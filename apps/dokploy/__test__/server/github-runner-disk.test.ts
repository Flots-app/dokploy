import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	apiCreateGithubRunnerNode,
	apiUpdateGithubRunnerNode,
} from "@dokploy/server/db/schema";
import {
	linuxChecks,
	macChecks,
} from "@dokploy/server/utils/github-runners/checks";
import {
	parseLinuxFacts,
	parseMacStatus,
} from "@dokploy/server/utils/github-runners/probe";
import {
	installRuntimeScript,
	shellQuote,
} from "@dokploy/server/utils/github-runners/runtime";
import { describe, expect, it } from "vitest";

const GiB = 1024 ** 3;

describe("disk cleanup percentage", () => {
	const update = (diskCleanupPercent: number) =>
		apiUpdateGithubRunnerNode.safeParse({
			githubRunnerNodeId: "node-1",
			description: null,
			cpuPercent: 70,
			memoryPercent: 70,
			diskReserveGb: 15,
			diskCleanupPercent,
			maxRunners: 0,
			vmDiskGb: 60,
			extraLabels: [],
		});

	it("takes a usage percentage between 50 and 99, 90 by default", () => {
		expect(update(90).success).toBe(true);
		expect(update(99).success).toBe(true);
		expect(update(50).success).toBe(true);
		expect(update(49).success).toBe(false);
		expect(update(100).success).toBe(false);
		expect(update(89.5).success).toBe(false);
		const created = apiCreateGithubRunnerNode.parse({
			githubRunnerPoolId: "pool-1",
			name: "m6",
			host: "192.0.2.10",
			username: "dokploy",
			sshKeyId: "key-1",
			platform: "linux",
			hostKeyFingerprint: "SHA256:test",
		});
		expect(created.diskCleanupPercent).toBe(90);
	});

	const settings = {
		vmName: "dokploy-runners",
		vmDiskGb: 60,
		diskReserveGb: 15,
		diskCleanupPercent: 90,
		cpuPercent: 70,
		memoryPercent: 70,
		maxRunners: 0,
	};
	const linux = (totalGib: number) =>
		parseLinuxFacts(
			[
				"os kernel=Linux arch=x86_64",
				"distro id=ubuntu version=24.04",
				"host cpus=8 memory_kib=16000000",
				"user root=yes sudo=yes",
				"systemd present=yes",
				"cgroup fs=cgroup2fs",
				"apt present=yes",
				`disk total_kib=${totalGib * 1024 * 1024} free_kib=${(totalGib / 2) * 1024 * 1024}`,
				"docker present=no",
				"network github=200",
				"runtime version=0",
			].join("\n"),
		);

	it("warns when the percentage leaves no more than the reserve", () => {
		// 90% of 100 GiB leaves 10 GiB: caches would go once jobs stop starting.
		const small = linuxChecks(linux(100), settings).find(
			(item) => item.id === "disk-cleanup",
		);
		expect(small?.status).toBe("warn");
		expect(small?.message).toContain("leaves 10 GiB free");
		expect(
			linuxChecks(linux(100), { ...settings, diskCleanupPercent: 80 }).some(
				(item) => item.id === "disk-cleanup",
			),
		).toBe(false);
		expect(
			linuxChecks(linux(400), settings).filter(
				(item) => item.status !== "pass",
			),
		).toEqual([]);
		const mac = parseMacStatus(
			[
				"mac cpus=10 memory_bytes=34359738368 arch=arm64 version=26.1 load=1",
				// A 128 GiB Mac at 90% keeps 12.8 GiB, below the 15 GiB reserve.
				"macdisk total_kib=134217728 free_kib=104857600",
				"network github=200",
				"lima version=",
			].join("\n"),
		);
		expect(
			macChecks(mac, settings).find((item) => item.id === "disk-cleanup")
				?.message,
		).toMatch(/90% of this 128 GiB Mac disk leaves 12\.8 GiB free/);
	});
});

/** runnerctl needs bash 4.4 (mapfile -d), GNU find and stat, and jq, as on the machines. */
const linuxShell = (() => {
	try {
		const version = execFileSync("bash", [
			"-c",
			"echo $BASH_VERSION",
		]).toString();
		return (
			/^(4\.[4-9]|[5-9])/.test(version) &&
			execFileSync("find", ["--version"]).toString().includes("GNU") &&
			spawnSync("jq", ["--version"]).status === 0
		);
	} catch {
		return false;
	}
})();

const runnerctlScript = () => {
	const install = installRuntimeScript();
	const start = install.indexOf(
		"write_file /opt/dokploy-runners/bin/runnerctl ",
	);
	const body = install.slice(install.indexOf("\n", start) + 1);
	return body.slice(0, body.indexOf("\nDOKPLOY_EOF\n"));
};

/**
 * A docker command answering from `volumes.json`: `volume ls` lists them,
 * `volume inspect` prints them, `volume rm` logs and drops one. Anything else
 * (prunes, images, containers) does nothing.
 */
const fakeDocker = (dir: string) => `#!/bin/bash
case "$1 $2" in
"info -f") echo ${shellQuote(join(dir, "docker"))} ;;
"volume ls") jq -r '.[].Name' ${shellQuote(join(dir, "volumes.json"))} ;;
"volume inspect")
	shift 2
	jq --args '[.[] | select(.Name as $name | $ARGS.positional | index($name))]' "$@" <${shellQuote(join(dir, "volumes.json"))} ;;
"volume rm")
	echo "$3" >>${shellQuote(join(dir, "removed"))}
	jq --arg name "$3" 'map(select(.Name != $name))' ${shellQuote(join(dir, "volumes.json"))} >${shellQuote(join(dir, "volumes.next"))}
	mv ${shellQuote(join(dir, "volumes.next"))} ${shellQuote(join(dir, "volumes.json"))} ;;
esac
exit 0
`;

describe.skipIf(!linuxShell)("named volume cleanup", () => {
	it("removes the least recently used named volumes, never one it cannot free", () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "dokploy-volumes-")));
		try {
			const day = 24 * 3600 * 1000;
			const volume = (name: string, extra: Record<string, unknown> = {}) => {
				const mountpoint = join(dir, "docker/volumes", name, "_data");
				mkdirSync(join(mountpoint, "pkg"), { recursive: true });
				writeFileSync(join(mountpoint, "pkg/blob"), "cache");
				return {
					Name: name,
					Driver: "local",
					Mountpoint: mountpoint,
					Labels: null,
					Options: null,
					...extra,
				};
			};
			const volumes = [
				volume("ci_old-cache"),
				volume("ci_fresh-cache"),
				// Removing a bind volume frees nothing: the data stays where it is.
				volume("ci_bound", {
					Options: { type: "none", o: "bind", device: "/srv" },
				}),
				volume("ci_anonymous", {
					Labels: { "com.docker.volume.anonymous": "" },
				}),
				volume("../escape"),
			];
			// Last used 40 days ago: files and directories alike.
			const old = new Date(Date.now() - 40 * day);
			const oldData = volumes[0]?.Mountpoint ?? "";
			for (const path of [
				join(oldData, "pkg/blob"),
				join(oldData, "pkg"),
				oldData,
			]) {
				utimesSync(path, old, old);
			}
			writeFileSync(join(dir, "volumes.json"), JSON.stringify(volumes));
			mkdirSync(join(dir, "bin"));
			writeFileSync(join(dir, "bin/docker"), fakeDocker(dir));
			writeFileSync(
				join(dir, "bin/systemctl"),
				'#!/bin/bash\n[ "$1" = show ] && echo inactive\nexit 0\n',
			);
			for (const tool of ["docker", "systemctl"]) {
				chmodSync(join(dir, "bin", tool), 0o755);
			}
			const runnerctl = join(dir, "runnerctl");
			writeFileSync(
				runnerctl,
				runnerctlScript()
					.replace(
						"export PATH=/usr/local/sbin",
						`export PATH=${shellQuote(join(dir, "bin"))}:/usr/local/sbin`,
					)
					.replace(
						"ROOT=/opt/dokploy-runners",
						`ROOT=${shellQuote(join(dir, "root"))}`,
					)
					.replace(
						"STATE=/var/lib/dokploy-runners",
						`STATE=${shellQuote(join(dir, "state"))}`,
					),
			);
			mkdirSync(join(dir, "root/tool-cache"), { recursive: true });
			mkdirSync(join(dir, "state/home"), { recursive: true });
			const removed = () => {
				try {
					return readFileSync(join(dir, "removed"), "utf8").trim().split("\n");
				} catch {
					return [];
				}
			};
			// Without access times, volumes only go in the idle step, like file caches.
			const atime = !execFileSync("findmnt", ["-no", "OPTIONS", "-T", dir])
				.toString()
				.split(",")
				.includes("noatime");
			// A target the disk cannot reach: every step runs, the idle one does not.
			const lru = spawnSync("bash", [
				runnerctl,
				"gc",
				"auto",
				"0",
				"999999999999",
			]);
			expect(lru.stderr.toString()).toBe("");
			expect(lru.stdout.toString()).toMatch(
				/^gc mode=auto .* idle=not-needed$/m,
			);
			expect(removed()).toEqual(atime ? ["ci_old-cache"] : []);
			// Clear all caches: every unused plain volume, still not the others.
			const full = spawnSync("bash", [runnerctl, "gc", "full"]);
			expect(full.stderr.toString()).toBe("");
			expect(full.stdout.toString()).toMatch(/ idle=done$/m);
			expect(removed().sort()).toEqual(["ci_fresh-cache", "ci_old-cache"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
