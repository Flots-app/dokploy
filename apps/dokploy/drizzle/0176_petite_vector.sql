ALTER TABLE "destination" ADD COLUMN "encryptionEnabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "destination" ADD COLUMN "encryptionPassword" text;--> statement-breakpoint
ALTER TABLE "destination" ADD COLUMN "encryptionPassword2" text;--> statement-breakpoint
ALTER TABLE "destination" ADD COLUMN "encryptionFilenameMode" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "destination" ADD COLUMN "encryptionDirectoryNames" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "destination" ADD CONSTRAINT "destination_encryption_password_required" CHECK (NOT "destination"."encryptionEnabled" OR "destination"."encryptionPassword" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "destination" ADD CONSTRAINT "destination_encryption_filename_mode" CHECK ("destination"."encryptionFilenameMode" IN ('standard', 'obfuscate', 'off'));