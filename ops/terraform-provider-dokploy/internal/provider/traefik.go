package provider

import (
	"context"
	"fmt"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

// traefikRoot is the directory Dokploy keeps the Traefik files in, on the
// Dokploy host and on remote servers.
const traefikRoot = "/etc/dokploy/traefik/"

// traefikDocs maps the fixed targets to their read and write procedures.
var traefikDocs = map[string]struct{ read, write string }{
	"main":        {"settings.readTraefikConfig", "settings.updateTraefikConfig"},
	"web_server":  {"settings.readWebServerTraefikConfig", "settings.updateWebServerTraefikConfig"},
	"middlewares": {"settings.readMiddlewareTraefikConfig", "settings.updateMiddlewareTraefikConfig"},
}

// traefikID builds the id of a file: the fixed targets are their own id, a
// file is file:<path> on the Dokploy host or file:<serverId>:<path> on a server.
func traefikID(target, filePath, serverID string) string {
	if target != "file" {
		return target
	}
	if serverID != "" {
		return "file:" + serverID + ":" + filePath
	}
	return "file:" + filePath
}

// parseTraefikID is the reverse of traefikID.
func parseTraefikID(id string) (target, filePath, serverID string, err error) {
	if _, ok := traefikDocs[id]; ok {
		return id, "", "", nil
	}
	rest, ok := strings.CutPrefix(id, "file:")
	if !ok || rest == "" {
		return "", "", "", fmt.Errorf("invalid id %q: expected main, web_server, middlewares, file:<path> or file:<serverId>:<path>", id)
	}
	if !strings.HasPrefix(rest, "/") {
		serverID, rest, ok = strings.Cut(rest, ":")
		if !ok || serverID == "" {
			return "", "", "", fmt.Errorf("invalid id %q: expected file:<path> or file:<serverId>:<path>", id)
		}
	}
	return "file", rest, serverID, nil
}

// readTraefikText reads one document. The procedures answer null when the file
// does not exist.
func readTraefikText(ctx context.Context, c *client.Client, id string) (target, filePath, serverID, text string, err error) {
	target, filePath, serverID, err = parseTraefikID(id)
	if err != nil {
		return
	}
	var out any
	if doc, ok := traefikDocs[target]; ok {
		err = c.Query(ctx, doc.read, nil, &out)
	} else {
		params := map[string]any{"path": filePath}
		if serverID != "" {
			params["serverId"] = serverID
		}
		err = c.Query(ctx, "settings.readTraefikFile", params, &out)
	}
	if err != nil {
		return
	}
	switch v := out.(type) {
	case nil:
		err = client.ErrNotFound
	case string:
		text = v
	default:
		err = fmt.Errorf("unexpected answer for %s: the instance does not serve Traefik files (cloud?)", id)
	}
	return
}

// writeTraefikText writes one document, then reads it back: the procedures
// swallow write errors (missing directory, permissions) and answer true anyway.
func writeTraefikText(ctx context.Context, c *client.Client, id, content string) error {
	target, filePath, serverID, err := parseTraefikID(id)
	if err != nil {
		return err
	}
	var proc string
	body := map[string]any{"traefikConfig": content}
	if doc, ok := traefikDocs[target]; ok {
		proc = doc.write
	} else {
		proc = "settings.updateTraefikFile"
		body["path"] = filePath
		if serverID != "" {
			body["serverId"] = serverID
		}
	}
	if err := c.Mutate(ctx, proc, body, nil); err != nil {
		return err
	}
	_, _, _, got, err := readTraefikText(ctx, c, id)
	if err != nil {
		return fmt.Errorf("the file was written but cannot be read back: %w", err)
	}
	if got != content {
		return fmt.Errorf("Dokploy accepted the write but the file holds other content: it swallows write errors, check the directory and its permissions")
	}
	return nil
}

func checkTraefikFileConfig(cfg Obj, d *diag.Diagnostics) {
	target, ok := srvCfgString(cfg, "target")
	if !ok {
		return
	}
	filePath, hasPath := srvCfgString(cfg, "path")
	if target != "file" {
		if !cfg["path"].IsNull() {
			d.AddAttributeError(path.Root("path"), "Unexpected path", fmt.Sprintf("path is only used with target = \"file\"; %s is a fixed file of the Dokploy host.", target))
		}
		if !cfg["server_id"].IsNull() {
			d.AddAttributeError(path.Root("server_id"), "Unexpected server_id", fmt.Sprintf("server_id is only used with target = \"file\"; %s lives on the Dokploy host.", target))
		}
		return
	}
	if cfg["path"].IsNull() {
		d.AddAttributeError(path.Root("path"), "Missing path", "path is required with target = \"file\".")
	}
	if hasPath {
		switch {
		case !strings.HasPrefix(filePath, traefikRoot):
			d.AddAttributeError(path.Root("path"), "Invalid path", "The path must be absolute and below "+traefikRoot+", for example "+traefikRoot+"dynamic/redirects.yml.")
		case strings.Contains(filePath, ".."), strings.ContainsRune(filePath, 0):
			d.AddAttributeError(path.Root("path"), "Invalid path", "The path must not contain \"..\".")
		}
	}
}

func init() {
	s := &Spec{
		Name: "traefik_file",
		Desc: "A Traefik configuration file kept by Dokploy: the static traefik.yml (target main), the dynamic file of the dashboard (web_server, dokploy.yml), the shared middlewares (middlewares, middlewares.yml) or any other file below /etc/dokploy/traefik of the Dokploy host or of a remote server (file). " +
			"The whole content is managed as text and stored in the state: never put a secret in it. " +
			"Dokploy has no procedure to delete a file, so destroying the resource only forgets it. " +
			"Dynamic files are hot-reloaded by Traefik: a file with an invalid router breaks routing at once. " +
			"Terraform never restarts Traefik: a change of traefik.yml (static configuration) is read at the next restart, and a mistake in it is a latent outage for that restart.",
		IDKey:      "id",
		ImportHint: "Import with main, web_server, middlewares, file:<absolute path> (Dokploy host) or file:<serverId>:<absolute path> (remote server).",
		Fields: []Field{
			{Name: "target", Kind: String, Required: true, ForceNew: true, OneOf: []string{"main", "web_server", "middlewares", "file"}, Desc: "Which file: main (traefik.yml), web_server (dynamic/dokploy.yml), middlewares (dynamic/middlewares.yml) or file (any file, with path)."},
			{Name: "path", Kind: String, ForceNew: true, Desc: "Absolute path of the file, below /etc/dokploy/traefik. Only with target = \"file\"."},
			{Name: "server_id", Kind: String, ForceNew: true, Desc: "Id of the remote dokploy_server holding the file. Only with target = \"file\"; left out, the file is on the Dokploy host."},
			{Name: "content", Kind: String, Required: true, Desc: "Content of the file, as YAML text. It is compared byte for byte with what Dokploy holds, so trailing spaces and the final newline count."},
		},
	}
	s.Read = func(ctx context.Context, c *client.Client, id string) (map[string]any, error) {
		target, filePath, serverID, text, err := readTraefikText(ctx, c, id)
		if err != nil {
			return nil, err
		}
		out := map[string]any{"target": target, "content": text}
		if target == "file" {
			out["path"] = filePath
			if serverID != "" {
				out["serverId"] = serverID
			}
		}
		return out, nil
	}
	s.Create = func(ctx context.Context, c *client.Client, in Input) (string, error) {
		id := traefikID(asString(in.Body["target"]), asString(in.Body["path"]), asString(in.Body["serverId"]))
		return id, writeTraefikText(ctx, c, id, asString(in.Body["content"]))
	}
	s.Update = func(ctx context.Context, c *client.Client, in Input) error {
		if asString(in.Body["content"]) == asString(in.Remote["content"]) {
			return nil
		}
		return writeTraefikText(ctx, c, in.ID, asString(in.Body["content"]))
	}
	s.Delete = func(context.Context, *client.Client, string) error { return nil }
	srvRegisterChecked(s, "", checkTraefikFileConfig)
}
