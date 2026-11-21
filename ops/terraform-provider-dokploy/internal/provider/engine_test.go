package provider

import (
	"fmt"
	"regexp"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	"github.com/hashicorp/terraform-plugin-go/tfprotov6"
	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/knownvalue"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/statecheck"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
	"github.com/hashicorp/terraform-plugin-testing/tfjsonpath"
)

func factories() map[string]func() (tfprotov6.ProviderServer, error) {
	return map[string]func() (tfprotov6.ProviderServer, error){
		"dokploy": providerserver.NewProtocol6WithError(New("test")()),
	}
}

func providerBlock(url string) string {
	return fmt.Sprintf(`
provider "dokploy" {
  url     = %q
  api_key = "test-key"
}
`, url)
}

func TestProjectLifecycleAndEnvSplit(t *testing.T) {
	f, srv := newFakeAPI(t)
	cfg := func(extra string) string {
		return providerBlock(srv.URL) + `
resource "dokploy_project" "p" {
  name        = "demo"
  description = "first"
` + extra + `
}
`
	}
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				// Create: a public variable goes to the state, a secret one is
				// sent once through the write-only attribute and never stored.
				Config: cfg(`
  env             = { PUBLIC_URL = "https://example.test" }
  secret_env_keys = ["HIDDEN_ONE"]
  secret_env_wo   = { HIDDEN_ONE = "alpha-value" }
`),
				ConfigStateChecks: []statecheck.StateCheck{
					statecheck.ExpectKnownValue("dokploy_project.p", tfjsonpath.New("env_keys"), knownvalue.SetExact([]knownvalue.Check{
						knownvalue.StringExact("HIDDEN_ONE"), knownvalue.StringExact("PUBLIC_URL"),
					})),
					statecheck.ExpectKnownValue("dokploy_project.p", tfjsonpath.New("secret_env_wo"), knownvalue.Null()),
				},
				Check: func(s *terraform.State) error {
					id = idOf(s, "dokploy_project.p")
					env := fmt.Sprint(f.get("project", id)["env"])
					if !strings.Contains(env, "HIDDEN_ONE=alpha-value") || !strings.Contains(env, "PUBLIC_URL=https://example.test") {
						return fmt.Errorf("remote env is %q", env)
					}
					return notInState(s, "alpha-value")
				},
			},
			{
				// No further change: an empty plan, the secret is not touched.
				Config: cfg(`
  env             = { PUBLIC_URL = "https://example.test" }
  secret_env_keys = ["HIDDEN_ONE"]
`),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
			{
				// A public change rewrites the text but keeps the secret verbatim.
				Config: cfg(`
  env             = { PUBLIC_URL = "https://other.test" }
  secret_env_keys = ["HIDDEN_ONE"]
`),
				Check: func(s *terraform.State) error {
					env := fmt.Sprint(f.get("project", id)["env"])
					if !strings.Contains(env, "HIDDEN_ONE=alpha-value") || !strings.Contains(env, "PUBLIC_URL=https://other.test") {
						return fmt.Errorf("remote env is %q", env)
					}
					return nil
				},
			},
			{
				// A variable added in Dokploy by hand is drift: it is removed.
				PreConfig: func() {
					f.set("project", id, "env", fmt.Sprint(f.get("project", id)["env"])+"EXTRA=1\n")
				},
				Config: cfg(`
  env             = { PUBLIC_URL = "https://other.test" }
  secret_env_keys = ["HIDDEN_ONE"]
`),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("dokploy_project.p", plancheck.ResourceActionUpdate),
				}},
				Check: func(s *terraform.State) error {
					if env := fmt.Sprint(f.get("project", id)["env"]); strings.Contains(env, "EXTRA") {
						return fmt.Errorf("drift not corrected: %q", env)
					}
					return nil
				},
			},
			{
				// A secret rotation needs the write-only value and a new version.
				Config: cfg(`
  env                   = { PUBLIC_URL = "https://other.test" }
  secret_env_keys       = ["HIDDEN_ONE"]
  secret_env_wo         = { HIDDEN_ONE = "rotated" }
  secret_env_wo_version = 2
`),
				Check: func(s *terraform.State) error {
					if env := fmt.Sprint(f.get("project", id)["env"]); !strings.Contains(env, "HIDDEN_ONE=rotated") {
						return fmt.Errorf("secret not rotated: %q", env)
					}
					return notInState(s, "rotated")
				},
			},
		},
	})
}

func TestImportKeepsSecretsAndMissingSecretFails(t *testing.T) {
	f, srv := newFakeAPI(t)
	id := f.seed("project", map[string]any{
		"name": "legacy", "description": "", "organizationId": "org-1",
		"env": "# comment\nHIDDEN_TWO=\"two words\"\nPUBLIC=1\nCERT=\"line1\nline2\"\n",
	})
	cfg := providerBlock(srv.URL) + `
import {
  to = dokploy_project.p
  id = "` + id + `"
}
resource "dokploy_project" "p" {
  name            = "legacy"
  env             = { PUBLIC = "1" }
  secret_env_keys = ["HIDDEN_TWO", "CERT"]
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: cfg,
				Check: func(s *terraform.State) error {
					env := fmt.Sprint(f.get("project", id)["env"])
					// Secret entries, quotes and multi-line values included, are
					// carried over byte for byte.
					for _, want := range []string{"HIDDEN_TWO=\"two words\"\n", "CERT=\"line1\nline2\"\n", "PUBLIC=1\n"} {
						if !strings.Contains(env, want) {
							return fmt.Errorf("remote env lost %q: %q", want, env)
						}
					}
					return notInState(s, "two words")
				},
			},
			{
				// Declaring a secret that does not exist remotely fails loudly.
				Config:      strings.Replace(cfg, `["HIDDEN_TWO", "CERT"]`, `["HIDDEN_TWO", "CERT", "MISSING"]`, 1),
				ExpectError: regexp.MustCompile(`MISSING.*no value in Dokploy`),
			},
		},
	})
}

func TestSSHKeyWriteOnlyPrivateKey(t *testing.T) {
	f, srv := newFakeAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config: providerBlock(srv.URL) + `
resource "dokploy_ssh_key" "k" {
  name           = "deploy"
  public_key     = "ssh-ed25519 AAAA test"
  private_key_wo = "fixture-material"
}
`,
			Check: func(s *terraform.State) error {
				id := idOf(s, "dokploy_ssh_key.k")
				if f.get("sshKey", id)["privateKey"] != "fixture-material" {
					return fmt.Errorf("private key not sent")
				}
				return notInState(s, "fixture-material")
			},
		}},
	})
}

func TestResourceRemovedOutsideTerraform(t *testing.T) {
	f, srv := newFakeAPI(t)
	cfg := providerBlock(srv.URL) + `
resource "dokploy_project" "p" {
  name = "gone"
}
`
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{Config: cfg, Check: func(s *terraform.State) error { id = idOf(s, "dokploy_project.p"); return nil }},
			{
				PreConfig: func() { f.mu.Lock(); delete(f.objs["project"], id); f.mu.Unlock() },
				Config:    cfg,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("dokploy_project.p", plancheck.ResourceActionCreate),
				}},
			},
		},
	})
}

func idOf(s *terraform.State, addr string) string {
	rs, ok := s.RootModule().Resources[addr]
	if !ok {
		return ""
	}
	return rs.Primary.ID
}

// notInState fails when a secret value appears anywhere in the state.
func notInState(s *terraform.State, secret string) error {
	for addr, rs := range s.RootModule().Resources {
		for k, v := range rs.Primary.Attributes {
			if strings.Contains(v, secret) || strings.Contains(k, secret) {
				return fmt.Errorf("%s: secret found in state attribute %s", addr, k)
			}
		}
	}
	return nil
}
