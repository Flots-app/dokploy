import { createHash } from "node:crypto";
import { Client, type ClientChannel } from "ssh2";
import { shellQuote } from "./runtime";

export interface NodeConnection {
	name: string;
	host: string;
	port: number;
	username: string;
	privateKey: string;
	/** Pinned SHA256 fingerprint; null accepts the first key presented (checks only). */
	hostKeyFingerprint: string | null;
	/**
	 * Without a pinned key: the host keys known out of band (from the setup
	 * script of the machine); any other key is refused before authenticating.
	 */
	knownHostKeys?: string[];
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

/**
 * A command that certainly never reached the machine: its connection was
 * already closed. Running it again on a new connection is safe.
 */
export class NodeNotStartedError extends Error {}

export class HostKeyMismatchError extends Error {
	constructor(node: string, expected: string, presented: string) {
		super(
			`The SSH host key of ${node} changed (expected ${expected}, presented ${presented}). Refusing to connect: verify the machine, then reset its host key in Dokploy.`,
		);
	}
}

export class UnknownHostKeyError extends Error {
	constructor(node: string, presented: string) {
		super(
			`${node} presented the host key ${presented}, which the setup code of the machine does not list. Refusing to connect: check the address, or run the setup script again and paste its new code.`,
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
	let mismatch: HostKeyMismatchError | UnknownHostKeyError | null = null;
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
					if (
						!connection.hostKeyFingerprint &&
						connection.knownHostKeys &&
						!connection.knownHostKeys.includes(presented)
					) {
						mismatch = new UnknownHostKeyError(connection.name, presented);
						return false;
					}
					return true;
				},
			});
	});
	// Errors after the handshake surface through the channel of each command.
	client.on("error", () => {});
	// Keepalive, a reboot or the network close the connection: later commands
	// fail without sending anything, so the shared connection can be replaced.
	let closed = false;
	client.on("close", () => {
		closed = true;
	});

	const run: NodeSession["run"] = (script, runOptions = {}) =>
		new Promise((resolve, reject) => {
			const label = runOptions.label ?? "Command";
			const command =
				runOptions.input === undefined
					? "/bin/bash -s"
					: `/bin/bash -c ${shellQuote(script)}`;
			const notStarted = (reason: string) =>
				reject(
					new NodeNotStartedError(
						`${label} could not start on ${connection.name}: ${reason}`,
					),
				);
			if (closed) {
				notStarted("the connection is closed");
				return;
			}
			const onChannel = (error: Error | undefined, channel: ClientChannel) => {
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
			};
			try {
				client.exec(command, onChannel);
			} catch (error) {
				// ssh2 throws "Not connected" before sending anything.
				notStarted(error instanceof Error ? error.message : String(error));
			}
		});

	return {
		fingerprint: presented,
		run,
		close: () => client.end(),
	};
};

// ------------------------------------------------------------ shared sessions

/** Shared sessions are closed after this long without a command. */
const SHARED_IDLE_MS = 5 * 60_000;

interface SharedEntry {
	/** user@host:port, to close the connections of one machine. */
	target: string;
	session: Promise<NodeSession>;
	lastUsed: number;
	busy: number;
}

const targetOf = (
	connection: Pick<NodeConnection, "host" | "port" | "username">,
) => `${connection.username}@${connection.host}:${connection.port}`;

/**
 * One SSH connection per machine, shared by the controller ticks and tasks:
 * a new login every few seconds costs a handshake each time and fills the
 * machine's auth logs. Lives on globalThis like the controller state, so the
 * server entry point and the Next.js routes share it.
 */
const sharedState = globalThis as {
	__dokployRunnerSessions?: {
		entries: Map<string, SharedEntry>;
		sweeper: NodeJS.Timeout | null;
	};
};
sharedState.__dokployRunnerSessions ??= { entries: new Map(), sweeper: null };
const shared = sharedState.__dokployRunnerSessions;

const sharedKey = (connection: NodeConnection) =>
	createHash("sha256")
		.update(
			JSON.stringify([
				connection.host,
				connection.port,
				connection.username,
				connection.privateKey,
				connection.hostKeyFingerprint,
			]),
		)
		.digest("hex");

const evict = (key: string, entry: SharedEntry) => {
	if (shared.entries.get(key) !== entry) return;
	shared.entries.delete(key);
	entry.session.then((session) => session.close()).catch(() => undefined);
};

const sweep = () => {
	const now = Date.now();
	for (const [key, entry] of shared.entries) {
		if (entry.busy === 0 && now - entry.lastUsed > SHARED_IDLE_MS) {
			evict(key, entry);
		}
	}
	if (!shared.entries.size && shared.sweeper) {
		clearInterval(shared.sweeper);
		shared.sweeper = null;
	}
};

/**
 * A session on the shared connection of a machine. close() only releases it;
 * the connection is replaced once a command fails for any reason other than
 * the command itself, and closed after idling. A command that never left
 * (NodeNotStartedError: the connection was already closed) is retried once on
 * a new connection; any other failure is not, since the command may have run.
 */
export const sharedNodeSession = async (
	connection: NodeConnection,
	open: typeof openNodeSession = openNodeSession,
): Promise<NodeSession> => {
	const key = sharedKey(connection);
	const acquire = () => {
		let entry = shared.entries.get(key);
		if (!entry) {
			const session = open(connection);
			entry = {
				target: targetOf(connection),
				session,
				lastUsed: Date.now(),
				busy: 0,
			};
			const created = entry;
			shared.entries.set(key, created);
			session.catch(() => evict(key, created));
			shared.sweeper ??= setInterval(sweep, 60_000);
			shared.sweeper.unref?.();
		}
		return entry;
	};
	const session = await acquire().session;
	const run: NodeSession["run"] = async (script, options) => {
		for (let attempt = 0; ; attempt++) {
			// The entry may have been replaced since this session was handed out.
			const entry = acquire();
			entry.busy++;
			entry.lastUsed = Date.now();
			try {
				return await (await entry.session).run(script, options);
			} catch (error) {
				// The command ran and failed (or timed out): the connection is fine.
				if (error instanceof NodeCommandError) throw error;
				evict(key, entry);
				if (!(error instanceof NodeNotStartedError) || attempt > 0) {
					throw error;
				}
			} finally {
				entry.busy--;
				entry.lastUsed = Date.now();
			}
		}
	};
	return { fingerprint: session.fingerprint, run, close: () => undefined };
};

/** Closes the shared connections to a machine, e.g. after its key changed. */
export const closeSharedSessions = (
	connection: Pick<NodeConnection, "host" | "port" | "username">,
) => {
	const target = targetOf(connection);
	for (const [key, entry] of shared.entries) {
		if (entry.target === target) evict(key, entry);
	}
};
