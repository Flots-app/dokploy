package client

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func newTestClient(t *testing.T, url string) *Client {
	t.Helper()
	c, err := New(Options{URL: url, APIKey: "test-key", Retries: 1, Backoff: time.Millisecond, Headers: map[string]string{"X-Extra": "extra-value"}})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// organization.active failing must neither deadlock concurrent callers nor be cached.
func TestOrganizationIDFailureIsNotCachedAndDoesNotDeadlock(t *testing.T) {
	var fail atomic.Bool
	fail.Store(true)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail.Load() {
			http.Error(w, `{"message":"boom"}`, http.StatusBadRequest)
			return
		}
		_, _ = w.Write([]byte(`{"id":"org-1"}`))
	}))
	defer srv.Close()
	c := newTestClient(t, srv.URL)

	done := make(chan struct{})
	go func() {
		defer close(done)
		var wg sync.WaitGroup
		for i := 0; i < 8; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if _, err := c.OrganizationID(context.Background()); err == nil {
					t.Error("expected an error while the API fails")
				}
			}()
		}
		wg.Wait()
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("OrganizationID deadlocked")
	}

	fail.Store(false)
	id, err := c.OrganizationID(context.Background())
	if err != nil || id != "org-1" {
		t.Fatalf("after recovery: id=%q err=%v", id, err)
	}
}

// A redirect to another host must not carry the API key or the extra headers.
func TestRedirectIsNotFollowed(t *testing.T) {
	var leaked atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		leaked.Store(true)
	}))
	defer target.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer origin.Close()
	c := newTestClient(t, origin.URL)

	err := c.Mutate(context.Background(), "project.update", map[string]any{"env": "A=1"}, nil)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusTemporaryRedirect {
		t.Fatalf("expected an HTTP 307 error, got %v", err)
	}
	if leaked.Load() {
		t.Fatal("the request was forwarded to the redirect target")
	}
}

// Only Dokploy's own "not found" answer means the object is gone.
func TestNotFoundNeedsAStructuredAnswer(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		missing bool
	}{
		{"object not found", `{"message":"Project not found","code":"NOT_FOUND"}`, true},
		{"trpc object not found", `{"error":{"json":{"message":"Server not found"}}}`, true},
		{"unknown procedure", `{"message":"No procedure found on path \"x.y\"","code":"NOT_FOUND"}`, false},
		{"proxy page", `404 page not found`, false},
		{"empty", ``, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			c := newTestClient(t, srv.URL)
			err := c.Query(context.Background(), "project.one", map[string]any{"projectId": "x"}, nil)
			if err == nil {
				t.Fatal("expected an error")
			}
			if got := errors.Is(err, ErrNotFound); got != tc.missing {
				t.Fatalf("errors.Is(ErrNotFound) = %v, want %v (%v)", got, tc.missing, err)
			}
		})
	}
}

// Mutations are never retried; reads are.
func TestOnlyReadsAreRetried(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, `{"message":"unavailable"}`, http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	c := newTestClient(t, srv.URL)

	_ = c.Mutate(context.Background(), "project.create", map[string]any{"name": "x"}, nil)
	if n := calls.Load(); n != 1 {
		t.Fatalf("a mutation was sent %d times", n)
	}
	calls.Store(0)
	_ = c.Query(context.Background(), "project.one", nil, nil)
	if n := calls.Load(); n != 2 {
		t.Fatalf("a read was sent %d times, want 2 (one retry)", n)
	}
}

func TestServerMessageIsTruncated(t *testing.T) {
	long := make([]byte, 2000)
	for i := range long {
		long[i] = 'a'
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"message":"` + string(long) + `"}`))
	}))
	defer srv.Close()
	c := newTestClient(t, srv.URL)
	err := c.Mutate(context.Background(), "x.y", nil, nil)
	if err == nil || len(err.Error()) > 700 {
		t.Fatalf("message not truncated: %d chars", len(err.Error()))
	}
}

// Drizzle query errors end with the bound parameters, which hold secrets.
func TestQueryParametersAreWithheldFromErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"message":"Failed query: insert into backup (metadata) values ($1)\nparams: {\"password\":\"hunter-two\"}"}`))
	}))
	defer srv.Close()
	c := newTestClient(t, srv.URL)
	err := c.Mutate(context.Background(), "backup.create", nil, nil)
	if err == nil {
		t.Fatal("expected an error")
	}
	if strings.Contains(err.Error(), "hunter-two") || !strings.Contains(err.Error(), "Failed query") {
		t.Fatalf("unexpected message: %v", err)
	}
}
