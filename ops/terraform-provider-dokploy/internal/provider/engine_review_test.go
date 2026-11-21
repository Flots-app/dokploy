package provider

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

// remoteEnvEntry parses the remote environment text the way Dokploy's dotenv
// would see its entries and returns the value of one key.
func remoteEnvEntry(env, key string) (string, bool) {
	for _, e := range parseEnv(env) {
		if e.Key == key {
			v := strings.TrimSpace(e.Value)
			if len(v) >= 2 && (v[0] == '\'' || v[0] == '"' || v[0] == '`') && v[len(v)-1] == v[0] {
				v = v[1 : len(v)-1]
			}
			return v, true
		}
	}
	return "", false
}

// A secret holding '#', a quote or a line break must be stored quoted: dotenv
// would cut it at '#', and a line break must not add a variable.
func TestSecretValuesAreQuotedForDotenv(t *testing.T) {
	f, srv := newFakeAPI(t)
	pem := "-----BEGIN-----\nline-two\n-----END-----"
	cfg := providerBlock(srv.URL) + `
resource "dokploy_project" "p" {
  name            = "quoting"
  secret_env_keys = ["HASHED", "MULTI", "INJECT", "QUOTED"]
  secret_env_wo = {
    HASHED = "Abc#123xyz"
    MULTI  = "-----BEGIN-----\nline-two\n-----END-----"
    INJECT = "first\nINJECTED=1"
    QUOTED = "it's \"both\""
  }
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config: cfg,
			Check: func(s *terraform.State) error {
				env := fmt.Sprint(f.get("project", idOf(s, "dokploy_project.p"))["env"])
				for key, want := range map[string]string{"HASHED": "Abc#123xyz", "MULTI": pem, "INJECT": "first\nINJECTED=1"} {
					if got, ok := remoteEnvEntry(env, key); !ok || got != want {
						return fmt.Errorf("%s reads back as %q, want %q (text %q)", key, got, want, env)
					}
				}
				if _, injected := remoteEnvEntry(env, "INJECTED"); injected {
					return fmt.Errorf("a line break in a value added a variable: %q", env)
				}
				if got, ok := remoteEnvEntry(env, "QUOTED"); !ok || got != "it's \"both\"" {
					// both quote characters present: backtick is used
					return fmt.Errorf("QUOTED reads back as %q (text %q)", got, env)
				}
				return notInState(s, "Abc#123xyz")
			},
		}},
	})
}

func TestEnvDeclarationsAreValidatedAtPlanTime(t *testing.T) {
	f, srv := newFakeAPI(t)
	for name, tc := range map[string]struct{ body, want string }{
		"hash in a public value": {`env = { URL = "https://x.test/#frag" }`, `dotenv would read differently`},
		"bad public name":        {`env = { "BAD KEY" = "1" }`, `not a valid environment variable name`},
		"bad secret name":        {`secret_env_keys = ["1TOKEN"]`, `not a valid environment variable name`},
		"orphan secret_env_wo":   {`secret_env_wo = { A = "x" }`, `secret_env_keys is not`},
	} {
		t.Run(name, func(t *testing.T) {
			resource.UnitTest(t, resource.TestCase{
				ProtoV6ProviderFactories: factories(),
				Steps: []resource.TestStep{{
					Config:      providerBlock(srv.URL) + "resource \"dokploy_project\" \"p\" {\n  name = \"validate\"\n  " + tc.body + "\n}\n",
					ExpectError: regexp.MustCompile(tc.want),
				}},
			})
			if n := f.called("project.create"); n != 0 {
				t.Fatalf("project.create was called %d times: the mistake must be caught before anything is created", n)
			}
		})
	}
}

// A write-only secret is sent on creation and when its version changes, never on
// an unrelated update: a secret rotated in Dokploy must survive.
func TestSecretWriteOnlyIsNotResentOnUnrelatedUpdates(t *testing.T) {
	f, srv := newFakeAPI(t)
	cfg := func(url string) string {
		return providerBlock(srv.URL) + `
resource "dokploy_project" "p" {
  name                  = "rotation"
  env                   = { PUBLIC = "` + url + `" }
  secret_env_keys       = ["TOKEN_A"]
  secret_env_wo         = { TOKEN_A = "version-one" }
  secret_env_wo_version = 1
}
`
	}
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{Config: cfg("a"), Check: func(s *terraform.State) error { id = idOf(s, "dokploy_project.p"); return nil }},
			{
				PreConfig: func() {
					f.set("project", id, "env", "PUBLIC=a\nTOKEN_A=rotated-in-dokploy\n")
				},
				Config: cfg("b"),
				Check: func(*terraform.State) error {
					got, _ := remoteEnvEntry(fmt.Sprint(f.get("project", id)["env"]), "TOKEN_A")
					if got != "rotated-in-dokploy" {
						return fmt.Errorf("the rotated secret was reverted to %q", got)
					}
					return nil
				},
			},
		},
	})
}

// A 404 that is not Dokploy's "object not found" (a proxy page while the dashboard
// restarts) must fail the refresh, never plan a duplicate create.
func TestPlainNotFoundDoesNotDropTheResource(t *testing.T) {
	f, srv := newFakeAPI(t)
	var broken atomic.Bool
	f.hooks["project.one"] = func(w http.ResponseWriter, body map[string]any) bool {
		if broken.Load() {
			http.Error(w, "404 page not found", http.StatusNotFound)
			return true
		}
		return false
	}
	cfg := providerBlock(srv.URL) + `
resource "dokploy_project" "p" {
  name = "keep"
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{Config: cfg},
			{
				PreConfig:   func() { broken.Store(true) },
				Config:      cfg,
				ExpectError: regexp.MustCompile(`404 page not found`),
			},
			{PreConfig: func() { broken.Store(false) }, Config: cfg},
		},
	})
	if n := f.called("project.create"); n != 1 {
		t.Fatalf("project.create was called %d times, want 1", n)
	}
}

// A Create hook that fails after the object exists keeps its id in the state
// (tainted): the retry replaces it instead of leaving a duplicate.
var failAfterCreate atomic.Bool

func init() {
	s := &Spec{
		Name:  "create_fail_probe",
		IDKey: "probeId",
		Fields: []Field{
			{Name: "name", Kind: String, Required: true},
		},
	}
	s.UseREST(CRUD{Router: "probe"})
	inner := s.Create
	s.Create = func(ctx context.Context, c *client.Client, in Input) (string, error) {
		id, err := inner(ctx, c, in)
		if err == nil && failAfterCreate.Load() {
			return id, fmt.Errorf("a follow-up step failed")
		}
		return id, err
	}
	register(s)
}

func TestFailedCreateKeepsTheObjectInTheState(t *testing.T) {
	f, srv := newFakeAPI(t)
	f.routes["probe"] = "probeId"
	cfg := providerBlock(srv.URL) + `
resource "dokploy_create_fail_probe" "p" {
  name = "x"
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				PreConfig:   func() { failAfterCreate.Store(true) },
				Config:      cfg,
				ExpectError: regexp.MustCompile(`follow-up step failed`),
			},
			{
				PreConfig: func() { failAfterCreate.Store(false) },
				Config:    cfg,
				Check: func(*terraform.State) error {
					f.mu.Lock()
					defer f.mu.Unlock()
					if n := len(f.objs["probe"]); n != 1 {
						return fmt.Errorf("%d remote objects after the retry, want exactly 1 (a duplicate was left)", n)
					}
					return nil
				},
			},
		},
	})
}

// An out-of-range Traefik port would leave Dokploy without Traefik, and so without
// the API that could repair it: it must be refused at plan time.
func TestTraefikPortsAreRangeChecked(t *testing.T) {
	_, srv := newFakeAPI(t)
	for _, port := range []string{"70000:70000/tcp", "0:0/tcp", "8080:80/tcp", "9000:443/tcp"} {
		resource.UnitTest(t, resource.TestCase{
			ProtoV6ProviderFactories: factories(),
			Steps: []resource.TestStep{{
				Config: providerBlock(srv.URL) + `
resource "dokploy_web_server_settings" "w" {
  traefik_ports = ["` + port + `"]
}
`,
				ExpectError: regexp.MustCompile(`Invalid Traefik port`),
			}},
		})
	}
}
