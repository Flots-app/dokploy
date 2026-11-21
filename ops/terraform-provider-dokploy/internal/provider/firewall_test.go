package provider

import (
	"fmt"
	"reflect"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/plancheck"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

const rnFirewallRules = `jsonencode([
    {
      id          = "web"
      direction   = "outbound"
      action      = "allow"
      protocol    = "tcp"
      ports       = "22,80,443"
      peer        = { type = "object", object = "internet" }
      description = "SSH, HTTP and HTTPS"
    },
    {
      id          = "lan"
      direction   = "outbound"
      action      = "deny"
      protocol    = "any"
      ports       = null
      peer        = { type = "addresses", addresses = ["10.0.0.0/8", "192.168.0.0/16"] }
      description = null
    },
  ])`

func TestFirewallLifecycleAndAttachments(t *testing.T) {
	f, srv := newFakeTRPC(t)
	pool := f.seedPool(rnProdPoolJSON)
	f.seedNode(rnProdNodeM4JSON)
	const addr = "dokploy_firewall.web"
	cfg := func(extra string) string {
		return providerBlock(srv.URL) + `
resource "dokploy_firewall" "web" {
  name            = "web-only"
  inbound_policy  = "deny"
  outbound_policy = "deny"
  rules           = ` + rnFirewallRules + `
` + extra + `
}
`
	}
	var id string
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		CheckDestroy: func(*terraform.State) error {
			if f.called("firewall.remove") != 1 || len(f.firewalls) != 0 {
				return fmt.Errorf("firewall not removed")
			}
			return nil
		},
		Steps: []resource.TestStep{
			{
				Config: cfg(`runner_pool_ids = ["` + pool + `"]`),
				Check: resource.ComposeTestCheckFunc(
					func(s *terraform.State) error {
						id = idOf(s, addr)
						if f.attached["githubRunnerPool:"+pool] != id {
							return fmt.Errorf("pool not attached: %v", f.attached)
						}
						rules := f.firewalls[id]["rules"].([]any)
						if len(rules) != 2 || rules[0].(map[string]any)["ports"] != "22,80,443" {
							return fmt.Errorf("rules %v", rules)
						}
						return nil
					},
					resource.TestCheckResourceAttr(addr, "revision", "1"),
					resource.TestCheckResourceAttr(addr, "description", ""),
					resource.TestCheckResourceAttr(addr, "runner_pool_ids.#", "1"),
					resource.TestCheckResourceAttr(addr, "runner_node_ids.#", "0"),
				),
			},
			{Config: cfg(`runner_pool_ids = ["` + pool + `"]`), ConfigPlanChecks: resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}}},
			{
				// A machine joins and the pool leaves; the description changes.
				Config: cfg(`
  description     = "no private networks"
  runner_pool_ids = []
  runner_node_ids = ["` + rnProdNodeM4ID + `"]`),
				Check: func(*terraform.State) error {
					if _, still := f.attached["githubRunnerPool:"+pool]; still {
						return fmt.Errorf("pool still attached: %v", f.attached)
					}
					if f.attached["githubRunnerNode:"+rnProdNodeM4ID] != id || len(f.attached) != 1 {
						return fmt.Errorf("attachments %v", f.attached)
					}
					if f.firewalls[id]["description"] != "no private networks" || f.firewalls[id]["revision"] != float64(2) {
						return fmt.Errorf("firewall %v", f.firewalls[id])
					}
					return nil
				},
			},
			{
				// The rules change: the others settings stay (partial update).
				Config: providerBlock(srv.URL) + `
resource "dokploy_firewall" "web" {
  name            = "web-only"
  description     = "no private networks"
  inbound_policy  = "deny"
  outbound_policy = "deny"
  rules = jsonencode([{
    id = "all", direction = "inbound", action = "allow", protocol = "icmp",
    ports = null, peer = { type = "object", object = "tailnet" }, description = "ping"
  }])
  runner_pool_ids = []
  runner_node_ids = ["` + rnProdNodeM4ID + `"]
}
`,
				Check: func(*terraform.State) error {
					rules := f.firewalls[id]["rules"].([]any)
					if len(rules) != 1 || !reflect.DeepEqual(rules[0].(map[string]any)["peer"], map[string]any{"type": "object", "object": "tailnet"}) {
						return fmt.Errorf("rules %v", rules)
					}
					return nil
				},
			},
			{ResourceName: addr, ImportState: true, ImportStateVerify: true},
		},
	})
}

// No firewall exists in production yet: this one is shaped like firewall.list
// returns it, runtime fields included.
func TestFirewallAdoption(t *testing.T) {
	f, srv := newFakeTRPC(t)
	pool := f.seedPool(rnProdPoolJSON)
	f.firewalls["fw-seed"] = map[string]any{
		"firewallId": "fw-seed", "organizationId": "org-1", "name": "internet-only", "description": "Outbound to the public Internet only.",
		"inboundPolicy": "deny", "outboundPolicy": "deny", "revision": float64(7),
		"rules": []any{map[string]any{
			"id": "net", "direction": "outbound", "action": "allow", "protocol": "any", "ports": nil,
			"peer": map[string]any{"type": "object", "object": "internet"}, "description": "The public Internet",
		}},
		"createdAt": "2026-11-10T10:00:00.000Z", "updatedAt": "2026-11-12T10:00:00.000Z",
	}
	f.attached["githubRunnerPool:"+pool] = "fw-seed"
	minimal := providerBlock(srv.URL) + `
import {
  to = dokploy_firewall.net
  id = "fw-seed"
}

resource "dokploy_firewall" "net" {
  name = "internet-only"
}
`
	explicit := providerBlock(srv.URL) + `
import {
  to = dokploy_firewall.net
  id = "fw-seed"
}

resource "dokploy_firewall" "net" {
  name            = "internet-only"
  description     = "Outbound to the public Internet only."
  inbound_policy  = "deny"
  outbound_policy = "deny"
  rules = jsonencode([{
    id          = "net"
    direction   = "outbound"
    action      = "allow"
    protocol    = "any"
    ports       = null
    peer        = { type = "object", object = "internet" }
    description = "The public Internet"
  }])
  runner_pool_ids = ["` + pool + `"]
  runner_node_ids = []
}
`
	empty := resource.ConfigPlanChecks{PreApply: []plancheck.PlanCheck{plancheck.ExpectEmptyPlan()}}
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{Config: minimal, Check: resource.TestCheckResourceAttr("dokploy_firewall.net", "revision", "7")},
			{Config: minimal, ConfigPlanChecks: empty},
			{Config: explicit, ConfigPlanChecks: empty},
		},
	})
	if f.called("firewall.update") != 0 || f.called("firewall.attach") != 0 || f.called("firewall.detach") != 0 {
		t.Fatal("adoption changed the firewall")
	}
}
