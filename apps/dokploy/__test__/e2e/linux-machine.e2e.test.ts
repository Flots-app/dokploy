import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@dokploy/server/db";
import {
	githubRunnerNodes,
	githubRunnerOperations,
	githubRunnerPools,
} from "@dokploy/server/db/schema";
import {
	attachFirewall,
	createFirewall,
} from "@dokploy/server/services/firewall";
import {
	completeGithubRunnerEnrollment,
	finishGithubRunnerEnrollment,
	startGithubRunnerEnrollment,
} from "@dokploy/server/services/github-runner";
import { FIREWALL_TEMPLATES } from "@dokploy/server/utils/firewall/rules";
import {
	cleanRunnerCaches,
	provisionRunnerNode,
	removeRunnerNode,
	startGithubRunnerController,
	stopGithubRunnerController,
} from "@dokploy/server/utils/github-runners/controller";
import { RUNTIME_VERSION } from "@dokploy/server/utils/github-runners/runtime";
import {
	parseSetupCode,
	publicKeyFingerprint,
} from "@dokploy/server/utils/github-runners/setup";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createOrganization,
	type Person,
	removeCreatedRows,
} from "../db/fixtures";

/** A command on this machine, as root when asked. */
const run = (command: string, options: { root?: boolean } = {}) => {
	const started = Date.now();
	const result = spawnSync(
		options.root ? "sudo" : "bash",
		options.root ? ["bash", "-c", command] : ["-c", command],
		{ encoding: "utf8", timeout: 10 * 60_000 },
	);
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		ms: Date.now() - started,
	};
};

const waitFor = async <T>(
	what: string,
	check: () => Promise<T | null | undefined | false>,
	timeoutMs: number,
): Promise<T> => {
	const until = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 2_000));
	}
};

const operationDone = (id: string) =>
	waitFor(
		"the operation",
		async () => {
			const operation = await db.query.githubRunnerOperations.findFirst({
				where: eq(githubRunnerOperations.githubRunnerOperationId, id),
			});
			return operation && operation.status !== "running" ? operation : null;
		},
		25 * 60_000,
	);

const node = (id: string) =>
	db.query.githubRunnerNodes.findFirst({
		where: eq(githubRunnerNodes.githubRunnerNodeId, id),
	});

describe.runIf(process.platform === "linux")("a Linux runner machine", () => {
	const dir = mkdtempSync(join(tmpdir(), "dokploy-e2e-"));
	const scriptPath = join(dir, "dokploy-runner-setup-ci-linux.sh");
	let owner: Person;
	let poolId = "";
	let nodeId = "";

	beforeAll(async () => {
		owner = await createOrganization("e2e-linux");
		const [ownerName, repository] = (process.env.GITHUB_REPOSITORY ?? "").split(
			"/",
		);
		// The workflow's read-only token: it lists the runner releases but may not
		// register a runner, so nothing ever reaches a real repository's runners.
		const [pool] = await db
			.insert(githubRunnerPools)
			.values({
				organizationId: owner.organizationId,
				name: "e2e",
				scope: "repository",
				owner: ownerName ?? "",
				repository: repository ?? "",
				authType: "token",
				token: process.env.GITHUB_TOKEN ?? null,
				labels: ["dokploy-e2e-ci"],
				routingVariable: null,
				autonomyReserve: 0,
			})
			.returning();
		poolId = pool?.githubRunnerPoolId ?? "";
	});

	afterAll(async () => {
		await stopGithubRunnerController();
		await removeCreatedRows();
	});

	it("enrolls the machine with its setup script and code", async () => {
		const started = await startGithubRunnerEnrollment(
			{
				githubRunnerPoolId: poolId,
				name: "ci-linux",
				description: null,
				platform: "linux",
				vmName: "dokploy-runners",
				keepAwake: true,
			},
			owner.organizationId,
		);
		nodeId = started.node.githubRunnerNodeId;
		writeFileSync(scriptPath, started.script);

		const setup = run(`bash ${scriptPath}`, { root: true });
		expect(setup.status, setup.stderr).toBe(0);
		const code = setup.stdout.match(/^dokploy-runner-setup:\S+$/m)?.[0];
		if (!code) throw new Error(`No setup code in:\n${setup.stdout}`);
		const parsed = parseSetupCode(code);
		expect(parsed).toMatchObject({
			machine: "ci-linux",
			user: "dokploy-manager",
		});
		const hostKey = publicKeyFingerprint(
			readFileSync("/etc/ssh/ssh_host_ed25519_key.pub", "utf8"),
		);
		expect(parsed.hostKeys).toContain(hostKey);

		// The account logs in with its key only; the other accounts keep theirs.
		const sshd = (user: string) =>
			run(`/usr/sbin/sshd -T -C user=${user},host=x,addr=127.0.0.1`, {
				root: true,
			}).stdout;
		expect(sshd("dokploy-manager")).toMatch(/^permittty no$/m);
		expect(sshd("dokploy-manager")).toMatch(/^allowtcpforwarding no$/m);
		expect(sshd("dokploy-manager")).toMatch(
			/^authenticationmethods publickey$/m,
		);
		expect(sshd("runner")).toMatch(/^permittty yes$/m);
		expect(run("visudo -c", { root: true }).status).toBe(0);

		const checked = await completeGithubRunnerEnrollment(
			{ githubRunnerNodeId: nodeId, code, host: "127.0.0.1", port: 22 },
			owner.organizationId,
		);
		// What the checks said shows when one of them stops the enrollment.
		expect(checked, JSON.stringify(checked.checks, null, 1)).toMatchObject({
			fingerprint: hostKey,
			platform: "linux",
			canProvision: true,
		});
		await finishGithubRunnerEnrollment(
			{
				githubRunnerNodeId: nodeId,
				cpuPercent: 50,
				memoryPercent: 50,
				diskReserveGb: 2,
				diskCleanupPercent: 95,
				maxRunners: 1,
				vmDiskGb: 60,
				extraLabels: [],
			},
			owner.organizationId,
		);
	});

	it("provisions the runtime, the runner and the budget", async () => {
		const operation = await provisionRunnerNode(nodeId, owner.userId);
		const done = await operationDone(operation.githubRunnerOperationId);
		expect(done.status, `${done.errorMessage ?? ""}\n${done.logs}`).toBe(
			"done",
		);
		expect(await node(nodeId)).toMatchObject({
			phase: "ready",
			applied: { runtimeVersion: RUNTIME_VERSION },
		});

		// The slice name only means something to Docker's systemd cgroup driver,
		// which the runtime switches Docker to.
		expect(run("docker info --format '{{.CgroupDriver}}'").stdout.trim()).toBe(
			"systemd",
		);
		const cpus = Number(run("nproc").stdout.trim());
		const slice = run(
			"systemctl show dokploy-runners.slice -p CPUQuotaPerSecUSec -p AllowedCPUs -p MemoryMax",
		).stdout;
		// Half the CPUs, the last ones, so nproc inside matches the quota.
		const half = Math.max(1, Math.floor(cpus / 2));
		expect(slice, slice).toMatch(
			new RegExp(`^CPUQuotaPerSecUSec=${half}s$`, "m"),
		);
		expect(slice).toMatch(/^AllowedCPUs=\S+$/m);
		expect(slice).not.toMatch(/^MemoryMax=infinity$/m);
		const daemon = JSON.parse(
			run("cat /etc/docker/daemon.json", { root: true }).stdout,
		) as Record<string, unknown>;
		expect(daemon["cgroup-parent"]).toBe("dokploy-runners.slice");
		// A job's own container shares the budget.
		const container = run(
			"docker run --rm alpine:3.20 sh -c 'nproc; cat /proc/self/cgroup'",
		);
		expect(container.status, container.stderr).toBe(0);
		expect(container.stdout.split("\n")[0]).toBe(String(half));
		expect(container.stdout).toContain("dokploy-runners.slice");

		const status = run("/opt/dokploy-runners/bin/runnerctl status", {
			root: true,
		});
		expect(status.stdout).toMatch(
			new RegExp(`^runtime version=${RUNTIME_VERSION}\\b`, "m"),
		);
		// The jobs account has no sudo.
		expect(run("sudo -l -U dokploy-runner", { root: true }).stdout).toMatch(
			/not allowed to run sudo/,
		);
	});

	it("filters the jobs' outbound traffic with an Internet only firewall", async () => {
		const template = FIREWALL_TEMPLATES.find(
			(item) => item.id === "internet-only",
		);
		if (!template) throw new Error("no Internet only template");
		const firewall = await createFirewall(
			{
				name: template.name,
				description: null,
				inboundPolicy: template.inboundPolicy,
				outboundPolicy: template.outboundPolicy,
				rules: template.rules.map((rule, index) => ({
					...rule,
					id: `rule-${index}`,
				})),
			},
			owner.organizationId,
		);
		await attachFirewall(
			{
				firewallId: firewall.firewallId,
				target: { type: "githubRunnerPool", id: poolId },
			},
			owner.organizationId,
		);
		await startGithubRunnerController({ kind: "standalone", version: "e2e" });
		const applied = await waitFor(
			"the firewall",
			async () => {
				const current = await node(nodeId);
				return current?.firewall?.appliedAt ? current.firewall : null;
			},
			5 * 60_000,
		);
		expect(applied.error).toBeNull();
		expect(
			run("nft list table inet dokploy_firewall", { root: true }).status,
		).toBe(0);

		const asJobs = (url: string) =>
			run(
				`sudo -u dokploy-runner curl -sS -o /dev/null -w '%{http_code}' -m 8 ${url}`,
			);
		expect(asJobs("https://github.com").stdout).toBe("200");
		for (const address of [
			"10.255.255.1",
			"192.168.255.1",
			"100.100.100.100",
		]) {
			const blocked = asJobs(`http://${address}/`);
			// Rejected at once, not left to time out.
			expect(blocked.status, `${address}: ${blocked.stderr}`).not.toBe(0);
			expect(blocked.ms, address).toBeLessThan(3_000);
		}
		// Other accounts are not filtered: the same address times out instead.
		const root = run("curl -sS -o /dev/null -m 3 http://10.255.255.1/", {
			root: true,
		});
		expect(root.status).toBe(28);

		// Job containers on the Docker bridge are filtered too.
		const container = (url: string) =>
			run(
				`docker run --rm curlimages/curl:8.11.1 -sS -o /dev/null -w '%{http_code}' -m 8 ${url}`,
			);
		expect(container("https://github.com").stdout).toBe("200");
		const fromContainer = container("http://10.255.255.1/");
		expect(fromContainer.status).not.toBe(0);
	});

	it("removes unused named volumes on a full cleanup and keeps the used ones", async () => {
		expect(
			run(
				"docker volume create e2e_cache && docker run --rm -v e2e_cache:/data alpine:3.20 dd if=/dev/zero of=/data/blob bs=1M count=32 && docker run -d --name e2e_keep -v e2e_used:/data alpine:3.20 sleep 900",
			).status,
		).toBe(0);
		const asked = new Date().toISOString();
		await waitFor(
			"the machine to be free",
			async () => cleanRunnerCaches(nodeId, "full").catch(() => false),
			5 * 60_000,
		);
		// The controller may run its own routine cleanup meanwhile: wait for this one.
		const cleanup = await waitFor(
			"the cleanup",
			async () =>
				(await node(nodeId))?.cleanups?.find(
					(item) => item.trigger === "manual-full" && item.at >= asked,
				),
			10 * 60_000,
		);
		expect(cleanup?.idle, JSON.stringify(cleanup)).toBe("done");
		const volumes = run("docker volume ls -q").stdout.split("\n");
		expect(volumes).not.toContain("e2e_cache");
		expect(volumes).toContain("e2e_used");
		run("docker rm -f e2e_keep");
	});

	it("uninstalls the runtime when removed, then the script removes the account", async () => {
		const operation = await removeRunnerNode(
			nodeId,
			{ mode: "kill", uninstall: true, force: false },
			owner.userId,
		);
		if (operation) {
			const done = await operationDone(operation.githubRunnerOperationId);
			expect(done.status, `${done.errorMessage ?? ""}\n${done.logs}`).toBe(
				"done",
			);
		}
		await waitFor(
			"the machine to be forgotten",
			async () => !(await node(nodeId)),
			5 * 60_000,
		);
		await stopGithubRunnerController();

		expect(
			run(
				"systemctl list-unit-files 'dokploy-runner*' --no-legend",
			).stdout.trim(),
		).toBe("");
		expect(
			run("nft list table inet dokploy_firewall", { root: true }).status,
		).not.toBe(0);
		expect(run("id dokploy-runner").status).not.toBe(0);
		const daemon = run("cat /etc/docker/daemon.json", { root: true }).stdout;
		expect(daemon).not.toContain("cgroup-parent");

		const uninstall = run(`bash ${scriptPath} --uninstall`, { root: true });
		expect(uninstall.status, uninstall.stderr).toBe(0);
		expect(run("id dokploy-manager").status).not.toBe(0);
		expect(
			run("test -e /etc/sudoers.d/dokploy-manager", { root: true }).status,
		).not.toBe(0);
		expect(run("/usr/sbin/sshd -t", { root: true }).status).toBe(0);
	});
});
