import type { BackupSchedule } from "@dokploy/server/services/backup";
import {
	createDeploymentBackup,
	updateDeploymentStatus,
} from "@dokploy/server/services/deployment";
import { findDestinationById } from "@dokploy/server/services/destination";
import { findEnvironmentById } from "@dokploy/server/services/environment";
import type { Mongo } from "@dokploy/server/services/mongo";
import { findProjectById } from "@dokploy/server/services/project";
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

export const runMongoBackup = async (mongo: Mongo, backup: BackupSchedule) => {
	const { environmentId, name, appName } = mongo;
	const environment = await findEnvironmentById(environmentId);
	const project = await findProjectById(environment.projectId);
	const { prefix } = backup;
	const destination = await findDestinationById(backup.destinationId);
	const backupFileName = `${getBackupTimestamp()}.bson.gz`;
	const bucketDestination = `${appName}/${normalizeS3Path(prefix)}${backupFileName}`;
	const deployment = await createDeploymentBackup({
		backupId: backup.backupId,
		title: "MongoDB Backup",
		description: "MongoDB Backup",
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

		const backupCommand = getBackupCommand(
			backup,
			rcloneCommand,
			deployment.logPath,
		);

		if (mongo.serverId) {
			await execAsyncRemote(
				mongo.serverId,
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
			databaseType: "mongodb",
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
			databaseType: "mongodb",
			type: "error",
			errorMessage,
			organizationId: project.organizationId,
			databaseName: backup.database,
		});
		await updateDeploymentStatus(deployment.deploymentId, "error");
		throw error;
	}
};
