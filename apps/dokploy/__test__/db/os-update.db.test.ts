import { db } from "@dokploy/server/db";
import {
	osUpdateConfigurations,
	osUpdateRuns,
	osUpdateServers,
	server,
} from "@dokploy/server/db/schema";
import {
	cancelOsUpdateRun,
	createOsUpdateConfiguration,
	installOsUpdatesNow,
	listOsUpdateServers,
	removeOsUpdateConfiguration,
	updateOsUpdateConfiguration,
} from "@dokploy/server/services/os-update";
import {
	planOsUpdateWindows,
	skipClosedOsUpdateRuns,
} from "@dokploy/server/utils/os-updates/controller";
import { DEFAULT_OS_UPDATE_SETTINGS } from "@dokploy/server/utils/os-updates/filters";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { osUpdateRouter } from "@/server/api/routers/os-update";
import {
	addMember,
	contextOf,
	createOrganization,
	type Person,
	pgErrorCode,
	removeCreatedRows,
} from "./fixtures";

const UNIQUE_VIOLATION = "23505";

type Context = Parameters<typeof osUpdateRouter.createCaller>[0];
const callerOf = (person: Person) =>
	osUpdateRouter.createCaller(contextOf(person) as unknown as Context);

let a: Person;
let b: Person;

const insertServer = async (organizationId: string, name: string) => {
	const [row] = await db
		.insert(server)
		.values({
			organizationId,
			name,
			ipAddress: "192.0.2.20",
			port: 22,
			username: "root",
			createdAt: new Date().toISOString(),
		})
		.returning();
	if (!row) throw new Error("server not created");
	return row;
};

/** Daily 02:00-05:00 UTC. */
const nightly = {
	recurrence: "daily" as const,
	startTime: "02:00",
	timeZone: "UTC",
	durationMinutes: 180,
	weekdays: [],
	monthlyMode: "day" as const,
	monthDay: 1,
	monthWeek: 1,
	monthWeekday: 0,
};

const configurationInput = (
	name: string,
	serverIds: string[],
	patch: Partial<Parameters<typeof createOsUpdateConfiguration>[0]> = {},
) => ({
	name,
	description: null,
	enabled: true,
	schedule: nightly,
	notifyOnSuccess: false,
	serverIds,
	...DEFAULT_OS_UPDATE_SETTINGS,
	...patch,
});

const runsOf = (serverId: string) =>
	db.query.osUpdateRuns.findMany({
		where: eq(osUpdateRuns.serverId, serverId),
	});

/** Assigned and configured long before the windows of the tests. */
const backdate = async (configurationId: string) => {
	await db
		.update(osUpdateConfigurations)
		.set({ updatedAt: "2026-11-01T00:00:00.000Z" })
		.where(eq(osUpdateConfigurations.osUpdateConfigurationId, configurationId));
	await db
		.update(osUpdateServers)
		.set({ assignedAt: "2026-11-01T00:00:00.000Z" })
		.where(eq(osUpdateServers.osUpdateConfigurationId, configurationId));
};

beforeAll(async () => {
	a = await createOrganization("os-a");
	b = await createOrganization("os-b");
});

afterAll(removeCreatedRows);

describe("migration 0182", () => {
	it("creates the OS update tables and their unique indexes", async () => {
		const tables = await db.execute<{ table_name: string }>(sql`
			select table_name from information_schema.tables
			where table_schema = 'public' and table_name like 'os_update%'
			order by table_name`);
		expect(tables.map((row) => row.table_name)).toEqual([
			"os_update_configuration",
			"os_update_lock",
			"os_update_run",
			"os_update_server",
		]);
		const indexes = await db.execute<{ indexname: string }>(sql`
			select indexname from pg_indexes
			where tablename = 'os_update_run' and indexname like '%unique'
			order by indexname`);
		expect(indexes.map((row) => row.indexname)).toEqual([
			"os_update_run_configuration_running_unique",
			"os_update_run_server_running_unique",
			"os_update_run_window_unique",
		]);
	});
});

describe("constraints", () => {
	it("allows one run per server and window", async () => {
		const target = await insertServer(a.organizationId, "unique-window");
		const configuration = await createOsUpdateConfiguration(
			configurationInput("unique-window", [target.serverId]),
			a.organizationId,
		);
		const row = {
			organizationId: a.organizationId,
			serverId: target.serverId,
			osUpdateConfigurationId: configuration.osUpdateConfigurationId,
			trigger: "schedule" as const,
			windowStart: "2026-11-10T02:00:00.000Z",
			deadline: "2026-11-10T05:00:00.000Z",
			settings: DEFAULT_OS_UPDATE_SETTINGS,
		};
		await db.insert(osUpdateRuns).values(row);
		expect(await pgErrorCode(db.insert(osUpdateRuns).values(row))).toBe(
			UNIQUE_VIOLATION,
		);
		// Manual runs are not tied to a window.
		await db.insert(osUpdateRuns).values([
			{ ...row, trigger: "manual" },
			{ ...row, trigger: "manual" },
		]);
	});

	it("runs one update at a time per server, and per configuration", async () => {
		const first = await insertServer(a.organizationId, "busy-1");
		const second = await insertServer(a.organizationId, "busy-2");
		const configuration = await createOsUpdateConfiguration(
			configurationInput("busy", [first.serverId, second.serverId]),
			a.organizationId,
		);
		const run = (serverId: string, windowStart: string) => ({
			organizationId: a.organizationId,
			serverId,
			osUpdateConfigurationId: configuration.osUpdateConfigurationId,
			trigger: "schedule" as const,
			status: "running" as const,
			windowStart,
			deadline: "2026-11-10T05:00:00.000Z",
			settings: DEFAULT_OS_UPDATE_SETTINGS,
		});
		await db
			.insert(osUpdateRuns)
			.values(run(first.serverId, "2026-11-10T02:00:00.000Z"));
		// The same server in another window, or another server of the configuration.
		expect(
			await pgErrorCode(
				db
					.insert(osUpdateRuns)
					.values(run(first.serverId, "2026-11-11T02:00:00.000Z")),
			),
		).toBe(UNIQUE_VIOLATION);
		expect(
			await pgErrorCode(
				db
					.insert(osUpdateRuns)
					.values(run(second.serverId, "2026-11-10T02:00:00.000Z")),
			),
		).toBe(UNIQUE_VIOLATION);
		// A manual run of the other server may run meanwhile.
		await db.insert(osUpdateRuns).values({
			...run(second.serverId, "2026-11-10T02:00:00.000Z"),
			trigger: "manual",
			osUpdateConfigurationId: null,
		});
	});
});

describe("windows", () => {
	it("gives each assigned server one run per window, whatever the restarts", async () => {
		const first = await insertServer(a.organizationId, "window-1");
		const second = await insertServer(a.organizationId, "window-2");
		const configuration = await createOsUpdateConfiguration(
			configurationInput("window", [first.serverId, second.serverId]),
			a.organizationId,
		);
		await backdate(configuration.osUpdateConfigurationId);
		const now = new Date("2026-11-10T03:00:00Z");
		// A restart plans the same window again.
		await planOsUpdateWindows(now);
		await planOsUpdateWindows(now);
		const windowRuns = async (serverId: string, windowStart: string) =>
			(await runsOf(serverId)).filter(
				(run) =>
					run.osUpdateConfigurationId ===
						configuration.osUpdateConfigurationId &&
					run.windowStart === windowStart,
			);
		for (const target of [first, second]) {
			const runs = await windowRuns(
				target.serverId,
				"2026-11-10T02:00:00.000Z",
			);
			expect(runs).toHaveLength(1);
			expect(runs[0]).toMatchObject({
				status: "pending",
				trigger: "schedule",
				deadline: "2026-11-10T05:00:00.000Z",
			});
			// Assigned since November 1st: the night before passed with no
			// Dokploy, recorded once.
			const before = await windowRuns(
				target.serverId,
				"2026-11-09T02:00:00.000Z",
			);
			expect(before.map((run) => run.status)).toEqual(["missed"]);
		}
		// Once the window closes, its runs are not reported missed.
		await planOsUpdateWindows(new Date("2026-11-10T06:00:00Z"));
		expect(
			(await windowRuns(first.serverId, "2026-11-10T02:00:00.000Z")).map(
				(run) => run.status,
			),
		).toEqual(["pending"]);
		// And a run that could not start in time is skipped.
		await skipClosedOsUpdateRuns(new Date("2026-11-10T04:50:00Z"));
		expect(
			(await windowRuns(first.serverId, "2026-11-10T02:00:00.000Z"))[0]?.status,
		).toBe("skipped");
	});

	it("records a window no Dokploy ran in as missed, once", async () => {
		const target = await insertServer(a.organizationId, "missed");
		const configuration = await createOsUpdateConfiguration(
			configurationInput("missed", [target.serverId]),
			a.organizationId,
		);
		await backdate(configuration.osUpdateConfigurationId);
		const later = new Date("2026-11-10T09:00:00Z");
		await planOsUpdateWindows(later);
		await planOsUpdateWindows(later);
		const runs = await runsOf(target.serverId);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			status: "missed",
			windowStart: "2026-11-10T02:00:00.000Z",
		});
		expect(runs[0]?.message).toMatch(/nothing was installed/);
	});

	it("never reports missed a window before the assignment or a change", async () => {
		const target = await insertServer(a.organizationId, "fresh");
		const configuration = await createOsUpdateConfiguration(
			configurationInput("fresh", [target.serverId]),
			a.organizationId,
		);
		// Assigned now (2026 test clock: after the window below).
		await db
			.update(osUpdateServers)
			.set({ assignedAt: "2026-11-10T08:00:00.000Z" })
			.where(eq(osUpdateServers.serverId, target.serverId));
		await db
			.update(osUpdateConfigurations)
			.set({ updatedAt: "2026-11-01T00:00:00.000Z" })
			.where(
				eq(
					osUpdateConfigurations.osUpdateConfigurationId,
					configuration.osUpdateConfigurationId,
				),
			);
		await planOsUpdateWindows(new Date("2026-11-10T09:00:00Z"));
		expect(await runsOf(target.serverId)).toHaveLength(0);
	});

	it("plans nothing for a disabled configuration", async () => {
		const target = await insertServer(a.organizationId, "disabled");
		const configuration = await createOsUpdateConfiguration(
			configurationInput("disabled", [target.serverId], { enabled: false }),
			a.organizationId,
		);
		await backdate(configuration.osUpdateConfigurationId);
		await planOsUpdateWindows(new Date("2026-11-10T03:00:00Z"));
		await planOsUpdateWindows(new Date("2026-11-10T09:00:00Z"));
		expect(await runsOf(target.serverId)).toHaveLength(0);
	});
});

describe("service", () => {
	it("assigns servers, moves them between configurations, and keeps names unique", async () => {
		const first = await insertServer(a.organizationId, "svc-1");
		const second = await insertServer(a.organizationId, "svc-2");
		const one = await createOsUpdateConfiguration(
			configurationInput("svc-one", [first.serverId, second.serverId]),
			a.organizationId,
		);
		const two = await createOsUpdateConfiguration(
			configurationInput("svc-two", [second.serverId]),
			a.organizationId,
		);
		const assignment = async (serverId: string) =>
			(
				await db.query.osUpdateServers.findFirst({
					where: eq(osUpdateServers.serverId, serverId),
				})
			)?.osUpdateConfigurationId;
		expect(await assignment(first.serverId)).toBe(one.osUpdateConfigurationId);
		// A server has one configuration: the last one taking it.
		expect(await assignment(second.serverId)).toBe(two.osUpdateConfigurationId);
		await updateOsUpdateConfiguration(
			{
				...configurationInput("svc-one", []),
				osUpdateConfigurationId: one.osUpdateConfigurationId,
			},
			a.organizationId,
		);
		expect(await assignment(first.serverId)).toBeNull();
		await expect(
			createOsUpdateConfiguration(
				configurationInput("svc-two", []),
				a.organizationId,
			),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await removeOsUpdateConfiguration(
			two.osUpdateConfigurationId,
			a.organizationId,
		);
		expect(await assignment(second.serverId)).toBeNull();
	});

	it("refuses the servers of another organization", async () => {
		const foreign = await insertServer(b.organizationId, "foreign");
		await expect(
			createOsUpdateConfiguration(
				configurationInput("foreign", [foreign.serverId]),
				a.organizationId,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			installOsUpdatesNow(
				{
					serverId: foreign.serverId,
					maxDurationMinutes: 60,
					...DEFAULT_OS_UPDATE_SETTINGS,
				},
				a.organizationId,
				a.email,
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("queues one Install now per server, which can be cancelled before it starts", async () => {
		const target = await insertServer(a.organizationId, "now");
		const input = {
			serverId: target.serverId,
			maxDurationMinutes: 60,
			...DEFAULT_OS_UPDATE_SETTINGS,
			reboot: "never" as const,
		};
		const { run } = await installOsUpdatesNow(input, a.organizationId, a.email);
		expect(run).toMatchObject({
			trigger: "manual",
			status: "pending",
			requestedBy: a.email,
		});
		expect(run.settings.reboot).toBe("never");
		expect(Date.parse(run.deadline) - Date.parse(run.createdAt)).toBeCloseTo(
			3_600_000,
			-3,
		);
		await expect(
			installOsUpdatesNow(input, a.organizationId, a.email),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			cancelOsUpdateRun(run.osUpdateRunId, b.organizationId),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await cancelOsUpdateRun(run.osUpdateRunId, a.organizationId);
		const listed = (await listOsUpdateServers(a.organizationId)).find(
			(row) => row.serverId === target.serverId,
		);
		expect(listed?.lastRun?.status).toBe("cancelled");
		// Cancelled: another one may be queued.
		await installOsUpdatesNow(input, a.organizationId, a.email);
		const pending = await db.query.osUpdateRuns.findMany({
			where: and(
				eq(osUpdateRuns.serverId, target.serverId),
				eq(osUpdateRuns.status, "pending"),
			),
		});
		expect(pending).toHaveLength(1);
	});
});

describe("router", () => {
	it("lets the owner in and keeps a member without the permission out", async () => {
		const target = await insertServer(a.organizationId, "router");
		const overview = await callerOf(a).overview();
		expect(
			overview.servers.some((row) => row.serverId === target.serverId),
		).toBe(true);
		// Never the private key nor another organization's servers.
		expect(JSON.stringify(overview)).not.toMatch(/PRIVATE KEY/);
		expect(overview.servers.some((row) => row.name === "foreign")).toBe(false);
		const member = await addMember(a.organizationId, "member");
		await expect(callerOf(member).overview()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
		await expect(
			callerOf(member).installNow({
				serverId: target.serverId,
				...DEFAULT_OS_UPDATE_SETTINGS,
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	it("validates what reaches the controller", async () => {
		const target = await insertServer(a.organizationId, "validation");
		await expect(
			callerOf(a).installNow({
				serverId: target.serverId,
				...DEFAULT_OS_UPDATE_SETTINGS,
				includePackages: ["$(reboot)"],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			callerOf(a).createConfiguration({
				...configurationInput("bad-schedule", []),
				schedule: { ...nightly, recurrence: "weekly", weekdays: [] },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});
