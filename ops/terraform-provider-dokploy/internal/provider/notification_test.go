package provider

import (
	"fmt"
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

// notifCase describes one notification type for the table-driven lifecycle
// test: its non-secret configuration, its write-only secrets, and where the
// secrets land in the type-specific object of the API.
type notifCase struct {
	typ string
	// plain is the non-secret configuration.
	plain string
	// secretHCL sets the write-only attributes.
	secretHCL string
	// secretKey and secretValue locate the secret in the nested object.
	secretKey, secretValue string
	// extraKey, extraValue: a second secret, when the type has two.
	extraKey, extraValue string
}

var notifCases = []notifCase{
	{typ: "discord", plain: `decoration = false`, secretHCL: `webhook_url_wo = "https://discord.test/api/webhooks/1/FIXTURE-DISCORD"`, secretKey: "webhookUrl", secretValue: "https://discord.test/api/webhooks/1/FIXTURE-DISCORD"},
	{typ: "email", plain: `
  smtp_server  = "smtp.example.test"
  smtp_port    = 465
  username     = "mailer"
  from_address = "dokploy@example.test"
  to_addresses = ["ops@example.test", "dev@example.test"]`, secretHCL: `password_wo = "FIXTURE-SMTP-PASSWORD"`, secretKey: "password", secretValue: "FIXTURE-SMTP-PASSWORD"},
	{typ: "slack", plain: `channel = "#ops"`, secretHCL: `webhook_url_wo = "https://hooks.slack.test/FIXTURE-SLACK"`, secretKey: "webhookUrl", secretValue: "https://hooks.slack.test/FIXTURE-SLACK"},
	{typ: "telegram", plain: `chat_id = "42"`, secretHCL: `bot_token_wo = "123456:FIXTURE-BOT-TOKEN"`, secretKey: "botToken", secretValue: "123456:FIXTURE-BOT-TOKEN"},
	{typ: "resend", plain: `
  from_address = "dokploy@example.test"
  to_addresses = ["ops@example.test"]`, secretHCL: `api_key_wo = "re_FIXTURE-RESEND-KEY"`, secretKey: "apiKey", secretValue: "re_FIXTURE-RESEND-KEY"},
	{typ: "gotify", plain: `
  server_url = "https://gotify.example.test"
  priority   = 7`, secretHCL: `app_token_wo = "FIXTURE-GOTIFY-TOKEN"`, secretKey: "appToken", secretValue: "FIXTURE-GOTIFY-TOKEN"},
	{typ: "ntfy", plain: `
  server_url = "https://ntfy.example.test"
  topic      = "dokploy"`, secretHCL: `access_token_wo = "tk_FIXTURE-NTFY-TOKEN"`, secretKey: "accessToken", secretValue: "tk_FIXTURE-NTFY-TOKEN"},
	{typ: "mattermost", plain: `channel = "ops"`, secretHCL: `webhook_url_wo = "https://mm.example.test/hooks/FIXTURE-MM"`, secretKey: "webhookUrl", secretValue: "https://mm.example.test/hooks/FIXTURE-MM"},
	{typ: "lark", plain: ``, secretHCL: `webhook_url_wo = "https://lark.example.test/hook/FIXTURE-LARK"`, secretKey: "webhookUrl", secretValue: "https://lark.example.test/hook/FIXTURE-LARK"},
	{typ: "teams", plain: ``, secretHCL: `webhook_url_wo = "https://teams.example.test/hook/FIXTURE-TEAMS"`, secretKey: "webhookUrl", secretValue: "https://teams.example.test/hook/FIXTURE-TEAMS"},
	{typ: "pushover", plain: `priority = 1`, secretHCL: `
  user_key_wo  = "FIXTURE-PUSHOVER-USER"
  api_token_wo = "FIXTURE-PUSHOVER-TOKEN"`, secretKey: "userKey", secretValue: "FIXTURE-PUSHOVER-USER", extraKey: "apiToken", extraValue: "FIXTURE-PUSHOVER-TOKEN"},
	{typ: "custom", plain: `endpoint = "https://hooks.example.test/dokploy"`, secretHCL: `headers_wo = { X-Fixture = "FIXTURE-CUSTOM-HEADER" }`, secretKey: "headers", secretValue: ""},
}

// TestNotificationLifecycles creates, updates (without repeating the secrets),
// rotates the secrets of, imports and destroys one notification of every type.
func TestNotificationLifecycles(t *testing.T) {
	for _, tc := range notifCases {
		tc := tc
		t.Run(tc.typ, func(t *testing.T) {
			a := newBackupsAPI(t)
			addr := "dokploy_notification_" + tc.typ + ".n"
			cfg := func(name, flags, secrets string) string {
				return providerBlock(a.srv.URL) + fmt.Sprintf(`
resource "dokploy_notification_%s" "n" {
  name = %q
  %s
  %s
  %s
}
`, tc.typ, name, flags, tc.plain, secrets)
			}
			var id string
			secretOf := func(sub map[string]any, key string) string {
				if tc.typ == "custom" {
					h, _ := sub["headers"].(map[string]any)
					return fmt.Sprint(h["X-Fixture"])
				}
				return fmt.Sprint(sub[key])
			}
			// gotify and ntfy have no server_threshold event.
			flags2 := "app_deploy = false"
			if tc.typ != "gotify" && tc.typ != "ntfy" {
				flags2 += "\n  server_threshold = true"
			}
			wantStored := tc.secretValue
			if tc.typ == "custom" {
				wantStored = "FIXTURE-CUSTOM-HEADER"
			}
			steps := []resource.TestStep{
				{
					Config: cfg("first", `app_deploy = true`, tc.secretHCL+"\n  secrets_version = 1"),
					ConfigStateChecks: []statecheck.StateCheck{
						statecheck.ExpectKnownValue(addr, tfjsonpath.New("app_deploy"), knownvalue.Bool(true)),
						statecheck.ExpectKnownValue(addr, tfjsonpath.New("database_backup"), knownvalue.Bool(false)),
					},
					Check: func(s *terraform.State) error {
						id = idOf(s, addr)
						n := a.get("notification", id)
						sub := a.notifSub(id, tc.typ)
						if n["notificationType"] != tc.typ || n["name"] != "first" || n["appDeploy"] != true {
							return fmt.Errorf("unexpected notification: %v", n)
						}
						if got := secretOf(sub, tc.secretKey); got != wantStored {
							return fmt.Errorf("secret not sent: %v", sub)
						}
						if tc.extraKey != "" && secretOf(sub, tc.extraKey) != tc.extraValue {
							return fmt.Errorf("second secret not sent: %v", sub)
						}
						for _, secret := range []string{"FIXTURE-"} {
							if err := notInState(s, secret); err != nil {
								return err
							}
						}
						return nil
					},
				},
				{
					// A rename and a flag, secrets not repeated: they are read back
					// and sent again, as lark and teams cannot update without them
					// and ntfy would reset its token.
					Config: cfg("renamed", flags2, "secrets_version = 1"),
					Check: func(s *terraform.State) error {
						n := a.get("notification", id)
						sub := a.notifSub(id, tc.typ)
						if n["name"] != "renamed" || n["appDeploy"] != false {
							return fmt.Errorf("not updated: %v", n)
						}
						if got := secretOf(sub, tc.secretKey); got != wantStored {
							return fmt.Errorf("the update lost the secret: %v", sub)
						}
						body := a.calls.last("notification.update" + strings.ToUpper(tc.typ[:1]) + tc.typ[1:])
						if body[tc.typ+"Id"] == nil || body["notificationId"] != id {
							return fmt.Errorf("the type id must come from notification.one: %v", body)
						}
						return nil
					},
				},
				{
					ResourceName:            addr,
					ImportState:             true,
					ImportStateVerify:       true,
					ImportStateVerifyIgnore: []string{"secrets_version"},
				},
			}
			if tc.typ == "custom" {
				steps[0].ConfigStateChecks = append(steps[0].ConfigStateChecks,
					statecheck.ExpectKnownValue(addr, tfjsonpath.New("header_names"), knownvalue.SetExact([]knownvalue.Check{knownvalue.StringExact("X-Fixture")})),
					statecheck.ExpectKnownValue(addr, tfjsonpath.New("headers_wo"), knownvalue.Null()))
			}
			resource.UnitTest(t, resource.TestCase{ProtoV6ProviderFactories: factories(), Steps: steps})
		})
	}
}

func TestNotificationSecretRotationAndRequiredSecret(t *testing.T) {
	a := newBackupsAPI(t)
	cfg := func(extra string) string {
		return providerBlock(a.srv.URL) + `
resource "dokploy_notification_discord" "d" {
  name = "logs"
` + extra + `
}
`
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config:      cfg(``),
				ExpectError: regexp.MustCompile(`webhook_url_wo is required to create a notification of type discord`),
			},
			{
				Config: cfg(`
  webhook_url_wo  = "https://discord.test/hook/old"
  secrets_version = 1`),
			},
			{
				// Same configuration, new value, new version: sent again.
				Config: cfg(`
  webhook_url_wo  = "https://discord.test/hook/new"
  secrets_version = 2`),
				Check: func(s *terraform.State) error {
					sub := a.notifSub(idOf(s, "dokploy_notification_discord.d"), "discord")
					if sub["webhookUrl"] != "https://discord.test/hook/new" {
						return fmt.Errorf("not rotated: %v", sub)
					}
					return notInState(s, "discord.test/hook")
				},
			},
		},
	})
}

func TestNotificationNtfyWithoutToken(t *testing.T) {
	a := newBackupsAPI(t)
	cfg := func(topic string) string {
		return providerBlock(a.srv.URL) + `
resource "dokploy_notification_ntfy" "n" {
  name       = "alerts"
  server_url = "https://ntfy.example.test"
  topic      = "` + topic + `"
}
`
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				// createNtfy refuses a payload without the accessToken key.
				Config: cfg("a"),
				Check: func(s *terraform.State) error {
					if sub := a.notifSub(idOf(s, "dokploy_notification_ntfy.n"), "ntfy"); sub["accessToken"] != "" {
						return fmt.Errorf("unexpected ntfy row: %v", sub)
					}
					return nil
				},
			},
			{Config: cfg("b")},
		},
	})
}

func TestNotificationImportWrongType(t *testing.T) {
	a := newBackupsAPI(t)
	id := a.seed("notification", map[string]any{
		"name": "mail", "notificationType": "email", "emailId": "e-1",
		"email": map[string]any{"emailId": "e-1", "smtpServer": "s", "smtpPort": 25, "username": "u", "password": "p", "fromAddress": "f", "toAddresses": []any{"t"}},
	})
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config: providerBlock(a.srv.URL) + `
import {
  to = dokploy_notification_discord.d
  id = "` + id + `"
}
resource "dokploy_notification_discord" "d" {
  name = "mail"
}
`,
			ExpectError: regexp.MustCompile(`is of type "email"`),
		}},
	})
}

// TestNotificationAdoption seeds the two notifications of the production
// Dokploy (an email one and a Discord one, as notification.all returns them:
// every other type null, the secrets in clear) and imports them with the
// configuration a human would write. The plan must be empty, and the first
// change must send the secrets again, read back from Dokploy.
func TestNotificationAdoption(t *testing.T) {
	a := newBackupsAPI(t)
	others := func(m map[string]any, except string) map[string]any {
		for _, typ := range bkNotifTypes {
			if typ != except {
				m[typ] = nil
				m[typ+"Id"] = nil
			}
		}
		return m
	}
	email := a.seed("notification", others(map[string]any{
		"appBuildError": true, "appDeploy": true, "databaseBackup": true, "dockerCleanup": true, "dokployBackup": true,
		"dokployRestart": true, "githubRunners": true, "osUpdates": true, "serverThreshold": false, "volumeBackup": true,
		"name": "Email Notifications", "notificationType": "email", "emailId": "PfFr7YpoIdD2fmEswcMR7",
		"organizationId": "org-1",
		"email": map[string]any{
			"emailId": "PfFr7YpoIdD2fmEswcMR7", "fromAddress": "dokploy@example.test", "password": "SMTP-PASSWORD-SEED", "smtpPort": 465,
			"smtpServer": "smtp.example.test", "toAddresses": []any{"ops@example.test"}, "username": "mailer",
		},
	}, "email"))
	discord := a.seed("notification", others(map[string]any{
		"appBuildError": true, "appDeploy": true, "databaseBackup": true, "dockerCleanup": true, "dokployBackup": true,
		"dokployRestart": true, "githubRunners": true, "osUpdates": false, "serverThreshold": false, "volumeBackup": true,
		"name": "Discord Logs Dokploy", "notificationType": "discord", "discordId": "BTfbAj6WGQIgP4mGWGDUy",
		"organizationId": "org-1",
		"discord":        map[string]any{"decoration": true, "discordId": "BTfbAj6WGQIgP4mGWGDUy", "webhookUrl": "https://discord.test/api/webhooks/SEED"},
	}, "discord"))
	cfg := func(extra string) string {
		return providerBlock(a.srv.URL) + `
import {
  to = dokploy_notification_email.mail
  id = "` + email + `"
}
import {
  to = dokploy_notification_discord.logs
  id = "` + discord + `"
}
resource "dokploy_notification_email" "mail" {
  name         = "Email Notifications"
  smtp_server  = "smtp.example.test"
  smtp_port    = 465
  username     = "mailer"
  from_address = "dokploy@example.test"
  to_addresses = ["ops@example.test"]
` + extra + `
}
resource "dokploy_notification_discord" "logs" {
  name = "Discord Logs Dokploy"
}
`
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: cfg(``),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("dokploy_notification_email.mail", plancheck.ResourceActionNoop),
					plancheck.ExpectResourceAction("dokploy_notification_discord.logs", plancheck.ResourceActionNoop),
				}},
				ConfigStateChecks: []statecheck.StateCheck{
					statecheck.ExpectKnownValue("dokploy_notification_email.mail", tfjsonpath.New("os_updates"), knownvalue.Bool(true)),
					statecheck.ExpectKnownValue("dokploy_notification_discord.logs", tfjsonpath.New("os_updates"), knownvalue.Bool(false)),
					statecheck.ExpectKnownValue("dokploy_notification_discord.logs", tfjsonpath.New("decoration"), knownvalue.Bool(true)),
				},
				Check: func(s *terraform.State) error {
					for _, secret := range []string{"SMTP-PASSWORD-SEED", "discord.test/api/webhooks/SEED"} {
						if err := notInState(s, secret); err != nil {
							return err
						}
					}
					return nil
				},
			},
			{
				Config:           cfg(``),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
			{
				Config: cfg(`server_threshold = true`),
				Check: func(s *terraform.State) error {
					body := a.calls.last("notification.updateEmail")
					if body["emailId"] != "PfFr7YpoIdD2fmEswcMR7" || body["serverThreshold"] != true {
						return fmt.Errorf("unexpected update payload: %v", body)
					}
					if sub := a.notifSub(email, "email"); sub["password"] != "SMTP-PASSWORD-SEED" {
						return fmt.Errorf("the SMTP password was lost: %v", sub)
					}
					return notInState(s, "SMTP-PASSWORD-SEED")
				},
			},
		},
	})
}
