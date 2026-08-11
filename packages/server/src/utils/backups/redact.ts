/**
 * Redacts S3 credentials from rclone command strings.
 *
 * Used to prevent credential leakage in structured logs and error output.
 * Matches the shell-token format produced by `shell-quote`, plus the obscured
 * rclone crypt environment variables used by encrypted destinations.
 */
export const redactRcloneCredentials = (command: string): string => {
	return command
		.replace(
			/(--s3-access-key-id=)(?:'[^']*'|"[^"]*"|[^\s]+)/g,
			'$1"[REDACTED]"',
		)
		.replace(
			/(--s3-secret-access-key=)(?:'[^']*'|"[^"]*"|[^\s]+)/g,
			'$1"[REDACTED]"',
		)
		.replace(
			/(RCLONE_CRYPT_PASSWORD2?=)(?:'[^']*'|"[^"]*"|[^\s]+)/g,
			'$1"[REDACTED]"',
		);
};

export const getSafeRcloneErrorMessage = (
	error: unknown,
	fallback = "Rclone command failed",
) => {
	const message = error instanceof Error ? error.message : String(error);
	return redactRcloneCredentials(message) || fallback;
};
