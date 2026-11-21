import { scheduleJob } from "node-schedule";
import {
	failureOf,
	getAuditLogRetentionDays,
	purgeAuditLogs,
} from "../../services/audit-log";

const DAY_IN_MS = 24 * 60 * 60 * 1000;

/** Once a day, drops the audit entries older than the retention period. */
export const initAuditLogRetentionCronJob = () => {
	const days = getAuditLogRetentionDays();
	if (days === null) return;

	scheduleJob("audit-log-retention", "17 3 * * *", async () => {
		try {
			const purged = await purgeAuditLogs(
				new Date(Date.now() - days * DAY_IN_MS),
			);
			if (purged > 0) {
				console.log(
					`[audit-log] removed ${purged} entries older than ${days} days`,
				);
			}
		} catch (error) {
			console.error(
				"[audit-log] could not apply the retention",
				failureOf(error),
			);
		}
	});
};
