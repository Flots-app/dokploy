import type { apiRestoreBackup } from "@dokploy/server/db/schema";
import type { Destination } from "@dokploy/server/services/destination";
import type { Mongo } from "@dokploy/server/services/mongo";
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

export const restoreMongoBackup = async (
	mongo: Mongo,
	destination: Destination,
	backupInput: z.infer<typeof apiRestoreBackup>,
	emit: (log: string) => void,
) => {
	try {
		const { appName, databasePassword, databaseUser, serverId } = mongo;

		const backupPath = getRcloneRemotePath(destination, backupInput.backupFile);
		const rcloneCommand = buildRcloneCommand(destination, ["copy", backupPath]);

		const command = getRestoreCommand({
			appName,
			type: "mongo",
			credentials: {
				database: backupInput.databaseName,
				databaseUser,
				databasePassword,
			},
			restoreType: "database",
			rcloneCommand,
			backupFile: backupInput.backupFile,
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
			"Error restoring mongo backup",
		);
		console.error(errorMessage);
		emit(`Error: ${errorMessage}`);
		throw new Error(errorMessage);
	}
};
