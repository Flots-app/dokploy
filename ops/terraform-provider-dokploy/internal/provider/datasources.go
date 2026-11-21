package provider

import (
	"context"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/datasource/schema"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

// lookupSpec describes a read-only data source that finds one object of the
// instance, by name, so a configuration can reference ids it does not own.
type lookupSpec struct {
	// Name is the type name without the provider prefix.
	Name string
	Desc string
	// IDKey is the JSON key of the object id, exposed as id.
	IDKey string
	// ByName makes name a required argument; otherwise name is an output and
	// Find is called with an empty name (organization.active).
	ByName   bool
	NameDesc string
	// Fields are the outputs, all computed. name and id are implicit.
	Fields []Field
	// Find returns the object; client.ErrNotFound when nothing matches.
	Find func(ctx context.Context, c *client.Client, name string) (map[string]any, error)
}

type lookupDataSource struct {
	spec   *lookupSpec
	client *client.Client
}

var (
	_ datasource.DataSource              = (*lookupDataSource)(nil)
	_ datasource.DataSourceWithConfigure = (*lookupDataSource)(nil)
)

// registerLookup registers a lookup data source.
func registerLookup(s *lookupSpec) {
	registerDataSource(func() datasource.DataSource { return &lookupDataSource{spec: s} })
}

func (d *lookupDataSource) Metadata(_ context.Context, req datasource.MetadataRequest, resp *datasource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_" + d.spec.Name
}

// lookupAttribute turns an output field into a computed data source attribute.
func lookupAttribute(f Field) schema.Attribute {
	switch f.Kind {
	case Bool:
		return schema.BoolAttribute{Computed: true, Description: f.Desc}
	case Int:
		return schema.Int64Attribute{Computed: true, Description: f.Desc}
	case StringMap:
		return schema.MapAttribute{ElementType: types.StringType, Computed: true, Description: f.Desc}
	case StringList:
		return schema.ListAttribute{ElementType: types.StringType, Computed: true, Description: f.Desc}
	case StringSet:
		return schema.SetAttribute{ElementType: types.StringType, Computed: true, Description: f.Desc}
	default:
		return schema.StringAttribute{Computed: true, Description: f.Desc}
	}
}

func (d *lookupDataSource) Schema(_ context.Context, _ datasource.SchemaRequest, resp *datasource.SchemaResponse) {
	attrs := map[string]schema.Attribute{
		"id": schema.StringAttribute{Computed: true, Description: "Dokploy id of the object."},
	}
	if d.spec.ByName {
		attrs["name"] = schema.StringAttribute{Required: true, Description: d.spec.NameDesc}
	} else {
		attrs["name"] = schema.StringAttribute{Computed: true, Description: d.spec.NameDesc}
	}
	for _, f := range d.spec.Fields {
		attrs[f.Name] = lookupAttribute(f)
	}
	resp.Schema = schema.Schema{Description: d.spec.Desc, Attributes: attrs}
}

func (d *lookupDataSource) Configure(_ context.Context, req datasource.ConfigureRequest, resp *datasource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}
	c, ok := req.ProviderData.(*client.Client)
	if !ok {
		resp.Diagnostics.AddError("Unexpected provider data", fmt.Sprintf("expected *client.Client, got %T", req.ProviderData))
		return
	}
	d.client = c
}

func (d *lookupDataSource) Read(ctx context.Context, req datasource.ReadRequest, resp *datasource.ReadResponse) {
	var name string
	if d.spec.ByName {
		resp.Diagnostics.Append(req.Config.GetAttribute(ctx, path.Root("name"), &name)...)
		if resp.Diagnostics.HasError() {
			return
		}
	}
	obj, err := d.spec.Find(ctx, d.client, name)
	if err != nil {
		resp.Diagnostics.AddError(fmt.Sprintf("Cannot read %s", d.spec.Name), err.Error())
		return
	}
	vals := Obj{
		"id":   toTF(String, obj[d.spec.IDKey]),
		"name": toTF(String, obj["name"]),
	}
	for _, f := range d.spec.Fields {
		raw := obj[f.apiKey()]
		if f.FromAPI != nil {
			raw = f.FromAPI(raw)
		}
		vals[f.Name] = toTF(f.Kind, raw)
	}
	resp.State.Raw = finalize(req.Config.Raw.Type(), vals)
}

// lookupFindByName returns the one object of list whose name is name.
func lookupFindByName(list []map[string]any, name, what string) (map[string]any, error) {
	var found []map[string]any
	for _, o := range list {
		if asString(o["name"]) == name {
			found = append(found, o)
		}
	}
	switch len(found) {
	case 0:
		return nil, fmt.Errorf("no %s named %q", what, name)
	case 1:
		return found[0], nil
	}
	return nil, fmt.Errorf("%d %ss are named %q: names must be unique to be looked up", len(found), what, name)
}

func init() {
	registerLookup(&lookupSpec{
		Name:     "server",
		Desc:     "Looks up a remote server by name.",
		IDKey:    "serverId",
		ByName:   true,
		NameDesc: "Exact name of the server.",
		Fields: []Field{
			{Name: "description", Kind: String, Desc: "Free text."},
			{Name: "ip_address", Kind: String, Desc: "IP address or host name Dokploy connects to."},
			{Name: "port", Kind: Int, Desc: "SSH port."},
			{Name: "username", Kind: String, Desc: "SSH user."},
			{Name: "ssh_key_id", Kind: String, Desc: "Id of the SSH key Dokploy authenticates with."},
			{Name: "server_type", Kind: String, Desc: "deploy or build."},
			{Name: "server_status", Kind: String, Desc: "active or inactive."},
			{Name: "enable_docker_cleanup", Kind: Bool, Desc: "Whether Dokploy prunes unused Docker data on the server."},
			{Name: "builds_concurrency", Kind: Int, Desc: "Number of builds the server runs at the same time."},
			{Name: "is_default_build_server", Kind: Bool, Desc: "Whether this is the default build server."},
			{Name: "app_name", Kind: String, Desc: "Generated technical name of the server."},
		},
		Find: func(ctx context.Context, c *client.Client, name string) (map[string]any, error) {
			var all []map[string]any
			if err := c.Query(ctx, "server.all", nil, &all); err != nil {
				return nil, err
			}
			return lookupFindByName(all, name, "server")
		},
	})

	registerLookup(&lookupSpec{
		Name:     "project",
		Desc:     "Looks up a project by name. Its environment variables are not exposed.",
		IDKey:    "projectId",
		ByName:   true,
		NameDesc: "Exact name of the project.",
		Fields: []Field{
			{Name: "description", Kind: String, Desc: "Free text."},
			{Name: "organization_id", Kind: String, Desc: "Owning organization."},
			{Name: "default_environment_id", Kind: String, Desc: "Id of the default environment of the project."},
			{Name: "environment_ids", Kind: StringMap, Desc: "Ids of the environments of the project, by name."},
		},
		Find: func(ctx context.Context, c *client.Client, name string) (map[string]any, error) {
			var all []map[string]any
			if err := c.Query(ctx, "project.all", nil, &all); err != nil {
				return nil, err
			}
			p, err := lookupFindByName(all, name, "project")
			if err != nil {
				return nil, err
			}
			envs := map[string]any{}
			def := ""
			list, _ := p["environments"].([]any)
			for _, e := range list {
				m, _ := e.(map[string]any)
				envs[asString(m["name"])] = asString(m["environmentId"])
				if m["isDefault"] == true {
					def = asString(m["environmentId"])
				}
			}
			out := pick(p, "projectId", "name", "description", "organizationId")
			out["environmentIds"] = envs
			out["defaultEnvironmentId"] = def
			return out, nil
		},
	})

	registerLookup(&lookupSpec{
		Name:     "github_provider",
		Desc:     "Looks up a GitHub App connection (a Git provider of type GitHub) by name, to reference its ids without hardcoding them. No credential is exposed.",
		IDKey:    "gitProviderId",
		ByName:   true,
		NameDesc: "Exact name of the Git provider.",
		Fields: []Field{
			{Name: "git_provider_id", Kind: String, Desc: "Id of the Git provider (what git-based services reference)."},
			{Name: "github_id", Kind: String, Desc: "Id of the GitHub App connection (githubId)."},
			{Name: "github_app_name", Kind: String, Desc: "URL of the GitHub App."},
			{Name: "github_app_id", Kind: Int, Desc: "Numeric id of the GitHub App."},
			{Name: "github_installation_id", Kind: String, Desc: "Id of the installation of the app."},
			{Name: "is_configured", Kind: Bool, Desc: "Whether the app is fully configured (private key and installation present)."},
			{Name: "shared_with_organization", Kind: Bool, Desc: "Whether the provider is shared with the whole organization."},
		},
		Find: func(ctx context.Context, c *client.Client, name string) (map[string]any, error) {
			var all []map[string]any
			if err := c.Query(ctx, "gitProvider.getAll", nil, &all); err != nil {
				return nil, err
			}
			var github []map[string]any
			for _, p := range all {
				if _, ok := p["github"].(map[string]any); ok {
					github = append(github, p)
				}
			}
			p, err := lookupFindByName(github, name, "GitHub provider")
			if err != nil {
				return nil, err
			}
			gh, _ := p["github"].(map[string]any)
			return map[string]any{
				"gitProviderId":          p["gitProviderId"],
				"name":                   p["name"],
				"sharedWithOrganization": p["sharedWithOrganization"],
				"githubId":               gh["githubId"],
				"githubAppName":          gh["githubAppName"],
				"githubAppId":            gh["githubAppId"],
				"githubInstallationId":   gh["githubInstallationId"],
				"isConfigured":           gh["isConfigured"],
			}, nil
		},
	})

	registerLookup(&lookupSpec{
		Name:     "organization",
		Desc:     "The organization the API key acts in (the active organization).",
		IDKey:    "id",
		NameDesc: "Name of the organization.",
		Fields: []Field{
			{Name: "slug", Kind: String, Desc: "Slug of the organization, when set."},
			{Name: "owner_id", Kind: String, Desc: "Id of the user owning the organization."},
			{Name: "created_at", Kind: String, Desc: "Creation date."},
		},
		Find: func(ctx context.Context, c *client.Client, _ string) (map[string]any, error) {
			var org map[string]any
			if err := c.Query(ctx, "organization.active", nil, &org); err != nil {
				return nil, err
			}
			if org == nil {
				return nil, fmt.Errorf("the API key has no active organization")
			}
			return org, nil
		},
	})
}
