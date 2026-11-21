package provider

import (
	"fmt"
	"regexp"
	"strconv"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

// The real files of production (redacted samples settings.readWebServerTraefikConfig.json
// and settings.readMiddlewareTraefikConfig.json), blank lines with spaces included.
const (
	traefikProdWebServer   = "http:\n  routers:\n    dokploy-router-app:\n      rule: Host(`dokploy.flots.app`)\n      service: dokploy-service-app\n      entryPoints:\n        - web\n      middlewares:\n        - redirect-to-https\n    \n    dokploy-router-app-secure:\n      rule: Host(`dokploy.flots.app`)\n      service: dokploy-service-app\n      entryPoints:\n        - websecure\n\n      tls:\n        certResolver: letsencrypt\n  services:\n    dokploy-service-app:\n      loadBalancer:\n        servers:\n          - url: http://dokploy:3000\n        passHostHeader: true\n"
	traefikProdMiddlewares = "http:\n  middlewares:\n    redirect-to-https:\n      redirectScheme:\n        scheme: https\n        permanent: true\n"
)

func TestParseTraefikID(t *testing.T) {
	for id, want := range map[string][3]string{
		"main":        {"main", "", ""},
		"web_server":  {"web_server", "", ""},
		"middlewares": {"middlewares", "", ""},
		"file:/etc/dokploy/traefik/dynamic/a.yml":         {"file", "/etc/dokploy/traefik/dynamic/a.yml", ""},
		"file:srv_1-x:/etc/dokploy/traefik/dynamic/a.yml": {"file", "/etc/dokploy/traefik/dynamic/a.yml", "srv_1-x"},
		"file:srv:/etc/dokploy/traefik/dynamic/a:b.yml":   {"file", "/etc/dokploy/traefik/dynamic/a:b.yml", "srv"},
	} {
		target, p, srv, err := parseTraefikID(id)
		if err != nil || [3]string{target, p, srv} != want {
			t.Errorf("%s: got %q %q %q (%v), want %v", id, target, p, srv, err, want)
		}
		if back := traefikID(target, p, srv); back != id {
			t.Errorf("%s: round trip gave %s", id, back)
		}
	}
	for _, bad := range []string{"", "other", "file:", "file:relative"} {
		if _, _, _, err := parseTraefikID(bad); err == nil {
			t.Errorf("%q should be rejected", bad)
		}
	}
}

// ADOPTION: the two Traefik files production has under Dokploy's control are
// imported by their fixed ids and the configuration holding the same text gives
// an empty plan; nothing is written.
func TestTraefikFileAdoptsProdFiles(t *testing.T) {
	s := newSrvFake(t)
	s.files["web_server"] = traefikProdWebServer
	s.files["middlewares"] = traefikProdMiddlewares
	cfg := providerBlock(s.URL) + fmt.Sprintf(`
import {
  to = dokploy_traefik_file.web
  id = "web_server"
}
import {
  to = dokploy_traefik_file.middlewares
  id = "middlewares"
}
resource "dokploy_traefik_file" "web" {
  target  = "web_server"
  content = %s
}
resource "dokploy_traefik_file" "middlewares" {
  target  = "middlewares"
  content = %s
}
`, strconv.Quote(traefikProdWebServer), strconv.Quote(traefikProdMiddlewares))
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: cfg,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("dokploy_traefik_file.web", plancheck.ResourceActionNoop),
					plancheck.ExpectResourceAction("dokploy_traefik_file.middlewares", plancheck.ResourceActionNoop),
				}},
			},
			{Config: cfg, ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}}},
		},
	})
	for _, p := range []string{"settings.updateTraefikConfig", "settings.updateWebServerTraefikConfig", "settings.updateMiddlewareTraefikConfig", "settings.updateTraefikFile"} {
		if n := s.callsOf(p); n != 0 {
			t.Errorf("%s called %d times while adopting", p, n)
		}
	}
	s.assertNoForbiddenCall(t)
}

func TestTraefikFileLifecycle(t *testing.T) {
	s := newSrvFake(t)
	s.files["main"] = "entryPoints:\n  web:\n    address: :80\n"
	const (
		local  = "/etc/dokploy/traefik/dynamic/extra.yml"
		remote = "/etc/dokploy/traefik/dynamic/remote.yml"
	)
	cfg := func(main, extra, rem string) string {
		return providerBlock(s.URL) + fmt.Sprintf(`
resource "dokploy_traefik_file" "main" {
  target  = "main"
  content = %q
}
resource "dokploy_traefik_file" "web" {
  target  = "web_server"
  content = "http:\n  routers: {}\n"
}
resource "dokploy_traefik_file" "extra" {
  target  = "file"
  path    = %q
  content = %q
}
resource "dokploy_traefik_file" "remote" {
  target    = "file"
  server_id = "server-9"
  path      = %q
  content   = %q
}
`, main, local, extra, remote, rem)
	}
	step1 := cfg("entryPoints:\n  web:\n    address: :80\n  websecure:\n    address: :443\n", "http:\n  middlewares: {}\n", "http:\n  services: {}\n")
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: step1,
				Check: func(st *terraform.State) error {
					for id, want := range map[string]string{
						"main":                    "entryPoints:\n  web:\n    address: :80\n  websecure:\n    address: :443\n",
						"web_server":              "http:\n  routers: {}\n",
						"file:" + local:           "http:\n  middlewares: {}\n",
						"file:server-9:" + remote: "http:\n  services: {}\n",
					} {
						if got := s.files[id]; got != want {
							return fmt.Errorf("file %s holds %q, want %q", id, got, want)
						}
					}
					if got := idOf(st, "dokploy_traefik_file.remote"); got != "file:server-9:"+remote {
						return fmt.Errorf("id of the remote file: %s", got)
					}
					return resource.TestCheckResourceAttr("dokploy_traefik_file.main", "id", "main")(st)
				},
			},
			{
				// A change rewrites only the file that changed.
				PreConfig: func() { s.mine, s.fakeAPI.calls = nil, nil },
				Config:    cfg("entryPoints:\n  web:\n    address: :80\n  websecure:\n    address: :443\n", "http:\n  middlewares:\n    a: {}\n", "http:\n  services: {}\n"),
				Check: func(st *terraform.State) error {
					if s.files["file:"+local] != "http:\n  middlewares:\n    a: {}\n" {
						return fmt.Errorf("file not updated: %q", s.files["file:"+local])
					}
					if n := s.callsOf("settings.updateTraefikFile"); n != 1 {
						return fmt.Errorf("updateTraefikFile called %d times", n)
					}
					if n := s.callsOf("settings.updateTraefikConfig") + s.callsOf("settings.updateWebServerTraefikConfig"); n != 0 {
						return fmt.Errorf("unchanged documents were rewritten")
					}
					return nil
				},
			},
			{ResourceName: "dokploy_traefik_file.main", ImportState: true, ImportStateVerify: true},
			{ResourceName: "dokploy_traefik_file.web", ImportState: true, ImportStateVerify: true},
			{ResourceName: "dokploy_traefik_file.extra", ImportState: true, ImportStateVerify: true},
			{ResourceName: "dokploy_traefik_file.remote", ImportState: true, ImportStateVerify: true},
		},
	})
	// Dokploy has no delete: destroy forgets the files, they stay.
	if len(s.files) != 4 {
		t.Errorf("destroy removed files: %v", s.files)
	}
	s.assertNoForbiddenCall(t)
}

// Dokploy answers true when it fails to write: the provider reads the file back.
func TestTraefikFileSwallowedWriteIsAnError(t *testing.T) {
	s := newSrvFake(t)
	s.swallowWrites = true
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config: providerBlock(s.URL) + `
resource "dokploy_traefik_file" "f" {
  target  = "file"
  path    = "/etc/dokploy/traefik/dynamic/missing-dir/x.yml"
  content = "http: {}\n"
}
`,
			ExpectError: regexp.MustCompile(`cannot be read back|swallows\s+write\s+errors`),
		}},
	})
}

func TestTraefikFileRemovedOutsideTerraform(t *testing.T) {
	s := newSrvFake(t)
	cfg := providerBlock(s.URL) + `
resource "dokploy_traefik_file" "f" {
  target  = "file"
  path    = "/etc/dokploy/traefik/dynamic/gone.yml"
  content = "http: {}\n"
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{Config: cfg},
			{
				PreConfig: func() { delete(s.files, "file:/etc/dokploy/traefik/dynamic/gone.yml") },
				Config:    cfg,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("dokploy_traefik_file.f", plancheck.ResourceActionCreate),
				}},
			},
		},
	})
}

func TestTraefikFileConfigValidation(t *testing.T) {
	s := newSrvFake(t)
	for name, tc := range map[string]struct{ body, err string }{
		"file needs a path":        {`target = "file"`, `path is required`},
		"path outside the root":    {"target = \"file\"\n  path = \"/etc/passwd\"", `below\s+/etc/dokploy/traefik/`},
		"path traversal":           {"target = \"file\"\n  path = \"/etc/dokploy/traefik/../../passwd\"", `must not contain`},
		"fixed target with a path": {"target = \"main\"\n  path = \"/etc/dokploy/traefik/x.yml\"", `only\s+used\s+with\s+target`},
		"fixed target with server": {"target = \"middlewares\"\n  server_id = \"s1\"", `lives\s+on\s+the\s+Dokploy\s+host`},
		"unknown target":           {`target = "dynamic"`, `target value must be one of`},
	} {
		t.Run(name, func(t *testing.T) {
			resource.UnitTest(t, resource.TestCase{
				ProtoV6ProviderFactories: factories(),
				Steps: []resource.TestStep{{
					Config: providerBlock(s.URL) + `
resource "dokploy_traefik_file" "f" {
  content = "a: b\n"
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
