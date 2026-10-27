import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	apiCreateFirewall,
	apiUpdateFirewall,
} from "@dokploy/server/db/schema";
import {
	LIMA_SSH_PORTS,
	NFT_UID_PLACEHOLDER,
	nftablesRuleset,
	pfRuleset,
} from "@dokploy/server/utils/firewall/backends";
import {
	compileFirewall,
	type FirewallDefinition,
	filters,
	NON_PUBLIC,
} from "@dokploy/server/utils/firewall/model";
import {
	canonicalAddress,
	FIREWALL_TEMPLATES,
	type FirewallRule,
	isAddress,
	parsePorts,
} from "@dokploy/server/utils/firewall/rules";
import {
	linuxFirewallApplyScript,
	macFirewallHelper,
	parseFirewallStatus,
} from "@dokploy/server/utils/github-runners/firewall";
import {
	macCreateVmScript,
	macStartVmScript,
	macStopVmScript,
} from "@dokploy/server/utils/github-runners/macos";
import { machineSetupScript } from "@dokploy/server/utils/github-runners/setup";
import { afterAll, describe, expect, it, vi } from "vitest";

// The domain of the Dokploy server resolves without a network.
vi.mock("node:dns/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:dns/promises")>()),
	lookup: vi.fn(async () => [{ address: "104.16.1.1", family: 4 }]),
}));

const rule = (overrides: Partial<FirewallRule> = {}): FirewallRule => ({
	id: "r1",
	direction: "outbound",
	action: "allow",
	protocol: "any",
	ports: null,
	peer: { type: "object", object: "internet" },
	description: null,
	...overrides,
});

const firewall = (
	rules: FirewallRule[],
	overrides: Partial<FirewallDefinition> = {},
): FirewallDefinition => ({
	firewallId: "fw",
	name: "Internet only",
	inboundPolicy: "deny",
	outboundPolicy: "deny",
	rules,
	...overrides,
});

const context = { dokployAddresses: ["203.0.113.7", "2001:db8::7"] };

describe("firewall rules", () => {
	it("accepts addresses and networks of both families", () => {
		for (const value of [
			"10.0.0.0/8",
			"192.168.1.20",
			"0.0.0.0/0",
			"fd7a:115c:a1e0::/48",
			"::1",
			"::ffff:10.0.0.1",
		]) {
			expect(isAddress(value), value).toBe(true);
		}
		for (const value of [
			"10.0.0.0/33",
			"300.1.1.1",
			"10.0.0",
			"fd00::/129",
			"example.com",
			"10.0.0.0/8/8",
			"",
		]) {
			expect(isAddress(value), value).toBe(false);
		}
	});

	it("reads ports, lists and ranges", () => {
		expect(parsePorts("443")).toEqual([[443, 443]]);
		expect(parsePorts("80, 443,8000-9000")).toEqual([
			[80, 80],
			[443, 443],
			[8000, 9000],
		]);
		expect(parsePorts("0")).toBeNull();
		expect(parsePorts("9000-8000")).toBeNull();
		expect(parsePorts("65536")).toBeNull();
		expect(parsePorts("http")).toBeNull();
	});

	it("rejects rules the backends cannot express", () => {
		const parse = (rules: FirewallRule[]) =>
			apiCreateFirewall.safeParse({ name: "x", rules });
		expect(parse([rule({ protocol: "icmp", ports: "443" })]).success).toBe(
			false,
		);
		expect(parse([rule({ protocol: "tcp", ports: "80-70" })]).success).toBe(
			false,
		);
		expect(
			parse([rule({ peer: { type: "addresses", addresses: ["10.0.0.0/40"] } })])
				.success,
		).toBe(false);
		expect(parse([rule(), rule()]).success).toBe(false);
		expect(parse([rule({ protocol: "tcp", ports: "443" })]).success).toBe(true);
	});

	it("offers templates the schema accepts", () => {
		for (const template of FIREWALL_TEMPLATES) {
			const parsed = apiCreateFirewall.safeParse({
				...template,
				rules: template.rules.map((item, index) => ({
					...item,
					id: `r${index}`,
				})),
			});
			expect(parsed.success, template.id).toBe(true);
		}
	});
});

describe("firewall compilation", () => {
	it("turns the Internet into everything but the non-public ranges", () => {
		const compiled = compileFirewall(firewall([rule()]), context);
		expect(compiled.outbound.rules[0]).toMatchObject({
			negate: true,
			addresses: NON_PUBLIC,
		});
		expect(NON_PUBLIC.v4).toEqual(
			expect.arrayContaining(["10.0.0.0/8", "100.64.0.0/10", "192.168.0.0/16"]),
		);
		expect(NON_PUBLIC.v6).toEqual(expect.arrayContaining(["fc00::/7"]));
	});

	it("leaves out the Dokploy server while its addresses are unknown", () => {
		const compiled = compileFirewall(
			firewall([
				rule({ action: "deny", peer: { type: "object", object: "dokploy" } }),
			]),
			{ dokployAddresses: [] },
		);
		expect(compiled.outbound.rules).toEqual([]);
		expect(compiled.skipped).toEqual([
			{
				ruleId: "r1",
				reason: "the addresses of the Dokploy server are not known",
			},
		]);
	});

	it("does not filter a default allow without rules", () => {
		const open = compileFirewall(
			firewall([], { outboundPolicy: "allow" }),
			context,
		);
		expect(filters(open.outbound)).toBe(false);
		expect(filters(compileFirewall(firewall([]), context).outbound)).toBe(true);
	});
});

const sample = () =>
	compileFirewall(
		firewall([
			rule({
				id: "dokploy",
				action: "deny",
				peer: { type: "object", object: "dokploy" },
			}),
			rule({
				id: "registry",
				protocol: "tcp",
				ports: "5000,8000-8100",
				peer: { type: "addresses", addresses: ["10.0.4.20", "fd00::20"] },
			}),
			rule({ id: "ping", protocol: "icmp" }),
			rule({ id: "internet" }),
		]),
		context,
	);

describe("nftables ruleset", () => {
	it("filters the job account and the Docker bridges, in order", () => {
		const { text, hash, notes } = nftablesRuleset(sample());
		expect(text).toMatch(/^# Dokploy firewall "Internet only"/);
		expect(text).toContain(
			"table inet dokploy_firewall\ndelete table inet dokploy_firewall\n",
		);
		expect(text).toContain(`meta skuid ${NFT_UID_PLACEHOLDER} jump jobs`);
		expect(text).toContain('iifname "docker0" jump jobs');
		expect(text).toContain('iifname "br-*" jump jobs');
		const jobs = text
			.slice(text.indexOf("chain jobs {"), text.indexOf("chain output"))
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("chain") && line !== "}");
		expect(jobs).toEqual([
			"ct state established,related accept",
			'oifname "lo" accept',
			"meta l4proto { tcp, udp } th dport 53 accept",
			"ip daddr @v4_1 reject",
			"ip6 daddr @v6_2 reject",
			"ip daddr @v4_3 meta l4proto tcp tcp dport { 5000, 8000-8100 } accept",
			"ip6 daddr @v6_4 meta l4proto tcp tcp dport { 5000, 8000-8100 } accept",
			"ip daddr != @v4_5 meta l4proto { icmp, ipv6-icmp } accept",
			"ip6 daddr != @v6_6 meta l4proto { icmp, ipv6-icmp } accept",
			"ip daddr != @v4_5 accept",
			"ip6 daddr != @v6_6 accept",
			"reject",
		]);
		expect(text).toContain("elements = { 203.0.113.7 }");
		expect(hash).toMatch(/^[a-f0-9]{32}$/);
		expect(notes.join(" ")).toContain("Inbound rules do not apply here");
		expect(notes.join(" ")).toContain("docker group is root");
	});

	it("is loaded by a script that checks it first and keeps it for the boot", () => {
		const ruleset = nftablesRuleset(sample());
		const script = linuxFirewallApplyScript(ruleset);
		expect(script).toContain('nft -c -f "$tmp" || fail');
		expect(script).toContain(`sed -i "s/${NFT_UID_PLACEHOLDER}/$uid/"`);
		expect(script).toContain("systemctl enable dokploy-firewall.service");
		expect(script).toContain(`printf '%s\\n' ${ruleset.hash}`);
		const bash = spawnSync("bash", ["-n"], { input: script });
		expect(bash.status, bash.stderr.toString()).toBe(0);
	});
});

describe("pf ruleset", () => {
	it("writes only rules the helper accepts, with the hash of their body", () => {
		const { text, hash, notes } = pfRuleset(sample());
		const lines = text.trimEnd().split("\n");
		expect(lines[0]).toBe(`# dokploy-firewall ${hash}`);
		expect(lines.slice(1)).toEqual([
			"table <dk1> const { 203.0.113.7, 2001:db8::7 }",
			"table <dk2> const { 10.0.4.20, fd00::20 }",
			`table <dk3> const { ${[...NON_PUBLIC.v4, ...NON_PUBLIC.v6].join(", ")} }`,
			// The Mac's loopback: Lima's SSH forward only, then nothing.
			"pass out quick on lo0 proto tcp from any to any port 60022:60031",
			"pass out quick proto { tcp udp } from any to any port 53",
			"block return out quick on lo0 proto { tcp udp } from any to any",
			"block return out quick proto { tcp udp } from any to <dk1>",
			// No state: a stricter firewall cuts the connections already open.
			"pass out quick proto tcp from any to <dk2> port { 5000 8000:8100 } no state",
			"pass out quick proto { tcp udp } from any to ! <dk3> no state",
			"block return out quick proto { tcp udp } from any to any",
		]);
		expect(notes.join(" ")).toContain(
			"On a Mac, pf filters TCP and UDP only: ICMP (ping) is not filtered",
		);
		expect(notes.join(" ")).toContain(
			"only on ports 60022-60031, where Lima forwards its SSH",
		);
	});

	it("leaves the VM's SSH range in the range Lima's scripts pick from", () => {
		const create = macCreateVmScript("dokploy-runners", {
			cpus: 2,
			memoryGiB: "2",
			diskGb: 20,
		});
		expect(create).toContain('--ssh-port="$port"');
		expect(create).toContain(
			`seq ${LIMA_SSH_PORTS.first} ${LIMA_SSH_PORTS.last}`,
		);
		// A VM started outside the range is moved into it first; one already
		// running outside it is refused rather than cut off by the firewall.
		const start = macStartVmScript("dokploy-runners");
		expect(start).toContain('limactl edit --tty=false --ssh-port="$port"');
		expect(start).toMatch(/outside 60022-60031: stop it/);
		for (const script of [create, start]) {
			const bash = spawnSync("bash", ["-n"], { input: script });
			expect(bash.status, bash.stderr.toString()).toBe(0);
		}
	});
});

describe("Lima VM SSH port", () => {
	/** Runs a Mac script with fake limactl, nc and sysctl, as the Mac account would. */
	const runMac = (
		script: string,
		vm: { status: string; port: number },
		busyPorts: number[] = [],
	) => {
		const home = mkdtempSync(join(tmpdir(), "dokploy-lima-"));
		const bin = join(home, ".dokploy/lima/bin");
		spawnSync("mkdir", ["-p", bin]);
		const fakes: Record<string, string> = {
			limactl: `#!/bin/bash
echo "limactl $*" >>"${home}/calls"
case "$*" in
*"{{.Status}}"*) echo "${vm.status}" ;;
*"{{.SSHLocalPort}}"*) echo "${vm.port}" ;;
*"{{.Dir}}"*) echo "${home}" ;;
stop*) [ -f "${home}/refuse-stop" ] && [ "$2" != --force ] && exit 1 ;;
esac
exit 0
`,
			nc: `#!/bin/bash
# nc -z -G 1 127.0.0.1 PORT: the port is the last argument.
case " ${busyPorts.join(" ")} " in *" ${"${@: -1}"} "*) exit 0 ;; esac
exit 1
`,
			sysctl: "#!/bin/bash\necho '{ sec = 1700000000, usec = 0 }'\n",
		};
		for (const [name, body] of Object.entries(fakes)) {
			writeFileSync(join(bin, name), body);
			chmodSync(join(bin, name), 0o755);
		}
		const result = spawnSync("bash", ["-c", script], {
			env: { ...process.env, HOME: home },
			encoding: "utf8",
		});
		let calls = "";
		try {
			calls = readFileSync(join(home, "calls"), "utf8");
		} catch {}
		return { ...result, calls, home };
	};

	it("moves a VM with a random port into the range before starting it", () => {
		const moved = runMac(
			macStartVmScript("dokploy-runners"),
			{
				status: "Stopped",
				port: 0,
			},
			[LIMA_SSH_PORTS.first],
		);
		expect(moved.status, moved.stderr).toBe(0);
		// The first port is taken by another process: the next one is used.
		expect(moved.calls).toContain(
			`limactl edit --tty=false --ssh-port=${LIMA_SSH_PORTS.first + 1} dokploy-runners`,
		);
		expect(moved.calls).toMatch(/limactl start --tty=false dokploy-runners/);
		expect(moved.calls.indexOf("edit")).toBeLessThan(
			moved.calls.indexOf("start"),
		);

		const kept = runMac(macStartVmScript("dokploy-runners"), {
			status: "Stopped",
			port: LIMA_SSH_PORTS.first + 3,
		});
		expect(kept.status, kept.stderr).toBe(0);
		expect(kept.calls).not.toContain("edit");
	});

	it("refuses a running VM outside the range instead of cutting it off", () => {
		const running = runMac(macStartVmScript("dokploy-runners"), {
			status: "Running",
			port: 49152,
		});
		expect(running.status).toBe(1);
		expect(running.stderr).toMatch(/outside 60022-60031: stop it/);
		expect(running.calls).not.toMatch(/edit|start/);
	});

	it("creates the VM on a free port of the range", () => {
		const created = runMac(
			macCreateVmScript("dokploy-runners", {
				cpus: 2,
				memoryGiB: "2",
				diskGb: 20,
			}),
			{ status: "", port: LIMA_SSH_PORTS.first },
			[],
		);
		expect(created.status, created.stderr).toBe(0);
		// Another instance already uses the first port.
		expect(created.calls).toContain(`--ssh-port=${LIMA_SSH_PORTS.first + 1}`);
	});

	it("forces a stop the guest refuses", () => {
		const stop = macStopVmScript("dokploy-runners");
		const graceful = runMac(stop, {
			status: "Running",
			port: LIMA_SSH_PORTS.first,
		});
		expect(graceful.status, graceful.stderr).toBe(0);
		expect(graceful.calls).not.toContain("--force");
		const refused = runMac(`touch "$HOME/refuse-stop"\n${stop}`, {
			status: "Running",
			port: LIMA_SSH_PORTS.first,
		});
		expect(refused.status, refused.stderr).toBe(0);
		expect(refused.calls).toContain("limactl stop --force dokploy-runners");
	});
});

describe("macOS firewall helper", () => {
	const dir = mkdtempSync(join(tmpdir(), "dokploy-pf-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const bin = join(dir, "bin");
	const state = join(dir, "state");
	// Stubs: pfctl logs what it is asked and answers like macOS does.
	const stubs: Record<string, string> = {
		id: `#!/bin/bash\ncase "$*" in "-u") echo 0 ;; "-u dokploy-manager") echo 502 ;; *) exit 1 ;; esac\n`,
		pfctl: `#!/bin/bash
echo "pfctl $*" >>"${dir}/pfctl.log"
case "$*" in
"-E") echo "Token : 4242" >&2 ;;
"-sr") echo 'anchor "com.apple/*" all' ;;
"-s info") echo "Status: Enabled for 0 days 00:00:12" ;;
"-a com.apple/dokploy.firewall -sr") [ -s "${state}/anchor.conf" ] && echo "rules" ;;
"-s References") ;;
esac
exit 0
`,
	};
	spawnSync("mkdir", ["-p", bin]);
	for (const [name, body] of Object.entries(stubs)) {
		writeFileSync(join(bin, name), body);
		chmodSync(join(bin, name), 0o755);
	}
	// The real helper, pointed at the stubs and a scratch state directory.
	const helper = join(dir, "helper");
	writeFileSync(
		helper,
		macFirewallHelper
			.replace(
				"export PATH=/usr/bin:/bin:/usr/sbin:/sbin",
				`export PATH=${bin}:/usr/bin:/bin`,
			)
			.replace("STATE=/var/db/dokploy-firewall", `STATE=${state}`)
			.replace("LOADED=/var/run/dokploy-firewall.hash", `LOADED=${dir}/loaded`)
			.replace(
				"EXPECTED=/var/db/dokploy-firewall.expected",
				`EXPECTED=${dir}/expected`,
			),
	);
	const run = (args: string[], input = "") =>
		spawnSync("/bin/bash", [helper, ...args], { input, encoding: "utf8" });

	it("binds every rule to the account Lima runs as and reports the hash", () => {
		const ruleset = pfRuleset(sample());
		const result = run(["apply"], ruleset.text);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(parseFirewallStatus(result.stdout)).toEqual({
			helper: "yes",
			loaded: ruleset.hash,
		});
		const anchor = readFileSync(join(state, "anchor.conf"), "utf8")
			.trimEnd()
			.split("\n");
		for (const line of anchor) {
			if (line.startsWith("table")) continue;
			expect(line).toMatch(/ user 502$/);
		}
		expect(readFileSync(join(dir, "pfctl.log"), "utf8")).toContain(
			`pfctl -q -a com.apple/dokploy.firewall -f ${state}/anchor.conf`,
		);
		expect(readFileSync(join(state, "token"), "utf8").trim()).toBe("4242");
		// The boot script of the VM waits for these rules.
		expect(readFileSync(join(dir, "expected"), "utf8").trim()).toBe(
			ruleset.hash,
		);
	});

	it("refuses anything Dokploy does not write", () => {
		const { hash } = pfRuleset(sample());
		for (const line of [
			"pass in quick proto tcp from any to any port 22",
			"rdr pass on en0 proto tcp from any to any port 80 -> 127.0.0.1",
			"pass out quick proto tcp from any to any user 0",
			"pass out quick on en0 proto tcp from any to any",
			"block return out quick proto tcp from 10.0.0.1 to any",
			"pass out quick proto tcp from any to any port 22 route-to (lo0 127.0.0.1)",
			"table <dk1> const { 10.0.0.0/8 } ; pass all",
		]) {
			const result = run(["apply"], `# dokploy-firewall ${hash}\n${line}\n`);
			expect(result.status, line).not.toBe(0);
			expect(result.stderr, line).toContain("is not a rule Dokploy writes");
		}
		expect(
			run(["apply"], "pass out quick proto tcp from any to any\n").stderr,
		).toContain("not a Dokploy firewall");
	});

	it("refuses rules that were cut or changed, and oversized input", () => {
		const { text } = pfRuleset(sample());
		const changed = text.replace("203.0.113.7", "203.0.113.8");
		expect(changed).not.toBe(text);
		const altered = run(["apply"], changed);
		expect(altered.status).not.toBe(0);
		expect(altered.stderr).toContain("do not match their hash");
		const huge = `${text}${"pass out quick proto tcp from any to any port 443\n".repeat(25_000)}`;
		const oversized = run(["apply"], huge);
		expect(oversized.status).not.toBe(0);
		expect(oversized.stderr).toContain("larger than 1048576 bytes");
	});

	it("loads the kept rules at boot and removes them on clear", () => {
		const ruleset = pfRuleset(sample());
		run(["apply"], ruleset.text);
		const boot = run(["boot"]);
		expect(boot.status).toBe(0);
		expect(parseFirewallStatus(boot.stdout)?.loaded).toBe(ruleset.hash);
		const clear = run(["clear"]);
		expect(clear.status).toBe(0);
		expect(readFileSync(join(dir, "pfctl.log"), "utf8")).toContain(
			"pfctl -X 4242",
		);
		expect(parseFirewallStatus(clear.stdout)).toEqual({
			helper: "yes",
			loaded: null,
		});
		expect(run(["boot"]).status).toBe(0);
	});

	it("is installed by the Mac setup script, with a sudo rule for it alone", () => {
		const script = machineSetupScript({
			platform: "macos",
			machine: "m6",
			publicKey:
				"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl dokploy",
			keepAwake: true,
		});
		expect(script).toContain(
			"printf '%s ALL=(root) NOPASSWD: %s\\n' \"$MANAGER_USER\" /Library/PrivilegedHelperTools/com.dokploy.firewall",
		);
		expect(script).toContain('launchctl bootstrap system "$firewall_daemon"');
		expect(script).toContain(
			"/Library/PrivilegedHelperTools/com.dokploy.firewall clear",
		);
		const bash = spawnSync("bash", ["-n"], { input: script });
		expect(bash.status, bash.stderr.toString()).toBe(0);
	});
});

describe("firewall enforcement by the runner controller", () => {
	const pfStatus = (loaded: string | null) =>
		`firewall helper=yes loaded=${loaded ?? "none"}\n`;
	const internetOnly = {
		firewallId: "fw",
		organizationId: "org",
		name: "Internet only",
		description: null,
		inboundPolicy: "deny" as const,
		outboundPolicy: "deny" as const,
		rules: [rule()],
		revision: 3,
		createdAt: "",
		updatedAt: "",
	};
	const expected = (platform: "macos" | "linux") => {
		const compiled = compileFirewall(internetOnly, { dokployAddresses: [] });
		return platform === "macos"
			? pfRuleset(compiled)
			: nftablesRuleset(compiled);
	};
	const node = (overrides: Record<string, unknown> = {}) =>
		({
			githubRunnerNodeId: "m6",
			githubRunnerPoolId: "pool",
			name: "m6",
			platform: "macos",
			enabled: true,
			phase: "ready",
			firewall: null,
			...overrides,
		}) as never;
	const fakeDriver = (reply: (command: string, input?: string) => string) => {
		const calls: { command: string; input?: string }[] = [];
		const run = async (command: string, options?: { input?: string }) => {
			calls.push({ command, input: options?.input });
			return {
				stdout: reply(command, options?.input),
				stderr: "",
				exitCode: 0,
			};
		};
		return { calls, driver: { host: run, guest: run } as never };
	};
	const probe = (firewall: unknown) => ({ firewall }) as never;
	let clock = Date.parse("2026-10-22T08:00:00Z");
	const attach = async (rows: unknown[], advanceMs = 60_000) => {
		// A new instant per case: the attachments are cached for 3 seconds.
		clock += advanceMs;
		vi.setSystemTime(clock);
		(globalThis as Record<string, unknown>).__dokployFirewallAddresses = {
			at: clock,
			addresses: [],
		};
		const { db } = await import("@dokploy/server/db");
		vi.mocked(db.query.firewallAttachments.findMany).mockResolvedValueOnce(
			rows as never,
		);
	};
	const poolAttachment = [
		{
			githubRunnerPoolId: "pool",
			githubRunnerNodeId: null,
			firewall: internetOnly,
		},
	];
	afterAll(() => vi.useRealTimers());
	vi.useFakeTimers({ toFake: ["Date"] });

	it("loads the pool's firewall on a Mac through the helper", async () => {
		const { enforceFirewall } = await import(
			"@dokploy/server/utils/github-runners/controller"
		);
		await attach(poolAttachment);
		const ruleset = expected("macos");
		const { calls, driver } = fakeDriver(() => pfStatus(ruleset.hash));
		const events: { at: string; message: string }[] = [];
		const blocked = await enforceFirewall(
			node(),
			driver,
			probe({ helper: "yes", loaded: null }),
			events,
		);
		expect(blocked).toBeNull();
		expect(calls).toEqual([
			{
				command:
					"sudo -n /Library/PrivilegedHelperTools/com.dokploy.firewall apply",
				input: ruleset.text,
			},
		]);
		expect(events[0]?.message).toBe('Firewall "Internet only" applied');
	});

	it("does nothing while the expected rules are loaded", async () => {
		const { enforceFirewall } = await import(
			"@dokploy/server/utils/github-runners/controller"
		);
		await attach(poolAttachment);
		const ruleset = expected("macos");
		const { calls, driver } = fakeDriver(() => "");
		const blocked = await enforceFirewall(
			node({
				firewall: {
					firewallId: "fw",
					revision: 3,
					hash: ruleset.hash,
					appliedAt: "2026-10-22T07:00:00Z",
					error: null,
					errorAt: null,
				},
			}),
			driver,
			probe({ helper: "yes", loaded: ruleset.hash }),
			[],
		);
		expect(blocked).toBeNull();
		expect(calls).toEqual([]);
	});

	it("keeps jobs away from a Mac without the helper", async () => {
		const { enforceFirewall } = await import(
			"@dokploy/server/utils/github-runners/controller"
		);
		await attach(poolAttachment);
		const { calls, driver } = fakeDriver(() => "");
		const blocked = await enforceFirewall(
			node({ githubRunnerNodeId: "m4", name: "m4" }),
			driver,
			probe({ helper: "missing", loaded: null }),
			[],
		);
		expect(blocked).toContain("run the setup script of the machine again");
		expect(calls).toEqual([]);
	});

	it("keeps jobs away when loading fails, and waits before trying again", async () => {
		const { enforceFirewall } = await import(
			"@dokploy/server/utils/github-runners/controller"
		);
		await attach(poolAttachment);
		const failing = {
			calls: 0,
			driver: {
				host: async () => {
					failing.calls++;
					throw new Error("pf rejected the rules");
				},
			} as never,
		};
		const first = await enforceFirewall(
			node({ githubRunnerNodeId: "m7", name: "m7" }),
			failing.driver,
			probe({ helper: "yes", loaded: null }),
			[],
		);
		expect(first).toBe(
			'Firewall "Internet only" not applied: pf rejected the rules',
		);
		await attach(poolAttachment, 5_000);
		const again = await enforceFirewall(
			node({ githubRunnerNodeId: "m7", name: "m7" }),
			failing.driver,
			probe({ helper: "yes", loaded: null }),
			[],
		);
		expect(again).toContain("not applied");
		expect(failing.calls).toBe(1);
	});

	it("loads nftables on Linux and removes rules no longer wanted", async () => {
		const { enforceFirewall } = await import(
			"@dokploy/server/utils/github-runners/controller"
		);
		await attach(poolAttachment);
		const ruleset = expected("linux");
		const linux = fakeDriver(() => pfStatus(ruleset.hash));
		expect(
			await enforceFirewall(
				node({ githubRunnerNodeId: "l1", name: "l1", platform: "linux" }),
				linux.driver,
				probe({ helper: "yes", loaded: null }),
				[],
			),
		).toBeNull();
		expect(linux.calls[0]?.command).toBe("bash -s");
		expect(linux.calls[0]?.input).toContain(ruleset.text);

		await attach([]);
		const detached = fakeDriver(() => pfStatus(null));
		const events: { at: string; message: string }[] = [];
		expect(
			await enforceFirewall(
				node({ githubRunnerNodeId: "l1", name: "l1", platform: "linux" }),
				detached.driver,
				probe({ helper: "yes", loaded: ruleset.hash }),
				events,
			),
		).toBeNull();
		expect(detached.calls[0]?.input).toContain(
			"nft delete table inet dokploy_firewall",
		);
		expect(events[0]?.message).toBe("Firewall removed");
	});

	it("keeps jobs away while a deny rule has no address to deny", async () => {
		const { enforceFirewall } = await import(
			"@dokploy/server/utils/github-runners/controller"
		);
		const noDokploy = {
			...internetOnly,
			firewallId: "no-dokploy",
			name: "No Dokploy",
			rules: [
				rule({
					id: "deny",
					action: "deny",
					peer: { type: "object", object: "dokploy" },
				}),
				rule(),
			],
		};
		await attach([
			{
				githubRunnerPoolId: "pool",
				githubRunnerNodeId: null,
				firewall: noDokploy,
			},
		]);
		const { calls, driver } = fakeDriver(() => "");
		const blocked = await enforceFirewall(
			node({ githubRunnerNodeId: "m8", name: "m8" }),
			driver,
			probe({ helper: "yes", loaded: null }),
			[],
		);
		expect(blocked).toBe(
			'Firewall "No Dokploy" not applied: a rule that denies traffic cannot be written: the addresses of the Dokploy server are not known',
		);
		expect(calls).toEqual([]);
	});

	it("follows the machine's own firewall over its pool's", async () => {
		const { enforceFirewall } = await import(
			"@dokploy/server/utils/github-runners/controller"
		);
		const open = {
			...internetOnly,
			firewallId: "open",
			name: "Open",
			outboundPolicy: "allow" as const,
			rules: [],
		};
		await attach([
			...poolAttachment,
			{ githubRunnerPoolId: null, githubRunnerNodeId: "m9", firewall: open },
		]);
		const { calls, driver } = fakeDriver(() => "");
		// Its own firewall filters nothing: no rule is loaded.
		expect(
			await enforceFirewall(
				node({ githubRunnerNodeId: "m9", name: "m9" }),
				driver,
				probe({ helper: "yes", loaded: null }),
				[],
			),
		).toBeNull();
		expect(calls).toEqual([]);
	});
});

describe("firewall review fixes", () => {
	it("refuses addresses nftables would refuse", () => {
		for (const value of ["10.0.0.0/08", "2001:db8::/032", "1.2.3.4/032"]) {
			expect(isAddress(value), value).toBe(false);
		}
		expect(isAddress("2001:db8::/32")).toBe(true);
	});

	it("merges overlapping networks in nftables sets", () => {
		const { text } = nftablesRuleset(
			compileFirewall(
				firewall([
					rule({
						action: "deny",
						peer: {
							type: "addresses",
							addresses: ["192.168.1.0/24", "192.168.1.10"],
						},
					}),
				]),
				context,
			),
		);
		expect(text).toContain(
			"flags interval\n\t\tauto-merge\n\t\telements = { 192.168.1.0/24, 192.168.1.10 }",
		);
	});

	it("counts the broadcast and multicast of the LAN as private networks", () => {
		const compiled = compileFirewall(
			firewall([
				rule({ action: "deny", peer: { type: "object", object: "private" } }),
			]),
			context,
		);
		expect(compiled.outbound.rules[0]?.addresses.v4).toEqual(
			expect.arrayContaining(["224.0.0.0/4", "255.255.255.255/32"]),
		);
		expect(compiled.outbound.rules[0]?.addresses.v6).toContain("ff00::/8");
	});
});

describe("firewall review infos", () => {
	it("keeps local-use NAT64 out of the Internet, and in private networks", () => {
		expect(NON_PUBLIC.v6).toContain("64:ff9b:1::/48");
		// The well-known prefix reaches public IPv4 hosts: it stays the Internet.
		expect(NON_PUBLIC.v6).not.toContain("64:ff9b::/96");
		const compiled = compileFirewall(
			firewall([
				rule({ action: "deny", peer: { type: "object", object: "private" } }),
			]),
			context,
		);
		expect(compiled.outbound.rules[0]?.addresses.v6).toContain(
			"64:ff9b:1::/48",
		);
	});

	it("tells that DNS passes and that a Mac does not filter ICMP", () => {
		const internetOnly = FIREWALL_TEMPLATES.find(
			(item) => item.id === "internet-only",
		);
		expect(internetOnly?.description).toContain(
			"DNS still reaches any resolver",
		);
		// Whatever the rules: the deny of last resort is TCP and UDP on a Mac.
		const { notes } = pfRuleset(compileFirewall(firewall([rule()]), context));
		expect(notes).toContain(
			"On a Mac, pf filters TCP and UDP only: ICMP (ping) is not filtered, and ICMP rules do not apply.",
		);
	});

	it("knows when a firewall applies to runners", async () => {
		const { db } = await import("@dokploy/server/db");
		const { firewallAppliesToRunners } = await import(
			"@dokploy/server/services/firewall"
		);
		vi.mocked(db.query.firewallAttachments.findFirst).mockResolvedValueOnce({
			firewallAttachmentId: "a",
		} as never);
		await expect(firewallAppliesToRunners("fw", "org")).resolves.toBe(true);
		vi.mocked(db.query.firewallAttachments.findFirst).mockResolvedValueOnce(
			undefined,
		);
		await expect(firewallAppliesToRunners("fw", "org")).resolves.toBe(false);
	});
});

describe("firewall review, fourth pass", () => {
	it("keeps the Dokploy server's addresses when its settings cannot be read", async () => {
		const { db } = await import("@dokploy/server/db");
		const { dokployServerAddresses } = await import(
			"@dokploy/server/services/firewall"
		);
		// Behind a CDN: the domain resolves to the CDN, the server IP is the origin.
		const settings = {
			host: "dokploy.example.com",
			https: true,
			serverIp: "203.0.113.10",
		};
		const cache = globalThis as {
			__dokployFirewallAddresses?: { at: number; failed?: boolean };
		};
		const cached = () => cache.__dokployFirewallAddresses;
		const findFirst = vi.mocked(db.query.webServerSettings.findFirst);
		const both = ["104.16.1.1", "203.0.113.10"];
		cache.__dokployFirewallAddresses = undefined;
		findFirst
			.mockResolvedValueOnce(settings as never)
			.mockResolvedValueOnce(settings as never);
		await expect(dokployServerAddresses()).resolves.toEqual(both);
		const restarting = new Error("Connection terminated unexpectedly");
		// The read for the server IP fails, then the one for the domain.
		for (const failing of ["serverIp", "domain"]) {
			const entry = cached();
			if (!entry) throw new Error("not cached");
			entry.at -= 11 * 60_000;
			if (failing === "serverIp") {
				findFirst
					.mockRejectedValueOnce(restarting)
					.mockResolvedValueOnce(settings as never);
			} else {
				findFirst
					.mockResolvedValueOnce(settings as never)
					.mockRejectedValueOnce(restarting);
			}
			await expect(dokployServerAddresses(), failing).resolves.toEqual(both);
			// Tried again within a minute, not ten.
			expect(cached()?.failed, failing).toBe(true);
		}
	});
});

describe("firewall review, sixth pass", () => {
	it("loads the mixed IPv6 notation in the canonical form nftables accepts", () => {
		// RFC 4291 lets an IPv6 address end with an IPv4 one; nft 1.0.9 refuses
		// all of these but the last, so the Linux machines took no job.
		const addresses = [
			"64:ff9b::192.0.2.33",
			"64:ff9b::192.0.2.0/120",
			"2001:DB8::10.1.2.3",
			"::ffff:10.0.0.1",
		];
		expect(addresses.every(isAddress)).toBe(true);
		const compiled = compileFirewall(
			firewall([
				rule({ action: "deny", peer: { type: "addresses", addresses } }),
			]),
			{ dokployAddresses: [] },
		);
		const canonical =
			"64:ff9b::c000:221, 64:ff9b::c000:200/120, 2001:db8::a01:203, ::ffff:a00:1";
		expect(nftablesRuleset(compiled).text).toContain(
			`elements = { ${canonical} }`,
		);
		expect(pfRuleset(compiled).text).toContain(`{ ${canonical} }`);
		expect(canonicalAddress("10.0.0.0/8")).toBe("10.0.0.0/8");
	});

	describe("updates", () => {
		const stored = {
			firewallId: "fw",
			organizationId: "org",
			name: "CI egress",
			description: null,
			inboundPolicy: "deny",
			outboundPolicy: "deny",
			rules: [rule({ action: "deny", id: "deny-db" }), rule()],
			revision: 4,
		};
		const recordSets = async (returned: unknown[] | null = null) => {
			const { db } = await import("@dokploy/server/db");
			const original = vi.mocked(db.update).getMockImplementation();
			const sets: { values: Record<string, unknown>; where: unknown }[] = [];
			vi.mocked(db.update).mockImplementation(() => {
				const entry = {
					values: {} as Record<string, unknown>,
					where: null as unknown,
				};
				const query = {
					set: (values: Record<string, unknown>) => {
						entry.values = values;
						return query;
					},
					where: (where: unknown) => {
						entry.where = where;
						sets.push(entry);
						return query;
					},
					returning: async () => returned ?? [{ ...stored, ...entry.values }],
				};
				return query as never;
			});
			vi.mocked(db.query.firewalls.findFirst).mockResolvedValue(
				stored as never,
			);
			return {
				sets,
				restore: () => {
					vi.mocked(db.update).mockImplementation(original as never);
					vi.mocked(db.query.firewalls.findFirst).mockReset();
				},
			};
		};

		it("keeps what a partial update leaves out", async () => {
			const { updateFirewall } = await import(
				"@dokploy/server/services/firewall"
			);
			// A rename through the API or MCP, without the rules.
			const input = apiUpdateFirewall.parse({
				firewallId: "fw",
				name: "CI egress v2",
			});
			expect(input).toEqual({ firewallId: "fw", name: "CI egress v2" });
			const { sets, restore } = await recordSets();
			try {
				await updateFirewall(input, "org");
			} finally {
				restore();
			}
			expect(Object.keys(sets[0]?.values ?? {}).sort()).toEqual([
				"name",
				"revision",
				"updatedAt",
			]);
		});

		it("refuses a change made from an older revision", async () => {
			const { updateFirewall } = await import(
				"@dokploy/server/services/firewall"
			);
			const { sets, restore } = await recordSets([]);
			try {
				// The editor opened revision 3; someone saved revision 4 since.
				await expect(
					updateFirewall(
						apiUpdateFirewall.parse({
							firewallId: "fw",
							revision: 3,
							description: "Only GitHub",
						}),
						"org",
					),
				).rejects.toMatchObject({ code: "CONFLICT" });
				expect(sets).toHaveLength(0);
				// Same revision, but another save lands first: no row is updated.
				await expect(
					updateFirewall(
						apiUpdateFirewall.parse({
							firewallId: "fw",
							revision: 4,
							description: "Only GitHub",
						}),
						"org",
					),
				).rejects.toMatchObject({ code: "CONFLICT" });
			} finally {
				restore();
			}
		});
	});
});
