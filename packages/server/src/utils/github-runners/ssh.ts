import { createHash } from "node:crypto";
import { Client } from "ssh2";
import { shellQuote } from "./runtime";

export interface NodeConnection {
	name: string;
	host: string;
	port: number;
	username: string;
	privateKey: string;
	/** Pinned SHA256 fingerprint; null accepts the first key presented (checks only). */
	hostKeyFingerprint: string | null;
}

export class NodeCommandError extends Error {
	constructor(
		readonly node: string,
		readonly exitCode: number | null,
		readonly stdout: string,
		readonly stderr: string,
		label: string,
	) {
		const output = (stderr || stdout).trim().split("\n").slice(-6).join("\n");
		super(
			`${label} failed on ${node} (exit ${exitCode ?? "unknown"})${output ? `: ${output}` : ""}`,
		);
	}
}

export class HostKeyMismatchError extends Error {
	constructor(node: string, expected: string, presented: string) {
		super(
			`The SSH host key of ${node} changed (expected ${expected}, presented ${presented}). Refusing to connect: verify the machine, then reset its host key in Dokploy.`,
		);
	}
}

export const fingerprintOf = (key: Buffer) =>
	`SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;

export interface RunOptions {
	input?: string;
	timeoutMs?: number;
	allowFailure?: boolean;
	/** Short description used in errors and logs. */
	label?: string;
	onOutput?: (chunk: string) => void;
}

export interface NodeSession {
	fingerprint: string;
	/**
	 * Runs a bash script. Without input the script itself goes through stdin, so
	 * it does not depend on the login shell (zsh on macOS) nor on argument limits.
	 */
	run: (
		script: string,
		options?: RunOptions,
	) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
	close: () => void;
}

const MAX_OUTPUT = 512 * 1024;

export const openNodeSession = async (
	connection: NodeConnection,
	options: { readyTimeoutMs?: number } = {},
): Promise<NodeSession> => {
	const client = new Client();
	let presented = "";
	let mismatch: HostKeyMismatchError | null = null;
	await new Promise<void>((resolve, reject) => {
		client
			.once("ready", () => resolve())
			.once("error", (error) =>
				reject(
					mismatch ??
						new Error(
							`Unable to connect to ${connection.name} (${connection.host}:${connection.port}): ${error.message}`,
						),
				),
			)
			.connect({
				host: connection.host,
				port: connection.port,
				username: connection.username,
				privateKey: connection.privateKey,
				readyTimeout: options.readyTimeoutMs ?? 15_000,
				keepaliveInterval: 10_000,
				keepaliveCountMax: 3,
				hostVerifier: (key: Buffer) => {
					presented = fingerprintOf(key);
					if (
						connection.hostKeyFingerprint &&
						connection.hostKeyFingerprint !== presented
					) {
						mismatch = new HostKeyMismatchError(
							connection.name,
							connection.hostKeyFingerprint,
							presented,
						);
						return false;
					}
					return true;
				},
			});
	});
	// Errors after the handshake surface through the channel of each command.
	client.on("error", () => {});

	const run: NodeSession["run"] = (script, runOptions = {}) =>
		new Promise((resolve, reject) => {
			const label = runOptions.label ?? "Command";
			const command =
				runOptions.input === undefined
					? "/bin/bash -s"
					: `/bin/bash -c ${shellQuote(script)}`;
			client.exec(command, (error, channel) => {
				if (error) {
					reject(
						new Error(
							`${label} could not start on ${connection.name}: ${error.message}`,
						),
					);
					return;
				}
				let stdout = "";
				let stderr = "";
				let exitCode: number | null = null;
				let settled = false;
				const timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					channel.close();
					reject(
						new NodeCommandError(
							connection.name,
							null,
							stdout,
							`${stderr}\n${label} timed out after ${Math.round((runOptions.timeoutMs ?? 60_000) / 1000)} s`,
							label,
						),
					);
				}, runOptions.timeoutMs ?? 60_000);
				channel.on("data", (data: Buffer) => {
					const text = data.toString();
					stdout = (stdout + text).slice(-MAX_OUTPUT);
					runOptions.onOutput?.(text);
				});
				channel.stderr.on("data", (data: Buffer) => {
					const text = data.toString();
					stderr = (stderr + text).slice(-MAX_OUTPUT);
					runOptions.onOutput?.(text);
				});
				channel.on("exit", (code: number | null) => {
					exitCode = code;
				});
				channel.on("error", () => {});
				channel.on("close", (code?: number | null) => {
					exitCode ??= typeof code === "number" ? code : null;
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (exitCode !== 0 && !runOptions.allowFailure) {
						reject(
							new NodeCommandError(
								connection.name,
								exitCode,
								stdout,
								stderr,
								label,
							),
						);
						return;
					}
					resolve({ stdout, stderr, exitCode });
				});
				channel.end(runOptions.input ?? `${script}\n`);
			});
		});

	return {
		fingerprint: presented,
		run,
		close: () => client.end(),
	};
};
