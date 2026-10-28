import { db } from "@dokploy/server/db";
import {
	firewallAttachments,
	githubRunnerNodes,
	githubRunnerPools,
} from "@dokploy/server/db/schema";
import {
	completeGithubRunnerEnrollment,
	finishGithubRunnerEnrollment,
	startGithubRunnerEnrollment,
} from "@dokploy/server/services/github-runner";
import { publicKeyFingerprint } from "@dokploy/server/utils/github-runners/setup";
import { SETUP_CODE_PREFIX } from "@dokploy/server/utils/github-runners/setup-constants";
import { eq, sql } from "drizzle-orm";
import { Server, utils } from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { firewallRouter } from "@/server/api/routers/firewall";
import { githubRunnerRouter } from "@/server/api/routers/github-runner";
import {
	addMember,
	contextOf,
	createOrganization,
	insertNode,
	insertPool,
	type Person,
	removeCreatedRows,
} from "./fixtures";

type Context = Parameters<typeof githubRunnerRouter.createCaller>[0];
const runners = (person: Person, organizationId?: string) =>
	githubRunnerRouter.createCaller(
		contextOf(person, organizationId) as unknown as Context,
	);
const firewallsOf = (person: Person) =>
	firewallRouter.createCaller(contextOf(person) as unknown as Context);

/** What a Linux machine answers to the facts script: every check passes. */
const LINUX_FACTS = `${[
	"os kernel=Linux arch=x86_64",
	"distro id=ubuntu version=24.04",
	"host cpus=8 memory_kib=16000000",
	"user root=yes sudo=yes",
	"systemd present=yes",
	"cgroup fs=cgroup2fs",
	"apt present=yes",
	`disk total_kib=${400 * 1024 * 1024} free_kib=${200 * 1024 * 1024}`,
	"docker present=no",
	"network github=200",
	"runtime version=0",
].join("\n")}\n`;

let a: Person;
let b: Person;
let memberA: Person;
let adminA: Person;

beforeAll(async () => {
	a = await createOrganization("api-a");
	b = await createOrganization("api-b");
	memberA = await addMember(a.organizationId, "member");
	adminA = await addMember(a.organizationId, "admin");
});

afterAll(removeCreatedRows);

describe("enrollment with the setup script", () => {
	const hostKey = utils.generateKeyPairSync("ed25519");
	const hostFingerprint = publicKeyFingerprint(hostKey.public);
	let server: Server;
	let port = 0;
	/** The machine key the server accepts, as the script installs it. */
	let machineKey: Buffer | null = null;
	/** Accounts that completed a login (publickey asks twice: query, then signature). */
	const logins: string[] = [];

	beforeAll(async () => {
		server = new Server({ hostKeys: [hostKey.private] }, (client) => {
			let username = "";
			client
				.on("authentication", (context) => {
					if (
						context.method === "publickey" &&
						machineKey &&
						context.key.data.equals(machineKey)
					) {
						username = context.username;
						context.accept();
						return;
					}
					context.reject(["publickey"]);
				})
				.on("ready", () => {
					logins.push(username);
					client.on("session", (accept) => {
						accept().on("exec", (acceptExec) => {
							const channel = acceptExec();
							let script = "";
							channel.on("data", (data: Buffer) => {
								script += data.toString();
							});
							channel.on("end", () => {
								channel.write(
									script.trim() === "uname -s" ? "Linux\n" : LINUX_FACTS,
								);
								channel.exit(0);
								channel.end();
							});
						});
					});
				})
				.on("error", () => {});
		});
		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => {
				port = (server.address() as { port: number }).port;
				resolve();
			});
		});
	});

	afterAll(() => server.close());

	const codeFor = (values: Record<string, unknown>) =>
		`${SETUP_CODE_PREFIX}${Buffer.from(JSON.stringify(values)).toString("base64")}`;

	it("enrolls a machine: own key, code checked, host key pinned, then the budget", async () => {
		const pool = await insertPool(a.organizationId, "enroll");
		const started = await startGithubRunnerEnrollment(
			{
				githubRunnerPoolId: pool.githubRunnerPoolId,
				name: "m6",
				description: null,
				platform: "linux",
				vmName: "dokploy-runners",
				keepAwake: true,
			},
			a.organizationId,
		);
		expect(started.node).toMatchObject({ phase: "enrolling", host: "" });
		expect(JSON.stringify(started)).not.toMatch(/PRIVATE KEY|enc:v1:/);
		const [stored] = await db
			.select()
			.from(githubRunnerNodes)
			.where(
				eq(
					githubRunnerNodes.githubRunnerNodeId,
					started.node.githubRunnerNodeId,
				),
			);
		if (!stored?.sshPublicKey) throw new Error("no machine key");
		expect(started.script).toContain(stored.sshPublicKey);
		// Encrypted at rest: the column itself never holds the key.
		const [raw] = await db.execute<{ key: string }>(sql`
			select "sshPrivateKey" as key from github_runner_node
			where "githubRunnerNodeId" = ${started.node.githubRunnerNodeId}`);
		expect(raw?.key).toMatch(/^enc:v1:/);
		expect(raw?.key).not.toContain("PRIVATE KEY");

		machineKey = Buffer.from(stored.sshPublicKey.split(" ")[1] ?? "", "base64");
		const valid = {
			v: 1,
			machine: "m6",
			platform: "linux",
			user: "dokploy-manager",
			port: 22,
			key: publicKeyFingerprint(stored.sshPublicKey),
			hostKeys: [hostFingerprint],
			hosts: ["127.0.0.1"],
			os: "Ubuntu 24.04",
			arch: "x86_64",
			fileVault: "off",
			keepAwake: false,
		};
		const complete = (values: Record<string, unknown>) =>
			completeGithubRunnerEnrollment(
				{
					githubRunnerNodeId: started.node.githubRunnerNodeId,
					code: codeFor(values),
					host: "127.0.0.1",
					port,
				},
				a.organizationId,
			);

		// Codes that are not this machine's are refused before any login.
		for (const [change, message] of [
			[{ machine: "m4" }, /setup script of m4, not m6/],
			[{ platform: "macos" }, /from a Mac script/],
			[
				{
					key: publicKeyFingerprint(
						utils.generateKeyPairSync("ed25519").public,
					),
				},
				/older setup script/,
			],
		] as const) {
			await expect(complete({ ...valid, ...change })).rejects.toThrow(message);
		}
		expect(logins).toEqual([]);
		// A host key the code does not list: no login either.
		await expect(
			complete({
				...valid,
				hostKeys: [
					publicKeyFingerprint(utils.generateKeyPairSync("ed25519").public),
				],
			}),
		).rejects.toThrow(/which the setup code of the machine does not list/);
		expect(logins).toEqual([]);
		await expect(
			finishGithubRunnerEnrollment(
				{
					githubRunnerNodeId: started.node.githubRunnerNodeId,
					cpuPercent: 50,
					memoryPercent: 50,
					diskReserveGb: 15,
					diskCleanupPercent: 90,
					maxRunners: 0,
					vmDiskGb: 60,
					extraLabels: [],
				},
				a.organizationId,
			),
		).rejects.toThrow(/Paste the setup code of m6 first/);

		const result = await complete(valid);
		expect(logins).toEqual(["dokploy-manager"]);
		expect(result).toMatchObject({
			fingerprint: hostFingerprint,
			platform: "linux",
			canProvision: true,
		});
		const checked = await db.query.githubRunnerNodes.findFirst({
			where: eq(
				githubRunnerNodes.githubRunnerNodeId,
				started.node.githubRunnerNodeId,
			),
		});
		expect(checked).toMatchObject({
			phase: "enrolling",
			host: "127.0.0.1",
			port,
			username: "dokploy-manager",
			hostKeyFingerprint: hostFingerprint,
			setup: { os: "Ubuntu 24.04", hostKeys: [hostFingerprint] },
		});

		const finished = await finishGithubRunnerEnrollment(
			{
				githubRunnerNodeId: started.node.githubRunnerNodeId,
				cpuPercent: 50,
				memoryPercent: 40,
				diskReserveGb: 10,
				diskCleanupPercent: 85,
				maxRunners: 2,
				vmDiskGb: 60,
				extraLabels: ["gpu"],
			},
			a.organizationId,
		);
		expect(finished).toMatchObject({
			phase: "new",
			cpuPercent: 50,
			memoryPercent: 40,
			diskCleanupPercent: 85,
			maxRunners: 2,
			extraLabels: ["gpu"],
		});
		await expect(complete(valid)).rejects.toThrow(
			/m6 is not waiting for a setup code/,
		);
		// The same name cannot start twice in the organization.
		await expect(
			startGithubRunnerEnrollment(
				{
					githubRunnerPoolId: pool.githubRunnerPoolId,
					name: "m6",
					description: null,
					platform: "linux",
					vmName: "dokploy-runners",
					keepAwake: true,
				},
				a.organizationId,
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});

describe("routers", () => {
	it("lets owners and admins in, keeps members and outsiders out", async () => {
		await insertPool(a.organizationId, "roles");
		await expect(runners(a).overview()).resolves.toBeDefined();
		await expect(runners(adminA).overview()).resolves.toBeDefined();
		await expect(runners(memberA).overview()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		await expect(firewallsOf(memberA).list()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		// A session pointing at an organization the user does not belong to.
		await expect(runners(b, a.organizationId).overview()).rejects.toMatchObject(
			{
				code: "UNAUTHORIZED",
			},
		);
		const pool = await insertPool(a.organizationId, "roles-member");
		await expect(
			runners(memberA).startEnrollment({
				githubRunnerPoolId: pool.githubRunnerPoolId,
				name: "by-member",
				platform: "linux",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(
			await db.query.githubRunnerNodes.findFirst({
				where: eq(githubRunnerNodes.name, "by-member"),
			}),
		).toBeUndefined();
	});

	it("shows each organization its own pools, without secrets", async () => {
		const poolA = await insertPool(a.organizationId, "overview-a");
		await runners(a).startEnrollment({
			githubRunnerPoolId: poolA.githubRunnerPoolId,
			name: "overview",
			platform: "macos",
		});
		const poolB = await insertPool(b.organizationId, "overview-b");
		const seenByA = await runners(a).overview();
		const seenByB = await runners(b).overview();
		const names = (overview: { name: string }[]) =>
			overview.map((pool) => pool.name);
		expect(names(seenByA)).toContain(poolA.name);
		expect(names(seenByA)).not.toContain(poolB.name);
		expect(names(seenByB)).toEqual([poolB.name]);
		expect(JSON.stringify(seenByA)).not.toMatch(/PRIVATE KEY|enc:v1:/);
	});

	it("refuses another organization's pools and machines", async () => {
		const pool = await insertPool(a.organizationId, "cross");
		const node = await insertNode(pool, "cross", { cpuPercent: 30 });
		const outsider = runners(b);
		const notFound = { code: "NOT_FOUND" };

		await expect(
			outsider.setupScript({ githubRunnerNodeId: node.githubRunnerNodeId }),
		).rejects.toMatchObject(notFound);
		await expect(
			outsider.startEnrollment({
				githubRunnerPoolId: pool.githubRunnerPoolId,
				name: "intruder",
				platform: "linux",
			}),
		).rejects.toMatchObject(notFound);
		await expect(
			outsider.updateMachine({
				githubRunnerNodeId: node.githubRunnerNodeId,
				description: "changed",
				cpuPercent: 100,
				memoryPercent: 100,
				diskReserveGb: 0,
				diskCleanupPercent: 99,
				maxRunners: 32,
				vmDiskGb: 60,
				extraLabels: [],
			}),
		).rejects.toMatchObject(notFound);
		await expect(
			outsider.removeMachine({
				githubRunnerNodeId: node.githubRunnerNodeId,
				mode: "kill",
				force: true,
			}),
		).rejects.toMatchObject(notFound);
		await expect(
			outsider.removePool({ githubRunnerPoolId: pool.githubRunnerPoolId }),
		).rejects.toMatchObject(notFound);

		expect(
			await db.query.githubRunnerPools.findFirst({
				where: eq(
					githubRunnerPools.githubRunnerPoolId,
					pool.githubRunnerPoolId,
				),
			}),
		).toBeDefined();
		expect(
			await db.query.githubRunnerNodes.findFirst({
				where: eq(
					githubRunnerNodes.githubRunnerNodeId,
					node.githubRunnerNodeId,
				),
			}),
		).toMatchObject({ cpuPercent: 30, description: null });
		expect(
			await db.query.githubRunnerNodes.findFirst({
				where: eq(githubRunnerNodes.name, "intruder"),
			}),
		).toBeUndefined();
	});

	it("attaches firewalls through the API within the organization only", async () => {
		const poolA = await insertPool(a.organizationId, "fw-api-a");
		const firewallA = await firewallsOf(a).create({
			name: "internet-only",
			outboundPolicy: "deny",
		});
		const firewallB = await firewallsOf(b).create({ name: "internet-only" });
		const target = {
			type: "githubRunnerPool",
			id: poolA.githubRunnerPoolId,
		} as const;
		const attached = () =>
			db.query.firewallAttachments.findMany({
				where: eq(
					firewallAttachments.githubRunnerPoolId,
					poolA.githubRunnerPoolId,
				),
			});

		await expect(
			firewallsOf(b).attach({ firewallId: firewallB.firewallId, target }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			firewallsOf(memberA).attach({ firewallId: firewallA.firewallId, target }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		expect(await attached()).toEqual([]);

		await firewallsOf(a).attach({ firewallId: firewallA.firewallId, target });
		expect((await attached()).map((row) => row.firewallId)).toEqual([
			firewallA.firewallId,
		]);
		const pools = await runners(a).overview();
		expect(
			pools.find((pool) => pool.name === poolA.name)?.firewall?.firewallId,
		).toBe(firewallA.firewallId);

		await expect(
			firewallsOf(b).one({ firewallId: firewallA.firewallId }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(firewallsOf(b).detach({ target })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			firewallsOf(b).remove({ firewallId: firewallA.firewallId }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(await attached()).toHaveLength(1);

		await firewallsOf(a).detach({ target });
		expect(await attached()).toEqual([]);
	});
});
