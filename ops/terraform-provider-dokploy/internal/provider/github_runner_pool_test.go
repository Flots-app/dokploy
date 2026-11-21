package provider

import (
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"sort"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

const rnProdPoolID = "wBwBrAbeesYNEQxOxY11D"

func TestGithubRunnerPoolLifecycleAndSecrets(t *testing.T) {
	f, srv := newFakeTRPC(t)
	cfg := func(extra string) string {
		return providerBlock(srv.URL) + `
resource "dokploy_github_runner_pool" "p" {
  name                   = "ci"
  scope                  = "organization"
  owner                  = "acme"
  auth_type              = "token"
  labels                 = ["acme-ci"]
  routing_variable       = "ACME_RUNS_ON"
  job_guard_repositories = ["acme/app"]
  failover_interruptions = 3
` + extra + `
}
`
	}
	const addr = "dokploy_github_runner_pool.p"
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		CheckDestroy: func(*terraform.State) error {
			if f.called("githubRunner.removePool") != 1 {
				return fmt.Errorf("the pool was not removed")
			}
			return nil
		},
		Steps: []resource.TestStep{
			{
				// Create: the token goes to Dokploy once, never to the state; what the
				// configuration leaves out adopts the defaults of the API.
				Config: cfg(`
  token_wo        = "fx_pool_token_value"
  secrets_version = 1`),
				Check: resource.ComposeTestCheckFunc(
					func(s *terraform.State) error {
						id = idOf(s, addr)
						p := f.pool(id)
						fo := p["failover"].(map[string]any)
						if fo["interruptions"] != float64(3) || fo["windowMinutes"] != float64(10) || fo["cooldownMinutes"] != float64(30) || fo["mode"] != "auto" {
							return fmt.Errorf("failover not folded back with its defaults: %v", fo)
						}
						jg := p["jobGuard"].(map[string]any)
						if !reflect.DeepEqual(jg["repositories"], []any{"acme/app"}) || jg["refuseForks"] != true || jg["refuseDependabot"] != true {
							return fmt.Errorf("job guard: %v", jg)
						}
						if f.secret(id, "token") != "fx_pool_token_value" {
							return fmt.Errorf("token not sent")
						}
						return notInState(s, "fx_pool_token_value")
					},
					resource.TestCheckResourceAttr(addr, "fallback_labels.#", "1"),
					resource.TestCheckResourceAttr(addr, "fallback_labels.0", "ubuntu-24.04"),
					resource.TestCheckResourceAttr(addr, "failover_mode", "auto"),
					resource.TestCheckResourceAttr(addr, "failover_window_minutes", "10"),
					resource.TestCheckResourceAttr(addr, "job_guard_refuse_forks", "true"),
					resource.TestCheckResourceAttr(addr, "placement", "fastest"),
					resource.TestCheckResourceAttr(addr, "runner_group", "Default"),
					resource.TestCheckResourceAttr(addr, "rerun_interrupted_jobs", "true"),
					resource.TestCheckResourceAttr(addr, "autonomy_reserve", "2"),
					resource.TestCheckResourceAttr(addr, "rollout_max_unavailable", "1"),
					resource.TestCheckResourceAttr(addr, "has_token", "true"),
					resource.TestCheckResourceAttr(addr, "has_app_private_key", "false"),
					resource.TestCheckResourceAttr(addr, "description", ""),
					resource.TestCheckResourceAttr(addr, "update_policy", `{"auto":true,"window":null}`),
					resource.TestCheckResourceAttr(addr, "fallback_chain", `[]`),
				),
			},
			{
				// Nothing changed: an empty plan, nothing is sent.
				Config:           cfg(`secrets_version = 1`),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
			{
				// An update sends the whole pool: what the change does not touch
				// (the defaults, the guard) stays, and so do the stored secrets.
				Config: cfg(`
  description            = "CI of acme"
  secrets_version        = 1`),
				Check: func(*terraform.State) error {
					p := f.pool(id)
					if p["description"] != "CI of acme" {
						return fmt.Errorf("description %v", p["description"])
					}
					if p["failover"].(map[string]any)["windowMinutes"] != float64(10) || p["routingVariable"] != "ACME_RUNS_ON" {
						return fmt.Errorf("update lost settings: %v", p)
					}
					if f.secret(id, "token") != "fx_pool_token_value" {
						return fmt.Errorf("a plain update wiped the stored token: %v", f.secret(id, "token"))
					}
					last := f.callsOf("githubRunner.updatePool")
					body := last[len(last)-1]
					for _, k := range []string{"token", "appPrivateKey", "runnerEnv", "blacksmithToken", "billingToken", "failoverMode", "jobGuardEvents"} {
						if _, ok := body[k]; ok {
							return fmt.Errorf("update body carries %q", k)
						}
					}
					return nil
				},
			},
			{
				// A failover change keeps the other keys of the object.
				Config: cfg(`
  description            = "CI of acme"
  failover_cooldown_minutes = 45
  secrets_version        = 1`),
				Check: func(*terraform.State) error {
					fo := f.pool(id)["failover"].(map[string]any)
					if fo["cooldownMinutes"] != float64(45) || fo["interruptions"] != float64(3) || fo["mode"] != "auto" {
						return fmt.Errorf("failover %v", fo)
					}
					return nil
				},
			},
			{
				// Rotation: the new token needs the write-only value and a new version.
				Config: cfg(`
  description               = "CI of acme"
  failover_cooldown_minutes = 45
  token_wo                  = "fx_rotated_value"
  secrets_version           = 2`),
				Check: func(s *terraform.State) error {
					if f.secret(id, "token") != "fx_rotated_value" {
						return fmt.Errorf("token not rotated: %v", f.secret(id, "token"))
					}
					return notInState(s, "fx_rotated_value")
				},
			},
			{
				// The runner environment is write-only too; only its names come back.
				Config: cfg(`
  description               = "CI of acme"
  failover_cooldown_minutes = 45
  runner_env_wo             = "REGION=eu-env-secret-value\nDEBUG=1"
  secrets_version           = 3`),
				Check: func(s *terraform.State) error {
					if f.secret(id, "runnerEnv") != "REGION=eu-env-secret-value\nDEBUG=1" {
						return fmt.Errorf("env not sent")
					}
					return notInState(s, "eu-env-secret-value")
				},
			},
			{
				Config: cfg(`
  description               = "CI of acme"
  failover_cooldown_minutes = 45
  secrets_version           = 3`),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
				Check: resource.ComposeTestCheckFunc(
					resource.TestCheckResourceAttr(addr, "runner_env_keys.#", "2"),
					resource.TestCheckTypeSetElemAttr(addr, "runner_env_keys.*", "REGION"),
				),
			},
			{
				ResourceName:            addr,
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"secrets_version"},
			},
		},
	})
}

func TestGithubRunnerPoolNeedsCredentials(t *testing.T) {
	_, srv := newFakeTRPC(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config: providerBlock(srv.URL) + `
resource "dokploy_github_runner_pool" "p" {
  name      = "ci"
  scope     = "organization"
  owner     = "acme"
  auth_type = "app"
}
`,
			ExpectError: regexp.MustCompile(`app_private_key_wo are required`),
		}},
	})
}

func TestGithubRunnerPoolRejectsInvalidJSON(t *testing.T) {
	_, srv := newFakeTRPC(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config: providerBlock(srv.URL) + `
resource "dokploy_github_runner_pool" "p" {
  name           = "ci"
  scope          = "organization"
  owner          = "acme"
  auth_type      = "provider"
  github_id      = "g"
  fallback_chain = "[{"
}
`,
			ExpectError: regexp.MustCompile(`Invalid JSON`),
		}},
	})
}

// A hand-written jsonencode() must equal what the API returns, otherwise the
// plan is never empty: the objects of the lists keep every key the API
// validates as required, and the same text comes back.
func TestGithubRunnerPoolJSONAttributesStayEqual(t *testing.T) {
	f, srv := newFakeTRPC(t)
	cfg := providerBlock(srv.URL) + `
resource "dokploy_github_runner_pool" "p" {
  name       = "ci"
  scope      = "organization"
  owner      = "acme"
  auth_type  = "app"
  app_id     = 123
  app_private_key_wo = "fx-begin-app-key-body"
  blacksmith_organization = "acme"
  blacksmith_token_wo     = "bs-secret-token-value"
  billing_token_wo        = "billing-secret-token-value"
  secrets_version         = 1
  labels     = ["acme-ci"]
  fallback_chain = jsonencode([
    {
      id        = "bs"
      kind      = "blacksmith"
      labels    = ["blacksmith-4vcpu-ubuntu-2404"]
      x64Labels = ["blacksmith-4vcpu-ubuntu-2404"]
      budget    = { freeMinutes = 3000, pricePerMinute = 0.004, overspend = 50, warningPercent = 80 }
    },
    {
      id         = "gh"
      kind       = "github"
      labels     = ["ubuntu-24.04"]
      x64Labels  = ["ubuntu-24.04"]
      budget     = null
      classLabels = { android = ["ubuntu-24.04-8core"] }
    },
  ])
  job_classes = jsonencode([
    { id = "android", suffix = "ANDROID", arch = "native", fallbackLabels = ["ubuntu-24.04"] },
  ])
  update_policy = jsonencode({
    auto       = true
    osPatches  = true
    window     = { days = [0, 6], start = "02:00", end = "05:00", timeZone = "Europe/Paris" }
  })
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: cfg,
				Check: func(s *terraform.State) error {
					p := f.pool(idOf(s, "dokploy_github_runner_pool.p"))
					chain := p["fallbackChain"].([]any)
					if len(chain) != 2 || chain[0].(map[string]any)["budget"].(map[string]any)["pricePerMinute"] != 0.004 {
						return fmt.Errorf("fallback chain not sent as written: %v", chain)
					}
					if p["updatePolicy"].(map[string]any)["osPatches"] != true {
						return fmt.Errorf("update policy %v", p["updatePolicy"])
					}
					id := idOf(s, "dokploy_github_runner_pool.p")
					for key, want := range map[string]string{"appPrivateKey": "fx-begin-app-key-body", "blacksmithToken": "bs-secret-token-value", "billingToken": "billing-secret-token-value"} {
						if f.secret(id, key) != want {
							return fmt.Errorf("%s not sent", key)
						}
						if err := notInState(s, want); err != nil {
							return err
						}
					}
					return nil
				},
			},
			{
				// The refresh gives the same text back: nothing to do.
				Config:           cfg,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
		},
	})
}

// The key acceptance test: the pool of production, as the overview returns it,
// is adopted with the configuration a human writes and the plan is empty.
func TestGithubRunnerPoolAdoptsProductionPool(t *testing.T) {
	f, srv := newFakeTRPC(t)
	f.seedPool(rnProdPoolJSON)
	before := f.pool(rnProdPoolID)
	minimal := providerBlock(srv.URL) + `
import {
  to = dokploy_github_runner_pool.main
  id = "` + rnProdPoolID + `"
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
	// Every setting spelled out, in another order than the API's.
	explicit := providerBlock(srv.URL) + `
import {
  to = dokploy_github_runner_pool.main
  id = "` + rnProdPoolID + `"
}

resource "dokploy_github_runner_pool" "main" {
  name        = "Flots-app"
  description = "Flots-app organization runners. Label flots-dokploy until the switch from the Mac mini runners."
  scope       = "organization"
  owner       = "Flots-app"
  runner_group = "Default"
  auth_type   = "provider"
  github_id   = "gQJXmATMu5eSTvtWni3ya"
  api_url     = "https://api.github.com"
  labels      = ["flots-dokploy"]

  routing_variable    = "DOKPLOY_RUNS_ON"
  fallback_labels     = ["ubuntu-24.04-arm"]
  x64_fallback_labels = ["ubuntu-24.04"]
  fallback_chain      = jsonencode([])
  job_classes         = jsonencode([])
  placement           = "fastest"

  failover_mode             = "auto"
  failover_interruptions    = 2
  failover_window_minutes   = 10
  failover_cooldown_minutes = 30

  job_guard_events = ["workflow_dispatch", "push", "pull_request"]
  job_guard_repositories = [
    "Flots-app/website",
    "Flots-app/monorepo",
    "Flots-app/runner-smoke",
    "Flots-app/github-action-ci-runner-router",
    "Flots-app/iac-infra",
  ]
  job_guard_refuse_forks      = true
  job_guard_refuse_dependabot = true
  rerun_interrupted_jobs      = true

  update_policy           = jsonencode({ auto = true, window = null })
  rollout_max_unavailable = 1
  rollout_canary          = true
  autonomy_reserve        = 2
}
`
	const addr = "dokploy_github_runner_pool.main"
	empty := resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: minimal,
				Check: resource.ComposeTestCheckFunc(
					resource.TestCheckResourceAttr(addr, "id", rnProdPoolID),
					resource.TestCheckResourceAttr(addr, "routing_variable", "DOKPLOY_RUNS_ON"),
					resource.TestCheckResourceAttr(addr, "has_token", "false"),
					resource.TestCheckResourceAttr(addr, "latest_runner_version", "2.338.2"),
					resource.TestCheckResourceAttr(addr, "job_guard_repositories.#", "5"),
					resource.TestCheckResourceAttr(addr, "update_policy", `{"auto":true,"window":null}`),
					resource.TestCheckResourceAttr(addr, "runner_version", ""),
				),
			},
			{Config: minimal, ConfigPlanChecks: empty},
			{Config: explicit, ConfigPlanChecks: empty},
			{
				// A change touches only what it says: everything else, the runtime
				// state included, is as production had it.
				Config: explicit + "\n",
				PreConfig: func() {
					if f.called("githubRunner.updatePool") != 0 {
						t.Errorf("adopting called updatePool")
					}
				},
				ConfigPlanChecks: empty,
			},
			{
				Config: rnRegexpReplace(explicit, `description = "[^"]*"`, `description = "Flots runners"`),
				Check: func(*terraform.State) error {
					after := f.pool(rnProdPoolID)
					if after["description"] != "Flots runners" {
						return fmt.Errorf("description %v", after["description"])
					}
					after["description"] = before["description"]
					// the update leaves runtime state alone and re-sends the settings
					// unchanged (array order aside: sets are sent sorted).
					for _, k := range []string{"jobGuard"} {
						a, b := after[k].(map[string]any), before[k].(map[string]any)
						rnSortAny(a["repositories"])
						rnSortAny(b["repositories"])
						rnSortAny(a["events"])
						rnSortAny(b["events"])
					}
					if !reflect.DeepEqual(before, after) {
						var diff []string
						for k := range before {
							if !reflect.DeepEqual(before[k], after[k]) {
								x, _ := json.Marshal(before[k])
								y, _ := json.Marshal(after[k])
								diff = append(diff, fmt.Sprintf("%s: %s -> %s", k, x, y))
							}
						}
						return fmt.Errorf("update changed more than the description: %v", diff)
					}
					return nil
				},
			},
		},
	})
}

func rnRegexpReplace(s, pattern, repl string) string {
	return regexp.MustCompile(pattern).ReplaceAllLiteralString(s, repl)
}

// rnSortAny sorts a decoded JSON array of strings in place.
func rnSortAny(v any) {
	l, _ := v.([]any)
	sort.Slice(l, func(i, j int) bool { return l[i].(string) < l[j].(string) })
}
