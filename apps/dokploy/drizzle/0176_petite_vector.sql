ALTER TABLE "destination" ADD COLUMN "encryptionEnabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "destination" ADD COLUMN "encryptionKeyManagement" text DEFAULT 'dokploy' NOT NULL;--> statement-breakpoint
ALTER TABLE "destination" ADD COLUMN "encryptionPassword" text;--> statement-breakpoint
ALTER TABLE "destination" ADD COLUMN "encryptionPassword2" text;--> statement-breakpoint
ALTER TABLE "destination" ADD COLUMN "encryptionFilenameMode" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "destination" ADD COLUMN "encryptionDirectoryNames" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "destination" ADD CONSTRAINT "destination_encryption_password_required" CHECK (NOT "destination"."encryptionEnabled" OR "destination"."encryptionPassword" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "destination" ADD CONSTRAINT "destination_encryption_key_management" CHECK ("destination"."encryptionKeyManagement" IN ('dokploy', 'customer'));--> statement-breakpoint
ALTER TABLE "destination" ADD CONSTRAINT "destination_managed_encryption_password2_required" CHECK (NOT "destination"."encryptionEnabled" OR "destination"."encryptionKeyManagement" <> 'dokploy' OR "destination"."encryptionPassword2" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "destination" ADD CONSTRAINT "destination_encryption_filename_mode" CHECK ("destination"."encryptionFilenameMode" IN ('standard', 'obfuscate', 'off'));--> statement-breakpoint
ALTER TABLE "destination" ADD CONSTRAINT "destination_encryption_directory_name_mode" CHECK ("destination"."encryptionFilenameMode" <> 'off' OR NOT "destination"."encryptionDirectoryNames");--> statement-breakpoint
ALTER TABLE "destination" ADD CONSTRAINT "destination_encryption_disabled_secrets" CHECK ("destination"."encryptionEnabled" OR ("destination"."encryptionPassword" IS NULL AND "destination"."encryptionPassword2" IS NULL));
