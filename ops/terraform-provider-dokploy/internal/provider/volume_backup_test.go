package provider

import (
	"fmt"
	"regexp"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

func TestVolumeBackupLifecycle(t *testing.T) {
	a := newBackupsAPI(t)
	cfg := func(cron string, keep int) string {
		return providerBlock(a.srv.URL) + bkDestinationHCL() + fmt.Sprintf(`
resource "dokploy_volume_backup" "v" {
  name              = "uploads"
  volume_name       = "app_uploads"
  prefix            = "/volumes/uploads"
  cron_expression   = %q
  application_id    = "app-1"
  destination_id    = dokploy_destination.d.id
  keep_latest_count = %d
}
`, cron, keep)
	}
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: cfg("0 2 * * *", 7),
				Check: func(s *terraform.State) error {
					id = idOf(s, "dokploy_volume_backup.v")
					v := a.get("volumeBackups", id)
					// The service type is derived from the parent id.
					if v["serviceType"] != "application" || v["enabled"] != true || v["turnOff"] != false || v["volumeName"] != "app_uploads" {
						return fmt.Errorf("unexpected volume backup: %v", v)
					}
					return nil
				},
			},
			{
				Config: cfg("0 3 * * *", 14),
				Check: func(s *terraform.State) error {
					v := a.get("volumeBackups", id)
					if v["cronExpression"] != "0 3 * * *" || v["keepLatestCount"] != float64(14) {
						return fmt.Errorf("not updated: %v", v)
					}
					return nil
				},
			},
			{
				ResourceName:      "dokploy_volume_backup.v",
				ImportState:       true,
				ImportStateVerify: true,
			},
		},
		CheckDestroy: func(s *terraform.State) error {
			if a.get("volumeBackups", id) != nil {
				return fmt.Errorf("the volume backup was not deleted")
			}
			return nil
		},
	})
}

func TestVolumeBackupNeedsOneParent(t *testing.T) {
	a := newBackupsAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config: providerBlock(a.srv.URL) + bkDestinationHCL() + `
resource "dokploy_volume_backup" "v" {
  name            = "x"
  volume_name     = "vol"
  prefix          = "/x"
  cron_expression = "0 2 * * *"
  postgres_id     = "pg-1"
  redis_id        = "redis-1"
  destination_id  = dokploy_destination.d.id
}
`,
			ExpectError: regexp.MustCompile(`exactly one parent id`),
		}},
	})
}

// TestVolumeBackupAdoption imports a volume backup shaped like what
// volumeBackups.one returns (the production Dokploy has none yet): the
// relations are nested, the unused parent ids null.
func TestVolumeBackupAdoption(t *testing.T) {
	a := newBackupsAPI(t)
	dest := a.seed("destination", map[string]any{
		"name": "R2", "provider": "Other", "bucket": "b", "region": "", "endpoint": "https://s3.example.test",
		"accessKey": "AK", "secretAccessKey": "SK", "additionalFlags": nil, "organizationId": "org-1",
	})
	id := a.seed("volumeBackups", map[string]any{
		"name": "pg data", "volumeName": "pg_data", "prefix": "/volumes/pg", "serviceType": "postgres",
		"appName": "volumeBackup-abc123", "serviceName": nil, "turnOff": true, "cronExpression": "0 5 * * 1",
		"keepLatestCount": nil, "enabled": true, "applicationId": nil, "postgresId": "pg-1", "mariadbId": nil,
		"mongoId": nil, "mysqlId": nil, "redisId": nil, "libsqlId": nil, "composeId": nil, "destinationId": dest,
		"postgres": map[string]any{"postgresId": "pg-1", "name": "pg"}, "application": nil, "destination": map[string]any{"destinationId": dest},
	})
	cfg := providerBlock(a.srv.URL) + `
import {
  to = dokploy_volume_backup.pg
  id = "` + id + `"
}
resource "dokploy_volume_backup" "pg" {
  name            = "pg data"
  volume_name     = "pg_data"
  prefix          = "/volumes/pg"
  cron_expression = "0 5 * * 1"
  postgres_id     = "pg-1"
  destination_id  = "` + dest + `"
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: cfg,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("dokploy_volume_backup.pg", plancheck.ResourceActionNoop),
				}},
			},
			{
				Config:           cfg,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
		},
	})
}
