/**
 * Rules of the Firewalls service, as operators write them: shared by the
 * server and the UI (no Node.js module here).
 */
import { z } from "zod";

/** Named address sets, resolved when a firewall is compiled. */
export const FIREWALL_OBJECTS = [
	"internet",
	"private",
	"tailnet",
	"dokploy",
	"any",
] as const;
export type FirewallObject = (typeof FIREWALL_OBJECTS)[number];

export const FIREWALL_OBJECT_LABELS: Record<FirewallObject, string> = {
	internet: "Internet (public addresses)",
	private: "Private networks (LAN, VPN, tailnet)",
	tailnet: "Tailnet (Tailscale)",
	dokploy: "Dokploy server",
	any: "Anywhere",
};

// zod's validators refuse what nftables refuses too, such as "/08" prefixes.
const IPV4 = z.union([z.ipv4(), z.cidrv4()]);
const IPV6 = z.union([z.ipv6(), z.cidrv6()]);

/** 4 or 6 for an address or a network ("10.0.0.0/8", "fd00::1"), 0 otherwise. */
export const addressFamily = (value: string): 0 | 4 | 6 =>
	IPV4.safeParse(value).success ? 4 : IPV6.safeParse(value).success ? 6 : 0;

/** "10.0.0.0/8", "192.168.1.10", "fd00::/8": an address or a network. */
export const isAddress = (value: string) => addressFamily(value) !== 0;

/**
 * An IPv6 address or network in its canonical text (RFC 5952), as the
 * machines load it: nftables refuses the mixed notation of RFC 4291 that zod
 * accepts, such as 64:ff9b::192.0.2.33. Anything else is returned as it is.
 */
export const canonicalAddress = (value: string) => {
	if (addressFamily(value) !== 6) return value;
	const [address, prefix] = value.split("/");
	try {
		const host = new URL(`http://[${address}]/`).hostname.slice(1, -1);
		return prefix === undefined ? host : `${host}/${prefix}`;
	} catch {
		return value;
	}
};

/** "443", "80,443", "8000-9000": every port and range between 1 and 65535. */
export const parsePorts = (value: string): [number, number][] | null => {
	const ranges: [number, number][] = [];
	for (const part of value.split(",")) {
		const match = part.trim().match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
		if (!match) return null;
		const from = Number(match[1]);
		const to = Number(match[2] ?? match[1]);
		if (from < 1 || to > 65_535 || from > to) return null;
		ranges.push([from, to]);
	}
	return ranges.length ? ranges : null;
};

export const firewallPeerSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("object"), object: z.enum(FIREWALL_OBJECTS) }),
	z.object({
		type: z.literal("addresses"),
		addresses: z
			.array(
				z
					.string()
					.trim()
					.refine(isAddress, "Use an address or a network such as 10.0.0.0/8"),
			)
			.min(1, "Add at least one address")
			.max(64),
	}),
]);

export const firewallRuleSchema = z
	.object({
		id: z.string().min(1).max(32),
		direction: z.enum(["inbound", "outbound"]),
		action: z.enum(["allow", "deny"]),
		protocol: z.enum(["any", "tcp", "udp", "icmp"]),
		/** "443", "80,443", "8000-9000"; null for every port. */
		ports: z.string().trim().max(200).nullable(),
		/** Where the traffic goes (outbound) or comes from (inbound). */
		peer: firewallPeerSchema,
		description: z.string().trim().max(200).nullable(),
	})
	.superRefine((rule, ctx) => {
		if (rule.ports === null || rule.ports === "") return;
		if (rule.protocol === "icmp") {
			ctx.addIssue({
				code: "custom",
				path: ["ports"],
				message: "ICMP has no ports",
			});
		} else if (!parsePorts(rule.ports)) {
			ctx.addIssue({
				code: "custom",
				path: ["ports"],
				message: "Ports between 1 and 65535, such as 443, 80,443 or 8000-9000",
			});
		} else if ((parsePorts(rule.ports)?.length ?? 0) > 15) {
			ctx.addIssue({
				code: "custom",
				path: ["ports"],
				message: "15 ports or ranges at most: add another rule",
			});
		}
	});

export const firewallPolicySchema = z.enum(["allow", "deny"]);

export const firewallRulesSchema = z.array(firewallRuleSchema).max(100);

export type FirewallPeer = z.infer<typeof firewallPeerSchema>;
export type FirewallRule = z.infer<typeof firewallRuleSchema>;
export type FirewallPolicy = z.infer<typeof firewallPolicySchema>;

/** Ready-made firewalls the UI offers. */
export const FIREWALL_TEMPLATES: {
	id: string;
	name: string;
	description: string;
	inboundPolicy: FirewallPolicy;
	outboundPolicy: FirewallPolicy;
	rules: Omit<FirewallRule, "id">[];
}[] = [
	{
		id: "internet-only",
		name: "Internet only",
		description:
			"Outbound traffic reaches the public Internet and nothing else: no LAN, no tailnet, no Dokploy server behind a private address. DNS still reaches any resolver, so names resolve.",
		inboundPolicy: "deny",
		outboundPolicy: "deny",
		rules: [
			{
				direction: "outbound",
				action: "allow",
				protocol: "any",
				ports: null,
				peer: { type: "object", object: "internet" },
				description: "The public Internet",
			},
		],
	},
	{
		id: "web-only",
		name: "Web only",
		description:
			"Only HTTPS, HTTP and SSH (git) to the public Internet: package registries, GitHub and container registries keep working.",
		inboundPolicy: "deny",
		outboundPolicy: "deny",
		rules: [
			{
				direction: "outbound",
				action: "allow",
				protocol: "tcp",
				ports: "22,80,443",
				peer: { type: "object", object: "internet" },
				description: "SSH, HTTP and HTTPS",
			},
			{
				direction: "outbound",
				action: "allow",
				protocol: "udp",
				ports: "443",
				peer: { type: "object", object: "internet" },
				description: "HTTP/3",
			},
		],
	},
	{
		id: "block-private",
		name: "Block private networks",
		description:
			"Everything is allowed except the LAN, the VPNs and the tailnet.",
		inboundPolicy: "deny",
		outboundPolicy: "allow",
		rules: [
			{
				direction: "outbound",
				action: "deny",
				protocol: "any",
				ports: null,
				peer: { type: "object", object: "private" },
				description: "LAN, VPNs and tailnet",
			},
		],
	},
];
