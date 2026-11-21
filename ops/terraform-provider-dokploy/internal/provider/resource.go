package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/hashicorp/terraform-plugin-framework-validators/stringvalidator"
	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/boolplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/int64planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/listplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/mapplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/planmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/setplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/resource/schema/stringplanmodifier"
	"github.com/hashicorp/terraform-plugin-framework/schema/validator"
	"github.com/hashicorp/terraform-plugin-framework/types"
	"github.com/hashicorp/terraform-plugin-go/tftypes"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

// Obj is the attributes of a resource, as Terraform values.
type Obj map[string]tftypes.Value

// Input is what the CRUD hooks of a Spec receive.
type Input struct {
	// ID is the resource id (empty on create).
	ID string
	// Body is the API payload built from the plan, write-only values from the
	// configuration included. On update the id is already set under IDKey.
	Body map[string]any
	// Remote is the object as the API returns it now (update only).
	Remote map[string]any
	// Plan, Config and State are the raw attributes (State: update only).
	Plan, Config, State Obj
}

// EnvSpec enables the env / secret_env_keys / secret_env_wo mechanism on a
// resource (see envfile.go).
type EnvSpec struct {
	// API is the JSON key of the environment text; default "env".
	API string
	// Save stores the environment text. Required: services keep it behind a
	// dedicated procedure (compose.saveEnvironment, ...).
	Save func(ctx context.Context, c *client.Client, id, text string, remote map[string]any) error
}

// Spec describes a resource declaratively. The generic resource turns it into
// a Terraform resource.
type Spec struct {
	// Name is the type name without the provider prefix: "ssh_key" gives
	// dokploy_ssh_key.
	Name string
	Desc string
	// IDKey is the JSON key of the object id in API answers.
	IDKey  string
	Fields []Field
	Env    *EnvSpec
	// SecretsVersion adds a secrets_version attribute: bump it to send the
	// write-only attributes again without changing anything else.
	SecretsVersion bool

	// Create stores the object and returns its id.
	Create func(ctx context.Context, c *client.Client, in Input) (string, error)
	// Read returns the object, or an error matching client.ErrNotFound.
	Read func(ctx context.Context, c *client.Client, id string) (map[string]any, error)
	// Update applies in.Body.
	Update func(ctx context.Context, c *client.Client, in Input) error
	// Delete removes the object.
	Delete func(ctx context.Context, c *client.Client, id string) error
	// ImportHint documents the import id.
	ImportHint string
}

func (s *Spec) envAPI() string {
	if s.Env != nil && s.Env.API != "" {
		return s.Env.API
	}
	return "env"
}

// ---------------------------------------------------------------- schema

func (f Field) attribute() schema.Attribute {
	computed := f.computed()
	optional := !f.Required && !f.ReadOnly
	sensitive := f.Sensitive || f.WriteOnly
	desc := f.Desc
	if f.WriteOnly {
		desc += " Write-only: never stored in the plan or the state."
	}
	switch f.Kind {
	case Bool:
		a := schema.BoolAttribute{Description: desc, Required: f.Required, Optional: optional, Computed: computed, Sensitive: sensitive, WriteOnly: f.WriteOnly}
		if !f.WriteOnly {
			if computed && !f.Volatile {
				a.PlanModifiers = append(a.PlanModifiers, boolplanmodifier.UseStateForUnknown())
			}
			if f.ForceNew {
				a.PlanModifiers = append(a.PlanModifiers, boolplanmodifier.RequiresReplaceIfConfigured())
			}
		}
		return a
	case Int:
		a := schema.Int64Attribute{Description: desc, Required: f.Required, Optional: optional, Computed: computed, Sensitive: sensitive, WriteOnly: f.WriteOnly}
		if !f.WriteOnly {
			if computed && !f.Volatile {
				a.PlanModifiers = append(a.PlanModifiers, int64planmodifier.UseStateForUnknown())
			}
			if f.ForceNew {
				a.PlanModifiers = append(a.PlanModifiers, int64planmodifier.RequiresReplaceIfConfigured())
			}
		}
		return a
	case StringList:
		a := schema.ListAttribute{ElementType: types.StringType, Description: desc, Required: f.Required, Optional: optional, Computed: computed, Sensitive: sensitive, WriteOnly: f.WriteOnly}
		if !f.WriteOnly {
			if computed && !f.Volatile {
				a.PlanModifiers = append(a.PlanModifiers, listplanmodifier.UseStateForUnknown())
			}
			if f.ForceNew {
				a.PlanModifiers = append(a.PlanModifiers, listplanmodifier.RequiresReplaceIfConfigured())
			}
		}
		return a
	case StringSet:
		a := schema.SetAttribute{ElementType: types.StringType, Description: desc, Required: f.Required, Optional: optional, Computed: computed, Sensitive: sensitive} // sets cannot be write-only
		if !f.WriteOnly {
			if computed && !f.Volatile {
				a.PlanModifiers = append(a.PlanModifiers, setplanmodifier.UseStateForUnknown())
			}
			if f.ForceNew {
				a.PlanModifiers = append(a.PlanModifiers, setplanmodifier.RequiresReplaceIfConfigured())
			}
		}
		return a
	case StringMap:
		a := schema.MapAttribute{ElementType: types.StringType, Description: desc, Required: f.Required, Optional: optional, Computed: computed, Sensitive: sensitive, WriteOnly: f.WriteOnly}
		if !f.WriteOnly {
			if computed && !f.Volatile {
				a.PlanModifiers = append(a.PlanModifiers, mapplanmodifier.UseStateForUnknown())
			}
			if f.ForceNew {
				a.PlanModifiers = append(a.PlanModifiers, mapplanmodifier.RequiresReplaceIfConfigured())
			}
		}
		return a
	default: // String, JSON
		a := schema.StringAttribute{Description: desc, Required: f.Required, Optional: optional, Computed: computed, Sensitive: sensitive, WriteOnly: f.WriteOnly}
		var vs []validator.String
		if len(f.OneOf) > 0 {
			vs = append(vs, stringvalidator.OneOf(f.OneOf...))
		}
		if f.Kind == JSON {
			vs = append(vs, validJSON{})
		}
		a.Validators = vs
		if !f.WriteOnly {
			var mods []planmodifier.String
			if computed && !f.Volatile {
				mods = append(mods, stringplanmodifier.UseStateForUnknown())
			}
			if f.ForceNew {
				mods = append(mods, stringplanmodifier.RequiresReplaceIfConfigured())
			}
			a.PlanModifiers = mods
		}
		return a
	}
}

type validJSON struct{}

func (validJSON) Description(context.Context) string             { return "must be valid JSON" }
func (v validJSON) MarkdownDescription(c context.Context) string { return v.Description(c) }
func (validJSON) ValidateString(_ context.Context, req validator.StringRequest, resp *validator.StringResponse) {
	if req.ConfigValue.IsNull() || req.ConfigValue.IsUnknown() {
		return
	}
	if !json.Valid([]byte(req.ConfigValue.ValueString())) {
		resp.Diagnostics.AddAttributeError(req.Path, "Invalid JSON", "The value must be valid JSON, for example built with jsonencode().")
	}
}

func (s *Spec) schema() schema.Schema {
	attrs := map[string]schema.Attribute{
		"id": schema.StringAttribute{
			Computed:      true,
			Description:   "Dokploy id of the object. " + s.ImportHint,
			PlanModifiers: []planmodifier.String{stringplanmodifier.UseStateForUnknown()},
		},
	}
	for _, f := range s.Fields {
		attrs[f.Name] = f.attribute()
	}
	if s.Env != nil {
		attrs["env"] = schema.MapAttribute{
			ElementType: types.StringType,
			Optional:    true,
			Description: "Public environment variables, as the literal text after the '=' of the dotenv line. Stored in the state: never put a secret here, declare it in secret_env_keys. When env and secret_env_keys are both left out, the environment is not managed.",
		}
		attrs["secret_env_keys"] = schema.SetAttribute{
			ElementType: types.StringType,
			Optional:    true,
			Description: "Names of the secret environment variables. Their values stay in Dokploy and are copied over untouched; the provider never reads them into the state. Every variable of the service must be declared in env or here: an undeclared one is removed on apply.",
		}
		attrs["secret_env_wo"] = schema.MapAttribute{
			ElementType: types.StringType,
			Optional:    true,
			Sensitive:   true,
			WriteOnly:   true,
			Description: "Values of secret variables to set or rotate (keys must be in secret_env_keys). Write-only: never stored in the plan or the state. Bump secret_env_wo_version to send them again.",
		}
		attrs["secret_env_wo_version"] = schema.Int64Attribute{
			Optional:    true,
			Description: "Change this number to send secret_env_wo again.",
		}
		attrs["env_keys"] = schema.SetAttribute{
			ElementType: types.StringType,
			Computed:    true,
			Description: "Names of the variables currently set in Dokploy; a difference with env and secret_env_keys is reported as drift.",
		}
	}
	if s.SecretsVersion {
		attrs["secrets_version"] = schema.Int64Attribute{
			Optional:    true,
			Description: "Change this number to send the write-only attributes again.",
		}
	}
	return schema.Schema{Description: s.Desc, Attributes: attrs}
}

// -------------------------------------------------------------- resource

type genericResource struct {
	spec   *Spec
	client *client.Client
}

// NewResource returns the Terraform resource for a Spec.
func NewResource(s *Spec) func() resource.Resource {
	return func() resource.Resource { return &genericResource{spec: s} }
}

var (
	_ resource.ResourceWithConfigure      = (*genericResource)(nil)
	_ resource.ResourceWithImportState    = (*genericResource)(nil)
	_ resource.ResourceWithModifyPlan     = (*genericResource)(nil)
	_ resource.ResourceWithValidateConfig = (*genericResource)(nil)
)

func (r *genericResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + "_" + r.spec.Name
}

func (r *genericResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = r.spec.schema()
}

func (r *genericResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}
	c, ok := req.ProviderData.(*client.Client)
	if !ok {
		resp.Diagnostics.AddError("Unexpected provider data", fmt.Sprintf("expected *client.Client, got %T", req.ProviderData))
		return
	}
	r.client = c
}

func (r *genericResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root("id"), req.ID)...)
}

func objOf(v tftypes.Value) (Obj, error) {
	var m map[string]tftypes.Value
	if err := v.As(&m); err != nil {
		return nil, err
	}
	return Obj(m), nil
}

// finalize builds the object value, null for the attributes vals leaves out.
func finalize(ty tftypes.Type, vals Obj) tftypes.Value {
	obj := ty.(tftypes.Object)
	full := make(map[string]tftypes.Value, len(obj.AttributeTypes))
	for name, t := range obj.AttributeTypes {
		if v, ok := vals[name]; ok && v.Type() != nil {
			full[name] = v
		} else {
			full[name] = tftypes.NewValue(t, nil)
		}
	}
	return tftypes.NewValue(ty, full)
}

func stringOf(v tftypes.Value) (string, bool) {
	if v.IsNull() || !v.IsFullyKnown() {
		return "", false
	}
	var s string
	if v.As(&s) != nil {
		return "", false
	}
	return s, true
}

func mapOf(v tftypes.Value) (map[string]string, bool) {
	if v.IsNull() || !v.IsFullyKnown() {
		return nil, false
	}
	var m map[string]tftypes.Value
	if v.As(&m) != nil {
		return nil, false
	}
	out := make(map[string]string, len(m))
	for k, e := range m {
		var s string
		if e.As(&s) != nil {
			return nil, false
		}
		out[k] = s
	}
	return out, true
}

func setOf(v tftypes.Value) ([]string, bool) {
	if v.IsNull() || !v.IsFullyKnown() {
		return nil, false
	}
	var l []tftypes.Value
	if v.As(&l) != nil {
		return nil, false
	}
	out := make([]string, 0, len(l))
	for _, e := range l {
		var s string
		if e.As(&s) != nil {
			return nil, false
		}
		out = append(out, s)
	}
	sort.Strings(out)
	return out, true
}

func stringSetValue(keys []string) tftypes.Value {
	vals := make([]tftypes.Value, 0, len(keys))
	for _, k := range keys {
		vals = append(vals, tftypes.NewValue(tftypes.String, k))
	}
	return tftypes.NewValue(tftypes.Set{ElementType: tftypes.String}, vals)
}

func stringMapValue(m map[string]string) tftypes.Value {
	vals := make(map[string]tftypes.Value, len(m))
	for k, v := range m {
		vals[k] = tftypes.NewValue(tftypes.String, v)
	}
	return tftypes.NewValue(tftypes.Map{ElementType: tftypes.String}, vals)
}

func asString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	default:
		return fmt.Sprint(x)
	}
}

// body builds the API payload from the plan; write-only values come from the
// configuration.
func (s *Spec) body(plan, cfg Obj, create bool) map[string]any {
	body := map[string]any{}
	for _, f := range s.Fields {
		if f.ReadOnly {
			continue
		}
		src := plan
		if f.WriteOnly {
			src = cfg
		}
		v, ok := src[f.Name]
		if !ok {
			continue
		}
		val, ok := fromTF(f.Kind, v)
		if !ok {
			if create && f.Default != nil && !f.WriteOnly {
				body[f.apiKey()] = f.Default
			}
			continue
		}
		if f.ToAPI != nil {
			val = f.ToAPI(val)
		}
		body[f.apiKey()] = val
	}
	return body
}

// fieldsChanged reports whether the plan changes anything the Update hook
// writes: a known planned value that differs from the state, or a new
// secrets_version. Read-only, write-only and unknown values do not count; an
// opaque attribute declared for the first time does not count either when Dokploy
// already holds exactly that text.
func (s *Spec) fieldsChanged(plan, state Obj, remote map[string]any) bool {
	for _, f := range s.Fields {
		if f.ReadOnly || f.WriteOnly {
			continue
		}
		p, ok := plan[f.Name]
		if !ok || p.Type() == nil || !p.IsFullyKnown() {
			continue
		}
		prev, ok := state[f.Name]
		if f.Opaque && (!ok || prev.Type() == nil || prev.IsNull()) {
			// First time the attribute is declared: Dokploy may already hold
			// exactly that text, which is then no change at all.
			raw := remote[f.apiKey()]
			if f.FromAPI != nil {
				raw = f.FromAPI(raw)
			}
			if p.Equal(toTF(f.Kind, raw)) {
				continue
			}
			return true
		}
		if !ok || prev.Type() == nil || !p.Equal(prev) {
			return true
		}
	}
	if s.SecretsVersion {
		p, prev := plan["secrets_version"], state["secrets_version"]
		if p.Type() != nil && prev.Type() != nil && !p.Equal(prev) {
			return true
		}
	}
	return false
}

// envManaged reports whether the plan manages the environment.
func envManaged(v Obj) bool {
	return !v["env"].IsNull() || !v["secret_env_keys"].IsNull()
}

// stateVals builds the state from the API object. When applying, values known
// in the plan win over what the API reports, so a normalization on the API
// side cannot fail the apply; the next refresh shows the real value.
func (s *Spec) stateVals(id string, remote map[string]any, ref Obj, applying bool) Obj {
	out := Obj{"id": tftypes.NewValue(tftypes.String, id)}
	for _, f := range s.Fields {
		if f.WriteOnly {
			out[f.Name] = nullOf(f.Kind)
			continue
		}
		if applying {
			if pv, ok := ref[f.Name]; ok && pv.IsFullyKnown() {
				out[f.Name] = pv
				continue
			}
		}
		if f.Opaque && !applying {
			// Only read back what the configuration declared.
			if pv, ok := ref[f.Name]; !ok || pv.Type() == nil || pv.IsNull() {
				out[f.Name] = nullOf(f.Kind)
				continue
			}
		}
		raw := remote[f.apiKey()]
		if f.FromAPI != nil {
			raw = f.FromAPI(raw)
		}
		out[f.Name] = toTF(f.Kind, raw)
	}
	if s.SecretsVersion {
		if v, ok := ref["secrets_version"]; ok {
			out["secrets_version"] = v
		}
	}
	if s.Env != nil {
		entries := parseEnv(asString(remote[s.envAPI()]))
		out["env_keys"] = stringSetValue(envKeys(entries))
		byKey := envIndex(entries)
		out["secret_env_keys"] = ref["secret_env_keys"]
		if v, ok := ref["secret_env_wo_version"]; ok {
			out["secret_env_wo_version"] = v
		}
		prev, hasPrev := mapOf(ref["env"])
		switch {
		case applying && hasPrev:
			out["env"] = ref["env"]
		case hasPrev:
			pub := map[string]string{}
			for k := range prev {
				if e, ok := byKey[k]; ok {
					pub[k] = e.Value
				}
			}
			out["env"] = stringMapValue(pub)
		}
	}
	return out
}

func (r *genericResource) writeEnv(ctx context.Context, id string, plan, cfg Obj, remote map[string]any) error {
	if r.spec.Env == nil || !envManaged(plan) {
		return nil
	}
	public, _ := mapOf(plan["env"])
	secretKeys, _ := setOf(plan["secret_env_keys"])
	wo, _ := mapOf(cfg["secret_env_wo"])
	current := parseEnv(asString(remote[r.spec.envAPI()]))
	text, err := renderEnv(public, secretKeys, wo, current)
	if err != nil {
		return err
	}
	if sameEnv(parseEnv(text), current) {
		return nil
	}
	return r.spec.Env.Save(ctx, r.client, id, text, remote)
}

func sameEnv(a, b []envEntry) bool {
	if len(a) != len(b) {
		return false
	}
	bi := envIndex(b)
	for _, e := range a {
		o, ok := bi[e.Key]
		if !ok || o.Raw != e.Raw {
			return false
		}
	}
	return true
}

func (r *genericResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	plan, err := objOf(req.Plan.Raw)
	if err != nil {
		resp.Diagnostics.AddError("Cannot read the plan", err.Error())
		return
	}
	cfg, err := objOf(req.Config.Raw)
	if err != nil {
		resp.Diagnostics.AddError("Cannot read the configuration", err.Error())
		return
	}
	ty := req.Plan.Raw.Type()
	in := Input{Body: r.spec.body(plan, cfg, true), Plan: plan, Config: cfg}
	id, err := r.spec.Create(ctx, r.client, in)
	if err != nil {
		resp.Diagnostics.AddError(fmt.Sprintf("Cannot create %s", r.spec.Name), err.Error())
		return
	}
	// From here the object exists: keep it in the state even if a later step
	// fails, so Terraform marks it tainted instead of losing it.
	resp.State.Raw = finalize(ty, r.partialState(id, plan))
	remote, err := r.spec.Read(ctx, r.client, id)
	if err != nil {
		resp.Diagnostics.AddError(fmt.Sprintf("Cannot read the new %s", r.spec.Name), err.Error())
		return
	}
	if err := r.writeEnv(ctx, id, plan, cfg, remote); err != nil {
		resp.Diagnostics.AddError(fmt.Sprintf("Cannot set the environment of the new %s", r.spec.Name), err.Error())
		return
	}
	if r.spec.Env != nil && envManaged(plan) {
		if remote, err = r.spec.Read(ctx, r.client, id); err != nil {
			resp.Diagnostics.AddError(fmt.Sprintf("Cannot read the new %s", r.spec.Name), err.Error())
			return
		}
	}
	resp.State.Raw = finalize(ty, r.spec.stateVals(id, remote, plan, true))
}

// partialState keeps the planned values that are known and nulls the rest.
func (r *genericResource) partialState(id string, plan Obj) Obj {
	out := Obj{"id": tftypes.NewValue(tftypes.String, id)}
	for name, v := range plan {
		if name == "id" || !v.IsFullyKnown() {
			continue
		}
		out[name] = v
	}
	for _, f := range r.spec.Fields {
		if f.WriteOnly {
			delete(out, f.Name)
		}
	}
	delete(out, "secret_env_wo")
	return out
}

func (r *genericResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	state, err := objOf(req.State.Raw)
	if err != nil {
		resp.Diagnostics.AddError("Cannot read the state", err.Error())
		return
	}
	id, _ := stringOf(state["id"])
	remote, err := r.spec.Read(ctx, r.client, id)
	if errors.Is(err, client.ErrNotFound) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		resp.Diagnostics.AddError(fmt.Sprintf("Cannot read %s %s", r.spec.Name, id), err.Error())
		return
	}
	resp.State.Raw = finalize(req.State.Raw.Type(), r.spec.stateVals(id, remote, state, false))
}

func (r *genericResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	plan, err := objOf(req.Plan.Raw)
	if err != nil {
		resp.Diagnostics.AddError("Cannot read the plan", err.Error())
		return
	}
	cfg, err := objOf(req.Config.Raw)
	if err != nil {
		resp.Diagnostics.AddError("Cannot read the configuration", err.Error())
		return
	}
	state, err := objOf(req.State.Raw)
	if err != nil {
		resp.Diagnostics.AddError("Cannot read the state", err.Error())
		return
	}
	id, _ := stringOf(state["id"])
	remote, err := r.spec.Read(ctx, r.client, id)
	if err != nil {
		resp.Diagnostics.AddError(fmt.Sprintf("Cannot read %s %s", r.spec.Name, id), err.Error())
		return
	}
	// A plan that only touches the environment (the first apply after an
	// import, or a drifted variable) must not rewrite the object itself.
	if r.spec.fieldsChanged(plan, state, remote) {
		body := r.spec.body(plan, cfg, false)
		body[r.spec.IDKey] = id
		if err := r.spec.Update(ctx, r.client, Input{ID: id, Body: body, Remote: remote, Plan: plan, Config: cfg, State: state}); err != nil {
			resp.Diagnostics.AddError(fmt.Sprintf("Cannot update %s %s", r.spec.Name, id), err.Error())
			return
		}
	}
	if err := r.writeEnv(ctx, id, plan, cfg, remote); err != nil {
		resp.Diagnostics.AddError(fmt.Sprintf("Cannot set the environment of %s %s", r.spec.Name, id), err.Error())
		return
	}
	remote, err = r.spec.Read(ctx, r.client, id)
	if err != nil {
		resp.Diagnostics.AddError(fmt.Sprintf("Cannot read %s %s", r.spec.Name, id), err.Error())
		return
	}
	resp.State.Raw = finalize(req.Plan.Raw.Type(), r.spec.stateVals(id, remote, plan, true))
}

func (r *genericResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	state, err := objOf(req.State.Raw)
	if err != nil {
		resp.Diagnostics.AddError("Cannot read the state", err.Error())
		return
	}
	id, _ := stringOf(state["id"])
	if err := r.spec.Delete(ctx, r.client, id); err != nil && !errors.Is(err, client.ErrNotFound) {
		resp.Diagnostics.AddError(fmt.Sprintf("Cannot delete %s %s", r.spec.Name, id), err.Error())
	}
}

// ModifyPlan computes env_keys, the names the environment will hold, so that
// a variable added or removed outside Terraform shows up as a diff.
func (r *genericResource) ModifyPlan(ctx context.Context, req resource.ModifyPlanRequest, resp *resource.ModifyPlanResponse) {
	if r.spec.Env == nil || req.Plan.Raw.IsNull() {
		return
	}
	plan, err := objOf(req.Plan.Raw)
	if err != nil {
		return
	}
	set := func(v tftypes.Value) {
		sv, d := typesSet(ctx, v)
		resp.Diagnostics.Append(d...)
		resp.Diagnostics.Append(resp.Plan.SetAttribute(ctx, path.Root("env_keys"), sv)...)
	}
	if !envManaged(plan) {
		if req.State.Raw.IsNull() {
			set(tftypes.NewValue(tftypes.Set{ElementType: tftypes.String}, tftypes.UnknownValue))
			return
		}
		if st, err := objOf(req.State.Raw); err == nil {
			set(st["env_keys"])
		}
		return
	}
	public := plan["env"]
	secret := plan["secret_env_keys"]
	if !public.IsFullyKnown() || !secret.IsFullyKnown() {
		set(tftypes.NewValue(tftypes.Set{ElementType: tftypes.String}, tftypes.UnknownValue))
		return
	}
	keys := map[string]bool{}
	if m, ok := mapOf(public); ok {
		for k := range m {
			keys[k] = true
		}
	}
	if l, ok := setOf(secret); ok {
		for _, k := range l {
			keys[k] = true
		}
	}
	list := make([]string, 0, len(keys))
	for k := range keys {
		list = append(list, k)
	}
	sort.Strings(list)
	set(stringSetValue(list))
}

// typesSet converts a raw set of strings to a framework value.
func typesSet(ctx context.Context, v tftypes.Value) (types.Set, diag.Diagnostics) {
	switch {
	case !v.IsKnown():
		return types.SetUnknown(types.StringType), nil
	case v.IsNull():
		return types.SetNull(types.StringType), nil
	}
	keys, _ := setOf(v)
	elems := make([]types.String, 0, len(keys))
	for _, k := range keys {
		elems = append(elems, types.StringValue(k))
	}
	return types.SetValueFrom(ctx, types.StringType, elems)
}

// ValidateConfig checks the environment declarations.
func (r *genericResource) ValidateConfig(_ context.Context, req resource.ValidateConfigRequest, resp *resource.ValidateConfigResponse) {
	if r.spec.Env == nil || req.Config.Raw.IsNull() {
		return
	}
	cfg, err := objOf(req.Config.Raw)
	if err != nil {
		return
	}
	public, okPub := mapOf(cfg["env"])
	secret, okSec := setOf(cfg["secret_env_keys"])
	if okPub && okSec {
		declared := map[string]bool{}
		for _, k := range secret {
			declared[k] = true
		}
		for k := range public {
			if declared[k] {
				resp.Diagnostics.AddAttributeError(path.Root("env"), "Variable declared twice", fmt.Sprintf("%q is in env and in secret_env_keys.", k))
			}
		}
	}
	if wo, ok := mapOf(cfg["secret_env_wo"]); ok && okSec {
		declared := map[string]bool{}
		for _, k := range secret {
			declared[k] = true
		}
		for k := range wo {
			if !declared[k] {
				resp.Diagnostics.AddAttributeError(path.Root("secret_env_wo"), "Unknown secret variable", fmt.Sprintf("%q is not listed in secret_env_keys.", k))
			}
		}
	}
}
