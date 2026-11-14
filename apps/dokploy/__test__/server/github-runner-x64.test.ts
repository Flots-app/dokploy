import {
	clearPoolRouting,
	needsVmRestart,
	x64Labels,
} from "@dokploy/server/utils/github-runners/controller";
import type { GithubRunner } from "@dokploy/server/utils/github-runners/github-api";
import {
	macCreateVmScript,
	macProbeScript,
	macResizeVmScript,
} from "@dokploy/server/utils/github-runners/macos";
import {
	type LocalSlot,
	parseMacStatus,
	parseRecords,
	parseRuntimeStatus,
} from "@dokploy/server/utils/github-runners/probe";
import {
	type PlannerNode,
	planNode,
	runnerNamePrefix,
} from "@dokploy/server/utils/github-runners/reconcile";
import { installRuntimeScript } from "@dokploy/server/utils/github-runners/runtime";
import { machineSetupScript } from "@dokploy/server/utils/github-runners/setup";
import {
	isX64Slot,
	nativeMaxRunners,
	x64Blocker,
	x64ReleaseDue,
	x64RunnerLabels,
	x64Slots,
} from "@dokploy/server/utils/github-runners/x64";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const NOW = Date.parse("2026-11-14T08:00:00Z");
const prefix = runnerNamePrefix("m4");
const nativeLabels = ["self-hosted", "Linux", "ARM64", "ci", "dokploy-m4"];
const labels64 = x64RunnerLabels({
	poolLabels: ["ci"],
	extraLabels: [],
	machineLabel: "dokploy-m4",
});

const plannerNode = (overrides: Partial<PlannerNode> = {}): PlannerNode => ({
	enabled: true,
	phase: "ready",
	drain: null,
	maxRunners: 2,
	namePrefix: prefix,
	labels: nativeLabels,
	runnerVersion: "2.330.0",
	admission: { ok: true },
	maxArmsPerTick: 4,
	x64: { slots: [32], labels: labels64, ready: true },
	...overrides,
});

const slot = (
	number: number,
	overrides: Partial<LocalSlot> = {},
): LocalSlot => ({
	slot: number,
	active: "active",
	since: NOW / 1000 - 600,
	runnerName: `${prefix}${number}-aaaaaa`,
	job: null,
	...overrides,
});

const ghRunner = (
	number: number,
	overrides: Partial<GithubRunner> = {},
): GithubRunner => ({
	id: 100 + number,
	name: `${prefix}${number}-aaaaaa`,
	os: "Linux",
	status: "online",
	busy: false,
	labels: number === 32 ? labels64 : nativeLabels,
	customLabels: (number === 32 ? labels64 : nativeLabels).slice(3),
	version: "2.330.0",
	...overrides,
});

describe("x86_64 slots and labels", () => {
	it("keeps the last slots, whatever the number of native ones", () => {
		expect(x64Slots(0)).toEqual([]);
		expect(x64Slots(2)).toEqual([32, 31]);
		// Never more than the cap.
		expect(x64Slots(10)).toHaveLength(4);
		expect(isX64Slot(31, 2)).toBe(true);
		expect(isX64Slot(31, 1)).toBe(false);
		expect(nativeMaxRunners(3, 1)).toBe(3);
		// An automatic budget of 32 runners leaves room for the x86_64 ones.
		expect(nativeMaxRunners(32, 2)).toBe(30);
	});

	it("suffixes every label a job could ask for, so no other job lands there", () => {
		expect(labels64).toEqual([
			"self-hosted",
			"Linux",
			"X64",
			"ci-x64",
			"dokploy-m4-x64",
		]);
		expect(
			x64Labels(
				{ labels: ["flots-dokploy"] } as never,
				{ name: "m4", extraLabels: ["big"] } as never,
			),
		).toEqual([
			"self-hosted",
			"Linux",
			"X64",
			"flots-dokploy-x64",
			"big-x64",
			"dokploy-m4-x64",
		]);
	});
});

describe("x64Blocker", () => {
	const ready = {
		x64Runners: 1,
		platform: "macos" as const,
		runtimeVersion: 13,
		minRuntime: 13,
		vmRosetta: true,
		hostRosetta: true,
		status: { rosetta: true, release: "2.330.0" },
	};

	it("lets the x86_64 slots run once everything is in place", () => {
		expect(x64Blocker(ready)).toBeNull();
		// A release behind the native one still runs jobs while the new one installs.
		expect(
			x64Blocker({ ...ready, status: { rosetta: true, release: "2.329.0" } }),
		).toBeNull();
		expect(
			x64Blocker({ ...ready, x64Runners: 0, vmRosetta: false }),
		).toBeNull();
	});

	it("tells what the x86_64 slots wait for, first thing first", () => {
		expect(x64Blocker({ ...ready, platform: "linux" })).toMatch(/Macs only/);
		expect(x64Blocker({ ...ready, hostRosetta: false })).toMatch(
			/run the setup script of the machine again/,
		);
		// A Mac that did not say is not trusted to have it.
		expect(x64Blocker({ ...ready, hostRosetta: null })).toMatch(
			/Rosetta is not installed on the Mac/,
		);
		expect(x64Blocker({ ...ready, vmRosetta: false })).toMatch(
			/restarts with Rosetta/,
		);
		expect(x64Blocker({ ...ready, runtimeVersion: 12, status: null })).toMatch(
			/runtime update/,
		);
		expect(
			x64Blocker({ ...ready, status: { rosetta: false, release: null } }),
		).toMatch(/not available in the VM/);
		expect(
			x64Blocker({ ...ready, status: { rosetta: true, release: null } }),
		).toMatch(/installing the x86_64 runner/);
		// An installation that failed says so, with why.
		expect(
			x64Blocker({
				...ready,
				status: { rosetta: true, release: null },
				installError: "apt-get update kept failing",
			}),
		).toBe(
			"the x86_64 runner could not be installed (apt-get update kept failing); Dokploy tries again every 10 minutes",
		);
		// An Intel Mac runs x86_64 natively: nothing to wait for.
		expect(x64Blocker({ ...ready, hostArch: "x86_64" })).toMatch(/Intel Mac/);
	});

	it("installs the x86_64 runner of the native release once Rosetta runs", () => {
		expect(x64ReleaseDue({ rosetta: true, release: null }, "2.330.0")).toBe(
			true,
		);
		expect(
			x64ReleaseDue({ rosetta: true, release: "2.329.0" }, "2.330.0"),
		).toBe(true);
		expect(
			x64ReleaseDue({ rosetta: true, release: "2.330.0" }, "2.330.0"),
		).toBe(false);
		expect(x64ReleaseDue({ rosetta: false, release: null }, "2.330.0")).toBe(
			false,
		);
		expect(x64ReleaseDue(null, "2.330.0")).toBe(false);
	});
});

describe("planNode with x86_64 slots", () => {
	it("arms the x86_64 slot whatever the placement, with its own flag", () => {
		const plan = planNode({
			now: NOW,
			// A faster machine has room: no native runner should wait here.
			node: plannerNode({ waiting: { arm: 0, keep: 0 } }),
			slots: [],
			runners: [],
		});
		expect(plan.actions).toEqual([{ type: "arm", slot: 32, x64: true }]);
	});

	it("never releases a waiting x86_64 runner for a faster machine", () => {
		const plan = planNode({
			now: NOW,
			node: plannerNode({ waiting: { arm: 0, keep: 0 } }),
			slots: [slot(1), slot(32)],
			runners: [ghRunner(1), ghRunner(32)],
		});
		expect(plan.actions).toEqual([
			{
				type: "release",
				slot: 1,
				runnerId: 101,
				reason: "a faster machine has room",
			},
		]);
		expect(plan.slots.find((item) => item.slot === 32)).toMatchObject({
			arch: "x64",
			state: "idle",
		});
		expect(plan.slots.find((item) => item.slot === 1)?.arch).toBeUndefined();
	});

	it("arms nothing and lets an idle x86_64 runner go while they are not ready", () => {
		const plan = planNode({
			now: NOW,
			node: plannerNode({
				x64: { slots: [32], labels: labels64, ready: false },
			}),
			slots: [slot(1), slot(2), slot(32)],
			runners: [ghRunner(1), ghRunner(2), ghRunner(32)],
		});
		expect(plan.actions).toEqual([
			{
				type: "release",
				slot: 32,
				runnerId: 132,
				reason: "x86_64 runners not available",
			},
		]);
	});

	it("keeps a running x86_64 job and recycles a runner with native labels there", () => {
		const busy = planNode({
			now: NOW,
			node: plannerNode({
				x64: { slots: [32], labels: labels64, ready: false },
			}),
			slots: [slot(1), slot(2), slot(32)],
			runners: [ghRunner(1), ghRunner(2), ghRunner(32, { busy: true })],
		});
		expect(busy.actions).toEqual([]);
		expect(busy.busy).toBe(1);
		// A native runner left in the x86_64 slot (labels changed): recycled.
		const stale = planNode({
			now: NOW,
			node: plannerNode(),
			slots: [slot(1), slot(2), slot(32)],
			runners: [
				ghRunner(1),
				ghRunner(2),
				ghRunner(32, {
					labels: nativeLabels,
					customLabels: nativeLabels.slice(3),
				}),
			],
		});
		expect(stale.actions).toEqual([
			{
				type: "release",
				slot: 32,
				runnerId: 132,
				reason: "runner settings changed",
			},
		]);
	});

	it("keeps an x86_64 runner of its own release while a newer native one installs", () => {
		const plan = planNode({
			now: NOW,
			node: plannerNode({
				runnerVersion: "2.331.0",
				x64: {
					slots: [32],
					labels: labels64,
					runnerVersion: "2.330.0",
					ready: true,
				},
			}),
			slots: [slot(1), slot(2), slot(32)],
			runners: [
				ghRunner(1, { version: "2.331.0" }),
				ghRunner(2, { version: "2.331.0" }),
				ghRunner(32),
			],
		});
		expect(plan.actions).toEqual([]);
	});

	it("leaves a machine without x86_64 runners as it was", () => {
		const plan = planNode({
			now: NOW,
			node: plannerNode({ x64: undefined }),
			slots: [],
			runners: [],
		});
		expect(plan.actions).toEqual([
			{ type: "arm", slot: 1 },
			{ type: "arm", slot: 2 },
		]);
	});
});

describe("Rosetta on the Mac and in the VM", () => {
	it("creates and restarts the VM with Rosetta only when asked", () => {
		expect(
			macCreateVmScript("dokploy-runners", {
				cpus: 4,
				memoryGiB: "8",
				diskGb: 60,
				rosetta: true,
			}),
		).toContain("--vm-type=vz --rosetta");
		expect(
			macCreateVmScript("dokploy-runners", {
				cpus: 4,
				memoryGiB: "8",
				diskGb: 60,
			}),
		).not.toContain("--rosetta");
		const resize = (rosetta: boolean | null) =>
			macResizeVmScript("dokploy-runners", {
				cpus: 4,
				memoryGiB: "8",
				diskGb: null,
				rosetta,
			});
		expect(resize(true)).toMatch(/--memory='8' --rosetta\n/);
		expect(resize(false)).toMatch(/--rosetta=false\n/);
		expect(resize(null)).not.toContain("rosetta");
	});

	it("reads whether the Mac has Rosetta, and what the VM runs", () => {
		expect(macProbeScript("dokploy-runners", true)).toContain(
			"[ -e /Library/Apple/usr/libexec/oah/RosettaLinux ]",
		);
		const mac = (rosetta: string) =>
			parseMacStatus(
				[
					"mac cpus=10 memory_bytes=17179869184 arch=arm64 version=27.2 load=1",
					`macsetup admin=no sleep=0 filevault=off daemon=yes${rosetta}`,
				].join("\n"),
			).setup?.rosetta;
		expect(mac(" rosetta=yes")).toBe(true);
		expect(mac(" rosetta=no")).toBe(false);
		// A Mac probed by an older Dokploy did not say.
		expect(mac("")).toBeNull();
		const status = (line: string) =>
			parseRuntimeStatus(parseRecords(`runtime version=13\n${line}`)).x64;
		expect(status("rosetta enabled=yes release=2.330.0")).toEqual({
			rosetta: true,
			release: "2.330.0",
		});
		expect(status("rosetta enabled=no release=")).toEqual({
			rosetta: false,
			release: null,
		});
		expect(status("")).toBeNull();
	});

	it("installs Rosetta with the Mac setup script, never on Linux", () => {
		const script = (platform: "macos" | "linux") =>
			machineSetupScript({
				platform,
				machine: "m4",
				publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL7 test",
				keepAwake: true,
			});
		expect(script("macos")).toContain(
			"softwareupdate --install-rosetta --agree-to-license",
		);
		expect(script("linux")).not.toContain("rosetta");
	});

	it("restarts the VM of a Mac that gets x86_64 runners, once it has Rosetta", () => {
		const host = { cpus: 10, memoryBytes: 16 * 1024 ** 3, rosetta: true };
		const applied = {
			runtimeVersion: 13,
			runnerVersion: "2.330.0",
			cpuPercent: 70,
			memoryPercent: 60,
			vmDiskGb: 60,
			cpus: 7,
			memoryBytes: 9.5 * 1024 ** 3,
			envHash: "",
		};
		const node = (x64Runners: number, rosetta?: boolean) =>
			({
				platform: "macos",
				cpuPercent: 70,
				memoryPercent: 60,
				vmDiskGb: 60,
				x64Runners,
				applied: { ...applied, rosetta },
			}) as never;
		expect(needsVmRestart(node(0), host)).toBe(false);
		expect(needsVmRestart(node(1), host)).toBe(true);
		expect(needsVmRestart(node(1, true), host)).toBe(false);
		// Turning them off leaves Rosetta in place: no restart for that.
		expect(needsVmRestart(node(0, true), host)).toBe(false);
		// A restart would not give the VM a Rosetta the Mac lacks.
		expect(needsVmRestart(node(1), { ...host, rosetta: false })).toBe(false);
		expect(needsVmRestart(node(1), { ...host, rosetta: undefined })).toBe(
			false,
		);
	});
});

describe("Rosetta in a plain VM (runtime v14)", () => {
	const install = installRuntimeScript();

	it("mounts the VM's Rosetta share and registers Lima's own binfmt entry", () => {
		// Lima skips both in a plain VM; this is its entry, byte for byte
		// (lima-vm/lima v2.2.1, pkg/driver/vz/boot.Linux/05-rosetta-volume.sh).
		const lima = String.raw`:rosetta:M::\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x3e\x00:\xff\xff\xff\xff\xff\xfe\xfe\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfe\xff\xff\xff:/mnt/lima-rosetta/rosetta:OCF`;
		expect(install).toContain(`ROSETTA_BINFMT='${lima}'`);
		expect(install).toContain(
			'mount -t virtiofs -o ro vz-rosetta "$ROSETTA_MOUNT"',
		);
		expect(install).toContain("rosetta) cmd_rosetta ;;");
	});

	it("does it at every boot, and before any x86_64 work", () => {
		expect(install).toContain(
			"write_file /etc/systemd/system/dokploy-rosetta.service 0644",
		);
		expect(install).toContain(
			"ExecStart=/opt/dokploy-runners/bin/runnerctl rosetta",
		);
		expect(install).toContain("systemctl enable dokploy-rosetta.service");
		// x64_prepare and an x86_64 arm both try before they give up.
		expect(
			install.match(/cmd_rosetta >\/dev\/null\n\s+rosetta_ready \|\| die/g),
		).toHaveLength(2);
	});
});

describe("runtime v13", () => {
	const install = installRuntimeScript();

	it("arms an x86_64 slot with its own release and Docker platform", () => {
		expect(install).toContain(
			'arm) cmd_arm "${2:-}" "${3:-0}" "${4:-native}" ;;',
		);
		expect(install).toContain(
			"printf 'DOCKER_DEFAULT_PLATFORM=linux/amd64\\n' >\"$ETC/slot-$slot.env\"",
		);
		expect(install).toContain(
			"EnvironmentFile=-/etc/dokploy-runners/slot-%i.env",
		);
		expect(install).toContain('x64) echo "$ROOT/releases-x64" ;;');
	});

	it("installs the amd64 libraries from the main archive, never from ports", () => {
		expect(install).toContain("URIs: http://archive.ubuntu.com/ubuntu");
		expect(install).toContain("Architectures: amd64");
		expect(install).toContain(
			'grep -q \'^Architectures:\' "$file" || sed -i "/^Types:/a Architectures: $native" "$file"',
		);
		// The runner's own installer only knows the native packages.
		expect(install).toContain(
			'if [ "$arch" = native ] && [ -x "$tmp/runner/bin/installdependencies.sh" ]; then',
		);
	});
});

describe("deleting a pool", () => {
	const fetched: string[] = [];
	const routing = (variable: string) => ({
		variable,
		target: "pool" as const,
		value: "[]",
		since: "2026-11-14T08:00:00.000Z",
		unavailableSince: null,
		syncedValue: "[]",
		syncedAt: "2026-11-14T08:00:00.000Z",
		attemptedAt: "2026-11-14T08:00:00.000Z",
		error: null,
	});
	beforeAll(() =>
		vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
			fetched.push(`${init?.method ?? "GET"} ${url}`);
			return url.endsWith("_X64")
				? new Response(JSON.stringify({ message: "Forbidden" }), {
						status: 403,
					})
				: new Response(null, { status: 204 });
		}),
	);
	afterAll(() => vi.unstubAllGlobals());

	it("deletes the variable of the x86_64 jobs too, and says when it cannot", async () => {
		const warning = await clearPoolRouting({
			githubRunnerPoolId: "pool-x64-delete",
			name: "Lab",
			scope: "organization",
			owner: "Flots-app",
			repository: null,
			runnerGroup: "Default",
			apiUrl: "https://api.github.com",
			authType: "token",
			token: "t",
			labels: ["ci"],
			fallbackLabels: ["ubuntu-24.04"],
			x64FallbackLabels: ["ubuntu-24.04"],
			routingVariable: "DOKPLOY_RUNS_ON",
			routing: routing("DOKPLOY_RUNS_ON"),
			x64Routing: routing("DOKPLOY_RUNS_ON_X64"),
		} as never);
		expect([...fetched].sort()).toEqual([
			"DELETE https://api.github.com/orgs/Flots-app/actions/variables/DOKPLOY_RUNS_ON",
			"DELETE https://api.github.com/orgs/Flots-app/actions/variables/DOKPLOY_RUNS_ON_X64",
		]);
		expect(warning).toMatch(
			/^The Actions variable DOKPLOY_RUNS_ON_X64 could not be deleted .*delete it on GitHub/,
		);
	});
});
