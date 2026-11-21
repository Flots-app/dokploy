package provider

import (
	"context"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

func init() {
	project := &Spec{
		Name:       "project",
		Desc:       "A Dokploy project: a folder of environments. Its environment variables follow the same public/secret split as services.",
		IDKey:      "projectId",
		ImportHint: "Import with the projectId.",
		Fields: []Field{
			{Name: "name", Kind: String, Required: true, Desc: "Name of the project."},
			{Name: "description", Kind: String, Desc: "Free text."},
			{Name: "organization_id", Kind: String, ReadOnly: true, Desc: "Owning organization."},
			{Name: "created_at", Kind: String, ReadOnly: true, Desc: "Creation date."},
		},
		Env: &EnvSpec{Save: func(ctx context.Context, c *client.Client, id, text string, _ map[string]any) error {
			return c.Mutate(ctx, "project.update", map[string]any{"projectId": id, "env": text}, nil)
		}},
	}
	project.UseREST(CRUD{Router: "project", CreateIDPath: []string{"project", "projectId"}})
	register(project)

	environment := &Spec{
		Name:       "environment",
		Desc:       "An environment of a project (production, staging, ...). The default environment of a project cannot be deleted.",
		IDKey:      "environmentId",
		ImportHint: "Import with the environmentId.",
		Fields: []Field{
			{Name: "project_id", Kind: String, Required: true, ForceNew: true, Desc: "Project the environment belongs to."},
			{Name: "name", Kind: String, Required: true, Desc: "Name of the environment."},
			{Name: "description", Kind: String, Desc: "Free text."},
			{Name: "is_default", Kind: Bool, ReadOnly: true, Desc: "Whether this is the default environment of the project."},
			{Name: "created_at", Kind: String, ReadOnly: true, Desc: "Creation date."},
		},
		Env: &EnvSpec{Save: func(ctx context.Context, c *client.Client, id, text string, _ map[string]any) error {
			return c.Mutate(ctx, "environment.update", map[string]any{"environmentId": id, "env": text}, nil)
		}},
	}
	environment.UseREST(CRUD{Router: "environment"})
	register(environment)
}
