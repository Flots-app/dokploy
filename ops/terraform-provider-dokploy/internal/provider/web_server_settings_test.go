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

// wssProdSettings is the web server settings of production (redacted sample
// settings.getWebServerSettings.json), with a made-up secret where the real one
// is null, to prove nothing secret reaches the state.
func wssProdSettings() map[string]any {
	return map[string]any{
		"buildsConcurrency": float64(1), "certificateType": "letsencrypt",
		"cleanupCacheApplications": false, "cleanupCacheOnCompose": false, "cleanupCacheOnPreviews": false,
		"createdAt": "2026-01-10T09:24:44.975Z", "enableDockerCleanup": true, "enforceSSO": false,
		"host": "dokploy.flots.app", "https": true, "id": "90c65f2b-692b-4870-8e10-ad2c4891d8fa",
		"letsEncryptEmail": "app.flots@gmail.com", "logCleanupCron": "0 0 * * *",
		"metricsConfig": srvProdMetrics(), "remoteServersOnly": false, "serverIp": "195.201.5.178",
		"sshPrivateKey": "FIXTURE-KEY-MATERIAL", "updatedAt": "2026-11-15T04:53:19.094Z",
		"whitelabelingConfig": map[string]any{"appName": nil, "logoUrl": nil},
	}
}

func wssDefaultSettings() map[string]any {
	return map[string]any{
		"buildsConcurrency": float64(1), "certificateType": "none",
		"cleanupCacheApplications": false, "cleanupCacheOnCompose": false, "cleanupCacheOnPreviews": false,
		"enableDockerCleanup": true, "enforceSSO": false, "host": nil, "https": false, "id": "x",
		"letsEncryptEmail": nil, "logCleanupCron": "0 0 * * *", "remoteServersOnly": false, "serverIp": nil,
		"sshPrivateKey": nil,
	}
}

func wssFastPorts(t *testing.T) {
	oldPoll, oldTimeout := webServerPortsPoll, webServerPortsTimeout
	webServerPortsPoll, webServerPortsTimeout = 5*time.Millisecond, 2*time.Second
	t.Cleanup(func() { webServerPortsPoll, webServerPortsTimeout = oldPoll, oldTimeout })
}

var wssMutations = []string{
	"settings.assignDomainServer", "settings.updateServerIp", "settings.updateDockerCleanup", "settings.updateLogCleanup",
	"settings.updateBuildsConcurrency", "settings.updateRemoteServersOnly", "settings.updateEnforceSSO", "settings.updateTraefikPorts",
}

func (s *srvFake) assertNoSettingsWrite(t *testing.T) {
	t.Helper()
	for _, p := range wssMutations {
		if n := s.callsOf(p); n != 0 {
			t.Errorf("%s called %d times", p, n)
		}
	}
}

// ADOPTION: the settings of production are imported (with an arbitrary id, it is
// a singleton) and the minimal configuration gives an empty plan; nothing is
// written, no secret reaches the state.
func TestWebServerSettingsAdoptsProdSettings(t *testing.T) {
	s := newSrvFake(t)
	s.settings = wssProdSettings()
	s.ports = []map[string]any{{"protocol": "tcp", "publishedPort": float64(8080), "targetPort": float64(8080)}}
	cfg := providerBlock(s.URL) + `
import {
  to = dokploy_web_server_settings.this
  id = "any-id-works"
}
resource "dokploy_web_server_settings" "this" {
  host              = "dokploy.flots.app"
  https             = true
  certificate_type  = "letsencrypt"
  letsencrypt_email = "app.flots@gmail.com"
  server_ip         = "195.201.5.178"
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: cfg,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("dokploy_web_server_settings.this", plancheck.ResourceActionNoop),
				}},
				Check: resource.ComposeTestCheckFunc(
					resource.TestCheckResourceAttr("dokploy_web_server_settings.this", "id", "web-server"),
					resource.TestCheckResourceAttr("dokploy_web_server_settings.this", "log_cleanup_cron", "0 0 * * *"),
					resource.TestCheckResourceAttr("dokploy_web_server_settings.this", "builds_concurrency", "1"),
					resource.TestCheckResourceAttr("dokploy_web_server_settings.this", "enforce_sso", "false"),
					resource.TestCheckResourceAttr("dokploy_web_server_settings.this", "traefik_ports.#", "1"),
					resource.TestCheckTypeSetElemAttr("dokploy_web_server_settings.this", "traefik_ports.*", "8080:8080/tcp"),
					func(st *terraform.State) error {
						if err := notInState(st, "FIXTURE-KEY-MATERIAL"); err != nil {
							return err
						}
						return notInState(st, "METRICS-TOKEN-VALUE")
					},
				),
			},
			{
				Config:           cfg,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
		},
	})
	s.assertNoSettingsWrite(t)
	s.assertNoForbiddenCall(t)
}

func TestWebServerSettingsLifecycle(t *testing.T) {
	wssFastPorts(t)
	s := newSrvFake(t)
	s.settings = wssDefaultSettings()
	s.ports = []map[string]any{}
	s.portsLag = 2
	cfg := func(body string) string {
		return providerBlock(s.URL) + `
resource "dokploy_web_server_settings" "this" {
` + body + `
}
`
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				// Create adopts the existing settings and applies the difference.
				Config: cfg(`
  host                  = "dokploy.example.test"
  https                 = true
  certificate_type      = "letsencrypt"
  letsencrypt_email     = "ops@example.test"
  server_ip             = "203.0.113.7"
  enable_docker_cleanup = false
  log_cleanup_cron      = "30 3 * * *"
  builds_concurrency    = 4
  traefik_ports         = ["8080:8080/tcp", "9000:9001/udp"]
`),
				Check: func(st *terraform.State) error {
					want := map[string]string{
						"host": "dokploy.example.test", "https": "true", "certificateType": "letsencrypt", "letsEncryptEmail": "ops@example.test",
						"serverIp": "203.0.113.7", "enableDockerCleanup": "false", "logCleanupCron": "30 3 * * *", "buildsConcurrency": "4",
					}
					for k, w := range want {
						if got := asString(s.settings[k]); got != w {
							return fmt.Errorf("remote %s = %q, want %q", k, got, w)
						}
					}
					if len(s.ports) != 2 {
						return fmt.Errorf("remote ports %v", s.ports)
					}
					if n := s.callsOf("settings.updateTraefikPorts"); n != 1 {
						return fmt.Errorf("updateTraefikPorts called %d times", n)
					}
					// One assignDomainServer for the four domain fields, the email included.
					req := s.bodies["settings.assignDomainServer"]
					if len(req) != 1 || req[0]["host"] != "dokploy.example.test" || req[0]["https"] != true || req[0]["certificateType"] != "letsencrypt" || req[0]["letsEncryptEmail"] != "ops@example.test" {
						return fmt.Errorf("assignDomainServer bodies: %v", req)
					}
					return nil
				},
			},
			{
				// Nothing changed: no write at all.
				PreConfig: func() { s.mine, s.fakeAPI.calls = nil, nil },
				Config: cfg(`
  host                  = "dokploy.example.test"
  https                 = true
  certificate_type      = "letsencrypt"
  letsencrypt_email     = "ops@example.test"
  server_ip             = "203.0.113.7"
  enable_docker_cleanup = false
  log_cleanup_cron      = "30 3 * * *"
  builds_concurrency    = 4
  traefik_ports         = ["9000:9001/udp", "8080:8080/tcp"]
`),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
			{
				// Updating one field of each group calls only its procedure; clearing
				// the log cleanup sends null; the ports lose one entry.
				PreConfig: func() { s.mine, s.fakeAPI.calls, s.portsLag = nil, nil, 1 },
				Config: cfg(`
  host                  = "dokploy.example.test"
  https                 = false
  certificate_type      = "letsencrypt"
  letsencrypt_email     = "ops@example.test"
  server_ip             = "203.0.113.8"
  enable_docker_cleanup = true
  log_cleanup_cron      = ""
  builds_concurrency    = 2
  remote_servers_only   = true
  enforce_sso           = true
  traefik_ports         = ["9000:9001/udp"]
`),
				Check: func(st *terraform.State) error {
					if s.settings["https"] != false || asString(s.settings["serverIp"]) != "203.0.113.8" || s.settings["enableDockerCleanup"] != true ||
						s.settings["logCleanupCron"] != nil || asString(s.settings["buildsConcurrency"]) != "2" ||
						s.settings["remoteServersOnly"] != true || s.settings["enforceSSO"] != true {
						return fmt.Errorf("update not applied: %v", s.settings)
					}
					if len(s.ports) != 1 {
						return fmt.Errorf("ports not reduced: %v", s.ports)
					}
					return nil
				},
			},
			{ResourceName: "dokploy_web_server_settings.this", ImportState: true, ImportStateId: "whatever", ImportStateVerify: true},
		},
	})
	// Destroy only forgets the settings.
	if s.settings["host"] != "dokploy.example.test" {
		t.Errorf("destroy altered the settings: %v", s.settings)
	}
	s.assertNoForbiddenCall(t)
}

func TestWebServerSettingsTraefikPortsTimeout(t *testing.T) {
	wssFastPorts(t)
	webServerPortsTimeout = 100 * time.Millisecond
	s := newSrvFake(t)
	s.settings = wssDefaultSettings()
	s.ports = []map[string]any{}
	s.portsLag = 1 << 30 // Traefik never reports the new ports
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config: providerBlock(s.URL) + `
resource "dokploy_web_server_settings" "this" {
  traefik_ports = ["8080:8080/tcp"]
}
`,
			ExpectError: regexp.MustCompile(`did not report the new\s+ports`),
		}},
	})
}

func TestWebServerSettingsLogCleanupFailure(t *testing.T) {
	s := newSrvFake(t)
	s.settings = wssDefaultSettings()
	s.ports = []map[string]any{}
	s.logCleanupOK = false
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config: providerBlock(s.URL) + `
resource "dokploy_web_server_settings" "this" {
  log_cleanup_cron = "0 1 * * *"
}
`,
			ExpectError: regexp.MustCompile(`log cleanup schedule`),
		}},
	})
}

func TestWebServerSettingsConfigValidation(t *testing.T) {
	s := newSrvFake(t)
	s.settings = wssDefaultSettings()
	s.ports = []map[string]any{}
	for name, tc := range map[string]struct{ body, err string }{
		"port format":       {`traefik_ports = ["8080"]`, `does not match published:target/protocol`},
		"port protocol":     {`traefik_ports = ["8080:8080"]`, `does not match published:target/protocol`},
		"empty host":        {`host = ""`, `Clearing the host`},
		"concurrency range": {`builds_concurrency = 101`, `between 1 and 100`},
		"certificate type":  {`certificate_type = "acme"`, `certificate_type value must be one of`},
		"read-only flag":    {`cleanup_cache_applications = true`, `(?i)read-only`},
	} {
		t.Run(name, func(t *testing.T) {
			resource.UnitTest(t, resource.TestCase{
				ProtoV6ProviderFactories: factories(),
				Steps: []resource.TestStep{{
					Config: providerBlock(s.URL) + `
resource "dokploy_web_server_settings" "this" {
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

// Changing the host while the instance has none yet needs the host: the domain
// procedure cannot be called without it.
func TestWebServerSettingsDomainNeedsAHost(t *testing.T) {
	s := newSrvFake(t)
	s.settings = wssDefaultSettings()
	s.ports = []map[string]any{}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config: providerBlock(s.URL) + `
resource "dokploy_web_server_settings" "this" {
  https = true
}
`,
			ExpectError: regexp.MustCompile(`host must be set`),
		}},
	})
	if s.settings["host"] != nil {
		t.Errorf("settings altered: %v", s.settings)
	}
}
