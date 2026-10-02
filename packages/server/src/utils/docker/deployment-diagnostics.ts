import { quote } from "shell-quote";
import { formatDeploymentError } from "../process/deployment-error";

/**
 * Failure diagnostics for runtime containers. They are collected before a
 * failed release is torn down, because `docker compose down` deletes the
 * containers together with the only copy of their logs.
 */

export const DIAGNOSTICS_LOG_TAIL_LINES = 200;
const DIAGNOSTICS_MAX_LINE_LENGTH = 2000;
const DIAGNOSTICS_COMMAND_TIMEOUT_SECONDS = 30;
const SUMMARY_LOG_LINES = 15;
const SUMMARY_MAX_LINE_LENGTH = 300;
const SUMMARY_MAX_PROBE_OUTPUT = 500;
const REPORT_HEALTH_PROBES = 3;

export type DiagnosticsSeverity = "failing" | "stopped" | "ok";

export interface DiagnosticsHealthProbe {
	start?: string;
	exitCode?: number;
	output: string;
}

export interface DiagnosticsEntry {
	/** Compose service name. */
	service: string;
	/** Container name or Swarm task name. */
	reference: string;
	/** Short human readable state, e.g. "running, unhealthy". */
	status: string;
	severity: DiagnosticsSeverity;
	details: string[];
	healthProbes: DiagnosticsHealthProbe[];
	logs: string;
}

export type DiagnosticsExecutor = (
	command: string,
) => Promise<{ stdout: string; stderr: string }>;

export interface DiagnosticsResult {
	/** Full report appended to the deployment log, one chunk per section. */
	sections: string[];
	/** Short digest of the failing units, shown in the deployment error. */
	summary: string;
}

interface DockerContainerState {
	Status?: string;
	Running?: boolean;
	Restarting?: boolean;
	OOMKilled?: boolean;
	Dead?: boolean;
	ExitCode?: number;
	Error?: string;
	StartedAt?: string;
	FinishedAt?: string;
	Health?: {
		Status?: string;
		FailingStreak?: number;
		Log?: Array<{
			Start?: string;
			End?: string;
			ExitCode?: number;
			Output?: string;
		}> | null;
	} | null;
}

const withCommandTimeout = (command: string) =>
	`run_bounded() { if command -v timeout >/dev/null 2>&1; then timeout ${DIAGNOSTICS_COMMAND_TIMEOUT_SECONDS} "$@"; else "$@"; fi; }; ${command}`;

// Only the fields needed for diagnostics: a full `docker inspect` would also
// return Config.Env, which contains the service secrets.
const containerInspectFormat = (serviceLabel: string) =>
	`[{{json .Name}},{{json (index .Config.Labels ${JSON.stringify(
		serviceLabel,
	)})}},{{json .RestartCount}},{{json .State}}]`;

export const getContainersInspectCommand = (
	labels: string[],
	serviceLabel: string,
) =>
	withCommandTimeout(
		`ids="$(run_bounded docker ps -aq ${labels
			.map((label) => `--filter ${quote([`label=${label}`])}`)
			.join(
				" ",
			)})"; if [ -n "$ids" ]; then run_bounded docker inspect --format ${quote([
			containerInspectFormat(serviceLabel),
		])} $ids; fi`,
	);

export const getComposeProjectContainersInspectCommand = (
	projectName: string,
) =>
	getContainersInspectCommand(
		[`com.docker.compose.project=${projectName}`],
		"com.docker.compose.service",
	);

/** Output is merged and line-truncated so a single call stays bounded. */
export const getContainerLogsCommand = (
	containerName: string,
	tailLines = DIAGNOSTICS_LOG_TAIL_LINES,
) =>
	withCommandTimeout(
		`run_bounded docker logs --timestamps --tail ${tailLines} ${quote([
			containerName,
		])} 2>&1 | cut -c1-${DIAGNOSTICS_MAX_LINE_LENGTH}`,
	);

const truncate = (value: string, length: number) =>
	value.length > length ? `${value.slice(0, length)}…` : value;

const classifyContainer = (
	state: DockerContainerState,
): { severity: DiagnosticsSeverity; status: string } => {
	const status = state.Status || "unknown";
	const health = state.Health?.Status;
	if (state.OOMKilled)
		return { severity: "failing", status: `${status}, OOM killed` };
	if (status === "running") {
		if (health === "unhealthy")
			return { severity: "failing", status: "running, unhealthy" };
		if (health === "starting")
			return {
				severity: "failing",
				status: "running, healthcheck still starting",
			};
		return {
			severity: "ok",
			status: health ? `running, ${health}` : "running",
		};
	}
	if (status === "exited") {
		const exitStatus = `exited (code ${state.ExitCode ?? "unknown"})`;
		return {
			severity: state.ExitCode === 0 ? "stopped" : "failing",
			status: exitStatus,
		};
	}
	if (status === "created")
		return { severity: "stopped", status: "created, never started" };
	return { severity: "failing", status };
};

export const parseContainersInspect = (
	stdout: string,
): Array<Omit<DiagnosticsEntry, "logs">> =>
	stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [name, service, restartCount, state] = JSON.parse(line) as [
				string,
				string | null,
				number | null,
				DockerContainerState | null,
			];
			const reference = String(name || "").replace(/^\//, "");
			const containerState = state || {};
			const { severity, status } = classifyContainer(containerState);
			const details: string[] = [];
			if (
				containerState.Status !== "running" &&
				containerState.ExitCode !== undefined
			)
				details.push(`Exit code: ${containerState.ExitCode}`);
			if (containerState.OOMKilled)
				details.push("Killed by the kernel because it ran out of memory (OOM)");
			if (containerState.Error)
				details.push(`Docker error: ${containerState.Error}`);
			if (restartCount) details.push(`Restarts: ${restartCount}`);
			if (containerState.Health?.FailingStreak)
				details.push(
					`Consecutive failed healthchecks: ${containerState.Health.FailingStreak}`,
				);
			if (
				containerState.StartedAt &&
				!containerState.StartedAt.startsWith("0001")
			)
				details.push(`Started at: ${containerState.StartedAt}`);
			if (
				containerState.Status !== "running" &&
				containerState.FinishedAt &&
				!containerState.FinishedAt.startsWith("0001")
			)
				details.push(`Finished at: ${containerState.FinishedAt}`);
			return {
				service: service || reference,
				reference,
				status,
				severity,
				details,
				healthProbes: (containerState.Health?.Log || [])
					.slice(-REPORT_HEALTH_PROBES)
					.map((probe) => ({
						start: probe.Start,
						exitCode: probe.ExitCode,
						output: (probe.Output || "").trim(),
					})),
			};
		});

const severityRank: Record<DiagnosticsSeverity, number> = {
	failing: 0,
	stopped: 1,
	ok: 2,
};

export const sortDiagnosticsEntries = <
	T extends Pick<DiagnosticsEntry, "severity" | "service">,
>(
	entries: T[],
) =>
	[...entries].sort(
		(left, right) =>
			severityRank[left.severity] - severityRank[right.severity] ||
			left.service.localeCompare(right.service),
	);

const severityMarker: Record<DiagnosticsSeverity, string> = {
	failing: "✗",
	stopped: "!",
	ok: "✓",
};

const formatProbe = (probe: DiagnosticsHealthProbe, maxOutput?: number) => {
	const output = probe.output || "(no output)";
	return `[${probe.start || "unknown time"}] exit ${probe.exitCode ?? "?"}: ${
		maxOutput ? truncate(output, maxOutput) : output
	}`;
};

const indent = (value: string, prefix = "  ") =>
	value
		.split("\n")
		.map((line) => `${prefix}${line}`)
		.join("\n");

export const formatDiagnosticsReport = (
	title: string,
	entries: DiagnosticsEntry[],
): string[] => {
	const sorted = sortDiagnosticsEntries(entries);
	const header = [`\n===== ${title} =====`];
	if (sorted.length === 0) {
		header.push("No containers were found for this release.");
		return [`${header.join("\n")}\n`];
	}
	const width = Math.max(...sorted.map((entry) => entry.service.length));
	header.push(
		...sorted.map(
			(entry) =>
				`${severityMarker[entry.severity]} ${entry.service.padEnd(width)}  ${entry.status}`,
		),
	);
	return [
		`${header.join("\n")}\n`,
		...sorted.map((entry) => {
			const lines = [
				`\n----- ${entry.service} (${entry.reference}): ${entry.status} -----`,
				...entry.details,
			];
			if (entry.healthProbes.length > 0) {
				lines.push(
					"Last healthcheck probes:",
					...entry.healthProbes.map((probe) => indent(formatProbe(probe))),
				);
			}
			const logs = entry.logs.trimEnd();
			lines.push(
				logs
					? `Last ${logs.split("\n").length} log lines:\n${logs}`
					: "No log output was captured.",
			);
			return `${lines.join("\n")}\n`;
		}),
	];
};

export const summarizeDiagnostics = (
	title: string,
	entries: DiagnosticsEntry[],
): string => {
	const sorted = sortDiagnosticsEntries(entries);
	const lines = ["Container diagnostics:"];
	if (sorted.length === 0) {
		lines.push("- No containers were found for this release.");
	}
	for (const entry of sorted) {
		if (entry.severity === "ok") continue;
		lines.push(`- ${entry.service}: ${entry.status}`);
		for (const detail of entry.details) lines.push(`  ${detail}`);
		const lastProbe = entry.healthProbes.at(-1);
		if (lastProbe && entry.severity === "failing") {
			lines.push(
				`  Last healthcheck: ${formatProbe(lastProbe, SUMMARY_MAX_PROBE_OUTPUT).replace(/\n+/g, " ")}`,
			);
		}
		const logLines = entry.logs.trimEnd().split("\n").filter(Boolean);
		if (logLines.length > 0) {
			lines.push(
				`  Last ${Math.min(SUMMARY_LOG_LINES, logLines.length)} log lines:`,
			);
			lines.push(
				...logLines
					.slice(-SUMMARY_LOG_LINES)
					.map((line) => `    ${truncate(line, SUMMARY_MAX_LINE_LENGTH)}`),
			);
		}
	}
	const healthy = sorted.filter((entry) => entry.severity === "ok");
	if (healthy.length > 0) {
		lines.push(
			`- Running normally: ${healthy.map((entry) => `${entry.service} (${entry.status})`).join(", ")}`,
		);
	}
	lines.push(
		`Full logs of every container are in the deployment log, section "${title}".`,
	);
	return lines.join("\n");
};

// Remote appends pass the content as one base64 shell argument, and Linux
// caps a single argument at 128 KiB (MAX_ARG_STRLEN).
const MAX_SHELL_APPEND_BYTES = 48 * 1024;

/** Split log content on line boundaries into shell-argument-sized pieces. */
export const chunkLogContent = (
	content: string,
	maxBytes = MAX_SHELL_APPEND_BYTES,
): string[] => {
	const chunks: string[] = [];
	let current = "";
	let currentBytes = 0;
	const flush = () => {
		if (current) chunks.push(current);
		current = "";
		currentBytes = 0;
	};
	for (const line of content.split(/(?<=\n)/)) {
		const lineBytes = Buffer.byteLength(line);
		if (currentBytes + lineBytes > maxBytes) flush();
		if (lineBytes <= maxBytes) {
			current += line;
			currentBytes += lineBytes;
			continue;
		}
		for (const character of line) {
			const characterBytes = Buffer.byteLength(character);
			if (currentBytes + characterBytes > maxBytes) flush();
			current += character;
			currentBytes += characterBytes;
		}
	}
	flush();
	return chunks;
};

const describeCollectionError = (error: unknown) =>
	formatDeploymentError(error).replace(/\n+/g, " ");

export interface ContainerDiagnosticsTarget {
	/** Docker label filters selecting the containers to diagnose. */
	labels: string[];
	/** Label holding the service name of each container. */
	serviceLabel: string;
	/** Deployment log section title. */
	title: string;
	/** Maps the service label value to the name shown to developers. */
	serviceName?: (label: string) => string;
}

/**
 * Collects state, healthcheck probes and recent logs of every selected
 * container. Never throws: a diagnostics failure must not hide the deployment
 * error that triggered it.
 */
export const collectContainerDiagnostics = async (
	execute: DiagnosticsExecutor,
	target: ContainerDiagnosticsTarget,
): Promise<DiagnosticsResult> => {
	const { title } = target;
	let containers: Array<Omit<DiagnosticsEntry, "logs">>;
	try {
		const { stdout } = await execute(
			getContainersInspectCommand(target.labels, target.serviceLabel),
		);
		containers = parseContainersInspect(stdout).map((container) => ({
			...container,
			service: target.serviceName?.(container.service) ?? container.service,
		}));
	} catch (error) {
		const message = `Container diagnostics could not be collected: ${describeCollectionError(error)}`;
		return {
			sections: [`\n===== ${title} =====\n${message}\n`],
			summary: message,
		};
	}

	const entries: DiagnosticsEntry[] = [];
	// Sequential on purpose: each remote call opens its own SSH connection.
	for (const container of sortDiagnosticsEntries(containers)) {
		let logs: string;
		try {
			logs = (await execute(getContainerLogsCommand(container.reference)))
				.stdout;
		} catch (error) {
			logs = `Logs could not be read: ${describeCollectionError(error)}`;
		}
		entries.push({ ...container, logs });
	}

	return {
		sections: formatDiagnosticsReport(title, entries),
		summary: summarizeDiagnostics(title, entries),
	};
};

export const collectComposeReleaseDiagnostics = (
	execute: DiagnosticsExecutor,
	projectName: string,
) =>
	collectContainerDiagnostics(execute, {
		labels: [`com.docker.compose.project=${projectName}`],
		serviceLabel: "com.docker.compose.service",
		title: "Diagnostics: candidate containers",
	});
