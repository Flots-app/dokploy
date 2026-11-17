import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
import { db } from "@dokploy/server/db";
import { server } from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";
import { quote } from "shell-quote";
import { z } from "zod";
import { execAsyncRemote } from "../utils/process/execAsync";
import { getRemoteDocker } from "../utils/servers/remote-docker";
import { runPreviewManager } from "./compose-preview-stack";
import { findServerById } from "./server";

const ip = z.string().refine(isIPv4, "Use a valid IPv4 address");
export const previewFirewallInput = z.object({
	serverId: z.string().min(1),
	sshAdmins: z.array(ip).max(30),
	blockedAddresses: z.array(ip).max(100),
});
const policySchema = z.object({
	address: ip,
	peers: z.array(ip),
	/** The worker's DNS resolvers: reachable on port 53 only, even when private. */
	dnsResolvers: z.array(ip).default([]),
	/** Every Swarm node: allowed on gossip (7946) and VXLAN (4789) only. */
	swarmPeers: z.array(ip).default([]),
	sshAdmins: z.array(ip),
	blockedAddresses: z.array(ip).default([]),
	/** What the operator typed; `blockedAddresses` adds known servers. */
	operatorBlockedAddresses: z.array(ip).optional(),
	controlPlaneMappings: z
		.array(z.object({ advertised: ip, reachable: ip }))
		.default([]),
});
const stateSchema = z.object({
	role: z.string(),
	appliedAt: z.string().datetime(),
	policySha256: z.string(),
});
const workerPolicyPath = "/etc/dokploy/firewall.json";
const managerDirectory = "/etc/dokploy/preview-firewall";

function fresh(state: z.infer<typeof stateSchema> | null, contents: string) {
	return (
		!!state &&
		state.policySha256 ===
			createHash("sha256").update(contents).digest("hex") &&
		Math.abs(Date.now() - Date.parse(state.appliedAt)) < 45000
	);
}

type AgentState = z.infer<typeof stateSchema>;

/** Health of one firewall agent, as shown to operators. */
function agentHealth(state: AgentState | null, contents: string) {
	if (!state) return { healthy: false, appliedAt: null, reason: "missing" };
	if (
		state.policySha256 !== createHash("sha256").update(contents).digest("hex")
	)
		return {
			healthy: false,
			appliedAt: state.appliedAt,
			reason: "has not applied the latest policy yet",
		};
	if (!fresh(state, contents))
		return {
			healthy: false,
			appliedAt: state.appliedAt,
			reason: "stopped reporting (no heartbeat in the last 45 seconds)",
		};
	return { healthy: true, appliedAt: state.appliedAt, reason: null };
}

/**
 * Read the policy and agent heartbeats. Never throws: deployments use
 * `healthy`, and the UI shows `reason` plus each agent's state so operators
 * can tell "not installed" from "SSH unreachable" from "agent stopped".
 */
export async function readPreviewFirewall(serverId: string) {
	let stage = "worker server";
	try {
		const worker = await findServerById(serverId);
		stage = "worker policy (/etc/dokploy/firewall.json)";
		const file = await execAsyncRemote(serverId, `cat ${workerPolicyPath}`);
		const policy = policySchema.parse(JSON.parse(file.stdout));
		const readState = async (run: () => Promise<{ stdout: string }>) => {
			try {
				return stateSchema.parse(JSON.parse((await run()).stdout));
			} catch {
				return null;
			}
		};
		stage = "manager policy";
		const managerFile = await runPreviewManager(
			worker.swarmManagerId,
			`cat ${managerDirectory}/firewall.json`,
		);
		const managerPolicy = policySchema.parse(JSON.parse(managerFile.stdout));
		const [host, engine, manager] = await Promise.all([
			readState(() =>
				execAsyncRemote(serverId, "cat /etc/dokploy/worker-host-status.json"),
			),
			readState(() =>
				execAsyncRemote(serverId, "cat /etc/dokploy/worker-engine-status.json"),
			),
			readState(() =>
				runPreviewManager(
					worker.swarmManagerId,
					`cat ${managerDirectory}/manager-status.json`,
				),
			),
		]);
		const agents = {
			host: agentHealth(host, file.stdout),
			engine: agentHealth(engine, file.stdout),
			manager: agentHealth(manager, managerFile.stdout),
		};
		const problems = Object.entries(agents)
			.filter(([, agent]) => !agent.healthy)
			.map(([name, agent]) => `${name} agent ${agent.reason}`);
		if (!managerPolicy.peers.includes(worker.ipAddress))
			problems.push("the manager policy does not list this worker yet");
		if (!policy.peers.includes(managerPolicy.address))
			problems.push("the worker policy does not list the manager address");
		return {
			configured: true,
			healthy: problems.length === 0,
			reason: problems.length ? problems.join("; ") : null,
			policy,
			agents,
			host,
			engine,
			manager,
		};
	} catch {
		return {
			configured: false,
			healthy: false,
			reason: `Unable to read the ${stage}. Apply the policy below, then install the agents from ops/compose-preview.`,
			policy: null,
			agents: null,
			host: null,
			engine: null,
			manager: null,
		};
	}
}

/** Apply only this worker's policy and merge the manager peer allowlist. Agents
 * retain their last applied rules if a malformed policy is ever encountered. */
export async function updatePreviewFirewall(
	input: z.infer<typeof previewFirewallInput>,
) {
	const worker = await findServerById(input.serverId);
	if (!worker.swarmNodeId) throw new Error("Configure the Swarm worker first");
	if (worker.swarmManagerId) {
		const managerServer = await findServerById(worker.swarmManagerId);
		if (
			managerServer.organizationId !== worker.organizationId ||
			!managerServer.sshKeyId
		)
			throw new Error("Preview manager configuration is invalid");
	}
	const manager = await getRemoteDocker(worker.swarmManagerId);
	const info = await manager.info();
	const address = ip.parse(info.Swarm?.NodeAddr);
	const advertised = info.Swarm?.RemoteManagers?.find(
		(item: { NodeID: string; Addr: string }) =>
			item.NodeID === info.Swarm?.NodeID,
	)?.Addr;
	const advertisedIp = advertised?.endsWith(":2377")
		? advertised.slice(0, -5)
		: undefined;
	// Every node of the cluster must stay reachable on the Swarm ports, not only
	// preview workers: dropping a regular node's VXLAN or a second manager's
	// Raft traffic breaks ingress (the 2026-09-12 incident). Recomputed from
	// the live cluster on every save, so removed nodes lose access.
	const [servers, nodes] = await Promise.all([
		db.query.server.findMany({
			where: eq(server.organizationId, worker.organizationId),
		}),
		manager.listNodes(),
	]);
	const peers = new Set<string>([worker.ipAddress]);
	for (const node of nodes) {
		const candidates = [
			node.Status?.Addr,
			node.ManagerStatus?.Addr?.replace(/:\d+$/, ""),
		].filter(
			(value): value is string =>
				!!value && isIPv4(value) && value !== "0.0.0.0",
		);
		if (!candidates.length)
			throw new Error(
				`Unable to determine the address of Swarm node ${node.Description?.Hostname || node.ID}; refusing to apply a manager firewall that could cut it off`,
			);
		for (const candidate of candidates) peers.add(candidate);
	}
	for (const item of servers)
		if (item.swarmNodeId && item.swarmManagerId === worker.swarmManagerId)
			peers.add(ip.parse(item.ipAddress));
	peers.delete(address);
	// Workloads must not reach any server Dokploy manages (public addresses
	// are not covered by the private-range rules of the engine agent).
	const automaticallyBlocked = servers
		.map((item) => item.ipAddress)
		.filter((value) => isIPv4(value) && value !== worker.ipAddress);
	// Builds and default-bridge containers use the engine's resolvers, which
	// are often private (cloud VPC resolver, systemd-resolved upstream). Allow
	// DNS to them, and only DNS: the private ranges stay blocked otherwise.
	const resolvConf = await execAsyncRemote(
		input.serverId,
		"cat /run/systemd/resolve/resolv.conf 2>/dev/null || cat /etc/resolv.conf",
	).catch(() => ({ stdout: "" }));
	const dnsResolvers = [
		...new Set(
			resolvConf.stdout
				.split("\n")
				.map((line) => line.match(/^\s*nameserver\s+(\S+)/)?.[1])
				.filter(
					(value): value is string =>
						!!value && isIPv4(value) && !value.startsWith("127."),
				),
		),
	];
	const policy = policySchema.parse({
		address: worker.ipAddress,
		dnsResolvers,
		peers: [address],
		swarmPeers: [...new Set([address, ...peers])].filter(
			(entry) => entry !== worker.ipAddress,
		),
		sshAdmins: input.sshAdmins,
		operatorBlockedAddresses: input.blockedAddresses,
		blockedAddresses: [
			...new Set([...input.blockedAddresses, ...automaticallyBlocked, address]),
		],
		controlPlaneMappings:
			advertisedIp && isIPv4(advertisedIp) && advertisedIp !== address
				? [{ advertised: advertisedIp, reachable: address }]
				: [],
	});
	const managerPolicy = {
		address,
		peers: [...peers],
		sshAdmins: [],
		blockedAddresses: [],
	};
	const write = (file: string, value: unknown) =>
		`umask 077; printf %s ${quote([Buffer.from(`${JSON.stringify(value)}\n`).toString("base64")])} | base64 -d > ${quote([`${file}.tmp`])}; mv ${quote([`${file}.tmp`, file])}`;
	await runPreviewManager(
		worker.swarmManagerId,
		`mkdir -p ${managerDirectory}; ${write(`${managerDirectory}/firewall.json`, managerPolicy)}`,
	);
	await execAsyncRemote(input.serverId, write(workerPolicyPath, policy));
	return true;
}
