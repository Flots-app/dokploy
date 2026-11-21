package provider

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

// composeFake adds the compose procedures to the fake API. It mimics what the
// real zod schemas do: compose.create keeps seven keys, compose.update silently
// drops serverId, buildServerId, buildRegistryId and appName, and
// compose.updateBuildServer (tRPC only) enforces the "set together" and Git
// source rules.
type composeFake struct {
	*fakeAPI
	// bodies are the payloads received per procedure (guarded by fakeAPI.mu).
	bodies map[string][]map[string]any
}

var composeFakeUpdatable = map[string]bool{
	"name": true, "description": true, "env": true, "composeFile": true, "refreshToken": true,
	"sourceType": true, "composeType": true, "repository": true, "owner": true, "branch": true,
	"autoDeploy": true, "gitlabProjectId": true, "gitlabRepository": true, "gitlabOwner": true,
	"gitlabBranch": true, "gitlabPathNamespace": true, "bitbucketRepository": true,
	"bitbucketRepositorySlug": true, "bitbucketOwner": true, "bitbucketBranch": true,
	"giteaRepository": true, "giteaOwner": true, "giteaBranch": true, "customGitUrl": true,
	"customGitBranch": true, "customGitSSHKeyId": true, "command": true, "enableSubmodules": true,
	"composePath": true, "suffix": true, "randomize": true, "isolatedDeployment": true,
	"isolatedDeploymentsVolume": true, "triggerType": true, "composeStatus": true,
	"environmentId": true, "createdAt": true, "watchPaths": true, "githubId": true,
	"gitlabId": true, "bitbucketId": true, "giteaId": true,
}

func composeJSONReply(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func composeDefaults() map[string]any {
	return map[string]any{
		"name": nil, "description": nil, "env": nil, "composeFile": "", "refreshToken": "webhook-token",
		"sourceType": "github", "composeType": "docker-compose",
		"repository": nil, "owner": nil, "branch": nil, "autoDeploy": true,
		"gitlabProjectId": nil, "gitlabRepository": nil, "gitlabOwner": nil, "gitlabBranch": nil, "gitlabPathNamespace": nil,
		"bitbucketRepository": nil, "bitbucketRepositorySlug": nil, "bitbucketOwner": nil, "bitbucketBranch": nil,
		"giteaRepository": nil, "giteaOwner": nil, "giteaBranch": nil,
		"customGitUrl": nil, "customGitBranch": nil, "customGitSSHKeyId": nil,
		"command": "", "enableSubmodules": false, "composePath": "./docker-compose.yml", "suffix": "",
		"randomize": false, "isolatedDeployment": false, "isolatedDeploymentsVolume": false,
		"triggerType": "push", "composeStatus": "idle", "watchPaths": nil,
		"githubId": nil, "gitlabId": nil, "bitbucketId": nil, "giteaId": nil,
		"serverId": nil, "buildServerId": nil, "buildRegistryId": nil,
	}
}

func newComposeFake(t *testing.T) (*composeFake, *httptest.Server) {
	f, srv := newFakeAPI(t)
	cf := &composeFake{fakeAPI: f, bodies: map[string][]map[string]any{}}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.routes["compose"] = "composeId"
	notFound := func(w http.ResponseWriter) {
		composeJSONReply(w, http.StatusNotFound, map[string]any{"message": "Compose not found"})
	}
	find := func(id any) map[string]any {
		s, _ := id.(string)
		return f.objs["compose"][s]
	}

	f.hooks["compose.create"] = func(w http.ResponseWriter, body map[string]any) bool {
		cf.bodies["compose.create"] = append(cf.bodies["compose.create"], body)
		obj := composeDefaults()
		for k, v := range body {
			if composeCreateKeys[k] && k != "appName" {
				obj[k] = v
			}
		}
		name, _ := obj["name"].(string)
		if name == "" {
			composeJSONReply(w, http.StatusBadRequest, map[string]any{"message": "name is required"})
			return true
		}
		// Like buildAppName: a given name is a prefix, Dokploy adds a suffix.
		prefix, _ := body["appName"].(string)
		if prefix == "" {
			prefix = "compose-fake-app"
		}
		obj["appName"] = fmt.Sprintf("%s-%06d", prefix, f.next+1)
		f.insert("compose", obj)
		composeJSONReply(w, http.StatusOK, obj)
		return true
	}
	f.hooks["compose.update"] = func(w http.ResponseWriter, body map[string]any) bool {
		cf.bodies["compose.update"] = append(cf.bodies["compose.update"], body)
		obj := find(body["composeId"])
		if obj == nil {
			notFound(w)
			return true
		}
		for k, v := range body {
			if composeFakeUpdatable[k] {
				obj[k] = v
			}
		}
		composeJSONReply(w, http.StatusOK, obj)
		return true
	}
	f.hooks["compose.move"] = func(w http.ResponseWriter, body map[string]any) bool {
		cf.bodies["compose.move"] = append(cf.bodies["compose.move"], body)
		obj := find(body["composeId"])
		if obj == nil {
			notFound(w)
			return true
		}
		obj["environmentId"] = body["targetEnvironmentId"]
		composeJSONReply(w, http.StatusOK, obj)
		return true
	}
	f.hooks["compose.saveEnvironment"] = func(w http.ResponseWriter, body map[string]any) bool {
		cf.bodies["compose.saveEnvironment"] = append(cf.bodies["compose.saveEnvironment"], body)
		obj := find(body["composeId"])
		if obj == nil {
			notFound(w)
			return true
		}
		obj["env"] = body["env"]
		composeJSONReply(w, http.StatusOK, true)
		return true
	}
	f.hooks["compose.delete"] = func(w http.ResponseWriter, body map[string]any) bool {
		cf.bodies["compose.delete"] = append(cf.bodies["compose.delete"], body)
		obj := find(body["composeId"])
		if obj == nil {
			notFound(w)
			return true
		}
		if _, ok := body["deleteVolumes"].(bool); !ok {
			composeJSONReply(w, http.StatusBadRequest, map[string]any{"message": "deleteVolumes is required"})
			return true
		}
		delete(f.objs["compose"], body["composeId"].(string))
		composeJSONReply(w, http.StatusOK, obj)
		return true
	}
	f.hooks["trpc/compose.updateBuildServer"] = func(w http.ResponseWriter, raw map[string]any) bool {
		body, _ := raw["json"].(map[string]any)
		cf.bodies["compose.updateBuildServer"] = append(cf.bodies["compose.updateBuildServer"], body)
		obj := find(body["composeId"])
		if obj == nil {
			notFound(w)
			return true
		}
		server, registry := body["buildServerId"], body["buildRegistryId"]
		if (server == nil) != (registry == nil) {
			composeJSONReply(w, http.StatusBadRequest, map[string]any{"error": map[string]any{"message": "Build Server and Build Registry must be selected or disabled together"}})
			return true
		}
		if server != nil && (obj["sourceType"] == "raw" || obj["composeType"] != "docker-compose" || obj["command"] != "" || obj["isolatedDeployment"] == true || obj["randomize"] == true) {
			composeJSONReply(w, http.StatusBadRequest, map[string]any{"error": map[string]any{"message": "Zero-downtime Compose Build Servers require a Git source, composeType docker-compose, the default Dokploy command, and non-isolated deterministic resources"}})
			return true
		}
		obj["buildServerId"], obj["buildRegistryId"] = server, registry
		composeJSONReply(w, http.StatusOK, map[string]any{"result": map[string]any{"data": map[string]any{"json": obj}}})
		return true
	}
	t.Cleanup(func() { cf.onlyConfigurationCalls(t) })
	return cf, srv
}

// onlyConfigurationCalls fails when the provider called anything that could
// deploy, start or stop a compose: Terraform manages configuration only.
func (cf *composeFake) onlyConfigurationCalls(t *testing.T) {
	t.Helper()
	cf.mu.Lock()
	defer cf.mu.Unlock()
	allowed := map[string]bool{
		"compose.create": true, "compose.one": true, "compose.update": true, "compose.delete": true,
		"compose.move": true, "compose.saveEnvironment": true, "trpc/compose.updateBuildServer": true,
		"organization.active": true,
	}
	for _, c := range cf.calls {
		if !allowed[c] {
			t.Errorf("unexpected API call %s: a compose resource must only touch the configuration", c)
		}
	}
}

func (cf *composeFake) sent(proc string) []map[string]any {
	cf.mu.Lock()
	defer cf.mu.Unlock()
	return append([]map[string]any(nil), cf.bodies[proc]...)
}

func (cf *composeFake) lastSent(t *testing.T, proc string) map[string]any {
	t.Helper()
	all := cf.sent(proc)
	if len(all) == 0 {
		t.Fatalf("%s was never called", proc)
	}
	return all[len(all)-1]
}

// mutationCount counts the calls that change something.
func (cf *composeFake) mutationCount() int {
	n := 0
	for _, p := range []string{"compose.create", "compose.update", "compose.move", "compose.saveEnvironment", "compose.delete", "trpc/compose.updateBuildServer"} {
		n += cf.called(p)
	}
	return n
}

func (cf *composeFake) callOrder() []string {
	cf.mu.Lock()
	defer cf.mu.Unlock()
	var out []string
	for _, c := range cf.calls {
		if strings.HasPrefix(c, "compose.") && c != "compose.one" || c == "trpc/compose.updateBuildServer" {
			out = append(out, c)
		}
	}
	return out
}

func composeKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func composeExpectKeys(m map[string]any, want ...string) error {
	sort.Strings(want)
	if got := composeKeys(m); strings.Join(got, ",") != strings.Join(want, ",") {
		return fmt.Errorf("payload keys are %v, want %v", got, want)
	}
	return nil
}

// composeHCL quotes a string for a configuration, `${` included.
func composeHCL(s string) string { return strings.ReplaceAll(strconv.Quote(s), "${", "$${") }

func composeIDs(f *fakeAPI) (envA, envB string) {
	return f.seed("environment", map[string]any{"name": "production", "projectId": "pj-1", "env": ""}),
		f.seed("environment", map[string]any{"name": "staging", "projectId": "pj-1", "env": ""})
}

func TestComposeLifecycleRaw(t *testing.T) {
	cf, srv := newComposeFake(t)
	envA, envB := composeIDs(cf.fakeAPI)
	const file1 = "services:\n  web:\n    image: passbolt/passbolt:latest\n    ports: [\"${PORT}:80\"]\n"
	const file2 = "services:\n  web:\n    image: passbolt/passbolt:5.0\n"
	cfg := func(env, server, body string) string {
		return providerBlock(srv.URL) + fmt.Sprintf(`
resource "dokploy_compose" "c" {
  name            = "passbolt"
  environment_id  = %q
  server_id       = %q
%s
  env             = { APP_FULL_BASE_URL = "https://pass.example.test" }
  secret_env_keys = ["DATASOURCES_DEFAULT_PASSWORD"]
}
`, env, server, body)
	}
	create := cfg(envA, "srv-1", `
  app_name_prefix = "app-passbolt"
  description     = "password manager"
  compose_file    = `+composeHCL(file1)+`
  auto_deploy     = false
  secret_env_wo   = { DATASOURCES_DEFAULT_PASSWORD = "pw-fixture-value" }
`)
	// Same configuration without the write-only inputs: nothing to do.
	unchanged := cfg(envA, "srv-1", `
  app_name_prefix = "app-passbolt"
  description     = "password manager"
  compose_file    = `+composeHCL(file1)+`
  auto_deploy     = false
`)
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		CheckDestroy: func(*terraform.State) error {
			if n := len(cf.sent("compose.delete")); n == 0 {
				return fmt.Errorf("compose.delete was never called")
			}
			for _, b := range cf.sent("compose.delete") {
				if b["deleteVolumes"] != false {
					return fmt.Errorf("a destroy must keep the volumes: %v", b)
				}
			}
			return nil
		},
		Steps: []resource.TestStep{
			{
				Config: create,
				Check: func(s *terraform.State) error {
					id = idOf(s, "dokploy_compose.c")
					remote := cf.get("compose", id)
					if name := fmt.Sprint(remote["appName"]); !strings.HasPrefix(name, "app-passbolt-") {
						return fmt.Errorf("app name %q does not start with the prefix", name)
					}
					attrs := s.RootModule().Resources["dokploy_compose.c"].Primary.Attributes
					if attrs["app_name"] != remote["appName"] {
						return fmt.Errorf("app_name %q, remote %q", attrs["app_name"], remote["appName"])
					}
					if _, ok := attrs["app_name_prefix"]; ok && attrs["app_name_prefix"] != "" {
						return fmt.Errorf("app_name_prefix leaked in the state: %q", attrs["app_name_prefix"])
					}
					for k := range attrs {
						if strings.Contains(k, "refresh") {
							return fmt.Errorf("the webhook token must not be exposed: %s", k)
						}
					}
					if remote["sourceType"] != "raw" {
						return fmt.Errorf("an inline compose file implies the raw source, got %v", remote["sourceType"])
					}
					if remote["serverId"] != "srv-1" || remote["composeFile"] != file1 || remote["autoDeploy"] != false || remote["description"] != "password manager" {
						return fmt.Errorf("remote not as planned: %v", remote)
					}
					env := fmt.Sprint(remote["env"])
					if !strings.Contains(env, "DATASOURCES_DEFAULT_PASSWORD=pw-fixture-value") || !strings.Contains(env, "APP_FULL_BASE_URL=https://pass.example.test") {
						return fmt.Errorf("remote env is %q", env)
					}
					if attrs["compose_status"] != "idle" || attrs["compose_type"] != "docker-compose" {
						return fmt.Errorf("computed attributes: %v", attrs)
					}
					// create takes seven keys, the rest goes through update.
					if err := composeExpectKeys(cf.lastSent(t, "compose.create"), "name", "description", "environmentId", "serverId", "composeFile", "appName"); err != nil {
						return fmt.Errorf("compose.create: %w", err)
					}
					if err := composeExpectKeys(cf.lastSent(t, "compose.update"), "composeId", "sourceType", "autoDeploy"); err != nil {
						return fmt.Errorf("compose.update: %w", err)
					}
					if got := cf.callOrder(); strings.Join(got, " ") != "compose.create compose.update compose.saveEnvironment" {
						return fmt.Errorf("call order %v", got)
					}
					return notInState(s, "pw-fixture-value")
				},
			},
			{
				Config:           unchanged,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
			{
				// A plain update sends the changed attributes only, and keeps the secret.
				Config: cfg(envA, "srv-1", `
  app_name_prefix = "another-prefix"
  description     = "password manager (prod)"
  compose_file    = `+composeHCL(file2)+`
  auto_deploy     = true
  randomize       = true
  suffix          = "x1"
`),
				Check: func(s *terraform.State) error {
					remote := cf.get("compose", id)
					if remote["composeFile"] != file2 || remote["randomize"] != true || remote["suffix"] != "x1" || remote["autoDeploy"] != true {
						return fmt.Errorf("remote not updated: %v", remote)
					}
					if !strings.Contains(fmt.Sprint(remote["env"]), "DATASOURCES_DEFAULT_PASSWORD=pw-fixture-value") {
						return fmt.Errorf("the secret was lost: %v", remote["env"])
					}
					if strings.HasPrefix(fmt.Sprint(remote["appName"]), "another-prefix") {
						return fmt.Errorf("the app name must not change: %v", remote["appName"])
					}
					return composeExpectKeys(cf.lastSent(t, "compose.update"), "composeId", "description", "composeFile", "autoDeploy", "randomize", "suffix")
				},
			},
			{
				// Moving to another environment uses compose.move and nothing else.
				PreConfig: func() { cf.mu.Lock(); cf.bodies["compose.update"] = nil; cf.mu.Unlock() },
				Config: cfg(envB, "srv-1", `
  description     = "password manager (prod)"
  compose_file    = `+composeHCL(file2)+`
  auto_deploy     = true
  randomize       = true
  suffix          = "x1"
`),
				Check: func(s *terraform.State) error {
					if got := cf.get("compose", id)["environmentId"]; got != envB {
						return fmt.Errorf("environment is %v, want %v", got, envB)
					}
					if n := len(cf.sent("compose.update")); n != 0 {
						return fmt.Errorf("compose.update called %d times for a move", n)
					}
					return composeExpectKeys(cf.lastSent(t, "compose.move"), "composeId", "targetEnvironmentId")
				},
			},
			{
				ResourceName:            "dokploy_compose.c",
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"env", "secret_env_keys", "compose_file"},
			},
			{
				// The runtime server cannot change: the compose is replaced.
				Config: cfg(envB, "srv-2", `
  description     = "password manager (prod)"
  compose_file    = `+composeHCL(file2)+`
  auto_deploy     = true
  randomize       = true
  suffix          = "x1"
  secret_env_wo   = { DATASOURCES_DEFAULT_PASSWORD = "pw-other-value" }
`),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("dokploy_compose.c", plancheck.ResourceActionReplace),
				}},
				Check: func(s *terraform.State) error {
					if newID := idOf(s, "dokploy_compose.c"); newID == id || cf.get("compose", id) != nil {
						return fmt.Errorf("the old compose %s should be gone", id)
					}
					if got := cf.get("compose", idOf(s, "dokploy_compose.c"))["serverId"]; got != "srv-2" {
						return fmt.Errorf("server is %v", got)
					}
					return notInState(s, "pw-other-value")
				},
			},
		},
	})
	if left := len(cf.objs["compose"]); left != 0 {
		t.Fatalf("%d composes left after destroy", left)
	}
}

func TestComposeGithubWithBuildServer(t *testing.T) {
	cf, srv := newComposeFake(t)
	envA, _ := composeIDs(cf.fakeAPI)
	cfg := func(extra string) string {
		return providerBlock(srv.URL) + fmt.Sprintf(`
resource "dokploy_compose" "c" {
  name                        = "monorepo"
  environment_id              = %q
  server_id                   = "srv-1"
  source_type                 = "github"
  github_id                   = "gh-1"
  owner                       = "Flots-app"
  repository                  = "monorepo"
  compose_path                = "./docker-compose.yaml"
  trigger_type                = "tag"
  auto_deploy                 = false
  watch_paths                 = ["apps/**"]
  enable_submodules           = true
  isolated_deployments_volume = true
%s
}
`, envA, extra)
	}
	withBuild := cfg(`
  branch            = "main"
  build_server_id   = "bs-1"
  build_registry_id = "reg-1"
`)
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: withBuild,
				Check: func(s *terraform.State) error {
					id = idOf(s, "dokploy_compose.c")
					remote := cf.get("compose", id)
					for k, want := range map[string]any{
						"sourceType": "github", "githubId": "gh-1", "owner": "Flots-app", "repository": "monorepo", "branch": "main",
						"composePath": "./docker-compose.yaml", "triggerType": "tag", "autoDeploy": false, "enableSubmodules": true,
						"isolatedDeploymentsVolume": true, "buildServerId": "bs-1", "buildRegistryId": "reg-1", "serverId": "srv-1",
					} {
						if fmt.Sprint(remote[k]) != fmt.Sprint(want) {
							return fmt.Errorf("remote %s is %v, want %v", k, remote[k], want)
						}
					}
					if got := fmt.Sprint(remote["watchPaths"]); got != "[apps/**]" {
						return fmt.Errorf("watchPaths %v", got)
					}
					// The source is configured before the build server, whose
					// rules need a Git source.
					if got := cf.callOrder(); strings.Join(got, " ") != "compose.create compose.update trpc/compose.updateBuildServer" {
						return fmt.Errorf("call order %v", got)
					}
					upd := cf.lastSent(t, "compose.update")
					for _, k := range []string{"serverId", "buildServerId", "buildRegistryId", "appName", "refreshToken", "composeStatus"} {
						if _, ok := upd[k]; ok {
							return fmt.Errorf("compose.update must not carry %s", k)
						}
					}
					return nil
				},
			},
			{
				Config:           withBuild,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
			{
				// Disabling the build server comes first, then the other changes.
				PreConfig: func() { cf.mu.Lock(); cf.calls = nil; cf.mu.Unlock() },
				Config: cfg(`
  branch            = "release"
  build_server_id   = ""
  build_registry_id = ""
`),
				Check: func(s *terraform.State) error {
					remote := cf.get("compose", id)
					if remote["buildServerId"] != nil || remote["buildRegistryId"] != nil || remote["branch"] != "release" {
						return fmt.Errorf("remote not as planned: %v", remote)
					}
					if got := cf.callOrder(); strings.Join(got, " ") != "trpc/compose.updateBuildServer compose.update" {
						return fmt.Errorf("call order %v", got)
					}
					last := cf.lastSent(t, "compose.updateBuildServer")
					if last["buildServerId"] != nil || last["buildRegistryId"] != nil {
						return fmt.Errorf("disabling must send nulls: %v", last)
					}
					return composeExpectKeys(cf.lastSent(t, "compose.update"), "composeId", "branch")
				},
			},
			{
				// A null in the API is "" in the state: stable across refreshes.
				Config: cfg(`
  branch            = "release"
  build_server_id   = ""
  build_registry_id = ""
`),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
			{
				Config: cfg(`
  branch            = "release"
  build_server_id   = "bs-1"
  build_registry_id = ""
`),
				ExpectError: regexp.MustCompile(`build_server_id and build_registry_id must be set together`),
			},
			{
				// Re-enabling goes through the API rule: no raw source allowed.
				PreConfig: func() { cf.mu.Lock(); cf.calls = nil; cf.mu.Unlock() },
				Config: cfg(`
  branch            = "release"
  build_server_id   = "bs-2"
  build_registry_id = "reg-2"
`),
				Check: func(s *terraform.State) error {
					remote := cf.get("compose", id)
					if remote["buildServerId"] != "bs-2" || remote["buildRegistryId"] != "reg-2" {
						return fmt.Errorf("remote not as planned: %v", remote)
					}
					if n := cf.called("compose.update"); n != 0 {
						return fmt.Errorf("compose.update called %d times for a build server change", n)
					}
					return nil
				},
			},
		},
	})
}

func TestComposeCreateFailureRemovesTheHalfCreatedCompose(t *testing.T) {
	cf, srv := newComposeFake(t)
	envA, _ := composeIDs(cf.fakeAPI)
	cf.mu.Lock()
	cf.hooks["compose.update"] = func(w http.ResponseWriter, body map[string]any) bool {
		composeJSONReply(w, http.StatusBadRequest, map[string]any{"message": "boom"})
		return true
	}
	cf.mu.Unlock()
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config: providerBlock(srv.URL) + fmt.Sprintf(`
resource "dokploy_compose" "c" {
  name           = "x"
  environment_id = %q
  source_type    = "raw"
  compose_file   = "services: {}"
}
`, envA),
			ExpectError: regexp.MustCompile(`half-created\s+compose\s+was\s+removed`),
		}},
	})
	if n := len(cf.objs["compose"]); n != 0 {
		t.Fatalf("%d composes left behind", n)
	}
	if b := cf.sent("compose.delete"); len(b) != 1 || b[0]["deleteVolumes"] != false {
		t.Fatalf("rollback delete: %v", b)
	}
}

// ------------------------------------------------------------- adoption

// composeSeed stores an object under its own composeId, as a real production
// object keeps its id.
func composeSeed(f *fakeAPI, obj map[string]any) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.objs["compose"] == nil {
		f.objs["compose"] = map[string]map[string]any{}
	}
	id := obj["composeId"].(string)
	f.objs["compose"][id] = obj
	return id
}

// monorepoProd is a trimmed copy of the production `monorepo` compose (github
// source, tag trigger, build server and registry, shared volumes). Secrets are
// fake: the sample masks them.
func monorepoProd() map[string]any {
	return map[string]any{
		"composeId": "RsQUtixvesryzf1ZpLwkT", "name": "monorepo", "appName": "app-monorepo-kyohkb", "description": "",
		"env":         "APP_ENV=production\nDATABASE_URL=postgres://app:fake-db-pass@db:5432/app\nLOG_LEVEL=info\n",
		"composeFile": "", "refreshToken": "<redacted:str>",
		"sourceType": "github", "composeType": "docker-compose",
		"repository": "monorepo", "owner": "Flots-app", "branch": "main", "autoDeploy": false,
		"gitlabProjectId": nil, "gitlabRepository": nil, "gitlabOwner": nil, "gitlabBranch": nil, "gitlabPathNamespace": nil,
		"bitbucketRepository": nil, "bitbucketRepositorySlug": nil, "bitbucketOwner": nil, "bitbucketBranch": nil,
		"giteaRepository": nil, "giteaOwner": nil, "giteaBranch": nil,
		"customGitUrl": nil, "customGitBranch": nil, "customGitSSHKeyId": nil,
		"command": "", "enableSubmodules": false, "composePath": "./docker-compose.yaml", "suffix": "",
		"randomize": false, "isolatedDeployment": false, "isolatedDeploymentsVolume": true,
		"triggerType": "tag", "composeStatus": "done", "watchPaths": []any{},
		"createdAt":     "2025-06-11T04:33:17.203Z",
		"environmentId": "env_prod_bugSRj1IJ6LokzazCsYLt_1757262382.609079",
		"githubId":      "gQJXmATMu5eSTvtWni3ya", "gitlabId": nil, "bitbucketId": nil, "giteaId": nil,
		"serverId": "XXQ2bDvtoMB5PhW51uozD", "buildServerId": "KZ4vfW5bRwhFW2gYdAA1t", "buildRegistryId": "VFjAhlgO_FqHbdaEMKV2E",
		// Nested relations and extras `compose.one` adds.
		"environment": map[string]any{"environmentId": "env_prod_bugSRj1IJ6LokzazCsYLt_1757262382.609079", "name": "production", "isDefault": true,
			"project": map[string]any{"projectId": "pj-flots", "name": "pj-flots-nbg1-hetzner"}},
		"github":        map[string]any{"githubId": "gQJXmATMu5eSTvtWni3ya", "githubClientSecret": "<redacted:str>", "githubPrivateKey": "<redacted:str>", "githubWebhookSecret": "<redacted:str>"},
		"server":        map[string]any{"serverId": "XXQ2bDvtoMB5PhW51uozD", "ipAddress": "10.0.0.2", "name": "app"},
		"buildServer":   map[string]any{"serverId": "KZ4vfW5bRwhFW2gYdAA1t", "name": "builder"},
		"buildRegistry": map[string]any{"registryId": "VFjAhlgO_FqHbdaEMKV2E", "registryName": "ghcr"},
		"deployments":   []any{}, "mounts": []any{}, "domains": []any{map[string]any{"host": "app.example.test"}}, "backups": []any{},
		"bitbucket": nil, "gitea": nil, "gitlab": nil, "hasGitProviderAccess": true, "unauthorizedProvider": nil,
	}
}

const passboltFile = "services:\n  passbolt:\n    image: passbolt/passbolt:latest\n    environment:\n      APP_FULL_BASE_URL: ${APP_FULL_BASE_URL}\n      DATASOURCES_DEFAULT_PASSWORD: ${DATASOURCES_DEFAULT_PASSWORD}\n    ports:\n      - \"443:443\"\n"

// passboltProd is a trimmed copy of the production `passbolt` compose (raw
// source on a remote server, no Git field, watchPaths null, auto deploy on).
func passboltProd() map[string]any {
	return map[string]any{
		"composeId": "U4hFp9Ucvv8vPfNMQzVac", "name": "passbolt", "appName": "app-passbolt-qxdwqe", "description": "",
		"env":         "APP_FULL_BASE_URL=https://pass.example.test\nDATASOURCES_DEFAULT_PASSWORD=\"fake pass #1\"\nEMAIL_TRANSPORT_DEFAULT_PASSWORD=fake-smtp-pass\n",
		"composeFile": passboltFile, "refreshToken": "<redacted:str>",
		"sourceType": "raw", "composeType": "docker-compose",
		"repository": nil, "owner": nil, "branch": nil, "autoDeploy": true,
		"gitlabProjectId": nil, "gitlabRepository": nil, "gitlabOwner": nil, "gitlabBranch": nil, "gitlabPathNamespace": nil,
		"bitbucketRepository": nil, "bitbucketRepositorySlug": nil, "bitbucketOwner": nil, "bitbucketBranch": nil,
		"giteaRepository": nil, "giteaOwner": nil, "giteaBranch": nil,
		"customGitUrl": nil, "customGitBranch": nil, "customGitSSHKeyId": nil,
		"command": "", "enableSubmodules": false, "composePath": "./docker-compose.yml", "suffix": "",
		"randomize": false, "isolatedDeployment": false, "isolatedDeploymentsVolume": true,
		"triggerType": "push", "composeStatus": "done", "watchPaths": nil,
		"createdAt":     "2025-06-07T13:19:43.181Z",
		"environmentId": "env_prod_bugSRj1IJ6LokzazCsYLt_1757262382.609079",
		"githubId":      nil, "gitlabId": nil, "bitbucketId": nil, "giteaId": nil,
		"serverId": "N4_drB-08E_3wcR1B81K0", "buildServerId": nil, "buildRegistryId": nil,
		"environment": map[string]any{"environmentId": "env_prod_bugSRj1IJ6LokzazCsYLt_1757262382.609079", "name": "production"},
		"server":      map[string]any{"serverId": "N4_drB-08E_3wcR1B81K0", "ipAddress": "10.0.0.3", "name": "tools"},
		"github":      nil, "buildServer": nil, "buildRegistry": nil, "deployments": []any{}, "mounts": []any{}, "domains": []any{}, "backups": []any{},
		"hasGitProviderAccess": true, "unauthorizedProvider": nil,
	}
}

const prodEnvironmentID = "env_prod_bugSRj1IJ6LokzazCsYLt_1757262382.609079"

// A github compose of production is adopted with the shortest configuration a
// human can write, then with every attribute spelled out, and the plan stays
// empty. Importing and applying never writes anything to Dokploy.
func TestComposeAdoptionGithub(t *testing.T) {
	cf, srv := newComposeFake(t)
	id := composeSeed(cf.fakeAPI, monorepoProd())
	imp := fmt.Sprintf(`
import {
  to = dokploy_compose.monorepo
  id = %q
}
`, id)
	minimal := providerBlock(srv.URL) + imp + fmt.Sprintf(`
resource "dokploy_compose" "monorepo" {
  name           = "monorepo"
  environment_id = %q
}
`, prodEnvironmentID)
	explicit := providerBlock(srv.URL) + imp + fmt.Sprintf(`
resource "dokploy_compose" "monorepo" {
  name                        = "monorepo"
  environment_id              = %q
  description                 = ""
  server_id                   = "XXQ2bDvtoMB5PhW51uozD"
  build_server_id             = "KZ4vfW5bRwhFW2gYdAA1t"
  build_registry_id           = "VFjAhlgO_FqHbdaEMKV2E"
  compose_type                = "docker-compose"
  source_type                 = "github"
  github_id                   = "gQJXmATMu5eSTvtWni3ya"
  owner                       = "Flots-app"
  repository                  = "monorepo"
  branch                      = "main"
  compose_path                = "./docker-compose.yaml"
  trigger_type                = "tag"
  auto_deploy                 = false
  watch_paths                 = []
  enable_submodules           = false
  command                     = ""
  randomize                   = false
  suffix                      = ""
  isolated_deployment         = false
  isolated_deployments_volume = true
  env                         = { APP_ENV = "production", LOG_LEVEL = "info" }
  secret_env_keys             = ["DATABASE_URL"]
}
`, prodEnvironmentID)
	noWrite := func(*terraform.State) error {
		if n := cf.mutationCount(); n != 0 {
			return fmt.Errorf("%d write calls while adopting: %v", n, cf.callOrder())
		}
		return nil
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: minimal,
				Check: func(s *terraform.State) error {
					if got := idOf(s, "dokploy_compose.monorepo"); got != id {
						return fmt.Errorf("imported %q, want %q", got, id)
					}
					attrs := s.RootModule().Resources["dokploy_compose.monorepo"].Primary.Attributes
					for k, want := range map[string]string{
						"app_name": "app-monorepo-kyohkb", "source_type": "github", "github_id": "gQJXmATMu5eSTvtWni3ya",
						"owner": "Flots-app", "repository": "monorepo", "branch": "main", "trigger_type": "tag",
						"auto_deploy": "false", "compose_path": "./docker-compose.yaml", "compose_status": "done",
						"server_id": "XXQ2bDvtoMB5PhW51uozD", "build_server_id": "KZ4vfW5bRwhFW2gYdAA1t",
						"build_registry_id": "VFjAhlgO_FqHbdaEMKV2E", "isolated_deployments_volume": "true",
						"watch_paths.#": "0", "env_keys.#": "3",
					} {
						if attrs[k] != want {
							return fmt.Errorf("%s is %q, want %q", k, attrs[k], want)
						}
					}
					if err := noWrite(s); err != nil {
						return err
					}
					return notInState(s, "<redacted:str>")
				},
			},
			{
				Config:           minimal,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
			{
				// Spelling everything out, the environment included, only
				// records it in the state: Dokploy already holds all of it.
				Config: explicit,
				Check: func(s *terraform.State) error {
					if err := noWrite(s); err != nil {
						return err
					}
					if env := fmt.Sprint(cf.get("compose", id)["env"]); !strings.Contains(env, "fake-db-pass") {
						return fmt.Errorf("the secret was lost: %q", env)
					}
					return notInState(s, "fake-db-pass")
				},
			},
			{
				Config:           explicit,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
		},
	})
}

// A raw compose of production, with an inline compose file made of `${VAR}`
// references and secrets in the environment.
func TestComposeAdoptionRaw(t *testing.T) {
	cf, srv := newComposeFake(t)
	id := composeSeed(cf.fakeAPI, passboltProd())
	cfg := providerBlock(srv.URL) + fmt.Sprintf(`
import {
  to = dokploy_compose.passbolt
  id = %q
}
resource "dokploy_compose" "passbolt" {
  name            = "passbolt"
  environment_id  = %q
  server_id       = "N4_drB-08E_3wcR1B81K0"
  source_type     = "raw"
  compose_file    = %s
  env             = { APP_FULL_BASE_URL = "https://pass.example.test" }
  secret_env_keys = ["DATASOURCES_DEFAULT_PASSWORD", "EMAIL_TRANSPORT_DEFAULT_PASSWORD"]
}
`, id, prodEnvironmentID, composeHCL(passboltFile))
	minimal := providerBlock(srv.URL) + fmt.Sprintf(`
import {
  to = dokploy_compose.passbolt
  id = %q
}
resource "dokploy_compose" "passbolt" {
  name           = "passbolt"
  environment_id = %q
}
`, id, prodEnvironmentID)
	noWrite := func(s *terraform.State) error {
		if n := cf.mutationCount(); n != 0 {
			return fmt.Errorf("%d write calls while adopting: %v", n, cf.callOrder())
		}
		return nil
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: minimal,
				Check: func(s *terraform.State) error {
					attrs := s.RootModule().Resources["dokploy_compose.passbolt"].Primary.Attributes
					if attrs["source_type"] != "raw" || attrs["compose_file"] != "" || attrs["auto_deploy"] != "true" ||
						attrs["watch_paths.#"] != "0" || attrs["build_server_id"] != "" || attrs["isolated_deployments_volume"] != "true" {
						return fmt.Errorf("unexpected state: %v", attrs)
					}
					return noWrite(s)
				},
			},
			{
				Config:           minimal,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
			{
				Config: cfg,
				Check: func(s *terraform.State) error {
					if err := noWrite(s); err != nil {
						return err
					}
					// Quotes and spaces of the secret survive, byte for byte.
					if env := fmt.Sprint(cf.get("compose", id)["env"]); !strings.Contains(env, "DATASOURCES_DEFAULT_PASSWORD=\"fake pass #1\"\n") {
						return fmt.Errorf("the secret was altered: %q", env)
					}
					if err := notInState(s, "fake pass #1"); err != nil {
						return err
					}
					return notInState(s, "fake-smtp-pass")
				},
			},
			{
				Config:           cfg,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
		},
	})
}

// "" is how a configuration says "not set" (the only way to clear an
// Optional+Computed attribute): Dokploy's NULL must read back as "" or the plan
// would never settle, and clearing a reference must send a null, not a bad id.
func TestComposeEmptyStringMeansUnset(t *testing.T) {
	cf, srv := newComposeFake(t)
	obj := passboltProd()
	obj["description"] = nil // created from a template: NULL, not ""
	passbolt := composeSeed(cf.fakeAPI, obj)
	monorepo := composeSeed(cf.fakeAPI, monorepoProd())
	cfg := func(githubID string) string {
		return providerBlock(srv.URL) + fmt.Sprintf(`
import {
  to = dokploy_compose.passbolt
  id = %q
}
import {
  to = dokploy_compose.monorepo
  id = %q
}
resource "dokploy_compose" "passbolt" {
  name                  = "passbolt"
  environment_id        = %q
  description           = ""
  branch                = ""
  github_id             = ""
  custom_git_ssh_key_id = ""
}
resource "dokploy_compose" "monorepo" {
  name           = "monorepo"
  environment_id = %q
  github_id      = %q
}
`, passbolt, monorepo, prodEnvironmentID, prodEnvironmentID, githubID)
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: cfg("gQJXmATMu5eSTvtWni3ya"),
				Check: func(*terraform.State) error {
					if n := cf.mutationCount(); n != 0 {
						return fmt.Errorf("%d write calls while adopting: %v", n, cf.callOrder())
					}
					return nil
				},
			},
			{
				Config:           cfg("gQJXmATMu5eSTvtWni3ya"),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
			{
				// Clearing a reference sends a null and settles.
				Config: cfg(""),
				Check: func(*terraform.State) error {
					if got := cf.get("compose", monorepo)["githubId"]; got != nil {
						return fmt.Errorf("githubId is %v, want null", got)
					}
					upd := cf.lastSent(t, "compose.update")
					if v, ok := upd["githubId"]; !ok || v != nil || len(upd) != 2 {
						return fmt.Errorf("compose.update payload %v", upd)
					}
					return nil
				},
			},
			{
				Config:           cfg(""),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
		},
	})
}
