package provider

import (
	"context"
	"fmt"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

func init() {
	s := &Spec{
		Name: "registry",
		Desc: "A container registry Dokploy logs in to (image pulls and pushes). The password is write-only: Dokploy keeps it, Terraform never stores it. " +
			"Destroying it runs docker logout on the Dokploy host and clears the build registry (and build server) of every application and Compose service that uses it. " +
			"Dokploy runs a docker login on its host at every create and update, so the credentials must be valid.",
		IDKey:          "registryId",
		ImportHint:     "Import with the registryId.",
		SecretsVersion: true,
		Fields: []Field{
			{Name: "registry_name", Kind: String, Required: true, Desc: "Display name of the registry."},
			{Name: "image_prefix", Kind: String, Desc: "Prefix put in front of the image names pushed to the registry (for example the GitHub organization)."},
			{Name: "username", Kind: String, Required: true, Desc: "Registry user name (case is kept: AWS ECR wants exactly AWS)."},
			{Name: "registry_url", Kind: String, Default: "", Desc: "Registry host, hostname or hostname:port, without scheme (empty means Docker Hub)."},
			{Name: "registry_type", Kind: String, Default: "cloud", OneOf: []string{"cloud"}, Desc: "Kind of registry; Dokploy only accepts cloud."},
			{Name: "password_wo", API: "password", Kind: String, WriteOnly: true, Desc: "Registry password or access token. Required on creation; when left out on an update, the password Dokploy holds is kept."},
			{Name: "created_at", Kind: String, ReadOnly: true, Desc: "Creation date."},
		},
	}
	// registry.update is a partial update: the password is only sent when it
	// is configured, and Dokploy logs in again with the stored one otherwise.
	s.UseREST(CRUD{Router: "registry"})
	create := s.Create
	s.Create = func(ctx context.Context, c *client.Client, in Input) (string, error) {
		if _, ok := in.Body["password"]; !ok {
			return "", fmt.Errorf("password_wo is required to create a registry")
		}
		// registry.create requires the key, null when there is no prefix.
		if _, ok := in.Body["imagePrefix"]; !ok {
			in.Body["imagePrefix"] = nil
		}
		return create(ctx, c, in)
	}
	register(s)
}
