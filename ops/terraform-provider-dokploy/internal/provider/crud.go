package provider

import (
	"context"
	"fmt"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

// CRUD describes the usual Dokploy procedures of an object so a Spec can wire
// its hooks with UseREST. Every field is optional: the defaults follow the
// naming of most routers (<router>.create, .one, .update, .remove).
type CRUD struct {
	// Router is the tRPC router name, for example "sshKey".
	Router string
	// CreateProc, OneProc, UpdateProc, DeleteProc override the procedure names.
	CreateProc, OneProc, UpdateProc, DeleteProc string
	// OneParam is the query parameter of OneProc carrying the id; default the
	// spec's IDKey.
	OneParam string
	// CreateIDPath locates the new id in the create answer; default [IDKey].
	CreateIDPath []string
	// FindID resolves the id when the create answer does not carry it (some
	// procedures answer `true`): it receives the create body.
	FindID func(ctx context.Context, c *client.Client, body map[string]any) (string, error)
	// DeleteBody builds the delete payload; default {IDKey: id}.
	DeleteBody func(id string) map[string]any
	// UpdateBody post-processes the update payload (for example to merge it
	// over the current remote object when the procedure wants the whole
	// object).
	UpdateBody func(in Input) map[string]any
	// ReadPath locates the object in the one-answer; default the answer itself.
	ReadPath []string
}

func (c CRUD) proc(override, suffix string) string {
	if override != "" {
		return override
	}
	return c.Router + "." + suffix
}

// dig walks nested JSON objects.
func dig(v any, path ...string) any {
	for _, k := range path {
		m, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = m[k]
	}
	return v
}

// UseREST wires the CRUD hooks of s on the REST facade.
func (s *Spec) UseREST(o CRUD) {
	idPath := o.CreateIDPath
	if len(idPath) == 0 {
		idPath = []string{s.IDKey}
	}
	oneParam := o.OneParam
	if oneParam == "" {
		oneParam = s.IDKey
	}
	s.Create = func(ctx context.Context, c *client.Client, in Input) (string, error) {
		var out any
		if err := c.Mutate(ctx, o.proc(o.CreateProc, "create"), in.Body, &out); err != nil {
			return "", err
		}
		if id := asString(dig(out, idPath...)); id != "" {
			return id, nil
		}
		if o.FindID != nil {
			return o.FindID(ctx, c, in.Body)
		}
		return "", fmt.Errorf("the API answer carries no %s", s.IDKey)
	}
	s.Read = func(ctx context.Context, c *client.Client, id string) (map[string]any, error) {
		var out any
		if err := c.Query(ctx, o.proc(o.OneProc, "one"), map[string]any{oneParam: id}, &out); err != nil {
			return nil, err
		}
		obj, _ := dig(out, o.ReadPath...).(map[string]any)
		if obj == nil {
			return nil, client.ErrNotFound
		}
		return obj, nil
	}
	s.Update = func(ctx context.Context, c *client.Client, in Input) error {
		body := in.Body
		if o.UpdateBody != nil {
			body = o.UpdateBody(in)
		}
		return c.Mutate(ctx, o.proc(o.UpdateProc, "update"), body, nil)
	}
	s.Delete = func(ctx context.Context, c *client.Client, id string) error {
		body := map[string]any{s.IDKey: id}
		if o.DeleteBody != nil {
			body = o.DeleteBody(id)
		}
		return c.Mutate(ctx, o.proc(o.DeleteProc, "remove"), body, nil)
	}
}

// overlay returns remote with the keys of body set over it: for procedures
// whose update wants the whole object, secrets included, the provider reads
// them from Dokploy instead of asking the configuration for them.
func overlay(remote, body map[string]any) map[string]any {
	out := make(map[string]any, len(remote)+len(body))
	for k, v := range remote {
		out[k] = v
	}
	for k, v := range body {
		out[k] = v
	}
	return out
}

// pick keeps only the listed keys of m.
func pick(m map[string]any, keys ...string) map[string]any {
	out := map[string]any{}
	for _, k := range keys {
		if v, ok := m[k]; ok {
			out[k] = v
		}
	}
	return out
}
