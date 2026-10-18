import dns from "node:dns/promises";
import { BlockList, isIP, isIPv4, isIPv6 } from "node:net";
import type { HostExecutor } from "./host";

const blockList = (ipv4: string[], ipv6: string[]) => {
	const list = new BlockList();
	for (const range of ipv4) {
		const [network, prefix] = range.split("/");
		list.addSubnet(network as string, Number(prefix), "ipv4");
	}
	for (const range of ipv6) {
		const [network, prefix] = range.split("/");
		list.addSubnet(network as string, Number(prefix), "ipv6");
	}
	return list;
};

/** Addresses public DNS records cannot point to: private, CGNAT (Tailscale), loopback, link-local. */
const nonPublicRanges = blockList(
	[
		"0.0.0.0/8",
		"10.0.0.0/8",
		"100.64.0.0/10",
		"127.0.0.0/8",
		"169.254.0.0/16",
		"172.16.0.0/12",
		"192.168.0.0/16",
	],
	["::1/128", "fc00::/7", "fe80::/10"],
);

/** https://www.cloudflare.com/ips/ */
const cloudflareRanges = blockList(
	[
		"173.245.48.0/20",
		"103.21.244.0/22",
		"103.22.200.0/22",
		"103.31.4.0/22",
		"141.101.64.0/18",
		"108.162.192.0/18",
		"190.93.240.0/20",
		"188.114.96.0/20",
		"197.234.240.0/22",
		"198.41.128.0/17",
		"162.158.0.0/15",
		"104.16.0.0/13",
		"104.24.0.0/14",
		"172.64.0.0/13",
		"131.0.72.0/22",
	],
	[
		"2400:cb00::/32",
		"2606:4700::/32",
		"2803:f800::/32",
		"2405:b500::/32",
		"2405:8100::/32",
		"2a06:98c0::/29",
		"2c0f:f248::/32",
	],
);

const family = (address: string) => (isIPv6(address) ? "ipv6" : "ipv4");

export const isPublicAddress = (address: string) =>
	isIP(address) !== 0 && !nonPublicRanges.check(address, family(address));

export const isCloudflareAddress = (address: string) =>
	isIP(address) !== 0 && cloudflareRanges.check(address, family(address));

export interface PublicAddresses {
	ipv4: string | null;
	ipv6: string | null;
}

const probePublicAddress = async (target: HostExecutor, version: 4 | 6) => {
	// Same lookup services as the Dokploy server setup.
	const result = await target.run(
		["https://ifconfig.io", "https://icanhazip.com"]
			.map(
				(url) =>
					`curl -${version}fsS --connect-timeout 3 --max-time 5 ${url} 2>/dev/null`,
			)
			.join(" || "),
		{ allowFailure: true },
	);
	const address = result.stdout.trim();
	const valid = version === 4 ? isIPv4(address) : isIPv6(address);
	return valid && isPublicAddress(address) ? address : null;
};

/** Public addresses the target is reached at, as seen from the internet. */
export const probePublicAddresses = async (
	target: HostExecutor,
): Promise<PublicAddresses> => {
	const [ipv4, ipv6] = await Promise.all([
		probePublicAddress(target, 4),
		probePublicAddress(target, 6),
	]);
	return { ipv4, ipv6 };
};

export interface DomainRecords {
	host: string;
	/** null when the lookup failed. */
	ipv4: string[] | null;
	ipv6: string[] | null;
}

const lookup = async (resolve: () => Promise<string[]>) => {
	try {
		return await resolve();
	} catch {
		return null;
	}
};

export const resolveDomainRecords = async (
	host: string,
): Promise<DomainRecords> => {
	const [ipv4, ipv6] = await Promise.all([
		lookup(() => dns.resolve4(host)),
		lookup(() => dns.resolve6(host)),
	]);
	return { host, ipv4, ipv6 };
};

export interface DnsTarget {
	name: string;
	/** Address the server is registered with in Dokploy (often a private or VPN address). */
	registeredAddress: string | null;
	publicAddresses: PublicAddresses;
}

const list = (hosts: string[]) => hosts.join(", ");

/** Builds the "Domain DNS" check from the current records of the domains. */
export const describeDomainDns = (
	records: DomainRecords[],
	target: DnsTarget,
): { status: "pass" | "warn"; message: string } => {
	const registered =
		target.registeredAddress && isIP(target.registeredAddress)
			? target.registeredAddress
			: null;
	const publicRegistered =
		registered && isPublicAddress(registered) ? registered : null;
	const ipv4 =
		target.publicAddresses.ipv4 ??
		(publicRegistered && isIPv4(publicRegistered) ? publicRegistered : null);
	const ipv6 =
		target.publicAddresses.ipv6 ??
		(publicRegistered && isIPv6(publicRegistered) ? publicRegistered : null);
	const targetAddresses = new Set(
		[ipv4, ipv6, registered].filter((address): address is string =>
			Boolean(address),
		),
	);
	const unknownAddress =
		registered && !publicRegistered
			? `the public IP of ${target.name} (it is registered with ${registered}, which public DNS cannot use)`
			: `the public IP of ${target.name}`;
	const stale = (addresses: string[] | null) =>
		(addresses ?? []).some((address) => !targetAddresses.has(address));

	const unresolved: string[] = [];
	const proxied: string[] = [];
	const staleIpv4: string[] = [];
	const staleIpv6: string[] = [];
	const resolved = new Set<string>();
	for (const record of records) {
		const addresses = [...(record.ipv4 ?? []), ...(record.ipv6 ?? [])];
		for (const address of addresses) resolved.add(address);
		if (addresses.length === 0) {
			unresolved.push(record.host);
		} else if (addresses.every(isCloudflareAddress)) {
			proxied.push(record.host);
		} else {
			if (stale(record.ipv4)) staleIpv4.push(record.host);
			if (stale(record.ipv6)) staleIpv6.push(record.host);
		}
	}

	const notes: string[] = [];
	if (staleIpv4.length) {
		notes.push(
			`Point ${list(staleIpv4)} to ${ipv4 ?? unknownAddress} once migrated (the source stops serving them).`,
		);
	}
	if (staleIpv6.length) {
		notes.push(
			ipv6
				? `Set the AAAA records of ${list(staleIpv6)} to ${ipv6} once migrated.`
				: `Remove or update the AAAA records of ${list(staleIpv6)}: no public IPv6 address was found on ${target.name}.`,
		);
	}
	if (proxied.length) {
		notes.push(
			`${list(proxied)} ${proxied.length > 1 ? "are" : "is"} proxied by Cloudflare: once migrated, point the origin in Cloudflare (DNS record or tunnel) to ${ipv4 ?? ipv6 ?? unknownAddress}.`,
		);
	}
	if (unresolved.length) notes.push(`Unresolved: ${list(unresolved)}.`);
	return notes.length
		? { status: "warn", message: notes.join(" ") }
		: {
				status: "pass",
				message: `Every domain already resolves to ${target.name} (${[...resolved].join(", ")}).`,
			};
};
