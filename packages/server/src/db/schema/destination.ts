import { relations, sql } from "drizzle-orm";
import { boolean, check, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
	ADDITIONAL_FLAG_ERROR,
	ADDITIONAL_FLAG_REGEX,
} from "../validations/destination";
import { organization } from "./account";
import { backups } from "./backups";

export const destinations = pgTable(
	"destination",
	{
		destinationId: text("destinationId")
			.notNull()
			.primaryKey()
			.$defaultFn(() => nanoid()),
		name: text("name").notNull(),
		provider: text("provider"),
		accessKey: text("accessKey").notNull(),
		secretAccessKey: text("secretAccessKey").notNull(),
		bucket: text("bucket").notNull(),
		region: text("region").notNull(),
		endpoint: text("endpoint").notNull(),
		additionalFlags: text("additionalFlags").array(),
		encryptionEnabled: boolean("encryptionEnabled").notNull().default(false),
		// rclone-obscured values. They remain reversible secrets and must be redacted.
		encryptionPassword: text("encryptionPassword"),
		encryptionPassword2: text("encryptionPassword2"),
		encryptionFilenameMode: text("encryptionFilenameMode")
			.notNull()
			.default("standard"),
		encryptionDirectoryNames: boolean("encryptionDirectoryNames")
			.notNull()
			.default(true),
		organizationId: text("organizationId")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		createdAt: timestamp("createdAt").notNull().defaultNow(),
	},
	(table) => [
		check(
			"destination_encryption_password_required",
			sql`NOT ${table.encryptionEnabled} OR ${table.encryptionPassword} IS NOT NULL`,
		),
		check(
			"destination_encryption_filename_mode",
			sql`${table.encryptionFilenameMode} IN ('standard', 'obfuscate', 'off')`,
		),
		check(
			"destination_encryption_directory_name_mode",
			sql`${table.encryptionFilenameMode} <> 'off' OR NOT ${table.encryptionDirectoryNames}`,
		),
		check(
			"destination_encryption_disabled_secrets",
			sql`${table.encryptionEnabled} OR (${table.encryptionPassword} IS NULL AND ${table.encryptionPassword2} IS NULL)`,
		),
	],
);

export const destinationsRelations = relations(
	destinations,
	({ many, one }) => ({
		backups: many(backups),
		organization: one(organization, {
			fields: [destinations.organizationId],
			references: [organization.id],
		}),
	}),
);

const createSchema = createInsertSchema(destinations, {
	destinationId: z.string(),
	name: z.string().min(1),
	provider: z.string(),
	accessKey: z.string(),
	bucket: z.string(),
	endpoint: z.string(),
	secretAccessKey: z.string(),
	region: z.string(),
	additionalFlags: z
		.array(z.string().regex(ADDITIONAL_FLAG_REGEX, ADDITIONAL_FLAG_ERROR))
		.default([]),
	encryptionEnabled: z.boolean(),
	encryptionPassword: z.string().nullable(),
	encryptionPassword2: z.string().nullable(),
	encryptionFilenameMode: z.enum(["standard", "obfuscate", "off"]),
	encryptionDirectoryNames: z.boolean(),
});

export const apiCreateDestination = createSchema
	.pick({
		name: true,
		provider: true,
		accessKey: true,
		bucket: true,
		region: true,
		endpoint: true,
		secretAccessKey: true,
		additionalFlags: true,
		encryptionEnabled: true,
		encryptionPassword: true,
		encryptionPassword2: true,
		encryptionFilenameMode: true,
		encryptionDirectoryNames: true,
	})
	.required()
	.extend({
		serverId: z.string().optional(),
		encryptionEnabled: z.boolean().default(false),
		encryptionPassword: z.string().optional(),
		encryptionPassword2: z.string().optional(),
		encryptionFilenameMode: z
			.enum(["standard", "obfuscate", "off"])
			.default("standard"),
		encryptionDirectoryNames: z.boolean().default(true),
	})
	.superRefine((destination, ctx) => {
		if (destination.encryptionEnabled && !destination.encryptionPassword) {
			ctx.addIssue({
				code: "custom",
				message: "Encryption password is required when encryption is enabled",
				path: ["encryptionPassword"],
			});
		}
		if (
			destination.encryptionEnabled &&
			destination.encryptionPassword2 &&
			destination.encryptionPassword2 === destination.encryptionPassword
		) {
			ctx.addIssue({
				code: "custom",
				message: "The second password must differ from the primary password",
				path: ["encryptionPassword2"],
			});
		}
		if (
			destination.encryptionEnabled &&
			[destination.encryptionPassword, destination.encryptionPassword2].some(
				(password) => password && /[\0\r\n]/.test(password),
			)
		) {
			ctx.addIssue({
				code: "custom",
				message: "Encryption passwords cannot contain NUL or line breaks",
				path: ["encryptionPassword"],
			});
		}
		if (
			destination.encryptionEnabled &&
			destination.encryptionFilenameMode === "off" &&
			destination.encryptionDirectoryNames
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"Directory-name encryption must be disabled when filename encryption is off",
				path: ["encryptionDirectoryNames"],
			});
		}
		if (
			destination.encryptionEnabled &&
			destination.additionalFlags?.some((flag) =>
				flag.toLowerCase().startsWith("--crypt-"),
			)
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"Additional --crypt-* flags are not allowed for encrypted destinations",
				path: ["additionalFlags"],
			});
		}
	});

export const apiFindOneDestination = z.object({
	destinationId: z.string().min(1),
});

export const apiRemoveDestination = createSchema
	.pick({
		destinationId: true,
	})
	.required();

export const apiUpdateDestination = createSchema
	.pick({
		name: true,
		accessKey: true,
		bucket: true,
		region: true,
		endpoint: true,
		secretAccessKey: true,
		destinationId: true,
		provider: true,
		additionalFlags: true,
	})
	.required()
	.extend({
		serverId: z.string().optional(),
	});
