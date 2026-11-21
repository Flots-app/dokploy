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

// ------------------------------------------------------------------ fake API

// attFake is the in-memory API with the routers of the resources attached to a
// service, answering the way the real procedures do: `<router>.delete`,
// creations that answer `true`, defaults injected by the database, mounts
// stored under one parent key per kind of service.
func attFake(t *testing.T) (*fakeAPI, *httptest.Server) {
	f, srv := newFakeAPI(t)
	f.mu.Lock()
	defer f.mu.Unlock()
	for router, key := range map[string]string{
		"domain": "domainId", "mounts": "mountId", "schedule": "scheduleId", "port": "portId",
		"redirects": "redirectId", "security": "securityId", "application": "applicationId",
	} {
		f.routes[router] = key
	}
	reply := func(w http.ResponseWriter, code int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(v)
	}
	// The input schemas of the real procedures refuse a body without these keys.
	for proc, keys := range map[string][]string{
		"domain.create": {"host"}, "domain.update": {"domainId", "host"},
		"mounts.create": {"type", "mountPath", "serviceId", "serviceType"}, "mounts.update": {"mountId"},
		"schedule.create":  {"name", "cronExpression", "command", "scheduleType"},
		"schedule.update":  {"scheduleId", "name", "cronExpression", "command", "scheduleType"},
		"port.create":      {"applicationId", "publishedPort", "targetPort", "protocol", "publishMode"},
		"port.update":      {"portId", "publishedPort", "targetPort", "protocol", "publishMode"},
		"redirects.create": {"applicationId", "regex", "replacement", "permanent"},
		"redirects.update": {"redirectId", "regex", "replacement", "permanent"},
		"security.create":  {"applicationId", "username", "password"},
		"security.update":  {"securityId", "username", "password"},
	} {
		proc, keys := proc, keys
		attChain(f, proc, func(w http.ResponseWriter, body map[string]any) bool {
			for _, k := range keys {
				if v, ok := body[k]; !ok || v == nil {
					reply(w, http.StatusBadRequest, map[string]any{"message": proc + ": " + k + " is required"})
					return true
				}
			}
			return false
		})
	}
	for _, router := range []string{"domain", "schedule", "port", "redirects", "security"} {
		router := router
		f.hooks[router+".delete"] = func(w http.ResponseWriter, body map[string]any) bool {
			id, _ := body[f.routes[router]].(string)
			if f.objs[router][id] == nil {
				reply(w, http.StatusNotFound, map[string]any{"message": "not found"})
				return true
			}
			delete(f.objs[router], id)
			reply(w, http.StatusOK, true)
			return true
		}
	}

	setDefaults := func(obj map[string]any, defaults map[string]any) {
		for k, v := range defaults {
			if _, ok := obj[k]; !ok {
				obj[k] = v
			}
		}
	}
	f.answer["domain"] = func(f *fakeAPI, obj map[string]any) any {
		setDefaults(obj, map[string]any{
			"applicationId": nil, "composeId": nil, "previewDeploymentId": nil, "serviceName": nil,
			"customCertResolver": nil, "customEntrypoint": nil, "domainType": "application",
			"path": "/", "internalPath": "/", "stripPath": false, "port": 3000, "https": false,
			"certificateType": "none", "middlewares": []any{}, "forwardAuthEnabled": false,
			"uniqueConfigKey": f.next,
		})
		return obj
	}
	f.answer["schedule"] = func(f *fakeAPI, obj map[string]any) any {
		setDefaults(obj, map[string]any{
			"applicationId": nil, "composeId": nil, "serverId": nil, "organizationId": nil, "serviceName": nil,
			"description": nil, "script": nil, "timezone": nil, "shellType": "bash", "enabled": true,
			"appName": fmt.Sprintf("schedule-test-%d", f.next),
		})
		return obj
	}
	f.answer["redirects"] = func(f *fakeAPI, obj map[string]any) any {
		setDefaults(obj, map[string]any{"uniqueConfigKey": f.next})
		return true // the real procedure answers `true`
	}
	f.answer["security"] = func(*fakeAPI, map[string]any) any { return true }

	// mounts.create takes serviceId + serviceType and stores the id under the
	// key of that kind of service, as the real service does.
	parents := map[string]string{
		"application": "applicationId", "compose": "composeId", "postgres": "postgresId", "mysql": "mysqlId",
		"mariadb": "mariadbId", "mongo": "mongoId", "redis": "redisId", "libsql": "libsqlId",
	}
	attChain(f, "mounts.create", func(w http.ResponseWriter, body map[string]any) bool {
		obj := map[string]any{}
		for _, k := range []string{"type", "hostPath", "volumeName", "filePath", "content", "mountPath", "serviceType"} {
			obj[k] = body[k]
		}
		for _, key := range parents {
			obj[key] = nil
		}
		if key, ok := parents[asString(body["serviceType"])]; ok {
			obj[key] = body["serviceId"]
		}
		f.insert("mounts", obj)
		reply(w, http.StatusOK, obj)
		return true
	})

	// application.one embeds the redirects and the basic-auth users, password
	// included, which is where the provider finds ids the create answers omit.
	f.hooks["application.one"] = func(w http.ResponseWriter, _ map[string]any) bool {
		list := func(router string) []any {
			out := []any{}
			for _, o := range f.objs[router] {
				out = append(out, o)
			}
			return out
		}
		reply(w, http.StatusOK, map[string]any{
			"applicationId": "app-1", "redirects": list("redirects"), "security": list("security"), "ports": list("port"),
		})
		return true
	}
	return f, srv
}

// attChain runs extra after the hook already registered for proc, when that one
// does not handle the request.
func attChain(f *fakeAPI, proc string, extra func(http.ResponseWriter, map[string]any) bool) {
	prev := f.hooks[proc]
	f.hooks[proc] = func(w http.ResponseWriter, body map[string]any) bool {
		if prev != nil && prev(w, body) {
			return true
		}
		return extra(w, body)
	}
}

// attGone fails when objects of a router are left in the fake API.
func attGone(f *fakeAPI, router string) resource.TestCheckFunc {
	return func(*terraform.State) error {
		f.mu.Lock()
		defer f.mu.Unlock()
		if n := len(f.objs[router]); n != 0 {
			return fmt.Errorf("%d %s left in Dokploy after destroy; calls: %v", n, router, f.calls)
		}
		return nil
	}
}

// attNoWrites fails when the API received any create / update / delete of a
// router: an adoption must only read.
func attNoWrites(f *fakeAPI, router string) resource.TestCheckFunc {
	return func(*terraform.State) error {
		for _, op := range []string{"create", "update", "delete", "remove"} {
			if n := f.called(router + "." + op); n != 0 {
				return fmt.Errorf("%s.%s was called %d time(s) while adopting", router, op, n)
			}
		}
		return nil
	}
}

// attImport builds an import block for a resource address and an id.
func attImport(addr, id string) string {
	return fmt.Sprintf("import {\n  to = %s\n  id = %q\n}\n", addr, id)
}

var attEmptyPlan = resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}}

func attAction(addr string, a plancheck.ResourceActionType) resource.ConfigPlanChecks {
	return resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectResourceAction(addr, a)}}
}

func attExpect(addr, attr string, c knownvalue.Check) statecheck.StateCheck {
	return statecheck.ExpectKnownValue(addr, tfjsonpath.New(attr), c)
}

// attWant fails when an attribute of a fake API object differs.
func attWant(f *fakeAPI, router, id string, want map[string]any) error {
	obj := f.get(router, id)
	if obj == nil {
		return fmt.Errorf("%s %s not found in Dokploy", router, id)
	}
	for k, v := range want {
		if fmt.Sprint(obj[k]) != fmt.Sprint(v) {
			return fmt.Errorf("%s %s: %s is %v, want %v", router, id, k, obj[k], v)
		}
	}
	return nil
}

// ------------------------------------------------------------------- domains

func TestAttachDomainLifecycle(t *testing.T) {
	f, srv := attFake(t)
	app := func(extra string) string {
		return providerBlock(srv.URL) + `
resource "dokploy_domain" "d" {
  application_id = "app-1"
` + extra + `
}
`
	}
	const addr = "dokploy_domain.d"
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		CheckDestroy:             attGone(f, "domain"),
		Steps: []resource.TestStep{
			{
				Config: app(`
  host             = "app.example.test"
  port             = 8080
  https            = true
  certificate_type = "letsencrypt"
`),
				ConfigStateChecks: []statecheck.StateCheck{
					// Whatever is left out adopts what Dokploy reports.
					attExpect(addr, "domain_type", knownvalue.StringExact("application")),
					attExpect(addr, "path", knownvalue.StringExact("/")),
					attExpect(addr, "internal_path", knownvalue.StringExact("/")),
					attExpect(addr, "strip_path", knownvalue.Bool(false)),
					attExpect(addr, "middlewares", knownvalue.ListSizeExact(0)),
					attExpect(addr, "compose_id", knownvalue.Null()),
				},
				Check: func(s *terraform.State) error {
					id = idOf(s, addr)
					return attWant(f, "domain", id, map[string]any{
						"host": "app.example.test", "port": 8080, "https": true, "certificateType": "letsencrypt",
						"applicationId": "app-1", "domainType": "application",
					})
				},
			},
			{
				Config: app(`
  host                 = "api.example.test"
  port                 = 8080
  https                = true
  certificate_type     = "letsencrypt"
  path                 = "/v1"
  internal_path        = "/internal"
  strip_path           = true
  middlewares          = ["basic-auth@file", "ratelimit@file"]
  forward_auth_enabled = true
`),
				ConfigPlanChecks: attAction(addr, plancheck.ResourceActionUpdate),
				Check: func(*terraform.State) error {
					return attWant(f, "domain", id, map[string]any{
						"host": "api.example.test", "path": "/v1", "internalPath": "/internal", "stripPath": true,
						"forwardAuthEnabled": true, "middlewares": "[basic-auth@file ratelimit@file]",
					})
				},
			},
			{ResourceName: addr, ImportState: true, ImportStateVerify: true},
		},
	})
}

func TestAttachDomainComposeInfersType(t *testing.T) {
	f, srv := attFake(t)
	cfg := func(compose string) string {
		return providerBlock(srv.URL) + `
resource "dokploy_domain" "d" {
  compose_id   = "` + compose + `"
  service_name = "backend"
  host         = "api.example.test"
  port         = 8080
}
`
	}
	const addr = "dokploy_domain.d"
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		CheckDestroy:             attGone(f, "domain"),
		Steps: []resource.TestStep{
			{
				Config: cfg("compose-1"),
				// domain.create defaults domainType to application: the provider
				// must send compose itself.
				ConfigStateChecks: []statecheck.StateCheck{attExpect(addr, "domain_type", knownvalue.StringExact("compose"))},
				Check: func(s *terraform.State) error {
					id = idOf(s, addr)
					return attWant(f, "domain", id, map[string]any{"composeId": "compose-1", "domainType": "compose", "serviceName": "backend"})
				},
			},
			{
				// The parent cannot move: another compose replaces the domain.
				Config:           cfg("compose-2"),
				ConfigPlanChecks: attAction(addr, plancheck.ResourceActionReplace),
				Check: func(s *terraform.State) error {
					if idOf(s, addr) == id {
						return fmt.Errorf("the domain was not replaced")
					}
					id = idOf(s, addr)
					return attWant(f, "domain", id, map[string]any{"composeId": "compose-2"})
				},
			},
			{
				// Moving the domain to an application replaces it too, and the type
				// follows the new parent instead of the one in the old state.
				Config: providerBlock(srv.URL) + `
resource "dokploy_domain" "d" {
  application_id = "app-1"
  host           = "api.example.test"
}
`,
				ConfigPlanChecks: attAction(addr, plancheck.ResourceActionReplace),
				ConfigStateChecks: []statecheck.StateCheck{
					attExpect(addr, "domain_type", knownvalue.StringExact("application")),
					attExpect(addr, "service_name", knownvalue.Null()),
				},
				Check: func(s *terraform.State) error {
					if idOf(s, addr) == id {
						return fmt.Errorf("the domain was not replaced")
					}
					return attWant(f, "domain", idOf(s, addr), map[string]any{"applicationId": "app-1", "composeId": nil, "domainType": "application"})
				},
			},
		},
	})
}

// The parent ids usually come from another resource: unknown while the
// configuration is validated and planned, which must neither trip the
// "exactly one parent" checks nor the ForceNew attributes.
func TestAttachParentIdsComputedElsewhere(t *testing.T) {
	f, srv := attFake(t)
	cfg := providerBlock(srv.URL) + `
resource "dokploy_project" "p" {
  name = "parent"
}

resource "dokploy_domain" "d" {
  compose_id   = dokploy_project.p.id
  service_name = "web"
  host         = "web.example.test"
}

resource "dokploy_mount" "m" {
  service_id   = dokploy_project.p.id
  service_type = "redis"
  type         = "volume"
  mount_path   = "/data"
  volume_name  = "data-${dokploy_project.p.id}"
}

resource "dokploy_schedule" "s" {
  schedule_type   = "compose"
  compose_id      = dokploy_project.p.id
  service_name    = "web"
  name            = "tick"
  cron_expression = "* * * * *"
  command         = "true"
}

resource "dokploy_port" "port" {
  application_id = dokploy_project.p.id
  published_port = 8443
  target_port    = 443
}

resource "dokploy_redirect" "r" {
  application_id = dokploy_project.p.id
  regex          = "^/a"
  replacement    = "/b"
}

resource "dokploy_security" "u" {
  application_id = dokploy_project.p.id
  username       = "carol"
  password_wo    = "carol-fixture"
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: cfg,
				Check: func(s *terraform.State) error {
					parent := idOf(s, "dokploy_project.p")
					for _, c := range []struct{ addr, router, key string }{
						{"dokploy_domain.d", "domain", "composeId"}, {"dokploy_mount.m", "mounts", "redisId"},
						{"dokploy_schedule.s", "schedule", "composeId"}, {"dokploy_port.port", "port", "applicationId"},
						{"dokploy_redirect.r", "redirects", "applicationId"}, {"dokploy_security.u", "security", "applicationId"},
					} {
						if err := attWant(f, c.router, idOf(s, c.addr), map[string]any{c.key: parent}); err != nil {
							return err
						}
					}
					return notInState(s, "carol-fixture")
				},
			},
			{Config: cfg, ConfigPlanChecks: attEmptyPlan},
		},
	})
}

func TestAttachDomainValidation(t *testing.T) {
	_, srv := attFake(t)
	cfg := func(body string) string {
		return providerBlock(srv.URL) + "resource \"dokploy_domain\" \"d\" {\n" + body + "\n}\n"
	}
	cases := []struct{ name, body, want string }{
		{"two parents", `host = "a.example.test"
application_id = "app-1"
compose_id = "compose-1"
service_name = "web"`, `Exactly one parent is required`},
		{"no parent", `host = "a.example.test"`, `Exactly one parent is required`},
		{"compose without service", `host = "a.example.test"
compose_id = "compose-1"`, `Service name required`},
		{"type without its parent", `host = "a.example.test"
application_id = "app-1"
domain_type = "compose"`, `Parent id missing`},
		{"custom certificate without resolver", `host = "a.example.test"
application_id = "app-1"
https = true
certificate_type = "custom"`, `Certificate resolver required`},
		{"unknown certificate type", `host = "a.example.test"
application_id = "app-1"
certificate_type = "acme"`, `Invalid Attribute Value Match`},
	}
	var steps []resource.TestStep
	for _, c := range cases {
		steps = append(steps, resource.TestStep{Config: cfg(c.body), PlanOnly: true, ExpectError: regexp.MustCompile(c.want)})
	}
	resource.UnitTest(t, resource.TestCase{ProtoV6ProviderFactories: factories(), Steps: steps})
}

func TestAttachDomainRemovedOutsideTerraform(t *testing.T) {
	f, srv := attFake(t)
	cfg := providerBlock(srv.URL) + `
resource "dokploy_domain" "d" {
  application_id = "app-1"
  host           = "gone.example.test"
}
`
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{Config: cfg, Check: func(s *terraform.State) error { id = idOf(s, "dokploy_domain.d"); return nil }},
			{
				PreConfig:        func() { f.mu.Lock(); delete(f.objs["domain"], id); f.mu.Unlock() },
				Config:           cfg,
				ConfigPlanChecks: attAction("dokploy_domain.d", plancheck.ResourceActionCreate),
			},
		},
	})
}

// attProdDomain is a domain as domain.one returns it in production (trimmed to
// the keys of the table), host and parent set by the caller.
func attProdDomain(over map[string]any) map[string]any {
	d := map[string]any{
		"applicationId": nil, "composeId": nil, "previewDeploymentId": nil, "serviceName": nil,
		"certificateType": "letsencrypt", "customCertResolver": nil, "customEntrypoint": nil,
		"domainType": "compose", "forwardAuthEnabled": false, "https": true, "internalPath": "/",
		"middlewares": []any{}, "path": "/", "port": 8080, "stripPath": false,
		"uniqueConfigKey": 13, "application": nil, "createdAt": "2025-06-11T11:34:10.161Z",
	}
	for k, v := range over {
		d[k] = v
	}
	return d
}

// Adoption: three production domains (api.flots.app and mcp-europa.flots.app of
// the compose stacks, flots.app of the website application) are imported with the
// configuration a person would write, and the plan must stay empty.
func TestAttachDomainAdoption(t *testing.T) {
	f, srv := attFake(t)
	api := f.seed("domain", attProdDomain(map[string]any{
		"composeId": "RsQUtixvesryzf1ZpLwkT", "serviceName": "backend", "host": "api.flots.app", "uniqueConfigKey": 13,
	}))
	mcp := f.seed("domain", attProdDomain(map[string]any{
		"composeId": "H7EJhQY3TaxGJn7W8Ucxz", "serviceName": "backend-staging", "host": "mcp-europa.flots.app",
		"internalPath": "", "uniqueConfigKey": 42,
	}))
	www := f.seed("domain", attProdDomain(map[string]any{
		"applicationId": "bHn5talQhJsSYMyHl1T7t", "domainType": "application", "host": "flots.app", "port": 3000, "uniqueConfigKey": 36,
	}))
	cfg := providerBlock(srv.URL) + attImport("dokploy_domain.api", api) + attImport("dokploy_domain.mcp", mcp) + attImport("dokploy_domain.www", www) + `
# Everything the person cares about, spelled out.
resource "dokploy_domain" "api" {
  compose_id       = "RsQUtixvesryzf1ZpLwkT"
  service_name     = "backend"
  host             = "api.flots.app"
  port             = 8080
  https            = true
  certificate_type = "letsencrypt"
}

# The bare minimum: the rest adopts what Dokploy has (path, internal_path "",
# no middleware, ...).
resource "dokploy_domain" "mcp" {
  compose_id   = "H7EJhQY3TaxGJn7W8Ucxz"
  service_name = "backend-staging"
  host         = "mcp-europa.flots.app"
}

resource "dokploy_domain" "www" {
  application_id = "bHn5talQhJsSYMyHl1T7t"
  host           = "flots.app"
  port           = 3000
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config:           cfg,
				ConfigPlanChecks: attEmptyPlan,
				Check: resource.ComposeTestCheckFunc(
					attNoWrites(f, "domain"),
					resource.TestCheckResourceAttr("dokploy_domain.mcp", "internal_path", ""),
					resource.TestCheckResourceAttr("dokploy_domain.mcp", "unique_config_key", "42"),
					resource.TestCheckResourceAttr("dokploy_domain.www", "domain_type", "application"),
					resource.TestCheckNoResourceAttr("dokploy_domain.www", "service_name"),
				),
			},
			{Config: cfg, ConfigPlanChecks: attEmptyPlan, Check: attNoWrites(f, "domain")},
		},
	})
}

// ------------------------------------------------------------------- mounts

func TestAttachMountLifecycle(t *testing.T) {
	f, srv := attFake(t)
	var updates []map[string]any
	attChain(f, "mounts.update", func(_ http.ResponseWriter, body map[string]any) bool {
		updates = append(updates, body)
		return false
	})
	cfg := func(body string) string {
		return providerBlock(srv.URL) + "resource \"dokploy_mount\" \"m\" {\n" + body + "\n}\n"
	}
	const addr = "dokploy_mount.m"
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		CheckDestroy:             attGone(f, "mounts"),
		Steps: []resource.TestStep{
			{
				Config: cfg(`
  service_id   = "postgres-1"
  service_type = "postgres"
  type         = "volume"
  mount_path   = "/var/lib/postgresql/data"
  volume_name  = "db-data"
`),
				ConfigStateChecks: []statecheck.StateCheck{
					attExpect(addr, "service_id", knownvalue.StringExact("postgres-1")),
					attExpect(addr, "host_path", knownvalue.Null()),
				},
				Check: func(s *terraform.State) error {
					id = idOf(s, addr)
					// mounts.create files the parent under the key of its kind.
					return attWant(f, "mounts", id, map[string]any{"postgresId": "postgres-1", "applicationId": nil, "serviceType": "postgres", "volumeName": "db-data"})
				},
			},
			{
				Config: cfg(`
  service_id   = "postgres-1"
  service_type = "postgres"
  type         = "volume"
  mount_path   = "/data"
  volume_name  = "db-data-2"
`),
				ConfigPlanChecks: attAction(addr, plancheck.ResourceActionUpdate),
				Check: func(*terraform.State) error {
					if len(updates) != 1 {
						return fmt.Errorf("%d updates, want 1", len(updates))
					}
					for _, k := range []string{"serviceId", "serviceType", "postgresId", "applicationId"} {
						if _, ok := updates[0][k]; ok {
							return fmt.Errorf("mounts.update received the parent key %s", k)
						}
					}
					return attWant(f, "mounts", id, map[string]any{"mountPath": "/data", "volumeName": "db-data-2", "postgresId": "postgres-1"})
				},
			},
			{ResourceName: addr, ImportState: true, ImportStateVerify: true},
			{
				// Another service replaces the mount.
				Config: cfg(`
  service_id   = "postgres-2"
  service_type = "postgres"
  type         = "volume"
  mount_path   = "/data"
  volume_name  = "db-data-2"
`),
				ConfigPlanChecks: attAction(addr, plancheck.ResourceActionReplace),
			},
		},
	})
}

func TestAttachMountFile(t *testing.T) {
	f, srv := attFake(t)
	cfg := func(content string) string {
		return providerBlock(srv.URL) + `
resource "dokploy_mount" "m" {
  service_id   = "compose-1"
  service_type = "compose"
  type         = "file"
  mount_path   = "/etc/app/app.conf"
  file_path    = "conf/app.conf"
  content      = "` + content + `"
}
`
	}
	const addr = "dokploy_mount.m"
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		CheckDestroy:             attGone(f, "mounts"),
		Steps: []resource.TestStep{
			{
				Config: cfg("listen = 1"),
				Check: func(s *terraform.State) error {
					id = idOf(s, addr)
					return attWant(f, "mounts", id, map[string]any{"composeId": "compose-1", "filePath": "conf/app.conf", "content": "listen = 1"})
				},
			},
			{
				Config: cfg("listen = 2"),
				Check:  func(*terraform.State) error { return attWant(f, "mounts", id, map[string]any{"content": "listen = 2"}) },
			},
			{ResourceName: addr, ImportState: true, ImportStateVerify: true, ImportStateVerifyIgnore: []string{"content"}},
		},
	})
}

func TestAttachMountValidation(t *testing.T) {
	_, srv := attFake(t)
	cfg := func(body string) string {
		return providerBlock(srv.URL) + `
resource "dokploy_mount" "m" {
  service_id   = "app-1"
  service_type = "application"
  mount_path   = "/data"
` + body + "\n}\n"
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{Config: cfg(`type = "volume"`), PlanOnly: true, ExpectError: regexp.MustCompile(`Attribute required`)},
			{Config: cfg(`type = "bind"`), PlanOnly: true, ExpectError: regexp.MustCompile(`Attribute required`)},
			{Config: cfg(`type = "file"`), PlanOnly: true, ExpectError: regexp.MustCompile(`Attribute required`)},
			{Config: cfg(`type = "tmpfs"`), PlanOnly: true, ExpectError: regexp.MustCompile(`Invalid Attribute Value Match`)},
		},
	})
}

// attProdMount is a mount as mounts.one returns it in production: one key per
// kind of service, and the service itself nested.
func attProdMount(kind, serviceID, mountPath, volume string) map[string]any {
	m := map[string]any{
		"applicationId": nil, "composeId": nil, "libsqlId": nil, "mariadbId": nil, "mongoId": nil,
		"mysqlId": nil, "postgresId": nil, "redisId": nil,
		"content": nil, "filePath": nil, "hostPath": nil,
		"mountPath": mountPath, "serviceType": kind, "type": "volume", "volumeName": volume,
		"postgres": nil, "redis": nil,
	}
	m[kind+"Id"] = serviceID
	m[kind] = map[string]any{"appName": "svc-" + kind, "environment": map[string]any{"project": map[string]any{"name": "Production"}}}
	return m
}

// Adoption: the volumes of the production Postgres and Redis, whose mounts have
// no serviceId in the answer.
func TestAttachMountAdoption(t *testing.T) {
	f, srv := attFake(t)
	pg := f.seed("mounts", attProdMount("postgres", "2Wi1lNgawg6VqxFAZai9m", "/var/lib/postgresql/data", "db-pxkqib-data"))
	rd := f.seed("mounts", attProdMount("redis", "m4u7ZLHkQ_O2CloiG6SzN", "/data", "app-redis01backend-r0d8n4-data"))
	cfg := providerBlock(srv.URL) + attImport("dokploy_mount.pg", pg) + attImport("dokploy_mount.rd", rd) + `
resource "dokploy_mount" "pg" {
  service_id   = "2Wi1lNgawg6VqxFAZai9m"
  service_type = "postgres"
  type         = "volume"
  mount_path   = "/var/lib/postgresql/data"
  volume_name  = "db-pxkqib-data"
}

resource "dokploy_mount" "rd" {
  service_id   = "m4u7ZLHkQ_O2CloiG6SzN"
  service_type = "redis"
  type         = "volume"
  mount_path   = "/data"
  volume_name  = "app-redis01backend-r0d8n4-data"
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config:           cfg,
				ConfigPlanChecks: attEmptyPlan,
				Check: resource.ComposeTestCheckFunc(
					attNoWrites(f, "mounts"),
					resource.TestCheckResourceAttr("dokploy_mount.pg", "service_id", "2Wi1lNgawg6VqxFAZai9m"),
					resource.TestCheckNoResourceAttr("dokploy_mount.pg", "host_path"),
				),
			},
			{Config: cfg, ConfigPlanChecks: attEmptyPlan, Check: attNoWrites(f, "mounts")},
		},
	})
}

// ----------------------------------------------------------------- schedules

func TestAttachScheduleLifecycle(t *testing.T) {
	f, srv := attFake(t)
	cfg := func(body string) string {
		return providerBlock(srv.URL) + "resource \"dokploy_schedule\" \"s\" {\n" + body + "\n}\n"
	}
	const addr = "dokploy_schedule.s"
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		CheckDestroy:             attGone(f, "schedule"),
		Steps: []resource.TestStep{
			{
				Config: cfg(`
  schedule_type   = "compose"
  compose_id      = "compose-1"
  service_name    = "backend"
  name            = "Clean up"
  cron_expression = "0 2 * * *"
  command         = "node clean.js"
`),
				ConfigStateChecks: []statecheck.StateCheck{
					attExpect(addr, "enabled", knownvalue.Bool(true)),
					attExpect(addr, "shell_type", knownvalue.StringExact("bash")),
					attExpect(addr, "timezone", knownvalue.Null()),
				},
				Check: func(s *terraform.State) error {
					id = idOf(s, addr)
					return attWant(f, "schedule", id, map[string]any{"scheduleType": "compose", "composeId": "compose-1", "serviceName": "backend", "cronExpression": "0 2 * * *"})
				},
			},
			{
				Config: cfg(`
  schedule_type   = "compose"
  compose_id      = "compose-1"
  service_name    = "backend"
  name            = "Clean up"
  cron_expression = "*/15 * * * *"
  command         = "node clean.js --fast"
  shell_type      = "sh"
  timezone        = "Europe/Paris"
  enabled         = false
`),
				ConfigPlanChecks: attAction(addr, plancheck.ResourceActionUpdate),
				Check: func(*terraform.State) error {
					return attWant(f, "schedule", id, map[string]any{
						"cronExpression": "*/15 * * * *", "command": "node clean.js --fast", "shellType": "sh",
						"timezone": "Europe/Paris", "enabled": false, "scheduleType": "compose",
					})
				},
			},
			{ResourceName: addr, ImportState: true, ImportStateVerify: true},
		},
	})
}

func TestAttachScheduleHostScript(t *testing.T) {
	f, srv := attFake(t)
	cfg := func(script string) string {
		return providerBlock(srv.URL) + `
resource "dokploy_schedule" "s" {
  schedule_type   = "dokploy-server"
  name            = "Prune"
  cron_expression = "0 4 * * 0"
  command         = "prune"
  script          = <<-EOT
    ` + script + `
  EOT
}

resource "dokploy_schedule" "remote" {
  schedule_type   = "server"
  server_id       = "server-1"
  name            = "Rotate logs"
  cron_expression = "0 5 * * *"
  command         = "logrotate"
  script          = "logrotate -f /etc/logrotate.conf"
}
`
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		CheckDestroy:             attGone(f, "schedule"),
		Steps: []resource.TestStep{
			{
				Config: cfg("docker system prune -f"),
				Check: func(s *terraform.State) error {
					if err := attWant(f, "schedule", idOf(s, "dokploy_schedule.s"), map[string]any{"scheduleType": "dokploy-server", "composeId": nil, "applicationId": nil, "serverId": nil}); err != nil {
						return err
					}
					return attWant(f, "schedule", idOf(s, "dokploy_schedule.remote"), map[string]any{"scheduleType": "server", "serverId": "server-1"})
				},
			},
			{Config: cfg("docker system prune -af"), ConfigPlanChecks: attAction("dokploy_schedule.s", plancheck.ResourceActionUpdate)},
			{ResourceName: "dokploy_schedule.s", ImportState: true, ImportStateVerify: true, ImportStateVerifyIgnore: []string{"script"}},
			{ResourceName: "dokploy_schedule.remote", ImportState: true, ImportStateVerify: true, ImportStateVerifyIgnore: []string{"script"}},
		},
	})
}

func TestAttachScheduleValidation(t *testing.T) {
	_, srv := attFake(t)
	cfg := func(body string) string {
		return providerBlock(srv.URL) + `
resource "dokploy_schedule" "s" {
  name            = "x"
  cron_expression = "* * * * *"
  command         = "true"
` + body + "\n}\n"
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{Config: cfg(`schedule_type = "compose"`), PlanOnly: true, ExpectError: regexp.MustCompile(`Parent id required`)},
			{Config: cfg("schedule_type = \"application\"\napplication_id = \"a\"\ncompose_id = \"c\""), PlanOnly: true, ExpectError: regexp.MustCompile(`Unexpected parent id`)},
			{Config: cfg("schedule_type = \"dokploy-server\"\nserver_id = \"s\""), PlanOnly: true, ExpectError: regexp.MustCompile(`Unexpected parent id`)},
			{Config: cfg(`schedule_type = "weekly"`), PlanOnly: true, ExpectError: regexp.MustCompile(`Invalid Attribute Value Match`)},
		},
	})
}

// attProdSchedule is a schedule as schedule.one returns it in production for
// the compose "monorepo": shell sh, disabled, empty script. The commands of the
// redacted sample are stand-ins.
func attProdSchedule(name, cron, command string) map[string]any {
	return map[string]any{
		"appName": "schedule-" + strings.ToLower(strings.ReplaceAll(name, " ", "-")), "application": nil, "applicationId": nil,
		"command": command, "composeId": "RsQUtixvesryzf1ZpLwkT", "createdAt": "2025-08-17T16:11:44.267Z",
		"cronExpression": cron, "description": nil, "enabled": false, "name": name, "organizationId": nil,
		"scheduleType": "compose", "script": "", "server": nil, "serverId": nil, "serviceName": "backend",
		"shellType": "sh", "timezone": nil,
		"compose": map[string]any{"composeId": "RsQUtixvesryzf1ZpLwkT", "appName": "monorepo", "environment": map[string]any{"project": map[string]any{"name": "Flots"}}},
	}
}

// Adoption: the three schedules of the production compose, imported with minimal
// configurations, and one with every attribute spelled out.
func TestAttachScheduleAdoption(t *testing.T) {
	f, srv := attFake(t)
	date := f.seed("schedule", attProdSchedule("Emit Task Date Update", "0 0 * * *", "node dist/emit-date.js"))
	notif := f.seed("schedule", attProdSchedule("Emit Task Notification", "*/15 * * * *", "node dist/emit-notification.js"))
	clean := f.seed("schedule", attProdSchedule("Clean up expiration verification code email", "0 2 * * *", "node dist/clean-codes.js"))
	cfg := providerBlock(srv.URL) + attImport("dokploy_schedule.date", date) + attImport("dokploy_schedule.notif", notif) + attImport("dokploy_schedule.clean", clean) + `
resource "dokploy_schedule" "date" {
  schedule_type   = "compose"
  compose_id      = "RsQUtixvesryzf1ZpLwkT"
  service_name    = "backend"
  name            = "Emit Task Date Update"
  cron_expression = "0 0 * * *"
  command         = "node dist/emit-date.js"
}

resource "dokploy_schedule" "notif" {
  schedule_type   = "compose"
  compose_id      = "RsQUtixvesryzf1ZpLwkT"
  service_name    = "backend"
  name            = "Emit Task Notification"
  cron_expression = "*/15 * * * *"
  command         = "node dist/emit-notification.js"
  shell_type      = "sh"
  enabled         = false
}

resource "dokploy_schedule" "clean" {
  schedule_type   = "compose"
  compose_id      = "RsQUtixvesryzf1ZpLwkT"
  service_name    = "backend"
  name            = "Clean up expiration verification code email"
  cron_expression = "0 2 * * *"
  command         = "node dist/clean-codes.js"
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config:           cfg,
				ConfigPlanChecks: attEmptyPlan,
				Check: resource.ComposeTestCheckFunc(
					attNoWrites(f, "schedule"),
					resource.TestCheckResourceAttr("dokploy_schedule.date", "enabled", "false"),
					resource.TestCheckResourceAttr("dokploy_schedule.date", "shell_type", "sh"),
					resource.TestCheckNoResourceAttr("dokploy_schedule.date", "timezone"),
				),
			},
			{Config: cfg, ConfigPlanChecks: attEmptyPlan, Check: attNoWrites(f, "schedule")},
		},
	})
}

// ---------------------------------------------------------------------- ports

func TestAttachPortLifecycle(t *testing.T) {
	f, srv := attFake(t)
	cfg := func(body string) string {
		return providerBlock(srv.URL) + "resource \"dokploy_port\" \"p\" {\n  application_id = \"app-1\"\n" + body + "\n}\n"
	}
	const addr = "dokploy_port.p"
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		CheckDestroy:             attGone(f, "port"),
		Steps: []resource.TestStep{
			{
				Config: cfg("published_port = 5432\ntarget_port = 5432"),
				ConfigStateChecks: []statecheck.StateCheck{
					attExpect(addr, "protocol", knownvalue.StringExact("tcp")),
					attExpect(addr, "publish_mode", knownvalue.StringExact("ingress")),
				},
				Check: func(s *terraform.State) error {
					id = idOf(s, addr)
					return attWant(f, "port", id, map[string]any{"publishedPort": 5432, "targetPort": 5432, "protocol": "tcp", "publishMode": "ingress", "applicationId": "app-1"})
				},
			},
			{
				Config:           cfg("published_port = 5433\ntarget_port = 5432\nprotocol = \"udp\"\npublish_mode = \"host\""),
				ConfigPlanChecks: attAction(addr, plancheck.ResourceActionUpdate),
				Check: func(*terraform.State) error {
					return attWant(f, "port", id, map[string]any{"publishedPort": 5433, "protocol": "udp", "publishMode": "host"})
				},
			},
			{ResourceName: addr, ImportState: true, ImportStateVerify: true},
		},
	})
}

// port.one answers HTTP 400 "Port not found" instead of 404: a port removed in
// Dokploy must be planned for creation, not fail the refresh.
func TestAttachPortRemovedOutsideTerraform(t *testing.T) {
	f, srv := attFake(t)
	attChain(f, "port.one", func(w http.ResponseWriter, _ map[string]any) bool {
		if len(f.objs["port"]) != 0 {
			return false
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"message":"Port not found"}`))
		return true
	})
	cfg := providerBlock(srv.URL) + `
resource "dokploy_port" "p" {
  application_id = "app-1"
  published_port = 9000
  target_port    = 9000
}
`
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{Config: cfg, Check: func(s *terraform.State) error { id = idOf(s, "dokploy_port.p"); return nil }},
			{
				PreConfig:        func() { f.mu.Lock(); delete(f.objs["port"], id); f.mu.Unlock() },
				Config:           cfg,
				ConfigPlanChecks: attAction("dokploy_port.p", plancheck.ResourceActionCreate),
			},
		},
	})
}

func TestAttachPortAdoption(t *testing.T) {
	f, srv := attFake(t)
	id := f.seed("port", map[string]any{
		"applicationId": "bHn5talQhJsSYMyHl1T7t", "publishedPort": 5432, "targetPort": 5432, "protocol": "tcp", "publishMode": "host",
		"application": map[string]any{"appName": "website"},
	})
	cfg := providerBlock(srv.URL) + attImport("dokploy_port.p", id) + `
resource "dokploy_port" "p" {
  application_id = "bHn5talQhJsSYMyHl1T7t"
  published_port = 5432
  target_port    = 5432
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{Config: cfg, ConfigPlanChecks: attEmptyPlan, Check: resource.ComposeTestCheckFunc(
				attNoWrites(f, "port"),
				// Left out, the mode adopts what the object has.
				resource.TestCheckResourceAttr("dokploy_port.p", "publish_mode", "host"),
			)},
			{Config: cfg, ConfigPlanChecks: attEmptyPlan},
		},
	})
}

// ------------------------------------------------------------------ redirects

func TestAttachRedirectLifecycle(t *testing.T) {
	f, srv := attFake(t)
	cfg := func(body string) string {
		return providerBlock(srv.URL) + "resource \"dokploy_redirect\" \"r\" {\n  application_id = \"app-1\"\n" + body + "\n}\n"
	}
	const addr = "dokploy_redirect.r"
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		CheckDestroy:             attGone(f, "redirects"),
		Steps: []resource.TestStep{
			{
				Config: cfg(`
  regex       = "^https://old.example.test/(.*)"
  replacement = "https://new.example.test/$${1}"
`),
				ConfigStateChecks: []statecheck.StateCheck{attExpect(addr, "permanent", knownvalue.Bool(false))},
				Check: func(s *terraform.State) error {
					id = idOf(s, addr)
					return attWant(f, "redirects", id, map[string]any{"regex": "^https://old.example.test/(.*)", "replacement": "https://new.example.test/${1}", "permanent": false, "applicationId": "app-1"})
				},
			},
			{
				Config: cfg(`
  regex       = "^https://old.example.test/(.*)"
  replacement = "https://other.example.test/$${1}"
  permanent   = true
`),
				ConfigPlanChecks: attAction(addr, plancheck.ResourceActionUpdate),
				Check: func(*terraform.State) error {
					return attWant(f, "redirects", id, map[string]any{"replacement": "https://other.example.test/${1}", "permanent": true})
				},
			},
			{ResourceName: addr, ImportState: true, ImportStateVerify: true},
		},
	})
}

// redirects.create answers `true`: two identical redirects created in parallel
// must still end up with two different ids.
func TestAttachRedirectIdenticalTwins(t *testing.T) {
	f, srv := attFake(t)
	cfg := providerBlock(srv.URL) + `
resource "dokploy_redirect" "a" {
  application_id = "app-1"
  regex          = "^/old"
  replacement    = "/new"
}

resource "dokploy_redirect" "b" {
  application_id = "app-1"
  regex          = "^/old"
  replacement    = "/new"
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		CheckDestroy:             attGone(f, "redirects"),
		Steps: []resource.TestStep{{
			Config: cfg,
			Check: func(s *terraform.State) error {
				a, b := idOf(s, "dokploy_redirect.a"), idOf(s, "dokploy_redirect.b")
				if a == "" || b == "" || a == b {
					return fmt.Errorf("redirect ids %q and %q must be distinct", a, b)
				}
				f.mu.Lock()
				n := len(f.objs["redirects"])
				f.mu.Unlock()
				if n != 2 {
					return fmt.Errorf("%d redirects in Dokploy, want 2", n)
				}
				return nil
			},
		}},
	})
}

func TestAttachRedirectAdoption(t *testing.T) {
	f, srv := attFake(t)
	id := f.seed("redirects", map[string]any{
		"applicationId": "bHn5talQhJsSYMyHl1T7t", "regex": "^https://www.flots.app/(.*)", "replacement": "https://flots.app/${1}",
		"permanent": true, "uniqueConfigKey": 4,
	})
	cfg := providerBlock(srv.URL) + attImport("dokploy_redirect.r", id) + `
resource "dokploy_redirect" "r" {
  application_id = "bHn5talQhJsSYMyHl1T7t"
  regex          = "^https://www.flots.app/(.*)"
  replacement    = "https://flots.app/$${1}"
  permanent      = true
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{Config: cfg, ConfigPlanChecks: attEmptyPlan, Check: attNoWrites(f, "redirects")},
			{Config: cfg, ConfigPlanChecks: attEmptyPlan},
		},
	})
}

// ------------------------------------------------------------------- security

func TestAttachSecurityLifecycleAndSecrets(t *testing.T) {
	f, srv := attFake(t)
	cfg := func(body string) string {
		return providerBlock(srv.URL) + "resource \"dokploy_security\" \"u\" {\n  application_id = \"app-1\"\n" + body + "\n}\n"
	}
	const addr = "dokploy_security.u"
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		CheckDestroy:             attGone(f, "security"),
		Steps: []resource.TestStep{
			{
				Config:            cfg("username = \"alice\"\npassword_wo = \"first-fixture\"\nsecrets_version = 1"),
				ConfigStateChecks: []statecheck.StateCheck{attExpect(addr, "password_wo", knownvalue.Null())},
				Check: func(s *terraform.State) error {
					id = idOf(s, addr)
					if err := attWant(f, "security", id, map[string]any{"username": "alice", "password": "first-fixture", "applicationId": "app-1"}); err != nil {
						return err
					}
					return notInState(s, "first-fixture")
				},
			},
			{
				// Nothing changed: the secret is neither read nor re-sent.
				Config:           cfg("username = \"alice\"\npassword_wo = \"first-fixture\"\nsecrets_version = 1"),
				ConfigPlanChecks: attEmptyPlan,
			},
			{
				// A rotation needs the new value and a new version.
				Config: cfg("username = \"alice\"\npassword_wo = \"second-fixture\"\nsecrets_version = 2"),
				Check: func(s *terraform.State) error {
					if err := attWant(f, "security", id, map[string]any{"password": "second-fixture"}); err != nil {
						return err
					}
					return notInState(s, "second-fixture")
				},
			},
			{
				// A rename without the password in the configuration keeps the
				// current one (security.update insists on it).
				Config: cfg("username = \"bob\""),
				Check: func(s *terraform.State) error {
					return attWant(f, "security", id, map[string]any{"username": "bob", "password": "second-fixture"})
				},
			},
			{ResourceName: addr, ImportState: true, ImportStateVerify: true, ImportStateVerifyIgnore: []string{"secrets_version"}},
		},
	})
}

func TestAttachSecurityNeedsPasswordOnCreate(t *testing.T) {
	_, srv := attFake(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config: providerBlock(srv.URL) + `
resource "dokploy_security" "u" {
  application_id = "app-1"
  username       = "alice"
}
`,
			ExpectError: regexp.MustCompile(`password_wo is required`),
		}},
	})
}

func TestAttachSecurityAdoption(t *testing.T) {
	f, srv := attFake(t)
	id := f.seed("security", map[string]any{"applicationId": "bHn5talQhJsSYMyHl1T7t", "username": "admin", "password": "stored-in-dokploy"})
	cfg := providerBlock(srv.URL) + attImport("dokploy_security.u", id) + `
resource "dokploy_security" "u" {
  application_id = "bHn5talQhJsSYMyHl1T7t"
  username       = "admin"
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{Config: cfg, ConfigPlanChecks: attEmptyPlan, Check: resource.ComposeTestCheckFunc(
				attNoWrites(f, "security"),
				// The password Dokploy returns is never mapped into the state.
				func(s *terraform.State) error { return notInState(s, "stored-in-dokploy") },
			)},
			{Config: cfg, ConfigPlanChecks: attEmptyPlan},
		},
	})
}
