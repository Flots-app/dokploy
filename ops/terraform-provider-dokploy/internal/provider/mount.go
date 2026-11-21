package provider

import (
	"context"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

// attMountParents maps a service type to the key under which mounts.one
// returns the id of the service.
var attMountParents = map[string]string{
	"application": "applicationId",
	"compose":     "composeId",
	"postgres":    "postgresId",
	"mysql":       "mysqlId",
	"mariadb":     "mariadbId",
	"mongo":       "mongoId",
	"redis":       "redisId",
	"libsql":      "libsqlId",
}

func init() {
	s := &Spec{
		Name:       "mount",
		Desc:       "A volume, bind mount or file mounted into an application, a database or a compose stack. Changes apply on the next deployment of the service.",
		IDKey:      "mountId",
		ImportHint: "Import with the mountId.",
		Fields: []Field{
			{Name: "service_id", Kind: String, Required: true, ForceNew: true, Desc: "Id of the service the mount belongs to. Changing it replaces the mount."},
			{Name: "service_type", Kind: String, Required: true, ForceNew: true, OneOf: attServiceTypes(), Desc: "Kind of that service. Changing it replaces the mount."},
			{Name: "type", Kind: String, Required: true, OneOf: []string{"volume", "bind", "file"}, Desc: "volume (Docker named volume), bind (host directory) or file (a file Dokploy writes next to the service)."},
			{Name: "mount_path", Kind: String, Required: true, Desc: "Path inside the container."},
			{Name: "volume_name", Kind: String, Desc: "Docker volume name, for type volume."},
			{Name: "host_path", Kind: String, Desc: "Directory on the host, for type bind."},
			{Name: "file_path", Kind: String, Desc: "Path of the file relative to the service's files directory, for type file."},
			{Name: "content", Kind: String, Opaque: true, Desc: "Text of the file, for type file. It is stored in the state: keep secrets out of it."},
		},
	}
	s.UseREST(CRUD{
		Router: "mounts",
		// mounts.update would also accept the parent ids; they never change.
		UpdateBody: func(in Input) map[string]any {
			return pick(in.Body, "mountId", "type", "mountPath", "volumeName", "hostPath", "filePath", "content")
		},
	})
	// mounts.create takes serviceId + serviceType, but mounts.one answers with
	// one key per kind of service (postgresId, redisId, ...) and no serviceId:
	// put it back so that service_id can be read, imported and compared.
	read := s.Read
	s.Read = func(ctx context.Context, c *client.Client, id string) (map[string]any, error) {
		remote, err := read(ctx, c, id)
		if err != nil {
			return nil, err
		}
		return overlay(remote, map[string]any{"serviceId": attMountServiceID(remote)}), nil
	}
	registerAttachment(s, attMountCheck)
}

func attServiceTypes() []string {
	return []string{"application", "compose", "postgres", "mysql", "mariadb", "mongo", "redis", "libsql"}
}

// attMountServiceID finds the id of the service a mount belongs to.
func attMountServiceID(remote map[string]any) any {
	if key, ok := attMountParents[asString(remote["serviceType"])]; ok {
		if id := asString(remote[key]); id != "" {
			return id
		}
	}
	for _, key := range attMountParents {
		if id := asString(remote[key]); id != "" {
			return id
		}
	}
	return nil
}

func attMountCheck(cfg Obj, report func(attr, summary, detail string)) {
	kind, ok := stringOf(cfg["type"])
	if !ok {
		return
	}
	need := map[string]string{"volume": "volume_name", "bind": "host_path", "file": "file_path"}[kind]
	if need != "" && !attSet(cfg[need]) {
		report(need, "Attribute required", "A mount of type "+kind+" needs "+need+".")
	}
}
