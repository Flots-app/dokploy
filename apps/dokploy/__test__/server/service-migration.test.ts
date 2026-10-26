import { execSync } from "node:child_process";
import { defaultServiceMigrationOptions } from "@dokploy/server/db/schema";
import {
	buildPlan,
	formatBytes,
	parseListeningPorts,
	parsePublishedPorts,
} from "@dokploy/server/utils/service-migration/analyze";
import {
	mapWithConcurrency,
	sequentially,
} from "@dokploy/server/utils/service-migration/concurrency";
import {
	type AnonymousVolumeMount,
	anonymousVolumeSkipReason,
	bindSkipReason,
	composeContainerIdsCommand,
	copiedVolumes,
	hasDataToCopy,
	isAnonymousVolume,
	isPathInside,
	requiresDowntime,
	runsWithoutDowntime,
	type SourceSnapshot,
	type VolumeSnapshot,
} from "@dokploy/server/utils/service-migration/discovery";
import {
	type DnsTarget,
	describeDomainDns,
	isCloudflareAddress,
	isPublicAddress,
} from "@dokploy/server/utils/service-migration/dns";
import {
	buildSourceCleanup,
	type MigrationContext,
	matchAnonymousVolumes,
} from "@dokploy/server/utils/service-migration/execute";
import {
	createHostExecutor,
	HostCommandError,
	pipeBetweenHosts,
} from "@dokploy/server/utils/service-migration/host";
import {
	assessComposeReadiness,
	composeProbeCommand,
	parseContainerProbes,
	readinessTimeoutMs,
	waitForComposeContainers,
} from "@dokploy/server/utils/service-migration/readiness";
import type { MigrationService } from "@dokploy/server/utils/service-migration/service";
import { describe, expect, it } from "vitest";

const localHost = { serverId: null, name: "Dokploy server", ipAddress: null };

const snapshot = (overrides: Partial<SourceSnapshot> = {}): SourceSnapshot => ({
	platform: "linux/amd64",
	uid: "0",
	gid: "0",
	service: null,
	previews: [],
	compose: null,
	volumes: [],
	missingVolumes: [],
	binds: [],
	directories: [],
	traefik: [],
	helperImagePresent: true,
	...overrides,
});

const service = (
	overrides: Partial<MigrationService> = {},
): MigrationService => ({
	type: "application",
	id: "app-1",
	name: "app",
	appName: "app-abc",
	serverId: "server-a",
	organizationId: "org",
	status: "done",
	mounts: [],
	domains: [],
	ports: [],
	networks: ["dokploy-network"],
	placementConstraints: [],
	replicas: 1,
	dockerImage: null,
	buildServerId: null,
	registryIds: [],
	composeType: null,
	supportsZeroDowntime: true,
	previews: [],
	redirects: 0,
	securityRules: 0,
	backups: [],
	volumeBackups: [],
	schedules: [],
	rollbacks: 0,
	deployments: 0,
	environmentVariables: 0,
	...overrides,
});

const volume: VolumeSnapshot = {
	name: "app-data",
	driver: "local",
	labels: {},
	options: {},
	sizeBytes: 1024,
	externalStorage: false,
	anonymous: null,
	skipReason: null,
};

describe("service migration bind mounts", () => {
	const serviceDirectory = "/etc/dokploy/compose/app-abc";

	it("copies regular host paths", () => {
		expect(bindSkipReason("/srv/uploads", serviceDirectory)).toBeNull();
	});

	it("never copies host system paths", () => {
		for (const path of [
			"/var/run/docker.sock",
			"/etc/localtime",
			"/var/lib/docker/volumes/x",
			"/proc/1",
		]) {
			expect(bindSkipReason(path, serviceDirectory)).toMatch(/system path/);
		}
		expect(bindSkipReason("/", serviceDirectory)).toBe("Host root filesystem");
	});

	it("leaves paths of the service directory to the directory copy", () => {
		expect(
			bindSkipReason(`${serviceDirectory}/code/data`, serviceDirectory),
		).toBe("Copied with the service directory");
	});

	it("matches path prefixes on segment boundaries", () => {
		expect(isPathInside("/etc/dokploy", "/etc")).toBe(true);
		expect(isPathInside("/etcetera", "/etc")).toBe(false);
		expect(isPathInside("/srv/a", "/srv/a")).toBe(true);
	});
});

describe("service migration downtime", () => {
	it("keeps stateless applications online", () => {
		expect(runsWithoutDowntime(service(), snapshot(), false)).toBe(true);
	});

	it("stops stateful applications unless zero-downtime is requested", () => {
		const withData = snapshot({ volumes: [volume] });
		expect(requiresDowntime(service(), withData, false)).toBe(true);
		expect(requiresDowntime(service(), withData, true)).toBe(false);
	});

	it("never runs databases on two servers at once", () => {
		const database = service({ type: "postgres", supportsZeroDowntime: false });
		expect(requiresDowntime(database, snapshot(), true)).toBe(true);
	});

	it("only lets zero-downtime Compose projects overlap", () => {
		const legacy = service({ type: "compose", supportsZeroDowntime: false });
		const zeroDowntime = service({
			type: "compose",
			supportsZeroDowntime: true,
		});
		expect(requiresDowntime(legacy, snapshot(), true)).toBe(true);
		expect(requiresDowntime(zeroDowntime, snapshot(), true)).toBe(false);
	});

	it("ignores external storage when deciding to stop the source", () => {
		const external = snapshot({
			volumes: [{ ...volume, driver: "nfs", externalStorage: true }],
		});
		expect(requiresDowntime(service(), external, false)).toBe(false);
	});
});

describe("service migration target probes", () => {
	it("parses published Docker ports", () => {
		const ports = parsePublishedPorts(
			"0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp\n*:8080->80/tcp\n",
		);
		expect([...ports].sort()).toEqual(["5432/tcp", "8080/tcp"]);
	});

	it("parses listening sockets", () => {
		const ports = parseListeningPorts(
			"tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\nudp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*\ntcp LISTEN 0 511 [::]:80 [::]:*\n",
		);
		expect([...ports].sort()).toEqual(["22/tcp", "53/udp", "80/tcp"]);
	});

	it("selects Compose containers by Dokploy id, project and stack", () => {
		const command = composeContainerIdsCommand({
			id: "compose-1",
			appName: "shop-x1",
		});
		// Evaluate the quoting with a real shell, printing the filters instead of running docker.
		const filters = execSync(
			command.replaceAll("docker ps -aq --no-trunc --filter", "echo"),
			{ shell: "/bin/sh" },
		)
			.toString()
			.trim()
			.split("\n");
		expect(filters).toEqual([
			"label=com.docker.compose.project=shop-x1",
			"label=com.docker.stack.namespace=shop-x1",
			"label=com.dokploy.compose-id=compose-1",
		]);
	});

	it("formats sizes", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(1536)).toBe("1.5 KB");
		expect(formatBytes(null)).toBe("unknown size");
	});
});

describe("service migration streams", () => {
	it("streams the source output into the target", async () => {
		const source = await createHostExecutor(localHost);
		const target = await createHostExecutor(localHost);
		const bytes = await pipeBetweenHosts(
			source,
			"head -c 3000000 /dev/zero",
			target,
			"wc -c",
		);
		expect(bytes).toBe(3_000_000);
	});

	it("drains the source when the target stops reading early", async () => {
		const source = await createHostExecutor(localHost);
		const target = await createHostExecutor(localHost);
		// Like `tar -x` exiting on the end-of-archive marker before EOF.
		const bytes = await pipeBetweenHosts(
			source,
			"head -c 2000000 /dev/zero",
			target,
			"head -c 10 >/dev/null",
		);
		expect(bytes).toBe(2_000_000);
	});

	it("reports a failing target", async () => {
		const source = await createHostExecutor(localHost);
		const target = await createHostExecutor(localHost);
		await expect(
			pipeBetweenHosts(source, "echo data", target, "cat >/dev/null; exit 3"),
		).rejects.toBeInstanceOf(HostCommandError);
	});

	it("reports a failing source", async () => {
		const source = await createHostExecutor(localHost);
		const target = await createHostExecutor(localHost);
		await expect(
			pipeBetweenHosts(
				source,
				"echo partial; echo broken >&2; exit 4",
				target,
				"cat >/dev/null",
			),
		).rejects.toThrow(/exit 4.*broken/s);
	});
});

describe("service migration concurrency helpers", () => {
	const wait = (ms: number) =>
		new Promise((resolve) => setTimeout(resolve, ms));

	it("runs ordered steps one after the other", async () => {
		const events: string[] = [];
		await sequentially([30, 10, 20], async (delay) => {
			events.push(`start ${delay}`);
			await wait(delay);
			events.push(`end ${delay}`);
		});
		expect(events).toEqual([
			"start 30",
			"end 30",
			"start 10",
			"end 10",
			"start 20",
			"end 20",
		]);
	});

	it("bounds concurrency and keeps the result order", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const results = await mapWithConcurrency(
			[5, 1, 4, 2, 3, 6, 1],
			3,
			async (value) => {
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await wait(value * 3);
				inFlight -= 1;
				return value * 10;
			},
		);
		expect(results).toEqual([50, 10, 40, 20, 30, 60, 10]);
		expect(maxInFlight).toBe(3);
	});
});

describe("service migration DNS hint", () => {
	const tailscaleTarget: DnsTarget = {
		name: "fsn1",
		registeredAddress: "100.127.224.66",
		publicAddresses: { ipv4: "5.75.1.2", ipv6: null },
	};
	const records = (
		host: string,
		ipv4: string[] | null,
		ipv6: string[] | null = null,
	) => ({ host, ipv4, ipv6 });

	it("classifies addresses", () => {
		for (const address of [
			"100.127.224.66",
			"172.17.0.1",
			"10.0.0.4",
			"192.168.1.10",
			"127.0.0.1",
			"fd7a:115c:a1e0::1",
			"not-an-ip",
		]) {
			expect(isPublicAddress(address)).toBe(false);
		}
		expect(isPublicAddress("195.201.5.178")).toBe(true);
		expect(isPublicAddress("2a01:4f8:c17::1")).toBe(true);
		expect(isCloudflareAddress("172.67.153.152")).toBe(true);
		expect(isCloudflareAddress("2606:4700:3030::ac43:9998")).toBe(true);
		expect(isCloudflareAddress("195.201.5.178")).toBe(false);
	});

	it("never suggests the private address a server is registered with", () => {
		const { status, message } = describeDomainDns(
			[records("app.example.com", ["195.201.5.178"])],
			tailscaleTarget,
		);
		expect(status).toBe("warn");
		expect(message).toBe(
			"Point app.example.com to 5.75.1.2 once migrated (the source stops serving them).",
		);
	});

	it("explains when the public address of the target is unknown", () => {
		const { message } = describeDomainDns(
			[records("app.example.com", ["195.201.5.178"])],
			{ ...tailscaleTarget, publicAddresses: { ipv4: null, ipv6: null } },
		);
		expect(message).toContain(
			"to the public IP of fsn1 (it is registered with 100.127.224.66, which public DNS cannot use)",
		);
	});

	it("falls back to a public registered address", () => {
		const { message } = describeDomainDns(
			[records("app.example.com", ["195.201.5.178"])],
			{
				name: "nbg1",
				registeredAddress: "203.0.113.7",
				publicAddresses: { ipv4: null, ipv6: null },
			},
		);
		expect(message).toContain("Point app.example.com to 203.0.113.7");
	});

	it("only blames the registered address when it is private", () => {
		const { message } = describeDomainDns(
			[records("app.example.com", ["195.201.5.178"])],
			{
				name: "v6-only",
				registeredAddress: "2a01:4f8:c17::1",
				publicAddresses: { ipv4: null, ipv6: null },
			},
		);
		expect(message).toBe(
			"Point app.example.com to the public IP of v6-only once migrated (the source stops serving them).",
		);
	});

	it("points Cloudflare-proxied domains to the origin", () => {
		const { status, message } = describeDomainDns(
			[
				records(
					"pwd.flots.app",
					["172.67.153.152", "104.21.3.180"],
					["2606:4700:3030::ac43:9998"],
				),
			],
			tailscaleTarget,
		);
		expect(status).toBe("warn");
		expect(message).toBe(
			"pwd.flots.app is proxied by Cloudflare: once migrated, point the origin in Cloudflare (DNS record or tunnel) to 5.75.1.2.",
		);
	});

	it("passes when every record already targets the server", () => {
		expect(
			describeDomainDns(
				[records("app.example.com", ["5.75.1.2"])],
				tailscaleTarget,
			),
		).toEqual({
			status: "pass",
			message: "Every domain already resolves to fsn1 (5.75.1.2).",
		});
	});

	it("flags AAAA records left on the source", () => {
		const { message } = describeDomainDns(
			[records("app.example.com", ["5.75.1.2"], ["2a01:4f8:c17::1"])],
			tailscaleTarget,
		);
		expect(message).toBe(
			"Remove or update the AAAA records of app.example.com: no public IPv6 address was found on fsn1.",
		);
	});

	it("reports unresolved domains", () => {
		const { message } = describeDomainDns(
			[records("new.example.com", null, null)],
			tailscaleTarget,
		);
		expect(message).toBe("Unresolved: new.example.com.");
	});
});

interface ProbeFields {
	id?: string;
	name?: string;
	service?: string;
	number?: string;
	status?: string;
	exitCode?: number;
	restartCount?: number;
	startedAt?: string;
	health?: string;
	healthLog?: { ExitCode: number; Output: string }[];
	/** Seconds, as in the Compose file. */
	healthcheck?: { startPeriod?: number; interval?: number; retries?: number };
	mounts?: { Type: string; Name: string; Destination: string }[];
}

/** One line of the readiness probe, shaped like `docker inspect` output. */
const probeLine = ({
	id = "c-web",
	name = "/shop-web-1",
	service = "web",
	number = "1",
	status = "running",
	exitCode = 0,
	restartCount = 0,
	startedAt = "2026-10-20T10:00:00Z",
	health,
	healthLog = [],
	healthcheck,
	mounts = [],
}: ProbeFields = {}) =>
	JSON.stringify({
		id,
		name,
		service,
		number,
		restartCount,
		state: {
			Status: status,
			ExitCode: exitCode,
			StartedAt: startedAt,
			...(health && {
				Health: { Status: health, FailingStreak: 0, Log: healthLog },
			}),
		},
		healthcheck: healthcheck
			? {
					Test: ["CMD", "true"],
					StartPeriod: (healthcheck.startPeriod ?? 0) * 1e9,
					Interval: (healthcheck.interval ?? 0) * 1e9,
					Retries: healthcheck.retries ?? 0,
				}
			: null,
		mounts,
	});

const fakeClock = () => {
	let now = 0;
	return {
		now: () => now,
		sleep: async (ms: number) => {
			now += ms;
		},
	};
};

/** A target whose probes are scripted by poll number and elapsed time. */
const fakeTarget = (
	clock: { now: () => number },
	probe: (poll: number, elapsedMs: number) => string[],
) => {
	let poll = 0;
	const commands: string[] = [];
	return {
		commands,
		host: { serverId: "server-b", name: "fsn1", ipAddress: null },
		run: async (command: string) => {
			commands.push(command);
			if (command.includes("docker logs")) {
				return {
					stdout:
						"2026-10-20T10:00:01Z Error: getaddrinfo ENOTFOUND feedback-db\n",
					stderr: "",
					exitCode: 0,
				};
			}
			return {
				stdout: probe(poll++, clock.now()).join("\n"),
				stderr: "",
				exitCode: 0,
			};
		},
	};
};

const waitFor = async (
	probe: (poll: number, elapsedMs: number) => string[],
	expectedServices: string[],
) => {
	const clock = fakeClock();
	const logs: string[] = [];
	const target = fakeTarget(clock, probe);
	const result = waitForComposeContainers(
		target,
		{ id: "compose-1", appName: "shop" },
		{
			expectedServices: new Set(expectedServices),
			log: async (message) => {
				logs.push(message);
			},
			clock,
		},
	).then(
		() => ({ error: null }),
		(error: Error) => ({ error }),
	);
	const { error } = await result;
	return { error, logs: logs.join("\n"), elapsedMs: clock.now(), target };
};

describe("service migration Compose readiness", () => {
	it("rolls back a crash loop sampled as running between restarts", async () => {
		// restart: unless-stopped makes the bot alternate between running and restarting.
		const { error, logs, elapsedMs } = await waitFor(
			(poll) => [
				probeLine({
					id: "c-bot",
					name: "/feedback-bot-bot-1",
					service: "bot",
					status: poll % 2 === 0 ? "running" : "restarting",
					exitCode: 1,
					restartCount: Math.floor(poll / 2),
					startedAt: `2026-10-20T10:00:${String(poll).padStart(2, "0")}Z`,
				}),
			],
			["bot"],
		);
		expect(error?.message).toMatch(
			/^shop is not healthy on fsn1 after \d+s: feedback-bot-bot-1 .*restart/,
		);
		expect(elapsedMs).toBeGreaterThanOrEqual(120_000);
		expect(logs).toContain("✗ feedback-bot-bot-1");
		expect(logs).toContain("Last log lines of feedback-bot-bot-1");
		expect(logs).toContain("ENOTFOUND feedback-db");
	});

	it("does not accept a container restarting while every sample shows it running", async () => {
		const { error } = await waitFor(
			(poll) => [
				probeLine({
					service: "bot",
					restartCount: poll,
					startedAt: `t${poll}`,
				}),
			],
			["bot"],
		);
		expect(error?.message).toContain("restarted");
	});

	it("passes once every container stayed up through the stabilization window", async () => {
		const { error, logs, elapsedMs } = await waitFor(
			() => [
				probeLine(),
				probeLine({
					id: "c-db",
					name: "/shop-db-1",
					service: "db",
					health: "healthy",
					healthcheck: { interval: 5 },
				}),
			],
			["web", "db"],
		);
		expect(error).toBeNull();
		expect(elapsedMs).toBeGreaterThanOrEqual(30_000);
		expect(elapsedMs).toBeLessThan(40_000);
		expect(logs).toContain("shop-db-1 running, healthy");
	});

	it("waits past the default timeout for a long healthcheck start_period", async () => {
		const { error, elapsedMs } = await waitFor(
			(_, elapsedMs) => [
				probeLine({
					health: elapsedMs < 250_000 ? "starting" : "healthy",
					healthcheck: { startPeriod: 300, interval: 10, retries: 3 },
				}),
			],
			["web"],
		);
		expect(error).toBeNull();
		expect(elapsedMs).toBeGreaterThanOrEqual(280_000);
	});

	it("fails as soon as a healthcheck reports unhealthy, with its output", async () => {
		const { error, logs, elapsedMs } = await waitFor(
			() => [
				probeLine({
					health: "unhealthy",
					healthLog: [{ ExitCode: 1, Output: "curl: (7) Failed to connect" }],
					healthcheck: { interval: 5 },
				}),
			],
			["web"],
		);
		expect(error?.message).toContain("shop-web-1 running, unhealthy");
		expect(elapsedMs).toBe(0);
		expect(logs).toContain("Last healthchecks of shop-web-1");
		expect(logs).toContain("curl: (7) Failed to connect");
	});

	it("fails when a container of a service running on the source exits", async () => {
		const { error } = await waitFor(
			() => [probeLine({ status: "exited", exitCode: 1 })],
			["web"],
		);
		expect(error?.message).toContain("shop-web-1 exited (code 1)");
	});

	it("tolerates one-shot containers of services not running on the source", async () => {
		const { error, logs } = await waitFor(
			() => [
				probeLine(),
				probeLine({
					id: "c-migrate",
					name: "/shop-migrate-1",
					service: "migrate",
					status: "exited",
				}),
			],
			["web"],
		);
		expect(error).toBeNull();
		expect(logs).toContain(
			"shop-migrate-1 exited (code 0), not running on the source either",
		);
	});

	it("fails when a service running on the source has no container", async () => {
		const { error, elapsedMs } = await waitFor(
			() => [probeLine()],
			["web", "worker"],
		);
		expect(error?.message).toContain("worker has no container");
		expect(elapsedMs).toBeGreaterThanOrEqual(120_000);
	});

	it("requires every container when the source had no Compose labels", () => {
		const assessment = assessComposeReadiness(
			parseContainerProbes(
				[probeLine(), probeLine({ id: "c-2", status: "created" })].join("\n"),
			),
			new Set(),
		);
		expect(assessment.ready).toBe(false);
		expect(assessment.containers.map((item) => item.verdict)).toEqual([
			"ready",
			"pending",
		]);
	});

	it("sizes the timeout from the slowest healthcheck", () => {
		expect(readinessTimeoutMs([])).toBe(120_000);
		const [container] = parseContainerProbes(
			probeLine({
				healthcheck: { startPeriod: 300, interval: 10, retries: 3 },
			}),
		);
		expect(container?.healthcheck).toEqual({
			startPeriodMs: 300_000,
			intervalMs: 10_000,
			timeoutMs: 30_000,
			retries: 3,
		});
		// start_period + retries × (interval + timeout) + 60 s margin.
		expect(readinessTimeoutMs(container ? [container] : [])).toBe(480_000);
		// Docker defaults: 30 s interval, 30 s timeout, 3 retries.
		const [defaults] = parseContainerProbes(probeLine({ healthcheck: {} }));
		expect(readinessTimeoutMs(defaults ? [defaults] : [])).toBe(240_000);
	});

	it("ignores disabled healthchecks", () => {
		const [container] = parseContainerProbes(
			JSON.stringify({
				id: "c",
				name: "/c",
				state: { Status: "running" },
				healthcheck: { Test: ["NONE"] },
			}),
		);
		expect(container?.healthcheck).toBeNull();
	});

	it("keeps the inspect template intact through the shell", () => {
		// A fake docker prints the --format argument it receives.
		const output = execSync(
			`docker() { if [ "$1" = ps ]; then echo id-1; else printf '%s\\n' "$3"; fi; }; ${composeProbeCommand({ id: "compose-1", appName: "shop" })}`,
			{ shell: "/bin/sh" },
		).toString();
		expect(output).toContain(
			'"service":{{json (index .Config.Labels "com.docker.compose.service")}}',
		);
		expect(output).toContain('"state":{{json .State}}');
		// Docker fails `.Config.Healthcheck` on containers that have none.
		expect(output).toContain('{{json (index .Config "Healthcheck")}}');
		expect(output).not.toContain("Env");
	});
});

describe("service migration anonymous volumes", () => {
	const anonymousName = "4f3c2a1b".repeat(8);
	const mount: AnonymousVolumeMount = {
		destination: "/data",
		container: "feedback-bot-bot-1",
		service: "bot",
		containerNumber: "1",
	};
	const anonymous: VolumeSnapshot = {
		...volume,
		name: anonymousName,
		sizeBytes: 12 * 1024 * 1024,
		anonymous: mount,
		skipReason: null,
	};
	const compose = service({
		type: "compose",
		composeType: "docker-compose",
		supportsZeroDowntime: false,
	});

	it("recognizes volumes Docker created without a name", () => {
		expect(isAnonymousVolume(anonymousName)).toBe(true);
		expect(isAnonymousVolume("feedback-bot_data")).toBe(false);
		expect(
			isAnonymousVolume("data", { "com.docker.volume.anonymous": "" }),
		).toBe(true);
	});

	it("copies them only where the data survives a redeploy", () => {
		expect(anonymousVolumeSkipReason(compose, mount)).toBeNull();
		expect(
			anonymousVolumeSkipReason({ ...compose, composeType: "stack" }, mount),
		).toMatch(/Swarm/);
		expect(
			anonymousVolumeSkipReason(
				{ ...compose, supportsZeroDowntime: true },
				mount,
			),
		).toMatch(/zero-downtime/);
		expect(
			anonymousVolumeSkipReason(compose, { ...mount, service: null }),
		).toMatch(/Docker Compose/);
	});

	it("plans them by mount path, not by hash", () => {
		const source = { serverId: "a", name: "nbg1", ipAddress: null };
		const target = { serverId: "b", name: "fsn1", ipAddress: null };
		const plan = (volumes: VolumeSnapshot[], owner = compose) =>
			buildPlan(
				owner,
				snapshot({ volumes }),
				source,
				target,
				defaultServiceMigrationOptions,
				true,
				null,
			).filter((item) => item.category === "data");

		const [copied] = plan([anonymous]);
		expect(copied).toMatchObject({
			action: "copy",
			label: "Anonymous volume /data of bot",
			sizeBytes: 12 * 1024 * 1024,
		});
		expect(copied?.label).not.toContain(anonymousName);

		const [skipped] = plan([{ ...anonymous, skipReason: "not kept" }]);
		expect(skipped).toMatchObject({
			action: "skip",
			label: "Anonymous volume /data of bot",
			sizeBytes: 12 * 1024 * 1024,
		});
		expect(skipped?.detail).toContain("stays on nbg1 as 4f3c2a1b4f3c");

		// Swarm deletes the volume with its task: never claim it stays.
		const [stack] = plan([{ ...anonymous, skipReason: "lost" }], {
			...compose,
			composeType: "stack",
		});
		expect(stack?.detail).toBe("Not carried over: lost.");
	});

	it("never counts or deletes the data left behind", () => {
		const skipped = { ...anonymous, skipReason: "not kept" };
		const withSkipped = snapshot({ volumes: [skipped] });
		expect(copiedVolumes(withSkipped)).toEqual([]);
		expect(hasDataToCopy(withSkipped)).toBe(false);
		expect(copiedVolumes(snapshot({ volumes: [anonymous] }))).toHaveLength(1);

		const cleanup = buildSourceCleanup({
			service: compose,
			analysis: { snapshot: snapshot({ volumes: [volume, skipped] }) },
			options: { ...defaultServiceMigrationOptions, removeSourceData: true },
		} as unknown as MigrationContext);
		expect(cleanup.volumes).toEqual(["app-data"]);
	});

	it("finds the new anonymous volume of the redeployed container", () => {
		const newName = "9e8d7c6b".repeat(8);
		const containers = parseContainerProbes(
			[
				probeLine({
					id: "c-bot",
					name: "/feedback-bot-bot-1",
					service: "bot",
					mounts: [
						{ Type: "volume", Name: newName, Destination: "/data" },
						{ Type: "bind", Name: "", Destination: "/config" },
					],
				}),
				probeLine({ id: "c-web", service: "web" }),
			].join("\n"),
		);
		const { copies, problems } = matchAnonymousVolumes(
			[anonymous, volume],
			containers,
		);
		expect(problems).toEqual([]);
		expect(copies).toHaveLength(1);
		expect(copies[0]?.container.id).toBe("c-bot");
		expect(copies[0]?.targetVolume).toBe(newName);
	});

	it("refuses to guess when the target container does not match", () => {
		const containers = parseContainerProbes(
			[
				probeLine({
					id: "c-bot",
					name: "/feedback-bot-bot-1",
					service: "bot",
					mounts: [
						{ Type: "volume", Name: "feedback-bot_data", Destination: "/data" },
					],
				}),
			].join("\n"),
		);
		expect(matchAnonymousVolumes([anonymous], containers).problems).toEqual([
			"/data of bot: feedback-bot-bot-1 mounts the named volume feedback-bot_data there, which is never overwritten",
		]);
		expect(
			matchAnonymousVolumes(
				[{ ...anonymous, anonymous: { ...mount, containerNumber: "2" } }],
				containers,
			).problems,
		).toEqual(["/data of bot: no container of bot #2 on the target"]);
		expect(
			matchAnonymousVolumes(
				[{ ...anonymous, anonymous: { ...mount, destination: "/cache" } }],
				containers,
			).problems,
		).toEqual(["/cache of bot: feedback-bot-bot-1 mounts no volume at /cache"]);
	});
});
