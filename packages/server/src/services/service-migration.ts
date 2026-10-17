import { db } from "@dokploy/server/db";
import {
	type MigratableServiceType,
	type ServiceMigration,
	type ServiceMigrationOptions,
	serviceMigrations,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { analyzeServiceMigration } from "../utils/service-migration/analyze";
import {
	buildSourceCleanup,
	cleanupSource,
	executeMigration,
	type MigrationContext,
	restoreServiceStatus,
	rollbackMigration,
} from "../utils/service-migration/execute";
import {
	createHostExecutor,
	type HostExecutor,
	resolveMigrationHost,
} from "../utils/service-migration/host";
import {
	loadMigrationService,
	setServiceStatus,
} from "../utils/service-migration/service";

export { analyzeServiceMigration } from "../utils/service-migration/analyze";
export { loadMigrationService } from "../utils/service-migration/service";

export const findServiceMigrationById = async (serviceMigrationId: string) => {
	const migration = await db.query.serviceMigrations.findFirst({
		where: eq(serviceMigrations.serviceMigrationId, serviceMigrationId),
	});
	if (!migration) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Migration not found",
		});
	}
	return migration;
};

export const findServiceMigrationsByService = async (serviceId: string) =>
	await db.query.serviceMigrations.findMany({
		where: eq(serviceMigrations.serviceId, serviceId),
		orderBy: desc(serviceMigrations.createdAt),
		columns: { logs: false, checks: false, plan: false },
		limit: 10,
	});

export const findRunningServiceMigration = async (serviceId: string) =>
	await db.query.serviceMigrations.findFirst({
		where: and(
			eq(serviceMigrations.serviceId, serviceId),
			eq(serviceMigrations.status, "running"),
		),
		columns: { serviceMigrationId: true },
	});

/** Deploys, restarts and stops would race with the migration of the same service. */
export const assertNoRunningServiceMigration = async (serviceId: string) => {
	if (await findRunningServiceMigration(serviceId)) {
		throw new TRPCError({
			code: "CONFLICT",
			message:
				"A server migration of this service is running. Wait for it to finish.",
		});
	}
};

const appendLog = async (serviceMigrationId: string, message: string) => {
	const line = `[${new Date().toISOString()}] ${message}\n`;
	await db
		.update(serviceMigrations)
		.set({ logs: sql`${serviceMigrations.logs} || ${line}` })
		.where(eq(serviceMigrations.serviceMigrationId, serviceMigrationId));
};

const finish = async (
	serviceMigrationId: string,
	values: Pick<ServiceMigration, "status"> &
		Partial<Pick<ServiceMigration, "errorMessage">>,
) => {
	await db
		.update(serviceMigrations)
		.set({ ...values, finishedAt: new Date().toISOString() })
		.where(eq(serviceMigrations.serviceMigrationId, serviceMigrationId));
};

const statusIcon = { pass: "✅", warn: "⚠️", fail: "❌", skip: "⏭️" } as const;

/** Runs a migration created by startServiceMigration. Never throws. */
export const runServiceMigration = async (serviceMigrationId: string) => {
	const migration = await findServiceMigrationById(serviceMigrationId);
	const log = (message: string) => appendLog(serviceMigrationId, message);
	let service: Awaited<ReturnType<typeof loadMigrationService>>;
	try {
		service = await loadMigrationService(
			migration.serviceType as MigratableServiceType,
			migration.serviceId,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await log(`❌ ${message}`);
		await finish(serviceMigrationId, {
			status: "error",
			errorMessage: message,
		});
		return;
	}
	const originalStatus = service.status;
	let source: HostExecutor | null = null;
	let target: HostExecutor | null = null;
	let context: MigrationContext | null = null;
	let committed = false;

	try {
		await log(
			`Migrating ${service.appName} from ${migration.sourceServerName} to ${migration.targetServerName}`,
		);
		source = await createHostExecutor(
			await resolveMigrationHost(migration.sourceServerId),
		);
		target = await createHostExecutor(
			await resolveMigrationHost(migration.targetServerId),
		);

		await log("Running pre-flight checks");
		const analysis = await analyzeServiceMigration({
			serviceType: service.type,
			serviceId: service.id,
			targetServerId: migration.targetServerId,
			organizationId: migration.organizationId,
			options: migration.options,
			executors: { source, target },
			migrationId: serviceMigrationId,
		});
		await db
			.update(serviceMigrations)
			.set({ checks: analysis.checks, plan: analysis.plan })
			.where(eq(serviceMigrations.serviceMigrationId, serviceMigrationId));
		await log(
			analysis.checks
				.map(
					(check) =>
						`  ${statusIcon[check.status]} ${check.label}: ${check.message}`,
				)
				.join("\n"),
		);
		if (!analysis.canMigrate) {
			throw new Error(
				"Pre-flight checks failed; nothing was changed. Fix the failing checks and try again.",
			);
		}

		await restoreServiceStatus(service, "running");
		context = {
			analysis,
			service: analysis.service,
			source,
			target,
			options: migration.options,
			log,
			compensations: [],
		};
		const finalStatus = await executeMigration(context);
		committed = true;

		const cleanup = buildSourceCleanup(context);
		if (migration.options.keepSourceRunning && !analysis.requiresDowntime) {
			await db
				.update(serviceMigrations)
				.set({ pendingCleanup: cleanup })
				.where(eq(serviceMigrations.serviceMigrationId, serviceMigrationId));
			await log(
				`${source.host.name} keeps serving the previous runtime. Point the DNS records to ${target.host.name}, then finish the migration to remove it.`,
			);
		} else {
			await log(`Cleaning up ${source.host.name}`);
			try {
				await cleanupSource(source, cleanup, log);
			} catch (error) {
				await log(
					`⚠️ Cleanup of the source failed: ${
						error instanceof Error ? error.message : String(error)
					}. Remove the leftovers manually.`,
				);
			}
		}
		await restoreServiceStatus(service, finalStatus);
		await log(`✅ ${service.appName} now runs on ${target.host.name}`);
		await finish(serviceMigrationId, { status: "done" });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await log(`❌ ${message}`);
		let status: ServiceMigration["status"] = "error";
		if (context && !committed && context.compensations.length > 0) {
			await log("Rolling back");
			const failures = await rollbackMigration(context);
			if (failures === 0) {
				status = "rolled_back";
				await log(
					`↩ Rolled back: ${service.appName} runs on ${migration.sourceServerName} as before`,
				);
			} else {
				await log(
					`⚠️ ${failures} rollback step(s) failed, check the service on both servers`,
				);
			}
		}
		await restoreServiceStatus(service, originalStatus).catch(() => {});
		await finish(serviceMigrationId, { status, errorMessage: message });
	} finally {
		source?.close();
		target?.close();
	}
};

export const startServiceMigration = async (input: {
	serviceType: MigratableServiceType;
	serviceId: string;
	targetServerId: string | null;
	options: ServiceMigrationOptions;
	organizationId: string;
	userId: string;
}) => {
	const service = await loadMigrationService(
		input.serviceType,
		input.serviceId,
	);
	if (service.organizationId !== input.organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this service",
		});
	}
	const [sourceHost, targetHost] = await Promise.all([
		resolveMigrationHost(service.serverId),
		resolveMigrationHost(input.targetServerId),
	]);
	let migration: ServiceMigration | undefined;
	try {
		[migration] = await db
			.insert(serviceMigrations)
			.values({
				serviceType: input.serviceType,
				serviceId: input.serviceId,
				appName: service.appName,
				organizationId: input.organizationId,
				sourceServerId: service.serverId,
				sourceServerName: sourceHost.name,
				targetServerId: input.targetServerId,
				targetServerName: targetHost.name,
				options: input.options,
				createdBy: input.userId,
			})
			.returning();
	} catch {
		throw new TRPCError({
			code: "CONFLICT",
			message: "A migration of this service is already running",
		});
	}
	if (!migration) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Unable to create the migration",
		});
	}
	void runServiceMigration(migration.serviceMigrationId).catch((error) => {
		console.error("Service migration crashed", error);
	});
	return migration;
};

/** Removes the source runtime kept running by a zero-downtime migration (after the DNS switch). */
export const finalizeServiceMigration = async (serviceMigrationId: string) => {
	const migration = await findServiceMigrationById(serviceMigrationId);
	const cleanup = migration.pendingCleanup;
	if (migration.status !== "done" || !cleanup) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "This migration has nothing left on the source server",
		});
	}
	const log = (message: string) => appendLog(serviceMigrationId, message);
	await log(
		`Finishing the migration: cleaning up ${migration.sourceServerName}`,
	);
	const source = await createHostExecutor(
		await resolveMigrationHost(migration.sourceServerId),
	);
	try {
		await cleanupSource(source, cleanup, log);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await log(`❌ ${message}`);
		throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
	} finally {
		source.close();
	}
	await db
		.update(serviceMigrations)
		.set({ pendingCleanup: null })
		.where(eq(serviceMigrations.serviceMigrationId, serviceMigrationId));
	await log(
		`✅ ${migration.sourceServerName} no longer runs ${migration.appName}`,
	);
	return migration;
};

/** A restart kills running migrations: flag them so the UI does not wait forever. */
export const initInterruptedServiceMigrations = async () => {
	const interrupted = await db
		.update(serviceMigrations)
		.set({
			status: "error",
			errorMessage:
				"Dokploy restarted during the migration. Check the service on both servers before retrying.",
			finishedAt: new Date().toISOString(),
		})
		.where(eq(serviceMigrations.status, "running"))
		.returning({
			serviceType: serviceMigrations.serviceType,
			serviceId: serviceMigrations.serviceId,
		});
	// The migrations had flagged their services as running; their state is unknown.
	await Promise.all(
		interrupted.map((migration) =>
			setServiceStatus(
				migration.serviceType as MigratableServiceType,
				migration.serviceId,
				"error",
			).catch(() => {}),
		),
	);
	if (interrupted.length > 0) {
		console.log(
			`Marked ${interrupted.length} interrupted service migration(s)`,
		);
	}
};
