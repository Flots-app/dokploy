package provider

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

// ------------------------------------------------------------------ the fake

// srvFake extends the shared fake API with the procedures the server, settings
// and Traefik resources use. It answers on its own URL and hands every other
// procedure to the shared fake.
type srvFake struct {
	*fakeAPI
	URL string

	settings map[string]any
	ports    []map[string]any
	// pendingPorts become visible after portsLag polls of getTraefikPorts, as
	// Traefik takes a while to be recreated.
	pendingPorts  []map[string]any
	hasPending    bool
	portsLag      int
	files         map[string]string // by traefikID
	swallowWrites bool
	logCleanupOK  bool
	// restMissing lists procedures the REST facade does not know (404); they stay
	// reachable through the raw tRPC endpoint.
	restMissing map[string]bool
	failProc    map[string]bool

	handlers map[string]func(q url.Values, body map[string]any) (int, any)
	mine     []string
	bodies   map[string][]map[string]any
}

func newSrvFake(t *testing.T) *srvFake {
	f, base := newFakeAPI(t)
	f.routes["server"] = "serverId"
	s := &srvFake{
		fakeAPI:      f,
		files:        map[string]string{},
		logCleanupOK: true,
		restMissing:  map[string]bool{},
		failProc:     map[string]bool{},
		bodies:       map[string][]map[string]any{},
	}
	f.hooks["server.create"] = s.serverCreate
	f.hooks["server.update"] = s.serverUpdate
	s.handlers = s.buildHandlers()
	srv := httptest.NewServer(http.HandlerFunc(s.serveHTTP))
	t.Cleanup(srv.Close)
	s.URL = srv.URL
	_ = base
	return s
}

func srvJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *srvFake) serveHTTP(w http.ResponseWriter, r *http.Request) {
	proc := strings.TrimPrefix(r.URL.Path, "/api/")
	viaTRPC := strings.HasPrefix(proc, "trpc/")
	name := strings.TrimPrefix(proc, "trpc/")
	h, mine := s.handlers[name]
	if !mine {
		s.fakeAPI.serve(w, r)
		return
	}
	if r.Header.Get("x-api-key") != "test-key" {
		srvJSON(w, http.StatusUnauthorized, map[string]any{"message": "unauthorized"})
		return
	}
	s.fakeAPI.mu.Lock()
	defer s.fakeAPI.mu.Unlock()
	s.mine = append(s.mine, proc)
	if !viaTRPC && s.restMissing[name] {
		srvJSON(w, http.StatusNotFound, map[string]any{"message": "Not found"})
		return
	}
	body := map[string]any{}
	if r.Method == http.MethodPost {
		_ = json.NewDecoder(r.Body).Decode(&body)
		if viaTRPC {
			body, _ = body["json"].(map[string]any)
		}
	}
	s.bodies[name] = append(s.bodies[name], body)
	if s.failProc[name] {
		srvJSON(w, http.StatusBadRequest, map[string]any{"message": "forced failure of " + name})
		return
	}
	code, out := h(r.URL.Query(), body)
	if code >= 300 {
		srvJSON(w, code, map[string]any{"message": fmt.Sprint(out)})
		return
	}
	if viaTRPC {
		out = map[string]any{"result": map[string]any{"data": map[string]any{"json": out}}}
	}
	srvJSON(w, code, out)
}

// callsOf counts the calls of a procedure, whoever handled them.
func (s *srvFake) callsOf(proc string) int {
	s.fakeAPI.mu.Lock()
	defer s.fakeAPI.mu.Unlock()
	n := 0
	for _, c := range append(append([]string{}, s.fakeAPI.calls...), s.mine...) {
		if c == proc || c == "trpc/"+proc {
			n++
		}
	}
	return n
}

// forbidden are the procedures that connect to a machine or restart a
// component: Terraform must never call them.
var srvForbidden = regexp.MustCompile(`^(trpc/)?(server\.(setup|setupWithLogs|validate|security|setupMonitoring|updatePreviewPolicy|updatePreviewFirewall)|settings\.(reloadTraefik|reloadServer|toggleDashboard|writeTraefikEnv|updateServer|reloadRedis|cleanAll\w*|cleanDocker\w*|clean\w+|setupGPU|saveSSHPrivateKey|cleanSSHPrivateKey)|admin\.setupMonitoring)$`)

func (s *srvFake) assertNoForbiddenCall(t *testing.T) {
	t.Helper()
	s.fakeAPI.mu.Lock()
	defer s.fakeAPI.mu.Unlock()
	for _, c := range append(append([]string{}, s.fakeAPI.calls...), s.mine...) {
		if srvForbidden.MatchString(c) {
			t.Errorf("forbidden procedure called: %s", c)
		}
	}
}

// ---- server procedures

// srvRequire checks the keys a zod schema requires, with their JSON types.
func srvRequire(body map[string]any, spec string) string {
	for _, item := range strings.Fields(spec) {
		key, typ, _ := strings.Cut(item, ":")
		v, ok := body[key]
		if !ok || v == nil {
			return fmt.Sprintf("Required: %s", key)
		}
		okType := true
		switch typ {
		case "string":
			str, isStr := v.(string)
			okType = isStr && (key == "description" || str != "")
		case "number":
			_, okType = v.(float64)
		case "bool":
			_, okType = v.(bool)
		}
		if !okType {
			return fmt.Sprintf("Invalid type for %s", key)
		}
	}
	return ""
}

func (s *srvFake) serverCreate(w http.ResponseWriter, body map[string]any) bool {
	if msg := srvRequire(body, "name:string description:string ipAddress:string port:number username:string sshKeyId:string serverType:string enableDockerCleanup:bool"); msg != "" {
		srvJSON(w, http.StatusBadRequest, map[string]any{"message": msg})
		return true
	}
	isDefault := false
	if body["serverType"] == "build" {
		isDefault = true
		for _, o := range s.fakeAPI.objs["server"] {
			if o["isDefaultBuildServer"] == true {
				isDefault = false
			}
		}
	}
	obj := map[string]any{}
	for k, v := range body {
		obj[k] = v
	}
	obj["appName"] = "server-fake-" + fmt.Sprint(s.fakeAPI.next+1)
	obj["serverStatus"] = "active"
	obj["command"] = ""
	obj["buildsConcurrency"] = float64(1)
	obj["isDefaultBuildServer"] = isDefault
	obj["organizationId"] = "org-1"
	obj["metricsConfig"] = map[string]any{"server": map[string]any{"token": "METRICS-TOKEN-VALUE", "port": float64(4500)}}
	srvJSON(w, http.StatusOK, s.fakeAPI.insert("server", obj))
	return true
}

func (s *srvFake) serverUpdate(w http.ResponseWriter, body map[string]any) bool {
	if msg := srvRequire(body, "serverId:string name:string description:string ipAddress:string port:number username:string sshKeyId:string serverType:string enableDockerCleanup:bool"); msg != "" {
		srvJSON(w, http.StatusBadRequest, map[string]any{"message": msg})
		return true
	}
	return false // the generic update merges the body
}

func (s *srvFake) buildHandlers() map[string]func(q url.Values, body map[string]any) (int, any) {
	ok := func(q url.Values, body map[string]any) (int, any) { return 200, true }
	setting := func(key, bodyKey string) func(q url.Values, body map[string]any) (int, any) {
		return func(q url.Values, body map[string]any) (int, any) {
			s.settings[key] = body[bodyKey]
			return 200, true
		}
	}
	file := func(id string) func(q url.Values, body map[string]any) (int, any) {
		return func(url.Values, map[string]any) (int, any) { return 200, s.readFile(id) }
	}
	write := func(id string) func(q url.Values, body map[string]any) (int, any) {
		return func(q url.Values, body map[string]any) (int, any) { return 200, s.writeFile(id, body) }
	}
	return map[string]func(q url.Values, body map[string]any) (int, any){
		"server.updateBuildsConcurrency": func(q url.Values, body map[string]any) (int, any) {
			n, _ := body["buildsConcurrency"].(float64)
			o := s.fakeAPI.objs["server"][asString(body["serverId"])]
			if o == nil || n < 1 || n > 100 {
				return 400, "invalid input"
			}
			o["buildsConcurrency"] = n
			return 200, o
		},
		"server.setDefaultBuildServer": func(q url.Values, body map[string]any) (int, any) {
			o := s.fakeAPI.objs["server"][asString(body["serverId"])]
			if o == nil {
				return 404, "Server not found"
			}
			if o["serverType"] != "build" {
				return 400, "The default Build Server must be active, accessible by SSH, and have serverType build"
			}
			for _, other := range s.fakeAPI.objs["server"] {
				other["isDefaultBuildServer"] = false
			}
			o["isDefaultBuildServer"] = true
			return 200, o
		},
		"settings.getWebServerSettings": func(url.Values, map[string]any) (int, any) { return 200, s.settings },
		"settings.getTraefikPorts": func(url.Values, map[string]any) (int, any) {
			if s.hasPending {
				if s.portsLag > 0 {
					s.portsLag--
				} else {
					s.ports, s.pendingPorts, s.hasPending = s.pendingPorts, nil, false
				}
			}
			return 200, s.ports
		},
		"settings.updateTraefikPorts": func(q url.Values, body map[string]any) (int, any) {
			raw, _ := body["additionalPorts"].([]any)
			ports := []map[string]any{}
			for _, p := range raw {
				ports = append(ports, p.(map[string]any))
			}
			s.pendingPorts, s.hasPending = ports, true
			return 200, true
		},
		"settings.assignDomainServer": func(q url.Values, body map[string]any) (int, any) {
			if msg := srvRequire(body, "host:string certificateType:string"); msg != "" {
				return 400, msg
			}
			s.settings["host"] = body["host"]
			s.settings["certificateType"] = body["certificateType"]
			if v, ok := body["https"]; ok {
				s.settings["https"] = v
			}
			if e, ok := body["letsEncryptEmail"].(string); ok && e != "" {
				s.settings["letsEncryptEmail"] = e
			}
			return 200, s.settings
		},
		"settings.updateServerIp":          setting("serverIp", "serverIp"),
		"settings.updateDockerCleanup":     setting("enableDockerCleanup", "enableDockerCleanup"),
		"settings.updateBuildsConcurrency": setting("buildsConcurrency", "buildsConcurrency"),
		"settings.updateRemoteServersOnly": setting("remoteServersOnly", "remoteServersOnly"),
		"settings.updateEnforceSSO":        setting("enforceSSO", "enforceSSO"),
		"settings.updateLogCleanup": func(q url.Values, body map[string]any) (int, any) {
			if !s.logCleanupOK {
				return 200, false
			}
			s.settings["logCleanupCron"] = body["cronExpression"]
			return 200, true
		},
		"settings.readTraefikConfig":             file("main"),
		"settings.readWebServerTraefikConfig":    file("web_server"),
		"settings.readMiddlewareTraefikConfig":   file("middlewares"),
		"settings.updateTraefikConfig":           write("main"),
		"settings.updateWebServerTraefikConfig":  write("web_server"),
		"settings.updateMiddlewareTraefikConfig": write("middlewares"),
		"settings.readTraefikFile": func(q url.Values, body map[string]any) (int, any) {
			p := q.Get("path")
			if strings.Contains(p, "../") || (strings.HasPrefix(p, "/") && !strings.HasPrefix(p, traefikRoot)) {
				return 400, "Invalid path: path traversal or unauthorized directory access detected"
			}
			return 200, s.readFile(traefikID("file", p, q.Get("serverId")))
		},
		"settings.updateTraefikFile": func(q url.Values, body map[string]any) (int, any) {
			return 200, s.writeFile(traefikID("file", asString(body["path"]), asString(body["serverId"])), body)
		},
		"settings.noop": ok,
	}
}

// readFile answers like the Dokploy procedures: the text, or null.
func (s *srvFake) readFile(id string) any {
	if c, ok := s.files[id]; ok {
		return c
	}
	return nil
}

// writeFile stores a file, or silently does not, as Dokploy does on errors.
func (s *srvFake) writeFile(id string, body map[string]any) any {
	c, _ := body["traefikConfig"].(string)
	if c == "" {
		return "traefikConfig: String must contain at least 1 character(s)"
	}
	if !s.swallowWrites {
		s.files[id] = c
	}
	return true
}

// srvProdDeploy and srvProdBuild are shaped like the redacted prod sample
// (server.all.json): a deploy server reached through a Tailscale address, and
// the default build server.
func srvProdDeploy() map[string]any {
	return map[string]any{
		"appName": "server-calculate-solid-state-bus-d7nfqy", "buildsConcurrency": float64(1), "command": "",
		"description": "", "enableDockerCleanup": true, "ipAddress": "100.127.224.66", "isDefaultBuildServer": false,
		"metricsConfig": srvProdMetrics(), "name": "ubuntu-8gb-fsn1-1-prd", "organizationId": "org-1", "port": float64(2200),
		"serverStatus": "active", "serverType": "deploy", "sshKeyId": "key-1", "username": "deploy",
		"deployments": []any{}, "sshKey": map[string]any{"sshKeyId": "key-1", "privateKey": ""},
	}
}

func srvProdBuild() map[string]any {
	return map[string]any{
		"appName": "server-back-up-back-end-panel-5zlcfn", "buildsConcurrency": float64(1), "command": "",
		"description": "", "enableDockerCleanup": true, "ipAddress": "100.115.98.81", "isDefaultBuildServer": true,
		"metricsConfig": srvProdMetrics(), "name": "kvincent-mac-mini-m4", "organizationId": "org-1", "port": float64(22),
		"serverStatus": "active", "serverType": "build", "sshKeyId": "key-2", "username": "builder",
		"deployments": []any{}, "sshKey": map[string]any{"sshKeyId": "key-2", "privateKey": ""},
	}
}

func srvProdMetrics() map[string]any {
	return map[string]any{
		"containers": map[string]any{"refreshRate": float64(60), "services": map[string]any{"exclude": []any{}, "include": []any{}}},
		"server": map[string]any{
			"cronJob": "", "port": float64(4500), "refreshRate": float64(60), "retentionDays": float64(2),
			"thresholds": map[string]any{"cpu": float64(0), "memory": float64(0)}, "token": "METRICS-TOKEN-VALUE", "type": "Remote", "urlCallback": "",
		},
	}
}

// ------------------------------------------------------------------- the tests

func TestServerLifecycle(t *testing.T) {
	s := newSrvFake(t)
	cfg := func(body string) string {
		return providerBlock(s.URL) + `
resource "dokploy_server" "s" {
` + body + `
}
`
	}
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: cfg(`
  name                    = "builder"
  description             = "Builds images"
  ip_address              = "100.64.0.10"
  port                    = 2222
  username                = "ci"
  ssh_key_id              = "key-1"
  server_type             = "build"
  enable_docker_cleanup   = false
  builds_concurrency      = 3
  is_default_build_server = true
  command                 = "echo hello"
`),
				Check: func(st *terraform.State) error {
					id = idOf(st, "dokploy_server.s")
					o := s.get("server", id)
					for k, want := range map[string]string{
						"name": "builder", "description": "Builds images", "ipAddress": "100.64.0.10", "port": "2222",
						"username": "ci", "sshKeyId": "key-1", "serverType": "build", "enableDockerCleanup": "false",
						"buildsConcurrency": "3", "isDefaultBuildServer": "true", "command": "echo hello",
					} {
						if got := asString(o[k]); got != want {
							return fmt.Errorf("remote %s = %q, want %q", k, got, want)
						}
					}
					return resource.TestCheckResourceAttrSet("dokploy_server.s", "app_name")(st)
				},
			},
			{
				// An update changes the object, keeps the rest and does not touch the
				// monitoring configuration.
				Config: cfg(`
  name                    = "builder-2"
  description             = "Builds images, renamed"
  ip_address              = "100.64.0.11"
  port                    = 2222
  username                = "ci"
  ssh_key_id              = "key-1"
  server_type             = "build"
  enable_docker_cleanup   = true
  builds_concurrency      = 2
  is_default_build_server = true
  command                 = "echo hello"
`),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("dokploy_server.s", plancheck.ResourceActionUpdate),
				}},
				Check: func(st *terraform.State) error {
					o := s.get("server", id)
					if o["name"] != "builder-2" || o["ipAddress"] != "100.64.0.11" || asString(o["buildsConcurrency"]) != "2" || o["enableDockerCleanup"] != true {
						return fmt.Errorf("update not applied: %v", o)
					}
					if mc, _ := o["metricsConfig"].(map[string]any); dig(mc, "server", "token") != "METRICS-TOKEN-VALUE" {
						return fmt.Errorf("metricsConfig was touched: %v", o["metricsConfig"])
					}
					return notInState(st, "METRICS-TOKEN-VALUE")
				},
			},
			{ResourceName: "dokploy_server.s", ImportState: true, ImportStateVerify: true},
			{
				// Only the concurrency changes: neither server.update nor the default
				// build server procedure is needed.
				PreConfig: func() {
					s.fakeAPI.mu.Lock()
					s.mine, s.fakeAPI.calls = nil, nil
					s.fakeAPI.mu.Unlock()
				},
				Config: cfg(`
  name                    = "builder-2"
  description             = "Builds images, renamed"
  ip_address              = "100.64.0.11"
  port                    = 2222
  username                = "ci"
  ssh_key_id              = "key-1"
  server_type             = "build"
  enable_docker_cleanup   = true
  builds_concurrency      = 4
  is_default_build_server = true
  command                 = "echo hello"
`),
				Check: func(st *terraform.State) error {
					if n := s.callsOf("server.update"); n != 0 {
						return fmt.Errorf("server.update called %d times for a concurrency change", n)
					}
					if n := s.callsOf("server.setDefaultBuildServer"); n != 0 {
						return fmt.Errorf("setDefaultBuildServer called for an unchanged default")
					}
					if n := s.callsOf("server.updateBuildsConcurrency"); n != 1 {
						return fmt.Errorf("updateBuildsConcurrency called %d times", n)
					}
					return nil
				},
			},
		},
	})
	if s.get("server", id) != nil {
		t.Errorf("server not removed by terraform destroy")
	}
	s.assertNoForbiddenCall(t)
}

// The create procedure ignores the build concurrency, the default flag and the
// command: they are applied right after, and the defaults of Dokploy are used
// when nothing is configured.
func TestServerCreateDefaults(t *testing.T) {
	s := newSrvFake(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config: providerBlock(s.URL) + `
resource "dokploy_server" "s" {
  name       = "plain"
  ip_address = "10.0.0.5"
  ssh_key_id = "key-1"
}
`,
			Check: resource.ComposeTestCheckFunc(
				resource.TestCheckResourceAttr("dokploy_server.s", "port", "22"),
				resource.TestCheckResourceAttr("dokploy_server.s", "username", "root"),
				resource.TestCheckResourceAttr("dokploy_server.s", "server_type", "deploy"),
				resource.TestCheckResourceAttr("dokploy_server.s", "enable_docker_cleanup", "true"),
				resource.TestCheckResourceAttr("dokploy_server.s", "description", ""),
				resource.TestCheckResourceAttr("dokploy_server.s", "builds_concurrency", "1"),
				resource.TestCheckResourceAttr("dokploy_server.s", "is_default_build_server", "false"),
				resource.TestCheckResourceAttr("dokploy_server.s", "server_status", "active"),
			),
		}},
	})
	if n := s.callsOf("server.update"); n != 0 {
		t.Errorf("a plain create needs no update, got %d", n)
	}
}

// ADOPTION: the servers of production (a deploy server reached through a
// Tailscale address, the default build server) are imported with the minimal
// configuration a human writes; the plan is empty and nothing is written.
func TestServerAdoptsProdShapedServers(t *testing.T) {
	s := newSrvFake(t)
	deploy := s.seed("server", srvProdDeploy())
	build := s.seed("server", srvProdBuild())
	cfg := providerBlock(s.URL) + `
import {
  to = dokploy_server.deploy
  id = "` + deploy + `"
}
import {
  to = dokploy_server.build
  id = "` + build + `"
}
resource "dokploy_server" "deploy" {
  name       = "ubuntu-8gb-fsn1-1-prd"
  ip_address = "100.127.224.66"
  port       = 2200
  username   = "deploy"
  ssh_key_id = "key-1"
}
resource "dokploy_server" "build" {
  name        = "kvincent-mac-mini-m4"
  ip_address  = "100.115.98.81"
  username    = "builder"
  ssh_key_id  = "key-2"
  server_type = "build"
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: cfg,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("dokploy_server.deploy", plancheck.ResourceActionNoop),
					plancheck.ExpectResourceAction("dokploy_server.build", plancheck.ResourceActionNoop),
				}},
				Check: resource.ComposeTestCheckFunc(
					resource.TestCheckResourceAttr("dokploy_server.build", "is_default_build_server", "true"),
					resource.TestCheckResourceAttr("dokploy_server.deploy", "app_name", "server-calculate-solid-state-bus-d7nfqy"),
					resource.TestCheckResourceAttr("dokploy_server.deploy", "server_status", "active"),
					func(st *terraform.State) error { return notInState(st, "METRICS-TOKEN-VALUE") },
				),
			},
			{
				Config:           cfg,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
		},
	})
	for _, p := range []string{"server.update", "server.create", "server.setDefaultBuildServer", "server.updateBuildsConcurrency"} {
		if n := s.callsOf(p); n != 0 {
			t.Errorf("%s called %d times while adopting", p, n)
		}
	}
	s.assertNoForbiddenCall(t)
}

// Dokploy has no procedure to unset the default build server: the one that is
// not the default anymore is cleared when another one takes over, whatever the
// order of the two updates.
func TestServerDefaultBuildServerSwitch(t *testing.T) {
	s := newSrvFake(t)
	a := s.seed("server", srvProdBuild())
	b := srvProdBuild()
	b["name"], b["ipAddress"], b["isDefaultBuildServer"] = "second-builder", "100.115.98.82", false
	bid := s.seed("server", b)
	cfg := func(aDefault, bDefault bool) string {
		return providerBlock(s.URL) + fmt.Sprintf(`
import {
  to = dokploy_server.a
  id = %q
}
import {
  to = dokploy_server.b
  id = %q
}
resource "dokploy_server" "a" {
  name                    = "kvincent-mac-mini-m4"
  ip_address              = "100.115.98.81"
  username                = "builder"
  ssh_key_id              = "key-2"
  server_type             = "build"
  is_default_build_server = %t
}
resource "dokploy_server" "b" {
  name                    = "second-builder"
  ip_address              = "100.115.98.82"
  username                = "builder"
  ssh_key_id              = "key-2"
  server_type             = "build"
  is_default_build_server = %t
}
`, a, bid, aDefault, bDefault)
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{Config: cfg(true, false)},
			{
				Config: cfg(false, true),
				Check: func(st *terraform.State) error {
					if s.get("server", a)["isDefaultBuildServer"] != false || s.get("server", bid)["isDefaultBuildServer"] != true {
						return fmt.Errorf("default build server not switched: a=%v b=%v", s.get("server", a)["isDefaultBuildServer"], s.get("server", bid)["isDefaultBuildServer"])
					}
					return nil
				},
			},
			{Config: cfg(false, true), ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}}},
		},
	})
}

// The REST facade of an instance may not expose the procedures added by the
// fork: they are then called through the raw tRPC endpoint.
func TestServerFallsBackToTRPC(t *testing.T) {
	s := newSrvFake(t)
	s.restMissing["server.updateBuildsConcurrency"] = true
	s.restMissing["server.setDefaultBuildServer"] = true
	s.seed("server", srvProdBuild()) // already the default build server
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config: providerBlock(s.URL) + `
resource "dokploy_server" "s" {
  name                    = "second"
  ip_address              = "10.1.1.1"
  ssh_key_id              = "key-2"
  server_type             = "build"
  builds_concurrency      = 5
  is_default_build_server = true
}
`,
			Check: func(st *terraform.State) error {
				o := s.get("server", idOf(st, "dokploy_server.s"))
				if asString(o["buildsConcurrency"]) != "5" || o["isDefaultBuildServer"] != true {
					return fmt.Errorf("not applied through tRPC: %v", o)
				}
				if s.callsOf("trpc/server.updateBuildsConcurrency") != 1 {
					return fmt.Errorf("tRPC fallback not used")
				}
				return nil
			},
		}},
	})
}

// A failure after the creation must not leave a server Terraform does not know.
func TestServerCreateRollsBackWhenAFollowUpFails(t *testing.T) {
	s := newSrvFake(t)
	s.failProc["server.updateBuildsConcurrency"] = true
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config: providerBlock(s.URL) + `
resource "dokploy_server" "s" {
  name               = "doomed"
  ip_address         = "10.1.1.1"
  ssh_key_id         = "key-1"
  builds_concurrency = 5
}
`,
			ExpectError: regexp.MustCompile(`forced failure of\s+server.updateBuildsConcurrency`),
		}},
	})
	if n := len(s.fakeAPI.objs["server"]); n != 0 {
		t.Errorf("%d server(s) left behind", n)
	}
}

func TestServerConfigValidation(t *testing.T) {
	s := newSrvFake(t)
	for name, tc := range map[string]struct{ body, err string }{
		"default on a deploy server": {`server_type = "deploy"
  is_default_build_server = true`, `Only a server of type build`},
		"port range":        {`port = 70000`, `between 1 and 65535`},
		"concurrency range": {`builds_concurrency = 0`, `between 1 and 100`},
		"server type":       {`server_type = "other"`, `server_type value must be one of`},
	} {
		t.Run(name, func(t *testing.T) {
			resource.UnitTest(t, resource.TestCase{
				ProtoV6ProviderFactories: factories(),
				Steps: []resource.TestStep{{
					Config: providerBlock(s.URL) + `
resource "dokploy_server" "s" {
  name       = "x"
  ip_address = "10.0.0.1"
  ssh_key_id = "key-1"
  ` + tc.body + `
}
`,
					PlanOnly:    true,
					ExpectError: regexp.MustCompile(tc.err),
				}},
			})
		})
	}
}

// A server that disappears is planned for creation again.
func TestServerRemovedOutsideTerraform(t *testing.T) {
	s := newSrvFake(t)
	cfg := providerBlock(s.URL) + `
resource "dokploy_server" "s" {
  name       = "ephemeral"
  ip_address = "10.0.0.9"
  ssh_key_id = "key-1"
}
`
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{Config: cfg, Check: func(st *terraform.State) error { id = idOf(st, "dokploy_server.s"); return nil }},
			{
				PreConfig: func() { s.fakeAPI.mu.Lock(); delete(s.fakeAPI.objs["server"], id); s.fakeAPI.mu.Unlock() },
				Config:    cfg,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("dokploy_server.s", plancheck.ResourceActionCreate),
				}},
			},
		},
	})
}
