package provider

import (
	"context"
	"fmt"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

func init() {
	s := &Spec{
		Name:       "redirect",
		Desc:       "A Traefik regex redirect of an application.",
		IDKey:      "redirectId",
		ImportHint: "Import with the redirectId.",
		Fields: []Field{
			{Name: "application_id", Kind: String, Required: true, ForceNew: true, Desc: "Application the redirect belongs to. Changing it replaces the redirect."},
			{Name: "regex", Kind: String, Required: true, Desc: "Regular expression the request URL is matched against."},
			{Name: "replacement", Kind: String, Required: true, Desc: "URL the request is redirected to; may use the capture groups of regex."},
			{Name: "permanent", Kind: Bool, Default: false, Desc: "Answer 301 instead of 302. Default false."},
			{Name: "unique_config_key", Kind: Int, ReadOnly: true, Desc: "Number Dokploy uses to name the Traefik middleware of this redirect."},
			{Name: "created_at", Kind: String, ReadOnly: true, Desc: "Creation date."},
		},
	}
	s.UseREST(CRUD{
		Router:     "redirects",
		DeleteProc: "redirects.delete",
		UpdateBody: func(in Input) map[string]any {
			return pick(in.Body, "redirectId", "regex", "replacement", "permanent")
		},
	})
	s.Create = func(ctx context.Context, c *client.Client, in Input) (string, error) {
		// redirects.create answers `true`: the new id is found by comparing the
		// redirects of the application before and after, which needs two
		// creations not to overlap (see attSerialize).
		appID := asString(in.Body["applicationId"])
		before, err := attAppChildren(ctx, c, appID, "redirects")
		if err != nil {
			return "", err
		}
		known := map[string]bool{}
		for _, r := range before {
			known[asString(r["redirectId"])] = true
		}
		if err := c.Mutate(ctx, "redirects.create", pick(in.Body, "applicationId", "regex", "replacement", "permanent"), nil); err != nil {
			return "", err
		}
		after, err := attAppChildren(ctx, c, appID, "redirects")
		if err != nil {
			return "", err
		}
		for _, r := range after {
			if id := asString(r["redirectId"]); id != "" && !known[id] {
				return id, nil
			}
		}
		return "", fmt.Errorf("the created redirect was not found on application %s", appID)
	}
	attSerialize(s)
	registerAttachment(s, nil)
}
