package provider

import (
	"fmt"
	"regexp"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/knownvalue"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/statecheck"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
	"github.com/hashicorp/terraform-plugin-testing/tfjsonpath"
)

const r2Endpoint = "https://130d1208c4debd8541f1e0f4402f4d87.eu.r2.cloudflarestorage.com"

func TestDestinationLifecycle(t *testing.T) {
	a := newBackupsAPI(t)
	cfg := func(body string) string {
		return providerBlock(a.srv.URL) + `
resource "dokploy_destination" "d" {
` + body + `
}
`
	}
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: cfg(`
  name                 = "R2"
  s3_provider          = "Cloudflare"
  bucket               = "backups"
  region               = "eeur"
  endpoint             = "` + r2Endpoint + `"
  additional_flags     = ["--s3-sign-accept-encoding=false"]
  access_key_wo        = "fx-TEST-KEY"
  secret_access_key_wo = "fixture-access-key"
  secrets_version      = 1
`),
				ConfigStateChecks: []statecheck.StateCheck{
					statecheck.ExpectKnownValue("dokploy_destination.d", tfjsonpath.New("encryption_enabled"), knownvalue.Bool(false)),
					statecheck.ExpectKnownValue("dokploy_destination.d", tfjsonpath.New("encryption_key_management"), knownvalue.StringExact("dokploy")),
					statecheck.ExpectKnownValue("dokploy_destination.d", tfjsonpath.New("access_key_wo"), knownvalue.Null()),
				},
				Check: func(s *terraform.State) error {
					id = idOf(s, "dokploy_destination.d")
					d := a.get("destination", id)
					if d["accessKey"] != "fx-TEST-KEY" || d["secretAccessKey"] != "fixture-access-key" {
						return fmt.Errorf("keys not sent: %v", d)
					}
					if d["provider"] != "Cloudflare" || d["encryptionFilenameMode"] != "standard" {
						return fmt.Errorf("unexpected destination: %v", d)
					}
					for _, secret := range []string{"fx-TEST-KEY", "fixture-access-key"} {
						if err := notInState(s, secret); err != nil {
							return err
						}
					}
					return nil
				},
			},
			{
				// A plain update does not repeat the keys: they are read back
				// from Dokploy, whose update refuses a payload without them.
				Config: cfg(`
  name             = "R2 renamed"
  s3_provider      = "Cloudflare"
  bucket           = "backups-2"
  region           = "eeur"
  endpoint         = "` + r2Endpoint + `"
  additional_flags = ["--s3-sign-accept-encoding=false"]
  secrets_version  = 1
`),
				Check: func(s *terraform.State) error {
					body := a.calls.last("destination.update")
					if body["accessKey"] != "fx-TEST-KEY" || body["secretAccessKey"] != "fixture-access-key" {
						return fmt.Errorf("the update wiped the keys: %v", body)
					}
					if _, ok := body["encryptionEnabled"]; ok {
						return fmt.Errorf("the update sent encryption settings: %v", body)
					}
					if d := a.get("destination", id); d["name"] != "R2 renamed" || d["bucket"] != "backups-2" {
						return fmt.Errorf("not updated: %v", d)
					}
					return nil
				},
			},
			{
				// Rotating a key: the new value and a new version.
				Config: cfg(`
  name                 = "R2 renamed"
  s3_provider          = "Cloudflare"
  bucket               = "backups-2"
  region               = "eeur"
  endpoint             = "` + r2Endpoint + `"
  additional_flags     = ["--s3-sign-accept-encoding=false"]
  secret_access_key_wo = "rotated-secret"
  secrets_version      = 2
`),
				Check: func(s *terraform.State) error {
					d := a.get("destination", id)
					if d["secretAccessKey"] != "rotated-secret" || d["accessKey"] != "fx-TEST-KEY" {
						return fmt.Errorf("rotation failed: %v", d)
					}
					return notInState(s, "rotated-secret")
				},
			},
			{
				ResourceName:            "dokploy_destination.d",
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"secrets_version"},
			},
		},
	})
}

func TestDestinationEncryptedCustomerKeys(t *testing.T) {
	a := newBackupsAPI(t)
	cfg := func(extra string) string {
		return providerBlock(a.srv.URL) + `
resource "dokploy_destination" "d" {
  name                       = "encrypted"
  bucket                     = "backups"
  endpoint                   = "` + r2Endpoint + `"
  region                     = "eeur"
  access_key_wo              = "fx-ENC"
  secret_access_key_wo       = "enc-secret"
  encryption_enabled         = true
  encryption_key_management  = "customer"
  encryption_password_wo     = "crypt-password-one"
  encryption_password2_wo    = "crypt-password-two"
  encryption_filename_mode   = "off"
  encryption_directory_names = false
` + extra + `
}
`
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: cfg(``),
				Check: func(s *terraform.State) error {
					d := a.get("destination", idOf(s, "dokploy_destination.d"))
					if d["encryptionPassword"] != "crypt-password-one" || d["encryptionPassword2"] != "crypt-password-two" {
						return fmt.Errorf("passwords not sent: %v", d)
					}
					if d["encryptionFilenameMode"] != "off" || d["encryptionDirectoryNames"] != false {
						return fmt.Errorf("unexpected encryption settings: %v", d)
					}
					for _, secret := range []string{"crypt-password-one", "crypt-password-two", "fx-ENC", "enc-secret"} {
						if err := notInState(s, secret); err != nil {
							return err
						}
					}
					return nil
				},
			},
			{
				// Leaving the passwords out of the configuration changes nothing:
				// they cannot be rotated and are not part of the update.
				Config: providerBlock(a.srv.URL) + `
resource "dokploy_destination" "d" {
  name                       = "encrypted renamed"
  bucket                     = "backups"
  endpoint                   = "` + r2Endpoint + `"
  region                     = "eeur"
  encryption_enabled         = true
  encryption_key_management  = "customer"
  encryption_filename_mode   = "off"
  encryption_directory_names = false
}
`,
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("dokploy_destination.d", plancheck.ResourceActionUpdate),
				}},
			},
		},
	})
}

func TestDestinationValidation(t *testing.T) {
	a := newBackupsAPI(t)
	base := func(extra string) string {
		return providerBlock(a.srv.URL) + `
resource "dokploy_destination" "d" {
  name     = "x"
  bucket   = "b"
  endpoint = "https://s3.example.test"
` + extra + `
}
`
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config:      base(``),
				ExpectError: regexp.MustCompile(`access_key_wo and secret_access_key_wo are required`),
			},
			{
				Config: base(`
  access_key_wo              = "a"
  secret_access_key_wo       = "b"
  encryption_filename_mode   = "obfuscate"`),
				ExpectError: regexp.MustCompile(`encryption_filename_mode = "obfuscate" requires encryption_enabled = true`),
			},
			{
				Config: base(`
  access_key_wo        = "a"
  secret_access_key_wo = "b"
  encryption_enabled   = true`),
				// Dokploy-managed keys: the API generates them, none is sent.
				Check: func(s *terraform.State) error {
					d := a.get("destination", idOf(s, "dokploy_destination.d"))
					if d["encryptionKeyManagement"] != "dokploy" || d["encryptionPassword"] != nil {
						return fmt.Errorf("unexpected destination: %v", d)
					}
					return nil
				},
			},
		},
	})
}

// TestDestinationAdoption seeds the two destinations of the production
// Dokploy (the encrypted one with customer keys, the plain one whose
// additionalFlags is null) and imports them with the configuration a human
// would write: no keys, no defaults. The plan must be empty.
func TestDestinationAdoption(t *testing.T) {
	a := newBackupsAPI(t)
	encrypted := a.seed("destination", map[string]any{
		"name": "Cloudflare R2 - backups - encrypted", "provider": "Cloudflare", "bucket": "dokploy-backups",
		"region": "eeur", "endpoint": r2Endpoint, "additionalFlags": []any{},
		"accessKey": "AK-SEED", "secretAccessKey": "SK-SEED",
		"encryptionEnabled": true, "encryptionKeyManagement": "customer", "encryptionFilenameMode": "standard",
		"encryptionDirectoryNames": true, "encryptionPassword": nil, "encryptionPassword2": nil,
		"organizationId": "org-1",
	})
	plain := a.seed("destination", map[string]any{
		"name": "Cloudflare R2 - backups", "provider": "Other", "bucket": "dokploy-backups",
		"region": "eeur", "endpoint": r2Endpoint, "additionalFlags": nil,
		"accessKey": "AK-SEED-2", "secretAccessKey": "SK-SEED-2",
		"encryptionEnabled": false, "encryptionKeyManagement": "dokploy", "encryptionFilenameMode": "standard",
		"encryptionDirectoryNames": true, "encryptionPassword": nil, "encryptionPassword2": nil,
		"organizationId": "org-1",
	})
	cfg := func(plainName string) string {
		return providerBlock(a.srv.URL) + `
import {
  to = dokploy_destination.encrypted
  id = "` + encrypted + `"
}
import {
  to = dokploy_destination.plain
  id = "` + plain + `"
}
resource "dokploy_destination" "encrypted" {
  name                      = "Cloudflare R2 - backups - encrypted"
  s3_provider               = "Cloudflare"
  bucket                    = "dokploy-backups"
  region                    = "eeur"
  endpoint                  = "` + r2Endpoint + `"
  encryption_enabled        = true
  encryption_key_management = "customer"
}
resource "dokploy_destination" "plain" {
  name     = "` + plainName + `"
  bucket   = "dokploy-backups"
  region   = "eeur"
  endpoint = "` + r2Endpoint + `"
}
`
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: cfg("Cloudflare R2 - backups"),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{
					plancheck.ExpectResourceAction("dokploy_destination.encrypted", plancheck.ResourceActionNoop),
					plancheck.ExpectResourceAction("dokploy_destination.plain", plancheck.ResourceActionNoop),
				}},
			},
			{
				Config:           cfg("Cloudflare R2 - backups"),
				ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}},
			},
			{
				// The first change after the adoption keeps the keys Dokploy holds.
				Config: cfg("Cloudflare R2 - backups (renamed)"),
				Check: func(s *terraform.State) error {
					d := a.get("destination", plain)
					if d["name"] != "Cloudflare R2 - backups (renamed)" || d["accessKey"] != "AK-SEED-2" || d["secretAccessKey"] != "SK-SEED-2" {
						return fmt.Errorf("unexpected destination after the update: %v", d)
					}
					body := a.calls.last("destination.update")
					if flags, ok := body["additionalFlags"].([]any); !ok || len(flags) != 0 {
						return fmt.Errorf("additionalFlags should be sent as an empty list: %#v", body["additionalFlags"])
					}
					return nil
				},
			},
		},
	})
}
