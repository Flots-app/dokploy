package provider

import (
	"fmt"
	"reflect"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

// rnLinuxNodeJSON is a Linux runner machine, the only kind OS updates accept.
const rnLinuxNodeJSON = `{"githubRunnerNodeId": "node-linux-1", "githubRunnerPoolId": "wBwBrAbeesYNEQxOxY11D", "name": "hetzner-1", "platform": "linux", "enabled": true, "phase": "ready"}`

func TestOsUpdateConfigurationLifecycle(t *testing.T) {
	f, srv := newFakeTRPC(t)
	f.servers["srv-1"], f.servers["srv-2"] = "web-1", "web-2"
	f.seedNode(rnLinuxNodeJSON)
	const addr = "dokploy_os_update_configuration.weekly"
	cfg := func(extra string) string {
		return providerBlock(srv.URL) + `
resource "dokploy_os_update_configuration" "weekly" {
  name             = "weekly-security"
  recurrence       = "weekly"
  start_time       = "02:00"
  time_zone        = "Europe/Paris"
  duration_minutes = 120
  weekdays         = jsonencode([0, 3])
` + extra + `
}
`
	}
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		CheckDestroy: func(*terraform.State) error {
			if f.called("osUpdate.removeConfiguration") != 1 {
				return fmt.Errorf("configuration not removed")
			}
			return nil
		},
		Steps: []resource.TestStep{
			{
				Config: cfg(`server_ids = ["srv-1"]`),
				Check: resource.ComposeTestCheckFunc(
					func(s *terraform.State) error {
						id = idOf(s, addr)
						sc := f.osConfigs[id]["schedule"].(map[string]any)
						// A schedule written with the four mandatory keys and the weekdays
						// gets the API's defaults for the others...
						if sc["monthlyMode"] != "day" || sc["monthDay"] != float64(1) || !reflect.DeepEqual(sc["weekdays"], []any{float64(0), float64(3)}) {
							return fmt.Errorf("schedule %v", sc)
						}
						if f.osAssigned["server:srv-1"] != id {
							return fmt.Errorf("srv-1 not assigned: %v", f.osAssigned)
						}
						return nil
					},
					// ...which the state adopts.
					resource.TestCheckResourceAttr(addr, "monthly_mode", "day"),
					resource.TestCheckResourceAttr(addr, "month_day", "1"),
					resource.TestCheckResourceAttr(addr, "classification", "security"),
					resource.TestCheckResourceAttr(addr, "reboot", "if-required"),
					resource.TestCheckResourceAttr(addr, "enabled", "true"),
					resource.TestCheckResourceAttr(addr, "weekdays", "[0,3]"),
					resource.TestCheckResourceAttr(addr, "server_ids.#", "1"),
					resource.TestCheckResourceAttr(addr, "runner_node_ids.#", "0"),
				),
			},
			{Config: cfg(`server_ids = ["srv-1"]`), ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}}},
			{
				// Another machine joins, the settings change: the whole configuration
				// is sent, assignments included.
				Config: cfg(`
  classification  = "all"
  reboot          = "never"
  include_packages = ["openssl*"]
  server_ids      = ["srv-1", "srv-2"]
  runner_node_ids = ["node-linux-1"]`),
				Check: func(*terraform.State) error {
					c := f.osConfigs[id]
					if c["classification"] != "all" || c["reboot"] != "never" || !reflect.DeepEqual(c["includePackages"], []any{"openssl*"}) {
						return fmt.Errorf("settings %v", c)
					}
					if f.osAssigned["server:srv-1"] != id || f.osAssigned["server:srv-2"] != id || f.osAssigned["node:node-linux-1"] != id {
						return fmt.Errorf("assignments %v", f.osAssigned)
					}
					return nil
				},
			},
			{
				// A change that does not name the machines keeps them: the update
				// payload carries what Dokploy holds, not an empty list.
				Config: cfg(`
  description     = "security patches on Wednesday"
  classification  = "all"
  reboot          = "never"
  include_packages = ["openssl*"]
  server_ids      = ["srv-1", "srv-2"]
  runner_node_ids = ["node-linux-1"]`),
				Check: func(*terraform.State) error {
					if len(f.osAssigned) != 3 || f.osConfigs[id]["description"] != "security patches on Wednesday" {
						return fmt.Errorf("assignments %v", f.osAssigned)
					}
					return nil
				},
			},
			{
				// A machine left out of the list leaves the configuration.
				Config: cfg(`
  description     = "security patches on Wednesday"
  classification  = "all"
  reboot          = "never"
  include_packages = ["openssl*"]
  server_ids      = ["srv-2"]
  runner_node_ids = ["node-linux-1"]`),
				Check: func(*terraform.State) error {
					if _, still := f.osAssigned["server:srv-1"]; still || len(f.osAssigned) != 2 {
						return fmt.Errorf("assignments %v", f.osAssigned)
					}
					return nil
				},
			},
			{ResourceName: addr, ImportState: true, ImportStateVerify: true},
		},
	})
}

// A monthly window written by hand, with defaults left out, still matches.
func TestOsUpdateConfigurationMonthlyDefaultsAdopted(t *testing.T) {
	f, srv := newFakeTRPC(t)
	cfg := providerBlock(srv.URL) + `
resource "dokploy_os_update_configuration" "m" {
  name             = "monthly"
  recurrence       = "monthly"
  start_time       = "03:30"
  time_zone        = "UTC"
  duration_minutes = 60
  month_day        = -1
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: cfg,
				Check: func(s *terraform.State) error {
					sc := f.osConfigs[idOf(s, "dokploy_os_update_configuration.m")]["schedule"].(map[string]any)
					if sc["monthDay"] != float64(-1) || sc["monthWeek"] != float64(1) || !reflect.DeepEqual(sc["weekdays"], []any{}) {
						return fmt.Errorf("schedule %v", sc)
					}
					return nil
				},
			},
			{Config: cfg, ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}}},
		},
	})
}

// There is no production configuration yet: the adoption test uses one shaped
// like osUpdate.overview returns it (runtime fields included).
func TestOsUpdateConfigurationAdoption(t *testing.T) {
	f, srv := newFakeTRPC(t)
	f.servers["KZ4vfW5bRwhFW2gYdAA1t"] = "kvincent-mac-mini-m4"
	f.servers["N4_drB-08E_3wcR1B81K0"] = "ubuntu-8gb-fsn1-1-prd"
	f.osConfigs["osu-seed"] = map[string]any{
		"osUpdateConfigurationId": "osu-seed", "organizationId": "org-1",
		"name": "nightly", "description": nil, "enabled": true,
		"schedule": map[string]any{
			"recurrence": "weekly", "startTime": "01:00", "timeZone": "Europe/Paris", "durationMinutes": float64(180),
			"weekdays": []any{float64(1), float64(2), float64(3), float64(4), float64(5)}, "monthlyMode": "day", "monthDay": float64(1), "monthWeek": float64(1), "monthWeekday": float64(0),
		},
		"classification": "security", "includePackages": []any{}, "excludePackages": []any{"docker*", "containerd*"},
		"reboot": "if-required", "allowDockerUpdates": false, "notifyOnSuccess": true,
		"createdAt": "2026-11-10T10:00:00.000Z", "updatedAt": "2026-11-11T10:00:00.000Z",
	}
	f.osAssigned["server:N4_drB-08E_3wcR1B81K0"] = "osu-seed"
	cfg := providerBlock(srv.URL) + `
import {
  to = dokploy_os_update_configuration.nightly
  id = "osu-seed"
}

resource "dokploy_os_update_configuration" "nightly" {
  name             = "nightly"
  recurrence       = "weekly"
  start_time       = "01:00"
  time_zone        = "Europe/Paris"
  duration_minutes = 180
  weekdays         = jsonencode([1, 2, 3, 4, 5])
}
`
	explicit := providerBlock(srv.URL) + `
import {
  to = dokploy_os_update_configuration.nightly
  id = "osu-seed"
}

resource "dokploy_os_update_configuration" "nightly" {
  name                 = "nightly"
  enabled              = true
  recurrence           = "weekly"
  start_time           = "01:00"
  time_zone            = "Europe/Paris"
  duration_minutes     = 180
  weekdays             = jsonencode([1, 2, 3, 4, 5])
  monthly_mode         = "day"
  month_day            = 1
  month_week           = 1
  month_weekday        = 0
  classification       = "security"
  include_packages     = []
  exclude_packages     = ["containerd*", "docker*"]
  reboot               = "if-required"
  allow_docker_updates = false
  notify_on_success    = true
  server_ids           = ["N4_drB-08E_3wcR1B81K0"]
  runner_node_ids      = []
}
`
	empty := resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{Config: cfg, Check: resource.TestCheckResourceAttr("dokploy_os_update_configuration.nightly", "server_ids.#", "1")},
			{Config: cfg, ConfigPlanChecks: empty},
			{Config: explicit, ConfigPlanChecks: empty},
		},
	})
	if n := f.called("osUpdate.updateConfiguration"); n != 0 {
		t.Fatalf("adoption updated the configuration %d times", n)
	}
}
