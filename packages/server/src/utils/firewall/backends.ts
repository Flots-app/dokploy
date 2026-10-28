/**
 * Rulesets of a compiled firewall for the machines that enforce it: nftables
 * on Linux, pf on macOS. Both filter the outbound traffic of one sandbox (the
 * jobs of a GitHub runner machine) and leave the rest of the machine alone.
 * Loopback and DNS always pass: name resolution goes through the resolvers
 * of the machine, which often sit on a private network.
 */
import {
	type AddressSet,
	type CompiledFirewall,
	type CompiledRule,
	rulesetHash,
} from "./model";

export interface Ruleset {
	text: string;
	/** What the machine reports once the ruleset is loaded. */
	hash: string;
	/** What the backend cannot enforce, for the operator. */
	notes: string[];
}

const isAnywhere = (rule: CompiledRule) =>
	!rule.negate &&
	rule.addresses.v4.length === 1 &&
	rule.addresses.v4[0] === "0.0.0.0/0" &&
	rule.addresses.v6.length === 1 &&
	rule.addresses.v6[0] === "::/0";

const inboundNote = (compiled: CompiledFirewall, why: string) =>
	compiled.inbound.rules.length || compiled.inbound.policy === "deny"
		? [`Inbound rules do not apply here: ${why}.`]
		: [];

const skippedNotes = (compiled: CompiledFirewall) =>
	compiled.skipped.map((item) => `A rule is left out: ${item.reason}.`);

/** Table Dokploy owns on Linux machines; nothing else is touched. */
export const NFT_TABLE = "dokploy_firewall";
/** Replaced by the uid of the job account when the ruleset is loaded. */
export const NFT_UID_PLACEHOLDER = "@JOB_UID@";

/**
 * nftables, for a Linux runner machine: what the job account sends, and the
 * connections the machine forwards, which are the Docker containers' (all
 * started by jobs: the machine is dedicated to them), whatever the name of
 * their network's bridge. Loaded in one transaction: the table is replaced
 * whole or not at all.
 */
export const nftablesRuleset = (compiled: CompiledFirewall): Ruleset => {
	const sets = new Map<string, { name: string; text: string }>();
	const setOf = (family: "v4" | "v6", addresses: string[]) => {
		const key = `${family}:${addresses.join(",")}`;
		let set = sets.get(key);
		if (!set) {
			const name = `${family}_${sets.size + 1}`;
			set = {
				name,
				text: `\tset ${name} {\n\t\ttype ${family === "v4" ? "ipv4_addr" : "ipv6_addr"}\n\t\tflags interval\n\t\tauto-merge\n\t\telements = { ${addresses.join(", ")} }\n\t}`,
			};
			sets.set(key, set);
		}
		return set.name;
	};
	const ports = (rule: CompiledRule) =>
		rule.ports
			? `{ ${rule.ports.map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`)).join(", ")} }`
			: null;
	const protocol = (rule: CompiledRule) => {
		const list = ports(rule);
		switch (rule.protocol) {
			case "tcp":
				return list ? `meta l4proto tcp tcp dport ${list}` : "meta l4proto tcp";
			case "udp":
				return list ? `meta l4proto udp udp dport ${list}` : "meta l4proto udp";
			case "icmp":
				return "meta l4proto { icmp, ipv6-icmp }";
			default:
				return list ? `meta l4proto { tcp, udp } th dport ${list}` : "";
		}
	};
	const lines = (rule: CompiledRule) => {
		const match = protocol(rule);
		const verdict = rule.action === "allow" ? "accept" : "reject";
		const join = (...parts: string[]) => parts.filter(Boolean).join(" ");
		if (isAnywhere(rule)) return [join(match, verdict)];
		const negate = rule.negate ? "!= " : "";
		const families: [keyof AddressSet, string][] = [
			["v4", "ip daddr"],
			["v6", "ip6 daddr"],
		];
		return families.flatMap(([family, selector]) =>
			rule.addresses[family].length
				? [
						join(
							`${selector} ${negate}@${setOf(family, rule.addresses[family])}`,
							match,
							verdict,
						),
					]
				: [],
		);
	};
	const jobs = [
		// Replies of the connections the jobs accept. Every packet the jobs send
		// otherwise meets the current rules, even on a connection opened under
		// older, looser ones: a stricter firewall cuts it.
		"ct direction reply accept",
		'oifname "lo" accept',
		"meta l4proto { tcp, udp } th dport 53 accept",
		...compiled.outbound.rules.flatMap(lines),
		compiled.outbound.policy === "deny" ? "reject" : "accept",
	];
	const text = `# Dokploy firewall "${compiled.name.replace(/[^\w .-]/g, "")}": jobs of this machine
table inet ${NFT_TABLE}
delete table inet ${NFT_TABLE}
table inet ${NFT_TABLE} {
${[...sets.values()].map((set) => `${set.text}\n`).join("")}	chain jobs {
${jobs.map((line) => `\t\t${line}`).join("\n")}
	}
	chain output {
		type filter hook output priority 0; policy accept;
		meta skuid ${NFT_UID_PLACEHOLDER} jump jobs
	}
	chain forward {
		type filter hook forward priority 0; policy accept;
		ct direction original jump jobs
	}
}
`;
	return {
		text,
		hash: rulesetHash(text),
		notes: [
			...skippedNotes(compiled),
			...inboundNote(compiled, "jobs take no connection from the network"),
			"A job that starts a privileged container, or one on the host network, can go around it: the docker group is root on the machine. Jobs in a VM (as on the Macs) cannot.",
		],
	};
};

/**
 * Mac loopback ports where Lima forwards the runner VM's sshd: Dokploy puts the
 * VM's SSH port in this range (limactl --ssh-port). The VM reaches the Mac's
 * loopback through 192.168.5.2, and pf leaves only this range open there.
 */
export const LIMA_SSH_PORTS = { first: 60022, last: 60031 } as const;

/**
 * pf, for a Mac: the VM of the jobs reaches the network through Lima, whose
 * processes run as the account Dokploy logs in with. The root helper the
 * setup script installs loads these rules in an anchor of its own and binds
 * every rule to that account: what the VM sends, nothing else of the Mac.
 * pf matches the account of TCP and UDP traffic only: ICMP is not filtered.
 */
export const pfRuleset = (compiled: CompiledFirewall): Ruleset => {
	const tables = new Map<string, string>();
	const tableOf = (addresses: AddressSet) => {
		const list = [...addresses.v4, ...addresses.v6];
		const key = list.join(",");
		let name = tables.get(key);
		if (!name) {
			name = `dk${tables.size + 1}`;
			tables.set(key, name);
		}
		return { name, list };
	};
	const notes = [
		...skippedNotes(compiled),
		...inboundNote(compiled, "the VM takes no connection from the network"),
	];
	const rules: string[] = [
		`pass out quick on lo0 proto tcp from any to any port ${LIMA_SSH_PORTS.first}:${LIMA_SSH_PORTS.last}`,
		"pass out quick proto { tcp udp } from any to any port 53",
		// Services listening on the Mac's loopback stay out of the jobs' reach.
		"block return out quick on lo0 proto { tcp udp } from any to any",
	];
	notes.push(
		`On a Mac, the VM reaches the Mac's own loopback (127.0.0.1) only on ports ${LIMA_SSH_PORTS.first}-${LIMA_SSH_PORTS.last}, where Lima forwards its SSH.`,
	);
	for (const rule of compiled.outbound.rules) {
		if (rule.protocol === "icmp") continue;
		// Without state, every packet meets the current rules: a stricter
		// firewall cuts the connections already open instead of letting them
		// run until they close. Replies come in, which these rules never match.
		const action =
			rule.action === "allow" ? "pass out quick" : "block return out quick";
		const state = rule.action === "allow" ? " no state" : "";
		const protocol = rule.protocol === "any" ? "{ tcp udp }" : rule.protocol;
		const to = isAnywhere(rule)
			? "any"
			: `${rule.negate ? "! " : ""}<${tableOf(rule.addresses).name}>`;
		const range = ([from, until]: [number, number]) =>
			from === until ? `${from}` : `${from}:${until}`;
		const port = !rule.ports
			? ""
			: rule.ports.length === 1 && rule.ports[0]
				? ` port ${range(rule.ports[0])}`
				: ` port { ${rule.ports.map(range).join(" ")} }`;
		rules.push(`${action} proto ${protocol} from any to ${to}${port}${state}`);
	}
	// An allow policy adds no rule: what nothing matched passes without state,
	// and the anchors after this one still apply.
	if (compiled.outbound.policy === "deny") {
		rules.push("block return out quick proto { tcp udp } from any to any");
	}
	// The deny of last resort is TCP and UDP too: whatever the rules, ping
	// and other ICMP traffic of the VM pass.
	notes.push(
		"On a Mac, pf filters TCP and UDP only: ICMP (ping) is not filtered, and ICMP rules do not apply.",
	);
	const body = [
		...[...tables.entries()].map(
			([key, name]) => `table <${name}> const { ${key.split(",").join(", ")} }`,
		),
		...rules,
	].join("\n");
	const hash = rulesetHash(body);
	return { text: `# dokploy-firewall ${hash}\n${body}\n`, hash, notes };
};
