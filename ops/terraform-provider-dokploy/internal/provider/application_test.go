package provider

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/knownvalue"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/statecheck"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
	"github.com/hashicorp/terraform-plugin-testing/tfjsonpath"
)

// applicationAPI is the fake API with the application procedures of Dokploy,
// including the quirks the provider has to cope with:
//   - application.create keeps only name, appName, description, environmentId
//     and serverId (zod strips the rest) and assigns the default build server;
//   - application.update refuses serverId, buildServerId, buildRegistryId and
//     appName (they are not part of its schema);
//   - application.saveEnvironment wants env, buildArgs, buildSecrets and
//     createEnvFile all at once;
//   - application.updateBuildServer wants both ids and two different machines;
//   - the delete procedure is application.delete, not .remove.
type applicationAPI struct {
	*fakeAPI
	updates []map[string]any // bodies of application.update, in order
}

func applicationFake(t *testing.T) (*applicationAPI, *httptest.Server) {
	f, srv := newFakeAPI(t)
	a := &applicationAPI{fakeAPI: f}
	f.routes["application"] = "applicationId"
	reply := func(w http.ResponseWriter, code int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(v)
	}
	// The hooks run with f.mu held.
	f.hooks["application.create"] = func(w http.ResponseWriter, body map[string]any) bool {
		appName, _ := body["appName"].(string)
		if appName == "" {
			appName = fmt.Sprintf("app-generated-%d", f.next+1)
		}
		obj := map[string]any{
			"name": body["name"], "appName": appName, "description": body["description"],
			"environmentId": body["environmentId"], "serverId": body["serverId"],
			"applicationStatus": "idle", "sourceType": "github", "buildType": "nixpacks",
			"buildServerId": "srv-build-default", "buildRegistryId": nil,
			"replicas": 1, "autoDeploy": true, "buildPath": "/", "triggerType": "push",
			"dockerfile": "Dockerfile", "enableSubmodules": false, "createEnvFile": true,
			"cleanCache": false, "rollbackActive": false, "isPreviewDeploymentsActive": false,
			"previewPort": 3000, "previewHttps": false, "previewPath": "/", "previewLimit": 3,
			"previewCertificateType": "none", "previewRequireCollaboratorPermissions": true,
			"refreshToken": "refresh-fixture-value",
			// A tRPC row carries null for every column without a value.
			"env": nil, "buildArgs": nil, "buildSecrets": nil, "previewEnv": nil,
			"watchPaths": nil, "args": nil, "command": nil,
		}
		f.insert("application", obj)
		reply(w, 200, obj)
		return true
	}
	f.hooks["application.update"] = func(w http.ResponseWriter, body map[string]any) bool {
		for _, k := range []string{"serverId", "buildServerId", "buildRegistryId", "appName"} {
			if _, ok := body[k]; ok {
				reply(w, 400, map[string]any{"message": "application.update does not take " + k})
				return true
			}
		}
		a.updates = append(a.updates, body)
		return false // the generic handler merges the body
	}
	f.hooks["application.saveEnvironment"] = func(w http.ResponseWriter, body map[string]any) bool {
		for _, k := range []string{"env", "buildArgs", "buildSecrets"} {
			if _, ok := body[k].(string); !ok {
				reply(w, 400, map[string]any{"message": k + " is required"})
				return true
			}
		}
		if _, ok := body["createEnvFile"].(bool); !ok {
			reply(w, 400, map[string]any{"message": "createEnvFile is required"})
			return true
		}
		obj := f.objs["application"][fmt.Sprint(body["applicationId"])]
		if obj == nil {
			reply(w, 404, map[string]any{"message": "not found"})
			return true
		}
		for _, k := range []string{"env", "buildArgs", "buildSecrets", "createEnvFile"} {
			obj[k] = body[k]
		}
		reply(w, 200, true)
		return true
	}
	f.hooks["application.updateBuildServer"] = func(w http.ResponseWriter, body map[string]any) bool {
		obj := f.objs["application"][fmt.Sprint(body["applicationId"])]
		server, _ := body["buildServerId"].(string)
		registry, _ := body["buildRegistryId"].(string)
		switch {
		case obj == nil:
			reply(w, 404, map[string]any{"message": "not found"})
		case server == "" || registry == "":
			reply(w, 400, map[string]any{"message": "buildServerId and buildRegistryId are required"})
		case server == obj["serverId"]:
			reply(w, 400, map[string]any{"message": "Build Server and Deploy Server must be different machines"})
		default:
			obj["buildServerId"], obj["buildRegistryId"] = server, registry
			reply(w, 200, true)
		}
		return true
	}
	f.hooks["application.move"] = func(w http.ResponseWriter, body map[string]any) bool {
		obj := f.objs["application"][fmt.Sprint(body["applicationId"])]
		if obj == nil {
			reply(w, 404, map[string]any{"message": "not found"})
			return true
		}
		obj["environmentId"] = body["targetEnvironmentId"]
		reply(w, 200, obj)
		return true
	}
	f.hooks["application.delete"] = func(w http.ResponseWriter, body map[string]any) bool {
		id := fmt.Sprint(body["applicationId"])
		obj := f.objs["application"][id]
		if obj == nil {
			reply(w, 404, map[string]any{"message": "Application not found"})
			return true
		}
		delete(f.objs["application"], id)
		reply(w, 200, obj)
		return true
	}
	return a, srv
}

func (a *applicationAPI) lastUpdate() map[string]any {
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.updates) == 0 {
		return nil
	}
	return a.updates[len(a.updates)-1]
}

func (a *applicationAPI) updateCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.updates)
}

func (a *applicationAPI) count(procs ...string) int {
	n := 0
	for _, p := range procs {
		n += a.called(p)
	}
	return n
}

// applicationNeverDeploys fails when the provider called anything that
// deploys, restarts or otherwise acts on the running service.
func applicationNeverDeploys(a *applicationAPI) error {
	for _, p := range []string{
		"application.deploy", "application.redeploy", "application.start", "application.stop",
		"application.reload", "application.markRunning", "application.refreshToken",
		"application.cancelDeployment", "application.killBuild",
	} {
		if n := a.called(p); n != 0 {
			return fmt.Errorf("%s was called %d time(s): Terraform must never act on the running service", p, n)
		}
	}
	return nil
}

// applicationRemoteIs compares keys of the remote object with the wanted JSON.
func applicationRemoteIs(a *applicationAPI, id string, want map[string]any) error {
	obj := a.get("application", id)
	if obj == nil {
		return fmt.Errorf("application %s does not exist", id)
	}
	for k, w := range want {
		got, _ := json.Marshal(obj[k])
		exp, _ := json.Marshal(w)
		if string(got) != string(exp) {
			return fmt.Errorf("remote %s is %s, want %s", k, got, exp)
		}
	}
	return nil
}

func applicationCheckDestroyed(a *applicationAPI) resource.TestCheckFunc {
	return func(*terraform.State) error {
		a.mu.Lock()
		defer a.mu.Unlock()
		if n := len(a.objs["application"]); n != 0 {
			return fmt.Errorf("%d application(s) left in Dokploy", n)
		}
		return nil
	}
}

// ------------------------------------------------------------ lifecycle

const applicationLifecycleTemplate = `
resource "dokploy_application" "a" {
  name           = "web"
  description    = "@DESC@"
  environment_id = "@ENV_ID@"
  server_id      = "srv-run"

  source_type         = "github"
  github_id           = "gh-1"
  owner               = "acme"
  repository          = "site"
  branch              = "@BRANCH@"
  trigger_type        = "push"
  watch_paths         = ["apps/web/**"]
  build_type          = "dockerfile"
  dockerfile          = "Dockerfile"
  docker_context_path = "."
  docker_build_stage  = "prod"
  build_args          = { NODE_ENV = "production"@BUILD_ARGS@ }

  replicas                = @REPLICAS@
  stop_grace_period_swarm = 30000000000
  placement_swarm         = jsonencode({ Constraints = ["node.labels.zone==a"] })
  health_check_swarm      = jsonencode({ Test = ["CMD-SHELL", "true"], Interval = 10000000000@HEALTH@ })

  is_preview_deployments_active = true
  preview_wildcard              = "*.example.test"
  preview_port                  = @PREVIEW_PORT@
  preview_https                 = true
  preview_limit                 = 2
  preview_certificate_type      = "letsencrypt"
@BUILD_SERVER@
  env             = { PUBLIC_URL = "@PUBLIC_URL@" }
  secret_env_keys = ["HIDDEN_ONE"]
@EXTRA@
}
`

func applicationLifecycleConfig(url string, v map[string]string) string {
	vars := map[string]string{
		"DESC": "first", "ENV_ID": "env-1", "BRANCH": "main", "BUILD_ARGS": "", "REPLICAS": "2",
		"HEALTH": "", "PREVIEW_PORT": "8080", "PUBLIC_URL": "https://example.test", "BUILD_SERVER": "", "EXTRA": "",
	}
	for k, x := range v {
		vars[k] = x
	}
	var pairs []string
	for k, x := range vars {
		pairs = append(pairs, "@"+k+"@", x)
	}
	return providerBlock(url) + strings.NewReplacer(pairs...).Replace(applicationLifecycleTemplate)
}

func TestApplicationLifecycle(t *testing.T) {
	a, srv := applicationFake(t)
	cfg := func(v map[string]string) string { return applicationLifecycleConfig(srv.URL, v) }
	var id string
	const addr = "dokploy_application.a"

	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		CheckDestroy:             applicationCheckDestroyed(a),
		Steps: []resource.TestStep{
			{
				// Create: application.create, then application.update for the
				// rest, then the environment. Secrets are sent once.
				Config: cfg(map[string]string{"EXTRA": `
  build_secrets_wo = { FIXTURE_BUILD = "build-fixture-value" }
  preview_env_wo   = { FIXTURE_PREVIEW = "preview-fixture-value" }
  secret_env_wo    = { HIDDEN_ONE = "env-fixture-value" }
`}),
				ConfigStateChecks: []statecheck.StateCheck{
					statecheck.ExpectKnownValue(addr, tfjsonpath.New("application_status"), knownvalue.StringExact("idle")),
					statecheck.ExpectKnownValue(addr, tfjsonpath.New("source_type"), knownvalue.StringExact("github")),
					statecheck.ExpectKnownValue(addr, tfjsonpath.New("build_server_id"), knownvalue.StringExact("srv-build-default")),
					statecheck.ExpectKnownValue(addr, tfjsonpath.New("build_secrets_wo"), knownvalue.Null()),
					statecheck.ExpectKnownValue(addr, tfjsonpath.New("build_args"), knownvalue.MapExact(map[string]knownvalue.Check{
						"NODE_ENV": knownvalue.StringExact("production"),
					})),
					statecheck.ExpectKnownValue(addr, tfjsonpath.New("health_check_swarm"), knownvalue.StringExact(`{"Interval":10000000000,"Test":["CMD-SHELL","true"]}`)),
				},
				Check: func(s *terraform.State) error {
					id = idOf(s, addr)
					if err := applicationRemoteIs(a, id, map[string]any{
						"name": "web", "description": "first", "environmentId": "env-1", "serverId": "srv-run",
						"sourceType": "github", "githubId": "gh-1", "owner": "acme", "repository": "site", "branch": "main",
						"watchPaths": []any{"apps/web/**"}, "buildType": "dockerfile", "dockerContextPath": ".", "dockerBuildStage": "prod",
						"replicas": 2, "stopGracePeriodSwarm": 30000000000,
						"placementSwarm":             map[string]any{"Constraints": []any{"node.labels.zone==a"}},
						"healthCheckSwarm":           map[string]any{"Test": []any{"CMD-SHELL", "true"}, "Interval": 10000000000},
						"buildArgs":                  "NODE_ENV=production\n",
						"buildSecrets":               "FIXTURE_BUILD=build-fixture-value\n",
						"previewEnv":                 "FIXTURE_PREVIEW=preview-fixture-value\n",
						"isPreviewDeploymentsActive": true, "previewWildcard": "*.example.test", "previewPort": 8080,
						"previewHttps": true, "previewLimit": 2, "previewCertificateType": "letsencrypt",
					}); err != nil {
						return err
					}
					env := fmt.Sprint(a.get("application", id)["env"])
					if !strings.Contains(env, "PUBLIC_URL=https://example.test") || !strings.Contains(env, "HIDDEN_ONE=env-fixture-value") {
						return fmt.Errorf("remote env is %q", env)
					}
					// saveEnvironment must have carried the build secrets over.
					if got := a.get("application", id)["buildSecrets"]; got != "FIXTURE_BUILD=build-fixture-value\n" {
						return fmt.Errorf("saveEnvironment wiped the build secrets: %q", got)
					}
					if n := a.count("application.create", "application.saveEnvironment"); n != 2 || a.updateCount() != 1 {
						return fmt.Errorf("calls: create+saveEnvironment=%d, update=%d", n, a.updateCount())
					}
					if err := applicationNeverDeploys(a); err != nil {
						return err
					}
					for _, secret := range []string{"build-fixture-value", "preview-fixture-value", "env-fixture-value", "refresh-fixture-value"} {
						if err := notInState(s, secret); err != nil {
							return err
						}
					}
					return nil
				},
			},
			{
				// Same configuration: nothing to do.
				Config:           cfg(nil),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
			{
				// A change: only the changed columns are sent, the secrets the
				// configuration does not repeat stay in Dokploy.
				Config: cfg(map[string]string{
					"DESC": "second", "BRANCH": "release", "REPLICAS": "3", "HEALTH": `, Retries = 3`,
					"BUILD_ARGS": `, EXTRA_ARG = "1"`, "PREVIEW_PORT": "9090", "PUBLIC_URL": "https://other.test",
				}),
				Check: func(s *terraform.State) error {
					if err := applicationRemoteIs(a, id, map[string]any{
						"description": "second", "branch": "release", "replicas": 3, "previewPort": 9090,
						"healthCheckSwarm": map[string]any{"Test": []any{"CMD-SHELL", "true"}, "Interval": 10000000000, "Retries": 3},
						"buildArgs":        "EXTRA_ARG=1\nNODE_ENV=production\n",
						"buildSecrets":     "FIXTURE_BUILD=build-fixture-value\n",
					}); err != nil {
						return err
					}
					env := fmt.Sprint(a.get("application", id)["env"])
					if !strings.Contains(env, "PUBLIC_URL=https://other.test") || !strings.Contains(env, "HIDDEN_ONE=env-fixture-value") {
						return fmt.Errorf("remote env is %q", env)
					}
					up := a.lastUpdate()
					for _, k := range []string{"buildSecrets", "previewEnv", "name", "githubId", "stopGracePeriodSwarm", "placementSwarm"} {
						if _, ok := up[k]; ok {
							return fmt.Errorf("application.update re-sent the unchanged key %s: %v", k, up)
						}
					}
					return applicationNeverDeploys(a)
				},
			},
			{
				// Another build server comes with its registry, through
				// application.updateBuildServer (application.update refuses both).
				Config: cfg(map[string]string{
					"DESC": "second", "BRANCH": "release", "REPLICAS": "3", "HEALTH": `, Retries = 3`,
					"BUILD_ARGS": `, EXTRA_ARG = "1"`, "PREVIEW_PORT": "9090", "PUBLIC_URL": "https://other.test",
					"BUILD_SERVER": "  build_server_id   = \"srv-build-2\"\n  build_registry_id = \"reg-1\"\n",
				}),
				Check: func(s *terraform.State) error {
					if a.called("application.updateBuildServer") != 1 {
						return fmt.Errorf("updateBuildServer was called %d times", a.called("application.updateBuildServer"))
					}
					return applicationRemoteIs(a, id, map[string]any{"buildServerId": "srv-build-2", "buildRegistryId": "reg-1"})
				},
			},
			{
				// Moving the application to another environment.
				Config: cfg(map[string]string{
					"DESC": "second", "BRANCH": "release", "REPLICAS": "3", "HEALTH": `, Retries = 3`, "ENV_ID": "env-2",
					"BUILD_ARGS": `, EXTRA_ARG = "1"`, "PREVIEW_PORT": "9090", "PUBLIC_URL": "https://other.test",
					"BUILD_SERVER": "  build_server_id   = \"srv-build-2\"\n  build_registry_id = \"reg-1\"\n",
				}),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction(addr, plancheck.ResourceActionUpdate),
				}},
				Check: func(s *terraform.State) error {
					if a.called("application.move") != 1 {
						return fmt.Errorf("move was called %d times", a.called("application.move"))
					}
					return applicationRemoteIs(a, id, map[string]any{"environmentId": "env-2"})
				},
			},
			{
				// A secret rotation rewrites the build secrets and, in the same
				// apply, the environment: saveEnvironment runs after the update
				// and must keep the new build secrets.
				Config: cfg(map[string]string{
					"DESC": "second", "BRANCH": "release", "REPLICAS": "3", "HEALTH": `, Retries = 3`, "ENV_ID": "env-2",
					"BUILD_ARGS": `, EXTRA_ARG = "1"`, "PREVIEW_PORT": "9090", "PUBLIC_URL": "https://third.test",
					"BUILD_SERVER": "  build_server_id   = \"srv-build-2\"\n  build_registry_id = \"reg-1\"\n",
					"EXTRA":        "  build_secrets_wo = { FIXTURE_BUILD = \"rotated-fixture-value\" }\n  secrets_version  = 2\n",
				}),
				Check: func(s *terraform.State) error {
					if got := a.get("application", id)["buildSecrets"]; got != "FIXTURE_BUILD=rotated-fixture-value\n" {
						return fmt.Errorf("build secrets not rotated: %q", got)
					}
					if env := fmt.Sprint(a.get("application", id)["env"]); !strings.Contains(env, "PUBLIC_URL=https://third.test") {
						return fmt.Errorf("remote env is %q", env)
					}
					if err := notInState(s, "rotated-fixture-value"); err != nil {
						return err
					}
					return applicationNeverDeploys(a)
				},
			},
			{
				// terraform import gives the same state back (the environment
				// split is only known to the configuration).
				ResourceName:            addr,
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"env.", "secret_env_keys", "secret_env_wo_version", "secrets_version"},
			},
		},
	})
}

// ------------------------------------------------------------ adoption

// TestApplicationAdoptsProductionSample imports the two applications of the
// production sample (public-website, production and staging) with the kind of
// configuration a human writes: the production one spells out what matters, the
// staging one only the two required attributes. No remote write may happen and
// the plan must be empty afterwards.
func TestApplicationAdoptsProductionSample(t *testing.T) {
	a, srv := applicationFake(t)
	var prod, staging map[string]any
	if err := json.Unmarshal([]byte(applicationSampleProduction), &prod); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(applicationSampleStaging), &staging); err != nil {
		t.Fatal(err)
	}
	prodID, stagingID := a.seed("application", prod), a.seed("application", staging)

	cfg := providerBlock(srv.URL) + `
import {
  to = dokploy_application.production
  id = "` + prodID + `"
}
import {
  to = dokploy_application.staging
  id = "` + stagingID + `"
}

resource "dokploy_application" "production" {
  name              = "public-website"
  environment_id    = "env_prod_bugSRj1IJ6LokzazCsYLt_1757262382.609079"
  server_id         = "N4_drB-08E_3wcR1B81K0"
  build_server_id   = "KZ4vfW5bRwhFW2gYdAA1t"
  build_registry_id = "VFjAhlgO_FqHbdaEMKV2E"

  source_type = "github"
  github_id   = "gQJXmATMu5eSTvtWni3ya"
  owner       = "Flots-app"
  repository  = "website"
  branch      = "main"

  build_type          = "dockerfile"
  dockerfile          = "Dockerfile"
  docker_context_path = "."
  docker_build_stage  = "prod"

  stop_grace_period_swarm = 30000000000
  health_check_swarm = jsonencode({
    Test        = ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:3000/"]
    Interval    = 10000000000
    Timeout     = 10000000000
    StartPeriod = 10000000000
  })
  placement_swarm = jsonencode({ Constraints = ["node.labels.com.dokploy.preview-only!=true"] })

  preview_wildcard         = "*.flots.app"
  preview_https            = true
  preview_certificate_type = "letsencrypt"

  env             = { NODE_ENV = "production", PUBLIC_SITE_URL = "https://www.example.test" }
  secret_env_keys = ["HIDDEN_ONE"]
}

resource "dokploy_application" "staging" {
  name           = "public-website"
  environment_id = "bJ_qlDFH8Wzpf28XGlSA4"
}
`
	noWrites := func(*terraform.State) error {
		if n := a.count("application.create", "application.delete", "application.saveEnvironment", "application.updateBuildServer", "application.move"); n != 0 || a.updateCount() != 0 {
			return fmt.Errorf("adopting an application wrote to Dokploy (%d procedure calls, %d updates)", n, a.updateCount())
		}
		return applicationNeverDeploys(a)
	}

	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				// The first apply only brings the environment split (unknown to
				// an imported state) into the state: it must not write anything.
				Config: cfg,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("dokploy_application.staging", plancheck.ResourceActionNoop),
				}},
				ConfigStateChecks: []statecheck.StateCheck{
					statecheck.ExpectKnownValue("dokploy_application.production", tfjsonpath.New("branch"), knownvalue.StringExact("main")),
					statecheck.ExpectKnownValue("dokploy_application.production", tfjsonpath.New("application_status"), knownvalue.StringExact("done")),
					statecheck.ExpectKnownValue("dokploy_application.production", tfjsonpath.New("env_keys"), knownvalue.SetExact([]knownvalue.Check{
						knownvalue.StringExact("HIDDEN_ONE"), knownvalue.StringExact("NODE_ENV"), knownvalue.StringExact("PUBLIC_SITE_URL"),
					})),
					// What the configuration left out is adopted, null columns included.
					statecheck.ExpectKnownValue("dokploy_application.staging", tfjsonpath.New("server_id"), knownvalue.StringExact("XXQ2bDvtoMB5PhW51uozD")),
					statecheck.ExpectKnownValue("dokploy_application.staging", tfjsonpath.New("build_registry_id"), knownvalue.StringExact("VFjAhlgO_FqHbdaEMKV2E")),
					statecheck.ExpectKnownValue("dokploy_application.staging", tfjsonpath.New("repository"), knownvalue.StringExact("website")),
					statecheck.ExpectKnownValue("dokploy_application.staging", tfjsonpath.New("health_check_swarm"), knownvalue.Null()),
					statecheck.ExpectKnownValue("dokploy_application.staging", tfjsonpath.New("stop_grace_period_swarm"), knownvalue.Null()),
					statecheck.ExpectKnownValue("dokploy_application.staging", tfjsonpath.New("command"), knownvalue.Null()),
					statecheck.ExpectKnownValue("dokploy_application.staging", tfjsonpath.New("watch_paths"), knownvalue.ListSizeExact(0)),
					statecheck.ExpectKnownValue("dokploy_application.staging", tfjsonpath.New("build_args"), knownvalue.MapSizeExact(0)),
					statecheck.ExpectKnownValue("dokploy_application.staging", tfjsonpath.New("placement_swarm"), knownvalue.StringExact(`{"Constraints":["node.labels.com.dokploy.preview-only!=true"]}`)),
				},
				Check: func(s *terraform.State) error {
					if err := noWrites(s); err != nil {
						return err
					}
					return notInState(s, "refresh-fixture-value")
				},
			},
			{
				// The real acceptance criterion: an empty plan.
				Config:           cfg,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
				Check:            noWrites,
			},
			{
				// A change made in Dokploy by hand is drift: Terraform puts the
				// configured value back, writing that column and nothing else.
				PreConfig: func() { a.set("application", prodID, "branch", "hotfix") },
				Config:    cfg,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("dokploy_application.production", plancheck.ResourceActionUpdate),
				}},
				Check: func(s *terraform.State) error {
					if up := a.lastUpdate(); len(up) != 2 || up["branch"] != "main" || up["applicationId"] != prodID {
						return fmt.Errorf("the update carries more than the drifted branch: %v", up)
					}
					return applicationRemoteIs(a, prodID, map[string]any{"branch": "main"})
				},
			},
		},
	})
}

// ------------------------------------------------------------ secrets

func TestApplicationDockerSourceWriteOnlySecrets(t *testing.T) {
	a, srv := applicationFake(t)
	cfg := func(extra string) string {
		return providerBlock(srv.URL) + `
resource "dokploy_application" "img" {
  name                = "img"
  environment_id      = "env-1"
  source_type         = "docker"
  docker_image        = "ghcr.io/acme/app:1.0"
  docker_registry_url = "ghcr.io"
` + extra + `
}
`
	}
	const addr = "dokploy_application.img"
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		CheckDestroy:             applicationCheckDestroyed(a),
		Steps: []resource.TestStep{
			{
				Config: cfg(`
  docker_username_wo = "puller-fixture"
  docker_password_wo = "pull-fixture-value"
`),
				ConfigStateChecks: []statecheck.StateCheck{
					statecheck.ExpectKnownValue(addr, tfjsonpath.New("docker_password_wo"), knownvalue.Null()),
					statecheck.ExpectKnownValue(addr, tfjsonpath.New("docker_image"), knownvalue.StringExact("ghcr.io/acme/app:1.0")),
				},
				Check: func(s *terraform.State) error {
					id = idOf(s, addr)
					if err := applicationRemoteIs(a, id, map[string]any{
						"sourceType": "docker", "dockerImage": "ghcr.io/acme/app:1.0", "registryUrl": "ghcr.io",
						"username": "puller-fixture", "password": "pull-fixture-value",
					}); err != nil {
						return err
					}
					for _, secret := range []string{"pull-fixture-value", "puller-fixture"} {
						if err := notInState(s, secret); err != nil {
							return err
						}
					}
					return nil
				},
			},
			{
				// An unrelated change does not resend (or wipe) the credentials.
				Config: cfg("  replicas = 2\n"),
				Check: func(s *terraform.State) error {
					if up := a.lastUpdate(); up["password"] != nil || up["username"] != nil {
						return fmt.Errorf("credentials sent without being set: %v", up)
					}
					return applicationRemoteIs(a, id, map[string]any{"replicas": 2, "password": "pull-fixture-value", "username": "puller-fixture"})
				},
			},
			{
				// Rotation: new value plus a new secrets_version.
				Config: cfg(`
  docker_username_wo = "puller-fixture"
  docker_password_wo = "rotated-pull-value"
  secrets_version    = 2
  replicas           = 2
`),
				Check: func(s *terraform.State) error {
					if err := applicationRemoteIs(a, id, map[string]any{"password": "rotated-pull-value"}); err != nil {
						return err
					}
					return notInState(s, "rotated-pull-value")
				},
			},
		},
	})
}

// ------------------------------------------------------------ failures

func TestApplicationBuildServerNeedsRegistry(t *testing.T) {
	a, srv := applicationFake(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config: providerBlock(srv.URL) + `
resource "dokploy_application" "a" {
  name            = "web"
  environment_id  = "env-1"
  build_server_id = "srv-build-2"
}
`,
			ExpectError: regexp.MustCompile(`build_server_id\s+needs\s+build_registry_id`),
			Check: func(*terraform.State) error {
				if a.called("application.create") != 0 {
					return fmt.Errorf("the application was created before the configuration was refused")
				}
				return nil
			},
		}},
	})
	if a.called("application.create") != 0 {
		t.Fatalf("application.create was called")
	}
}

func TestApplicationCreateIsRolledBackWhenConfigurationFails(t *testing.T) {
	a, srv := applicationFake(t)
	a.hooks["application.update"] = func(w http.ResponseWriter, _ map[string]any) bool {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"message":"Invalid input"}`))
		return true
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		CheckDestroy:             applicationCheckDestroyed(a),
		Steps: []resource.TestStep{{
			Config: providerBlock(srv.URL) + `
resource "dokploy_application" "a" {
  name           = "web"
  environment_id = "env-1"
  replicas       = 2
}
`,
			ExpectError: regexp.MustCompile(`the new application was\s+removed again`),
		}},
	})
	if a.called("application.delete") != 1 {
		t.Fatalf("application.delete was called %d times, want 1", a.called("application.delete"))
	}
}

// A new application with only the required attributes: Dokploy's defaults are
// adopted and nothing but application.create is called.
func TestApplicationMinimalCreate(t *testing.T) {
	a, srv := applicationFake(t)
	cfg := providerBlock(srv.URL) + `
resource "dokploy_application" "a" {
  name           = "web"
  environment_id = "env-1"
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		CheckDestroy:             applicationCheckDestroyed(a),
		Steps: []resource.TestStep{
			{
				Config: cfg,
				ConfigStateChecks: []statecheck.StateCheck{
					statecheck.ExpectKnownValue("dokploy_application.a", tfjsonpath.New("build_type"), knownvalue.StringExact("nixpacks")),
					statecheck.ExpectKnownValue("dokploy_application.a", tfjsonpath.New("replicas"), knownvalue.Int64Exact(1)),
					statecheck.ExpectKnownValue("dokploy_application.a", tfjsonpath.New("app_name"), knownvalue.StringRegexp(regexp.MustCompile(`^app-generated-`))),
				},
				Check: func(*terraform.State) error {
					if a.updateCount() != 0 || a.called("application.saveEnvironment") != 0 {
						return fmt.Errorf("a minimal application needs no write after create")
					}
					return applicationNeverDeploys(a)
				},
			},
			{Config: cfg, ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}}},
		},
	})
}

// An update that cannot work (a build server without its registry) is refused
// before anything is written, so nothing is left half-applied.
func TestApplicationUpdateRefusedBeforeAnyWrite(t *testing.T) {
	a, srv := applicationFake(t)
	cfg := func(extra string) string {
		return providerBlock(srv.URL) + `
resource "dokploy_application" "a" {
  name           = "web"
  environment_id = "env-1"
` + extra + `
}
`
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		CheckDestroy:             applicationCheckDestroyed(a),
		Steps: []resource.TestStep{
			{Config: cfg("")},
			{
				Config:      cfg("  description     = \"changed\"\n  build_server_id = \"srv-build-2\"\n"),
				ExpectError: regexp.MustCompile(`build_server_id\s+and\s+build_registry_id\s+must\s+both\s+be\s+set`),
			},
		},
	})
	if a.updateCount() != 0 || a.called("application.updateBuildServer") != 0 {
		t.Fatalf("the refused update wrote to Dokploy (%d updates)", a.updateCount())
	}
}
