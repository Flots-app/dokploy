package provider

import (
	"net/http"
	"regexp"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
)

func TestServerDataSource(t *testing.T) {
	s := newSrvFake(t)
	deploy := s.seed("server", srvProdDeploy())
	build := s.seed("server", srvProdBuild())
	twin := srvProdDeploy()
	twin["name"] = "twin"
	s.seed("server", twin)
	twin2 := srvProdDeploy()
	twin2["name"] = "twin"
	s.seed("server", twin2)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: providerBlock(s.URL) + `
data "dokploy_server" "build" {
  name = "kvincent-mac-mini-m4"
}
data "dokploy_server" "deploy" {
  name = "ubuntu-8gb-fsn1-1-prd"
}
`,
				Check: resource.ComposeTestCheckFunc(
					resource.TestCheckResourceAttr("data.dokploy_server.build", "id", build),
					resource.TestCheckResourceAttr("data.dokploy_server.build", "server_type", "build"),
					resource.TestCheckResourceAttr("data.dokploy_server.build", "is_default_build_server", "true"),
					resource.TestCheckResourceAttr("data.dokploy_server.build", "ip_address", "100.115.98.81"),
					resource.TestCheckResourceAttr("data.dokploy_server.build", "ssh_key_id", "key-2"),
					resource.TestCheckResourceAttr("data.dokploy_server.deploy", "id", deploy),
					resource.TestCheckResourceAttr("data.dokploy_server.deploy", "port", "2200"),
					resource.TestCheckResourceAttr("data.dokploy_server.deploy", "enable_docker_cleanup", "true"),
					resource.TestCheckResourceAttr("data.dokploy_server.deploy", "server_status", "active"),
				),
			},
			{
				Config: providerBlock(s.URL) + `
data "dokploy_server" "none" {
  name = "nope"
}
`,
				ExpectError: regexp.MustCompile(`no\s+server\s+named\s+"nope"`),
			},
			{
				Config: providerBlock(s.URL) + `
data "dokploy_server" "twin" {
  name = "twin"
}
`,
				ExpectError: regexp.MustCompile(`2\s+servers\s+are\s+named`),
			},
		},
	})
}

func TestProjectDataSource(t *testing.T) {
	s := newSrvFake(t)
	id := s.seed("project", map[string]any{
		"name": "Flots", "description": "main", "organizationId": "org-1",
		"env": "SECRET_TOKEN=PROJECT-FIXTURE-VALUE\n",
		"environments": []any{
			map[string]any{"environmentId": "env-prod", "isDefault": true, "name": "production"},
			map[string]any{"environmentId": "env-stg", "isDefault": false, "name": "staging"},
		},
	})
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config: providerBlock(s.URL) + `
data "dokploy_project" "p" {
  name = "Flots"
}
`,
			Check: resource.ComposeTestCheckFunc(
				resource.TestCheckResourceAttr("data.dokploy_project.p", "id", id),
				resource.TestCheckResourceAttr("data.dokploy_project.p", "description", "main"),
				resource.TestCheckResourceAttr("data.dokploy_project.p", "default_environment_id", "env-prod"),
				resource.TestCheckResourceAttr("data.dokploy_project.p", "environment_ids.production", "env-prod"),
				resource.TestCheckResourceAttr("data.dokploy_project.p", "environment_ids.staging", "env-stg"),
				resource.TestCheckNoResourceAttr("data.dokploy_project.p", "env"),
			),
		}},
	})
}

func TestGithubProviderDataSource(t *testing.T) {
	s := newSrvFake(t)
	s.hooks["gitProvider.getAll"] = func(w http.ResponseWriter, _ map[string]any) bool {
		srvJSON(w, http.StatusOK, []any{
			map[string]any{
				"bitbucket": nil, "createdAt": "2025-06-09T14:54:07.032Z", "gitProviderId": "gp-gl", "gitea": nil,
				"github": nil, "gitlab": map[string]any{"gitlabId": "gl-1", "isConfigured": true}, "isOwner": true,
				"name": "shared-name", "organizationId": "org-1", "providerType": "gitlab", "sharedWithOrganization": false,
			},
			map[string]any{
				"bitbucket": nil, "createdAt": "2025-06-09T14:54:07.032Z", "gitProviderId": "gp-gh", "gitea": nil, "gitlab": nil,
				"github": map[string]any{
					"githubAppId": float64(1384589), "githubAppName": "https://github.com/apps/flots-dokploy-2025-06-09",
					"githubId": "gh-1", "githubInstallationId": "70528431", "isConfigured": true,
				},
				"isOwner": true, "name": "shared-name", "organizationId": "org-1", "providerType": "github", "sharedWithOrganization": true,
			},
		})
		return true
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: providerBlock(s.URL) + `
data "dokploy_github_provider" "gh" {
  name = "shared-name"
}
`,
				Check: resource.ComposeTestCheckFunc(
					resource.TestCheckResourceAttr("data.dokploy_github_provider.gh", "id", "gp-gh"),
					resource.TestCheckResourceAttr("data.dokploy_github_provider.gh", "git_provider_id", "gp-gh"),
					resource.TestCheckResourceAttr("data.dokploy_github_provider.gh", "github_id", "gh-1"),
					resource.TestCheckResourceAttr("data.dokploy_github_provider.gh", "github_app_id", "1384589"),
					resource.TestCheckResourceAttr("data.dokploy_github_provider.gh", "github_installation_id", "70528431"),
					resource.TestCheckResourceAttr("data.dokploy_github_provider.gh", "is_configured", "true"),
					resource.TestCheckResourceAttr("data.dokploy_github_provider.gh", "shared_with_organization", "true"),
				),
			},
			{
				Config: providerBlock(s.URL) + `
data "dokploy_github_provider" "none" {
  name = "unknown"
}
`,
				ExpectError: regexp.MustCompile(`no\s+GitHub\s+provider\s+named`),
			},
		},
	})
}

func TestOrganizationDataSource(t *testing.T) {
	s := newSrvFake(t)
	s.hooks["organization.active"] = func(w http.ResponseWriter, _ map[string]any) bool {
		srvJSON(w, http.StatusOK, map[string]any{
			"createdAt": "2025-06-07T08:50:34.782Z", "id": "H6kENwEnUToStDD2th03b", "logo": "", "metadata": nil,
			"name": "Flots", "ownerId": "user-1", "slug": nil,
		})
		return true
	}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config: providerBlock(s.URL) + `
data "dokploy_organization" "org" {}
`,
			Check: resource.ComposeTestCheckFunc(
				resource.TestCheckResourceAttr("data.dokploy_organization.org", "id", "H6kENwEnUToStDD2th03b"),
				resource.TestCheckResourceAttr("data.dokploy_organization.org", "name", "Flots"),
				resource.TestCheckResourceAttr("data.dokploy_organization.org", "owner_id", "user-1"),
			),
		}},
	})
}
