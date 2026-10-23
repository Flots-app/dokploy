/**
 * What needs an operator's attention on a pool or a machine, sent through
 * Dokploy's notifications ("GitHub Runners" in Settings › Notifications).
 * A condition is an open alert while it lasts: it is notified once it has
 * lasted its delay, again when it gets worse and every day while it is
 * critical, and once more when it is resolved.
 */
import { db } from "@dokploy/server/db";
import {
	type GithubRunnerAlert,
	type GithubRunnerAlertSeverity,
	type GithubRunnerNode,
	type GithubRunnerPool,
	githubRunnerAlerts,
} from "@dokploy/server/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { type OsRelease, osStatus } from "./os";
import { effectiveUpdatePolicy } from "./updates";
import { machineRunnerStatus, type RunnerReleaseInfo } from "./versions";

export type RunnerAlertKind =
	| "unreachable"
	| "error"
	| "disk"
	| "runner-version"
	| "update-failed"
	| "os-patch"
	| "rollout-runner"
	| "rollout-runtime"
	| "os-host"
	| "os-guest"
	| "firewall"
	| "fallback"
	| "routing"
	| "no-capacity"
	| "token";

export interface RunnerAlertCondition {
	/** "<pool or machine id>:<kind>": one open alert per subject. */
	subject: string;
	poolId: string;
	nodeId: string | null;
	kind: RunnerAlertKind;
	severity: GithubRunnerAlertSeverity;
	title: string;
	message: string;
	/** Notified once the condition has lasted this long. */
	delayMs: number;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** A critical alert still open is notified again after this long. */
export const ALERT_REMINDER_MS = DAY;
/** A token expiring within this delay is a warning, then critical. */
export const TOKEN_WARNING_MS = 14 * DAY;
export const TOKEN_CRITICAL_MS = 3 * DAY;

const day = (time: string | number) =>
	new Date(time).toISOString().slice(0, 10);

/** Whether the controller runs jobs on the machine. */
const active = (node: GithubRunnerNode) =>
	node.enabled && (node.phase === "ready" || node.phase === "draining");

/** Not set up yet: nothing to watch until the first provisioning ends. */
const settingUp = (node: GithubRunnerNode) =>
	node.phase === "enrolling" ||
	node.phase === "new" ||
	node.phase === "provisioning";

const accepting = (node: GithubRunnerNode) =>
	active(node) &&
	node.phase === "ready" &&
	!node.drain &&
	node.observed?.reachable !== false &&
	node.observed?.admission?.ok !== false;

/**
 * GitHub sends the expiry of a personal access token as "2026-11-02 10:00:00
 * UTC" (or with an offset such as "-0800").
 */
export const parseTokenExpiration = (value: string | null) => {
	const match = value
		?.trim()
		.match(
			/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/,
		);
	if (!match) return null;
	const [, date, time, zone] = match;
	const offset =
		!zone || zone === "UTC" || zone === "Z"
			? "Z"
			: `${zone.slice(0, 3)}:${zone.slice(-2)}`;
	const parsed = Date.parse(`${date}T${time}${offset}`);
	return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};

const machineConditions = (input: {
	pool: GithubRunnerPool;
	node: GithubRunnerNode;
	now: number;
	runnerReleases: RunnerReleaseInfo[];
	osReleases: (id: string) => OsRelease[] | null;
	unknown: (subject: string) => void;
}): RunnerAlertCondition[] => {
	const { pool, node, now } = input;
	if (settingUp(node)) return [];
	const conditions: RunnerAlertCondition[] = [];
	const unknown = (kind: RunnerAlertKind) =>
		input.unknown(`${node.githubRunnerNodeId}:${kind}`);
	const add = (
		kind: RunnerAlertKind,
		severity: GithubRunnerAlertSeverity,
		title: string,
		message: string,
		delayMs = 0,
	) =>
		conditions.push({
			subject: `${node.githubRunnerNodeId}:${kind}`,
			poolId: pool.githubRunnerPoolId,
			nodeId: node.githubRunnerNodeId,
			kind,
			severity,
			title,
			message,
			delayMs,
		});
	const name = node.name;
	if (node.phase === "error") {
		add(
			"error",
			"critical",
			`${name} needs an operator`,
			node.lastError ?? "The last operation on the machine failed.",
		);
	}
	if (active(node) && node.observed?.reachable === false) {
		add(
			"unreachable",
			"critical",
			`${name} is unreachable`,
			`Dokploy cannot reach ${name} (${node.host}) since ${node.lastSeenAt ? new Date(node.lastSeenAt).toISOString().replace("T", " ").slice(0, 16) : "it was set up"} UTC: ${node.observed.error ?? node.lastError ?? "no answer"}. It takes no job until it answers again.`,
			3 * MINUTE,
		);
	}
	if (
		active(node) &&
		node.observed?.reachable !== false &&
		node.observed?.admission?.ok === false
	) {
		add(
			"disk",
			"warning",
			`${name} takes no new jobs`,
			`${node.observed.admission.reason ?? "Its disk is below the reserve"}. Free some space on it, or lower its disk reserve in the machine settings.`,
			10 * MINUTE,
		);
	}
	if (node.firewall?.error && node.enabled) {
		add(
			"firewall",
			"critical",
			`Firewall not applied on ${name}`,
			`${node.firewall.error}. The machine takes no job until its firewall is in place.`,
			2 * MINUTE,
		);
	}
	const updateError = node.enabled ? (node.updateState?.error ?? null) : null;
	if (updateError) {
		add(
			"update-failed",
			"warning",
			`Update failed on ${name}`,
			`${updateError}. Dokploy tries again every 30 minutes; "Update now" in the machine menu tries at once.`,
		);
	}
	// Lasts while Dokploy would still install them: turned off, or installed
	// by hand, the failure no longer matters.
	const patchable =
		node.platform === "macos"
			? (node.osReport?.guest ?? null)
			: (node.osReport?.host ?? null);
	if (node.enabled && node.updateState?.patchError) {
		if (!patchable) unknown("os-patch");
		else if (
			effectiveUpdatePolicy(pool, node).osPatches &&
			((patchable.updates ?? 0) > 0 || patchable.reboot === true)
		) {
			add(
				"os-patch",
				"warning",
				`OS updates failed on ${name}`,
				`${node.updateState.patchError}. Dokploy tries again in the next update window.`,
			);
		}
	}
	// A disabled machine is updated once enabled: nothing to tell until then.
	const runner = machineRunnerStatus(pool, node, input.runnerReleases, now);
	if (!node.enabled) {
		// No condition: an alert left open resolves.
	} else if (!input.runnerReleases.length) unknown("runner-version");
	else if (runner.state === "unsupported") {
		add(
			"runner-version",
			"critical",
			`Runner too old on ${name}`,
			runner.message,
		);
	} else if (runner.state === "outdated" && !updateError) {
		add(
			"runner-version",
			"warning",
			`Runner outdated on ${name}`,
			runner.message,
		);
	}
	const systems = [
		["os-host", node.osReport?.host ?? null, ""],
		[
			"os-guest",
			node.platform === "macos" ? (node.osReport?.guest ?? null) : null,
			" (VM)",
		],
	] as const;
	for (const [kind, info, where] of systems) {
		// No report (VM stopped, report failed) or support dates not read yet:
		// what was known holds.
		const releases = info ? input.osReleases(info.id) : null;
		if (!info || !releases) {
			if (kind === "os-host" || node.platform === "macos") unknown(kind);
			continue;
		}
		const status = osStatus({ info, releases, now });
		if (status.state === "unsupported") {
			add(
				kind,
				"critical",
				`Unsupported OS on ${name}${where}`,
				status.message,
			);
		} else if (status.state === "outdated") {
			// Security updates come out every week: worth a notification only
			// when nobody installed them for a few days.
			add(
				kind,
				"warning",
				`OS updates needed on ${name}${where}`,
				status.message,
				3 * DAY,
			);
		}
	}
	return conditions;
};

export interface RunnerAlertInput {
	pool: GithubRunnerPool;
	nodes: GithubRunnerNode[];
	now: number;
	/** Known actions/runner releases; empty while not read yet. */
	runnerReleases: RunnerReleaseInfo[];
	/** Release lines of an OS product; null while not read yet. */
	osReleases: (id: string) => OsRelease[] | null;
	/** What GitHub said of the pool's personal access token; null while not asked yet. */
	token: { valid: boolean; expiresAt: string | null } | null;
}

/**
 * Conditions of a pool and of its machines now, and the subjects that cannot
 * be told yet (a process that just took the lead has not read the releases,
 * a stopped VM sends no OS report): their alerts stay as they are.
 */
export const runnerAlerts = (
	input: RunnerAlertInput,
): { conditions: RunnerAlertCondition[]; unknown: string[] } => {
	const { pool, nodes, now } = input;
	const poolId = pool.githubRunnerPoolId;
	const unknown: string[] = [];
	const conditions = nodes.flatMap((node) =>
		machineConditions({
			...input,
			node,
			unknown: (subject) => unknown.push(subject),
		}),
	);
	const add = (
		kind: RunnerAlertKind,
		severity: GithubRunnerAlertSeverity,
		title: string,
		message: string,
		delayMs = 0,
	) =>
		conditions.push({
			subject: `${poolId}:${kind}`,
			poolId,
			nodeId: null,
			kind,
			severity,
			title,
			message,
			delayMs,
		});
	// Planned OS updates take a machine out on purpose: they are not a lack of capacity.
	const enabled = nodes.filter(
		(node) =>
			node.enabled && !settingUp(node) && node.drain?.reason !== "patch",
	);
	if (pool.routingVariable && pool.routing?.target === "fallback") {
		add(
			"fallback",
			"warning",
			`${pool.name}: jobs run on GitHub-hosted runners`,
			`No machine of ${pool.name} can take jobs since ${day(pool.routing.since)}: jobs of private repositories run on ${pool.fallbackLabels.join(", ")} until one can again.`,
		);
	} else if (
		!pool.routingVariable &&
		enabled.length &&
		!enabled.some(accepting)
	) {
		add(
			"no-capacity",
			"critical",
			`${pool.name}: no machine takes jobs`,
			`None of the machines of ${pool.name} can take jobs, and the pool has no fallback: jobs wait in GitHub's queue. See the machines on the GitHub Runners page.`,
			5 * MINUTE,
		);
	}
	const names = new Map(
		nodes.map((node) => [node.githubRunnerNodeId, node.name]),
	);
	for (const kind of ["runner", "runtime"] as const) {
		const rollout = pool.rollouts?.[kind];
		if (!rollout?.failedAt) continue;
		const canary = names.get(rollout.canaryNodeId) ?? "its canary";
		const what = kind === "runner" ? "actions/runner" : "the Dokploy runtime";
		add(
			`rollout-${kind}`,
			"warning",
			`${pool.name}: rollout of ${what} ${rollout.target} paused`,
			`The update failed on ${canary}, the first machine to install it: ${rollout.error ?? "unknown error"}. The other machines keep their release until the rollout is resumed from the pool.`,
		);
	}
	if (pool.routingVariable && pool.routing?.error) {
		add(
			"routing",
			"warning",
			`${pool.name}: routing variable not written`,
			`Dokploy could not write ${pool.routingVariable} on GitHub: ${pool.routing.error}. Jobs keep the runners it last named.`,
			10 * MINUTE,
		);
	}
	const token = pool.authType === "token" ? input.token : null;
	const expiresAt = parseTokenExpiration(token?.expiresAt ?? null);
	if (pool.authType === "token" && !token) unknown.push(`${poolId}:token`);
	if (token && !token.valid) {
		add(
			"token",
			"critical",
			`${pool.name}: GitHub token rejected`,
			`GitHub rejects the token of ${pool.name}: it expired or was revoked. Create a new one on GitHub and paste it in the pool settings: without it, Dokploy cannot start runners.`,
		);
	} else if (expiresAt) {
		const left = Date.parse(expiresAt) - now;
		if (left <= TOKEN_WARNING_MS) {
			add(
				"token",
				left <= TOKEN_CRITICAL_MS ? "critical" : "warning",
				`${pool.name}: GitHub token expires soon`,
				`The token of ${pool.name} expires on ${day(expiresAt)}. Create a new one on GitHub and paste it in the pool settings: without it, Dokploy cannot start runners.`,
			);
		}
	}
	return { conditions, unknown };
};

/** Conditions of a pool and of its machines, now. */
export const runnerAlertConditions = (input: RunnerAlertInput) =>
	runnerAlerts(input).conditions;

export type RunnerNoticeEvent =
	| "opened"
	| "worse"
	| "reminder"
	| "resolved"
	| "info";

/** One notification, ready for the notification channels. */
export interface RunnerNotice {
	event: RunnerNoticeEvent;
	severity: GithubRunnerAlertSeverity | "info";
	title: string;
	message: string;
	pool: string;
	machine: string | null;
	at: Date;
}

const changed = (row: GithubRunnerAlert, condition: RunnerAlertCondition) =>
	row.severity !== condition.severity ||
	row.title !== condition.title ||
	row.message !== condition.message;

/**
 * Brings the open alerts of a pool in line with its conditions and returns
 * what to notify. Every change is a conditional write: when several Dokploy
 * instances evaluate the same pool, only the one whose write lands notifies.
 */
export const syncRunnerAlerts = async (input: {
	pool: GithubRunnerPool;
	nodes: GithubRunnerNode[];
	conditions: RunnerAlertCondition[];
	/** Subjects that cannot be told now: their open alerts stay as they are. */
	unknown?: string[];
	now: number;
}): Promise<RunnerNotice[]> => {
	const { pool, now } = input;
	const at = new Date(now);
	const iso = at.toISOString();
	const machineName = (nodeId: string | null) =>
		input.nodes.find((node) => node.githubRunnerNodeId === nodeId)?.name ??
		null;
	const notice = (
		event: RunnerNoticeEvent,
		alert: Pick<
			RunnerAlertCondition,
			"severity" | "title" | "message" | "nodeId"
		>,
	): RunnerNotice => ({
		event,
		severity: alert.severity,
		title: alert.title,
		message: alert.message,
		pool: pool.name,
		machine: machineName(alert.nodeId),
		at,
	});
	const open = await db.query.githubRunnerAlerts.findMany({
		where: and(
			eq(githubRunnerAlerts.githubRunnerPoolId, pool.githubRunnerPoolId),
			isNull(githubRunnerAlerts.resolvedAt),
		),
	});
	const bySubject = new Map(open.map((row) => [row.subject, row]));
	const wanted = new Set([
		...input.conditions.map((item) => item.subject),
		...(input.unknown ?? []),
	]);
	const text = (condition: RunnerAlertCondition) => ({
		severity: condition.severity,
		title: condition.title,
		message: condition.message,
	});
	// Each write concerns one alert: they run side by side.
	const sync = async (
		condition: RunnerAlertCondition,
	): Promise<RunnerNotice | null> => {
		const row = bySubject.get(condition.subject);
		if (!row) {
			const due = condition.delayMs <= 0;
			const inserted = await db
				.insert(githubRunnerAlerts)
				.values({
					githubRunnerPoolId: condition.poolId,
					githubRunnerNodeId: condition.nodeId,
					subject: condition.subject,
					kind: condition.kind,
					...text(condition),
					openedAt: iso,
					notifiedAt: due ? iso : null,
				})
				.onConflictDoNothing()
				.returning({ id: githubRunnerAlerts.githubRunnerAlertId });
			return inserted.length && due ? notice("opened", condition) : null;
		}
		const where = eq(
			githubRunnerAlerts.githubRunnerAlertId,
			row.githubRunnerAlertId,
		);
		let claim: "opened" | "worse" | "reminder" | null = null;
		if (!row.notifiedAt) {
			if (now - Date.parse(row.openedAt) >= condition.delayMs) claim = "opened";
		} else if (
			row.severity === "warning" &&
			condition.severity === "critical"
		) {
			claim = "worse";
		} else if (
			condition.severity === "critical" &&
			now - Date.parse(row.notifiedAt) >= ALERT_REMINDER_MS
		) {
			claim = "reminder";
		}
		if (claim) {
			const claimed = await db
				.update(githubRunnerAlerts)
				.set({ ...text(condition), notifiedAt: iso })
				.where(
					and(
						where,
						isNull(githubRunnerAlerts.resolvedAt),
						row.notifiedAt
							? eq(githubRunnerAlerts.notifiedAt, row.notifiedAt)
							: isNull(githubRunnerAlerts.notifiedAt),
					),
				)
				.returning({ id: githubRunnerAlerts.githubRunnerAlertId });
			return claimed.length ? notice(claim, condition) : null;
		}
		if (changed(row, condition)) {
			await db
				.update(githubRunnerAlerts)
				.set(text(condition))
				.where(and(where, isNull(githubRunnerAlerts.resolvedAt)));
		}
		return null;
	};
	const resolve = async (row: GithubRunnerAlert) => {
		const resolved = await db
			.update(githubRunnerAlerts)
			.set({ resolvedAt: iso })
			.where(
				and(
					eq(githubRunnerAlerts.githubRunnerAlertId, row.githubRunnerAlertId),
					isNull(githubRunnerAlerts.resolvedAt),
				),
			)
			.returning({ id: githubRunnerAlerts.githubRunnerAlertId });
		// An alert resolved before it was notified stays silent.
		return resolved.length && row.notifiedAt
			? notice("resolved", {
					severity: row.severity,
					title: row.title,
					message: row.message,
					nodeId: row.githubRunnerNodeId,
				})
			: null;
	};
	const notices = await Promise.all([
		...input.conditions.map(sync),
		...open.filter((row) => !wanted.has(row.subject)).map(resolve),
	]);
	return notices.filter((item): item is RunnerNotice => item !== null);
};
