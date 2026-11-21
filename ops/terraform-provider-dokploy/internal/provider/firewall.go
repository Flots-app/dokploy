package provider

import (
	"context"
	"fmt"
	"sort"
	"sync"

	"github.com/Flots-app/dokploy/ops/terraform-provider-dokploy/internal/client"
)

const (
	rnTargetPool = "githubRunnerPool"
	rnTargetNode = "githubRunnerNode"
)

func init() {
	s := &Spec{
		Name: "firewall",
		Desc: "A firewall of the Firewalls service (Flots fork of Dokploy): ordered rules per direction (the first match decides) and a default policy, applied to the jobs of GitHub runner pools and machines. " +
			"The pools and machines it applies to are part of the resource: attaching one moves it from the firewall it had, and a target not listed is detached.",
		IDKey:      "firewallId",
		ImportHint: "Import with the firewallId.",
		Fields: []Field{
			{Name: "name", Kind: String, Required: true, Desc: "Name of the firewall, unique in the organization."},
			{Name: "description", Kind: String, FromAPI: rnStrFrom, ToAPI: rnStrTo, Desc: "Free text. Empty for none."},
			{Name: "inbound_policy", Kind: String, OneOf: []string{"allow", "deny"}, Desc: "What inbound traffic no rule matches does."},
			{Name: "outbound_policy", Kind: String, OneOf: []string{"allow", "deny"}, Desc: "What outbound traffic no rule matches does."},
			{Name: "rules", Kind: JSON, Desc: "JSON array of rules, in order (max 100). Each rule is an object with id, direction (inbound or outbound), action (allow or deny), protocol (any, tcp, udp or icmp), ports (null, or text such as 443, 80,443 or 8000-9000), peer ({type: object, object: internet|private|tailnet|dokploy|any} or {type: addresses, addresses: [...]}) and description (null or text). Write every key, as jsonencode() does: the value is compared as stored."},
			{Name: "runner_pool_ids", Kind: StringSet, Desc: "GitHub runner pools the firewall applies to."},
			{Name: "runner_node_ids", Kind: StringSet, Desc: "GitHub runner machines the firewall applies to (a machine with its own firewall ignores its pool's)."},
			{Name: "revision", Kind: Int, ReadOnly: true, Volatile: true, Desc: "Grows with every change of the firewall."},
			{Name: "created_at", Kind: String, ReadOnly: true, Desc: "Creation date."},
		},
	}
	s.Read = func(ctx context.Context, c *client.Client, id string) (map[string]any, error) {
		list, err := rnList(ctx, c, "firewall.list")
		if err != nil {
			return nil, err
		}
		fw, err := rnFind(list, "firewallId", id)
		if err != nil {
			return nil, err
		}
		out := rnClone(fw)
		pools, nodes := []any{}, []any{}
		targets, _ := fw["targets"].([]any)
		for _, t := range targets {
			m := rnMap(t)
			switch m["type"] {
			case rnTargetPool:
				pools = append(pools, asString(m["id"]))
			case rnTargetNode:
				nodes = append(nodes, asString(m["id"]))
			}
		}
		out["runnerPoolIds"], out["runnerNodeIds"] = pools, nodes
		return out, nil
	}
	s.Create = func(ctx context.Context, c *client.Client, in Input) (string, error) {
		body := rnClone(in.Body)
		delete(body, "runnerPoolIds")
		delete(body, "runnerNodeIds")
		var out map[string]any
		if err := c.TRPCMutate(ctx, "firewall.create", body, &out); err != nil {
			return "", err
		}
		id := asString(out["firewallId"])
		if id == "" {
			return "", fmt.Errorf("the API answer carries no firewallId")
		}
		if err := rnFirewallAttach(ctx, c, id, rnStrings(in.Body["runnerPoolIds"]), rnStrings(in.Body["runnerNodeIds"]), nil, nil); err != nil {
			// The engine only records an object whose creation succeeded:
			// take the half-built firewall away rather than orphan it.
			if rerr := c.TRPCMutate(ctx, "firewall.remove", map[string]any{"firewallId": id}, nil); rerr != nil {
				return "", fmt.Errorf("%w (and the half-built firewall %s could not be removed: %v)", err, id, rerr)
			}
			return "", err
		}
		return id, nil
	}
	s.Update = func(ctx context.Context, c *client.Client, in Input) error {
		body := rnClone(in.Body)
		delete(body, "runnerPoolIds")
		delete(body, "runnerNodeIds")
		// A revision is not sent: the plan comes from the state, which is as
		// fresh as Terraform can make it.
		if err := c.TRPCMutate(ctx, "firewall.update", body, nil); err != nil {
			return err
		}
		wantPools, wantNodes := rnStrings(in.Body["runnerPoolIds"]), rnStrings(in.Body["runnerNodeIds"])
		havePools, haveNodes := rnStrings(in.Remote["runnerPoolIds"]), rnStrings(in.Remote["runnerNodeIds"])
		return rnFirewallAttach(ctx, c, in.ID, rnMinus(wantPools, havePools), rnMinus(wantNodes, haveNodes), rnMinus(havePools, wantPools), rnMinus(haveNodes, wantNodes))
	}
	s.Delete = func(ctx context.Context, c *client.Client, id string) error {
		return c.TRPCMutate(ctx, "firewall.remove", map[string]any{"firewallId": id}, nil)
	}
	register(s)
}

// rnFirewallMu serializes the changes of firewall memberships: Terraform applies
// resources in parallel and detaching is not scoped to a firewall.
var rnFirewallMu sync.Mutex

// rnFirewallHolds reports whether the firewall currently has the target attached.
func rnFirewallHolds(ctx context.Context, c *client.Client, id, typ, target string) (bool, error) {
	list, err := rnList(ctx, c, "firewall.list")
	if err != nil {
		return false, err
	}
	fw, err := rnFind(list, "firewallId", id)
	if err != nil {
		return false, err
	}
	targets, _ := fw["targets"].([]any)
	for _, t := range targets {
		m := rnMap(t)
		if m["type"] == typ && asString(m["id"]) == target {
			return true, nil
		}
	}
	return false, nil
}

// rnFirewallAttach attaches the given targets to the firewall and detaches the
// others.
func rnFirewallAttach(ctx context.Context, c *client.Client, id string, addPools, addNodes, dropPools, dropNodes []string) error {
	rnFirewallMu.Lock()
	defer rnFirewallMu.Unlock()
	attach := func(typ string, ids []string) error {
		for _, t := range ids {
			err := c.TRPCMutate(ctx, "firewall.attach", map[string]any{"firewallId": id, "target": map[string]any{"type": typ, "id": t}}, nil)
			if err != nil {
				return fmt.Errorf("attach %s %s: %w", typ, t, err)
			}
		}
		return nil
	}
	detach := func(typ string, ids []string) error {
		for _, t := range ids {
			// firewall.detach names only the target, not the firewall: when another
			// firewall of the same apply has already taken it over, detaching now
			// would leave the target without any firewall. Only detach what this
			// firewall still holds.
			held, herr := rnFirewallHolds(ctx, c, id, typ, t)
			if herr != nil {
				return fmt.Errorf("read the firewall before detaching %s %s: %w", typ, t, herr)
			}
			if !held {
				continue
			}
			err := c.TRPCMutate(ctx, "firewall.detach", map[string]any{"target": map[string]any{"type": typ, "id": t}}, nil)
			if err != nil {
				return fmt.Errorf("detach %s %s: %w", typ, t, err)
			}
		}
		return nil
	}
	for _, step := range []func() error{
		func() error { return detach(rnTargetPool, dropPools) },
		func() error { return detach(rnTargetNode, dropNodes) },
		func() error { return attach(rnTargetPool, addPools) },
		func() error { return attach(rnTargetNode, addNodes) },
	} {
		if err := step(); err != nil {
			return err
		}
	}
	return nil
}

// rnStrings converts a decoded JSON array of strings, sorted.
func rnStrings(v any) []string {
	items, _ := v.([]any)
	out := make([]string, 0, len(items))
	for _, e := range items {
		out = append(out, asString(e))
	}
	sort.Strings(out)
	return out
}

// rnMinus returns the elements of a that are not in b.
func rnMinus(a, b []string) []string {
	in := make(map[string]bool, len(b))
	for _, e := range b {
		in[e] = true
	}
	var out []string
	for _, e := range a {
		if !in[e] {
			out = append(out, e)
		}
	}
	return out
}
