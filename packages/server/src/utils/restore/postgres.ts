import type { apiRestoreBackup } from "@dokploy/server/db/schema";
import type { Destination } from "@dokploy/server/services/destination";
import type { Postgres } from "@dokploy/server/services/postgres";
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

export const restorePostgresBackup = async (
	postgres: Postgres,
	destination: Destination,
	backupInput: z.infer<typeof apiRestoreBackup>,
	emit: (log: string) => void,
) => {
	try {
		const { appName, databaseUser, serverId } = postgres;

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
			},
			type: "postgres",
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
			"Error restoring postgres backup",
		);
		emit(`Error: ${errorMessage}`);
		throw new Error(errorMessage);
	}
};
