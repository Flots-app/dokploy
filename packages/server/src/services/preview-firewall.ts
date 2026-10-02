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
	sshAdmins: z.array(ip),
	blockedAddresses: z.array(ip).default([]),
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

export async function readPreviewFirewall(serverId: string) {
	const worker = await findServerById(serverId);
	try {
		const file = await execAsyncRemote(serverId, `cat ${workerPolicyPath}`);
		const policy = policySchema.parse(JSON.parse(file.stdout));
		const host = stateSchema.parse(
			JSON.parse(
				(
					await execAsyncRemote(
						serverId,
						"cat /etc/dokploy/worker-host-status.json",
					)
				).stdout,
			),
		);
		const engine = stateSchema.parse(
			JSON.parse(
				(
					await execAsyncRemote(
						serverId,
						"cat /etc/dokploy/worker-engine-status.json",
					)
				).stdout,
			),
		);
		const managerFile = await runPreviewManager(
			worker.swarmManagerId,
			`cat ${managerDirectory}/firewall.json`,
		);
		const managerPolicy = policySchema.parse(JSON.parse(managerFile.stdout));
		const managerState = stateSchema.parse(
			JSON.parse(
				(
					await runPreviewManager(
						worker.swarmManagerId,
						`cat ${managerDirectory}/manager-status.json`,
					)
				).stdout,
			),
		);
		return {
			configured: true,
			healthy:
				fresh(host, file.stdout) &&
				fresh(engine, file.stdout) &&
				fresh(managerState, managerFile.stdout) &&
				managerPolicy.peers.includes(worker.ipAddress) &&
				policy.peers.includes(managerPolicy.address),
			policy,
			host,
			engine,
			manager: managerState,
		};
	} catch {
		return {
			configured: false,
			healthy: false,
			policy: null,
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
	const workers = await db.query.server.findMany({
		where: eq(server.organizationId, worker.organizationId),
	});
	const peers = workers
		.filter(
			(item) =>
				item.swarmNodeId && item.swarmManagerId === worker.swarmManagerId,
		)
		.map((item) => ip.parse(item.ipAddress));
	const policy = policySchema.parse({
		address: worker.ipAddress,
		peers: [address],
		sshAdmins: input.sshAdmins,
		blockedAddresses: input.blockedAddresses,
		controlPlaneMappings:
			advertisedIp && isIPv4(advertisedIp) && advertisedIp !== address
				? [{ advertised: advertisedIp, reachable: address }]
				: [],
	});
	let existingPeers: string[] = [];
	try {
		existingPeers = policySchema.parse(
			JSON.parse(
				(
					await runPreviewManager(
						worker.swarmManagerId,
						`cat ${managerDirectory}/firewall.json`,
					)
				).stdout,
			),
		).peers;
	} catch {
		/* First setup. */
	}
	const managerPolicy = {
		address,
		peers: [...new Set([...existingPeers, ...peers, worker.ipAddress])],
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
