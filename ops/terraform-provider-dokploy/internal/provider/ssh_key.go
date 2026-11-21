package provider

import (
	"context"
	"fmt"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

func init() {
	s := &Spec{
		Name:       "ssh_key",
		Desc:       "An SSH key Dokploy uses to reach servers or private Git repositories. The private key is write-only: Dokploy keeps it, Terraform never stores it.",
		IDKey:      "sshKeyId",
		ImportHint: "Import with the sshKeyId.",
		Fields: []Field{
			{Name: "name", Kind: String, Required: true, Desc: "Name of the key."},
			{Name: "description", Kind: String, Desc: "Free text."},
			{Name: "public_key", Kind: String, Required: true, ForceNew: true, Desc: "OpenSSH public key. Changing it replaces the key."},
			{Name: "private_key_wo", API: "privateKey", Kind: String, WriteOnly: true, Desc: "OpenSSH private key, needed on creation only."},
			{Name: "created_at", Kind: String, ReadOnly: true, Desc: "Creation date."},
		},
	}
	s.UseREST(CRUD{
		Router: "sshKey",
		UpdateBody: func(in Input) map[string]any {
			return pick(in.Body, "sshKeyId", "name", "description")
		},
	})
	s.Create = func(ctx context.Context, c *client.Client, in Input) (string, error) {
		org, err := c.OrganizationID(ctx)
		if err != nil {
			return "", err
		}
		body := overlay(in.Body, map[string]any{"organizationId": org})
		if _, ok := body["privateKey"]; !ok {
			return "", fmt.Errorf("private_key_wo is required to create an SSH key")
		}
		if err := c.Mutate(ctx, "sshKey.create", body, nil); err != nil {
			return "", err
		}
		// The procedure answers nothing: find the key by its public key.
		var all []map[string]any
		if err := c.Query(ctx, "sshKey.all", nil, &all); err != nil {
			return "", fmt.Errorf("the SSH key was created but the list could not be read (%w): it exists in Dokploy, check the dashboard and import or delete it before applying again", err)
		}
		for _, k := range all {
			if k["publicKey"] == in.Body["publicKey"] && k["name"] == in.Body["name"] {
				return asString(k["sshKeyId"]), nil
			}
		}
		return "", fmt.Errorf("created SSH key not found in sshKey.all")
	}
	register(s)
}
