import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	linuxOsReportScript,
	osPatchScript,
} from "@dokploy/server/utils/github-runners/os";
import {
	isSecurityOrigin,
	parseSimulation,
} from "@dokploy/server/utils/os-updates/apt";
import {
	logLines,
	redactLogLine,
} from "@dokploy/server/utils/os-updates/controller";
import {
	DEFAULT_OS_UPDATE_SETTINGS,
	isDockerPackage,
	matchesPattern,
	type OsUpdateSettings,
	osUpdateSettingsSchema,
	selectPackages,
} from "@dokploy/server/utils/os-updates/filters";
import {
	describeSchedule,
	nextWindow,
	type OsUpdateSchedule,
	openWindow,
	osUpdateScheduleSchema,
	previousWindow,
	zonedTime,
} from "@dokploy/server/utils/os-updates/schedule";
import {
	assertRunId,
	assessScript,
	cleanupRunScript,
	dockerStatusScript,
	followStepScript,
	installStep,
	isSupportedOs,
	parseAssessment,
	parseFollow,
	parseInstallResult,
	parseSwarm,
	parseSwarmManagers,
	prepareStep,
	rebootScript,
	startStepScript,
	stepExitCode,
	swarmRebootCheck,
} from "@dokploy/server/utils/os-updates/scripts";
import { describe, expect, it } from "vitest";

const schedule = (patch: Partial<OsUpdateSchedule> = {}): OsUpdateSchedule =>
	osUpdateScheduleSchema.parse({
		recurrence: "daily",
		startTime: "02:00",
		timeZone: "Europe/Paris",
		durationMinutes: 180,
		...patch,
	});

const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;

describe("maintenance windows", () => {
	it("opens a daily window in its time zone, for its duration", () => {
		const daily = schedule();
		// 02:00 in Paris is 01:00 UTC in winter (CET, UTC+1).
		const window = openWindow(daily, new Date("2026-11-10T02:30:00Z"));
		expect(iso(window?.start)).toBe("2026-11-10T01:00:00.000Z");
		expect(iso(window?.end)).toBe("2026-11-10T04:00:00.000Z");
		expect(openWindow(daily, new Date("2026-11-10T04:00:00Z"))).toBeNull();
		expect(openWindow(daily, new Date("2026-11-10T00:59:59Z"))).toBeNull();
		expect(
			iso(nextWindow(daily, new Date("2026-11-10T02:30:00Z"))?.start),
		).toBe("2026-11-11T01:00:00.000Z");
		expect(
			iso(previousWindow(daily, new Date("2026-11-10T02:30:00Z"))?.start),
		).toBe("2026-11-09T01:00:00.000Z");
		// In summer Paris is UTC+2.
		expect(
			iso(openWindow(daily, new Date("2026-07-01T00:30:00Z"))?.start),
		).toBe("2026-07-01T00:00:00.000Z");
	});

	it("runs past midnight, the window belonging to the day it starts", () => {
		const night = schedule({
			recurrence: "weekly",
			weekdays: [5],
			startTime: "23:00",
			durationMinutes: 240,
			timeZone: "UTC",
		});
		// Friday 2026-11-13 23:00 to Saturday 03:00.
		expect(
			iso(openWindow(night, new Date("2026-11-14T02:00:00Z"))?.start),
		).toBe("2026-11-13T23:00:00.000Z");
		expect(openWindow(night, new Date("2026-11-14T23:30:00Z"))).toBeNull();
		expect(
			iso(nextWindow(night, new Date("2026-11-14T02:00:00Z"))?.start),
		).toBe("2026-11-20T23:00:00.000Z");
	});

	it("keeps only the chosen weekdays", () => {
		const weekdays = schedule({ recurrence: "weekly", weekdays: [1, 3] });
		// Monday 2026-11-09 and Wednesday 2026-11-11.
		expect(
			iso(nextWindow(weekdays, new Date("2026-11-08T12:00:00Z"))?.start),
		).toBe("2026-11-09T01:00:00.000Z");
		expect(
			iso(nextWindow(weekdays, new Date("2026-11-09T12:00:00Z"))?.start),
		).toBe("2026-11-11T01:00:00.000Z");
		expect(openWindow(weekdays, new Date("2026-11-10T02:00:00Z"))).toBeNull();
	});

	it("moves a start time skipped by the clocks forward by the jump", () => {
		// Paris skips 02:00-03:00 on 2027-03-28: 02:30 becomes 03:30 CEST.
		const window = openWindow(
			schedule({ startTime: "02:30", durationMinutes: 120 }),
			new Date("2027-03-28T02:00:00Z"),
		);
		expect(iso(window?.start)).toBe("2027-03-28T01:30:00.000Z");
		// The duration is elapsed time.
		expect(iso(window?.end)).toBe("2027-03-28T03:30:00.000Z");
		expect(
			zonedTime(
				{ year: 2027, month: 3, day: 14 },
				2 * 60 + 30,
				"America/New_York",
			),
		).toBe(Date.parse("2027-03-14T07:30:00Z"));
	});

	it("takes the first of a start time the clocks repeat", () => {
		// Paris goes back at 03:00 CEST on 2026-10-25: 02:30 happens twice.
		const window = nextWindow(
			schedule({ startTime: "02:30", durationMinutes: 60 }),
			new Date("2026-10-24T12:00:00Z"),
		);
		expect(iso(window?.start)).toBe("2026-10-25T00:30:00.000Z");
		expect(iso(window?.end)).toBe("2026-10-25T01:30:00.000Z");
		// New York repeats 01:00-02:00 on 2026-11-01: 01:30 EDT first.
		expect(
			zonedTime({ year: 2026, month: 11, day: 1 }, 90, "America/New_York"),
		).toBe(Date.parse("2026-11-01T05:30:00Z"));
	});

	it("handles zones a half hour off UTC and across the date line", () => {
		const kolkata = schedule({ timeZone: "Asia/Kolkata", startTime: "01:00" });
		expect(
			iso(nextWindow(kolkata, new Date("2026-11-10T00:00:00Z"))?.start),
		).toBe("2026-11-10T19:30:00.000Z");
		const auckland = schedule({ timeZone: "Pacific/Auckland" });
		// NZDT (UTC+13) in November: 02:00 on the 11th is 13:00 UTC on the 10th.
		expect(
			iso(nextWindow(auckland, new Date("2026-11-10T00:00:00Z"))?.start),
		).toBe("2026-11-10T13:00:00.000Z");
	});

	it("skips months without the day, and finds the last day", () => {
		const day31 = schedule({
			recurrence: "monthly",
			monthlyMode: "day",
			monthDay: 31,
			timeZone: "UTC",
		});
		// No 31st in November 2026: the next is December 31st.
		expect(
			iso(nextWindow(day31, new Date("2026-11-01T00:00:00Z"))?.start),
		).toBe("2026-12-31T02:00:00.000Z");
		// After January 31st, March 31st (February has none).
		expect(
			iso(nextWindow(day31, new Date("2027-02-01T00:00:00Z"))?.start),
		).toBe("2027-03-31T02:00:00.000Z");
		const last = schedule({
			recurrence: "monthly",
			monthlyMode: "day",
			monthDay: -1,
			timeZone: "UTC",
		});
		expect(iso(nextWindow(last, new Date("2027-02-01T00:00:00Z"))?.start)).toBe(
			"2027-02-28T02:00:00.000Z",
		);
		expect(iso(nextWindow(last, new Date("2028-02-01T00:00:00Z"))?.start)).toBe(
			"2028-02-29T02:00:00.000Z",
		);
		const day29 = schedule({
			recurrence: "monthly",
			monthlyMode: "day",
			monthDay: 29,
			timeZone: "UTC",
		});
		expect(
			iso(nextWindow(day29, new Date("2027-01-30T00:00:00Z"))?.start),
		).toBe("2027-03-29T02:00:00.000Z");
	});

	it("finds the nth and the last weekday of a month", () => {
		const secondTuesday = schedule({
			recurrence: "monthly",
			monthlyMode: "weekday",
			monthWeek: 2,
			monthWeekday: 2,
			timeZone: "UTC",
		});
		expect(
			iso(nextWindow(secondTuesday, new Date("2026-11-01T00:00:00Z"))?.start),
		).toBe("2026-11-10T02:00:00.000Z");
		expect(
			iso(nextWindow(secondTuesday, new Date("2026-11-11T00:00:00Z"))?.start),
		).toBe("2026-12-08T02:00:00.000Z");
		const lastSunday = schedule({
			recurrence: "monthly",
			monthlyMode: "weekday",
			monthWeek: -1,
			monthWeekday: 0,
			timeZone: "UTC",
		});
		expect(
			iso(nextWindow(lastSunday, new Date("2026-10-01T00:00:00Z"))?.start),
		).toBe("2026-10-25T02:00:00.000Z");
		expect(
			iso(nextWindow(lastSunday, new Date("2026-11-01T00:00:00Z"))?.start),
		).toBe("2026-11-29T02:00:00.000Z");
	});

	it("finds the previous window of a monthly schedule", () => {
		const first = schedule({
			recurrence: "monthly",
			monthlyMode: "day",
			monthDay: 1,
			timeZone: "UTC",
		});
		expect(
			iso(previousWindow(first, new Date("2026-11-20T00:00:00Z"))?.start),
		).toBe("2026-11-01T02:00:00.000Z");
		// Still open: the one before.
		expect(
			iso(previousWindow(first, new Date("2026-11-01T03:00:00Z"))?.start),
		).toBe("2026-10-01T02:00:00.000Z");
	});

	it("validates schedules", () => {
		const base = {
			recurrence: "daily",
			startTime: "02:00",
			timeZone: "UTC",
			durationMinutes: 120,
		};
		expect(osUpdateScheduleSchema.safeParse(base).success).toBe(true);
		for (const patch of [
			{ recurrence: "weekly", weekdays: [] },
			{ durationMinutes: 30 },
			{ durationMinutes: 13 * 60 },
			{ startTime: "24:00" },
			{ startTime: "2:00" },
			{ timeZone: "Mars/Olympus" },
			{ recurrence: "monthly", monthDay: 0 },
			{ recurrence: "monthly", monthlyMode: "weekday", monthWeek: 5 },
			{ recurrence: "weekly", weekdays: [1, 1] },
		]) {
			expect(
				osUpdateScheduleSchema.safeParse({ ...base, ...patch }).success,
				JSON.stringify(patch),
			).toBe(false);
		}
	});

	it("describes a schedule", () => {
		expect(describeSchedule(schedule())).toBe(
			"Every day at 02:00 for 3 h (Europe/Paris)",
		);
		expect(
			describeSchedule(
				schedule({
					recurrence: "weekly",
					weekdays: [3, 1],
					durationMinutes: 90,
				}),
			),
		).toBe("Every Mon, Wed at 02:00 for 1 h 30 min (Europe/Paris)");
		expect(
			describeSchedule(
				schedule({
					recurrence: "monthly",
					monthlyMode: "weekday",
					monthWeek: 2,
					monthWeekday: 2,
				}),
			),
		).toBe("On the second Tue of the month at 02:00 for 3 h (Europe/Paris)");
		expect(
			describeSchedule(
				schedule({ recurrence: "monthly", monthlyMode: "day", monthDay: -1 }),
			),
		).toBe("On the last day of the month at 02:00 for 3 h (Europe/Paris)");
	});
});

// ------------------------------------------------------------- apt output

const UBUNTU_SIMULATION = `NOTE: This is only a simulation!
Reading package lists...
Building dependency tree...
Reading state information...
Calculating upgrade...
The following packages have been kept back:
  libnss-systemd systemd
  udev
The following packages will be upgraded:
  libssl3t64 openssl tzdata
Inst libssl3t64 [3.0.13-0ubuntu3.1] (3.0.13-0ubuntu3.4 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])
Inst openssl [3.0.13-0ubuntu3.1] (3.0.13-0ubuntu3.4 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64]) []
Inst tzdata [2024a-3ubuntu1.1] (2025b-0ubuntu0.24.04 Ubuntu:24.04/noble-updates [all])
Inst docker-ce [5:27.3.1-1~ubuntu.24.04~noble] (5:27.4.0-1~ubuntu.24.04~noble Docker CE:noble [amd64])
Inst linux-image-6.8.0-50-generic (6.8.0-50.51 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])
Inst linux-image-generic [6.8.0-45.45] (6.8.0-50.50 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])
Inst libc6:i386 [2.39-0ubuntu8.3] (2.39-0ubuntu8.4 Ubuntu:24.04/noble-updates [i386])
Inst evil;rm [1] (2 Somewhere [all])
Conf libssl3t64 (3.0.13-0ubuntu3.4 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])
`;

const DEBIAN_SIMULATION = `Inst libc6 [2.36-9+deb12u7] (2.36-9+deb12u8 Debian:12.7/stable, Debian-Security:12/stable-security [amd64])
Inst curl [7.88.1-10+deb12u7] (7.88.1-10+deb12u8 Debian:12.7/stable [amd64])
`;

describe("apt simulation", () => {
	it("reads the packages an upgrade would install, and those kept back", () => {
		const { packages, keptBack } = parseSimulation(UBUNTU_SIMULATION);
		expect(keptBack).toEqual(["libnss-systemd", "systemd", "udev"]);
		expect(packages.map((item) => item.name)).toEqual([
			"libssl3t64",
			"openssl",
			"tzdata",
			"docker-ce",
			"linux-image-6.8.0-50-generic",
			"linux-image-generic",
			"libc6:i386",
		]);
		expect(packages[0]).toEqual({
			name: "libssl3t64",
			arch: "amd64",
			from: "3.0.13-0ubuntu3.1",
			to: "3.0.13-0ubuntu3.4",
			origins: "Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security",
			security: true,
		});
		expect(packages[2]?.security).toBe(false);
		// Epochs and tildes are part of a version.
		expect(packages[3]?.from).toBe("5:27.3.1-1~ubuntu.24.04~noble");
		// A package installed anew has no installed version.
		expect(packages[4]?.from).toBeNull();
	});

	it("tells Debian's security pocket apart", () => {
		const { packages } = parseSimulation(DEBIAN_SIMULATION);
		expect(packages.map((item) => [item.name, item.security])).toEqual([
			["libc6", true],
			["curl", false],
		]);
		expect(isSecurityOrigin("Debian-Security:12/stable-security")).toBe(true);
		expect(isSecurityOrigin("Ubuntu:24.04/noble-updates")).toBe(false);
	});
});

// ------------------------------------------------------------- filters

describe("package filters", () => {
	const { packages } = parseSimulation(UBUNTU_SIMULATION);
	const names = (settings: Partial<OsUpdateSettings>) =>
		selectPackages(packages, { ...DEFAULT_OS_UPDATE_SETTINGS, ...settings })
			.selected.map((item) => item.name)
			.sort();

	it("installs security updates only by default, and never Docker", () => {
		expect(names({})).toEqual([
			"libssl3t64",
			"linux-image-6.8.0-50-generic",
			"linux-image-generic",
			"openssl",
		]);
		const skipped = selectPackages(
			packages,
			DEFAULT_OS_UPDATE_SETTINGS,
		).skipped;
		expect(
			skipped.find((item) => item.package.name === "docker-ce")?.reason,
		).toBe("docker");
		expect(skipped.find((item) => item.package.name === "tzdata")?.reason).toBe(
			"not-security",
		);
	});

	it("installs every update with all, Docker once allowed", () => {
		expect(names({ classification: "all" })).not.toContain("docker-ce");
		expect(
			names({ classification: "all", allowDockerUpdates: true }),
		).toContain("docker-ce");
		// The include list does not bypass the Docker switch.
		expect(
			names({ classification: "all", includePackages: ["docker-ce"] }),
		).toEqual(["linux-image-6.8.0-50-generic"]);
	});

	it("keeps only the included packages, exclusions winning", () => {
		expect(
			names({ classification: "all", includePackages: ["libssl*", "tz?ata"] }),
		).toEqual(["libssl3t64", "linux-image-6.8.0-50-generic", "tzdata"]);
		expect(
			names({
				classification: "all",
				includePackages: ["libssl*"],
				excludePackages: ["libssl3t64"],
			}),
		).toEqual(["linux-image-6.8.0-50-generic"]);
	});

	it("installs a new package an update needs unless it is excluded", () => {
		expect(names({ excludePackages: ["linux-image-*"] })).toEqual([
			"libssl3t64",
			"openssl",
		]);
	});

	it("matches every architecture unless the pattern names one", () => {
		expect(matchesPattern("libc6:i386", "libc6")).toBe(true);
		expect(matchesPattern("libc6:i386", "libc6:amd64")).toBe(false);
		expect(matchesPattern("libc6:i386", "libc6:i386")).toBe(true);
		expect(matchesPattern("libc6", "libc")).toBe(false);
		// Regex characters are literal.
		expect(matchesPattern("libstdc++6", "libstdc++6")).toBe(true);
		expect(matchesPattern("python3.12", "python3?12")).toBe(true);
		expect(matchesPattern("python3x12", "python3.12")).toBe(false);
	});

	it("knows Docker's packages", () => {
		for (const name of [
			"docker-ce",
			"docker-ce-cli",
			"docker.io",
			"containerd",
			"containerd.io",
			"runc",
			"docker-compose-plugin",
			"docker-buildx-plugin",
		]) {
			expect(isDockerPackage(name), name).toBe(true);
		}
		expect(isDockerPackage("docker-doc-viewer")).toBe(false);
		expect(isDockerPackage("openssl")).toBe(false);
	});

	it("refuses patterns that are not package names", () => {
		for (const pattern of ["$(reboot)", "a b", "Nginx", "foo;bar", "-rf", ""]) {
			expect(
				osUpdateSettingsSchema.safeParse({ includePackages: [pattern] })
					.success,
				pattern,
			).toBe(false);
		}
		expect(
			osUpdateSettingsSchema.parse({
				excludePackages: ["linux-*", "libc6:i386"],
			}).excludePackages,
		).toEqual(["linux-*", "libc6:i386"]);
	});
});

// ------------------------------------------------------------- scripts

const scripts = () => ({
	assess: assessScript({ refresh: true }),
	assessCached: assessScript({ refresh: false }),
	prepare: prepareStep("run_1-a"),
	install: installStep({
		runId: "run_1-a",
		allowed: ["libssl3t64", "libc6:i386", "linux-image-generic"],
		deadline: 1_900_000_000,
	}),
	start: startStepScript("run_1-a", "install", "echo hi\n"),
	follow: followStepScript("run_1-a", "install", 42),
	docker: dockerStatusScript(),
	cleanup: cleanupRunScript("run_1-a"),
	reboot: rebootScript("run_1-a"),
});

const shellcheck = (() => {
	try {
		execFileSync("shellcheck", ["--version"]);
		return true;
	} catch {
		return false;
	}
})();

describe("server scripts", () => {
	it("are valid bash", () => {
		const dir = mkdtempSync(join(tmpdir(), "dokploy-os-updates-"));
		try {
			for (const [name, content] of Object.entries(scripts())) {
				const file = join(dir, `${name}.sh`);
				writeFileSync(file, content);
				expect(() => execFileSync("bash", ["-n", file]), name).not.toThrow();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(!shellcheck)("pass shellcheck", () => {
		const dir = mkdtempSync(join(tmpdir(), "dokploy-os-updates-sc-"));
		try {
			const paths = Object.entries(scripts()).map(([name, content]) => {
				const file = join(dir, `${name}.sh`);
				writeFileSync(file, `#!/bin/bash\n${content}`);
				return file;
			});
			expect(() =>
				execFileSync("shellcheck", ["-s", "bash", "-S", "warning", ...paths]),
			).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("quotes the packages, drops architectures, and refuses anything else", () => {
		const install = scripts().install;
		expect(install).toContain(
			"for name in 'libssl3t64' 'libc6' 'linux-image-generic'; do",
		);
		expect(install).toContain("-ge 1900000000 ]");
		for (const name of ["foo;reboot", "$(id)", "a b", "Foo", "x'y", ""]) {
			expect(
				() => installStep({ runId: "r", allowed: [name], deadline: 1 }),
				name,
			).toThrow(/Invalid package name/);
		}
		expect(() =>
			installStep({ runId: "r", allowed: ["curl"], deadline: 1.5 }),
		).toThrow(/deadline/);
	});

	it("refuses run ids that would leave the state directory", () => {
		for (const runId of ["../etc", "a b", "x;y", "", "a/b", "$(id)"]) {
			expect(() => assertRunId(runId), runId).toThrow();
			expect(() => prepareStep(runId), runId).toThrow();
			expect(() => cleanupRunScript(runId), runId).toThrow();
		}
		expect(assertRunId("AbC_12-x")).toBe("AbC_12-x");
	});

	it("refuses a step script that would end its heredoc", () => {
		expect(() =>
			startStepScript("r", "install", "echo\nDOKPLOY_EOF\nreboot\n"),
		).toThrow(/heredoc/);
	});

	it("never removes packages, and pins what is not allowed", () => {
		const install = scripts().install;
		expect(install).toContain("--with-new-pkgs upgrade");
		expect(install).not.toMatch(/dist-upgrade|full-upgrade|autoremove|purge/);
		expect(install).toContain('-o Dir::Etc::Preferences="$prefs"');
		expect(install).toContain("Pin-Priority: 1001");
		expect(install).toContain("Pin-Priority: -1");
		// The shared lock waits of the runners.
		expect(install).toContain("DPkg::Lock::Timeout=600");
		expect(scripts().prepare).toContain("for attempt in $(seq 1 30); do");
		expect(scripts().prepare).toContain(
			"dpkg --force-confdef --force-confold --configure -a",
		);
	});

	it("leaves the runners' OS scripts as they were", () => {
		const patch = osPatchScript();
		expect(patch).toContain(
			'apt="apt-get -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"\n# The package lists lock has no timeout, unlike dpkg\'s: apt-daily may hold it.\nfor attempt in $(seq 1 30); do\n\t$apt update -qq && break\n\t[ "$attempt" != 30 ] || exit 1\n\tsleep 10\ndone\n$apt -y -q --with-new-pkgs upgrade\n',
		);
		expect(patch).toMatch(
			/^set -euo pipefail\nexport DEBIAN_FRONTEND=noninteractive\nexport PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin\ncommand -v apt-get/,
		);
		expect(patch).toContain(
			'echo "patched boot=$(cat /proc/sys/kernel/random/boot_id) reboot=$([ -f /var/run/reboot-required ] && echo yes || echo no)"\n',
		);
		const report = linuxOsReportScript();
		expect(report).toContain(
			"\tsimulated=$(apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null || true)\n",
		);
		expect(report).toContain(
			"lists=$(stat -c %Y /var/lib/apt/lists 2>/dev/null || true)\nreboot=$([ -f /var/run/reboot-required ] && echo yes || echo no)\n",
		);
		expect(report).toContain(
			"clean() { printf '%s' \"$1\" | tr -cd 'A-Za-z0-9._+~-'; }",
		);
	});

	it("reboots from a transient unit named after the run", () => {
		expect(scripts().reboot).toBe(
			"systemd-run --on-active=5 --unit=dokploy-os-update-reboot-run_1-a systemctl reboot",
		);
	});
});

describe("script output", () => {
	const assessment = [
		"os id=ubuntu like=debian version=24.04 codename=noble kernel=6.8.0-45-generic apt=yes",
		"pretty Ubuntu 24.04.1 LTS",
		"state lists=1794079799 refreshed=yes reboot=yes dpkg=ok boot=abc-123",
		"reboot-packages linux-image-6.8.0-50-generic libc6 ",
		"docker active=active pid=812",
		'swarm {"NodeID":"n1","LocalNodeState":"active","ControlAvailable":true,"Managers":3,"Nodes":5,"Cluster":{"ID":"c1"}}',
		"--- simulation",
		UBUNTU_SIMULATION,
		"--- simulation status=0",
		"exit code=0",
	].join("\n");

	it("reads an assessment", () => {
		const parsed = parseAssessment(assessment);
		expect(parsed).toMatchObject({
			os: {
				id: "ubuntu",
				like: ["debian"],
				version: "24.04",
				pretty: "Ubuntu 24.04.1 LTS",
			},
			supported: true,
			listsAt: new Date(1794079799 * 1000).toISOString(),
			listsRefreshed: true,
			rebootRequired: true,
			rebootPackages: ["linux-image-6.8.0-50-generic", "libc6"],
			dpkgInterrupted: false,
			bootId: "abc-123",
			docker: { active: true, pid: "812" },
			swarm: {
				state: "active",
				manager: true,
				clusterId: "c1",
				managers: 3,
				nodes: 5,
			},
			keptBack: ["libnss-systemd", "systemd", "udev"],
			simulationError: null,
		});
		expect(parsed?.packages).toHaveLength(7);
		expect(stepExitCode(assessment)).toBe(0);
	});

	it("refuses distributions without apt", () => {
		const fedora = parseAssessment(
			"os id=fedora like= version=41 codename= kernel=6.11 apt=no\npretty Fedora Linux 41",
		);
		expect(fedora?.supported).toBe(false);
		expect(fedora?.packages).toEqual([]);
		// Derivatives of Debian or Ubuntu are apt-based too.
		expect(isSupportedOs({ id: "pop", like: ["ubuntu", "debian"] })).toBe(true);
		expect(isSupportedOs({ id: "rocky", like: ["rhel", "fedora"] })).toBe(
			false,
		);
		expect(parseAssessment("busy")).toBeNull();
	});

	it("reports apt's error when it cannot simulate", () => {
		const parsed = parseAssessment(
			[
				"os id=debian like= version=12 codename=bookworm kernel=6.1 apt=yes",
				"state lists=1 refreshed=no reboot=no dpkg=interrupted boot=b",
				"--- simulation",
				"E: dpkg was interrupted, you must manually run 'dpkg --configure -a' to correct the problem.",
				"--- simulation status=100",
			].join("\n"),
		);
		expect(parsed?.dpkgInterrupted).toBe(true);
		expect(parsed?.simulationError).toMatch(/dpkg was interrupted/);
	});

	it("reads where a step stands", () => {
		expect(
			parseFollow(
				"follow size=120 unit=active done=no\n--- log\nReading package lists...\nhalf a li",
			),
		).toEqual({
			size: 120,
			unitActive: true,
			done: false,
			result: "",
			log: "Reading package lists...\nhalf a li",
		});
		const done = parseFollow(
			"follow size=7 unit=inactive done=yes\nresult status=installed reboot=no\nexit code=0\n--- log\n",
		);
		expect(done?.done).toBe(true);
		expect(done?.unitActive).toBe(false);
		expect(stepExitCode(done?.result ?? "")).toBe(0);
		expect(parseFollow("garbage")).toBeNull();
	});

	it("reads what an install changed", () => {
		expect(
			parseInstallResult(
				[
					"changed name=libssl3t64:amd64 from=3.0.13-0ubuntu3.1 to=3.0.13-0ubuntu3.4",
					"changed name=linux-image-6.8.0-50-generic from=- to=6.8.0-50.51",
					"changed name=bad;name from=1 to=2",
					"result status=installed reboot=yes docker-before=812 docker-after=812",
					"exit code=0",
				].join("\n"),
			),
		).toEqual({
			status: "installed",
			rebootRequired: true,
			dockerRestarted: false,
			changes: [
				{
					name: "libssl3t64:amd64",
					from: "3.0.13-0ubuntu3.1",
					to: "3.0.13-0ubuntu3.4",
				},
				{ name: "linux-image-6.8.0-50-generic", from: null, to: "6.8.0-50.51" },
			],
			exitCode: 0,
		});
		expect(
			parseInstallResult("result status=window-closed\nexit code=0")?.status,
		).toBe("window-closed");
		expect(parseInstallResult("exit code=100")?.exitCode).toBe(100);
		// Without the exit record, the step did not end.
		expect(parseInstallResult("changed name=a from=1 to=2")).toBeNull();
	});

	it("reads Swarm states", () => {
		expect(parseSwarm('{"LocalNodeState":"inactive","NodeID":""}')).toEqual({
			state: "inactive",
			nodeId: null,
			clusterId: null,
			manager: false,
			managers: null,
			nodes: null,
		});
		expect(parseSwarm("")).toBeNull();
		expect(parseSwarm("not json")).toBeNull();
	});
});

describe("Swarm reboots", () => {
	const managers = (others: string) =>
		parseSwarmManagers(
			[
				'{"Self":true,"Hostname":"m1","Status":"Ready","ManagerStatus":"Leader"}',
				...others.split("\n").filter(Boolean),
			].join("\n"),
		);

	it("reboots a manager when every other manager is reachable", () => {
		expect(
			swarmRebootCheck(
				managers(
					'{"Self":false,"Hostname":"m2","Status":"Ready","ManagerStatus":"Reachable"}\n{"Self":false,"Hostname":"m3","Status":"Ready","ManagerStatus":"Reachable"}',
				),
			).safe,
		).toBe(true);
		expect(swarmRebootCheck(managers("")).safe).toBe(true);
	});

	it("refuses when a manager is down, keeping the quorum", () => {
		const check = swarmRebootCheck(
			managers(
				'{"Self":false,"Hostname":"m2","Status":"Down","ManagerStatus":"Unreachable"}\n{"Self":false,"Hostname":"m3","Status":"Ready","ManagerStatus":"Reachable"}',
			),
		);
		expect(check.safe).toBe(false);
		expect(check.reason).toMatch(/m2 is not reachable/);
		expect(swarmRebootCheck([]).safe).toBe(false);
	});
});

describe("run logs", () => {
	it("keep no credentials", () => {
		expect(
			redactLogLine(
				"Get:1 http://alice:s3cret@proxy.example:3128/ubuntu noble InRelease",
			),
		).toBe("Get:1 http://***:***@proxy.example:3128/ubuntu noble InRelease");
		expect(
			redactLogLine("https://repo.example/deb?token=abc123&arch=amd64"),
		).toBe("https://repo.example/deb?token=***&arch=amd64");
		expect(redactLogLine("Setting up curl (8.5.0) ...")).toBe(
			"Setting up curl (8.5.0) ...",
		);
	});

	it("keep the last state of a progress line", () => {
		expect(
			logLines(
				"(Reading database ... 5%\r(Reading database ... 100%\nSetting up x\n\n",
			),
		).toEqual(["(Reading database ... 100%", "Setting up x"]);
	});
});

/** The servers run bash 5; macOS ships 3.2, without associative arrays. */
const modernBash = (() => {
	try {
		return /^[4-9]/.test(
			execFileSync("bash", ["-c", "echo $BASH_VERSION"]).toString(),
		);
	} catch {
		return false;
	}
})();

/**
 * The recorded simulation answers in place of the host's apt-get: a Linux CI
 * machine has its own pending updates.
 */
const fakeAptGet = `apt-get() { cat "$dir/simulation"; }`;

describe.skipIf(!modernBash)("install step pins (bash, without apt)", () => {
	// The pin loop of the install step, run on a recorded simulation.
	it("pins every pending update that is not allowed", () => {
		const install = scripts().install;
		const start = install.indexOf("declare -A allow=()");
		const end = install.indexOf('done <<<"$simulated"');
		const dir = mkdtempSync(join(tmpdir(), "dokploy-os-pins-"));
		try {
			const script = `set -euo pipefail
dir=${dir}
${fakeAptGet}
${install.slice(start, end)}done <<<"$simulated"
cat "$prefs"
echo "held=$held"
`;
			writeFileSync(
				join(dir, "simulation"),
				UBUNTU_SIMULATION.replace("Inst evil;rm [1] (2 Somewhere [all])\n", ""),
			);
			writeFileSync(join(dir, "pins.sh"), script);
			const result = spawnSync("bash", [join(dir, "pins.sh")], {
				encoding: "utf8",
			});
			expect(result.stderr).toBe("");
			expect(result.status).toBe(0);
			expect(result.stdout).toContain(
				"Package: openssl\nPin: version 3.0.13-0ubuntu3.1\nPin-Priority: 1001\n",
			);
			expect(result.stdout).toContain(
				"Package: docker-ce\nPin: version 5:27.3.1-1~ubuntu.24.04~noble\nPin-Priority: 1001\n",
			);
			expect(result.stdout).toContain(
				"Package: linux-image-6.8.0-50-generic\nPin: version *\nPin-Priority: -1\n",
			);
			// Allowed: libssl3t64, libc6 (any architecture), linux-image-generic.
			expect(result.stdout).not.toContain("Package: libssl3t64\n");
			expect(result.stdout).not.toContain("Package: libc6\n");
			expect(result.stdout).toContain("held=4");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails closed on a name apt should never print", () => {
		const install = scripts().install;
		const start = install.indexOf("declare -A allow=()");
		const end = install.indexOf('done <<<"$simulated"');
		const dir = mkdtempSync(join(tmpdir(), "dokploy-os-pins-"));
		try {
			writeFileSync(join(dir, "simulation"), "Inst Evil$x [1] (2 x [all])\n");
			writeFileSync(
				join(dir, "pins.sh"),
				`set -euo pipefail\ndir=${dir}\n${fakeAptGet}\n${install.slice(start, end)}done <<<"$simulated"\necho reached\n`,
			);
			const result = spawnSync("bash", [join(dir, "pins.sh")], {
				encoding: "utf8",
			});
			expect(result.status).not.toBe(0);
			expect(result.stdout).toContain("unexpected package name");
			expect(result.stdout).not.toContain("reached");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
