package provider

import (
	"context"
	"fmt"
	"sync"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

// bkCreateMu serializes the creation of backups: backup.create answers
// nothing, so the new id is found by listing the backups of the parent before
// and after, which only works when two creations do not overlap.
var bkCreateMu sync.Mutex

// bkParents lists the services a backup schedule can hang on, with the
// procedure that returns the service together with its backups.
var bkParents = []struct{ api, proc, dbType string }{
	{"postgresId", "postgres.one", "postgres"},
	{"mysqlId", "mysql.one", "mysql"},
	{"mariadbId", "mariadb.one", "mariadb"},
	{"mongoId", "mongo.one", "mongo"},
	{"libsqlId", "libsql.one", "libsql"},
	{"composeId", "compose.one", ""},
}

type bkRef struct {
	BackupID      string `json:"backupId"`
	Prefix        string `json:"prefix"`
	Schedule      string `json:"schedule"`
	Database      string `json:"database"`
	DestinationID string `json:"destinationId"`
	DatabaseType  string `json:"databaseType"`
}

type bkList struct {
	Backups []bkRef `json:"backups"`
}

// bkParentOf returns the parent of a create payload: the service id and the
// procedure to list its backups, or "" for a Dokploy web server backup.
func bkParentOf(body map[string]any) (id, param, proc string) {
	for _, p := range bkParents {
		if v := asString(body[p.api]); v != "" {
			return v, p.api, p.proc
		}
	}
	return "", "", ""
}

// bkListBackups returns the backups of the parent of a create payload. The
// web server backups hang on the user and come from user.getBackups.
func bkListBackups(ctx context.Context, c *client.Client, body map[string]any) ([]bkRef, error) {
	var out bkList
	if id, param, proc := bkParentOf(body); id != "" {
		if err := c.Query(ctx, proc, map[string]any{param: id}, &out); err != nil {
			return nil, err
		}
		return out.Backups, nil
	}
	if err := c.Query(ctx, "user.getBackups", nil, &out); err != nil {
		return nil, err
	}
	web := make([]bkRef, 0, len(out.Backups))
	for _, b := range out.Backups {
		if b.DatabaseType == "web-server" {
			web = append(web, b)
		}
	}
	return web, nil
}

// bkCurrentUserID returns the id of the user the API key acts as: the owner of
// the Dokploy web server backups.
func bkCurrentUserID(ctx context.Context, c *client.Client) (string, error) {
	var out struct {
		UserID string `json:"userId"`
		User   struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	if err := c.Query(ctx, "user.get", nil, &out); err != nil {
		return "", err
	}
	if out.UserID != "" {
		return out.UserID, nil
	}
	if out.User.ID != "" {
		return out.User.ID, nil
	}
	return "", fmt.Errorf("user.get carries no user id")
}

// bkMetadata builds the metadata of a compose backup: the credentials Dokploy
// needs to dump the database of the service.
func bkMetadata(dbType, user, password string) map[string]any {
	switch dbType {
	case "postgres":
		if user != "" {
			return map[string]any{"postgres": map[string]any{"databaseUser": user}}
		}
	case "mariadb", "mongo":
		if user != "" || password != "" {
			return map[string]any{dbType: map[string]any{"databaseUser": user, "databasePassword": password}}
		}
	case "mysql":
		if password != "" {
			return map[string]any{"mysql": map[string]any{"databaseRootPassword": password}}
		}
	}
	return map[string]any{}
}

// bkRemotePassword reads the database password back from the metadata Dokploy
// holds, so an update that does not repeat it keeps it.
func bkRemotePassword(metadata any, dbType string) string {
	m, _ := metadata.(map[string]any)
	sub, _ := m[dbType].(map[string]any)
	for _, k := range []string{"databasePassword", "databaseRootPassword"} {
		if s, ok := sub[k].(string); ok {
			return s
		}
	}
	return ""
}

// bkDatabaseUser extracts the database user out of the metadata.
func bkDatabaseUser(v any) any {
	m, _ := v.(map[string]any)
	for _, t := range []string{"postgres", "mariadb", "mongo"} {
		if sub, ok := m[t].(map[string]any); ok {
			if u, ok := sub["databaseUser"].(string); ok {
				return u
			}
		}
	}
	return nil
}

func init() {
	parent := func(name, kind string) Field {
		return Field{Name: name, Kind: String, ForceNew: true, Desc: "Id of the " + kind + " the backup schedule belongs to. Changing it replaces the schedule."}
	}
	s := &Spec{
		Name: "backup",
		Desc: "A scheduled backup of a database service (postgres, mysql, mariadb, mongo, libsql), of one database of a compose service, " +
			"or of the Dokploy web server itself (database_type = web-server, no service id).",
		IDKey:          "backupId",
		ImportHint:     "Import with the backupId.",
		SecretsVersion: true,
		Fields: []Field{
			{Name: "database_type", Kind: String, Required: true, ForceNew: true, OneOf: []string{"postgres", "mariadb", "mysql", "mongo", "web-server", "libsql"}, Desc: "Kind of database to dump. For a compose backup, the kind of the database service inside the compose; web-server backs up Dokploy itself. Changing it replaces the schedule."},
			{Name: "backup_type", Kind: String, ForceNew: true, OneOf: []string{"database", "compose"}, Desc: "database (default) or compose (a database service inside a compose, needs compose_id and service_name). Changing it replaces the schedule."},
			parent("postgres_id", "Postgres service"),
			parent("mysql_id", "MySQL service"),
			parent("mariadb_id", "MariaDB service"),
			parent("mongo_id", "MongoDB service"),
			parent("libsql_id", "libSQL service"),
			parent("compose_id", "compose service"),
			{Name: "user_id", Kind: String, ForceNew: true, Desc: "Owner of a web server backup; defaults to the user of the API key. Changing it replaces the schedule."},
			{Name: "destination_id", Kind: String, Required: true, Desc: "Id of the dokploy_destination that receives the dumps."},
			{Name: "schedule", Kind: String, Required: true, Desc: "Cron expression of the schedule."},
			{Name: "prefix", Kind: String, Required: true, Desc: "Path prefix of the dumps inside the bucket, for example /daily."},
			{Name: "database", Kind: String, Required: true, Desc: "Name of the database to dump (dokploy for the web server)."},
			{Name: "keep_latest_count", Kind: Int, Desc: "Number of dumps to keep; older ones are deleted. Unlimited when unset."},
			{Name: "enabled", Kind: Bool, Default: true, Desc: "Whether the schedule runs."},
			{Name: "include_encryption_key", Kind: Bool, Default: true, Desc: "Upload the encryption key next to the dumps of an encrypted destination."},
			{Name: "service_name", Kind: String, Desc: "Compose backups only: name of the database service inside the compose file."},
			{Name: "database_user", API: "metadata", Kind: String, FromAPI: bkDatabaseUser, Desc: "Compose backups only (postgres, mariadb, mongo): database user Dokploy dumps with."},
			{Name: "database_password_wo", API: "_databasePassword", Kind: String, WriteOnly: true, Desc: "Compose backups only (mariadb, mongo: user password; mysql: root password): kept by Dokploy; when left out on an update the stored one is kept."},
			{Name: "app_name", Kind: String, ReadOnly: true, Desc: "Internal name Dokploy generated for the schedule."},
		},
	}
	s.UseREST(CRUD{
		Router: "backup",
		// backup.update wants the whole definition (enabled, keepLatestCount,
		// serviceName and metadata are required keys, null allowed) and does
		// not take the parent ids.
		UpdateBody: func(in Input) map[string]any {
			m := overlay(in.Remote, in.Body)
			out := pick(m, "backupId", "schedule", "prefix", "destinationId", "database", "serviceName", "databaseType", "includeEncryptionKey", "keepLatestCount")
			for _, k := range []string{"serviceName", "keepLatestCount"} {
				if _, ok := out[k]; !ok {
					out[k] = nil
				}
			}
			out["enabled"], _ = m["enabled"].(bool)
			dbType := asString(m["databaseType"])
			if bt, _ := bkPlannedString(in.Plan, "backup_type"); bt == "compose" {
				user, _ := bkPlannedString(in.Plan, "database_user")
				pw, ok := bkPlannedString(in.Config, "database_password_wo")
				if !ok {
					pw = bkRemotePassword(in.Remote["metadata"], dbType)
				}
				out["metadata"] = bkMetadata(dbType, user, pw)
			} else {
				out["metadata"] = map[string]any{}
			}
			return out
		},
	})
	s.Create = func(ctx context.Context, c *client.Client, in Input) (string, error) {
		body := in.Body
		dbType := asString(body["databaseType"])
		delete(body, "_databasePassword")
		if _, ok := body["backupType"]; !ok {
			if body["composeId"] != nil {
				body["backupType"] = "compose"
			} else {
				body["backupType"] = "database"
			}
		}
		switch {
		case body["backupType"] == "compose":
			if body["composeId"] == nil || body["serviceName"] == nil {
				return "", fmt.Errorf("a compose backup needs compose_id and service_name")
			}
		case dbType == "web-server":
			if body["userId"] == nil {
				id, err := bkCurrentUserID(ctx, c)
				if err != nil {
					return "", err
				}
				body["userId"] = id
			}
		default:
			if id, _, _ := bkParentOf(body); id == "" {
				return "", fmt.Errorf("database_type %q needs the id of the service to back up (%s_id)", dbType, dbType)
			}
		}
		if _, ok := bkPlannedString(in.Plan, "database_user"); ok && body["backupType"] != "compose" {
			return "", fmt.Errorf("database_user is for compose backups only (backup_type = \"compose\")")
		}
		if body["backupType"] == "compose" {
			user, _ := bkPlannedString(in.Plan, "database_user")
			pw, _ := bkPlannedString(in.Config, "database_password_wo")
			if (dbType == "postgres" || dbType == "mariadb" || dbType == "mongo") && user == "" {
				return "", fmt.Errorf("a compose backup of a %s database needs database_user", dbType)
			}
			if (dbType == "mariadb" || dbType == "mongo" || dbType == "mysql") && pw == "" {
				return "", fmt.Errorf("a compose backup of a %s database needs database_password_wo", dbType)
			}
			body["metadata"] = bkMetadata(dbType, user, pw)
		} else {
			body["metadata"] = map[string]any{}
		}

		bkCreateMu.Lock()
		defer bkCreateMu.Unlock()
		before, err := bkListBackups(ctx, c, body)
		if err != nil {
			return "", err
		}
		known := make(map[string]bool, len(before))
		for _, b := range before {
			known[b.BackupID] = true
		}
		// backup.create answers nothing.
		if err := c.Mutate(ctx, "backup.create", body, nil); err != nil {
			return "", err
		}
		after, err := bkListBackups(ctx, c, body)
		if err != nil {
			return "", fmt.Errorf("the backup was created but the list could not be read (%w): it exists in Dokploy, check the dashboard and import or delete it before applying again", err)
		}
		var fresh []bkRef
		for _, b := range after {
			if !known[b.BackupID] {
				fresh = append(fresh, b)
			}
		}
		for _, b := range fresh {
			if b.Prefix == asString(body["prefix"]) && b.Schedule == asString(body["schedule"]) &&
				b.Database == asString(body["database"]) && b.DestinationID == asString(body["destinationId"]) {
				return b.BackupID, nil
			}
		}
		if len(fresh) == 1 {
			return fresh[0].BackupID, nil
		}
		return "", fmt.Errorf("the backup was created but cannot be found in the backups of its service; import it with its backupId")
	}
	register(s)
}
