package provider

import (
	"fmt"
	"regexp"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

// bkDestinationHCL declares the destination the backups write to.
func bkDestinationHCL() string {
	return `
resource "dokploy_destination" "d" {
  name                 = "R2"
  bucket               = "backups"
  endpoint             = "https://s3.example.test"
  access_key_wo        = "fx-TEST"
  secret_access_key_wo = "secret-test"
}
`
}

func TestBackupLifecycle(t *testing.T) {
	a := newBackupsAPI(t)
	a.serveParent("postgres", "postgresId", "pg-1")
	cfg := func(dailySchedule string, monthlyEnabled bool) string {
		return providerBlock(a.srv.URL) + bkDestinationHCL() + fmt.Sprintf(`
resource "dokploy_backup" "daily" {
  database_type     = "postgres"
  postgres_id       = "pg-1"
  destination_id    = dokploy_destination.d.id
  schedule          = %q
  prefix            = "/daily"
  database          = "db_flots"
  keep_latest_count = 27
}
resource "dokploy_backup" "monthly" {
  database_type     = "postgres"
  postgres_id       = "pg-1"
  destination_id    = dokploy_destination.d.id
  schedule          = "0 3 1 * *"
  prefix            = "/monthly"
  database          = "db_flots"
  keep_latest_count = 12
  enabled           = %t
}
`, dailySchedule, monthlyEnabled)
	}
	var daily, monthly string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				// Two backups of the same service created in parallel: backup.create
				// answers nothing, each must find its own id.
				Config: cfg("0 0 * * *", true),
				Check: func(s *terraform.State) error {
					daily, monthly = idOf(s, "dokploy_backup.daily"), idOf(s, "dokploy_backup.monthly")
					if daily == "" || monthly == "" || daily == monthly {
						return fmt.Errorf("ids not resolved: %q %q", daily, monthly)
					}
					if p := a.get("backup", daily)["prefix"]; p != "/daily" {
						return fmt.Errorf("daily resolved to the wrong backup: %v", p)
					}
					if p := a.get("backup", monthly)["prefix"]; p != "/monthly" {
						return fmt.Errorf("monthly resolved to the wrong backup: %v", p)
					}
					b := a.get("backup", daily)
					if b["backupType"] != "database" || b["enabled"] != true || b["includeEncryptionKey"] != true || b["keepLatestCount"] != float64(27) {
						return fmt.Errorf("unexpected defaults: %v", b)
					}
					if _, ok := b["userId"]; ok {
						return fmt.Errorf("a database backup must not carry a user id: %v", b)
					}
					return nil
				},
			},
			{
				// An update repeats the whole definition, as backup.update demands.
				Config: cfg("30 1 * * *", false),
				Check: func(s *terraform.State) error {
					if a.get("backup", daily)["schedule"] != "30 1 * * *" || a.get("backup", monthly)["enabled"] != false {
						return fmt.Errorf("not updated: %v %v", a.get("backup", daily), a.get("backup", monthly))
					}
					body := a.calls.last("backup.update")
					if _, ok := body["postgresId"]; ok {
						return fmt.Errorf("backup.update does not take the parent id: %v", body)
					}
					return nil
				},
			},
			{
				ResourceName:            "dokploy_backup.daily",
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"secrets_version"},
			},
		},
	})
}

func TestBackupWebServer(t *testing.T) {
	a := newBackupsAPI(t)
	cfg := providerBlock(a.srv.URL) + bkDestinationHCL() + `
resource "dokploy_backup" "web" {
  database_type     = "web-server"
  destination_id    = dokploy_destination.d.id
  schedule          = "0 0 * * 0"
  prefix            = "/dokploy"
  database          = "dokploy"
  keep_latest_count = 4
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config: cfg,
			Check: func(s *terraform.State) error {
				id := idOf(s, "dokploy_backup.web")
				b := a.get("backup", id)
				// The owner of the web server backup is the API key's user.
				if b["userId"] != "user-1" || b["databaseType"] != "web-server" || b["backupType"] != "database" {
					return fmt.Errorf("unexpected backup: %v", b)
				}
				return nil
			},
		}},
	})
}

func TestBackupCompose(t *testing.T) {
	a := newBackupsAPI(t)
	a.serveParent("compose", "composeId", "compose-1")
	cfg := func(schedule, extra string) string {
		return providerBlock(a.srv.URL) + bkDestinationHCL() + `
resource "dokploy_backup" "c" {
  backup_type          = "compose"
  database_type        = "mariadb"
  compose_id           = "compose-1"
  service_name         = "db"
  destination_id       = dokploy_destination.d.id
  schedule             = "` + schedule + `"
  prefix               = "/compose"
  database             = "app"
  database_user        = "app_user"
` + extra + `
}
`
	}
	var id string
	meta := func() map[string]any {
		m, _ := a.get("backup", id)["metadata"].(map[string]any)
		sub, _ := m["mariadb"].(map[string]any)
		return sub
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config:      cfg("0 1 * * *", ``),
				ExpectError: regexp.MustCompile(`a compose backup of a mariadb database needs database_password_wo`),
			},
			{
				Config: cfg("0 1 * * *", `
  database_password_wo = "db-password-1"
  secrets_version      = 1`),
				Check: func(s *terraform.State) error {
					id = idOf(s, "dokploy_backup.c")
					b := a.get("backup", id)
					if b["backupType"] != "compose" || b["composeId"] != "compose-1" || b["serviceName"] != "db" {
						return fmt.Errorf("unexpected backup: %v", b)
					}
					if m := meta(); m["databaseUser"] != "app_user" || m["databasePassword"] != "db-password-1" {
						return fmt.Errorf("unexpected metadata: %v", b["metadata"])
					}
					return notInState(s, "db-password-1")
				},
			},
			{
				// The password is not repeated: it is read back from Dokploy.
				Config: cfg("0 2 * * *", `
  secrets_version = 1`),
				Check: func(s *terraform.State) error {
					if m := meta(); m["databaseUser"] != "app_user" || m["databasePassword"] != "db-password-1" {
						return fmt.Errorf("the update lost the password: %v", a.get("backup", id)["metadata"])
					}
					if a.get("backup", id)["schedule"] != "0 2 * * *" {
						return fmt.Errorf("not updated")
					}
					return nil
				},
			},
			{
				Config: cfg("0 2 * * *", `
  database_password_wo = "db-password-2"
  secrets_version      = 2`),
				Check: func(s *terraform.State) error {
					if m := meta(); m["databasePassword"] != "db-password-2" {
						return fmt.Errorf("password not rotated: %v", a.get("backup", id)["metadata"])
					}
					return notInState(s, "db-password-2")
				},
			},
		},
	})
}

func TestBackupNeedsItsParent(t *testing.T) {
	a := newBackupsAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: providerBlock(a.srv.URL) + bkDestinationHCL() + `
resource "dokploy_backup" "b" {
  database_type  = "postgres"
  destination_id = dokploy_destination.d.id
  schedule       = "0 0 * * *"
  prefix         = "/x"
  database       = "db"
}
`,
				ExpectError: regexp.MustCompile(`needs the id of the service to back up \(postgres_id\)`),
			},
			{
				Config: providerBlock(a.srv.URL) + bkDestinationHCL() + `
resource "dokploy_backup" "b" {
  backup_type    = "compose"
  database_type  = "postgres"
  compose_id     = "compose-1"
  destination_id = dokploy_destination.d.id
  schedule       = "0 0 * * *"
  prefix         = "/x"
  database       = "db"
}
`,
				ExpectError: regexp.MustCompile(`needs compose_id and service_name`),
			},
		},
	})
}

// TestBackupAdoption seeds what the production Dokploy holds: the encrypted
// destination, the three schedules of the Postgres service of pg-db01 and the
// Dokploy web server backup (database_type web-server, owned by a user, a
// nested destination without keys, metadata {}), and imports them all with the
// configuration a human would write. The plan must be empty.
func TestBackupAdoption(t *testing.T) {
	a := newBackupsAPI(t)
	dest := a.seed("destination", map[string]any{
		"name": "Cloudflare R2 - backups - encrypted", "provider": "Cloudflare", "bucket": "dokploy-backups",
		"region": "eeur", "endpoint": r2Endpoint, "additionalFlags": []any{},
		"accessKey": "AK-SEED", "secretAccessKey": "SK-SEED",
		"encryptionEnabled": true, "encryptionKeyManagement": "customer", "encryptionFilenameMode": "standard",
		"encryptionDirectoryNames": true, "encryptionPassword": nil, "encryptionPassword2": nil,
		"organizationId": "org-1",
	})
	nested := map[string]any{
		"additionalFlags": []any{}, "bucket": "dokploy-backups", "destinationId": dest,
		"encryptionDirectoryNames": true, "encryptionEnabled": true, "encryptionFilenameMode": "standard",
		"encryptionKeyManagement": "customer", "endpoint": r2Endpoint, "name": "Cloudflare R2 - backups - encrypted",
		"organizationId": "org-1", "provider": "Cloudflare", "region": "eeur",
	}
	const pg = "2Wi1lNgawg6VqxFAZai9m"
	pgBackup := func(app, prefix, schedule string, keep int) string {
		return a.seed("backup", map[string]any{
			"appName": app, "backupType": "database", "composeId": nil, "database": "db_flots", "databaseType": "postgres",
			"destination": nested, "destinationId": dest, "enabled": true, "includeEncryptionKey": true,
			"keepLatestCount": keep, "libsqlId": nil, "mariadbId": nil, "metadata": map[string]any{}, "mongoId": nil,
			"mysqlId": nil, "postgresId": pg, "prefix": prefix, "schedule": schedule, "serviceName": nil, "userId": nil,
		})
	}
	intraday := pgBackup("backup-parse-digital-pixel-yqafcd", "/intraday", "0 */4 * * *", 24)
	daily := pgBackup("backup-reboot-1080p-microchip-7y5m69", "/daily", "0 0 * * *", 27)
	monthly := pgBackup("backup-calculate-1080p-hard-drive-55wljz", "/monthly", "0 3 1 * *", 12)
	web := a.seed("backup", map[string]any{
		"appName": "backup-synthesize-auxiliary-pixel-fijfev", "backupType": "database", "compose": nil, "composeId": nil,
		"database": "dokploy", "databaseType": "web-server", "destination": nested, "destinationId": dest,
		"enabled": true, "includeEncryptionKey": true, "keepLatestCount": 4, "libsql": nil, "libsqlId": nil,
		"mariadb": nil, "mariadbId": nil, "metadata": map[string]any{}, "mongo": nil, "mongoId": nil, "mysql": nil,
		"mysqlId": nil, "postgres": nil, "postgresId": nil, "prefix": "/dokploy", "schedule": "0 0 * * 0",
		"serviceName": nil, "userId": "Td0KsbHlzD7s27dG6cJ2WHvNVZKiSKOd",
	})

	pgResource := func(name, id, prefix, schedule string, keep int) string {
		return fmt.Sprintf(`
import {
  to = dokploy_backup.%[1]s
  id = %[2]q
}
resource "dokploy_backup" "%[1]s" {
  database_type     = "postgres"
  postgres_id       = %[6]q
  destination_id    = dokploy_destination.enc.id
  schedule          = %[4]q
  prefix            = %[3]q
  database          = "db_flots"
  keep_latest_count = %[5]d
}
`, name, id, prefix, schedule, keep, pg)
	}
	cfg := func(monthlySchedule string) string {
		return providerBlock(a.srv.URL) + `
import {
  to = dokploy_destination.enc
  id = "` + dest + `"
}
resource "dokploy_destination" "enc" {
  name                      = "Cloudflare R2 - backups - encrypted"
  s3_provider               = "Cloudflare"
  bucket                    = "dokploy-backups"
  region                    = "eeur"
  endpoint                  = "` + r2Endpoint + `"
  encryption_enabled        = true
  encryption_key_management = "customer"
}
` + pgResource("intraday", intraday, "/intraday", "0 */4 * * *", 24) +
			pgResource("daily", daily, "/daily", "0 0 * * *", 27) +
			pgResource("monthly", monthly, "/monthly", monthlySchedule, 12) + `
import {
  to = dokploy_backup.web
  id = "` + web + `"
}
resource "dokploy_backup" "web" {
  database_type     = "web-server"
  destination_id    = dokploy_destination.enc.id
  schedule          = "0 0 * * 0"
  prefix            = "/dokploy"
  database          = "dokploy"
  keep_latest_count = 4
}
`
	}
	noop := func(names ...string) []plancheck.PlanCheck {
		var checks []plancheck.PlanCheck
		for _, n := range names {
			checks = append(checks, plancheck.ExpectResourceAction("dokploy_backup."+n, plancheck.ResourceActionNoop))
		}
		return checks
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config:           cfg("0 3 1 * *"),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: noop("intraday", "daily", "monthly", "web")},
			},
			{
				Config:           cfg("0 3 1 * *"),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
			{
				// The first change after the adoption: the whole definition is sent.
				Config: cfg("0 4 1 * *"),
				Check: func(s *terraform.State) error {
					b := a.get("backup", monthly)
					if b["schedule"] != "0 4 1 * *" || b["keepLatestCount"] != float64(12) || b["prefix"] != "/monthly" {
						return fmt.Errorf("unexpected backup after the update: %v", b)
					}
					body := a.calls.last("backup.update")
					if body["enabled"] != true || body["includeEncryptionKey"] != true || body["serviceName"] != nil {
						return fmt.Errorf("incomplete update payload: %v", body)
					}
					if m, ok := body["metadata"].(map[string]any); !ok || len(m) != 0 {
						return fmt.Errorf("metadata should be {}: %#v", body["metadata"])
					}
					// The web server backup keeps its owner.
					if a.get("backup", web)["userId"] != "Td0KsbHlzD7s27dG6cJ2WHvNVZKiSKOd" {
						return fmt.Errorf("the web server backup lost its owner")
					}
					return nil
				},
			},
		},
	})
}
