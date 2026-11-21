package provider

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// fakeAPI is an in-memory stand-in for the parts of the Dokploy API the tests
// use. Routers are generic: <router>.create|one|update|remove|all.
type fakeAPI struct {
	t      *testing.T
	mu     sync.Mutex
	next   int
	routes map[string]string                    // router -> id key
	objs   map[string]map[string]map[string]any // router -> id -> object
	calls  []string
	// answer overrides the create answer per router.
	answer map[string]func(f *fakeAPI, obj map[string]any) any
	// hooks run before the generic handling; return true when handled.
	hooks map[string]func(w http.ResponseWriter, body map[string]any) bool
}

func newFakeAPI(t *testing.T) (*fakeAPI, *httptest.Server) {
	f := &fakeAPI{
		t: t,
		routes: map[string]string{
			"project": "projectId", "environment": "environmentId", "sshKey": "sshKeyId",
		},
		objs:   map[string]map[string]map[string]any{},
		answer: map[string]func(*fakeAPI, map[string]any) any{},
		hooks:  map[string]func(http.ResponseWriter, map[string]any) bool{},
	}
	f.answer["project"] = func(f *fakeAPI, obj map[string]any) any {
		env := f.insert("environment", map[string]any{"name": "production", "isDefault": true, "projectId": obj["projectId"], "env": ""})
		return map[string]any{"project": obj, "environment": env}
	}
	f.answer["sshKey"] = func(*fakeAPI, map[string]any) any { return nil }
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeAPI) insert(router string, obj map[string]any) map[string]any {
	if f.objs[router] == nil {
		f.objs[router] = map[string]map[string]any{}
	}
	f.next++
	id := fmt.Sprintf("%s-%d", router, f.next)
	obj[f.routes[router]] = id
	obj["createdAt"] = "2026-01-01T00:00:00.000Z"
	f.objs[router][id] = obj
	return obj
}

// seed stores an object created "outside Terraform".
func (f *fakeAPI) seed(router string, obj map[string]any) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.insert(router, obj)[f.routes[router]].(string)
}

func (f *fakeAPI) get(router, id string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.objs[router][id]
}

func (f *fakeAPI) set(router, id, key string, v any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.objs[router][id][key] = v
}

func (f *fakeAPI) called(proc string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == proc {
			n++
		}
	}
	return n
}

func (f *fakeAPI) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("x-api-key") != "test-key" {
		http.Error(w, `{"message":"unauthorized"}`, http.StatusUnauthorized)
		return
	}
	proc := strings.TrimPrefix(r.URL.Path, "/api/")
	f.calls = append(f.calls, proc)
	body := map[string]any{}
	if r.Method == http.MethodPost {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}
	if h, ok := f.hooks[proc]; ok && h(w, body) {
		return
	}
	reply := func(v any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
	fail := func(code int, msg string) {
		w.WriteHeader(code)
		reply(map[string]any{"message": msg})
	}
	if proc == "organization.active" {
		reply(map[string]any{"id": "org-1"})
		return
	}
	router, op, ok := strings.Cut(proc, ".")
	idKey, known := f.routes[router]
	if !ok || !known {
		fail(404, "unknown procedure "+proc)
		return
	}
	switch op {
	case "create":
		obj := map[string]any{}
		for k, v := range body {
			obj[k] = v
		}
		f.insert(router, obj)
		if a := f.answer[router]; a != nil {
			reply(a(f, obj))
			return
		}
		reply(obj)
	case "one":
		obj := f.objs[router][r.URL.Query().Get(idKey)]
		if obj == nil {
			fail(404, "not found")
			return
		}
		reply(obj)
	case "all":
		list := []any{}
		for _, o := range f.objs[router] {
			list = append(list, o)
		}
		reply(list)
	case "update":
		id, _ := body[idKey].(string)
		obj := f.objs[router][id]
		if obj == nil {
			fail(404, "not found")
			return
		}
		for k, v := range body {
			obj[k] = v
		}
		reply(true)
	case "remove":
		id, _ := body[idKey].(string)
		if f.objs[router][id] == nil {
			fail(404, "not found")
			return
		}
		delete(f.objs[router], id)
		reply(true)
	default:
		fail(404, "unknown operation "+proc)
	}
}
