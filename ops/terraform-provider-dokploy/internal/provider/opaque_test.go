package provider

import (
	"fmt"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

// opaque_probe is a throwaway resource that exercises Field.Opaque.
func init() {
	s := &Spec{
		Name:  "opaque_probe",
		IDKey: "probeId",
		Fields: []Field{
			{Name: "name", Kind: String, Required: true},
			{Name: "note", Kind: String, Opaque: true},
		},
	}
	s.UseREST(CRUD{Router: "probe"})
	register(s)
}

func TestOpaqueFieldIsNeverReadUnlessDeclared(t *testing.T) {
	f, srv := newFakeAPI(t)
	f.routes["probe"] = "probeId"
	id := f.seed("probe", map[string]any{"name": "legacy", "note": "line with an inline credential"})
	base := providerBlock(srv.URL) + `
import {
  to = dokploy_opaque_probe.p
  id = "` + id + `"
}
`
	undeclared := base + `
resource "dokploy_opaque_probe" "p" {
  name = "legacy"
}
`
	declared := base + `
resource "dokploy_opaque_probe" "p" {
  name = "legacy"
  note = "line with an inline credential"
}
`
	changed := strings.Replace(declared, "line with an inline credential", "another text", 1)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				// Adopted without declaring the text: it never reaches the state.
				Config: undeclared,
				Check: func(s *terraform.State) error {
					return notInState(s, "inline credential")
				},
			},
			{
				Config:           undeclared,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
			{
				// Declared for the first time with the very text Dokploy holds:
				// the state records it, nothing is written to Dokploy.
				Config: declared,
				Check: func(*terraform.State) error {
					if n := f.called("probe.update"); n != 0 {
						return fmt.Errorf("probe.update was called %d times", n)
					}
					return nil
				},
			},
			{
				Config:           declared,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
			{
				Config: changed,
				Check: func(*terraform.State) error {
					if got := fmt.Sprint(f.get("probe", id)["note"]); got != "another text" {
						return fmt.Errorf("remote note is %q", got)
					}
					return nil
				},
			},
		},
	})
}

// A plan that only touches the environment must not rewrite the object: the
// first apply after an import then writes nothing at all to Dokploy.
func TestEnvOnlyPlanSendsNoUpdateOfTheObject(t *testing.T) {
	f, srv := newFakeAPI(t)
	id := f.seed("project", map[string]any{
		"name": "legacy", "description": "", "organizationId": "org-1",
		"env": "# kept comment\nPUBLIC=1\nHIDDEN_ONE=two words\n",
	})
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: providerBlock(srv.URL) + `
import {
  to = dokploy_project.p
  id = "` + id + `"
}
resource "dokploy_project" "p" {
  name            = "legacy"
  env             = { PUBLIC = "1" }
  secret_env_keys = ["HIDDEN_ONE"]
}
`,
				Check: func(*terraform.State) error {
					if n := f.called("project.update"); n != 0 {
						return fmt.Errorf("project.update was called %d times", n)
					}
					if n := f.called("project.create"); n != 0 {
						return fmt.Errorf("project.create was called %d times", n)
					}
					if env := fmt.Sprint(f.get("project", id)["env"]); !strings.Contains(env, "# kept comment") {
						return fmt.Errorf("the remote environment was rewritten: %q", env)
					}
					return nil
				},
			},
		},
	})
}
