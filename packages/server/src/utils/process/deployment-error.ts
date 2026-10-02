import { ExecError } from "./ExecError";

/** Format the captured diagnostic without dumping the deployment shell script. */
export const formatDeploymentError = (error: unknown): string => {
	if (!(error instanceof ExecError)) {
		return error instanceof Error ? error.message : String(error);
	}

	// Local exec messages include the entire command, which can contain credentials
	// and base64-encoded environment files. Never include that script in the UI.
	const message = error.command
		? error.message.split(error.command).join("[deployment command]")
		: error.message;
	const output = [error.stderr?.trim(), error.stdout?.trim()]
		.filter(Boolean)
		.join("\n");
	return [
		error.exitCode !== undefined
			? `Command failed (exit code ${error.exitCode}).`
			: "Command execution failed.",
		output || message,
		!output && error.exitCode !== undefined
			? "No additional output was captured. See the preceding deployment log lines for the command output."
			: null,
	]
		.filter(Boolean)
		.join("\n");
};

const deploymentDiagnostics = new WeakMap<object, string>();

/** Attach a runtime diagnostics digest to a deployment failure. */
export const attachDeploymentDiagnostics = (
	error: unknown,
	summary: string,
) => {
	if (typeof error === "object" && error !== null && summary) {
		deploymentDiagnostics.set(error, summary);
	}
};

/**
 * The persisted deployment error: the formatted cause plus the diagnostics
 * digest. Notifications keep using `formatDeploymentError` so application
 * logs are never forwarded to third-party channels.
 */
export const formatDeploymentErrorWithDiagnostics = (
	error: unknown,
	errorMessage = formatDeploymentError(error),
): string => {
	const summary =
		typeof error === "object" && error !== null
			? deploymentDiagnostics.get(error)
			: undefined;
	return summary ? `${errorMessage}\n\n${summary}` : errorMessage;
};
