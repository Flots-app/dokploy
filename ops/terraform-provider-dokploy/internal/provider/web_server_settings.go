package provider

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

// webServerSettingsID is the id of the singleton: the instance always has one
// row of settings.
const webServerSettingsID = "web-server"

var (
	// webServerPortsPoll and webServerPortsTimeout drive the wait that follows a
	// change of the Traefik ports: Dokploy recreates Traefik in the background,
	// and the API is served through Traefik. Variables so tests can shorten them.
	webServerPortsPoll    = 2 * time.Second
	webServerPortsTimeout = 3 * time.Minute

	// traefikPortRe is the format of traefik_ports entries.
	traefikPortRe = regexp.MustCompile(`^([0-9]{1,5}):([0-9]{1,5})/(tcp|udp|sctp)$`)
)

// webServerSettingsKeys are the keys of the settings Terraform maps. Anything
// else (the SSH private key, the metrics token, the whitelabeling) is dropped.
var webServerSettingsKeys = []string{
	"host", "https", "certificateType", "letsEncryptEmail", "serverIp",
	"enableDockerCleanup", "logCleanupCron", "buildsConcurrency",
	"remoteServersOnly", "enforceSSO",
	"cleanupCacheApplications", "cleanupCacheOnCompose", "cleanupCacheOnPreviews",
}

// traefikPortString renders an additional Traefik port as published:target/protocol.
func traefikPortString(m map[string]any) string {
	proto := strings.ToLower(asString(m["protocol"]))
	if proto == "" {
		proto = "tcp"
	}
	return fmt.Sprintf("%s:%s/%s", asString(m["publishedPort"]), asString(m["targetPort"]), proto)
}

// readTraefikPorts returns the additional ports of Traefik (the ones other than
// 80 and 443), as sorted published:target/protocol strings.
func readTraefikPorts(ctx context.Context, c *client.Client) ([]any, error) {
	var ports []map[string]any
	if err := c.Query(ctx, "settings.getTraefikPorts", nil, &ports); err != nil {
		return nil, err
	}
	list := make([]string, 0, len(ports))
	for _, p := range ports {
		list = append(list, traefikPortString(p))
	}
	sort.Strings(list)
	out := make([]any, 0, len(list))
	for _, s := range list {
		out = append(out, s)
	}
	return out, nil
}

func readWebServerSettings(ctx context.Context, c *client.Client, _ string) (map[string]any, error) {
	var settings map[string]any
	if err := c.Query(ctx, "settings.getWebServerSettings", nil, &settings); err != nil {
		return nil, err
	}
	if settings == nil {
		return nil, client.ErrNotFound
	}
	out := pick(settings, webServerSettingsKeys...)
	ports, err := readTraefikPorts(ctx, c)
	if err != nil {
		return nil, fmt.Errorf("read the Traefik ports: %w", err)
	}
	out["traefikPorts"] = ports
	return out, nil
}

// applyWebServerSettings writes what srvDiffers between the wanted values (body)
// and the remote settings, one procedure per group of fields.
func applyWebServerSettings(ctx context.Context, c *client.Client, body, remote map[string]any) error {
	want := func(k string) any {
		if v, ok := body[k]; ok {
			return v
		}
		return remote[k]
	}
	// The domain, HTTPS and certificate: assignDomainServer rewrites the dynamic
	// Traefik file of the dashboard (dokploy.yml) and, with an email, the
	// resolver of traefik.yml. Traefik picks the dynamic file up by itself.
	if srvDiffers(remote, body, "host", "https", "certificateType", "letsEncryptEmail") {
		host := asString(want("host"))
		if host == "" {
			return fmt.Errorf("host must be set to change https, certificate_type or letsencrypt_email")
		}
		certType := asString(want("certificateType"))
		if certType == "" {
			certType = "none"
		}
		https, _ := want("https").(bool)
		req := map[string]any{"host": host, "certificateType": certType, "https": https}
		if email := asString(want("letsEncryptEmail")); email != "" {
			req["letsEncryptEmail"] = email
		}
		if err := c.Mutate(ctx, "settings.assignDomainServer", req, nil); err != nil {
			return err
		}
	}
	if srvDiffers(remote, body, "serverIp") {
		if err := c.Mutate(ctx, "settings.updateServerIp", map[string]any{"serverIp": asString(body["serverIp"])}, nil); err != nil {
			return err
		}
	}
	if srvDiffers(remote, body, "enableDockerCleanup") {
		if err := c.Mutate(ctx, "settings.updateDockerCleanup", map[string]any{"enableDockerCleanup": body["enableDockerCleanup"]}, nil); err != nil {
			return err
		}
	}
	if srvDiffers(remote, body, "logCleanupCron") {
		var cron any // null stops the log cleanup
		if s := asString(body["logCleanupCron"]); s != "" {
			cron = s
		}
		var done any
		if err := c.Mutate(ctx, "settings.updateLogCleanup", map[string]any{"cronExpression": cron}, &done); err != nil {
			return err
		}
		// The procedure answers false instead of failing.
		if ok, isBool := done.(bool); isBool && !ok {
			return fmt.Errorf("the log cleanup schedule could not be changed, see the Dokploy logs")
		}
	}
	if srvDiffers(remote, body, "buildsConcurrency") {
		if err := srvMutateWithFallback(ctx, c, "settings.updateBuildsConcurrency", map[string]any{"buildsConcurrency": body["buildsConcurrency"]}, nil); err != nil {
			return err
		}
	}
	if srvDiffers(remote, body, "remoteServersOnly") {
		if err := srvMutateWithFallback(ctx, c, "settings.updateRemoteServersOnly", map[string]any{"remoteServersOnly": body["remoteServersOnly"]}, nil); err != nil {
			return err
		}
	}
	if srvDiffers(remote, body, "enforceSSO") {
		if err := srvMutateWithFallback(ctx, c, "settings.updateEnforceSSO", map[string]any{"enforceSSO": body["enforceSSO"]}, nil); err != nil {
			return err
		}
	}
	if v, ok := body["traefikPorts"].([]any); ok {
		return applyTraefikPorts(ctx, c, v, remote)
	}
	return nil
}

// applyTraefikPorts replaces the additional ports of Traefik when they differ.
// Dokploy then recreates the Traefik container in the background, which cuts
// every domain for a few seconds, the API of Dokploy included. The function
// waits until the new ports are reported.
func applyTraefikPorts(ctx context.Context, c *client.Client, wanted []any, remote map[string]any) error {
	want := make([]string, 0, len(wanted))
	for _, w := range wanted {
		want = append(want, asString(w))
	}
	sort.Strings(want)
	same := func(have []any) bool {
		if len(have) != len(want) {
			return false
		}
		got := make([]string, 0, len(have))
		for _, h := range have {
			got = append(got, asString(h))
		}
		sort.Strings(got)
		for i := range got {
			if got[i] != want[i] {
				return false
			}
		}
		return true
	}
	if have, _ := remote["traefikPorts"].([]any); same(have) {
		return nil
	}
	ports := make([]map[string]any, 0, len(want))
	for _, w := range want {
		m := traefikPortRe.FindStringSubmatch(w)
		if m == nil {
			return fmt.Errorf("invalid Traefik port %q, expected published:target/protocol such as 8080:8080/tcp", w)
		}
		published, _ := strconv.Atoi(m[1])
		target, _ := strconv.Atoi(m[2])
		ports = append(ports, map[string]any{"publishedPort": published, "targetPort": target, "protocol": m[3]})
	}
	if err := c.Mutate(ctx, "settings.updateTraefikPorts", map[string]any{"additionalPorts": ports}, nil); err != nil {
		return err
	}
	deadline := time.Now().Add(webServerPortsTimeout)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(webServerPortsPoll):
		}
		// Errors are expected while Traefik restarts: keep polling.
		if have, err := readTraefikPorts(ctx, c); err == nil && same(have) {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("Traefik did not report the new ports in time: check the dokploy-traefik service on the Dokploy host")
		}
	}
}

func checkWebServerSettingsConfig(cfg Obj, d *diag.Diagnostics) {
	if v, ok := srvCfgString(cfg, "host"); ok && strings.TrimSpace(v) == "" {
		d.AddAttributeError(path.Root("host"), "Invalid host", "Clearing the host would make Dokploy delete the Traefik file of the dashboard; set a domain.")
	}
	if v, ok := srvCfgInt(cfg, "builds_concurrency"); ok && (v < 1 || v > 100) {
		d.AddAttributeError(path.Root("builds_concurrency"), "Invalid builds_concurrency", "Dokploy accepts between 1 and 100 concurrent builds.")
	}
	if l, ok := setOf(cfg["traefik_ports"]); ok {
		for _, p := range l {
			if !traefikPortRe.MatchString(p) {
				d.AddAttributeError(path.Root("traefik_ports"), "Invalid Traefik port", fmt.Sprintf("%q does not match published:target/protocol, for example 8080:8080/tcp.", p))
				continue
			}
			// Dokploy removes the Traefik container before it recreates it with the
			// new ports and ignores a failed creation: an invalid port leaves no
			// Traefik, and so no API to repair it. Ports 80 and 443 are Traefik's own
			// and are never reported back as additional ports.
			m := traefikPortRe.FindStringSubmatch(p)
			published, _ := strconv.Atoi(m[1])
			target, _ := strconv.Atoi(m[2])
			if published < 1 || published > 65535 || target < 1 || target > 65535 {
				d.AddAttributeError(path.Root("traefik_ports"), "Invalid Traefik port", fmt.Sprintf("%q: ports must be between 1 and 65535.", p))
			} else if target == 80 || target == 443 {
				d.AddAttributeError(path.Root("traefik_ports"), "Invalid Traefik port", fmt.Sprintf("%q: the target ports 80 and 443 belong to Traefik itself.", p))
			}
		}
	}
}

func init() {
	s := &Spec{
		Name: "web_server_settings",
		Desc: "The settings of the Dokploy instance itself (the \"web server\"): the domain of the dashboard, the certificate, the Docker and log cleanups, the builds on the Dokploy host and the extra ports published by Traefik. " +
			"There is exactly one per instance: creating it adopts and updates the existing settings, destroying it only forgets them. " +
			"The SSH private key, the metrics token and the whitelabeling are not managed here.",
		IDKey:      "id",
		ImportHint: "Singleton: import with any id, for example web-server.",
		Fields: []Field{
			{Name: "host", Kind: String, Desc: "Domain of the dashboard. Changing it (or https, certificate_type, letsencrypt_email) makes Dokploy regenerate the dynamic Traefik file dokploy.yml: if a dokploy_traefik_file manages that file, make it depend on this resource so it is written last. A new host also rewrites both Traefik router rules to Host(new host): the dashboard then leaves the old host, so the provider's refresh after the change fails if DOKPLOY_URL still points to it."},
			{Name: "https", Kind: Bool, Desc: "Whether the dashboard is served over HTTPS (adds the redirect to HTTPS)."},
			{Name: "certificate_type", Kind: String, OneOf: []string{"letsencrypt", "none", "custom"}, Desc: "Certificate of the dashboard."},
			{Name: "letsencrypt_email", API: "letsEncryptEmail", Kind: String, Desc: "Contact email of the Let's Encrypt account. Setting it re-serializes traefik.yml (its resolver section); Traefik reads it at its next restart. It cannot be cleared through the API."},
			{Name: "server_ip", Kind: String, Desc: "Public IP address of the Dokploy host, used to build the domains Dokploy suggests."},
			{Name: "enable_docker_cleanup", Kind: Bool, Desc: "Whether Dokploy prunes unused Docker data on its own host every day."},
			{Name: "log_cleanup_cron", Kind: String, FromAPI: func(v any) any {
				if v == nil {
					return ""
				}
				return v
			}, Desc: "Cron expression of the Traefik access log cleanup. An empty string disables it."},
			{Name: "builds_concurrency", Kind: Int, Desc: "Number of builds the Dokploy host runs at the same time (1 to 100)."},
			{Name: "remote_servers_only", Kind: Bool, Desc: "Whether services must be deployed on remote servers (enterprise license)."},
			{Name: "enforce_sso", API: "enforceSSO", Kind: Bool, Desc: "Whether only single sign-on logins are accepted (enterprise license)."},
			{Name: "traefik_ports", Kind: StringSet, Desc: "Extra ports published by Traefik, besides 80 and 443, each as published:target/protocol (for example 8080:8080/tcp, the Traefik dashboard). " +
				"WARNING: changing this set makes Dokploy recreate the Traefik container: every domain, and the Dokploy API itself, is unreachable for a few seconds. The provider waits until the new ports are reported."},
			{Name: "cleanup_cache_applications", Kind: Bool, ReadOnly: true, Desc: "Cache cleanup flag of applications. Dokploy has no procedure to change it, so it is read-only."},
			{Name: "cleanup_cache_on_compose", Kind: Bool, ReadOnly: true, Desc: "Cache cleanup flag of Compose services. Read-only: Dokploy has no procedure to change it."},
			{Name: "cleanup_cache_on_previews", Kind: Bool, ReadOnly: true, Desc: "Cache cleanup flag of previews. Read-only: Dokploy has no procedure to change it."},
		},
	}
	s.Read = readWebServerSettings
	s.Create = func(ctx context.Context, c *client.Client, in Input) (string, error) {
		remote, err := readWebServerSettings(ctx, c, webServerSettingsID)
		if err != nil {
			return "", err
		}
		if err := applyWebServerSettings(ctx, c, in.Body, remote); err != nil {
			return "", err
		}
		return webServerSettingsID, nil
	}
	s.Update = func(ctx context.Context, c *client.Client, in Input) error {
		return applyWebServerSettings(ctx, c, in.Body, in.Remote)
	}
	s.Delete = func(context.Context, *client.Client, string) error { return nil }
	srvRegisterChecked(s, webServerSettingsID, checkWebServerSettingsConfig)
}
