package provider

func init() {
	s := &Spec{
		Name:       "schedule",
		Desc:       "A cron job Dokploy runs for an application or a compose service (docker exec of command), or on a server or on the Dokploy host itself (the script).",
		IDKey:      "scheduleId",
		ImportHint: "Import with the scheduleId.",
		Fields: []Field{
			{Name: "schedule_type", Kind: String, Required: true, ForceNew: true, OneOf: []string{"application", "compose", "server", "dokploy-server"}, Desc: "Where the job runs: in an application container, in a compose service, on a remote server, or on the Dokploy host. Changing it replaces the schedule."},
			{Name: "application_id", Kind: String, ForceNew: true, Desc: "Application, for schedule_type application. Changing it replaces the schedule."},
			{Name: "compose_id", Kind: String, ForceNew: true, Desc: "Compose stack, for schedule_type compose. Changing it replaces the schedule."},
			{Name: "server_id", Kind: String, ForceNew: true, Desc: "Remote server, for schedule_type server. Changing it replaces the schedule."},
			{Name: "name", Kind: String, Required: true, Desc: "Name of the job."},
			{Name: "description", Kind: String, Desc: "Free text."},
			{Name: "cron_expression", Kind: String, Required: true, Desc: "Cron expression, for example 0 2 * * *."},
			{Name: "command", Kind: String, Required: true, Desc: "Command run through shell_type inside the container. It is stored in the state: read secrets from the container's environment instead of writing them here. Required by Dokploy for host schedules too, which run script."},
			{Name: "shell_type", Kind: String, OneOf: []string{"bash", "sh"}, Desc: "Shell that runs the command (Dokploy's default is bash)."},
			{Name: "script", Kind: String, Opaque: true, Desc: "Shell script of a server or dokploy-server schedule."},
			{Name: "service_name", Kind: String, Desc: "Service of the compose stack the command runs in, for schedule_type compose."},
			{Name: "timezone", Kind: String, Desc: "IANA time zone of the cron expression (UTC when left unset)."},
			{Name: "enabled", Kind: Bool, Desc: "Whether the job runs (Dokploy's default is true)."},
			{Name: "app_name", Kind: String, ReadOnly: true, Desc: "Generated technical name of the job, used for its script directory."},
			{Name: "created_at", Kind: String, ReadOnly: true, Desc: "Creation date."},
		},
	}
	s.UseREST(CRUD{Router: "schedule", DeleteProc: "schedule.delete"})
	registerAttachment(s, attScheduleCheck)
}

func attScheduleCheck(cfg Obj, report func(attr, summary, detail string)) {
	kind, ok := stringOf(cfg["schedule_type"])
	if !ok {
		return
	}
	parent := map[string]string{"application": "application_id", "compose": "compose_id", "server": "server_id"}[kind]
	if parent != "" && !attSet(cfg[parent]) {
		report(parent, "Parent id required", "A schedule of type "+kind+" needs "+parent+".")
	}
	for _, other := range []string{"application_id", "compose_id", "server_id"} {
		if other != parent && attSet(cfg[other]) {
			if parent == "" {
				report(other, "Unexpected parent id", "A schedule of type "+kind+" is not attached to an application, a compose stack or a server.")
			} else {
				report(other, "Unexpected parent id", "A schedule of type "+kind+" only takes "+parent+".")
			}
		}
	}
}
