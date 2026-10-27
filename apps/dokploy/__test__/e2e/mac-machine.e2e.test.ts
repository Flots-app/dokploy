import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LIMA_SSH_PORTS,
	pfRuleset,
} from "@dokploy/server/utils/firewall/backends";
import { compileFirewall } from "@dokploy/server/utils/firewall/model";
import { FIREWALL_TEMPLATES } from "@dokploy/server/utils/firewall/rules";
import { macChecks } from "@dokploy/server/utils/github-runners/checks";
import { generateMachineKey } from "@dokploy/server/utils/github-runners/controller";
import {
	MAC_FIREWALL_HELPER,
	parseFirewallStatus,
} from "@dokploy/server/utils/github-runners/firewall";
import { resolveLimaRelease } from "@dokploy/server/utils/github-runners/github-api";
import {
	LIMA_VERSION,
	macCreateVmScript,
	macDeleteVmScript,
	macInstallLimaScript,
	macProbeScript,
	macResizeVmScript,
	macStartVmScript,
} from "@dokploy/server/utils/github-runners/macos";
import { parseMacStatus } from "@dokploy/server/utils/github-runners/probe";
import {
	machineSetupScript,
	parseSetupCode,
	publicKeyFingerprint,
} from "@dokploy/server/utils/github-runners/setup";
import {
	type NodeSession,
	openNodeSession,
} from "@dokploy/server/utils/github-runners/ssh";
import { afterAll, describe, expect, it } from "vitest";

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

const VM = "dokploy-runners";
const settings = {
	vmName: VM,
	vmDiskGb: 20,
	diskReserveGb: 5,
	diskCleanupPercent: 95,
	cpuPercent: 50,
	memoryPercent: 50,
	maxRunners: 0,
};

describe.runIf(process.platform === "darwin")("a Mac runner machine", () => {
	const dir = mkdtempSync(join(tmpdir(), "dokploy-e2e-"));
	const scriptPath = join(dir, "dokploy-runner-setup-ci-mac.sh");
	const keys = generateMachineKey("ci-mac");
	let hostKeys: string[] = [];
	let session: NodeSession | null = null;

	const remote = async (
		command: string,
		options: {
			input?: string;
			timeoutMs?: number;
			allowFailure?: boolean;
		} = {},
	) => {
		if (!session) throw new Error("not connected");
		return session.run(command, {
			label: "e2e",
			timeoutMs: options.timeoutMs ?? 120_000,
			input: options.input,
			allowFailure: options.allowFailure,
		});
	};
	const probe = async () => {
		const { stdout } = await remote(macProbeScript(VM, false));
		return { ...parseMacStatus(stdout), firewall: parseFirewallStatus(stdout) };
	};

	afterAll(() => session?.close());

	it("sets the Mac up with the setup script", () => {
		writeFileSync(
			scriptPath,
			machineSetupScript({
				platform: "macos",
				machine: "ci-mac",
				publicKey: keys.publicKey,
				keepAwake: true,
			}),
		);
		const setup = run(`bash ${scriptPath}`, { root: true });
		console.log(setup.stdout, setup.stderr);
		expect(setup.status, setup.stderr).toBe(0);
		const code = setup.stdout.match(/^dokploy-runner-setup:\S+$/m)?.[0];
		if (!code) throw new Error("no setup code");
		const parsed = parseSetupCode(code);
		expect(parsed).toMatchObject({
			machine: "ci-mac",
			platform: "macos",
			user: "dokploy-manager",
			keepAwake: true,
		});
		hostKeys = parsed.hostKeys;
		expect(hostKeys).toContain(
			publicKeyFingerprint(
				readFileSync("/etc/ssh/ssh_host_ed25519_key.pub", "utf8"),
			),
		);

		// A hidden standard account, without a password.
		expect(run("dscl . -read /Users/dokploy-manager IsHidden").stdout).toMatch(
			/IsHidden: 1/,
		);
		expect(
			run("dseditgroup -o checkmember -m dokploy-manager admin").stdout,
		).toMatch(/^no /);
		// Key only, no TTY, no forwarding; other accounts keep their settings.
		const sshd = (user: string) =>
			run(`/usr/sbin/sshd -T -C user=${user},host=x,addr=127.0.0.1`, {
				root: true,
			}).stdout;
		expect(sshd("dokploy-manager")).toMatch(/^permittty no$/m);
		expect(sshd("dokploy-manager")).toMatch(/^passwordauthentication no$/m);
		expect(sshd("dokploy-manager")).toMatch(
			/^authenticationmethods publickey$/m,
		);
		expect(sshd(process.env.USER ?? "runner")).toMatch(/^permittty yes$/m);
		expect(run("/usr/sbin/sshd -t", { root: true }).status).toBe(0);
		// Both daemons are loaded, and sudo allows the firewall helper only.
		for (const label of [
			"com.dokploy.github-runners",
			"com.dokploy.firewall",
		]) {
			expect(
				run(`launchctl print system/${label}`, { root: true }).status,
			).toBe(0);
		}
		const sudo = run("sudo -l -U dokploy-manager", { root: true }).stdout;
		expect(sudo).toContain(`NOPASSWD: ${MAC_FIREWALL_HELPER}`);
		expect(sudo).not.toMatch(/NOPASSWD: ALL/);
		// Keep awake: never sleeps. A virtual Mac has no restart after a power
		// loss (pmset ignores what the hardware lacks); a Mac mini has it.
		const power = run("pmset -g custom").stdout;
		expect(power).toMatch(/^\s*sleep\s+0$/m);
		expect(power).toMatch(/^\s*disksleep\s+0$/m);
		if (/\bautorestart\b/.test(run("pmset -g cap").stdout)) {
			expect(power).toMatch(/^\s*autorestart\s+1$/m);
		}
	});

	it("logs in with the machine key and reads the Mac", async () => {
		session = await openNodeSession({
			name: "ci-mac",
			host: "127.0.0.1",
			port: 22,
			username: "dokploy-manager",
			privateKey: keys.privateKey,
			hostKeyFingerprint: null,
			knownHostKeys: hostKeys,
		});
		expect(hostKeys).toContain(session.fingerprint);
		expect((await remote("id -un")).stdout.trim()).toBe("dokploy-manager");
		// No sudo beyond the helper.
		expect(
			(await remote("sudo -n true", { allowFailure: true })).exitCode,
		).not.toBe(0);

		const status = await probe();
		const checks = macChecks(status, settings);
		console.log(checks);
		expect(status.host?.arch).toBe("arm64");
		expect(checks.find((item) => item.id === "network")?.status).toBe("pass");
		expect(checks.find((item) => item.id === "platform")?.status).toBe("pass");
		expect(status.firewall?.helper).toBe("yes");
	});

	it("installs the pinned Lima and creates, resizes and deletes the VM", async () => {
		const release = await resolveLimaRelease(LIMA_VERSION, "arm64", {
			authorization: process.env.GITHUB_TOKEN
				? `Bearer ${process.env.GITHUB_TOKEN}`
				: undefined,
		});
		const install = await remote(macInstallLimaScript(release), {
			timeoutMs: 10 * 60_000,
		});
		expect(install.stdout).toContain(`lima installed=${LIMA_VERSION}`);
		const status = await probe();
		expect(status).toMatchObject({
			limaVersion: LIMA_VERSION,
			limaManaged: true,
		});
		expect(status.vm.status).toBe("missing");

		const created = await remote(
			macCreateVmScript(VM, { cpus: 2, memoryGiB: "2", diskGb: 20 }),
			{ timeoutMs: 20 * 60_000, allowFailure: true },
		);
		console.log(created.stdout, created.stderr);
		expect(created.exitCode, created.stderr).toBe(0);
		expect((await probe()).vm).toMatchObject({
			status: "Stopped",
			cpus: 2,
			memoryBytes: 2 * 1024 ** 3,
			diskBytes: 20 * 1024 ** 3,
			type: "vz",
		});
		await remote(
			macResizeVmScript(VM, { cpus: 3, memoryGiB: "3", diskGb: 25 }),
		);
		expect((await probe()).vm).toMatchObject({
			cpus: 3,
			memoryBytes: 3 * 1024 ** 3,
			diskBytes: 25 * 1024 ** 3,
		});

		// GitHub's macOS runners cannot nest virtualization: only what the start
		// says is recorded, the boot itself needs a real Mac.
		const start = await remote(macStartVmScript(VM), {
			timeoutMs: 4 * 60_000,
			allowFailure: true,
		}).catch((error: unknown) => ({
			exitCode: null,
			stdout: "",
			stderr: String(error),
		}));
		console.log(
			"VM start on a GitHub runner:",
			start.exitCode,
			start.stderr.slice(-2000),
		);

		await remote(macDeleteVmScript(VM), { timeoutMs: 5 * 60_000 });
		expect((await probe()).vm.status).toBe("missing");
	});

	it("filters the account's outbound traffic with pf, and only it", async () => {
		const template = FIREWALL_TEMPLATES.find(
			(item) => item.id === "internet-only",
		);
		if (!template) throw new Error("no Internet only template");
		const ruleset = pfRuleset(
			compileFirewall(
				{
					firewallId: "e2e",
					name: template.name,
					inboundPolicy: template.inboundPolicy,
					outboundPolicy: template.outboundPolicy,
					rules: template.rules.map((rule, index) => ({
						...rule,
						id: `rule-${index}`,
					})),
				},
				{ dokployAddresses: [] },
			),
		);
		const references = () =>
			run("pfctl -s References", { root: true }).stdout.trim();
		const referencesBefore = references();
		const applied = await remote(`sudo -n ${MAC_FIREWALL_HELPER} apply`, {
			input: ruleset.text,
		});
		expect(references()).not.toBe(referencesBefore);
		expect(parseFirewallStatus(applied.stdout)?.loaded).toBe(ruleset.hash);
		expect((await probe()).firewall?.loaded).toBe(ruleset.hash);

		const fromAccount = (url: string) =>
			remote(`curl -sS -o /dev/null -w '%{http_code}' -m 8 ${url}`, {
				allowFailure: true,
			});
		expect((await fromAccount("https://github.com")).stdout).toBe("200");
		for (const address of [
			"10.255.255.1",
			"192.168.255.1",
			"100.100.100.100",
		]) {
			const startedAt = Date.now();
			const blocked = await fromAccount(`http://${address}/`);
			expect(blocked.exitCode, address).not.toBe(0);
			// Rejected at once (block return), not left to time out.
			expect(Date.now() - startedAt, address).toBeLessThan(3_000);
		}
		// The runner's own account is not filtered: the same address times out.
		expect(run("curl -sS -o /dev/null -m 3 http://10.255.255.1/").status).toBe(
			28,
		);

		// The Mac's loopback (192.168.5.2 from the VM): a service there is out
		// of reach, except in the range Lima's SSH forward uses.
		const sshPort = LIMA_SSH_PORTS.first + 5;
		for (const port of [18080, sshPort]) {
			spawn(
				"python3",
				["-m", "http.server", String(port), "--bind", "127.0.0.1"],
				{
					detached: true,
					stdio: "ignore",
				},
			).unref();
		}
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		expect(
			run("curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/")
				.stdout,
		).toBe("200");
		const local = await fromAccount("http://127.0.0.1:18080/");
		expect(local.exitCode, local.stderr).not.toBe(0);
		expect((await fromAccount(`http://127.0.0.1:${sshPort}/`)).stdout).toBe(
			"200",
		);
		run("pkill -f 'http.server'");

		// Hand-written rules are refused.
		const forged = await remote(`sudo -n ${MAC_FIREWALL_HELPER} apply`, {
			input: `# dokploy-firewall ${"0".repeat(32)}\npass out quick proto tcp from any to any\n`,
			allowFailure: true,
		});
		expect(forged.exitCode).not.toBe(0);

		// Loaded again by its boot daemon, then removed with the pf reference.
		expect(
			run("launchctl kickstart -k system/com.dokploy.firewall", { root: true })
				.status,
		).toBe(0);
		await new Promise((resolve) => setTimeout(resolve, 3_000));
		expect((await probe()).firewall?.loaded).toBe(ruleset.hash);
		const cleared = await remote(`sudo -n ${MAC_FIREWALL_HELPER} clear`, {
			input: "",
		});
		expect(parseFirewallStatus(cleared.stdout)?.loaded ?? null).toBeNull();
		// The helper's pf reference is released: pf is back as it was.
		expect(references()).toBe(referencesBefore);
	});

	it("removes everything with --uninstall", () => {
		session?.close();
		session = null;
		const uninstall = run(`bash ${scriptPath} --uninstall`, { root: true });
		console.log(uninstall.stdout, uninstall.stderr);
		expect(uninstall.status, uninstall.stderr).toBe(0);
		expect(run("id dokploy-manager").status).not.toBe(0);
		for (const path of [
			"/etc/ssh/sshd_config.d/050-dokploy-manager.conf",
			"/Library/LaunchDaemons/com.dokploy.github-runners.plist",
			"/Library/LaunchDaemons/com.dokploy.firewall.plist",
			MAC_FIREWALL_HELPER,
			"/etc/sudoers.d/dokploy-firewall",
			"/Users/dokploy-manager",
		]) {
			expect(run(`test -e ${path}`, { root: true }).status, path).not.toBe(0);
		}
		expect(run("/usr/sbin/sshd -t", { root: true }).status).toBe(0);
	});
});
