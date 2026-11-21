package provider

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

// Notifications come in twelve flavours (discord, email, ...). Each one is a
// row of the notification table (name and event flags) plus a row of a
// type-specific table (webhook URL, SMTP settings, ...) and has its own
// create<Type> / update<Type> procedures; they all share notification.one,
// notification.all and notification.remove. One builder turns a description of
// the type-specific part into a resource.
//
// Quirks of the API this file works around:
//   - create<Type> answers nothing: the new id is found in notification.all;
//   - update<Type> wants the type-specific id read from notification.one;
//   - notification.one and notification.all return the secrets in clear: they
//     are never mapped to attributes (every secret is a write-only <x>_wo);
//   - some updates cannot omit their secret (lark, teams: "No values to set";
//     ntfy: the access token is reset to null), so the secrets the provider is
//     not given are read back from notification.one and sent again unchanged.

// notifCreateMu serializes the creations: the new id is found by comparing
// notification.all before and after.
var notifCreateMu sync.Mutex

type notifKind struct {
	// typ is the notification type: "discord", "email", ...
	typ string
	// desc describes the resource.
	desc string
	// fields are the type-specific attributes.
	fields []Field
	// noThreshold removes the server_threshold flag, which gotify and ntfy do
	// not support.
	noThreshold bool
	// requiredSecrets are the write-only attributes needed to create one.
	requiredSecrets []string
	// patchCreate adjusts the create payload.
	patchCreate func(body map[string]any)
}

// notifFlags are the events a notification can subscribe to.
var notifFlags = []struct{ name, desc string }{
	{"app_deploy", "Notify when an application is deployed."},
	{"app_build_error", "Notify when an application build fails."},
	{"database_backup", "Notify about database backups."},
	{"volume_backup", "Notify about volume backups."},
	{"dokploy_restart", "Notify when Dokploy restarts."},
	{"dokploy_backup", "Notify about Dokploy web server backups."},
	{"docker_cleanup", "Notify about Docker cleanups."},
	{"server_threshold", "Notify when a server crosses its CPU or memory threshold."},
	{"github_runners", "Notify about GitHub runner events."},
	{"os_updates", "Notify about operating system updates of the servers."},
}

func (k notifKind) spec() *Spec {
	suffix := strings.ToUpper(k.typ[:1]) + k.typ[1:] // createDiscord, updateDiscord, ...
	fields := []Field{{Name: "name", Kind: String, Required: true, Desc: "Name of the notification."}}
	for _, f := range notifFlags {
		if f.name == "server_threshold" && k.noThreshold {
			continue
		}
		fields = append(fields, Field{Name: f.name, Kind: Bool, Default: false, Desc: f.desc + " Off unless set."})
	}
	fields = append(fields, k.fields...)
	fields = append(fields, Field{Name: "created_at", Kind: String, ReadOnly: true, Desc: "Creation date."})

	idKey := k.typ + "Id" // discordId, emailId, ...
	secrets := map[string]Field{}
	for _, f := range fields {
		if f.WriteOnly {
			secrets[f.Name] = f
		}
	}

	s := &Spec{
		Name:           "notification_" + k.typ,
		Desc:           k.desc,
		IDKey:          "notificationId",
		ImportHint:     "Import with the notificationId.",
		SecretsVersion: true,
		Fields:         fields,
	}
	s.Read = func(ctx context.Context, c *client.Client, id string) (map[string]any, error) {
		var out map[string]any
		if err := c.Query(ctx, "notification.one", map[string]any{"notificationId": id}, &out); err != nil {
			return nil, err
		}
		if out == nil {
			return nil, client.ErrNotFound
		}
		if t := asString(out["notificationType"]); t != k.typ {
			return nil, fmt.Errorf("notification %s is of type %q: manage it with dokploy_notification_%s", id, t, t)
		}
		return notifFlatten(out, k.typ), nil
	}
	s.Create = func(ctx context.Context, c *client.Client, in Input) (string, error) {
		body := in.Body
		for _, name := range k.requiredSecrets {
			if _, ok := body[secrets[name].apiKey()]; !ok {
				return "", fmt.Errorf("%s is required to create a notification of type %s", name, k.typ)
			}
		}
		if k.patchCreate != nil {
			k.patchCreate(body)
		}
		notifCreateMu.Lock()
		defer notifCreateMu.Unlock()
		before, err := notifList(ctx, c, k.typ)
		if err != nil {
			return "", err
		}
		known := make(map[string]bool, len(before))
		for _, n := range before {
			known[n.ID] = true
		}
		// create<Type> answers nothing.
		if err := c.Mutate(ctx, "notification.create"+suffix, body, nil); err != nil {
			return "", err
		}
		after, err := notifList(ctx, c, k.typ)
		if err != nil {
			return "", err
		}
		var fresh []notifRef
		for _, n := range after {
			if !known[n.ID] {
				fresh = append(fresh, n)
			}
		}
		for _, n := range fresh {
			if n.Name == asString(body["name"]) {
				return n.ID, nil
			}
		}
		if len(fresh) == 1 {
			return fresh[0].ID, nil
		}
		return "", fmt.Errorf("the notification was created but cannot be found in notification.all; import it with its notificationId")
	}
	s.Update = func(ctx context.Context, c *client.Client, in Input) error {
		body := in.Body
		body[idKey] = in.Remote[idKey]
		// Send again the secrets that are not configured: see the comment at
		// the top of the file.
		for _, f := range secrets {
			if _, ok := body[f.apiKey()]; !ok {
				if v := in.Remote[f.apiKey()]; v != nil {
					body[f.apiKey()] = v
				}
			}
		}
		return c.Mutate(ctx, "notification.update"+suffix, body, nil)
	}
	s.Delete = func(ctx context.Context, c *client.Client, id string) error {
		return c.Mutate(ctx, "notification.remove", map[string]any{"notificationId": id}, nil)
	}
	return s
}

// notifFlatten merges the type-specific object (notification.discord, ...)
// into the notification, so the Fields can read both at the top level.
func notifFlatten(obj map[string]any, typ string) map[string]any {
	out := make(map[string]any, len(obj)+4)
	for k, v := range obj {
		out[k] = v
	}
	if sub, ok := obj[typ].(map[string]any); ok {
		for k, v := range sub {
			if _, exists := out[k]; !exists || out[k] == nil {
				out[k] = v
			}
		}
	}
	return out
}

type notifRef struct {
	ID   string `json:"notificationId"`
	Name string `json:"name"`
	Type string `json:"notificationType"`
}

// notifList lists the notifications of a type. Only the id, name and type are
// decoded: notification.all carries the secrets in clear.
func notifList(ctx context.Context, c *client.Client, typ string) ([]notifRef, error) {
	var all []notifRef
	if err := c.Query(ctx, "notification.all", nil, &all); err != nil {
		return nil, err
	}
	out := all[:0]
	for _, n := range all {
		if n.Type == typ {
			out = append(out, n)
		}
	}
	return out, nil
}

func init() {
	// webhook is the field of the types that only carry a webhook URL.
	webhook := func(what string) Field {
		return Field{Name: "webhook_url_wo", API: "webhookUrl", Kind: String, WriteOnly: true, Desc: what + " Required on creation; when left out on an update, the value Dokploy holds is kept."}
	}
	kinds := []notifKind{
		{
			typ:  "discord",
			desc: "A Discord notification. The webhook URL is write-only: Dokploy keeps it, Terraform never stores it.",
			fields: []Field{
				webhook("Discord webhook URL."),
				{Name: "decoration", Kind: Bool, Default: true, Desc: "Decorate the messages with emojis."},
			},
			requiredSecrets: []string{"webhook_url_wo"},
		},
		{
			typ:  "email",
			desc: "An SMTP email notification. The SMTP password is write-only: Dokploy keeps it, Terraform never stores it.",
			fields: []Field{
				{Name: "smtp_server", Kind: String, Required: true, Desc: "SMTP server host."},
				{Name: "smtp_port", Kind: Int, Required: true, Desc: "SMTP server port."},
				{Name: "username", Kind: String, Required: true, Desc: "SMTP user name."},
				{Name: "password_wo", API: "password", Kind: String, WriteOnly: true, Desc: "SMTP password. Required on creation; when left out on an update, the password Dokploy holds is kept."},
				{Name: "from_address", Kind: String, Required: true, Desc: "Sender address."},
				{Name: "to_addresses", Kind: StringList, Required: true, Desc: "Recipient addresses (at least one)."},
			},
			requiredSecrets: []string{"password_wo"},
		},
		{
			typ:  "slack",
			desc: "A Slack notification. The webhook URL is write-only: Dokploy keeps it, Terraform never stores it.",
			fields: []Field{
				webhook("Slack webhook URL."),
				{Name: "channel", Kind: String, Default: "", Desc: "Slack channel."},
			},
			requiredSecrets: []string{"webhook_url_wo"},
		},
		{
			typ:  "telegram",
			desc: "A Telegram notification. The bot token is write-only: Dokploy keeps it, Terraform never stores it.",
			fields: []Field{
				{Name: "bot_token_wo", API: "botToken", Kind: String, WriteOnly: true, Desc: "Telegram bot token. Required on creation; when left out on an update, the token Dokploy holds is kept."},
				{Name: "chat_id", Kind: String, Required: true, Desc: "Telegram chat id."},
				{Name: "message_thread_id", Kind: String, Default: "", Desc: "Telegram topic (message thread) id."},
			},
			requiredSecrets: []string{"bot_token_wo"},
		},
		{
			typ:  "resend",
			desc: "A Resend email notification. The API key is write-only: Dokploy keeps it, Terraform never stores it.",
			fields: []Field{
				{Name: "api_key_wo", API: "apiKey", Kind: String, WriteOnly: true, Desc: "Resend API key. Required on creation; when left out on an update, the key Dokploy holds is kept."},
				{Name: "from_address", Kind: String, Required: true, Desc: "Sender address."},
				{Name: "to_addresses", Kind: StringList, Required: true, Desc: "Recipient addresses (at least one)."},
			},
			requiredSecrets: []string{"api_key_wo"},
		},
		{
			typ:         "gotify",
			desc:        "A Gotify notification. The application token is write-only: Dokploy keeps it, Terraform never stores it. Gotify has no server_threshold event.",
			noThreshold: true,
			fields: []Field{
				{Name: "server_url", Kind: String, Required: true, Desc: "Gotify server URL."},
				{Name: "app_token_wo", API: "appToken", Kind: String, WriteOnly: true, Desc: "Gotify application token. Required on creation; when left out on an update, the token Dokploy holds is kept."},
				{Name: "priority", Kind: Int, Default: 5, Desc: "Message priority (at least 1)."},
				{Name: "decoration", Kind: Bool, Default: true, Desc: "Decorate the messages with emojis."},
			},
			requiredSecrets: []string{"app_token_wo"},
		},
		{
			typ:         "ntfy",
			desc:        "An ntfy notification. The access token is write-only: Dokploy keeps it, Terraform never stores it. ntfy has no server_threshold event.",
			noThreshold: true,
			fields: []Field{
				{Name: "server_url", Kind: String, Required: true, Desc: "ntfy server URL."},
				{Name: "topic", Kind: String, Required: true, Desc: "ntfy topic."},
				{Name: "access_token_wo", API: "accessToken", Kind: String, WriteOnly: true, Desc: "Optional ntfy access token; when left out on an update, the token Dokploy holds is kept."},
				{Name: "priority", Kind: Int, Default: 3, Desc: "Message priority (at least 1)."},
			},
			// notification.createNtfy requires the key even without a token.
			patchCreate: func(body map[string]any) {
				if _, ok := body["accessToken"]; !ok {
					body["accessToken"] = ""
				}
			},
		},
		{
			typ:  "mattermost",
			desc: "A Mattermost notification. The webhook URL is write-only: Dokploy keeps it, Terraform never stores it.",
			fields: []Field{
				webhook("Mattermost webhook URL."),
				{Name: "channel", Kind: String, Desc: "Channel to post to."},
				{Name: "username", Kind: String, Desc: "User name the messages are posted as."},
			},
			requiredSecrets: []string{"webhook_url_wo"},
		},
		{
			typ:  "custom",
			desc: "A custom webhook notification. The headers are write-only (they usually carry a token): Dokploy keeps them, Terraform never stores them; header_names lists their names.",
			fields: []Field{
				{Name: "endpoint", Kind: String, Required: true, Desc: "URL the notifications are POSTed to."},
				{Name: "headers_wo", API: "headers", Kind: StringMap, WriteOnly: true, Desc: "HTTP headers sent with every notification. When left out on an update, the headers Dokploy holds are kept."},
				{Name: "header_names", API: "headers", Kind: StringSet, ReadOnly: true, FromAPI: notifHeaderNames, Volatile: true, Desc: "Names of the headers Dokploy holds, reported for drift detection."},
			},
		},
		{
			typ:  "lark",
			desc: "A Lark notification. The webhook URL is write-only: Dokploy keeps it, Terraform never stores it.",
			fields: []Field{
				webhook("Lark webhook URL."),
			},
			requiredSecrets: []string{"webhook_url_wo"},
		},
		{
			typ:  "teams",
			desc: "A Microsoft Teams notification. The webhook URL is write-only: Dokploy keeps it, Terraform never stores it.",
			fields: []Field{
				webhook("Teams webhook URL."),
			},
			requiredSecrets: []string{"webhook_url_wo"},
		},
		{
			typ:  "pushover",
			desc: "A Pushover notification. The user key and API token are write-only: Dokploy keeps them, Terraform never stores them.",
			fields: []Field{
				{Name: "user_key_wo", API: "userKey", Kind: String, WriteOnly: true, Desc: "Pushover user key. Required on creation; when left out on an update, the key Dokploy holds is kept."},
				{Name: "api_token_wo", API: "apiToken", Kind: String, WriteOnly: true, Desc: "Pushover API token. Required on creation; when left out on an update, the token Dokploy holds is kept."},
				{Name: "priority", Kind: Int, Default: 0, Desc: "Message priority, from -2 to 2 (2, emergency, needs retry and expire)."},
				{Name: "retry", Kind: Int, Desc: "Emergency priority: seconds between retries (at least 30)."},
				{Name: "expire", Kind: Int, Desc: "Emergency priority: seconds before the retries stop (at most 10800)."},
			},
			requiredSecrets: []string{"user_key_wo", "api_token_wo"},
		},
	}
	for _, k := range kinds {
		register(k.spec())
	}
}

// notifHeaderNames turns the headers object into the sorted list of its names.
func notifHeaderNames(v any) any {
	m, _ := v.(map[string]any)
	names := make([]string, 0, len(m))
	for k := range m {
		names = append(names, k)
	}
	sort.Strings(names)
	out := make([]any, 0, len(names))
	for _, n := range names {
		out = append(out, n)
	}
	return out
}
