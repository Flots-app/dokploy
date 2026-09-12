import { relations } from "drizzle-orm";
import {
	boolean,
	integer,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { compose } from "./compose";
import { environments } from "./environment";
import { server } from "./server";

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
		status: text("status", {
			enum: ["pending", "deploying", "ready", "removing", "closed", "error"],
		})
			.notNull()
			.default("pending"),
		manualCleanup: boolean("manualCleanup").notNull().default(false),
		error: text("error"),
		expiresAt: text("expiresAt"),
		requestedAt: text("requestedAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		reconciledAt: text("reconciledAt"),
		createdAt: text("createdAt")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => [
		uniqueIndex("compose_preview_source_pr_unique").on(
			table.sourceComposeId,
			table.pullRequestNumber,
		),
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
