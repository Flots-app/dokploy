package provider

import (
	"context"
	"errors"
	"fmt"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

// The five database services of Dokploy (postgres, mysql, mariadb, mongo,
// redis) share one data model and one set of procedures, so one builder turns
// a small description (dbKind) into the Spec of each resource.
//
// Terraform only manages the CONFIGURATION of a database. It never deploys,
// starts, stops, rebuilds or reloads one: creating the object leaves the
// service idle, and a change of image, port, resources or environment is
// picked up by the next deployment, triggered from Dokploy. Therefore:
//
//   - the external port is written with <router>.update, never with
//     <router>.saveExternalPort, which deploys the database;
//   - a password rotation goes through <router>.changePassword, which only
//     runs a command in the already running container (and fails otherwise).

// dbKind describes one database engine.
type dbKind struct {
	// Name is the resource suffix and the tRPC router: "postgres" gives
	// dokploy_postgres, postgres.create and the id key postgresId.
	Name string
	// Title is the product name used in descriptions.
	Title string
	// ImageExample is an example docker image, for the descriptions.
	ImageExample string
	// DataPath is the directory Dokploy mounts the data volume on.
	DataPath string
	// DatabaseName and DatabaseUser tell which identity attributes the engine
	// has (redis has none, mongo only a user).
	DatabaseName, DatabaseUser bool
	// RootPassword adds the write-only root password (mysql, mariadb).
	RootPassword bool
	// Extra are engine specific attributes; ExtraCreate lists the API keys of
	// those that <router>.create accepts (the others go through update).
	Extra       []Field
	ExtraCreate []string
}

func (k dbKind) idKey() string { return k.Name + "Id" }

// databaseKinds lists the registered engines (the tests iterate over it).
var databaseKinds []dbKind

// registerDatabase builds and registers the resource of one engine.
func registerDatabase(k dbKind) {
	databaseKinds = append(databaseKinds, k)
	register(k.spec())
}

// API keys of the secrets of a database.
const (
	dbAPIPassword     = "databasePassword"
	dbAPIRootPassword = "databaseRootPassword"
)

func (k dbKind) fields() []Field {
	fs := []Field{
		{Name: "environment_id", Kind: String, Required: true, Desc: "Environment of a project the database lives in. Changing it moves the database to another environment; nothing is redeployed."},
		{Name: "name", Kind: String, Required: true, Desc: "Display name of the database in Dokploy."},
		{Name: "description", Kind: String, Desc: "Free text."},
		{Name: "docker_image", Kind: String, Required: true, Desc: fmt.Sprintf("Docker image of the %s server, for example %q. Pin the version: Dokploy applies the image at the next deployment.", k.Title, k.ImageExample)},
	}
	if k.DatabaseName {
		fs = append(fs, Field{Name: "database_name", Kind: String, Required: true, Desc: "Name of the database created in the server. Dokploy only uses it when the data volume is initialised."})
	}
	if k.DatabaseUser {
		fs = append(fs, Field{Name: "database_user", Kind: String, Required: true, Desc: "User created in the server. Dokploy only uses it when the data volume is initialised."})
	}
	who := "the database user"
	if k.Name == "redis" {
		who = "the Redis server"
	}
	pwDesc := "Password of " + who + ". Required on creation (Dokploy keeps it, Terraform never stores it); ignored afterwards unless secrets_version changes, then it is applied to the running server with changePassword (the container must be running). Must not contain $ ! ' \" \\ / or spaces."
	fs = append(fs, Field{Name: "database_password_wo", API: dbAPIPassword, Kind: String, WriteOnly: true, Desc: pwDesc})
	if k.RootPassword {
		fs = append(fs, Field{Name: "database_root_password_wo", API: dbAPIRootPassword, Kind: String, WriteOnly: true, Desc: "Password of the root user. Optional on creation (Dokploy generates one when it is left out); applied to the running server with changePassword when secrets_version changes."})
	}
	fs = append(fs, k.Extra...)
	fs = append(fs,
		Field{Name: "server_id", Kind: String, ForceNew: true, Desc: "Remote server the database runs on; left out, it runs on the Dokploy host. Changing it replaces the database."},
		Field{Name: "external_port", Kind: Int, Desc: "TCP port published on the host so the database is reachable from outside; 0 or no port means closed. Takes effect at the next deployment: Terraform writes it with update, never with saveExternalPort (which deploys), so Dokploy does not check that the port is free. Left out, the value reported by Dokploy is kept."},
		Field{Name: "replicas", Kind: Int, Desc: "Number of Swarm replicas."},
		Field{Name: "cpu_limit", Kind: String, Desc: "CPU limit of the container, as the Dokploy form takes it (for example \"1\")."},
		Field{Name: "cpu_reservation", Kind: String, Desc: "CPU reservation of the container."},
		Field{Name: "memory_limit", Kind: String, Desc: "Memory limit of the container, as the Dokploy form takes it (for example \"1g\")."},
		Field{Name: "memory_reservation", Kind: String, Desc: "Memory reservation of the container."},
		Field{Name: "command", Kind: String, Desc: "Overrides the entrypoint command of the image."},
		Field{Name: "args", Kind: StringList, Desc: "Arguments of the command."},
		Field{Name: "health_check_swarm", Kind: JSON, Desc: "Swarm health check as a JSON object (use jsonencode), with the keys Test, Interval, Timeout, StartPeriod, Retries."},
		Field{Name: "restart_policy_swarm", Kind: JSON, Desc: "Swarm restart policy as a JSON object (use jsonencode), with the keys Condition, Delay, MaxAttempts, Window."},
		Field{Name: "placement_swarm", Kind: JSON, Desc: "Swarm placement as a JSON object (use jsonencode), with the keys Constraints, Preferences, MaxReplicas, Platforms."},
		Field{Name: "update_config_swarm", Kind: JSON, Desc: "Swarm update configuration as a JSON object (use jsonencode), with the keys Parallelism, Delay, FailureAction, Monitor, MaxFailureRatio, Order."},
		Field{Name: "rollback_config_swarm", Kind: JSON, Desc: "Swarm rollback configuration as a JSON object (use jsonencode), same keys as update_config_swarm."},
		Field{Name: "mode_swarm", Kind: JSON, Desc: "Swarm service mode as a JSON object (use jsonencode), for example {Replicated={Replicas=1}}."},
		Field{Name: "labels_swarm", Kind: JSON, Desc: "Swarm service labels as a JSON object (use jsonencode) mapping a label to its value."},
		Field{Name: "network_swarm", Kind: JSON, Desc: "Swarm networks as a JSON array (use jsonencode) of objects with the keys Target, Aliases, DriverOpts."},
		Field{Name: "stop_grace_period_swarm", Kind: Int, Desc: "Time Swarm waits before killing the container on stop, in nanoseconds."},
		Field{Name: "endpoint_spec_swarm", Kind: JSON, Desc: "Swarm endpoint specification as a JSON object (use jsonencode), with the keys Mode and Ports."},
		Field{Name: "ulimits_swarm", Kind: JSON, Desc: "Swarm ulimits as a JSON array (use jsonencode) of objects with the keys Name, Soft, Hard."},
		Field{Name: "app_name", Kind: String, ReadOnly: true, Desc: "Name of the Docker Swarm service, also its hostname on the Docker network. Generated by Dokploy, so it cannot be chosen (Dokploy appends a random suffix to any name it is given)."},
		Field{Name: "created_at", Kind: String, ReadOnly: true, Desc: "Creation date."},
		Field{Name: "application_status", Kind: String, ReadOnly: true, Volatile: true, Desc: "Last status Dokploy recorded for the service (idle, running, done or error). Terraform never changes it."},
	)
	return fs
}

// createKeys are the API keys <router>.create accepts. Everything else goes
// through <router>.update right after the creation.
func (k dbKind) createKeys() map[string]bool {
	keys := map[string]bool{"name": true, "dockerImage": true, "environmentId": true, "description": true, "serverId": true, dbAPIPassword: true}
	if k.DatabaseName {
		keys["databaseName"] = true
	}
	if k.DatabaseUser {
		keys["databaseUser"] = true
	}
	if k.RootPassword {
		keys[dbAPIRootPassword] = true
	}
	for _, e := range k.ExtraCreate {
		keys[e] = true
	}
	return keys
}

func (k dbKind) spec() *Spec {
	router, idKey := k.Name, k.idKey()
	desc := fmt.Sprintf("A Dokploy %s database service. Terraform only manages its configuration: it never deploys, starts, stops or rebuilds the database. A new database stays idle until it is deployed from Dokploy, and a change of image, port, resources or environment takes effect at the next deployment. Dokploy creates the data volume mount (%s) together with the database; it is a separate mount resource. Use lifecycle { prevent_destroy = true } on production databases: destroying the resource removes the service from Dokploy.", k.Title, k.DataPath)
	s := &Spec{
		Name:           k.Name,
		Desc:           desc,
		IDKey:          idKey,
		SecretsVersion: true,
		Fields:         k.fields(),
		ImportHint:     "Import with the " + idKey + ".",
		Env: &EnvSpec{Save: func(ctx context.Context, c *client.Client, id, text string, _ map[string]any) error {
			return c.Mutate(ctx, router+".saveEnvironment", map[string]any{idKey: id, "env": text}, nil)
		}},
	}
	s.UseREST(CRUD{Router: router})
	create := k.createKeys()

	s.Create = func(ctx context.Context, c *client.Client, in Input) (string, error) {
		// The create procedure needs a password: an empty one would make
		// Dokploy generate a password nobody knows.
		if pw, _ := in.Body[dbAPIPassword].(string); pw == "" {
			return "", fmt.Errorf("database_password_wo is required to create a %s database (Dokploy keeps the password; Terraform never stores it)", k.Title)
		}
		first, rest := map[string]any{}, map[string]any{}
		for key, v := range in.Body {
			if create[key] {
				first[key] = v
			} else {
				rest[key] = v
			}
		}
		var out any
		if err := c.Mutate(ctx, router+".create", first, &out); err != nil {
			return "", err
		}
		id := asString(dig(out, idKey))
		if id == "" {
			return "", fmt.Errorf("the API answer carries no %s", idKey)
		}
		if len(rest) == 0 {
			return id, nil
		}
		// create only takes the identity of the database: the rest of the
		// configuration is applied with update, still without deploying.
		rest[idKey] = id
		if err := c.Mutate(ctx, router+".update", rest, nil); err != nil {
			// Do not leave a half configured database behind: the engine only
			// tracks objects whose creation succeeded.
			if rerr := c.Mutate(ctx, router+".remove", map[string]any{idKey: id}, nil); rerr != nil && !errors.Is(rerr, client.ErrNotFound) {
				return "", fmt.Errorf("%w (the database %s was created and could not be removed again: %v)", err, id, rerr)
			}
			return "", err
		}
		return id, nil
	}

	s.Update = func(ctx context.Context, c *client.Client, in Input) error {
		body := overlay(nil, in.Body)
		user, _ := body[dbAPIPassword].(string)
		root, _ := body[dbAPIRootPassword].(string)
		// A password written with update would only change what Dokploy
		// stores, not the running server; the environment moves with move and
		// the server cannot change.
		for _, key := range []string{dbAPIPassword, dbAPIRootPassword, "environmentId", "serverId"} {
			delete(body, key)
		}
		if err := c.Mutate(ctx, router+".update", body, nil); err != nil {
			return err
		}
		if to := dbPlanString(in.Plan, "environment_id"); to != "" && to != dbPlanString(in.State, "environment_id") {
			if err := c.Mutate(ctx, router+".move", map[string]any{idKey: in.ID, "targetEnvironmentId": to}, nil); err != nil {
				return fmt.Errorf("move to environment %s: %w", to, err)
			}
		}
		if !dbSecretsVersionBumped(in) {
			return nil
		}
		change := func(password, kind string) error {
			input := map[string]any{idKey: in.ID, "password": password}
			if k.RootPassword {
				input["type"] = kind
			}
			// changePassword has no REST route in the OpenAPI document: call
			// the tRPC endpoint, which the dashboard itself uses.
			if err := c.TRPCMutate(ctx, router+".changePassword", input, nil); err != nil {
				// A failing command is reported by Dokploy with the command line,
				// and so with the new (and the current) password: never forward it.
				var apiErr *client.APIError
				if errors.As(err, &apiErr) && apiErr.Status >= 500 {
					return fmt.Errorf("change the %s password: changePassword failed (HTTP %d); is the container running? See the Dokploy logs", kind, apiErr.Status)
				}
				return fmt.Errorf("change the %s password: %w", kind, err)
			}
			return nil
		}
		if user != "" {
			if err := change(user, "user"); err != nil {
				return err
			}
		}
		if root != "" {
			if err := change(root, "root"); err != nil {
				return err
			}
		}
		return nil
	}
	return s
}

// dbPlanString reads a string attribute of a plan or a state.
func dbPlanString(o Obj, name string) string {
	s, _ := stringOf(o[name])
	return s
}

// dbSecretsVersionBumped reports whether secrets_version is set and differs from
// the state: the only signal that the write-only passwords must be sent again.
func dbSecretsVersionBumped(in Input) bool {
	next, ok := fromTF(Int, in.Plan["secrets_version"])
	if !ok {
		return false
	}
	prev, _ := fromTF(Int, in.State["secrets_version"])
	return next != prev
}
