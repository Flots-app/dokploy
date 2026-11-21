package provider

import (
	"context"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

func init() {
	s := &Spec{
		Name:       "domain",
		Desc:       "A domain Traefik routes to an application, or to one service of a compose stack. Creating, updating or deleting it rewrites the Traefik configuration of the service on the Dokploy host.",
		IDKey:      "domainId",
		ImportHint: "Import with the domainId.",
		Fields: []Field{
			{Name: "application_id", Kind: String, ForceNew: true, Desc: "Application the domain routes to. Set exactly one of application_id, compose_id or preview_deployment_id. Changing it replaces the domain."},
			{Name: "compose_id", Kind: String, ForceNew: true, Desc: "Compose stack the domain routes to (together with service_name). Changing it replaces the domain."},
			{Name: "preview_deployment_id", Kind: String, ForceNew: true, Desc: "Preview deployment the domain belongs to. Preview domains are normally created by Dokploy itself. Changing it replaces the domain."},
			{Name: "domain_type", Kind: String, OneOf: []string{"application", "compose", "preview"}, Desc: "What the domain is attached to. Left out, it follows the parent id that is set."},
			{Name: "host", Kind: String, Required: true, Desc: "Host name, for example api.example.com."},
			{Name: "path", Kind: String, Desc: "URL path prefix the domain answers on (Dokploy's default is /)."},
			{Name: "internal_path", Kind: String, Desc: "Path the request is rewritten to before it reaches the service (Dokploy's default is /)."},
			{Name: "strip_path", Kind: Bool, Desc: "Remove path from the request before it reaches the service. Needs a path other than /."},
			{Name: "port", Kind: Int, Desc: "Port the service listens on in its container (Dokploy's default is 3000)."},
			{Name: "https", Kind: Bool, Desc: "Serve the domain over HTTPS."},
			{Name: "certificate_type", Kind: String, OneOf: []string{"letsencrypt", "none", "custom"}, Desc: "Where the certificate comes from when https is on: letsencrypt, none, or custom (a resolver named in custom_cert_resolver)."},
			{Name: "custom_cert_resolver", Kind: String, Desc: "Traefik certificate resolver, for certificate_type custom."},
			{Name: "custom_entrypoint", Kind: String, Desc: "Traefik entrypoint to bind instead of the default web / websecure pair."},
			{Name: "service_name", Kind: String, Desc: "Service of the compose stack the domain routes to. Required for compose domains."},
			{Name: "middlewares", Kind: StringList, Desc: "Extra Traefik middlewares applied to the router, in order (for example basic-auth@file)."},
			{Name: "forward_auth_enabled", Kind: Bool, Desc: "Protect the domain with the SSO forward-auth gate (Flots fork)."},
			{Name: "unique_config_key", Kind: Int, ReadOnly: true, Desc: "Number Dokploy uses to name the Traefik router of this domain."},
			{Name: "created_at", Kind: String, ReadOnly: true, Desc: "Creation date."},
		},
	}
	s.UseREST(CRUD{
		Router:     "domain",
		DeleteProc: "domain.delete",
		// The parent ids and the domain id never change on update.
		UpdateBody: func(in Input) map[string]any {
			return pick(in.Body, "domainId", "host", "path", "internalPath", "stripPath", "port", "https",
				"certificateType", "customCertResolver", "customEntrypoint", "serviceName", "domainType",
				"middlewares", "forwardAuthEnabled")
		},
	})
	create := s.Create
	s.Create = func(ctx context.Context, c *client.Client, in Input) (string, error) {
		// domain.create defaults domainType to "application": a compose domain
		// created without it would be filed under the wrong type.
		if _, ok := in.Body["domainType"]; !ok {
			kind := "application"
			switch {
			case in.Body["composeId"] != nil:
				kind = "compose"
			case in.Body["previewDeploymentId"] != nil:
				kind = "preview"
			}
			in = attWithBody(in, overlay(in.Body, map[string]any{"domainType": kind}))
		}
		return create(ctx, c, in)
	}
	attSerialize(s)
	registerAttachment(s, attDomainCheck)
}

func attDomainCheck(cfg Obj, report func(attr, summary, detail string)) {
	if attCount(cfg, "application_id", "compose_id", "preview_deployment_id") != 1 {
		report("application_id", "Exactly one parent is required", "Set exactly one of application_id, compose_id or preview_deployment_id.")
	}
	if kind, ok := stringOf(cfg["domain_type"]); ok {
		parent := map[string]string{"application": "application_id", "compose": "compose_id", "preview": "preview_deployment_id"}[kind]
		if parent != "" && !attSet(cfg[parent]) {
			report("domain_type", "Parent id missing", "A domain of type "+kind+" needs "+parent+".")
		}
	}
	if attSet(cfg["compose_id"]) && !attSet(cfg["service_name"]) {
		report("service_name", "Service name required", "A compose domain must name the service of the stack it routes to.")
	}
	if kind, ok := stringOf(cfg["certificate_type"]); ok && kind == "custom" && !attSet(cfg["custom_cert_resolver"]) {
		report("custom_cert_resolver", "Certificate resolver required", "certificate_type custom needs custom_cert_resolver.")
	}
}
