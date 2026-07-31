import type { apiRestoreBackup } from "@dokploy/server/db/schema";
import type { Destination } from "@dokploy/server/services/destination";
import type { Mariadb } from "@dokploy/server/services/mariadb";
import type { z } from "zod";
import { getSafeRcloneErrorMessage } from "../backups/redact";
import {
	buildRcloneCommand,
	getRcloneEnvironment,
	getRcloneExecOptions,
	getRcloneRemotePath,
} from "../backups/utils";
import { execAsync, execAsyncRemote } from "../process/execAsync";
import { getRestoreCommand } from "./utils";

export const restoreMariadbBackup = async (
	mariadb: Mariadb,
	destination: Destination,
	backupInput: z.infer<typeof apiRestoreBackup>,
	emit: (log: string) => void,
) => {
	try {
		const { appName, serverId, databaseUser, databasePassword } = mariadb;

		const backupPath = getRcloneRemotePath(destination, backupInput.backupFile);
		const rcloneCommand = `${buildRcloneCommand(destination, [
			"cat",
			backupPath,
		])} | gunzip`;

		const command = getRestoreCommand({
			appName,
			credentials: {
				database: backupInput.databaseName,
				databaseUser,
				databasePassword,
			},
			type: "mariadb",
			rcloneCommand,
			restoreType: "database",
		});

		emit("Starting restore...");
		emit(
			`Restoring database: ${backupInput.databaseName} from ${backupInput.backupFile}`,
		);

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
			"Error restoring mariadb backup",
		);
		console.error(errorMessage);
		emit(`Error: ${errorMessage}`);
		throw new Error(errorMessage);
	}
};
