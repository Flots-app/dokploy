import { relations, sql } from "drizzle-orm";
import {
	check,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
	type FirewallRule,
	firewallPolicySchema,
	firewallRulesSchema,
} from "../../utils/firewall/rules";
import { organization } from "./account";
import { githubRunnerNodes, githubRunnerPools } from "./github-runner";

export const firewallPolicy = pgEnum("firewallPolicy", ["allow", "deny"]);

/**
 * A firewall of the Firewalls service: ordered rules per direction (the first
 * match decides) and a default policy. Resources of other services attach to
 * it; `revision` grows with every change, so they can tell they are behind.
 */
export const firewalls = pgTable(
	"firewall",
	{
		firewallId: text("firewallId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description"),
		inboundPolicy: firewallPolicy("inboundPolicy").notNull().default("allow"),
		outboundPolicy: firewallPolicy("outboundPolicy").notNull().default("allow"),
		rules: jsonb("rules").$type<FirewallRule[]>().notNull().default([]),
		revision: integer("revision").notNull().default(1),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		updatedAt: text("updatedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => [
		uniqueIndex("firewall_org_name_unique").on(
			table.organizationId,
			table.name,
		),
	],
);

/**
 * What a firewall applies to: exactly one resource per row, each resource
 * with one firewall at most. A machine with its own firewall ignores its
 * pool's.
 */
export const firewallAttachments = pgTable(
	"firewall_attachment",
	{
		firewallAttachmentId: text("firewallAttachmentId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		firewallId: text("firewallId")
			.notNull()
			.references(() => firewalls.firewallId, { onDelete: "cascade" }),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		githubRunnerPoolId: text("githubRunnerPoolId").references(
			() => githubRunnerPools.githubRunnerPoolId,
			{ onDelete: "cascade" },
		),
		githubRunnerNodeId: text("githubRunnerNodeId").references(
			() => githubRunnerNodes.githubRunnerNodeId,
			{ onDelete: "cascade" },
		),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => [
		uniqueIndex("firewall_attachment_pool_unique").on(table.githubRunnerPoolId),
		uniqueIndex("firewall_attachment_node_unique").on(table.githubRunnerNodeId),
		check(
			"firewall_attachment_one_target",
			sql`num_nonnulls(${table.githubRunnerPoolId}, ${table.githubRunnerNodeId}) = 1`,
		),
	],
);

export const firewallsRelations = relations(firewalls, ({ one, many }) => ({
	organization: one(organization, {
		fields: [firewalls.organizationId],
		references: [organization.id],
	}),
	attachments: many(firewallAttachments),
}));

export const firewallAttachmentsRelations = relations(
	firewallAttachments,
	({ one }) => ({
		firewall: one(firewalls, {
			fields: [firewallAttachments.firewallId],
			references: [firewalls.firewallId],
		}),
		githubRunnerPool: one(githubRunnerPools, {
			fields: [firewallAttachments.githubRunnerPoolId],
			references: [githubRunnerPools.githubRunnerPoolId],
		}),
		githubRunnerNode: one(githubRunnerNodes, {
			fields: [firewallAttachments.githubRunnerNodeId],
			references: [githubRunnerNodes.githubRunnerNodeId],
		}),
	}),
);

export type Firewall = typeof firewalls.$inferSelect;
export type FirewallAttachment = typeof firewallAttachments.$inferSelect;

/** Resource types a firewall attaches to. */
export const firewallTargetSchema = z.object({
	type: z.enum(["githubRunnerPool", "githubRunnerNode"]),
	id: z.string().min(1),
});
export type FirewallTarget = z.infer<typeof firewallTargetSchema>;

const firewallFields = {
	name: z.string().trim().min(1).max(64),
	description: z.string().trim().max(500).nullable(),
	inboundPolicy: firewallPolicySchema,
	outboundPolicy: firewallPolicySchema,
	rules: firewallRulesSchema,
};

const uniqueRuleIds = {
	check: (value: { rules?: { id: string }[] }) =>
		!value.rules ||
		new Set(value.rules.map((rule) => rule.id)).size === value.rules.length,
	params: { path: ["rules"], message: "Each rule needs its own id" },
};

export const apiCreateFirewall = z
	.object({
		...firewallFields,
		description: firewallFields.description.default(null),
		inboundPolicy: firewallFields.inboundPolicy.default("allow"),
		outboundPolicy: firewallFields.outboundPolicy.default("allow"),
		rules: firewallFields.rules.default([]),
	})
	.refine(uniqueRuleIds.check, uniqueRuleIds.params);

/**
 * A field left out keeps its value: a rename through the API never drops the
 * rules. With `revision`, the change is refused when the firewall changed
 * since that revision, so two editors never silently undo each other.
 */
export const apiUpdateFirewall = z
	.object({
		firewallId: z.string().min(1),
		revision: z.number().int().min(0).optional(),
		name: firewallFields.name.optional(),
		description: firewallFields.description.optional(),
		inboundPolicy: firewallFields.inboundPolicy.optional(),
		outboundPolicy: firewallFields.outboundPolicy.optional(),
		rules: firewallFields.rules.optional(),
	})
	.refine(uniqueRuleIds.check, uniqueRuleIds.params);

export const apiFindFirewall = z.object({ firewallId: z.string().min(1) });

export const apiAttachFirewall = z.object({
	firewallId: z.string().min(1),
	target: firewallTargetSchema,
});

export const apiDetachFirewall = z.object({ target: firewallTargetSchema });
