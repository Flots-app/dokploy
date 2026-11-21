package provider

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-go/tftypes"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

// Helpers shared by the resources attached to a service (domain, mount,
// schedule, port, redirect, security).

// attachmentCheck reports configuration errors that the schema alone cannot
// express (a parent id that must be set exactly once, a field required by one
// value of another, ...). cfg is the raw configuration: an attribute left out is
// null, one computed by another resource is unknown (see attSet).
type attachmentCheck func(cfg Obj, report func(attr, summary, detail string))

// attachmentResource is the generic resource plus an extra configuration check.
type attachmentResource struct {
	*genericResource
	check attachmentCheck
}

var _ resource.ResourceWithValidateConfig = (*attachmentResource)(nil)

// ValidateConfig runs the generic checks, then the resource's own.
func (r *attachmentResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	r.genericResource.ValidateConfig(ctx, req, resp)
	if r.check == nil || req.Config.Raw.IsNull() {
		return
	}
	cfg, err := objOf(req.Config.Raw)
	if err != nil {
		return
	}
	r.check(cfg, func(attr, summary, detail string) {
		resp.Diagnostics.AddAttributeError(path.Root(attr), summary, detail)
	})
}

// registerAttachment registers a Spec as a resource that also runs check when
// the configuration is validated.
func registerAttachment(s *Spec, check attachmentCheck) {
	registerResource(func() resource.Resource {
		return &attachmentResource{genericResource: &genericResource{spec: s}, check: check}
	})
}

// attTraefikMu serializes the writes that rewrite the Traefik file of an
// application (its domains, redirects and basic-auth users all do a
// read-modify-write of the same file): Terraform applies resources in parallel,
// and two overlapping writes would lose one of them.
var attTraefikMu sync.Mutex

// attSerialize makes every create, update and delete of a Spec hold attTraefikMu.
func attSerialize(s *Spec) {
	create, update, remove := s.Create, s.Update, s.Delete
	s.Create = func(ctx context.Context, c *client.Client, in Input) (string, error) {
		attTraefikMu.Lock()
		defer attTraefikMu.Unlock()
		return create(ctx, c, in)
	}
	s.Update = func(ctx context.Context, c *client.Client, in Input) error {
		attTraefikMu.Lock()
		defer attTraefikMu.Unlock()
		return update(ctx, c, in)
	}
	s.Delete = func(ctx context.Context, c *client.Client, id string) error {
		attTraefikMu.Lock()
		defer attTraefikMu.Unlock()
		return remove(ctx, c, id)
	}
}

// attSet reports whether an attribute carries a value in the configuration. An
// unknown value (an id another resource will compute) counts as set.
func attSet(v tftypes.Value) bool { return !v.IsKnown() || !v.IsNull() }

// attCount counts the attributes of names that are set in cfg.
func attCount(cfg Obj, names ...string) int {
	n := 0
	for _, name := range names {
		if attSet(cfg[name]) {
			n++
		}
	}
	return n
}

// attNotFoundOn400 turns the HTTP 400 some procedures answer for a missing
// object (they wrap their NOT_FOUND error in a BAD_REQUEST) into ErrNotFound, so
// that an object removed outside Terraform is recreated instead of failing.
func attNotFoundOn400(err error, marker string) error {
	var api *client.APIError
	if errors.As(err, &api) && api.Status == http.StatusBadRequest && strings.Contains(strings.ToLower(api.Message), strings.ToLower(marker)) {
		return fmt.Errorf("%w: %s", client.ErrNotFound, api.Message)
	}
	return err
}

// attAppChildren lists the objects of one kind attached to an application
// ("redirects", "security", "ports", ...) through application.one, which embeds
// them. It is how the id of an object is found when its create procedure
// answers `true`.
func attAppChildren(ctx context.Context, c *client.Client, applicationID, key string) ([]map[string]any, error) {
	var app map[string]any
	if err := c.Query(ctx, "application.one", map[string]any{"applicationId": applicationID}, &app); err != nil {
		return nil, err
	}
	list, _ := app[key].([]any)
	out := make([]map[string]any, 0, len(list))
	for _, e := range list {
		m, ok := e.(map[string]any)
		if !ok {
			continue
		}
		if owner := asString(m["applicationId"]); owner != "" && owner != applicationID {
			continue
		}
		out = append(out, m)
	}
	return out, nil
}

// attWithBody returns a copy of in with its Body replaced.
func attWithBody(in Input, body map[string]any) Input {
	in.Body = body
	return in
}
