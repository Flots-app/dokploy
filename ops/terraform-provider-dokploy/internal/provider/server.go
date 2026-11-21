package provider

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

// ------------------------------------------------- shared helpers of this file

// srvCheckedResource is the generic resource plus a configuration check
// (cross-attribute rules the schema cannot express) and, optionally, a fixed id
// for singletons: whatever id is given to `terraform import`, the state gets it.
type srvCheckedResource struct {
	*genericResource
	fixedID string
	check   func(cfg Obj, d *diag.Diagnostics)
}

// srvRegisterChecked registers s with a configuration check and an optional fixed id.
func srvRegisterChecked(s *Spec, fixedID string, check func(cfg Obj, d *diag.Diagnostics)) {
	registerResource(func() resource.Resource {
		return &srvCheckedResource{genericResource: &genericResource{spec: s}, fixedID: fixedID, check: check}
	})
}

func (r *srvCheckedResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	if r.fixedID != "" {
		resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), r.fixedID)...)
		return
	}
	r.genericResource.ImportState(ctx, req, resp)
}

func (r *srvCheckedResource) ValidateConfig(ctx context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	r.genericResource.ValidateConfig(ctx, req, resp)
	if r.check == nil || req.Config.Raw.IsNull() {
		return
	}
	cfg, err := objOf(req.Config.Raw)
	if err != nil {
		return
	}
	r.check(cfg, &resp.Diagnostics)
}

// srvCfgString returns a configured, known string attribute.
func srvCfgString(cfg Obj, name string) (string, bool) { return stringOf(cfg[name]) }

// srvCfgInt returns a configured, known integer attribute.
func srvCfgInt(cfg Obj, name string) (int64, bool) {
	v, ok := fromTF(Int, cfg[name])
	if !ok {
		return 0, false
	}
	i, _ := v.(int64)
	return i, true
}

// srvCfgBool returns a configured, known boolean attribute.
func srvCfgBool(cfg Obj, name string) (bool, bool) {
	v, ok := fromTF(Bool, cfg[name])
	if !ok {
		return false, false
	}
	b, _ := v.(bool)
	return b, true
}

// srvMutateWithFallback calls a write procedure through the REST facade and, when
// the facade does not know it (it answers 404: procedures added by the fork
// after the last OpenAPI export), through the raw tRPC endpoint.
func srvMutateWithFallback(ctx context.Context, c *client.Client, proc string, body any, out any) error {
	err := c.Mutate(ctx, proc, body, out)
	var apiErr *client.APIError
	if errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound {
		return c.TRPCMutate(ctx, proc, body, out)
	}
	return err
}

// srvDiffers reports whether one of the keys is set in body with a value other
// than the one of remote. Values are compared as text so that 22 and 22.0
// (JSON numbers) and null and "" are the same.
func srvDiffers(remote, body map[string]any, keys ...string) bool {
	for _, k := range keys {
		if v, ok := body[k]; ok && asString(v) != asString(remote[k]) {
			return true
		}
	}
	return false
}

// -------------------------------------------------------------- dokploy_server

// serverUpdateKeys are the fields server.update takes (all required by its
// schema, except command).
var serverUpdateKeys = []string{"name", "description", "ipAddress", "port", "username", "sshKeyId", "serverType", "enableDockerCleanup", "command"}

// serverCreateKeys are the fields server.create takes.
var serverCreateKeys = []string{"name", "description", "ipAddress", "port", "username", "sshKeyId", "serverType", "enableDockerCleanup"}

// applyServerFields writes what srvDiffers between the wanted fields (body) and the
// remote object. server.update wants the whole object; the build concurrency
// and the default build server have procedures of their own.
func applyServerFields(ctx context.Context, c *client.Client, id string, body, remote map[string]any) error {
	if srvDiffers(remote, body, serverUpdateKeys...) {
		merged := overlay(remote, body)
		upd := pick(merged, serverUpdateKeys...)
		upd["serverId"] = id
		// The schema wants a string: the column is nullable.
		upd["description"] = asString(merged["description"])
		if err := c.Mutate(ctx, "server.update", upd, nil); err != nil {
			return err
		}
	}
	if srvDiffers(remote, body, "buildsConcurrency") {
		if err := srvMutateWithFallback(ctx, c, "server.updateBuildsConcurrency", map[string]any{"serverId": id, "buildsConcurrency": body["buildsConcurrency"]}, nil); err != nil {
			return err
		}
	}
	// There is no procedure to unset the default build server: making another
	// build server the default is what clears it here.
	if want, ok := body["isDefaultBuildServer"].(bool); ok && want && remote["isDefaultBuildServer"] != true {
		if err := srvMutateWithFallback(ctx, c, "server.setDefaultBuildServer", map[string]any{"serverId": id}, nil); err != nil {
			return err
		}
	}
	return nil
}

func checkServerConfig(cfg Obj, d *diag.Diagnostics) {
	if v, ok := srvCfgString(cfg, "ip_address"); ok && strings.TrimSpace(v) == "" {
		d.AddAttributeError(path.Root("ip_address"), "Invalid ip_address", "The address must not be empty.")
	}
	if v, ok := srvCfgInt(cfg, "port"); ok && (v < 1 || v > 65535) {
		d.AddAttributeError(path.Root("port"), "Invalid port", "The SSH port must be between 1 and 65535.")
	}
	if v, ok := srvCfgInt(cfg, "builds_concurrency"); ok && (v < 1 || v > 100) {
		d.AddAttributeError(path.Root("builds_concurrency"), "Invalid builds_concurrency", "Dokploy accepts between 1 and 100 concurrent builds.")
	}
	if def, ok := srvCfgBool(cfg, "is_default_build_server"); ok && def {
		if t, ok := srvCfgString(cfg, "server_type"); ok && t != "build" {
			d.AddAttributeError(path.Root("is_default_build_server"), "Invalid is_default_build_server", "Only a server of type build can be the default build server.")
		}
	}
}

func init() {
	s := &Spec{
		Name: "server",
		Desc: "A remote server Dokploy reaches over SSH, to deploy services (type deploy) or to build images (type build). " +
			"Terraform only manages the configuration stored in Dokploy: it never runs the server setup, the validation, the security audit or the monitoring setup, " +
			"which connect to the machine and change it. The monitoring configuration (it carries a token) is not exposed.",
		IDKey:      "serverId",
		ImportHint: "Import with the serverId.",
		Fields: []Field{
			{Name: "name", Kind: String, Required: true, Desc: "Name of the server."},
			{Name: "description", Kind: String, Default: "", Desc: "Free text."},
			{Name: "ip_address", Kind: String, Required: true, Desc: "IP address or host name Dokploy connects to (a Tailscale address works)."},
			{Name: "port", Kind: Int, Default: int64(22), Desc: "SSH port. Defaults to 22."},
			{Name: "username", Kind: String, Default: "root", Desc: "SSH user. Defaults to root."},
			{Name: "ssh_key_id", Kind: String, Required: true, Desc: "Id of the dokploy_ssh_key Dokploy authenticates with."},
			{Name: "server_type", Kind: String, OneOf: []string{"deploy", "build"}, Default: "deploy", Desc: "deploy runs services, build only builds images."},
			{Name: "enable_docker_cleanup", Kind: Bool, Default: true, Desc: "Whether Dokploy prunes unused Docker data on the server every day."},
			{Name: "builds_concurrency", Kind: Int, Desc: "Number of builds the server runs at the same time (1 to 100). Dokploy's default is 1."},
			{Name: "is_default_build_server", Kind: Bool, Desc: "Whether this build server is the default one for the organization. Dokploy makes the first build server the default on its own. " +
				"Dokploy has no way to unset it: it is cleared by making another build server the default, so setting false on the current default is a no-op that shows as a difference until another server takes over."},
			{Name: "command", Kind: String, Desc: "Custom setup command Dokploy runs on the server during its setup. Empty means the Dokploy default."},
			{Name: "app_name", Kind: String, ReadOnly: true, Desc: "Generated technical name of the server."},
			{Name: "server_status", Kind: String, ReadOnly: true, Volatile: true, Desc: "active or inactive, as reported by Dokploy."},
			{Name: "organization_id", Kind: String, ReadOnly: true, Desc: "Owning organization."},
			{Name: "created_at", Kind: String, ReadOnly: true, Desc: "Creation date."},
		},
	}
	s.UseREST(CRUD{Router: "server"})
	s.Create = func(ctx context.Context, c *client.Client, in Input) (string, error) {
		var out map[string]any
		if err := c.Mutate(ctx, "server.create", pick(in.Body, serverCreateKeys...), &out); err != nil {
			return "", err
		}
		id := asString(out["serverId"])
		if id == "" {
			return "", errors.New("the API answer carries no serverId")
		}
		// server.create takes neither the command, nor the build concurrency, nor
		// the default flag: apply them now. A failure here must not leave a server
		// Terraform does not know, so the new server is removed again.
		if err := applyServerFields(ctx, c, id, in.Body, out); err != nil {
			if rmErr := c.Mutate(ctx, "server.remove", map[string]any{"serverId": id}, nil); rmErr != nil {
				return "", fmt.Errorf("%w (the server %s was created and could not be removed again: %v)", err, id, rmErr)
			}
			return "", err
		}
		return id, nil
	}
	s.Update = func(ctx context.Context, c *client.Client, in Input) error {
		return applyServerFields(ctx, c, in.ID, in.Body, in.Remote)
	}
	srvRegisterChecked(s, "", checkServerConfig)
}
