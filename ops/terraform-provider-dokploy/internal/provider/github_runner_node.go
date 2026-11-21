package provider

import (
	"context"
	"errors"
	"fmt"

	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-go/tftypes"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

// A runner machine joins Dokploy through an enrollment (a setup script run on
// the machine, then a code that pins its SSH host key) or through createMachine
// (which provisions it right away): both reach the machine over SSH and rely on
// a trust decision a plan cannot make. The resource therefore adopts machines
// (terraform import), edits their configuration and removes them, but never
// creates one.

// rnNodeConfigOnly are the attributes that exist only in the Terraform state:
// how the machine is removed on destroy. Dokploy does not report them, so Read
// carries them over from the prior state.
var rnNodeConfigOnly = []string{"destroy_mode", "destroy_uninstall", "destroy_force"}

// rnNodeBudgetKeys are the API keys updateMachine takes besides the id.
var rnNodeBudgetKeys = []string{"description", "cpuPercent", "memoryPercent", "diskReserveGb", "diskCleanupPercent", "maxRunners", "vmDiskGb", "extraLabels", "x64Runners", "updatePolicy"}

func rnNodeSpec() *Spec {
	s := &Spec{
		Name: "github_runner_node",
		Desc: "A GitHub runner machine of a pool (Flots fork of Dokploy). A machine cannot be created by Terraform: enroll it in the Dokploy dashboard (setup script and host key check), then adopt it with terraform import. " +
			"The resource edits its budget, labels and update policy (Dokploy then applies them on the machine: a Mac's VM restarts once its jobs finish), switches it on or off, and removes it on destroy. Connection details and runtime state are read-only.",
		IDKey:      "githubRunnerNodeId",
		ImportHint: "Import with the githubRunnerNodeId; machines cannot be created by Terraform.",
		Fields: []Field{
			{Name: "name", Kind: String, Required: true, Desc: "Name of the machine; it prefixes the runner names on GitHub. Cannot be changed."},
			{Name: "pool_id", API: "githubRunnerPoolId", Kind: String, Required: true, Desc: "Pool the machine belongs to. A machine cannot be moved to another pool."},
			{Name: "description", Kind: String, FromAPI: rnStrFrom, ToAPI: rnStrTo, Desc: "Free text. Empty for none."},
			{Name: "enabled", Kind: Bool, Desc: "Whether the machine takes jobs. Switching it off waits for the running jobs (drain mode wait); switching it on starts it again, and provisions a machine that never was."},
			{Name: "cpu_percent", Kind: Int, Desc: "Share of the CPUs the runners may use, 10 to 100."},
			{Name: "memory_percent", Kind: Int, Desc: "Share of the memory the runners may use, 10 to 100."},
			{Name: "disk_reserve_gb", Kind: Int, Desc: "Disk space kept free, in GB."},
			{Name: "disk_cleanup_percent", Kind: Int, Desc: "Once the disk is this full (50 to 99 percent), the least recently used caches are removed."},
			{Name: "max_runners", Kind: Int, Desc: "Concurrent jobs, 0 to 32; 0 sizes it from the budget (2 CPUs and 3 GiB per job)."},
			{Name: "vm_disk_gb", Kind: Int, Desc: "Disk of the VM of a Mac, in GB (20 to 4096). It can only grow."},
			{Name: "x64_runners", Kind: Int, Desc: "Mac only: x86_64 runners through Rosetta, next to the native ones (0 to 4)."},
			{Name: "extra_labels", Kind: StringList, Desc: "Labels added to the runners of this machine, on top of the pool's."},
			{Name: "update_policy", Kind: JSON, FromAPI: rnJSONFrom, Desc: "JSON object {auto, window, osPatches?} overriding the update policy of the pool, or the JSON text null to follow the pool (the answer jsonencode(null) gives)."},
			{Name: "platform", Kind: String, ReadOnly: true, Desc: "linux or macos."},
			{Name: "host", Kind: String, ReadOnly: true, Desc: "Address Dokploy reaches the machine on."},
			{Name: "port", Kind: Int, ReadOnly: true, Desc: "SSH port."},
			{Name: "username", Kind: String, ReadOnly: true, Desc: "SSH user."},
			{Name: "ssh_key_id", Kind: String, FromAPI: rnStrFrom, ReadOnly: true, Desc: "Shared SSH key of the machine; empty when it has a key of its own (enrolled machines)."},
			{Name: "vm_name", Kind: String, ReadOnly: true, Desc: "Name of the VM of a Mac."},
			{Name: "keep_awake", Kind: Bool, ReadOnly: true, Desc: "Mac: no system sleep and restart after a power loss."},
			{Name: "host_key_fingerprint", Kind: String, FromAPI: rnStrFrom, ReadOnly: true, Desc: "SSH host key pinned on first contact."},
			{Name: "runner_name_prefix", Kind: String, ReadOnly: true, Desc: "Prefix of the runner names on GitHub."},
			{Name: "phase", Kind: String, ReadOnly: true, Volatile: true, Desc: "Controller phase: enrolling, new, provisioning, ready, draining, stopped or error."},
			{Name: "created_at", Kind: String, ReadOnly: true, Desc: "Creation date."},
			{Name: "destroy_mode", Kind: String, OneOf: []string{"wait", "kill"}, Desc: "Only used on destroy, kept in the state: wait lets the running jobs finish, kill interrupts them. Default wait."},
			{Name: "destroy_uninstall", Kind: Bool, Desc: "Only used on destroy, kept in the state: also uninstall the runtime (and the VM of a Mac) from the machine. Default true."},
			{Name: "destroy_force", Kind: Bool, Desc: "Only used on destroy, kept in the state: forget the machine without reaching it (it is gone or unreachable). Default false."},
		},
	}
	s.Read = func(ctx context.Context, c *client.Client, id string) (map[string]any, error) {
		pools, err := rnPoolList(ctx, c)
		if err != nil {
			return nil, err
		}
		return rnNodeOf(pools, id)
	}
	s.Create = func(context.Context, *client.Client, Input) (string, error) {
		return "", errors.New(rnNodeCreateMessage)
	}
	s.Update = rnNodeUpdate
	s.Delete = func(ctx context.Context, c *client.Client, id string) error {
		return rnNodeRemove(ctx, c, id, "wait", true, false)
	}
	return s
}

const rnNodeCreateMessage = "a GitHub runner machine cannot be created by Terraform: enroll it in the Dokploy dashboard (setup script, then the code that pins its host key), then adopt it with `terraform import` (or an import block) using its githubRunnerNodeId"

// rnNodeUpdate applies the editable configuration and the on/off switch.
func rnNodeUpdate(ctx context.Context, c *client.Client, in Input) error {
	get := func(key string) any {
		if v, ok := in.Body[key]; ok {
			return v
		}
		return in.Remote[key]
	}
	payload := map[string]any{"githubRunnerNodeId": in.ID}
	changed := false
	for _, k := range rnNodeBudgetKeys {
		payload[k] = get(k)
		if !rnSame(payload[k], in.Remote[k]) {
			changed = true
		}
	}
	if changed {
		// A Linux machine applies its limits live; a Mac resizes its VM once
		// no job runs ("wait"): the controller does it, the call returns early.
		payload["mode"] = "wait"
		if err := c.TRPCMutate(ctx, "githubRunner.updateMachine", payload, nil); err != nil {
			return err
		}
	}
	want, wantOK := in.Body["enabled"].(bool)
	have, _ := in.Remote["enabled"].(bool)
	if wantOK && want != have {
		id := map[string]any{"githubRunnerNodeId": in.ID}
		if want {
			return c.TRPCMutate(ctx, "githubRunner.enableMachine", id, nil)
		}
		id["mode"] = "wait"
		id["timeoutMinutes"] = nil
		return c.TRPCMutate(ctx, "githubRunner.disableMachine", id, nil)
	}
	return nil
}

// rnNodeRemove removes the machine, then waits (for a while) until Dokploy
// finished draining it: the pool cannot be removed before.
func rnNodeRemove(ctx context.Context, c *client.Client, id, mode string, uninstall, force bool) error {
	err := c.TRPCMutate(ctx, "githubRunner.removeMachine", map[string]any{
		"githubRunnerNodeId": id,
		"mode":               mode,
		"uninstall":          uninstall,
		"force":              force,
	}, nil)
	if err != nil {
		return err
	}
	gone, err := rnWaitNodeGone(ctx, c, id)
	if err != nil {
		return warningError{msg: "The removal was requested but its progress cannot be read: " + err.Error()}
	}
	if !gone {
		return warningError{msg: "Dokploy is still draining the machine: its removal goes on in the background. Remove the pool only once the machine is gone from the dashboard."}
	}
	return nil
}

// rnNodeResource is the generic resource with three differences: creation is
// refused at plan time, the identity of the machine cannot change, and the
// destroy options live in the state only.
type rnNodeResource struct{ *genericResource }

func init() {
	spec := rnNodeSpec()
	registerResource(func() resource.Resource { return &rnNodeResource{&genericResource{spec: spec}} })
}

func (r *rnNodeResource) ModifyPlan(_ context.Context, req resource.ModifyPlanRequest, resp *resource.ModifyPlanResponse) {
	if req.Plan.Raw.IsNull() {
		return // destroy
	}
	if req.State.Raw.IsNull() {
		resp.Diagnostics.AddError("Cannot create a runner machine", "A GitHub runner machine cannot be created by Terraform: enroll it in the Dokploy dashboard (setup script, then the code that pins its host key), then adopt it with `terraform import` or an import block, using its githubRunnerNodeId.")
		return
	}
	state, err1 := objOf(req.State.Raw)
	cfg, err2 := objOf(req.Config.Raw)
	if err1 != nil || err2 != nil {
		return
	}
	for _, name := range []string{"name", "pool_id"} {
		want, ok1 := stringOf(cfg[name])
		have, ok2 := stringOf(state[name])
		if ok1 && ok2 && want != have {
			resp.Diagnostics.AddAttributeError(path.Root(name), "Cannot change a runner machine's "+name,
				fmt.Sprintf("The machine is %q in Dokploy; its name and its pool cannot be changed. Remove it and enroll it again, or fix the configuration.", have))
		}
	}
}

// Read keeps the destroy options: they are not in Dokploy.
func (r *rnNodeResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	r.genericResource.Read(ctx, req, resp)
	if resp.Diagnostics.HasError() || resp.State.Raw.IsNull() {
		return
	}
	for _, name := range rnNodeConfigOnly {
		if name == "destroy_mode" {
			var v types.String
			resp.Diagnostics.Append(req.State.GetAttribute(ctx, path.Root(name), &v)...)
			resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root(name), v)...)
			continue
		}
		var v types.Bool
		resp.Diagnostics.Append(req.State.GetAttribute(ctx, path.Root(name), &v)...)
		resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root(name), v)...)
	}
}

func (r *rnNodeResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	state, err := objOf(req.State.Raw)
	if err != nil {
		resp.Diagnostics.AddError("Cannot read the state", err.Error())
		return
	}
	id, _ := stringOf(state["id"])
	mode := "wait"
	if s, ok := stringOf(state["destroy_mode"]); ok && s != "" {
		mode = s
	}
	uninstall := true
	if b, ok := rnBoolOf(state["destroy_uninstall"]); ok {
		uninstall = b
	}
	force, _ := rnBoolOf(state["destroy_force"])
	if err := rnNodeRemove(ctx, r.client, id, mode, uninstall, force); err != nil && !errors.Is(err, client.ErrNotFound) {
		var w warningError
		if errors.As(err, &w) {
			resp.Diagnostics.AddWarning(fmt.Sprintf("github_runner_node %s: removal not finished", id), w.msg)
			return
		}
		resp.Diagnostics.AddError(fmt.Sprintf("Cannot delete github_runner_node %s", id), err.Error())
	}
}

func rnBoolOf(v tftypes.Value) (bool, bool) {
	if v.IsNull() || !v.IsFullyKnown() {
		return false, false
	}
	var b bool
	if v.As(&b) != nil {
		return false, false
	}
	return b, true
}
