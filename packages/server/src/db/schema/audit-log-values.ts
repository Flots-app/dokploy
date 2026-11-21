// Kept free of imports so the audit log page can use the lists without
// bundling the database schema.
export const auditActions = [
	"create",
	"update",
	"delete",
	"deploy",
	"cancel",
	"redeploy",
	"login",
	"logout",
	"restore",
	"run",
	"start",
	"stop",
	"reload",
	"rebuild",
	"move",
] as const;

export const auditResourceTypes = [
	"project",
	"service",
	"environment",
	"deployment",
	"user",
	"customRole",
	"domain",
	"certificate",
	"registry",
	"server",
	"githubRunner",
	"firewall",
	"osUpdate",
	"sshKey",
	"gitProvider",
	"destination",
	"notification",
	"settings",
	"session",
	"port",
	"redirect",
	"security",
	"schedule",
	"backup",
	"volumeBackup",
	"docker",
	"swarm",
	"previewDeployment",
	"organization",
	"cluster",
	"mount",
	"application",
	"compose",
] as const;

export type AuditAction = (typeof auditActions)[number];

export type AuditResourceType = (typeof auditResourceTypes)[number];
