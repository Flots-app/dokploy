package provider

import (
	"context"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

func init() {
	s := &Spec{
		Name:       "port",
		Desc:       "A port of an application published on the Swarm nodes (not a Traefik domain). Applies on the next deployment of the application.",
		IDKey:      "portId",
		ImportHint: "Import with the portId.",
		Fields: []Field{
			{Name: "application_id", Kind: String, Required: true, ForceNew: true, Desc: "Application that publishes the port. Changing it replaces the port."},
			{Name: "published_port", Kind: Int, Required: true, Desc: "Port opened on the nodes."},
			{Name: "target_port", Kind: Int, Required: true, Desc: "Port of the container it leads to."},
			{Name: "protocol", Kind: String, OneOf: []string{"tcp", "udp"}, Default: "tcp", Desc: "tcp or udp (default tcp)."},
			{Name: "publish_mode", Kind: String, OneOf: []string{"ingress", "host"}, Default: "ingress", Desc: "ingress (routing mesh, every node answers) or host (only the node running the container). Default ingress."},
		},
	}
	s.UseREST(CRUD{
		Router:     "port",
		DeleteProc: "port.delete",
		UpdateBody: func(in Input) map[string]any {
			return pick(in.Body, "portId", "publishedPort", "targetPort", "protocol", "publishMode")
		},
	})
	// port.one wraps its "not found" in a BAD_REQUEST: without this a port
	// removed outside Terraform would fail the refresh instead of being recreated.
	read := s.Read
	s.Read = func(ctx context.Context, c *client.Client, id string) (map[string]any, error) {
		remote, err := read(ctx, c, id)
		return remote, attNotFoundOn400(err, "Port not found")
	}
	registerAttachment(s, nil)
}
