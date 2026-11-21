package provider

import (
	"context"
	"fmt"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

// The maintenance window of a configuration is one object in the API whose
// omitted keys get defaults; the schema flattens it so that a partial window
// written by hand still matches what the API reports.
var rnOsUpdateGroups = []rnGroup{{
	Key: "schedule",
	Fields: map[string]string{
		"recurrence": "recurrence", "startTime": "startTime", "timeZone": "timeZone", "durationMinutes": "durationMinutes",
		"weekdays": "weekdays", "monthlyMode": "monthlyMode", "monthDay": "monthDay", "monthWeek": "monthWeek", "monthWeekday": "monthWeekday",
	},
}}

func init() {
	s := &Spec{
		Name: "os_update_configuration",
		Desc: "An OS updates maintenance configuration (Flots fork of Dokploy): when the servers and the Linux runner machines assigned to it install their OS updates, and which ones. " +
			"The machines assigned to it are part of the configuration: a machine not listed leaves it.",
		IDKey:      "osUpdateConfigurationId",
		ImportHint: "Import with the osUpdateConfigurationId.",
		Fields: []Field{
			{Name: "name", Kind: String, Required: true, Desc: "Name of the configuration, unique in the organization."},
			{Name: "description", Kind: String, FromAPI: rnStrFrom, ToAPI: rnStrTo, Desc: "Free text. Empty for none."},
			{Name: "enabled", Kind: Bool, Desc: "Whether the machines install in its windows."},
			{Name: "recurrence", Kind: String, Required: true, OneOf: []string{"daily", "weekly", "monthly"}, Desc: "Window recurrence."},
			{Name: "start_time", Kind: String, Required: true, Desc: "Start of the window, 24-hour HH:MM in time_zone."},
			{Name: "time_zone", Kind: String, Required: true, Desc: "IANA time zone of start_time, such as Europe/Paris."},
			{Name: "duration_minutes", Kind: Int, Required: true, Desc: "Length of the window, 60 to 720 minutes."},
			{Name: "weekdays", Kind: JSON, Desc: "JSON array of the days of the week for a weekly recurrence, 0 for Sunday: jsonencode([1, 3])."},
			{Name: "monthly_mode", Kind: String, OneOf: []string{"day", "weekday"}, Desc: "Monthly recurrence: on a day of the month, or on the nth weekday."},
			{Name: "month_day", Kind: Int, Desc: "Monthly recurrence, mode day: 1 to 31, or -1 for the last day."},
			{Name: "month_week", Kind: Int, Desc: "Monthly recurrence, mode weekday: 1 to 4, or -1 for the last one."},
			{Name: "month_weekday", Kind: Int, Desc: "Monthly recurrence, mode weekday: day of the week, 0 for Sunday."},
			{Name: "classification", Kind: String, OneOf: []string{"security", "all"}, Desc: "security installs the updates of a security pocket only; all installs every update."},
			{Name: "include_packages", Kind: StringSet, Desc: "When not empty, only the packages matching one of these patterns (glob) are updated."},
			{Name: "exclude_packages", Kind: StringSet, Desc: "Packages matching one of these patterns (glob) are never updated."},
			{Name: "reboot", Kind: String, OneOf: []string{"if-required", "never", "always"}, Desc: "When to reboot after the installation."},
			{Name: "allow_docker_updates", Kind: Bool, Desc: "Allow the updates of Docker's packages, which restart every container of the server."},
			{Name: "notify_on_success", Kind: Bool, Desc: "Notify when a run succeeds, not only when it fails."},
			{Name: "server_ids", Kind: StringSet, Desc: "Dokploy servers assigned to the configuration (a server has one configuration at most)."},
			{Name: "runner_node_ids", Kind: StringSet, Desc: "Linux GitHub runner machines assigned to the configuration; each is drained during its window."},
			{Name: "created_at", Kind: String, ReadOnly: true, Desc: "Creation date."},
		},
	}
	s.Read = func(ctx context.Context, c *client.Client, id string) (map[string]any, error) {
		var out map[string]any
		if err := c.TRPCQuery(ctx, "osUpdate.overview", nil, &out); err != nil {
			return nil, err
		}
		list := make([]map[string]any, 0)
		raw, _ := out["configurations"].([]any)
		for _, o := range raw {
			if m := rnMap(o); m != nil {
				list = append(list, m)
			}
		}
		cfg, err := rnFind(list, "osUpdateConfigurationId", id)
		if err != nil {
			return nil, err
		}
		flat := rnFlatten(cfg, rnOsUpdateGroups)
		flat["serverIds"] = rnIDs(cfg["servers"], "serverId")
		flat["runnerNodeIds"] = rnIDs(cfg["runnerNodes"], "githubRunnerNodeId")
		return flat, nil
	}
	s.Create = func(ctx context.Context, c *client.Client, in Input) (string, error) {
		var out map[string]any
		if err := c.TRPCMutate(ctx, "osUpdate.createConfiguration", rnNest(in.Body, nil, rnOsUpdateGroups), &out); err != nil {
			return "", err
		}
		id := asString(out["osUpdateConfigurationId"])
		if id == "" {
			return "", fmt.Errorf("the API answer carries no osUpdateConfigurationId")
		}
		return id, nil
	}
	s.Update = func(ctx context.Context, c *client.Client, in Input) error {
		// The procedure takes the whole configuration, machines included: a
		// machine left out of the payload leaves the configuration.
		body := rnNest(in.Body, in.Remote, rnOsUpdateGroups)
		for _, k := range []string{"serverIds", "runnerNodeIds"} {
			if _, ok := body[k]; !ok {
				body[k] = in.Remote[k]
			}
		}
		return c.TRPCMutate(ctx, "osUpdate.updateConfiguration", body, nil)
	}
	s.Delete = func(ctx context.Context, c *client.Client, id string) error {
		return c.TRPCMutate(ctx, "osUpdate.removeConfiguration", map[string]any{"osUpdateConfigurationId": id}, nil)
	}
	register(s)
}

// rnIDs lists the idKey of the objects of an API list.
func rnIDs(list any, idKey string) []any {
	out := []any{}
	items, _ := list.([]any)
	for _, o := range items {
		if id := asString(rnMap(o)[idKey]); id != "" {
			out = append(out, id)
		}
	}
	return out
}
