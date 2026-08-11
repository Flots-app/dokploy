import type { apiRestoreBackup } from "@dokploy/server/db/schema";
import type { Compose } from "@dokploy/server/services/compose";
import type { Destination } from "@dokploy/server/services/destination";
import type { z } from "zod";
import { getSafeRcloneErrorMessage } from "../backups/redact";
import {
	buildRcloneCommand,
	getRcloneEnvironment,
	getRcloneExecOptions,
	getRcloneRemotePath,
} from "../backups/utils";
import { getActiveComposeRuntimeContainerSelector } from "../docker/utils";
import { execAsync, execAsyncRemote } from "../process/execAsync";
import { getRestoreCommand } from "./utils";

interface DatabaseCredentials {
	databaseUser?: string;
	databasePassword?: string;
}

export const restoreComposeBackup = async (
	compose: Compose,
	destination: Destination,
	backupInput: z.infer<typeof apiRestoreBackup>,
	emit: (log: string) => void,
) => {
	try {
		if (backupInput.databaseType === "web-server") {
			return;
		}
		const { serverId, appName, composeType } = compose;

		const backupPath = getRcloneRemotePath(destination, backupInput.backupFile);
		let rcloneCommand = `${buildRcloneCommand(destination, [
			"cat",
			backupPath,
		])} | gunzip`;

		if (backupInput.metadata?.mongo) {
			rcloneCommand = buildRcloneCommand(destination, ["copy", backupPath]);
		}
		const runtimeSelector =
			composeType === "docker-compose"
				? await getActiveComposeRuntimeContainerSelector(compose)
				: null;

		let credentials: DatabaseCredentials = {};

		switch (backupInput.databaseType) {
			case "postgres":
				credentials = {
					databaseUser: backupInput.metadata?.postgres?.databaseUser,
				};
				break;
			case "mariadb":
				credentials = {
					databaseUser: backupInput.metadata?.mariadb?.databaseUser,
					databasePassword: backupInput.metadata?.mariadb?.databasePassword,
				};
				break;
			case "mysql":
				credentials = {
					databasePassword: backupInput.metadata?.mysql?.databaseRootPassword,
				};
				break;
			case "mongo":
				credentials = {
					databaseUser: backupInput.metadata?.mongo?.databaseUser,
					databasePassword: backupInput.metadata?.mongo?.databasePassword,
				};
				break;
		}

		const restoreCommand = getRestoreCommand({
			appName: appName,
			serviceName: backupInput.metadata?.serviceName,
			type: backupInput.databaseType as
				| "postgres"
				| "mariadb"
				| "mysql"
				| "mongo",
			credentials: {
				database: backupInput.databaseName,
				...credentials,
			},
			restoreType: composeType,
			runtimeSelector,
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
				restoreCommand,
				undefined,
				undefined,
				getRcloneEnvironment(destination),
			);
		} else {
			await execAsync(restoreCommand, getRcloneExecOptions(destination));
		}

		emit("Restore completed successfully!");
	} catch (error) {
		const errorMessage = getSafeRcloneErrorMessage(
			error,
			"Error restoring compose backup",
		);
		console.error(errorMessage);
		emit(`Error: ${errorMessage}`);
		throw new Error(errorMessage);
	}
};
