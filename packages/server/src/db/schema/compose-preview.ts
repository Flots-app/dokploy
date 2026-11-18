import { relations } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	pgEnum,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { compose } from "./compose";
import { environments } from "./environment";
import { server } from "./server";

export const composePreviewStatus = pgEnum("composePreviewStatus", [
	"pending",
	"deploying",
	"ready",
	"removing",
	"closed",
	"error",
]);

// Retain a tombstone after cleanup: delayed webhooks must consult GitHub's
// current PR state before recreating any resources.
export const composePreviews = pgTable(
	"composePreview",
	{
		previewId: text("previewId")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		sourceComposeId: text("sourceComposeId")
			.notNull()
			.references(() => compose.composeId, { onDelete: "cascade" }),
		composeId: text("composeId").references(() => compose.composeId, {
			onDelete: "restrict",
		}),
		environmentId: text("environmentId").references(
			() => environments.environmentId,
			{ onDelete: "restrict" },
		),
		serverId: text("serverId").references(() => server.serverId, {
			onDelete: "restrict",
		}),
		pullRequestNumber: integer("pullRequestNumber").notNull(),
		branch: text("branch").notNull().default(""),
		url: text("url").notNull().default(""),
		deployedSha: text("deployedSha"),
		/** Sticky GitHub PR comment kept up to date with status and URLs. */
		commentId: text("commentId"),
		status: composePreviewStatus("status").notNull().default("pending"),
		manualCleanup: boolean("manualCleanup").notNull().default(false),
		error: text("error"),
		expiresAt: text("expiresAt"),
		requestedAt: text("requestedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		reconciledAt: text("reconciledAt"),
		/** Lifecycle lease (see reconcileComposePreview). */
		lockedBy: text("lockedBy"),
		lockedUntil: text("lockedUntil"),
		/** Last time GitHub granted the PR author write access, per head SHA. */
		authorizedSha: text("authorizedSha"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => [
		uniqueIndex("compose_preview_source_pr_unique").on(
			table.sourceComposeId,
			table.pullRequestNumber,
		),
		// Foreign keys used by capacity counts and RESTRICT checks on delete.
		index("compose_preview_server_idx").on(table.serverId),
		index("compose_preview_compose_idx").on(table.composeId),
		index("compose_preview_environment_idx").on(table.environmentId),
		index("compose_preview_status_idx").on(table.status),
	],
);

export const composePreviewRelations = relations(
	composePreviews,
	({ one }) => ({
		source: one(compose, {
			fields: [composePreviews.sourceComposeId],
			references: [compose.composeId],
			relationName: "composePreviewSource",
		}),
		instance: one(compose, {
			fields: [composePreviews.composeId],
			references: [compose.composeId],
			relationName: "composePreviewInstance",
		}),
		server: one(server, {
			fields: [composePreviews.serverId],
			references: [server.serverId],
		}),
	}),
);
