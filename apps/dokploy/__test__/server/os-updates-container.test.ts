/**
 * The OS update scripts run for real, in a throwaway Ubuntu 24.04 container
 * booted with systemd (the steps run in transient units): apt, dpkg, the
 * pins, the recovery of an interrupted dpkg and the reboot unit. Opt-in, as
 * it pulls an image and packages from the Internet:
 *
 *   DOKPLOY_OS_UPDATES_CONTAINER=1 pnpm vitest run --config __test__/vitest.config.ts os-updates-container
 *
 * It creates one image (committed from a container, so no build cache stays
 * behind) and one container, both removed at the end, and never prunes
 * anything.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	parseSimulation,
	type SimulatedPackage,
} from "@dokploy/server/utils/os-updates/apt";
import {
	DEFAULT_OS_UPDATE_SETTINGS,
	selectPackages,
} from "@dokploy/server/utils/os-updates/filters";
import {
	assessScript,
	followStepScript,
	installStep,
	parseAssessment,
	parseFollow,
	parseInstallResult,
	prepareStep,
	type RunStep,
	rebootScript,
	startStepScript,
	stepExitCode,
	stepUnit,
} from "@dokploy/server/utils/os-updates/scripts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = (() => {
	if (process.env.DOKPLOY_OS_UPDATES_CONTAINER !== "1") return false;
	try {
		execFileSync("docker", ["info"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

const suffix = randomUUID().slice(0, 8);
const IMAGE = `dokploy-os-updates-test:${suffix}`;
const CONTAINER = `dokploy-os-updates-test-${suffix}`;

/** systemd in Ubuntu 24.04. Committed, not built: no build cache stays behind. */
const SYSTEMD_SETUP =
	"apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends systemd systemd-sysv dbus >/dev/null && rm -rf /var/lib/apt/lists/*";

/** Runs a script as root in the container, as the controller does over SSH. */
const root = (script: string) => {
	const result = spawnSync("docker", ["exec", "-i", CONTAINER, "bash", "-s"], {
		input: script,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		status: result.status,
	};
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts a step in its unit, then follows it to its end, as runStep does. */
const runStep = async (runId: string, step: RunStep, script: string) => {
	const started = root(startStepScript(runId, step, script));
	expect(started.status, started.stderr).toBe(0);
	expect(started.stdout).toContain("started");
	let offset = 0;
	let log = "";
	const giveUp = Date.now() + 8 * 60_000;
	for (;;) {
		const follow = parseFollow(
			root(followStepScript(runId, step, offset)).stdout,
		);
		expect(follow).not.toBeNull();
		if (!follow) throw new Error("unreadable follow output");
		log += follow.log;
		offset += Buffer.byteLength(follow.log);
		if (follow.done && offset >= follow.size)
			return { result: follow.result, log };
		if (!follow.done && !follow.unitActive) {
			// One more look: the unit may end between the two reads.
			await sleep(1000);
			const again = parseFollow(
				root(followStepScript(runId, step, offset)).stdout,
			);
			if (!again?.done) throw new Error(`the ${step} unit died:\n${log}`);
			continue;
		}
		if (Date.now() > giveUp) throw new Error(`the ${step} step hangs:\n${log}`);
		await sleep(1000);
	}
};

const pending = (packages: SimulatedPackage[]) =>
	packages.filter((item) => item.from !== null).map((item) => item.name);

describe.skipIf(!enabled)("OS updates on a real Ubuntu 24.04", () => {
	beforeAll(() => {
		const setup = `${CONTAINER}-setup`;
		try {
			execFileSync(
				"docker",
				["run", "--name", setup, "ubuntu:24.04", "bash", "-c", SYSTEMD_SETUP],
				{ stdio: ["ignore", "ignore", "inherit"] },
			);
			execFileSync("docker", ["commit", setup, IMAGE], { stdio: "ignore" });
		} finally {
			spawnSync("docker", ["rm", "-f", setup], { stdio: "ignore" });
		}
		execFileSync("docker", [
			"run",
			"-d",
			"--name",
			CONTAINER,
			"--privileged",
			"--cgroupns=host",
			"-v",
			"/sys/fs/cgroup:/sys/fs/cgroup:rw",
			"--tmpfs",
			"/run",
			"--tmpfs",
			"/run/lock",
			IMAGE,
			"/sbin/init",
		]);
		for (let attempt = 0; attempt < 60; attempt++) {
			const state = root(
				"systemctl is-system-running 2>/dev/null || true",
			).stdout.trim();
			if (state === "running" || state === "degraded") return;
			execFileSync("sleep", ["1"]);
		}
		throw new Error("systemd did not start in the container");
	}, 10 * 60_000);

	afterAll(() => {
		spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
		spawnSync("docker", ["rmi", "-f", IMAGE], { stdio: "ignore" });
	});

	it(
		"prepares the server: finishes an interrupted dpkg, then assesses it",
		async () => {
			// Pending updates on purpose: openssl at its release version (a
			// security update waits), tzdata too (any pocket), then a package
			// unpacked and never configured, as a dpkg killed halfway leaves it.
			const setup = root(`set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
release() { apt-cache madison "$1" | awk -F'|' '$3 ~ / noble\\/main / { gsub(/ /, "", $2); print $2; exit }'; }
apt-get install -y -qq --allow-downgrades "openssl=$(release openssl)" "libssl3t64=$(release libssl3t64)" "tzdata=$(release tzdata)" >/dev/null
cd /tmp && apt-get download -qq hello && dpkg --unpack /tmp/hello_*.deb >/dev/null
dpkg --audit
`);
			expect(setup.status, setup.stderr).toBe(0);
			expect(setup.stdout).toContain("hello");

			const before = parseAssessment(
				root(assessScript({ refresh: false })).stdout,
			);
			expect(before?.supported).toBe(true);
			expect(before?.os).toMatchObject({ id: "ubuntu", version: "24.04" });
			expect(before?.dpkgInterrupted).toBe(true);

			const { result, log } = await runStep(
				"run1",
				"prepare",
				prepareStep("run1"),
			);
			expect(stepExitCode(result), log).toBe(0);
			expect(log).toContain("Finishing an interrupted dpkg run");
			const assessment = parseAssessment(result);
			expect(assessment?.dpkgInterrupted).toBe(false);
			expect(assessment?.listsRefreshed).toBe(true);
			expect(assessment?.simulationError).toBeNull();
			const names = pending(assessment?.packages ?? []);
			expect(names).toEqual(
				expect.arrayContaining(["openssl", "libssl3t64", "tzdata"]),
			);
			expect(
				assessment?.packages.find((item) => item.name === "openssl")?.security,
			).toBe(true);
			// The unit is gone once it ended (--collect).
			expect(
				root(
					`systemctl is-active ${stepUnit("run1", "prepare")} || true`,
				).stdout.trim(),
			).not.toBe("active");
		},
		10 * 60_000,
	);

	it(
		"installs the selected updates only, the others held at their version",
		async () => {
			const assessment = parseAssessment(
				root(assessScript({ refresh: false })).stdout,
			);
			const selection = selectPackages(assessment?.packages ?? [], {
				...DEFAULT_OS_UPDATE_SETTINGS,
				classification: "all",
				includePackages: ["openssl", "libssl*"],
			});
			const allowed = selection.selected.map((item) => item.name);
			expect(allowed).toEqual(
				expect.arrayContaining(["openssl", "libssl3t64"]),
			);
			expect(allowed).not.toContain("tzdata");

			const { result, log } = await runStep(
				"run2",
				"install",
				installStep({
					runId: "run2",
					allowed,
					deadline: Math.floor(Date.now() / 1000) + 3600,
				}),
			);
			const installed = parseInstallResult(result);
			expect(installed?.exitCode, log).toBe(0);
			expect(installed?.status).toBe("installed");
			const changed = installed?.changes.map((item) => item.name.split(":")[0]);
			expect(changed).toEqual(
				expect.arrayContaining(["openssl", "libssl3t64"]),
			);
			// Nothing else moved: tzdata and every other pending update are held.
			expect(changed?.every((name) => name && allowed.includes(name))).toBe(
				true,
			);
			expect(log).toMatch(/held at their version/);

			const after = parseSimulation(
				root("apt-get -s -o Debug::NoLocking=1 --with-new-pkgs upgrade").stdout,
			);
			expect(pending(after.packages)).toContain("tzdata");
			expect(pending(after.packages)).not.toContain("openssl");
			// The pins lived in the run's own preferences file only.
			expect(
				root(
					"ls /etc/apt/preferences.d/ && cat /etc/apt/preferences 2>/dev/null || true",
				).stdout.trim(),
			).toBe("");
		},
		10 * 60_000,
	);

	it(
		"installs nothing once the window closed",
		async () => {
			const { result } = await runStep(
				"run3",
				"install",
				installStep({
					runId: "run3",
					allowed: ["tzdata"],
					deadline: Math.floor(Date.now() / 1000) - 60,
				}),
			);
			const installed = parseInstallResult(result);
			expect(installed).toMatchObject({
				status: "window-closed",
				exitCode: 0,
				changes: [],
			});
			const still = parseSimulation(
				root("apt-get -s -o Debug::NoLocking=1 --with-new-pkgs upgrade").stdout,
			);
			expect(pending(still.packages)).toContain("tzdata");
		},
		5 * 60_000,
	);

	it(
		"does not restart a step that still runs when asked again",
		async () => {
			const script =
				"#!/bin/bash\nexec 3>/var/lib/dokploy-os-updates/run4/prepare.part\nsleep 5\necho 'exit code=0' >&3\nmv /var/lib/dokploy-os-updates/run4/prepare.part /var/lib/dokploy-os-updates/run4/prepare.result\n";
			expect(root(startStepScript("run4", "prepare", script)).status).toBe(0);
			// A lost answer makes the controller ask again: the step runs on.
			const again = root(
				startStepScript("run4", "prepare", "#!/bin/bash\nexit 7\n"),
			);
			expect(again.status).toBe(0);
			for (let attempt = 0; attempt < 30; attempt++) {
				const follow = parseFollow(
					root(followStepScript("run4", "prepare", 0)).stdout,
				);
				if (follow?.done) {
					expect(stepExitCode(follow.result)).toBe(0);
					return;
				}
				await sleep(1000);
			}
			throw new Error("the step never ended");
		},
		2 * 60_000,
	);

	it(
		"reboots through a transient unit",
		async () => {
			const reboot = root(rebootScript("run5"));
			expect(reboot.status, reboot.stderr).toBe(0);
			expect(
				root(
					"systemctl list-units --all --plain --no-legend 'dokploy-os-update-reboot-run5*'",
				).stdout,
			).toContain("dokploy-os-update-reboot-run5");
			// systemd reboots the container: its init ends, the container stops.
			for (let attempt = 0; attempt < 60; attempt++) {
				const running = execFileSync("docker", [
					"inspect",
					"-f",
					"{{.State.Running}}",
					CONTAINER,
				])
					.toString()
					.trim();
				if (running === "false") return;
				await sleep(1000);
			}
			throw new Error("the container did not reboot");
		},
		2 * 60_000,
	);
});
