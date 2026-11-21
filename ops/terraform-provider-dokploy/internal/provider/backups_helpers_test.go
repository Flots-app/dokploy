package provider

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
)

// Helpers shared by the tests of the destination, registry, backup, volume
// backup and notification resources. The fake API of fakeapi_test.go is
// generic (<router>.create|one|update|remove|all); what these resources do
// differently is added through its hooks, with the validation of the real zod
// schemas (checked against the Dokploy source) so that a payload the real API
// would refuse fails here too.

// bkCalls records the bodies the fake API received, per procedure.
type bkCalls struct {
	mu   sync.Mutex
	list map[string][]map[string]any
}

func (r *bkCalls) add(proc string, body map[string]any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.list == nil {
		r.list = map[string][]map[string]any{}
	}
	cp := make(map[string]any, len(body))
	for k, v := range body {
		cp[k] = v
	}
	r.list[proc] = append(r.list[proc], cp)
}

func (r *bkCalls) last(proc string) map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	l := r.list[proc]
	if len(l) == 0 {
		return nil
	}
	return l[len(l)-1]
}

func (r *bkCalls) count(proc string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.list[proc])
}

func bkReply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func bkBadRequest(w http.ResponseWriter, msg string) bool {
	bkReply(w, http.StatusBadRequest, map[string]any{"message": msg})
	return true
}

// bkRequire emulates a zod object whose keys are all required: a key must be
// present (null allowed when nullable).
func bkRequire(body map[string]any, keys ...string) string {
	var missing []string
	for _, k := range keys {
		if _, ok := body[k]; !ok {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return "Invalid input: expected nonoptional, received undefined: " + strings.Join(missing, ", ")
	}
	return ""
}

// bkAPI is the fake API of these resources.
type bkAPI struct {
	*fakeAPI
	calls *bkCalls
	srv   *httptest.Server
}

// newBackupsAPI returns a fake API that knows destinations, registries,
// backups, volume backups, notifications and the user.
func newBackupsAPI(t *testing.T) *bkAPI {
	f, srv := newFakeAPI(t)
	a := &bkAPI{fakeAPI: f, calls: &bkCalls{}, srv: srv}
	for router, id := range map[string]string{
		"destination": "destinationId", "registry": "registryId", "backup": "backupId",
		"volumeBackups": "volumeBackupId", "notification": "notificationId",
		"postgres": "postgresId", "compose": "composeId",
	} {
		f.routes[router] = id
	}
	// backup.create answers nothing.
	f.answer["backup"] = func(*fakeAPI, map[string]any) any { return nil }

	record := func(proc string, check func(map[string]any) string) {
		f.hooks[proc] = func(w http.ResponseWriter, body map[string]any) bool {
			a.calls.add(proc, body)
			if check != nil {
				if msg := check(body); msg != "" {
					return bkBadRequest(w, msg)
				}
			}
			return false
		}
	}

	destFlags := func(body map[string]any) string {
		if msg := bkRequire(body, "name", "provider", "accessKey", "bucket", "region", "endpoint", "secretAccessKey", "additionalFlags"); msg != "" {
			return msg
		}
		enc, _ := body["encryptionEnabled"].(bool)
		mode := fmt.Sprint(body["encryptionFilenameMode"])
		pw := body["encryptionPassword"] != nil
		switch {
		case !enc && pw:
			return "Encryption passwords require encryption to be enabled"
		case enc && body["encryptionKeyManagement"] == "customer" && !pw:
			return "Encryption password is required for customer-managed keys"
		case enc && body["encryptionKeyManagement"] == "dokploy" && pw:
			return "Encryption passwords must not be supplied for Dokploy-managed keys"
		case enc && mode == "off" && body["encryptionDirectoryNames"] == true:
			return "Directory-name encryption must be disabled when filename encryption is off"
		}
		return ""
	}
	record("destination.create", destFlags)
	record("destination.update", func(body map[string]any) string {
		return bkRequire(body, "name", "accessKey", "bucket", "region", "endpoint", "secretAccessKey", "destinationId", "provider")
	})
	record("registry.create", func(body map[string]any) string {
		if msg := bkRequire(body, "registryName", "username", "password", "registryUrl", "registryType", "imagePrefix"); msg != "" {
			return msg
		}
		if body["password"] == "" {
			return "password: too small"
		}
		return ""
	})
	record("registry.update", nil)
	record("backup.create", func(body map[string]any) string {
		return bkRequire(body, "schedule", "prefix", "destinationId", "database", "databaseType")
	})
	record("backup.update", func(body map[string]any) string {
		return bkRequire(body, "schedule", "enabled", "prefix", "backupId", "destinationId", "database", "keepLatestCount", "serviceName", "metadata", "databaseType")
	})
	record("volumeBackups.create", func(body map[string]any) string {
		return bkRequire(body, "name", "volumeName", "prefix", "cronExpression", "destinationId")
	})
	record("volumeBackups.update", func(body map[string]any) string {
		return bkRequire(body, "name", "volumeName", "prefix", "cronExpression", "destinationId", "volumeBackupId")
	})
	f.hooks["volumeBackups.delete"] = func(w http.ResponseWriter, body map[string]any) bool {
		id, _ := body["volumeBackupId"].(string)
		if f.objs["volumeBackups"][id] == nil {
			return bkReply404(w)
		}
		delete(f.objs["volumeBackups"], id)
		bkReply(w, http.StatusOK, nil)
		return true
	}
	f.hooks["user.get"] = func(w http.ResponseWriter, _ map[string]any) bool {
		bkReply(w, http.StatusOK, map[string]any{"userId": "user-1", "user": map[string]any{"id": "user-1"}})
		return true
	}
	f.hooks["user.getBackups"] = func(w http.ResponseWriter, _ map[string]any) bool {
		bkReply(w, http.StatusOK, map[string]any{"id": "user-1", "backups": a.backupsOf("userId", "user-1"), "apiKeys": []any{}})
		return true
	}
	a.installNotifications()
	return a
}

func bkReply404(w http.ResponseWriter) bool {
	bkReply(w, http.StatusNotFound, map[string]any{"message": "not found"})
	return true
}

// backupsOf lists the stored backups whose key equals id (the lock of the fake
// API is held by the handlers that call it).
func (a *bkAPI) backupsOf(key, id string) []any {
	ids := make([]string, 0)
	for bid, b := range a.objs["backup"] {
		if b[key] == id {
			ids = append(ids, bid)
		}
	}
	sort.Strings(ids)
	out := make([]any, 0, len(ids))
	for _, bid := range ids {
		out = append(out, a.objs["backup"][bid])
	}
	return out
}

// serveParent makes <router>.one answer a service that embeds its backups, as
// the real procedures do (the fake hooks cannot see the query string, so it is
// tied to one service id).
func (a *bkAPI) serveParent(router, idKey, id string) {
	a.hooks[router+".one"] = func(w http.ResponseWriter, _ map[string]any) bool {
		bkReply(w, http.StatusOK, map[string]any{idKey: id, "backups": a.backupsOf(idKey, id)})
		return true
	}
}

// ------------------------------------------------------- notifications

var bkNotifTypes = []string{"discord", "email", "slack", "telegram", "resend", "gotify", "ntfy", "mattermost", "custom", "lark", "teams", "pushover"}

var bkNotifFlags = []string{"appDeploy", "appBuildError", "databaseBackup", "volumeBackup", "dokployRestart", "dokployBackup", "dockerCleanup", "serverThreshold", "githubRunners", "osUpdates"}

// bkNotifRequired are the keys each create<Type> schema requires (checked
// against the real zod schemas).
var bkNotifRequired = map[string][]string{
	"discord":    {"webhookUrl", "decoration"},
	"email":      {"smtpServer", "smtpPort", "username", "password", "fromAddress", "toAddresses"},
	"slack":      {"webhookUrl", "channel"},
	"telegram":   {"botToken", "chatId", "messageThreadId"},
	"resend":     {"apiKey", "fromAddress", "toAddresses"},
	"gotify":     {"serverUrl", "appToken", "priority", "decoration"},
	"ntfy":       {"serverUrl", "topic", "accessToken", "priority"},
	"mattermost": {"webhookUrl"},
	"custom":     {"endpoint"},
	"lark":       {"webhookUrl"},
	"teams":      {"webhookUrl"},
	"pushover":   {"userKey", "apiToken"},
}

// installNotifications adds create<Type> and update<Type> for every type: they
// answer nothing, store the type-specific part in a nested object next to a
// type id, and reproduce the update quirks of the real service.
func (a *bkAPI) installNotifications() {
	f := a.fakeAPI
	for _, typ := range bkNotifTypes {
		typ := typ
		suffix := strings.ToUpper(typ[:1]) + typ[1:]
		isFlag := map[string]bool{"name": true}
		for _, k := range bkNotifFlags {
			isFlag[k] = true
		}
		f.hooks["notification.create"+suffix] = func(w http.ResponseWriter, body map[string]any) bool {
			a.calls.add("notification.create"+suffix, body)
			required := append([]string{"name"}, bkNotifRequired[typ]...)
			if typ != "custom" {
				required = append(required, "appDeploy", "appBuildError", "databaseBackup", "volumeBackup", "dokployRestart", "dokployBackup", "dockerCleanup", "githubRunners", "osUpdates")
				if typ != "gotify" && typ != "ntfy" {
					required = append(required, "serverThreshold")
				}
			}
			if msg := bkRequire(body, required...); msg != "" {
				return bkBadRequest(w, msg)
			}
			obj := map[string]any{"notificationType": typ}
			sub := map[string]any{}
			for _, k := range bkNotifFlags {
				obj[k] = false
			}
			for k, v := range body {
				if isFlag[k] {
					obj[k] = v
				} else {
					sub[k] = v
				}
			}
			sub[typ+"Id"] = fmt.Sprintf("%s-row-%d", typ, f.next+1)
			obj[typ+"Id"] = sub[typ+"Id"]
			obj[typ] = sub
			f.insert("notification", obj)
			bkReply(w, http.StatusOK, nil)
			return true
		}
		f.hooks["notification.update"+suffix] = func(w http.ResponseWriter, body map[string]any) bool {
			a.calls.add("notification.update"+suffix, body)
			id, _ := body["notificationId"].(string)
			obj := f.objs["notification"][id]
			if obj == nil {
				return bkReply404(w)
			}
			if body[typ+"Id"] != obj[typ+"Id"] {
				return bkBadRequest(w, "Invalid input: "+typ+"Id")
			}
			sub, _ := obj[typ].(map[string]any)
			for k, v := range body {
				switch {
				case k == "notificationId" || k == typ+"Id":
				case isFlag[k]:
					obj[k] = v
				default:
					sub[k] = v
				}
			}
			// The real services update the type table with exactly the keys
			// of the input and fail when there is none.
			if (typ == "lark" || typ == "teams") && body["webhookUrl"] == nil {
				return bkBadRequest(w, "No values to set")
			}
			// ntfy resets the access token when the input has none.
			if typ == "ntfy" && body["accessToken"] == nil {
				sub["accessToken"] = nil
			}
			bkReply(w, http.StatusOK, nil)
			return true
		}
	}
}

// notifSub returns the stored type-specific object of a notification.
func (a *bkAPI) notifSub(id, typ string) map[string]any {
	n := a.get("notification", id)
	sub, _ := n[typ].(map[string]any)
	return sub
}
