import { eq } from "drizzle-orm";
import { scheduleJob } from "node-schedule";
import { db } from "../db";
import { observabilitySettings } from "../db/schema";
import {
	purgeExpiredDatabaseAlertHistory,
	queueOrganizationObservabilityReconcile,
} from "./service";

export const initObservabilityCronJobs = async () => {
	scheduleJob("dokploy-observability-reconcile", "*/5 * * * *", async () => {
		const installed = await db.query.observabilitySettings.findMany({
			where: eq(observabilitySettings.enabled, true),
			columns: { organizationId: true },
		});
		for (const settings of installed) {
			await queueOrganizationObservabilityReconcile(settings.organizationId);
		}
	});

	scheduleJob(
		"dokploy-observability-history-cleanup",
		"15 2 * * *",
		async () => {
			try {
				await purgeExpiredDatabaseAlertHistory();
			} catch (error) {
				console.error(
					"Managed observability history cleanup failed:",
					error instanceof Error ? error.message : error,
				);
			}
		},
	);
};
