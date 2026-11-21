// Package provider implements the Terraform provider of a Dokploy instance.
package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/hashicorp/terraform-plugin-framework/datasource"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/provider"
	"github.com/hashicorp/terraform-plugin-framework/provider/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

// Registries filled by the init() of each resource file, so adding a resource
// is one new file.
var (
	specs       []*Spec
	extraRes    []func() resource.Resource
	dataSources []func() datasource.DataSource
)

func register(s *Spec)                                  { specs = append(specs, s) }
func registerResource(f func() resource.Resource)       { extraRes = append(extraRes, f) }
func registerDataSource(f func() datasource.DataSource) { dataSources = append(dataSources, f) }

type dokployProvider struct{ version string }

// New returns the provider factory.
func New(version string) func() provider.Provider {
	return func() provider.Provider { return &dokployProvider{version: version} }
}

func (p *dokployProvider) Metadata(_ context.Context, _ provider.MetadataRequest, resp *provider.MetadataResponse) {
	resp.TypeName = "dokploy"
	resp.Version = p.version
}

func (p *dokployProvider) Schema(_ context.Context, _ provider.SchemaRequest, resp *provider.SchemaResponse) {
	resp.Schema = schema.Schema{
		Description: "Manages a Dokploy instance. Credentials are read from the environment so they never end up in a configuration, a plan or a state.",
		Attributes: map[string]schema.Attribute{
			"url": schema.StringAttribute{
				Optional:    true,
				Description: "Dashboard URL, for example https://dokploy.example.com. Defaults to $DOKPLOY_URL.",
			},
			"api_key": schema.StringAttribute{
				Optional:    true,
				Sensitive:   true,
				Description: "API key of a Dokploy user. Defaults to $DOKPLOY_API_KEY.",
			},
			"custom_headers": schema.MapAttribute{
				ElementType: types.StringType,
				Optional:    true,
				Sensitive:   true,
				Description: "Extra headers for every request, for example the Cloudflare Access service token (CF-Access-Client-Id, CF-Access-Client-Secret). Defaults to the JSON object in $DOKPLOY_CUSTOM_HEADERS.",
			},
		},
	}
}

type providerModel struct {
	URL           types.String `tfsdk:"url"`
	APIKey        types.String `tfsdk:"api_key"`
	CustomHeaders types.Map    `tfsdk:"custom_headers"`
}

func (p *dokployProvider) Configure(ctx context.Context, req provider.ConfigureRequest, resp *provider.ConfigureResponse) {
	var m providerModel
	resp.Diagnostics.Append(req.Config.Get(ctx, &m)...)
	if resp.Diagnostics.HasError() {
		return
	}
	for _, a := range []struct {
		v    types.String
		name string
	}{{m.URL, "url"}, {m.APIKey, "api_key"}} {
		if a.v.IsUnknown() {
			resp.Diagnostics.AddAttributeError(path.Root(a.name), "Unknown value", "The value must be known when the provider is configured; use the environment instead.")
		}
	}
	if resp.Diagnostics.HasError() {
		return
	}
	url := m.URL.ValueString()
	if url == "" {
		url = os.Getenv("DOKPLOY_URL")
	}
	key := m.APIKey.ValueString()
	if key == "" {
		key = os.Getenv("DOKPLOY_API_KEY")
	}
	headers := map[string]string{}
	if !m.CustomHeaders.IsNull() && !m.CustomHeaders.IsUnknown() {
		resp.Diagnostics.Append(m.CustomHeaders.ElementsAs(ctx, &headers, false)...)
	} else if raw := os.Getenv("DOKPLOY_CUSTOM_HEADERS"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &headers); err != nil {
			resp.Diagnostics.AddError("Invalid DOKPLOY_CUSTOM_HEADERS", "It must be a JSON object of header names and values.")
		}
	}
	if resp.Diagnostics.HasError() {
		return
	}
	c, err := client.New(client.Options{
		URL:       url,
		APIKey:    key,
		Headers:   headers,
		UserAgent: fmt.Sprintf("terraform-provider-dokploy/%s", p.version),
	})
	if err != nil {
		resp.Diagnostics.AddError("Cannot configure the Dokploy client", err.Error()+". Set url / api_key or DOKPLOY_URL / DOKPLOY_API_KEY.")
		return
	}
	resp.ResourceData = c
	resp.DataSourceData = c
}

func (p *dokployProvider) Resources(context.Context) []func() resource.Resource {
	out := make([]func() resource.Resource, 0, len(specs)+len(extraRes))
	for _, s := range specs {
		out = append(out, NewResource(s))
	}
	return append(out, extraRes...)
}

func (p *dokployProvider) DataSources(context.Context) []func() datasource.DataSource {
	return dataSources
}
