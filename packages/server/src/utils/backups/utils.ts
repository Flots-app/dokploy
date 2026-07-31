import { logger } from "@dokploy/server/lib/logger";
import type { BackupSchedule } from "@dokploy/server/services/backup";
import type { Destination } from "@dokploy/server/services/destination";
import { scheduledJobs, scheduleJob } from "node-schedule";
import { quote } from "shell-quote";
import type { ComposeRuntimeContainerSelector } from "../docker/utils";
import { keepLatestNBackups } from ".";
import { runComposeBackup } from "./compose";
import { runLibsqlBackup } from "./libsql";
import { runMariadbBackup } from "./mariadb";
import { runMongoBackup } from "./mongo";
import { runMySqlBackup } from "./mysql";
import { runPostgresBackup } from "./postgres";
import { redactRcloneCredentials } from "./redact";
import { runWebServerBackup } from "./web-server";

export const scheduleBackup = (backup: BackupSchedule) => {
	const {
		schedule,
		backupId,
		databaseType,
		postgres,
		mysql,
		mongo,
		mariadb,
		libsql,
		compose,
	} = backup;
	scheduleJob(backupId, schedule, async () => {
		if (backup.backupType === "database") {
			if (databaseType === "postgres" && postgres) {
				await runPostgresBackup(postgres, backup);
				await keepLatestNBackups(backup, postgres.serverId);
			} else if (databaseType === "mysql" && mysql) {
				await runMySqlBackup(mysql, backup);
				await keepLatestNBackups(backup, mysql.serverId);
			} else if (databaseType === "mongo" && mongo) {
				await runMongoBackup(mongo, backup);
				await keepLatestNBackups(backup, mongo.serverId);
			} else if (databaseType === "mariadb" && mariadb) {
				await runMariadbBackup(mariadb, backup);
				await keepLatestNBackups(backup, mariadb.serverId);
			} else if (databaseType === "libsql" && libsql) {
				await runLibsqlBackup(libsql, backup);
				await keepLatestNBackups(backup, libsql.serverId);
			} else if (databaseType === "web-server") {
				await runWebServerBackup(backup);
				await keepLatestNBackups(backup);
			}
		} else if (backup.backupType === "compose" && compose) {
			await runComposeBackup(compose, backup);
			await keepLatestNBackups(backup, compose.serverId);
		}
	});
};

export const removeScheduleBackup = (backupId: string) => {
	const currentJob = scheduledJobs[backupId];
	currentJob?.cancel();
};

export const getBackupTimestamp = () =>
	new Date().toISOString().replace(/[:.]/g, "-");

export const normalizeS3Path = (prefix: string) => {
	// Trim whitespace and remove leading/trailing slashes
	const normalizedPrefix = prefix.trim().replace(/^\/+|\/+$/g, "");
	// Return empty string if prefix is empty, otherwise append trailing slash
	return normalizedPrefix ? `${normalizedPrefix}/` : "";
};

export const getS3Credentials = (
	destination: Pick<
		Destination,
		| "accessKey"
		| "additionalFlags"
		| "endpoint"
		| "provider"
		| "region"
		| "secretAccessKey"
	>,
) => {
	const { accessKey, secretAccessKey, region, endpoint, provider } =
		destination;
	const rcloneFlags = [
		`--s3-access-key-id=${quote([accessKey])}`,
		`--s3-secret-access-key=${quote([secretAccessKey])}`,
		`--s3-region=${quote([region])}`,
		`--s3-endpoint=${quote([endpoint])}`,
		"--s3-no-check-bucket",
		"--s3-force-path-style",
	];

	if (provider) {
		rcloneFlags.unshift(`--s3-provider=${quote([provider])}`);
	}

	if (destination.additionalFlags?.length) {
		rcloneFlags.push(...destination.additionalFlags);
	}

	return rcloneFlags;
};

export const RCLONE_ENCRYPTED_BACKUP_PREFIX = ".dokploy/encrypted/v1";

type RcloneDestination = Pick<
	Destination,
	| "accessKey"
	| "additionalFlags"
	| "bucket"
	| "encryptionDirectoryNames"
	| "encryptionEnabled"
	| "encryptionFilenameMode"
	| "encryptionPassword"
	| "encryptionPassword2"
	| "endpoint"
	| "provider"
	| "region"
	| "secretAccessKey"
>;

const assertEncryptedDestination: (
	destination: RcloneDestination,
) => asserts destination is RcloneDestination & {
	encryptionPassword: string;
} = (destination) => {
	if (destination.encryptionEnabled && !destination.encryptionPassword) {
		throw new Error("Encrypted destination is missing its encryption password");
	}
};

/**
 * Resolve a logical backup path through either the legacy S3 remote or the
 * isolated, versioned crypt remote. Plaintext and encrypted objects never
 * share a prefix, so existing destinations remain readable.
 */
export const getRcloneRemotePath = (
	destination: RcloneDestination,
	relativePath = "",
) => {
	assertEncryptedDestination(destination);
	const normalizedPath = relativePath.replace(/^\/+/, "");
	if (
		/[\0\r\n]/.test(normalizedPath) ||
		normalizedPath.split("/").some((segment) => segment === "..")
	) {
		throw new Error("Invalid backup path");
	}

	if (destination.encryptionEnabled) {
		return `:crypt:${normalizedPath}`;
	}

	return `:s3:${destination.bucket}${normalizedPath ? `/${normalizedPath}` : ""}`;
};

export const getRcloneEnvironment = (destination: RcloneDestination) => {
	assertEncryptedDestination(destination);
	if (!destination.encryptionEnabled) return {};

	const directoryNameEncryption =
		destination.encryptionFilenameMode === "off"
			? false
			: destination.encryptionDirectoryNames;
	const environment: Record<string, string> = {
		RCLONE_CRYPT_REMOTE: `:s3:${destination.bucket}/${RCLONE_ENCRYPTED_BACKUP_PREFIX}`,
		RCLONE_CRYPT_PASSWORD: destination.encryptionPassword,
		RCLONE_CRYPT_FILENAME_ENCRYPTION: destination.encryptionFilenameMode,
		RCLONE_CRYPT_DIRECTORY_NAME_ENCRYPTION: String(directoryNameEncryption),
	};

	if (destination.encryptionPassword2) {
		environment.RCLONE_CRYPT_PASSWORD2 = destination.encryptionPassword2;
	}

	return environment;
};

export const getRcloneExecOptions = (
	destination: RcloneDestination,
): { env: NodeJS.ProcessEnv } => ({
	env: {
		...process.env,
		...getRcloneEnvironment(destination),
	},
});

/**
 * Build one shell-safe rclone invocation. Passwords are rclone-obscured before
 * persistence. The caller must inject `getRcloneEnvironment(destination)` via
 * the process environment; no crypt secret is included in this command.
 */
export const buildRcloneCommand = (
	destination: RcloneDestination,
	args: [string, ...string[]],
) => {
	const [subcommand, ...subcommandArgs] = args;
	return [
		"rclone",
		subcommand,
		...getS3Credentials(destination),
		...subcommandArgs.map((argument) => quote([argument])),
	].join(" ");
};

// User-controlled values (database name, user, password) are passed to the
// container as environment variables via `docker exec -e VAR=<escaped>` and
// referenced as "$VAR" inside the inner shell, so they never appear in the
// inner command text. The -e value is escaped for the outer shell with
// shell-quote; the inner script is single-quoted and reads the env vars.
export const getPostgresBackupCommand = (
	database: string,
	databaseUser: string,
) => {
	return `docker exec -e DB_NAME=${quote([database])} -e DB_USER=${quote([databaseUser])} -i $CONTAINER_ID bash -c 'set -o pipefail; pg_dump -Fc --no-acl --no-owner -h localhost -U "$DB_USER" --no-password "$DB_NAME" | gzip'`;
};

export const getMariadbBackupCommand = (
	database: string,
	databaseUser: string,
	databasePassword: string,
) => {
	return `docker exec -e DB_NAME=${quote([database])} -e DB_USER=${quote([databaseUser])} -e DB_PASS=${quote([databasePassword])} -i $CONTAINER_ID bash -c 'set -o pipefail; mariadb-dump --user="$DB_USER" --password="$DB_PASS" --single-transaction --quick --databases "$DB_NAME" | gzip'`;
};

export const getMysqlBackupCommand = (
	database: string,
	databasePassword: string,
) => {
	return `docker exec -e DB_NAME=${quote([database])} -e DB_PASS=${quote([databasePassword])} -i $CONTAINER_ID bash -c 'set -o pipefail; mysqldump --default-character-set=utf8mb4 -u root --password="$DB_PASS" --single-transaction --no-tablespaces --quick "$DB_NAME" | gzip'`;
};

export const getMongoBackupCommand = (
	database: string,
	databaseUser: string,
	databasePassword: string,
) => {
	return `docker exec -e DB_NAME=${quote([database])} -e DB_USER=${quote([databaseUser])} -e DB_PASS=${quote([databasePassword])} -i $CONTAINER_ID bash -c 'set -o pipefail; mongodump -d "$DB_NAME" -u "$DB_USER" -p "$DB_PASS" --archive --authenticationDatabase admin --gzip'`;
};

export const getLibsqlBackupCommand = (database: string) => {
	return `docker exec -e DB_NAME=${quote([database])} -i $CONTAINER_ID sh -c 'tar cf - -C /var/lib/sqld "$DB_NAME" | gzip'`;
};

export const getServiceContainerCommand = (appName: string) => {
	return `docker ps -q --filter "status=running" --filter "label=com.docker.swarm.service.name=${appName}" | head -n 1`;
};

export const getComposeContainerCommand = (
	appName: string,
	serviceName: string,
	composeType: "stack" | "docker-compose" | undefined,
	runtimeSelector?: ComposeRuntimeContainerSelector | null,
) => {
	const filter = (value: string) => `--filter ${quote([value])}`;
	if (composeType === "stack") {
		return `docker ps -q ${filter("status=running")} ${filter(
			`label=com.docker.stack.namespace=${appName}`,
		)} ${filter(
			`label=com.docker.swarm.service.name=${appName}_${serviceName}`,
		)} | head -n 1`;
	}
	if (runtimeSelector) {
		return `docker ps -q ${filter("status=running")} ${filter(
			`label=com.dokploy.compose-id=${runtimeSelector.composeId}`,
		)} ${filter(
			`label=com.dokploy.deployment-id=${runtimeSelector.deploymentId}`,
		)} ${filter(
			`label=com.docker.compose.service=${serviceName}`,
		)} | head -n 1`;
	}
	return `docker ps -q ${filter("status=running")} ${filter(
		`label=com.docker.compose.project=${appName}`,
	)} ${filter(`label=com.docker.compose.service=${serviceName}`)} | head -n 1`;
};

const getContainerSearchCommand = (
	backup: BackupSchedule,
	runtimeSelector?: ComposeRuntimeContainerSelector | null,
) => {
	const {
		backupType,
		postgres,
		mysql,
		mariadb,
		mongo,
		libsql,
		compose,
		serviceName,
	} = backup;

	if (backupType === "database") {
		const appName =
			postgres?.appName ||
			mysql?.appName ||
			mariadb?.appName ||
			mongo?.appName ||
			libsql?.appName;
		return getServiceContainerCommand(appName || "");
	}
	if (backupType === "compose") {
		const { appName, composeType } = compose || {};
		return getComposeContainerCommand(
			appName || "",
			serviceName || "",
			composeType,
			runtimeSelector,
		);
	}
};

export const generateBackupCommand = (backup: BackupSchedule) => {
	const { backupType, databaseType } = backup;
	switch (databaseType) {
		case "postgres": {
			const postgres = backup.postgres;
			if (backupType === "database" && postgres) {
				return getPostgresBackupCommand(backup.database, postgres.databaseUser);
			}
			if (backupType === "compose" && backup.metadata?.postgres) {
				return getPostgresBackupCommand(
					backup.database,
					backup.metadata.postgres.databaseUser,
				);
			}
			break;
		}
		case "mysql": {
			const mysql = backup.mysql;
			if (backupType === "database" && mysql) {
				return getMysqlBackupCommand(
					backup.database,
					mysql.databaseRootPassword,
				);
			}
			if (backupType === "compose" && backup.metadata?.mysql) {
				return getMysqlBackupCommand(
					backup.database,
					backup.metadata?.mysql?.databaseRootPassword || "",
				);
			}
			break;
		}
		case "mariadb": {
			const mariadb = backup.mariadb;
			if (backupType === "database" && mariadb) {
				return getMariadbBackupCommand(
					backup.database,
					mariadb.databaseUser,
					mariadb.databasePassword,
				);
			}
			if (backupType === "compose" && backup.metadata?.mariadb) {
				return getMariadbBackupCommand(
					backup.database,
					backup.metadata.mariadb.databaseUser,
					backup.metadata.mariadb.databasePassword,
				);
			}
			break;
		}
		case "mongo": {
			const mongo = backup.mongo;
			if (backupType === "database" && mongo) {
				return getMongoBackupCommand(
					backup.database,
					mongo.databaseUser,
					mongo.databasePassword,
				);
			}
			if (backupType === "compose" && backup.metadata?.mongo) {
				return getMongoBackupCommand(
					backup.database,
					backup.metadata.mongo.databaseUser,
					backup.metadata.mongo.databasePassword,
				);
			}
			break;
		}
		case "libsql": {
			if (backupType === "database") {
				return getLibsqlBackupCommand(backup.database);
			}
			break;
		}
		default:
			throw new Error(`Database type not supported: ${databaseType}`);
	}

	return null;
};

export const getBackupCommand = (
	backup: BackupSchedule,
	rcloneCommand: string,
	logPath: string,
	runtimeSelector?: ComposeRuntimeContainerSelector | null,
) => {
	const containerSearch = getContainerSearchCommand(backup, runtimeSelector);
	const backupCommand = generateBackupCommand(backup);

	logger.info(
		{
			containerSearch,
			backupCommand,
			rcloneCommand: redactRcloneCredentials(rcloneCommand),
			logPath,
		},
		`Executing backup command: ${backup.databaseType} ${backup.backupType}`,
	);

	return `
	set -eo pipefail;
	echo "[$(date)] Starting backup process..." >> ${logPath};
	echo "[$(date)] Executing backup command..." >> ${logPath};
	CONTAINER_ID=$(${containerSearch})

	if [ -z "$CONTAINER_ID" ]; then
		echo "[$(date)] ❌ Error: Container not found" >> ${logPath};
		exit 1;
	fi

	echo "[$(date)] Container Up: $CONTAINER_ID" >> ${logPath};

	# Run the backup command and capture the exit status
	BACKUP_OUTPUT=$(${backupCommand} 2>&1 >/dev/null) || {
		echo "[$(date)] ❌ Error: Backup failed" >> ${logPath};
		echo "Error: $BACKUP_OUTPUT" >> ${logPath};
		exit 1;
	}

	echo "[$(date)] ✅ backup completed successfully" >> ${logPath};
	echo "[$(date)] Starting upload to S3..." >> ${logPath};

	# Run the upload command and capture the exit status
	UPLOAD_OUTPUT=$(${backupCommand} | ${rcloneCommand} 2>&1 >/dev/null) || {
		echo "[$(date)] ❌ Error: Upload to S3 failed" >> ${logPath};
		echo "Error: $UPLOAD_OUTPUT" >> ${logPath};
		exit 1;
	}

	echo "[$(date)] ✅ Upload to S3 completed successfully" >> ${logPath};
	echo "Backup done ✅" >> ${logPath};
	`;
};
