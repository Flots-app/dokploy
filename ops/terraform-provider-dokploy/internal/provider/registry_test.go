package provider

import (
	"fmt"
	"regexp"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

func TestRegistryLifecycle(t *testing.T) {
	a := newBackupsAPI(t)
	cfg := func(body string) string {
		return providerBlock(a.srv.URL) + `
resource "dokploy_registry" "r" {
` + body + `
}
`
	}
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				// No prefix: registry.create still wants the key (null).
				Config: cfg(`
  registry_name   = "GHCR"
  registry_url    = "ghcr.io"
  username        = "ci-bot"
  password_wo     = "fx_fixture-token"
  secrets_version = 1
`),
				Check: func(s *terraform.State) error {
					id = idOf(s, "dokploy_registry.r")
					body := a.calls.last("registry.create")
					if v, ok := body["imagePrefix"]; !ok || v != nil {
						return fmt.Errorf("imagePrefix should be sent as null: %#v", body)
					}
					if body["registryType"] != "cloud" || body["password"] != "fx_fixture-token" {
						return fmt.Errorf("unexpected create payload: %v", body)
					}
					return notInState(s, "fx_fixture-token")
				},
			},
			{
				// A partial update without the password.
				Config: cfg(`
  registry_name   = "GHCR"
  registry_url    = "ghcr.io"
  username        = "ci-bot"
  image_prefix    = "Flots-app"
  secrets_version = 1
`),
				Check: func(s *terraform.State) error {
					body := a.calls.last("registry.update")
					if _, ok := body["password"]; ok {
						return fmt.Errorf("the update sent a password: %v", body)
					}
					if r := a.get("registry", id); r["imagePrefix"] != "Flots-app" || r["password"] != "fx_fixture-token" {
						return fmt.Errorf("unexpected registry: %v", r)
					}
					return nil
				},
			},
			{
				Config: cfg(`
  registry_name   = "GHCR"
  registry_url    = "ghcr.io"
  username        = "ci-bot"
  image_prefix    = "Flots-app"
  password_wo     = "rotated-token"
  secrets_version = 2
`),
				Check: func(s *terraform.State) error {
					if r := a.get("registry", id); r["password"] != "rotated-token" {
						return fmt.Errorf("password not rotated: %v", r)
					}
					return notInState(s, "rotated-token")
				},
			},
			{
				ResourceName:            "dokploy_registry.r",
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"secrets_version"},
			},
		},
	})
}

func TestRegistryNeedsPassword(t *testing.T) {
	a := newBackupsAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config: providerBlock(a.srv.URL) + `
resource "dokploy_registry" "r" {
  registry_name = "x"
  username      = "u"
}
`,
			ExpectError: regexp.MustCompile(`password_wo is required to create a registry`),
		}},
	})
}

// TestRegistryAdoption imports the production registry (ghcr.io, username
// redacted in the sample) with the configuration a human would write.
func TestRegistryAdoption(t *testing.T) {
	a := newBackupsAPI(t)
	id := a.seed("registry", map[string]any{
		"registryName": "GitHub Container Registry", "imagePrefix": "Flots-app", "registryType": "cloud",
		"registryUrl": "ghcr.io", "username": "ci-user", "organizationId": "org-1",
	})
	cfg := func(url string) string {
		return providerBlock(a.srv.URL) + `
import {
  to = dokploy_registry.ghcr
  id = "` + id + `"
}
resource "dokploy_registry" "ghcr" {
  registry_name = "GitHub Container Registry"
  username      = "ci-user"
  registry_url  = "` + url + `"
}
`
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: cfg("ghcr.io"),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("dokploy_registry.ghcr", plancheck.ResourceActionNoop),
				}},
			},
			{
				Config:           cfg("ghcr.io"),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
			{
				Config: cfg("ghcr.io:443"),
				Check: func(s *terraform.State) error {
					r := a.get("registry", id)
					if r["registryUrl"] != "ghcr.io:443" || r["imagePrefix"] != "Flots-app" {
						return fmt.Errorf("unexpected registry: %v", r)
					}
					return nil
				},
			},
		},
	})
}
