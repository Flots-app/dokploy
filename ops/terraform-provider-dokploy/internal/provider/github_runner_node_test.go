package provider

import (
	"fmt"
	"regexp"
	"testing"
	"time"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

const (
	rnProdNodeM4ID = "hm8kyU_BjlDAqDewZs1np"
	rnProdNodeM6ID = "2M1L0Vvfgb6HcUsKa7Inl"
)

// rnProdFleet seeds the production pool and its two Macs and returns the
// imports plus the minimal pool block every test of this file shares.
func rnProdFleet(f *fakeTRPC) string {
	f.seedPool(rnProdPoolJSON)
	f.seedNode(rnProdNodeM4JSON)
	f.seedNode(rnProdNodeM6JSON)
	return `
import {
  to = dokploy_github_runner_pool.main
  id = "` + rnProdPoolID + `"
}

import {
  to = dokploy_github_runner_node.m4
  id = "` + rnProdNodeM4ID + `"
}

import {
  to = dokploy_github_runner_node.m6
  id = "` + rnProdNodeM6ID + `"
}

resource "dokploy_github_runner_pool" "main" {
  name      = "Flots-app"
  scope     = "organization"
  owner     = "Flots-app"
  auth_type = "provider"
  github_id = "gQJXmATMu5eSTvtWni3ya"
  labels    = ["flots-dokploy"]
}
`
}

func TestGithubRunnerNodeCannotBeCreated(t *testing.T) {
	f, srv := newFakeTRPC(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config: providerBlock(srv.URL) + `
resource "dokploy_github_runner_node" "n" {
  name    = "m9"
  pool_id = "pool-1"
}
`,
			ExpectError: regexp.MustCompile(`Cannot create a runner machine`),
		}},
	})
	if n := f.called("githubRunner.createMachine") + f.called("githubRunner.startEnrollment"); n != 0 {
		t.Fatalf("the provider reached the enrollment procedures %d times", n)
	}
}

// The machines of production are adopted with a minimal configuration and the
// plan is empty; editing them calls updateMachine with the whole budget, the
// on/off switch calls enable/disable, and destroy removes them like the
// dashboard (draining first), then the pool can go.
func TestGithubRunnerNodeAdoptionEditAndRemoval(t *testing.T) {
	f, srv := newFakeTRPC(t)
	f.removeLag = 2
	old := rnPollEvery
	rnPollEvery = time.Millisecond
	t.Cleanup(func() { rnPollEvery = old })

	base := rnProdFleet(f)
	cfg := func(m4, m6 string) string {
		return providerBlock(srv.URL) + base + `
resource "dokploy_github_runner_node" "m4" {
  name    = "m4"
  pool_id = dokploy_github_runner_pool.main.id
` + m4 + `
}

resource "dokploy_github_runner_node" "m6" {
  name    = "m6"
  pool_id = dokploy_github_runner_pool.main.id
` + m6 + `
}
`
	}
	empty := resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}}
	const m4, m6 = "dokploy_github_runner_node.m4", "dokploy_github_runner_node.m6"
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		CheckDestroy: func(*terraform.State) error {
			rm := f.callsOf("githubRunner.removeMachine")
			if len(rm) != 2 {
				return fmt.Errorf("removeMachine called %d times", len(rm))
			}
			for _, call := range rm {
				switch call["githubRunnerNodeId"] {
				case rnProdNodeM4ID: // defaults of the dashboard: wait, uninstall
					if call["mode"] != "wait" || call["uninstall"] != true || call["force"] != false {
						return fmt.Errorf("m4 removal %v", call)
					}
				case rnProdNodeM6ID: // forced in the configuration: it is unreachable
					if call["mode"] != "kill" || call["uninstall"] != false || call["force"] != true {
						return fmt.Errorf("m6 removal %v", call)
					}
				default:
					return fmt.Errorf("unexpected removal %v", call)
				}
			}
			if f.called("githubRunner.removePool") != 1 {
				return fmt.Errorf("the pool was not removed after its machines")
			}
			return nil
		},
		Steps: []resource.TestStep{
			{
				Config: cfg("", ""),
				Check: resource.ComposeTestCheckFunc(
					resource.TestCheckResourceAttr(m4, "id", rnProdNodeM4ID),
					resource.TestCheckResourceAttr(m4, "cpu_percent", "100"),
					resource.TestCheckResourceAttr(m4, "memory_percent", "75"),
					resource.TestCheckResourceAttr(m4, "max_runners", "3"),
					resource.TestCheckResourceAttr(m4, "x64_runners", "1"),
					resource.TestCheckResourceAttr(m4, "enabled", "true"),
					resource.TestCheckResourceAttr(m4, "platform", "macos"),
					resource.TestCheckResourceAttr(m4, "host", "100.115.98.81"),
					resource.TestCheckResourceAttr(m4, "update_policy", "null"),
					resource.TestCheckResourceAttr(m4, "phase", "ready"),
					resource.TestCheckResourceAttr(m4, "ssh_key_id", ""),
					resource.TestCheckResourceAttr(m6, "enabled", "false"),
					resource.TestCheckResourceAttr(m6, "vm_disk_gb", "25"),
					resource.TestCheckResourceAttr(m6, "phase", "stopped"),
				),
			},
			{Config: cfg("", ""), ConfigPlanChecks: empty},
			{
				// Every setting spelled out as production has it: still empty.
				Config: cfg(`
  description          = "Mac mini M4 (killians-mac-mini): the monorepo Linux CI since 2026-11-01."
  enabled              = true
  cpu_percent          = 100
  memory_percent       = 75
  disk_reserve_gb      = 15
  disk_cleanup_percent = 90
  max_runners          = 3
  vm_disk_gb           = 60
  x64_runners          = 1
  extra_labels         = []
  update_policy        = jsonencode(null)
`, `
  description          = "Mac mini M6 (macmini-de-erwan), next to the M4 in the fleet."
  enabled              = false
  cpu_percent          = 75
  memory_percent       = 50
  max_runners          = 1
  vm_disk_gb           = 25
`),
				ConfigPlanChecks: empty,
				PreConfig: func() {
					for _, p := range []string{"githubRunner.updateMachine", "githubRunner.enableMachine", "githubRunner.disableMachine", "githubRunner.createMachine"} {
						if f.called(p) != 0 {
							t.Errorf("adoption called %s", p)
						}
					}
				},
			},
			{
				// Edit the budget, the labels and the update policy of m4; switch m6 on.
				Config: cfg(`
  cpu_percent   = 90
  extra_labels  = ["big"]
  update_policy = jsonencode({ auto = false, window = null })
`, `
  enabled = true
`),
				Check: func(*terraform.State) error {
					up := f.callsOf("githubRunner.updateMachine")
					if len(up) != 1 {
						return fmt.Errorf("updateMachine called %d times: only m4 changed its budget", len(up))
					}
					c := up[0]
					if c["githubRunnerNodeId"] != rnProdNodeM4ID || c["cpuPercent"] != float64(90) || c["memoryPercent"] != float64(75) ||
						c["maxRunners"] != float64(3) || c["vmDiskGb"] != float64(60) || c["x64Runners"] != float64(1) || c["mode"] != "wait" {
						return fmt.Errorf("updateMachine payload %v", c)
					}
					if d, ok := c["description"]; !ok || d != "Mac mini M4 (killians-mac-mini): the monorepo Linux CI since 2026-11-01." {
						return fmt.Errorf("the update must send the description it keeps: %v", c["description"])
					}
					n := f.node(rnProdNodeM4ID)
					if fmt.Sprint(n["extraLabels"]) != "[big]" || fmt.Sprint(n["updatePolicy"]) != "map[auto:false window:<nil>]" {
						return fmt.Errorf("m4 stored as %v %v", n["extraLabels"], n["updatePolicy"])
					}
					if f.called("githubRunner.enableMachine") != 1 || f.node(rnProdNodeM6ID)["enabled"] != true {
						return fmt.Errorf("m6 not enabled")
					}
					if f.called("githubRunner.disableMachine") != 0 {
						return fmt.Errorf("unexpected disable")
					}
					return nil
				},
			},
			{
				// Back: m4 follows the pool again (null), m6 is switched off; the
				// destroy options of m6 are set (state only: no API call for them).
				Config: cfg(`
  cpu_percent   = 90
  extra_labels  = ["big"]
  update_policy = jsonencode(null)
`, `
  enabled           = false
  destroy_force     = true
  destroy_mode      = "kill"
  destroy_uninstall = false
`),
				PreConfig: func() { f.resetCalls() },
				Check: func(*terraform.State) error {
					up := f.callsOf("githubRunner.updateMachine")
					if len(up) != 1 || up[0]["githubRunnerNodeId"] != rnProdNodeM4ID {
						return fmt.Errorf("updateMachine calls: %v", up)
					}
					if v, ok := up[0]["updatePolicy"]; !ok || v != nil {
						return fmt.Errorf("updatePolicy must be sent as null to follow the pool: %v (sent: %v)", v, ok)
					}
					d := f.callsOf("githubRunner.disableMachine")
					if len(d) != 1 || d[0]["mode"] != "wait" || d[0]["timeoutMinutes"] != nil {
						return fmt.Errorf("disableMachine calls: %v", d)
					}
					if f.node(rnProdNodeM6ID)["enabled"] != false {
						return fmt.Errorf("m6 still enabled")
					}
					return nil
				},
			},
			{
				// The destroy options survive a refresh: no change.
				Config: cfg(`
  cpu_percent   = 90
  extra_labels  = ["big"]
  update_policy = jsonencode(null)
`, `
  enabled           = false
  destroy_force     = true
  destroy_mode      = "kill"
  destroy_uninstall = false
`),
				ConfigPlanChecks: empty,
			},
			{ResourceName: m4, ImportState: true, ImportStateVerify: true},
		},
	})
}

func TestGithubRunnerNodeIdentityCannotChange(t *testing.T) {
	f, srv := newFakeTRPC(t)
	f.seedPool(rnProdPoolJSON)
	f.seedNode(rnProdNodeM4JSON)
	cfg := func(name string) string {
		return providerBlock(srv.URL) + `
import {
  to = dokploy_github_runner_node.m4
  id = "` + rnProdNodeM4ID + `"
}

resource "dokploy_github_runner_node" "m4" {
  name    = "` + name + `"
  pool_id = "` + rnProdPoolID + `"
}
`
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{Config: cfg("m4")},
			{Config: cfg("renamed"), ExpectError: regexp.MustCompile(`Cannot change a runner machine's name`)},
		},
	})
	if f.called("githubRunner.updateMachine") != 0 {
		t.Fatal("a rename reached the API")
	}
}

// An unreachable machine is forgotten with the forced removal; a failing
// removal is reported, not swallowed.
func TestGithubRunnerNodeRemovalErrorIsReported(t *testing.T) {
	f, srv := newFakeTRPC(t)
	f.seedPool(rnProdPoolJSON)
	f.seedNode(rnProdNodeM6JSON)
	cfg := providerBlock(srv.URL) + `
import {
  to = dokploy_github_runner_node.m6
  id = "` + rnProdNodeM6ID + `"
}

resource "dokploy_github_runner_node" "m6" {
  name    = "m6"
  pool_id = "` + rnProdPoolID + `"
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{Config: cfg},
			{
				PreConfig: func() {
					f.hooks["githubRunner.removeMachine"] = func(map[string]any) *fakeTRPCError {
						return &fakeTRPCError{Status: 400, Message: "m6 is installing OS updates"}
					}
				},
				Config:      cfg,
				Destroy:     true,
				ExpectError: regexp.MustCompile(`installing OS updates`),
			},
			{
				PreConfig: func() { delete(f.hooks, "githubRunner.removeMachine") },
				Config:    cfg,
			},
		},
	})
}
