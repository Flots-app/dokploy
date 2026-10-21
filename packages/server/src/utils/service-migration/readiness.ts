import { quote } from "shell-quote";
import { getContainerLogsCommand } from "../docker/deployment-diagnostics";
import { sequentially } from "./concurrency";
import { composeContainerIdsCommand } from "./discovery";
import type { HostExecutor } from "./host";
import type { MigrationService } from "./service";

/** Time given to the containers to start when no healthcheck needs longer. */
export const BASE_READINESS_TIMEOUT_MS = 120_000;
/** Added to the time Docker needs to declare the slowest healthcheck unhealthy. */
const HEALTHCHECK_MARGIN_MS = 60_000;
/**
 * Every required container must keep running, without a restart, for this long.
 * A crash loop is sampled as "running" between two restarts.
 */
export const STABILIZATION_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;
const PROGRESS_LOG_INTERVAL_MS = 10_000;
const LOG_TAIL_LINES = 40;
const HEALTH_PROBES_SHOWN = 3;
const HEALTH_OUTPUT_MAX_LENGTH = 500;
const DIAGNOSED_CONTAINERS_MAX = 5;

/** Docker values for the healthcheck fields left at 0. */
const DOCKER_HEALTHCHECK_DEFAULTS = {
	intervalMs: 30_000,
	timeoutMs: 30_000,
	retries: 3,
};

export interface ContainerProbe {
	id: string;
	name: string;
	/** Compose service label. */
	service: string | null;
	containerNumber: string | null;
	status: string;
	exitCode: number | null;
	error: string | null;
	oomKilled: boolean;
	restartCount: number;
	startedAt: string | null;
	health: {
		status: string;
		failingStreak: number;
		log: { start: string | null; exitCode: number | null; output: string }[];
	} | null;
	healthcheck: {
		startPeriodMs: number;
		intervalMs: number;
		timeoutMs: number;
		retries: number;
	} | null;
	mounts: { type: string; name: string | null; destination: string }[];
}

interface RawContainerProbe {
	id?: string;
	name?: string;
	service?: string;
	number?: string;
	restartCount?: number;
	state?: {
		Status?: string;
		ExitCode?: number;
		Error?: string;
		OOMKilled?: boolean;
		StartedAt?: string;
		Health?: {
			Status?: string;
			FailingStreak?: number;
			Log?: Array<{
				Start?: string;
				ExitCode?: number;
				Output?: string;
			}> | null;
		} | null;
	};
	healthcheck?: {
		Test?: string[] | null;
		Interval?: number;
		Timeout?: number;
		StartPeriod?: number;
		Retries?: number;
	} | null;
	mounts?: Array<{ Type?: string; Name?: string; Destination?: string }> | null;
}

// Only the fields the check needs: a full inspect would also return Config.Env and its secrets.
// Docker evaluates the template over the inspect JSON: optional keys (Healthcheck) go
// through `index`, a direct `.Config.Healthcheck` fails for containers without one.
const PROBE_FORMAT = `{"id":{{json .Id}},"name":{{json .Name}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"number":{{json (index .Config.Labels "com.docker.compose.container-number")}},"restartCount":{{json .RestartCount}},"state":{{json .State}},"healthcheck":{{json (index .Config "Healthcheck")}},"mounts":{{json .Mounts}}}`;

/** Shell snippet printing one JSON line per container of the Compose service. */
export const composeProbeCommand = (
	service: Pick<MigrationService, "id" | "appName">,
) =>
	`ids="$(${composeContainerIdsCommand(service)})"; [ -z "$ids" ] || docker inspect --format ${quote([PROBE_FORMAT])} $ids`;

const nanosToMs = (value: number | undefined) =>
	Math.round((value ?? 0) / 1_000_000);

const parseHealthcheck = (
	healthcheck: RawContainerProbe["healthcheck"],
): ContainerProbe["healthcheck"] => {
	const test = healthcheck?.Test ?? [];
	if (test.length === 0 || test[0] === "NONE") return null;
	return {
		startPeriodMs: nanosToMs(healthcheck?.StartPeriod),
		intervalMs:
			nanosToMs(healthcheck?.Interval) ||
			DOCKER_HEALTHCHECK_DEFAULTS.intervalMs,
		timeoutMs:
			nanosToMs(healthcheck?.Timeout) || DOCKER_HEALTHCHECK_DEFAULTS.timeoutMs,
		retries: healthcheck?.Retries || DOCKER_HEALTHCHECK_DEFAULTS.retries,
	};
};

export const parseContainerProbes = (output: string): ContainerProbe[] =>
	output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line) => {
			let raw: RawContainerProbe;
			try {
				raw = JSON.parse(line) as RawContainerProbe;
			} catch {
				return [];
			}
			if (!raw.id) return [];
			const health = raw.state?.Health;
			return [
				{
					id: raw.id,
					name: (raw.name ?? raw.id).replace(/^\//, ""),
					service: raw.service || null,
					containerNumber: raw.number || null,
					status: raw.state?.Status ?? "unknown",
					exitCode: raw.state?.ExitCode ?? null,
					error: raw.state?.Error || null,
					oomKilled: Boolean(raw.state?.OOMKilled),
					restartCount: raw.restartCount ?? 0,
					startedAt: raw.state?.StartedAt ?? null,
					health: health?.Status
						? {
								status: health.Status,
								failingStreak: health.FailingStreak ?? 0,
								log: (health.Log ?? []).map((probe) => ({
									start: probe.Start ?? null,
									exitCode: probe.ExitCode ?? null,
									output: (probe.Output ?? "").trim(),
								})),
							}
						: null,
					healthcheck: parseHealthcheck(raw.healthcheck),
					mounts: (raw.mounts ?? []).map((mount) => ({
						type: mount.Type ?? "",
						name: mount.Name || null,
						destination: mount.Destination ?? "",
					})),
				},
			];
		});

/**
 * Longest time to wait: enough for the slowest healthcheck to pass its
 * start_period and for Docker to declare it unhealthy, plus a margin.
 */
export const readinessTimeoutMs = (containers: ContainerProbe[]) =>
	Math.max(
		BASE_READINESS_TIMEOUT_MS,
		...containers.map(({ healthcheck }) =>
			healthcheck
				? healthcheck.startPeriodMs +
					(healthcheck.intervalMs + healthcheck.timeoutMs) *
						healthcheck.retries +
					HEALTHCHECK_MARGIN_MS
				: 0,
		),
	);

export type ContainerVerdict = "ready" | "pending" | "failed" | "ignored";

export interface ContainerAssessment {
	container: ContainerProbe;
	verdict: ContainerVerdict;
	/** Human readable state, e.g. "running, healthy" or "exited (code 1)". */
	state: string;
}

export interface ReadinessAssessment {
	containers: ContainerAssessment[];
	/** Services running on the source without any container on the target. */
	missingServices: string[];
	failed: boolean;
	ready: boolean;
}

export const describeContainerState = (container: ContainerProbe) => {
	const parts: string[] = [];
	if (container.status === "exited" || container.status === "dead") {
		parts.push(`${container.status} (code ${container.exitCode ?? "?"})`);
	} else {
		parts.push(container.status);
	}
	if (container.status === "running" && container.health) {
		parts.push(container.health.status);
	}
	if (container.oomKilled) parts.push("out of memory");
	if (container.restartCount > 0) {
		parts.push(`${container.restartCount} restart(s)`);
	}
	return parts.join(", ");
};

const assessContainer = (
	container: ContainerProbe,
	required: boolean,
): ContainerAssessment => {
	const state = describeContainerState(container);
	if (!required) {
		return {
			container,
			verdict: "ignored",
			state: `${state}, not running on the source either`,
		};
	}
	let verdict: ContainerVerdict = "pending";
	if (container.status === "running") {
		const health = container.health?.status;
		if (!health || health === "healthy") verdict = "ready";
		else if (health === "unhealthy") verdict = "failed";
	} else if (container.status === "exited" || container.status === "dead") {
		// A restart policy shows "restarting" instead: this container stays down.
		verdict = "failed";
	}
	return { container, verdict, state };
};

/**
 * Every container of a service that runs on the source must run on the target,
 * and be healthy when it has a healthcheck. Containers of services that were not
 * running on the source (one-shot jobs…) are reported but not required.
 */
export const assessComposeReadiness = (
	containers: ContainerProbe[],
	expectedServices: ReadonlySet<string>,
): ReadinessAssessment => {
	const assessed = containers.map((container) =>
		assessContainer(
			container,
			expectedServices.size === 0 ||
				!container.service ||
				expectedServices.has(container.service),
		),
	);
	const missingServices = [...expectedServices].filter(
		(name) => !containers.some((container) => container.service === name),
	);
	const failed = assessed.some((item) => item.verdict === "failed");
	return {
		containers: assessed,
		missingServices,
		failed,
		ready:
			!failed &&
			assessed.length > 0 &&
			missingServices.length === 0 &&
			!assessed.some((item) => item.verdict === "pending"),
	};
};

/** Changes whenever a required container is replaced or restarted. */
const stabilityFingerprint = (assessment: ReadinessAssessment) =>
	assessment.containers
		.filter((item) => item.verdict !== "ignored")
		.map(
			({ container }) =>
				`${container.id}:${container.restartCount}:${container.startedAt}`,
		)
		.sort()
		.join(",");

const truncate = (value: string, length: number) =>
	value.length > length ? `${value.slice(0, length)}…` : value;

const indent = (text: string) =>
	text
		.split("\n")
		.map((line) => `    ${line}`)
		.join("\n");

const containerLabel = (container: ContainerProbe) =>
	container.service && !container.name.includes(container.service)
		? `${container.name} (service ${container.service})`
		: container.name;

export interface ReadinessClock {
	now: () => number;
	sleep: (ms: number) => Promise<void>;
}

const systemClock: ReadinessClock = {
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface ComposeReadinessOptions {
	/** Compose services with a running container on the source. */
	expectedServices: ReadonlySet<string>;
	log: (message: string) => Promise<void>;
	clock?: ReadinessClock;
	stabilizationMs?: number;
	pollMs?: number;
}

/**
 * Waits until the Compose project runs on the target: every required container
 * running (healthy when it has a healthcheck) and none restarted during the
 * stabilization window. On failure, logs the container states, healthcheck
 * output and last log lines, then throws.
 */
export const waitForComposeContainers = async (
	executor: Pick<HostExecutor, "run" | "host">,
	service: Pick<MigrationService, "id" | "appName">,
	options: ComposeReadinessOptions,
) => {
	const clock = options.clock ?? systemClock;
	const stabilizationMs = options.stabilizationMs ?? STABILIZATION_MS;
	const pollMs = options.pollMs ?? POLL_INTERVAL_MS;
	const { log } = options;
	const started = clock.now();
	const firstRestartCount = new Map<string, number>();
	let timeoutMs = BASE_READINESS_TIMEOUT_MS;
	let stableSince: number | null = null;
	let fingerprint = "";
	let assessment: ReadinessAssessment;
	let probeError = "";
	let timedOut = false;
	let announcedStabilization = false;
	let lastNotice = "";
	let lastNoticeAt = Number.NEGATIVE_INFINITY;
	/** Progress messages, throttled: a crash loop changes state every few seconds. */
	const notify = async (message: string, now: number) => {
		if (message === lastNotice || now - lastNoticeAt < PROGRESS_LOG_INTERVAL_MS)
			return;
		lastNotice = message;
		lastNoticeAt = now;
		await log(message);
	};

	while (true) {
		const probe = await executor.run(composeProbeCommand(service), {
			allowFailure: true,
		});
		// A container removed between `ps` and `inspect` fails alone; others still print.
		probeError = probe.exitCode === 0 ? "" : probe.stderr.trim();
		const containers = parseContainerProbes(probe.stdout);
		for (const container of containers) {
			if (!firstRestartCount.has(container.id)) {
				firstRestartCount.set(container.id, container.restartCount);
			}
		}
		assessment = assessComposeReadiness(containers, options.expectedServices);
		timeoutMs = Math.max(
			timeoutMs,
			readinessTimeoutMs(
				assessment.containers
					.filter((item) => item.verdict !== "ignored")
					.map((item) => item.container),
			),
		);
		const now = clock.now();
		if (assessment.failed) break;

		if (assessment.ready) {
			const current = stabilityFingerprint(assessment);
			if (stableSince === null || current !== fingerprint) {
				if (!announcedStabilization) {
					announcedStabilization = true;
					lastNoticeAt = now;
					await log(
						`  All containers run; checking that they stay up for ${Math.round(stabilizationMs / 1000)}s`,
					);
				} else if (stableSince !== null) {
					await notify("  A container restarted; checking again", now);
				}
				stableSince = now;
				fingerprint = current;
			} else if (now - stableSince >= stabilizationMs) {
				await log(
					`Containers on ${executor.host.name}: ${assessment.containers
						.map((item) => `${containerLabel(item.container)} ${item.state}`)
						.join("; ")}`,
				);
				return;
			}
		} else {
			stableSince = null;
			const waiting = [
				...assessment.missingServices.map((name) => `${name} (no container)`),
				...assessment.containers
					.filter((item) => item.verdict === "pending")
					.map((item) => `${containerLabel(item.container)} (${item.state})`),
			].join(", ");
			await notify(`  Waiting for ${waiting || "the containers"}`, now);
		}

		if (
			now - started >=
			timeoutMs + (stableSince === null ? 0 : stabilizationMs)
		) {
			timedOut = true;
			break;
		}
		await clock.sleep(pollMs);
	}

	const restartedDuringCheck = (container: ContainerProbe) =>
		container.restartCount - (firstRestartCount.get(container.id) ?? 0);
	const problems = assessment.containers.filter(
		(item) =>
			item.verdict === "failed" ||
			item.verdict === "pending" ||
			(item.verdict === "ready" && restartedDuringCheck(item.container) > 0),
	);
	const reasons = [
		...assessment.missingServices.map((name) => `${name} has no container`),
		...problems.map((item) => {
			const restarts = restartedDuringCheck(item.container);
			return `${containerLabel(item.container)} ${item.state}${
				restarts > 0 ? ` (restarted ${restarts} time(s) during the check)` : ""
			}`;
		}),
	];

	const problemIds = new Set(problems.map((item) => item.container.id));
	await log(
		[
			`Containers of ${service.appName} on ${executor.host.name}:`,
			...assessment.containers.map(
				(item) =>
					`  ${problemIds.has(item.container.id) ? "✗" : item.verdict === "ignored" ? "·" : "✓"} ${containerLabel(item.container)}: ${item.state}${
						item.container.error ? ` (${item.container.error})` : ""
					}`,
			),
			...assessment.missingServices.map(
				(name) => `  ✗ ${name}: runs on the source, no container on the target`,
			),
			...(probeError ? [`  docker inspect: ${truncate(probeError, 500)}`] : []),
		].join("\n"),
	);
	// One at a time so each container's report stays together in the log.
	await sequentially(
		problems.slice(0, DIAGNOSED_CONTAINERS_MAX),
		async ({ container }) => {
			const probes = container.health?.log.slice(-HEALTH_PROBES_SHOWN) ?? [];
			if (probes.length > 0) {
				await log(
					`Last healthchecks of ${container.name}:\n${probes
						.map((probe) =>
							indent(
								`[${probe.start ?? "?"}] exit ${probe.exitCode ?? "?"}: ${truncate(
									probe.output || "(no output)",
									HEALTH_OUTPUT_MAX_LENGTH,
								)}`,
							),
						)
						.join("\n")}`,
				);
			}
			const logs = await executor.run(
				getContainerLogsCommand(container.name, LOG_TAIL_LINES),
				{ allowFailure: true },
			);
			const output = logs.stdout.trimEnd();
			await log(
				output
					? `Last log lines of ${container.name}:\n${indent(output)}`
					: `No log output from ${container.name}`,
			);
		},
	);
	throw new Error(
		`${service.appName} is not healthy on ${executor.host.name}${
			timedOut ? ` after ${Math.round((clock.now() - started) / 1000)}s` : ""
		}: ${reasons.join("; ") || "no container found"}`,
	);
};
