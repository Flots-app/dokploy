package provider

import (
	"context"
	"fmt"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

// vbParents maps the parent id keys of a volume backup to the service type
// Dokploy stores next to them.
var vbParents = []struct{ api, serviceType string }{
	{"applicationId", "application"},
	{"postgresId", "postgres"},
	{"mysqlId", "mysql"},
	{"mariadbId", "mariadb"},
	{"mongoId", "mongo"},
	{"redisId", "redis"},
	{"libsqlId", "libsql"},
	{"composeId", "compose"},
}

func init() {
	parent := func(name, kind string) Field {
		return Field{Name: name, Kind: String, ForceNew: true, Desc: "Id of the " + kind + " whose volume is backed up. Exactly one parent id is required. Changing it replaces the schedule."}
	}
	s := &Spec{
		Name:       "volume_backup",
		Desc:       "A scheduled backup of a Docker volume of a service (application, database or compose) to a dokploy_destination.",
		IDKey:      "volumeBackupId",
		ImportHint: "Import with the volumeBackupId.",
		Fields: []Field{
			{Name: "name", Kind: String, Required: true, Desc: "Name of the volume backup."},
			{Name: "volume_name", Kind: String, Required: true, Desc: "Name of the Docker volume to back up."},
			{Name: "prefix", Kind: String, Required: true, Desc: "Path prefix of the archives inside the bucket."},
			{Name: "cron_expression", Kind: String, Required: true, Desc: "Cron expression of the schedule."},
			{Name: "destination_id", Kind: String, Required: true, Desc: "Id of the dokploy_destination that receives the archives."},
			parent("application_id", "application"),
			parent("postgres_id", "Postgres service"),
			parent("mysql_id", "MySQL service"),
			parent("mariadb_id", "MariaDB service"),
			parent("mongo_id", "MongoDB service"),
			parent("redis_id", "Redis service"),
			parent("libsql_id", "libSQL service"),
			parent("compose_id", "compose service"),
			{Name: "service_type", Kind: String, ForceNew: true, OneOf: []string{"application", "postgres", "mysql", "mariadb", "mongo", "redis", "compose", "libsql"}, Desc: "Kind of the parent service; derived from the parent id when left out."},
			{Name: "service_name", Kind: String, Desc: "Compose volumes: name of the service inside the compose file."},
			{Name: "turn_off", Kind: Bool, Default: false, Desc: "Stop the service while the volume is archived."},
			{Name: "keep_latest_count", Kind: Int, Desc: "Number of archives to keep; older ones are deleted. Unlimited when unset."},
			{Name: "enabled", Kind: Bool, Default: true, Desc: "Whether the schedule runs."},
			{Name: "app_name", Kind: String, ReadOnly: true, Desc: "Internal name Dokploy generated for the schedule."},
			{Name: "created_at", Kind: String, ReadOnly: true, Desc: "Creation date."},
		},
	}
	// volumeBackups.update is a partial update: every field that is present
	// is applied, the others are left alone. volumeBackups.create answers the
	// new object.
	s.UseREST(CRUD{Router: "volumeBackups", DeleteProc: "volumeBackups.delete"})
	create := s.Create
	s.Create = func(ctx context.Context, c *client.Client, in Input) (string, error) {
		var kind string
		n := 0
		for _, p := range vbParents {
			if in.Body[p.api] != nil {
				kind = p.serviceType
				n++
			}
		}
		if n != 1 {
			return "", fmt.Errorf("exactly one parent id (application_id, postgres_id, ...) is required, got %d", n)
		}
		if _, ok := in.Body["serviceType"]; !ok {
			in.Body["serviceType"] = kind
		}
		return create(ctx, c, in)
	}
	register(s)
}
