// Package client is a small HTTP client for the Dokploy API.
//
// Dokploy exposes its tRPC routers two ways: a REST facade (`/api/<router>.<proc>`,
// generated from the OpenAPI metadata) and the raw tRPC endpoint
// (`/api/trpc/<router>.<proc>`). Procedures of the Flots fork that carry no
// OpenAPI metadata (GitHub runner pools, firewalls, OS updates, ...) are only
// reachable through the second one, so the client speaks both.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ErrNotFound is returned when the API answers 404, or when a lookup finds no
// object. Resources translate it to "removed outside Terraform".
var ErrNotFound = errors.New("dokploy: not found")

// APIError is a non-2xx answer from the Dokploy API.
type APIError struct {
	Status  int
	Proc    string
	Message string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("dokploy %s: HTTP %d: %s", e.Proc, e.Status, e.Message)
}

// Is lets errors.Is(err, ErrNotFound) match a 404.
func (e *APIError) Is(target error) bool {
	return target == ErrNotFound && e.Status == http.StatusNotFound
}

// Client talks to one Dokploy instance.
type Client struct {
	baseURL   string
	apiKey    string
	headers   map[string]string
	userAgent string
	http      *http.Client
	retries   int
	backoff   time.Duration

	orgOnce sync.Once
	orgID   string
	orgErr  error
}

// Options configures New.
type Options struct {
	// URL of the Dokploy dashboard, for example https://dokploy.example.com.
	// A trailing /api is accepted.
	URL string
	// APIKey is sent as x-api-key.
	APIKey string
	// Headers are added to every request, for example the Cloudflare Access
	// service token headers when the dashboard sits behind Cloudflare Access.
	Headers map[string]string
	// UserAgent identifies the provider. Cloudflare answers 403 (error 1010)
	// to the default Go and Python signatures, so a dedicated one is needed.
	UserAgent string
	// HTTPClient overrides the default client (tests).
	HTTPClient *http.Client
	// Retries is the number of retries of idempotent requests on 429/5xx and
	// network errors. Default 3.
	Retries int
	// Backoff is the base delay between retries. Default 500ms.
	Backoff time.Duration
}

// New builds a client.
func New(o Options) (*Client, error) {
	if strings.TrimSpace(o.URL) == "" {
		return nil, errors.New("dokploy: url is required")
	}
	if strings.TrimSpace(o.APIKey) == "" {
		return nil, errors.New("dokploy: api_key is required")
	}
	base := strings.TrimRight(o.URL, "/")
	base = strings.TrimSuffix(base, "/api")
	if _, err := url.ParseRequestURI(base); err != nil {
		return nil, fmt.Errorf("dokploy: invalid url %q: %w", o.URL, err)
	}
	c := &Client{
		baseURL:   base,
		apiKey:    o.APIKey,
		headers:   o.Headers,
		userAgent: o.UserAgent,
		http:      o.HTTPClient,
		retries:   o.Retries,
		backoff:   o.Backoff,
	}
	if c.http == nil {
		c.http = &http.Client{Timeout: 2 * time.Minute}
	}
	if c.userAgent == "" {
		c.userAgent = "terraform-provider-dokploy"
	}
	if c.retries == 0 {
		c.retries = 3
	}
	if c.backoff == 0 {
		c.backoff = 500 * time.Millisecond
	}
	return c, nil
}

// Query calls a read procedure through the REST facade: GET /api/<proc>?k=v.
// Scalar params become query parameters, as the facade expects.
func (c *Client) Query(ctx context.Context, proc string, params map[string]any, out any) error {
	q := url.Values{}
	for k, v := range params {
		q.Set(k, fmt.Sprint(v))
	}
	u := c.baseURL + "/api/" + proc
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	return c.do(ctx, http.MethodGet, proc, u, nil, out, true)
}

// Mutate calls a write procedure through the REST facade: POST /api/<proc>.
func (c *Client) Mutate(ctx context.Context, proc string, body any, out any) error {
	return c.do(ctx, http.MethodPost, proc, c.baseURL+"/api/"+proc, body, out, false)
}

// TRPCQuery calls a read procedure through the raw tRPC endpoint.
func (c *Client) TRPCQuery(ctx context.Context, proc string, input any, out any) error {
	u := c.baseURL + "/api/trpc/" + proc
	if input != nil {
		b, err := json.Marshal(map[string]any{"json": input})
		if err != nil {
			return err
		}
		u += "?input=" + url.QueryEscape(string(b))
	}
	return c.doTRPC(ctx, http.MethodGet, proc, u, nil, out, true)
}

// TRPCMutate calls a write procedure through the raw tRPC endpoint.
func (c *Client) TRPCMutate(ctx context.Context, proc string, input any, out any) error {
	return c.doTRPC(ctx, http.MethodPost, proc, c.baseURL+"/api/trpc/"+proc, map[string]any{"json": input}, out, false)
}

func (c *Client) doTRPC(ctx context.Context, method, proc, u string, body any, out any, idempotent bool) error {
	var env struct {
		Result struct {
			Data struct {
				JSON json.RawMessage `json:"json"`
			} `json:"data"`
		} `json:"result"`
	}
	if err := c.do(ctx, method, proc, u, body, &env, idempotent); err != nil {
		return err
	}
	if out == nil || len(env.Result.Data.JSON) == 0 {
		return nil
	}
	return json.Unmarshal(env.Result.Data.JSON, out)
}

func (c *Client) do(ctx context.Context, method, proc, u string, body any, out any, idempotent bool) error {
	var payload []byte
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("dokploy %s: encode request: %w", proc, err)
		}
		payload = b
	}
	var lastErr error
	attempts := 1
	if idempotent {
		attempts += c.retries
	}
	for i := 0; i < attempts; i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(c.backoff * time.Duration(1<<(i-1))):
			}
		}
		req, err := http.NewRequestWithContext(ctx, method, u, bytes.NewReader(payload))
		if err != nil {
			return err
		}
		req.Header.Set("x-api-key", c.apiKey)
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", c.userAgent)
		if payload != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		for k, v := range c.headers {
			req.Header.Set(k, v)
		}
		resp, err := c.http.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("dokploy %s: %w", proc, err)
			continue
		}
		raw, readErr := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
		_ = resp.Body.Close()
		if readErr != nil {
			lastErr = fmt.Errorf("dokploy %s: read response: %w", proc, readErr)
			continue
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			if out == nil || len(bytes.TrimSpace(raw)) == 0 {
				return nil
			}
			if err := json.Unmarshal(raw, out); err != nil {
				return fmt.Errorf("dokploy %s: decode response: %w", proc, err)
			}
			return nil
		}
		lastErr = &APIError{Status: resp.StatusCode, Proc: proc, Message: errorMessage(raw)}
		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			continue
		}
		return lastErr
	}
	return lastErr
}

// errorMessage extracts the human message of a tRPC/REST error body, without
// ever echoing request data.
func errorMessage(raw []byte) string {
	var e struct {
		Message string `json:"message"`
		Error   struct {
			Message string `json:"message"`
			JSON    struct {
				Message string `json:"message"`
			} `json:"json"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &e) == nil {
		switch {
		case e.Message != "":
			return e.Message
		case e.Error.Message != "":
			return e.Error.Message
		case e.Error.JSON.Message != "":
			return e.Error.JSON.Message
		}
	}
	s := strings.TrimSpace(string(raw))
	if len(s) > 300 {
		s = s[:300] + "..."
	}
	if s == "" {
		return "empty response"
	}
	return s
}

// OrganizationID returns the id of the organization the API key acts in. Some
// create procedures require it in their payload although the server overrides
// it with the session's.
func (c *Client) OrganizationID(ctx context.Context) (string, error) {
	c.orgOnce.Do(func() {
		var out struct {
			ID string `json:"id"`
		}
		if err := c.Query(ctx, "organization.active", nil, &out); err != nil {
			c.orgErr = err
			return
		}
		c.orgID = out.ID
	})
	if c.orgErr != nil {
		// Do not cache a failure forever.
		err := c.orgErr
		c.orgOnce = sync.Once{}
		c.orgErr = nil
		return "", err
	}
	return c.orgID, nil
}
