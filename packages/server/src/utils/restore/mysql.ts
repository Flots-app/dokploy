import type { apiRestoreBackup } from "@dokploy/server/db/schema";
import type { Destination } from "@dokploy/server/services/destination";
import type { MySql } from "@dokploy/server/services/mysql";
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

export const restoreMySqlBackup = async (
	mysql: MySql,
	destination: Destination,
	backupInput: z.infer<typeof apiRestoreBackup>,
	emit: (log: string) => void,
) => {
	try {
		const { appName, databaseRootPassword, serverId } = mysql;

		const backupPath = getRcloneRemotePath(destination, backupInput.backupFile);
		const rcloneCommand = `${buildRcloneCommand(destination, [
			"cat",
			backupPath,
		])} | gunzip`;

		const command = getRestoreCommand({
			appName,
			type: "mysql",
			credentials: {
				database: backupInput.databaseName,
				databasePassword: databaseRootPassword,
			},
			restoreType: "database",
			rcloneCommand,
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
			"Error restoring mysql backup",
		);
		console.error(errorMessage);
		emit(`Error: ${errorMessage}`);
		throw new Error(errorMessage);
	}
};
