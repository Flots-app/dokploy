package provider

import (
	"regexp"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/knownvalue"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/statecheck"
	"github.com/hashicorp/terraform-plugin-testing/tfjsonpath"
)

// Dokploy appends a random suffix to the requested appName: asking for one must
// converge to an empty plan instead of replacing the application at every apply.
func TestApplicationAppNamePrefixConverges(t *testing.T) {
	a, srv := applicationFake(t)
	cfg := providerBlock(srv.URL) + `
resource "dokploy_application" "a" {
  name            = "web"
  environment_id  = "env-1"
  app_name_prefix = "web"
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		CheckDestroy:             applicationCheckDestroyed(a),
		Steps: []resource.TestStep{
			{
				Config: cfg,
				ConfigStateChecks: []statecheck.StateCheck{
					statecheck.ExpectKnownValue("dokploy_application.a", tfjsonpath.New("app_name"), knownvalue.StringRegexp(regexp.MustCompile(`^web-ab12cd$`))),
				},
			},
			{Config: cfg, ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}}},
		},
	})
}
