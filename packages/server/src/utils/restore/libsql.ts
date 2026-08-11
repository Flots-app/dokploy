import type { apiRestoreBackup } from "@dokploy/server/db/schema";
import type { Destination } from "@dokploy/server/services/destination";
import type { Libsql } from "@dokploy/server/services/libsql";
import type { z } from "zod";
import { getSafeRcloneErrorMessage } from "../backups/redact";
import {
	buildRcloneCommand,
	getRcloneEnvironment,
	getRcloneExecOptions,
	getRcloneRemotePath,
	getServiceContainerCommand,
} from "../backups/utils";
import { execAsync, execAsyncRemote } from "../process/execAsync";

export const restoreLibsqlBackup = async (
	libsql: Libsql,
	destination: Destination,
	backupInput: z.infer<typeof apiRestoreBackup>,
	emit: (log: string) => void,
) => {
	try {
		const { appName, serverId } = libsql;

		const backupPath = getRcloneRemotePath(destination, backupInput.backupFile);
		const rcloneCommand = buildRcloneCommand(destination, ["cat", backupPath]);

		const containerSearch = getServiceContainerCommand(appName);
		const restoreCommand = `docker exec -i $CONTAINER_ID sh -c "tar xzf - -C /var/lib/sqld"`;

		const command = `CONTAINER_ID=$(${containerSearch}) && ${rcloneCommand} | ${restoreCommand}`;

		emit("Starting restore...");
		emit(`Restoring libsql from ${backupInput.backupFile}`);

		if (serverId) {
			await execAsyncRemote(
				serverId,
				command,
				undefined,
				undefined,
				getRcloneEnvironment(destination),
			);
		} else {
			await execAsync(command, getRcloneExecOptions(destination));
		}

		emit("Restore completed successfully!");
	} catch (error) {
		const errorMessage = getSafeRcloneErrorMessage(
			error,
			"Error restoring libsql backup",
		);
		emit(`Error: ${errorMessage}`);
		throw new Error(errorMessage);
	}
};
