/**
 * Firewalls: a platform service, like the network firewalls of a cloud
 * provider. A firewall holds ordered rules for each direction (the first
 * matching rule decides) and a default policy for the traffic no rule
 * matches. Resources of other services attach to it: GitHub runner pools and
 * machines today, servers and applications later. Each resource type enforces
 * it with its own backend (nftables on Linux, pf on macOS).
 */
import { createHash } from "node:crypto";
import {
	type FirewallPeer,
	type FirewallPolicy,
	type FirewallRule,
	ipFamily,
	isAddress,
	parsePorts,
} from "./rules";

export interface AddressSet {
	v4: string[];
	v6: string[];
}

/**
 * Everything that is not the public Internet: private, shared (CGNAT, which
 * Tailscale uses), loopback, link-local, documentation, benchmarking,
 * multicast and reserved ranges (IANA special-purpose registries).
 */
export const NON_PUBLIC: AddressSet = {
	v4: [
		"0.0.0.0/8",
		"10.0.0.0/8",
		"100.64.0.0/10",
		"127.0.0.0/8",
		"169.254.0.0/16",
		"172.16.0.0/12",
		"192.0.0.0/24",
		"192.0.2.0/24",
		"192.88.99.0/24",
		"192.168.0.0/16",
		"198.18.0.0/15",
		"198.51.100.0/24",
		"203.0.113.0/24",
		"224.0.0.0/4",
		"240.0.0.0/4",
	],
	v6: [
		"::/127",
		"::ffff:0:0/96",
		"100::/64",
		"2001:db8::/32",
		"fc00::/7",
		"fe80::/10",
		"ff00::/8",
	],
};

const PRIVATE: AddressSet = {
	v4: [
		"10.0.0.0/8",
		"100.64.0.0/10",
		"169.254.0.0/16",
		"172.16.0.0/12",
		"192.168.0.0/16",
	],
	v6: ["fc00::/7", "fe80::/10"],
};

const TAILNET: AddressSet = {
	v4: ["100.64.0.0/10"],
	v6: ["fd7a:115c:a1e0::/48"],
};

const ANY: AddressSet = { v4: ["0.0.0.0/0"], v6: ["::/0"] };

export interface FirewallDefinition {
	firewallId: string;
	name: string;
	inboundPolicy: FirewallPolicy;
	outboundPolicy: FirewallPolicy;
	rules: FirewallRule[];
}

/** A rule with its addresses resolved. */
export interface CompiledRule {
	ruleId: string;
	action: "allow" | "deny";
	protocol: FirewallRule["protocol"];
	ports: [number, number][] | null;
	/** Matches the addresses outside the set (the Internet: not NON_PUBLIC). */
	negate: boolean;
	addresses: AddressSet;
}

export interface CompiledDirection {
	policy: FirewallPolicy;
	rules: CompiledRule[];
}

export interface CompiledFirewall {
	firewallId: string;
	name: string;
	inbound: CompiledDirection;
	outbound: CompiledDirection;
	/** Rules left out, and why (an address set that resolved to nothing). */
	skipped: { ruleId: string; reason: string }[];
}

const familyOf = (value: string) => ipFamily(value.split("/")[0] ?? "");

const split = (addresses: string[]): AddressSet => ({
	v4: addresses.filter((item) => familyOf(item) === 4),
	v6: addresses.filter((item) => familyOf(item) === 6),
});

/** The addresses of a peer; `dokploy` needs the addresses of this server. */
export const resolvePeer = (
	peer: FirewallPeer,
	context: { dokployAddresses: string[] },
): { negate: boolean; addresses: AddressSet } => {
	if (peer.type === "addresses") {
		return { negate: false, addresses: split(peer.addresses) };
	}
	switch (peer.object) {
		case "internet":
			return { negate: true, addresses: NON_PUBLIC };
		case "private":
			return { negate: false, addresses: PRIVATE };
		case "tailnet":
			return { negate: false, addresses: TAILNET };
		case "dokploy":
			return {
				negate: false,
				addresses: split(context.dokployAddresses.filter(isAddress)),
			};
		case "any":
			return { negate: false, addresses: ANY };
	}
};

export const compileFirewall = (
	firewall: FirewallDefinition,
	context: { dokployAddresses: string[] },
): CompiledFirewall => {
	const skipped: CompiledFirewall["skipped"] = [];
	const direction = (
		name: "inbound" | "outbound",
		policy: FirewallPolicy,
	): CompiledDirection => ({
		policy,
		rules: firewall.rules
			.filter((rule) => rule.direction === name)
			.flatMap((rule): CompiledRule[] => {
				const { negate, addresses } = resolvePeer(rule.peer, context);
				if (!negate && !addresses.v4.length && !addresses.v6.length) {
					skipped.push({
						ruleId: rule.id,
						reason:
							rule.peer.type === "object" && rule.peer.object === "dokploy"
								? "the addresses of the Dokploy server are not known"
								: "no address",
					});
					return [];
				}
				return [
					{
						ruleId: rule.id,
						action: rule.action,
						protocol: rule.protocol,
						ports:
							rule.protocol === "icmp" || !rule.ports
								? null
								: parsePorts(rule.ports),
						negate,
						addresses,
					},
				];
			}),
	});
	return {
		firewallId: firewall.firewallId,
		name: firewall.name,
		inbound: direction("inbound", firewall.inboundPolicy),
		outbound: direction("outbound", firewall.outboundPolicy),
		skipped,
	};
};

/** Whether a direction filters anything: a default allow with no rule does not. */
export const filters = (direction: CompiledDirection) =>
	direction.policy === "deny" || direction.rules.length > 0;

/** Hash of a ruleset as a machine loads it: the machine reports it back. */
export const rulesetHash = (text: string) =>
	createHash("sha256").update(text).digest("hex").slice(0, 32);
