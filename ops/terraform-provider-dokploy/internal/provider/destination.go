package provider

import (
	"context"
	"fmt"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

// bkPlannedString returns the planned value of a string attribute when it is
// known and set (so, configured: an unset Optional+Computed attribute is
// unknown on create).
func bkPlannedString(plan Obj, name string) (string, bool) {
	v, ok := plan[name]
	if !ok {
		return "", false
	}
	return stringOf(v)
}

func init() {
	s := &Spec{
		Name: "destination",
		Desc: "An S3-compatible backup destination (rclone). The access keys and the encryption passwords are write-only: Dokploy keeps them, Terraform never stores them. " +
			"Dokploy cannot change the encryption settings of an existing destination, so they replace it (and Dokploy deletes the backup schedules that use it); " +
			"on an encrypted destination the storage settings (s3_provider, bucket, region, endpoint, additional_flags) are immutable too.",
		IDKey:          "destinationId",
		ImportHint:     "Import with the destinationId.",
		SecretsVersion: true,
		Fields: []Field{
			{Name: "name", Kind: String, Required: true, Desc: "Name of the destination."},
			{Name: "s3_provider", API: "provider", Kind: String, Default: "Other", Desc: "rclone S3 provider (--s3-provider): AWS, Cloudflare, Minio, Other, ... Defaults to Other. Not named provider: that is a reserved word in a resource block."},
			{Name: "bucket", Kind: String, Required: true, Desc: "Bucket name."},
			{Name: "region", Kind: String, Default: "", Desc: "Region of the bucket (may be empty for some providers)."},
			{Name: "endpoint", Kind: String, Default: "", Desc: "S3 endpoint URL (empty for AWS)."},
			{Name: "additional_flags", Kind: StringList, Desc: "Extra rclone flags, for example --s3-sign-accept-encoding=false."},
			{Name: "access_key_wo", API: "accessKey", Kind: String, WriteOnly: true, Desc: "Access key id. Required on creation; when left out on an update, the key Dokploy holds is kept."},
			{Name: "secret_access_key_wo", API: "secretAccessKey", Kind: String, WriteOnly: true, Desc: "Secret access key. Required on creation; when left out on an update, the key Dokploy holds is kept."},
			{Name: "encryption_enabled", Kind: Bool, ForceNew: true, Default: false, Desc: "Encrypt the backups client-side with rclone crypt. Changing it replaces the destination."},
			{Name: "encryption_key_management", Kind: String, ForceNew: true, Default: "dokploy", OneOf: []string{"dokploy", "customer"}, Desc: "dokploy: Dokploy generates and keeps the keys; customer: you give encryption_password_wo. Only meaningful with encryption_enabled."},
			{Name: "encryption_filename_mode", Kind: String, ForceNew: true, Default: "standard", OneOf: []string{"standard", "obfuscate", "off"}, Desc: "How file names are encrypted. Only meaningful with encryption_enabled."},
			{Name: "encryption_directory_names", Kind: Bool, ForceNew: true, Default: true, Desc: "Encrypt directory names too (forced to false when encryption_filename_mode is off). Only meaningful with encryption_enabled."},
			{Name: "encryption_password_wo", API: "encryptionPassword", Kind: String, WriteOnly: true, Desc: "Encryption password, for encryption_key_management = customer; used on creation only (an existing destination cannot be re-keyed)."},
			{Name: "encryption_password2_wo", API: "encryptionPassword2", Kind: String, WriteOnly: true, Desc: "Optional second rclone crypt password (salt), customer-managed keys only; used on creation only."},
			{Name: "created_at", Kind: String, ReadOnly: true, Desc: "Creation date."},
		},
	}
	s.UseREST(CRUD{
		Router: "destination",
		// destination.update wants the whole storage definition, secrets
		// included (every field is required by its schema) and ignores the
		// encryption settings: start from what Dokploy holds and overlay the
		// planned values, so a plain update never wipes the keys.
		UpdateBody: func(in Input) map[string]any {
			m := overlay(in.Remote, in.Body)
			out := pick(m, "destinationId", "name", "accessKey", "bucket", "region", "endpoint", "secretAccessKey", "provider")
			if flags, ok := m["additionalFlags"].([]any); ok {
				out["additionalFlags"] = flags
			} else {
				out["additionalFlags"] = []any{}
			}
			return out
		},
	})
	create := s.Create
	s.Create = func(ctx context.Context, c *client.Client, in Input) (string, error) {
		body := in.Body
		for _, k := range []string{"accessKey", "secretAccessKey"} {
			if _, ok := body[k]; !ok {
				return "", fmt.Errorf("access_key_wo and secret_access_key_wo are required to create a destination")
			}
		}
		// destination.create requires the key even when empty.
		if _, ok := body["additionalFlags"]; !ok {
			body["additionalFlags"] = []any{}
		}
		if on, _ := body["encryptionEnabled"].(bool); !on {
			// Dokploy forces the defaults when encryption is off: refuse a
			// configuration that would read back differently (and, being
			// ForceNew, replace the destination at every run).
			for name, def := range map[string]string{"encryption_key_management": "dokploy", "encryption_filename_mode": "standard"} {
				if v, ok := bkPlannedString(in.Plan, name); ok && v != def {
					return "", fmt.Errorf("%s = %q requires encryption_enabled = true", name, v)
				}
			}
			if v, ok := fromTF(Bool, in.Plan["encryption_directory_names"]); ok && v == false {
				return "", fmt.Errorf("encryption_directory_names = false requires encryption_enabled = true")
			}
		} else if body["encryptionFilenameMode"] == "off" {
			// The schema refuses directory-name encryption without file-name
			// encryption.
			body["encryptionDirectoryNames"] = false
		}
		return create(ctx, c, in)
	}
	register(s)
}
