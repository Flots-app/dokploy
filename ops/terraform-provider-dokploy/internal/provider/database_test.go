package provider

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/knownvalue"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/statecheck"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
	"github.com/hashicorp/terraform-plugin-testing/tfjsonpath"
)

// ------------------------------------------------------------------ fake

// dbPwCall is a changePassword call received by the fake.
type dbPwCall struct{ Router, ID, Password, Type string }

// dbFake teaches the generic fake API what the database routers do on top of
// create/one/update/remove: saveEnvironment, move and the tRPC-only
// changePassword. It also fails the test when the provider sends the API
// something Dokploy would reject or something that must never be sent.
type dbFake struct {
	*fakeAPI
	pw []dbPwCall
}

func (d *dbFake) pwCalls() []dbPwCall {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]dbPwCall(nil), d.pw...)
}

func dbKindByName(t *testing.T, name string) dbKind {
	t.Helper()
	for _, k := range databaseKinds {
		if k.Name == name {
			return k
		}
	}
	t.Fatalf("no database kind %q", name)
	return dbKind{}
}

func dbWriteJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func newDatabaseFake(t *testing.T) (*dbFake, *httptest.Server) {
	f, srv := newFakeAPI(t)
	d := &dbFake{fakeAPI: f}
	for _, k := range databaseKinds {
		k := k
		idKey := k.idKey()
		f.routes[k.Name] = idKey
		f.answer[k.Name] = func(_ *fakeAPI, obj map[string]any) any {
			// What Dokploy fills in on its own.
			base := "db"
			if s, ok := obj["appName"].(string); ok && s != "" {
				base = s
			}
			obj["appName"] = base + "-x1y2z3"
			obj["applicationStatus"] = "idle"
			obj["replicas"] = float64(1)
			for _, key := range []string{"description", "serverId", "externalPort", "command", "args", "env", "cpuLimit", "cpuReservation", "memoryLimit", "memoryReservation",
				"healthCheckSwarm", "restartPolicySwarm", "placementSwarm", "updateConfigSwarm", "rollbackConfigSwarm", "modeSwarm", "labelsSwarm", "networkSwarm",
				"stopGracePeriodSwarm", "endpointSpecSwarm", "ulimitsSwarm"} {
				if _, ok := obj[key]; !ok {
					obj[key] = nil
				}
			}
			return obj
		}
		allowed := k.createKeys()
		f.hooks[k.Name+".create"] = func(_ http.ResponseWriter, body map[string]any) bool {
			for key := range body {
				if !allowed[key] {
					t.Errorf("%s.create received %q, which it does not accept", k.Name, key)
				}
			}
			return false
		}
		f.hooks[k.Name+".update"] = func(_ http.ResponseWriter, body map[string]any) bool {
			for _, key := range []string{"databasePassword", "databaseRootPassword", "environmentId", "serverId", "appName", "applicationStatus", "createdAt", "env"} {
				if _, ok := body[key]; ok {
					t.Errorf("%s.update received %q, it must never be sent", k.Name, key)
				}
			}
			return false
		}
		f.hooks[k.Name+".saveEnvironment"] = func(w http.ResponseWriter, body map[string]any) bool {
			obj := f.objs[k.Name][asString(body[idKey])]
			if obj == nil {
				w.WriteHeader(http.StatusNotFound)
				dbWriteJSON(w, map[string]any{"message": "not found"})
				return true
			}
			obj["env"] = body["env"]
			dbWriteJSON(w, true)
			return true
		}
		f.hooks[k.Name+".move"] = func(w http.ResponseWriter, body map[string]any) bool {
			obj := f.objs[k.Name][asString(body[idKey])]
			if obj == nil {
				w.WriteHeader(http.StatusNotFound)
				dbWriteJSON(w, map[string]any{"message": "not found"})
				return true
			}
			obj["environmentId"] = body["targetEnvironmentId"]
			dbWriteJSON(w, obj)
			return true
		}
		f.hooks["trpc/"+k.Name+".changePassword"] = func(w http.ResponseWriter, body map[string]any) bool {
			in, _ := body["json"].(map[string]any)
			obj := f.objs[k.Name][asString(in[idKey])]
			if obj == nil {
				w.WriteHeader(http.StatusNotFound)
				dbWriteJSON(w, map[string]any{"error": map[string]any{"json": map[string]any{"message": "not found"}}})
				return true
			}
			call := dbPwCall{Router: k.Name, ID: asString(in[idKey]), Password: asString(in["password"]), Type: asString(in["type"])}
			d.pw = append(d.pw, call)
			if call.Type == "root" {
				obj["databaseRootPassword"] = call.Password
			} else {
				obj["databasePassword"] = call.Password
			}
			dbWriteJSON(w, map[string]any{"result": map[string]any{"data": map[string]any{"json": true}}})
			return true
		}
	}
	return d, srv
}

// dbNeverDeploys fails when Terraform asked Dokploy to run anything.
func dbNeverDeploys(t *testing.T, f *fakeAPI) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		for _, banned := range []string{".deploy", ".start", ".stop", ".rebuild", ".reload", ".saveExternalPort", ".changeStatus"} {
			if strings.HasSuffix(c, banned) {
				t.Errorf("Terraform called %s, which would run the database", c)
			}
		}
	}
}

// dbOnlyReads fails when anything but reads reached the API.
func dbOnlyReads(f *fakeAPI) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if !strings.HasSuffix(c, ".one") && c != "organization.active" {
			return fmt.Errorf("adopting the database called %s: it must only read", c)
		}
	}
	return nil
}

// ------------------------------------------------------------- lifecycle

type dbCfg struct {
	Env, Name, Image string
	Password, Root   string
	Version          int
	Extra            string
}

func (c dbCfg) render(k dbKind) string {
	var b strings.Builder
	fmt.Fprintf(&b, "resource \"dokploy_%s\" \"db\" {\n", k.Name)
	fmt.Fprintf(&b, "  environment_id = %q\n  name           = %q\n  docker_image   = %q\n", c.Env, c.Name, c.Image)
	if k.DatabaseName {
		b.WriteString("  database_name  = \"app\"\n")
	}
	if k.DatabaseUser {
		b.WriteString("  database_user  = \"app\"\n")
	}
	if c.Password != "" {
		fmt.Fprintf(&b, "  database_password_wo = %q\n", c.Password)
	}
	if k.RootPassword && c.Root != "" {
		fmt.Fprintf(&b, "  database_root_password_wo = %q\n", c.Root)
	}
	if c.Version != 0 {
		fmt.Fprintf(&b, "  secrets_version = %d\n", c.Version)
	}
	b.WriteString(c.Extra)
	b.WriteString("}\n")
	return b.String()
}

func dbRemoteAttr(f *fakeAPI, router, id, key string) any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.objs[router][id][key]
}

// TestDatabaseLifecycle runs create, update, password rotation, import and
// destroy for each engine.
func TestDatabaseLifecycle(t *testing.T) {
	for _, k := range databaseKinds {
		k := k
		t.Run(k.Name, func(t *testing.T) {
			f, srv := newDatabaseFake(t)
			addr := "dokploy_" + k.Name + ".db"
			create := dbCfg{Env: "env-a", Name: "main", Image: k.ImageExample, Password: "pw-one", Root: "root-one", Version: 1, Extra: `
  description             = "first"
  external_port           = 5400
  memory_limit            = "512m"
  command                 = "run-me"
  args                    = ["--a", "--b"]
  restart_policy_swarm    = jsonencode({ Condition = "on-failure", MaxAttempts = 3 })
  stop_grace_period_swarm = 30000000000
`}
			if k.Name == "mongo" {
				create.Extra += "  replica_sets = true\n"
			}
			update := create
			update.Name, update.Image = "renamed", k.ImageExample+".1"
			update.Extra = strings.NewReplacer(`"first"`, `"second"`, "5400", "0", `"512m"`, `"1g"`, `["--a", "--b"]`, `["--c"]`).Replace(create.Extra)
			rotate := update
			rotate.Password, rotate.Root, rotate.Version = "pw-two", "root-two", 2
			silent := rotate
			silent.Password, silent.Root = "pw-three", "root-three" // same version: nothing to send

			var id string
			resource.UnitTest(t, resource.TestCase{
				ProtoV6ProviderFactories: factories(),
				CheckDestroy: func(*terraform.State) error {
					if f.get(k.Name, id) != nil {
						return fmt.Errorf("%s %s still exists", k.Name, id)
					}
					return nil
				},
				Steps: []resource.TestStep{
					{
						Config: providerBlock(srv.URL) + create.render(k),
						ConfigStateChecks: []statecheck.StateCheck{
							statecheck.ExpectKnownValue(addr, tfjsonpath.New("database_password_wo"), knownvalue.Null()),
							statecheck.ExpectKnownValue(addr, tfjsonpath.New("external_port"), knownvalue.Int64Exact(5400)),
							statecheck.ExpectKnownValue(addr, tfjsonpath.New("application_status"), knownvalue.StringExact("idle")),
							statecheck.ExpectKnownValue(addr, tfjsonpath.New("app_name"), knownvalue.StringExact("db-x1y2z3")),
						},
						Check: func(s *terraform.State) error {
							id = idOf(s, addr)
							r := func(key string) any { return dbRemoteAttr(f.fakeAPI, k.Name, id, key) }
							if r("databasePassword") != "pw-one" {
								return fmt.Errorf("the initial password was not sent on creation")
							}
							if k.RootPassword && r("databaseRootPassword") != "root-one" {
								return fmt.Errorf("the root password was not sent on creation")
							}
							if r("externalPort") != float64(5400) || r("memoryLimit") != "512m" || r("command") != "run-me" {
								return fmt.Errorf("configuration not applied after creation: %v %v %v", r("externalPort"), r("memoryLimit"), r("command"))
							}
							if fmt.Sprint(r("args")) != "[--a --b]" || fmt.Sprint(r("restartPolicySwarm")) != "map[Condition:on-failure MaxAttempts:3]" {
								return fmt.Errorf("args or swarm settings not applied: %v %v", r("args"), r("restartPolicySwarm"))
							}
							if k.Name == "mongo" && r("replicaSets") != true {
								return fmt.Errorf("replica_sets was not sent")
							}
							if f.called(k.Name+".create") != 1 || f.called(k.Name+".update") != 1 {
								return fmt.Errorf("expected one create and one update, got %d and %d", f.called(k.Name+".create"), f.called(k.Name+".update"))
							}
							for _, secret := range []string{"pw-one", "root-one"} {
								if err := notInState(s, secret); err != nil {
									return err
								}
							}
							return nil
						},
					},
					{
						// A plain change: configuration only, the password is
						// not sent again and nothing is redeployed.
						Config: providerBlock(srv.URL) + update.render(k),
						Check: func(s *terraform.State) error {
							r := func(key string) any { return dbRemoteAttr(f.fakeAPI, k.Name, id, key) }
							if r("name") != "renamed" || r("dockerImage") != k.ImageExample+".1" || r("memoryLimit") != "1g" || r("description") != "second" || r("externalPort") != float64(0) {
								return fmt.Errorf("update not applied: %v %v %v", r("name"), r("dockerImage"), r("externalPort"))
							}
							if r("databasePassword") != "pw-one" || len(f.pwCalls()) != 0 {
								return fmt.Errorf("a plain update touched the password")
							}
							return nil
						},
					},
					{
						// Rotation: new value plus a new version, applied to the
						// running server with changePassword.
						Config: providerBlock(srv.URL) + rotate.render(k),
						Check: func(s *terraform.State) error {
							calls := f.pwCalls()
							want := 1
							if k.RootPassword {
								want = 2
							}
							if len(calls) != want {
								return fmt.Errorf("expected %d changePassword calls, got %v", want, calls)
							}
							if calls[0].Password != "pw-two" || calls[0].ID != id {
								return fmt.Errorf("unexpected rotation call %v", calls[0])
							}
							if k.RootPassword && (calls[0].Type != "user" || calls[1].Type != "root" || calls[1].Password != "root-two") {
								return fmt.Errorf("unexpected root rotation %v", calls)
							}
							if !k.RootPassword && calls[0].Type != "" {
								return fmt.Errorf("%s changePassword takes no type, got %q", k.Name, calls[0].Type)
							}
							if dbRemoteAttr(f.fakeAPI, k.Name, id, "databasePassword") != "pw-two" {
								return fmt.Errorf("the password was not rotated")
							}
							for _, secret := range []string{"pw-two", "root-two"} {
								if err := notInState(s, secret); err != nil {
									return err
								}
							}
							return nil
						},
					},
					{
						// A write-only value cannot be diffed: without a version
						// bump nothing happens.
						Config:           providerBlock(srv.URL) + silent.render(k),
						ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
					},
					{
						Config:                  providerBlock(srv.URL) + silent.render(k),
						ResourceName:            addr,
						ImportState:             true,
						ImportStateVerify:       true,
						ImportStateVerifyIgnore: []string{"secrets_version"},
					},
				},
			})
			if n := len(f.pwCalls()); n > 2 {
				t.Errorf("unexpected extra password changes: %d", n)
			}
			dbNeverDeploys(t, f.fakeAPI)
		})
	}
}

// TestDatabaseCreateNeedsPassword: the API needs an initial password, so a
// creation without one fails before anything is created.
func TestDatabaseCreateNeedsPassword(t *testing.T) {
	for _, k := range databaseKinds {
		k := k
		t.Run(k.Name, func(t *testing.T) {
			f, srv := newDatabaseFake(t)
			resource.UnitTest(t, resource.TestCase{
				ProtoV6ProviderFactories: factories(),
				Steps: []resource.TestStep{{
					Config:      providerBlock(srv.URL) + dbCfg{Env: "env-a", Name: "nopw", Image: k.ImageExample}.render(k),
					ExpectError: regexp.MustCompile(`database_password_wo is required`),
				}},
			})
			if n := f.called(k.Name + ".create"); n != 0 {
				t.Errorf("%d create calls reached the API", n)
			}
		})
	}
}

// TestDatabaseCreateRollsBack: when the configuration cannot be applied after
// the creation, the half configured database does not stay in Dokploy.
func TestDatabaseCreateRollsBack(t *testing.T) {
	f, srv := newDatabaseFake(t)
	f.hooks["postgres.update"] = func(w http.ResponseWriter, _ map[string]any) bool {
		w.WriteHeader(http.StatusBadRequest)
		dbWriteJSON(w, map[string]any{"message": "boom"})
		return true
	}
	k := dbKindByName(t, "postgres")
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config:      providerBlock(srv.URL) + dbCfg{Env: "env-a", Name: "x", Image: "postgres:17", Password: "pw-one", Extra: "  memory_limit = \"1g\"\n"}.render(k),
			ExpectError: regexp.MustCompile(`boom`),
		}},
	})
	if f.called("postgres.remove") != 1 || len(f.objs["postgres"]) != 0 {
		t.Errorf("the half created database was left behind: remove called %d times, %d objects", f.called("postgres.remove"), len(f.objs["postgres"]))
	}
}

// TestDatabaseServerChangeReplaces: a database cannot move to another server,
// so changing server_id replaces it.
func TestDatabaseServerChangeReplaces(t *testing.T) {
	f, srv := newDatabaseFake(t)
	k := dbKindByName(t, "postgres")
	cfg := func(server string) string {
		return providerBlock(srv.URL) + dbCfg{Env: "env-a", Name: "main", Image: "postgres:17", Password: "pw-one", Extra: fmt.Sprintf("  server_id = %q\n", server)}.render(k)
	}
	var first string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{Config: cfg("srv-1"), Check: func(s *terraform.State) error { first = idOf(s, "dokploy_postgres.db"); return nil }},
			{
				Config: cfg("srv-2"),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("dokploy_postgres.db", plancheck.ResourceActionDestroyBeforeCreate),
				}},
				Check: func(s *terraform.State) error {
					if idOf(s, "dokploy_postgres.db") == first || f.get("postgres", first) != nil {
						return fmt.Errorf("the database was not replaced")
					}
					return nil
				},
			},
		},
	})
	dbNeverDeploys(t, f.fakeAPI)
}

// TestPostgresEnvironmentAndMove covers what is specific to a service with an
// environment text and a parent: the public/secret split, and the move to
// another environment without redeploying.
func TestPostgresEnvironmentAndMove(t *testing.T) {
	f, srv := newDatabaseFake(t)
	k := dbKindByName(t, "postgres")
	base := dbCfg{Env: "env-a", Name: "main", Image: "postgres:17", Password: "pw-one", Version: 1}
	cfg := func(env, extra string) string {
		c := base
		c.Env, c.Extra = env, extra
		return providerBlock(srv.URL) + c.render(k)
	}
	envText := `
  env             = { TZ = "UTC" }
  secret_env_keys = ["EXTRA_TOKEN"]
  secret_env_wo   = { EXTRA_TOKEN = "fixture-value" }
`
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: cfg("env-a", envText),
				Check: func(s *terraform.State) error {
					id = idOf(s, "dokploy_postgres.db")
					env := fmt.Sprint(dbRemoteAttr(f.fakeAPI, "postgres", id, "env"))
					if !strings.Contains(env, "TZ=UTC") || !strings.Contains(env, "EXTRA_TOKEN=fixture-value") {
						return fmt.Errorf("environment not saved: %q", env)
					}
					return notInState(s, "fixture-value")
				},
			},
			{
				// The environment is declared in full: no drift, empty plan.
				Config: cfg("env-a", strings.Replace(envText, `  secret_env_wo   = { EXTRA_TOKEN = "fixture-value" }`+"\n", "", 1)),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectEmptyPlan(),
				}},
			},
			{
				// Another environment: a move, never a replacement.
				Config: cfg("env-b", strings.Replace(envText, `  secret_env_wo   = { EXTRA_TOKEN = "fixture-value" }`+"\n", "", 1)),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("dokploy_postgres.db", plancheck.ResourceActionUpdate),
				}},
				Check: func(s *terraform.State) error {
					if idOf(s, "dokploy_postgres.db") != id {
						return fmt.Errorf("the database was replaced instead of moved")
					}
					if dbRemoteAttr(f.fakeAPI, "postgres", id, "environmentId") != "env-b" || f.called("postgres.move") != 1 {
						return fmt.Errorf("move not applied: %v, %d calls", dbRemoteAttr(f.fakeAPI, "postgres", id, "environmentId"), f.called("postgres.move"))
					}
					if env := fmt.Sprint(dbRemoteAttr(f.fakeAPI, "postgres", id, "env")); !strings.Contains(env, "EXTRA_TOKEN=fixture-value") {
						return fmt.Errorf("the secret was lost: %q", env)
					}
					return nil
				},
			},
		},
	})
	dbNeverDeploys(t, f.fakeAPI)
}

// ------------------------------------------------------------- adoption

// Trimmed copies of the production objects (postgres.one / redis.one), secrets
// masked as in the sample.
const (
	prodPostgresDB01 = `{
 "appName": "db-pxkqib",
 "applicationStatus": "done",
 "args": null,
 "backups": [{"appName": "backup-parse-digital-pixel-yqafcd", "backupId": "NHV_2MjRSCAV8433-H8Zs", "backupType": "database", "database": "db_flots", "databaseType": "postgres", "destinationId": "sIkOGAjmHIfvGXLT_wheQ", "enabled": true, "keepLatestCount": 24, "postgresId": "2Wi1lNgawg6VqxFAZai9m", "prefix": "/intraday", "schedule": "0 */4 * * *"}],
 "command": null,
 "cpuLimit": null,
 "cpuReservation": null,
 "createdAt": "2025-06-12T16:15:26.265Z",
 "databaseName": "pg-db01",
 "databasePassword": "<redacted:str>",
 "databaseUser": "db_admin",
 "description": "",
 "dockerImage": "postgres:17",
 "endpointSpecSwarm": null,
 "env": null,
 "environment": {"environmentId": "env_prod_bugSRj1IJ6LokzazCsYLt_1757262382.609079", "isDefault": true, "name": "production", "projectId": "bugSRj1IJ6LokzazCsYLt", "project": {"name": "pj-flots-nbg1-hetzner", "projectId": "bugSRj1IJ6LokzazCsYLt"}},
 "environmentId": "env_prod_bugSRj1IJ6LokzazCsYLt_1757262382.609079",
 "externalPort": 5432,
 "healthCheckSwarm": null,
 "labelsSwarm": null,
 "memoryLimit": null,
 "memoryReservation": null,
 "modeSwarm": null,
 "mounts": [{"mountId": "CpZ7macbjYGmEqe3ssdsq", "mountPath": "/var/lib/postgresql/data", "postgresId": "2Wi1lNgawg6VqxFAZai9m", "serviceType": "postgres", "type": "volume", "volumeName": "db-pxkqib-data"}],
 "name": "pg-db01",
 "networkSwarm": null,
 "placementSwarm": null,
 "postgresId": "2Wi1lNgawg6VqxFAZai9m",
 "replicas": 1,
 "restartPolicySwarm": null,
 "rollbackConfigSwarm": null,
 "server": {"appName": "server-transmit-optical-port-7z7wcd", "ipAddress": "172.17.0.1", "name": "ubuntu-8gb-nbg1-1", "port": 22, "serverId": "XXQ2bDvtoMB5PhW51uozD", "serverStatus": "active", "username": "<redacted:str>"},
 "serverId": "XXQ2bDvtoMB5PhW51uozD",
 "stopGracePeriodSwarm": null,
 "ulimitsSwarm": null,
 "updateConfigSwarm": null
}`

	stagingPostgres = `{
 "appName": "staging-pgstagingdb-xsqogw",
 "applicationStatus": "done",
 "args": [],
 "backups": [],
 "command": "",
 "cpuLimit": null,
 "cpuReservation": null,
 "createdAt": "2025-09-04T16:19:00.331Z",
 "databaseName": "flots_api_backend_ppr",
 "databasePassword": "<redacted:str>",
 "databaseUser": "flots_api",
 "description": "",
 "dockerImage": "postgres:17.10",
 "endpointSpecSwarm": null,
 "env": null,
 "environment": {"environmentId": "bJ_qlDFH8Wzpf28XGlSA4", "isDefault": false, "name": "staging", "description": null, "projectId": "bugSRj1IJ6LokzazCsYLt"},
 "environmentId": "bJ_qlDFH8Wzpf28XGlSA4",
 "externalPort": null,
 "healthCheckSwarm": null,
 "labelsSwarm": null,
 "memoryLimit": null,
 "memoryReservation": null,
 "modeSwarm": null,
 "mounts": [{"mountId": "Hk36S3UrXsOBRD-Py_AF1", "mountPath": "/var/lib/postgresql/data", "postgresId": "9aID8QmNh_CmKfhoGKWSH", "serviceType": "postgres", "type": "volume", "volumeName": "staging-pgstagingdb-xsqogw-data"}],
 "name": "pg-staging-db",
 "networkSwarm": null,
 "placementSwarm": null,
 "postgresId": "9aID8QmNh_CmKfhoGKWSH",
 "replicas": 1,
 "restartPolicySwarm": null,
 "rollbackConfigSwarm": null,
 "server": {"appName": "server-transmit-optical-port-7z7wcd", "ipAddress": "172.17.0.1", "name": "ubuntu-8gb-nbg1-1", "serverId": "XXQ2bDvtoMB5PhW51uozD", "username": "<redacted:str>"},
 "serverId": "XXQ2bDvtoMB5PhW51uozD",
 "stopGracePeriodSwarm": null,
 "ulimitsSwarm": null,
 "updateConfigSwarm": null
}`

	prodRedis = `{
 "appName": "app-redis01backend-r0d8n4",
 "applicationStatus": "done",
 "args": null,
 "command": null,
 "cpuLimit": null,
 "cpuReservation": null,
 "createdAt": "2025-07-12T08:51:16.542Z",
 "databasePassword": "<redacted:str>",
 "description": "",
 "dockerImage": "redis:7",
 "endpointSpecSwarm": null,
 "env": null,
 "environment": {"environmentId": "env_prod_bugSRj1IJ6LokzazCsYLt_1757262382.609079", "isDefault": true, "name": "production", "projectId": "bugSRj1IJ6LokzazCsYLt"},
 "environmentId": "env_prod_bugSRj1IJ6LokzazCsYLt_1757262382.609079",
 "externalPort": null,
 "healthCheckSwarm": null,
 "labelsSwarm": null,
 "memoryLimit": null,
 "memoryReservation": null,
 "modeSwarm": null,
 "mounts": [{"mountId": "Rz30jsk0CykoG5e1m1rFh", "mountPath": "/data", "postgresId": null, "redisId": "m4u7ZLHkQ_O2CloiG6SzN", "serviceType": "redis", "type": "volume", "volumeName": "app-redis01backend-r0d8n4-data"}],
 "name": "redis01-backend",
 "networkSwarm": null,
 "placementSwarm": null,
 "redisId": "m4u7ZLHkQ_O2CloiG6SzN",
 "replicas": 1,
 "restartPolicySwarm": null,
 "rollbackConfigSwarm": null,
 "server": {"appName": "server-transmit-optical-port-7z7wcd", "ipAddress": "172.17.0.1", "name": "ubuntu-8gb-nbg1-1", "serverId": "XXQ2bDvtoMB5PhW51uozD", "username": "<redacted:str>"},
 "serverId": "XXQ2bDvtoMB5PhW51uozD",
 "stopGracePeriodSwarm": null,
 "ulimitsSwarm": null,
 "updateConfigSwarm": null
}`
)

// TestDatabaseAdoption imports objects shaped like the production ones with
// the minimal configuration a human writes, and requires an empty plan: no
// attribute left out may produce a diff, and the import must only read.
func TestDatabaseAdoption(t *testing.T) {
	const prodEnv = "env_prod_bugSRj1IJ6LokzazCsYLt_1757262382.609079"
	cases := []struct {
		name, router, sample string
		config               string
		port                 knownvalue.Check // expected external_port
		memoryAfter          string
	}{
		{
			name: "production pg-db01 with an external port, minimal", router: "postgres", sample: prodPostgresDB01,
			config: `
resource "dokploy_postgres" "db" {
  environment_id = "` + prodEnv + `"
  name           = "pg-db01"
  docker_image   = "postgres:17"
  database_name  = "pg-db01"
  database_user  = "db_admin"
}`,
			port: knownvalue.Int64Exact(5432),
		},
		{
			name: "production pg-db01 spelled out", router: "postgres", sample: prodPostgresDB01,
			config: `
resource "dokploy_postgres" "db" {
  environment_id = "` + prodEnv + `"
  name           = "pg-db01"
  description    = ""
  docker_image   = "postgres:17"
  database_name  = "pg-db01"
  database_user  = "db_admin"
  server_id      = "XXQ2bDvtoMB5PhW51uozD"
  external_port  = 5432
  replicas       = 1
}`,
			port: knownvalue.Int64Exact(5432),
		},
		{
			name: "staging postgres, closed port, empty command", router: "postgres", sample: stagingPostgres,
			config: `
resource "dokploy_postgres" "db" {
  environment_id = "bJ_qlDFH8Wzpf28XGlSA4"
  name           = "pg-staging-db"
  docker_image   = "postgres:17.10"
  database_name  = "flots_api_backend_ppr"
  database_user  = "flots_api"
}`,
			port: knownvalue.Null(),
		},
		{
			name: "production redis", router: "redis", sample: prodRedis,
			config: `
resource "dokploy_redis" "db" {
  environment_id = "` + prodEnv + `"
  name           = "redis01-backend"
  docker_image   = "redis:7"
}`,
			port: knownvalue.Null(),
		},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			f, srv := newDatabaseFake(t)
			var sample map[string]any
			if err := json.Unmarshal([]byte(c.sample), &sample); err != nil {
				t.Fatal(err)
			}
			id := f.seed(c.router, sample)
			addr := "dokploy_" + c.router + ".db"
			cfg := providerBlock(srv.URL) + `
import {
  to = ` + addr + `
  id = "` + id + `"
}
` + c.config
			resource.UnitTest(t, resource.TestCase{
				ProtoV6ProviderFactories: factories(),
				Steps: []resource.TestStep{
					{
						Config: cfg,
						ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
							plancheck.ExpectResourceAction(addr, plancheck.ResourceActionNoop),
						}},
						ConfigStateChecks: []statecheck.StateCheck{
							statecheck.ExpectKnownValue(addr, tfjsonpath.New("external_port"), c.port),
							statecheck.ExpectKnownValue(addr, tfjsonpath.New("application_status"), knownvalue.StringExact("done")),
							statecheck.ExpectKnownValue(addr, tfjsonpath.New("database_password_wo"), knownvalue.Null()),
						},
						Check: func(s *terraform.State) error {
							if err := dbOnlyReads(f.fakeAPI); err != nil {
								return err
							}
							// The password Dokploy returns in clear never reaches the state.
							return notInState(s, "<redacted:str>")
						},
					},
					{
						Config:           cfg,
						ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
					},
					{
						// A later change on the adopted object is a plain update
						// that leaves the secrets alone.
						Config: cfg[:len(cfg)-1] + "\n  memory_limit   = \"2g\"\n}",
						Check: func(*terraform.State) error {
							if dbRemoteAttr(f.fakeAPI, c.router, id, "memoryLimit") != "2g" {
								return fmt.Errorf("the update was not applied")
							}
							if dbRemoteAttr(f.fakeAPI, c.router, id, "databasePassword") != "<redacted:str>" {
								return fmt.Errorf("the update touched the password")
							}
							return nil
						},
					},
				},
			})
			dbNeverDeploys(t, f.fakeAPI)
		})
	}
}

// ------------------------------------------------------------- contract

// TestDatabaseSpecsMatchOpenAPI checks the payloads of the five resources
// against the OpenAPI document of the Dokploy fork: every attribute that is
// sent must be a property of the procedure, and nothing the procedure requires
// may be missing. It needs the document (the root of the Dokploy repository,
// or $DOKPLOY_OPENAPI) and is skipped without it.
func TestDatabaseSpecsMatchOpenAPI(t *testing.T) {
	path := os.Getenv("DOKPLOY_OPENAPI")
	if path == "" {
		path = "../../../../openapi.json"
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("no OpenAPI document: %v", err)
	}
	var doc struct {
		Paths map[string]map[string]struct {
			Parameters []struct {
				Name string `json:"name"`
			} `json:"parameters"`
			RequestBody struct {
				Content map[string]struct {
					Schema struct {
						Properties map[string]json.RawMessage `json:"properties"`
						Required   []string                   `json:"required"`
					} `json:"schema"`
				} `json:"content"`
			} `json:"requestBody"`
		} `json:"paths"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	body := func(proc string) (props map[string]bool, required []string) {
		for _, op := range doc.Paths["/"+proc] {
			props = map[string]bool{}
			for key := range op.RequestBody.Content["application/json"].Schema.Properties {
				props[key] = true
			}
			return props, op.RequestBody.Content["application/json"].Schema.Required
		}
		t.Errorf("%s is not in the OpenAPI document", proc)
		return nil, nil
	}
	for _, k := range databaseKinds {
		k := k
		t.Run(k.Name, func(t *testing.T) {
			spec := k.spec()
			sent := map[string]bool{}
			for _, f := range spec.Fields {
				if !f.ReadOnly {
					sent[f.apiKey()] = true
				}
			}
			// Create takes the identity, update everything else but the
			// secrets, the environment (move) and the server.
			create, required := body(k.Name + ".create")
			for key := range k.createKeys() {
				if !create[key] {
					t.Errorf("%s.create has no property %q", k.Name, key)
				}
			}
			for _, key := range required {
				if !k.createKeys()[key] {
					t.Errorf("%s.create requires %q, which the resource does not send", k.Name, key)
				}
			}
			update, _ := body(k.Name + ".update")
			var missing []string
			for key := range sent {
				switch key {
				case dbAPIPassword, dbAPIRootPassword, "environmentId", "serverId":
					continue
				}
				if !update[key] {
					missing = append(missing, key)
				}
			}
			sort.Strings(missing)
			if len(missing) > 0 {
				t.Errorf("%s.update has no property %v", k.Name, missing)
			}
			if props, _ := body(k.Name + ".saveEnvironment"); !props[k.idKey()] || !props["env"] {
				t.Errorf("%s.saveEnvironment does not take %s and env", k.Name, k.idKey())
			}
			if props, _ := body(k.Name + ".move"); !props[k.idKey()] || !props["targetEnvironmentId"] {
				t.Errorf("%s.move does not take %s and targetEnvironmentId", k.Name, k.idKey())
			}
			if props, _ := body(k.Name + ".remove"); !props[k.idKey()] {
				t.Errorf("%s.remove does not take %s", k.Name, k.idKey())
			}
			one := doc.Paths["/"+k.Name+".one"]["get"]
			if len(one.Parameters) != 1 || one.Parameters[0].Name != k.idKey() {
				t.Errorf("%s.one does not take %s", k.Name, k.idKey())
			}
		})
	}
}
