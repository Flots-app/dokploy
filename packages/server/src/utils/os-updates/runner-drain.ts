/**
 * The drain an OS update run puts on a Linux GitHub runner machine, as the two
 * controllers that see it share it (in the database: they may lead in two
 * different Dokploy processes):
 * - the OS updates controller starts it, waits until the machine is empty,
 *   installs, then gives the machine back, whatever the outcome (installed,
 *   failed, cancelled, the window closed while jobs still ran);
 * - the runner controller treats it as any drain in "wait" mode (no new job,
 *   idle runners leave, the running jobs end: never interrupted) and, once
 *   the machine is empty and can no longer arm itself, only records it
 *   (drainedAt). It leaves an installing machine alone, and gives back the
 *   machines whose run ended without doing it.
 */
import { db } from "@dokploy/server/db";
import {
	type GithubRunnerDrain,
	githubRunnerNodes,
	osUpdateRuns,
} from "@dokploy/server/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";

export type OsUpdateDrain = GithubRunnerDrain & {
	reason: "os-update";
	osUpdateRunId: string;
};

export const isOsUpdateDrain = (
	drain: GithubRunnerDrain | null | undefined,
): drain is OsUpdateDrain =>
	drain?.reason === "os-update" && typeof drain.osUpdateRunId === "string";

/** The run installs (and may reboot): nothing may give the machine jobs. */
export const isOsUpdateInstalling = (
	drain: GithubRunnerDrain | null | undefined,
) => isOsUpdateDrain(drain) && Boolean(drain.installingAt);

/**
 * A condition for the updates that change a runner machine's drain or phase
 * from an operator action: never while an OS update run installs.
 */
export const notInstallingOsUpdates = () =>
	sql`NOT (coalesce(${githubRunnerNodes.drain}->>'reason', '') = 'os-update' AND ${githubRunnerNodes.drain}->>'installingAt' IS NOT NULL)`;

export const osUpdateInstallingMessage = (name: string) =>
	`OS updates are being installed on ${name} (a maintenance run, see OS Updates): it takes no other change until the run gives it back`;

/** Refuses an operator action that would end or replace the drain of an install. */
export const assertNotInstallingOsUpdates = (node: {
	name: string;
	drain: GithubRunnerDrain | null;
}) => {
	if (isOsUpdateInstalling(node.drain)) {
		throw new Error(osUpdateInstallingMessage(node.name));
	}
};

/** The machine's drain, as long as it is this run's. */
const drainOf = (runId: string) =>
	and(
		eq(githubRunnerNodes.phase, "draining"),
		sql`${githubRunnerNodes.drain}->>'reason' = 'os-update'`,
		sql`${githubRunnerNodes.drain}->>'osUpdateRunId' = ${runId}`,
	);

/**
 * Takes a ready (or stopped) Linux machine out of service for a run: no new
 * job from now on. False when the machine is busy with something else (an
 * operator drain, the runner controller's own updates) or not set up.
 * `abortAt`: the runner controller gives the machine back from then on if
 * the run never started installing (its process stopped for good).
 */
export const startOsUpdateDrain = async (input: {
	nodeId: string;
	runId: string;
	abortAt: Date;
}) => {
	const drain: OsUpdateDrain = {
		mode: "wait",
		reason: "os-update",
		requestedAt: new Date().toISOString(),
		deadline: null,
		operationId: null,
		abortAt: input.abortAt.toISOString(),
		osUpdateRunId: input.runId,
		drainedAt: null,
		installingAt: null,
	};
	const rows = await db
		.update(githubRunnerNodes)
		.set({ phase: "draining", drain })
		.where(
			and(
				eq(githubRunnerNodes.githubRunnerNodeId, input.nodeId),
				eq(githubRunnerNodes.platform, "linux"),
				inArray(githubRunnerNodes.phase, ["ready", "stopped"]),
				sql`${githubRunnerNodes.drain} IS NULL`,
			),
		)
		.returning({ id: githubRunnerNodes.githubRunnerNodeId });
	return rows.length > 0;
};

/** The runner controller found the machine empty: the run may install. */
export const markOsUpdateDrained = async (nodeId: string, runId: string) => {
	const rows = await db
		.update(githubRunnerNodes)
		.set({
			drain: sql`${githubRunnerNodes.drain} || jsonb_build_object('drainedAt', ${new Date().toISOString()}::text)`,
		})
		.where(
			and(
				eq(githubRunnerNodes.githubRunnerNodeId, nodeId),
				drainOf(runId),
				sql`${githubRunnerNodes.drain}->>'drainedAt' IS NULL`,
			),
		)
		.returning({ id: githubRunnerNodes.githubRunnerNodeId });
	if (rows.length) wakeOsUpdateDrains();
	return rows.length > 0;
};

/**
 * The run starts installing: from now on the machine stays out of service
 * until the run gives it back. False when the drain is no longer the run's
 * (an operator put the machine back to work, disabled or removed it).
 */
export const markOsUpdateInstalling = async (nodeId: string, runId: string) =>
	(
		await db
			.update(githubRunnerNodes)
			.set({
				drain: sql`${githubRunnerNodes.drain} || jsonb_build_object('installingAt', ${new Date().toISOString()}::text)`,
			})
			.where(
				and(
					eq(githubRunnerNodes.githubRunnerNodeId, nodeId),
					drainOf(runId),
					sql`${githubRunnerNodes.drain}->>'drainedAt' IS NOT NULL`,
				),
			)
			.returning({ id: githubRunnerNodes.githubRunnerNodeId })
	).length > 0;

/**
 * Gives the machine back: it takes jobs again (stopped when an operator
 * disabled it meanwhile). Nothing happens when the drain is no longer the
 * run's. True when the machine was given back.
 */
export const releaseOsUpdateDrain = async (nodeId: string, runId: string) =>
	(
		await db
			.update(githubRunnerNodes)
			.set({
				phase: sql`CASE WHEN ${githubRunnerNodes.enabled} THEN 'ready'::"githubRunnerNodePhase" ELSE 'stopped'::"githubRunnerNodePhase" END`,
				drain: null,
			})
			.where(
				and(eq(githubRunnerNodes.githubRunnerNodeId, nodeId), drainOf(runId)),
			)
			.returning({ id: githubRunnerNodes.githubRunnerNodeId })
	).length > 0;

/**
 * What the runner controller tells of a machine under an OS update drain:
 * empty (no runner process left, no job GitHub still sees on it) and unable
 * to arm itself. A runtime that keeps a reserve (autonomy) must report it
 * off: a machine that may still arm itself is never handed over.
 */
export const osUpdateDrainComplete = (input: {
	/** The planner of the machine found it drained (no live slot, no busy runner). */
	drained: boolean;
	runtime: { runtimeVersion: number; autonomySetting: string | null } | null;
	/** The first runtime with autonomy. */
	autonomyRuntime: number;
}) =>
	input.drained &&
	input.runtime !== null &&
	(input.runtime.runtimeVersion < input.autonomyRuntime ||
		input.runtime.autonomySetting === "off");

/**
 * What the runner controller does with an OS update drain at each tick of
 * the machine, from its planner's verdict: hands the machine over once it is
 * empty and cannot arm itself, never earlier. True when it did now.
 */
export const settleOsUpdateDrain = async (input: {
	nodeId: string;
	drain: GithubRunnerDrain | null;
	drained: boolean;
	runtime: { runtimeVersion: number; autonomySetting: string | null } | null;
	autonomyRuntime: number;
}) => {
	const { drain } = input;
	if (!isOsUpdateDrain(drain) || drain.drainedAt) return false;
	if (!osUpdateDrainComplete(input)) return false;
	return markOsUpdateDrained(input.nodeId, drain.osUpdateRunId);
};

/**
 * Machines whose OS update drain outlived its run: the run ended (or was
 * purged) without giving the machine back, or its process stopped before
 * installing and the window closed (abortAt). The runner controller gives
 * them back. A run that installs is left alone: its next leader resumes it.
 */
export const staleOsUpdateDrains = async <
	Node extends { githubRunnerNodeId: string; drain: GithubRunnerDrain | null },
>(
	nodes: Node[],
	now: number,
): Promise<Node[]> => {
	const drained = nodes.filter((node) => isOsUpdateDrain(node.drain));
	if (!drained.length) return [];
	const runs = await db
		.select({
			osUpdateRunId: osUpdateRuns.osUpdateRunId,
			status: osUpdateRuns.status,
		})
		.from(osUpdateRuns)
		.where(
			inArray(
				osUpdateRuns.osUpdateRunId,
				drained.map((node) => (node.drain as OsUpdateDrain).osUpdateRunId),
			),
		);
	const status = new Map(runs.map((run) => [run.osUpdateRunId, run.status]));
	return drained.filter((node) => {
		const drain = node.drain as OsUpdateDrain;
		const current = status.get(drain.osUpdateRunId);
		if (current !== "running" && current !== "pending") return true;
		return (
			!drain.installingAt &&
			Boolean(drain.abortAt) &&
			now >= Date.parse(drain.abortAt ?? "")
		);
	});
};

// ------------------------------------------------------------- wake-ups

/**
 * Runs waiting for their machine to empty poll the database; the runner
 * controller of the same process wakes them as soon as it records it. Shared
 * across the module copies of a process, as the controllers' state is.
 */
const shared = globalThis as {
	__dokployOsUpdateDrainWaiters?: Set<() => void>;
};
shared.__dokployOsUpdateDrainWaiters ??= new Set();
const waiters = shared.__dokployOsUpdateDrainWaiters;

export const wakeOsUpdateDrains = () => {
	for (const wake of [...waiters]) wake();
};

/** Sleeps `ms`, or less when a drain is recorded meanwhile. */
export const sleepUntilDrainNews = (ms: number) =>
	new Promise<void>((resolve) => {
		const done = () => {
			clearTimeout(timer);
			waiters.delete(done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		waiters.add(done);
	});
