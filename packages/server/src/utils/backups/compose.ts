import type { BackupSchedule } from "@dokploy/server/services/backup";
import type { Compose } from "@dokploy/server/services/compose";
import {
	createDeploymentBackup,
	updateDeploymentStatus,
} from "@dokploy/server/services/deployment";
import { findDestinationById } from "@dokploy/server/services/destination";
import { findEnvironmentById } from "@dokploy/server/services/environment";
import { findProjectById } from "@dokploy/server/services/project";
import { getActiveComposeRuntimeContainerSelector } from "../docker/utils";
import { sendDatabaseBackupNotifications } from "../notifications/database-backup";
import { execAsync, execAsyncRemote } from "../process/execAsync";
import { getSafeRcloneErrorMessage } from "./redact";
import {
	buildRcloneCommand,
	getBackupCommand,
	getBackupTimestamp,
	getRcloneEnvironment,
	getRcloneExecOptions,
	getRcloneRemotePath,
	normalizeS3Path,
} from "./utils";

export const runComposeBackup = async (
	compose: Compose,
	backup: BackupSchedule,
) => {
	const { environmentId, name, appName } = compose;
	const environment = await findEnvironmentById(environmentId);
	const project = await findProjectById(environment.projectId);
	const { prefix, databaseType, serviceName } = backup;
	const destination = await findDestinationById(backup.destinationId);
	const backupFileName = `${getBackupTimestamp()}.${databaseType === "mongo" ? "bson" : "sql"}.gz`;
	const s3AppName = serviceName ? `${appName}_${serviceName}` : appName;
	const bucketDestination = `${s3AppName}/${normalizeS3Path(prefix)}${backupFileName}`;
	const deployment = await createDeploymentBackup({
		backupId: backup.backupId,
		title: "Compose Backup",
		description: "Compose Backup",
	});

	try {
		const rcloneDestination = getRcloneRemotePath(
			destination,
			bucketDestination,
		);
		const rcloneCommand = buildRcloneCommand(destination, [
			"rcat",
			rcloneDestination,
		]);
		const runtimeSelector =
			compose.composeType === "docker-compose"
				? await getActiveComposeRuntimeContainerSelector(compose)
				: null;

		const backupCommand = getBackupCommand(
			backup,
			rcloneCommand,
			deployment.logPath,
			runtimeSelector,
		);
		if (compose.serverId) {
			await execAsyncRemote(
				compose.serverId,
				backupCommand,
				undefined,
				undefined,
				getRcloneEnvironment(destination),
			);
		} else {
			await execAsync(backupCommand, {
				shell: "/bin/bash",
				...getRcloneExecOptions(destination),
			});
		}

		await sendDatabaseBackupNotifications({
			applicationName: name,
			projectName: project.name,
			databaseType: getDatabaseType(databaseType),
			type: "success",
			organizationId: project.organizationId,
			databaseName: backup.database,
		});

		await updateDeploymentStatus(deployment.deploymentId, "done");
	} catch (error) {
		const errorMessage = getSafeRcloneErrorMessage(error);
		console.error(errorMessage);
		await sendDatabaseBackupNotifications({
			applicationName: name,
			projectName: project.name,
			databaseType: getDatabaseType(databaseType),
			type: "error",
			errorMessage,
			organizationId: project.organizationId,
			databaseName: backup.database,
		});

		await updateDeploymentStatus(deployment.deploymentId, "error");
		throw error;
	}
};

const getDatabaseType = (databaseType: BackupSchedule["databaseType"]) => {
	if (databaseType === "mongo") {
		return "mongodb";
	}
	if (databaseType === "postgres") {
		return "postgres";
	}
	if (databaseType === "mariadb") {
		return "mariadb";
	}
	if (databaseType === "mysql") {
		return "mysql";
	}
	return "mongodb";
};
