package provider

import (
	"context"
	"encoding/json"
	"time"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

// Helpers shared by the resources of the Flots-fork-only routers (GitHub
// runner pools and machines, OS updates, firewalls). Those procedures carry no
// OpenAPI metadata, so they are called through the raw tRPC endpoint, and most
// of them have no `.one` procedure: the object is found in the list or the
// overview the router returns. Everything here is prefixed rn to stay clear of
// the helpers of the other resources of the package.

// rnStrFrom reads a nullable text column: null is the empty string, so an
// attribute left out of the configuration never differs from "not set".
func rnStrFrom(v any) any {
	if v == nil {
		return ""
	}
	return v
}

// rnStrTo is the opposite: the empty string clears the column.
func rnStrTo(v any) any {
	if s, ok := v.(string); ok && s == "" {
		return nil
	}
	return v
}

// rnJSONFrom reads a nullable JSON column: null becomes the JSON text "null",
// so the attribute can tell "not overridden" from "left out of the
// configuration" (which adopts whatever the API reports).
func rnJSONFrom(v any) any {
	if v == nil {
		return json.RawMessage("null")
	}
	return v
}

func rnMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func rnClone(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// rnSame compares two decoded JSON values, whatever their Go number types.
func rnSame(a, b any) bool {
	x, err1 := json.Marshal(a)
	y, err2 := json.Marshal(b)
	return err1 == nil && err2 == nil && string(x) == string(y)
}

// rnGroup describes a nested API object that the Terraform schema flattens
// into scalar attributes: Fields maps the flat body key to the key inside the
// nested object. Flat attributes are friendlier than a JSON string and, above
// all, immune to the defaults the API's validation injects into a partial
// object (which would make a hand-written jsonencode() differ from the answer
// forever).
type rnGroup struct {
	// Key is the key of the nested object in the API payload.
	Key string
	// Fields maps the flat key of the body to the key of the nested object.
	Fields map[string]string
	// Defaults is the object a create starts from; nil starts from {} and
	// lets the API fill the rest.
	Defaults func() map[string]any
}

// rnNest folds the flat keys of body into their nested objects. A nested
// object starts from base (the object the API holds now) when it has one, else
// from the group's defaults; only the flat keys present in body override it.
func rnNest(body, base map[string]any, groups []rnGroup) map[string]any {
	out := rnClone(body)
	for _, g := range groups {
		var obj map[string]any
		for flat, nested := range g.Fields {
			v, ok := out[flat]
			if !ok {
				continue
			}
			delete(out, flat)
			if obj == nil {
				switch {
				case rnMap(base[g.Key]) != nil:
					obj = rnClone(rnMap(base[g.Key]))
				case g.Defaults != nil:
					obj = g.Defaults()
				default:
					obj = map[string]any{}
				}
			}
			obj[nested] = v
		}
		if obj != nil {
			out[g.Key] = obj
		}
	}
	return out
}

// rnFlatten copies the nested objects of an API answer into the flat keys the
// schema declares (the reverse of rnNest).
func rnFlatten(remote map[string]any, groups []rnGroup) map[string]any {
	out := rnClone(remote)
	for _, g := range groups {
		obj := rnMap(remote[g.Key])
		for flat, nested := range g.Fields {
			out[flat] = obj[nested]
		}
	}
	return out
}

// rnList calls a list-like read procedure and returns its objects.
func rnList(ctx context.Context, c *client.Client, proc string) ([]map[string]any, error) {
	var out []map[string]any
	if err := c.TRPCQuery(ctx, proc, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// rnFind returns the object of a list whose idKey is id, or client.ErrNotFound.
func rnFind(list []map[string]any, idKey, id string) (map[string]any, error) {
	for _, o := range list {
		if asString(o[idKey]) == id {
			return o, nil
		}
	}
	return nil, client.ErrNotFound
}

// rnPoolList is the runners overview: a list of pools with their machines
// embedded under "nodes".
func rnPoolList(ctx context.Context, c *client.Client) ([]map[string]any, error) {
	return rnList(ctx, c, "githubRunner.overview")
}

// rnNodeOf returns the machine with this id from the overview.
func rnNodeOf(pools []map[string]any, id string) (map[string]any, error) {
	for _, p := range pools {
		nodes, _ := p["nodes"].([]any)
		for _, n := range nodes {
			if node := rnMap(n); asString(node["githubRunnerNodeId"]) == id {
				return node, nil
			}
		}
	}
	return nil, client.ErrNotFound
}

// Tuning of the wait after a machine removal, variables so the tests are quick.
var (
	rnPollEvery = 3 * time.Second
	rnPollFor   = 5 * time.Minute
)

// rnWaitNodeGone waits (for a while) until the machine disappears from the
// overview: removing a machine drains it first, and its pool cannot be removed
// before. Running out of time is not an error: the removal goes on in Dokploy.
func rnWaitNodeGone(ctx context.Context, c *client.Client, id string) (gone bool, err error) {
	deadline := time.Now().Add(rnPollFor)
	for time.Now().Before(deadline) {
		pools, err := rnPoolList(ctx, c)
		if err != nil {
			return false, err
		}
		if _, err := rnNodeOf(pools, id); err != nil {
			return true, nil
		}
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-time.After(rnPollEvery):
		}
	}
	return false, nil
}
