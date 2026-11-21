package provider

import (
	"context"
	"fmt"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

func init() {
	s := &Spec{
		Name:           "security",
		Desc:           "A basic-auth user of an application (Traefik basicAuth middleware). The password is write-only: Dokploy keeps it, Terraform never stores it.",
		IDKey:          "securityId",
		ImportHint:     "Import with the securityId.",
		SecretsVersion: true,
		Fields: []Field{
			{Name: "application_id", Kind: String, Required: true, ForceNew: true, Desc: "Application protected by the user. Changing it replaces the user."},
			{Name: "username", Kind: String, Required: true, Desc: "Login name, unique per application."},
			{Name: "password_wo", API: "password", Kind: String, WriteOnly: true, Desc: "Password of the user. Required on creation; on update it is only sent when set."},
			{Name: "created_at", Kind: String, ReadOnly: true, Desc: "Creation date."},
		},
	}
	s.UseREST(CRUD{
		Router:     "security",
		DeleteProc: "security.delete",
		// security.update insists on the password. security.one returns the
		// current one, so a rename does not need the secret in the configuration;
		// a password given in the configuration wins.
		UpdateBody: func(in Input) map[string]any {
			return pick(overlay(in.Remote, in.Body), "securityId", "username", "password")
		},
	})
	s.Create = func(ctx context.Context, c *client.Client, in Input) (string, error) {
		if _, ok := in.Body["password"]; !ok {
			return "", fmt.Errorf("password_wo is required to create a basic-auth user")
		}
		appID := asString(in.Body["applicationId"])
		username := asString(in.Body["username"])
		// security.create answers `true`; the (application, username) pair is
		// unique, so the new user is found by its name.
		if err := c.Mutate(ctx, "security.create", pick(in.Body, "applicationId", "username", "password"), nil); err != nil {
			return "", err
		}
		users, err := attAppChildren(ctx, c, appID, "security")
		if err != nil {
			return "", err
		}
		for _, u := range users {
			if asString(u["username"]) == username {
				return asString(u["securityId"]), nil
			}
		}
		return "", fmt.Errorf("the created user %q was not found on application %s", username, appID)
	}
	attSerialize(s)
	registerAttachment(s, nil)
}
