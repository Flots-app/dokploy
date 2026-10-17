import { execSync } from "node:child_process";
import {
	formatBytes,
	parseListeningPorts,
	parsePublishedPorts,
} from "@dokploy/server/utils/service-migration/analyze";
import {
	mapWithConcurrency,
	sequentially,
} from "@dokploy/server/utils/service-migration/concurrency";
import {
	bindSkipReason,
	composeContainerIdsCommand,
	isPathInside,
	requiresDowntime,
	runsWithoutDowntime,
	type SourceSnapshot,
} from "@dokploy/server/utils/service-migration/discovery";
import {
	createHostExecutor,
	HostCommandError,
	pipeBetweenHosts,
} from "@dokploy/server/utils/service-migration/host";
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

const volume = {
	name: "app-data",
	driver: "local",
	labels: {},
	options: {},
	sizeBytes: 1024,
	externalStorage: false,
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
