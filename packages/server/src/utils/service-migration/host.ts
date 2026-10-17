import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { paths } from "@dokploy/server/constants";
import { findServerById } from "@dokploy/server/services/server";
import { getWebServerSettings } from "@dokploy/server/services/web-server-settings";
import { Client, type ClientChannel } from "ssh2";
import { withRemoteCommandEnvironment } from "../process/execAsync";

/** A machine taking part in a migration: a remote server, or the Dokploy server when serverId is null. */
export interface MigrationHost {
	serverId: string | null;
	name: string;
	ipAddress: string | null;
}

export class HostCommandError extends Error {
	constructor(
		readonly host: MigrationHost,
		readonly command: string,
		readonly exitCode: number | null,
		readonly stdout: string,
		readonly stderr: string,
	) {
		const output = (stderr || stdout).trim().split("\n").slice(-5).join("\n");
		super(
			`Command failed on ${host.name} (exit ${exitCode ?? "unknown"})${
				output ? `: ${output}` : ""
			}`,
		);
	}
}

interface HostProcess {
	stdin: Writable;
	stdout: Readable;
	stderr: Readable;
	done: Promise<number | null>;
	kill: () => void;
}

export interface HostExecutor {
	host: MigrationHost;
	paths: ReturnType<typeof paths>;
	run: (
		command: string,
		options?: { input?: string; allowFailure?: boolean },
	) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
	open: (command: string) => Promise<HostProcess>;
	close: () => void;
}

export const resolveMigrationHost = async (
	serverId: string | null,
): Promise<MigrationHost> => {
	if (!serverId) {
		const settings = await getWebServerSettings();
		return {
			serverId: null,
			name: "Dokploy server",
			ipAddress: settings?.serverIp || null,
		};
	}
	const server = await findServerById(serverId);
	return { serverId, name: server.name, ipAddress: server.ipAddress };
};

const openLocalProcess = (command: string): HostProcess => {
	const child = spawn("sh", ["-c", command], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	const done = new Promise<number | null>((resolve) => {
		child.on("error", () => resolve(127));
		child.on("close", (code) => resolve(code));
	});
	// A process that never reads stdin must not crash Dokploy with EPIPE.
	child.stdin.on("error", () => {});
	return {
		stdin: child.stdin,
		stdout: child.stdout,
		stderr: child.stderr,
		done,
		kill: () => child.kill("SIGKILL"),
	};
};

const connectToServer = async (serverId: string) => {
	const server = await findServerById(serverId);
	if (!server.sshKey?.privateKey) {
		throw new Error(`Server ${server.name} has no SSH key`);
	}
	const connection = new Client();
	await new Promise<void>((resolve, reject) => {
		connection
			.once("ready", () => resolve())
			.once("error", (error) =>
				reject(
					new Error(
						`Unable to connect to ${server.name} (${server.ipAddress}:${server.port}): ${error.message}`,
					),
				),
			)
			.connect({
				host: server.ipAddress,
				port: server.port,
				username: server.username,
				privateKey: server.sshKey?.privateKey,
				readyTimeout: 20_000,
				keepaliveInterval: 10_000,
			});
	});
	// Errors after the handshake surface through the channels of each command.
	connection.on("error", () => {});
	return connection;
};

const openRemoteProcess = (
	connection: Client,
	command: string,
): Promise<HostProcess> =>
	new Promise((resolve, reject) => {
		connection.exec(
			withRemoteCommandEnvironment(command),
			(error, channel: ClientChannel) => {
				if (error) {
					reject(error);
					return;
				}
				let exitCode: number | null = null;
				channel.on("exit", (code: number | null) => {
					exitCode = code;
				});
				const done = new Promise<number | null>((resolveDone) => {
					channel.on("close", (code?: number | null) => {
						resolveDone(exitCode ?? (typeof code === "number" ? code : null));
					});
				});
				channel.on("error", () => {});
				resolve({
					stdin: channel,
					stdout: channel,
					stderr: channel.stderr,
					done,
					kill: () => channel.close(),
				});
			},
		);
	});

/**
 * Opens a session on a host. Remote hosts reuse a single SSH connection for every
 * command, which keeps the dozens of probes run by the checks fast.
 */
export const createHostExecutor = async (
	host: MigrationHost,
): Promise<HostExecutor> => {
	const connection = host.serverId
		? await connectToServer(host.serverId)
		: null;

	const open = async (command: string) =>
		connection
			? await openRemoteProcess(connection, command)
			: openLocalProcess(command);

	const run: HostExecutor["run"] = async (command, options = {}) => {
		const child = await open(command);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		child.stdin.end(options.input ?? "");
		const exitCode = await child.done;
		if (exitCode !== 0 && !options.allowFailure) {
			throw new HostCommandError(host, command, exitCode, stdout, stderr);
		}
		return { stdout, stderr, exitCode };
	};

	return {
		host,
		paths: paths(Boolean(host.serverId)),
		run,
		open,
		close: () => connection?.end(),
	};
};

const collect = (stream: Readable) => {
	let output = "";
	stream.on("data", (data: Buffer) => {
		output = `${output}${data.toString()}`.slice(-4000);
	});
	return () => output;
};

/**
 * Streams the stdout of a command on the source into the stdin of a command on
 * the target, through the Dokploy server. Returns the number of bytes copied.
 *
 * The source is always read to its end: readers such as `tar -x` exit as soon as
 * they see the end-of-archive marker, and a paused SSH channel never reports its
 * own exit.
 */
export const pipeBetweenHosts = async (
	source: HostExecutor,
	sourceCommand: string,
	target: HostExecutor,
	targetCommand: string,
	onProgress?: (bytes: number) => void,
) => {
	const reader = await source.open(sourceCommand);
	let writer: HostProcess;
	try {
		writer = await target.open(targetCommand);
	} catch (error) {
		reader.kill();
		throw error;
	}
	reader.stdin.end();
	const readerErrors = collect(reader.stderr);
	const writerErrors = collect(writer.stderr);
	const writerOutput = collect(writer.stdout);
	writer.stdin.on("error", () => {});

	let bytes = 0;
	let writerOpen = true;
	reader.stdout.on("data", (chunk: Buffer) => {
		bytes += chunk.length;
		onProgress?.(bytes);
		if (!writerOpen) return;
		if (!writer.stdin.write(chunk)) {
			reader.stdout.pause();
			writer.stdin.once("drain", () => reader.stdout.resume());
		}
	});
	reader.stdout.on("end", () => {
		if (writerOpen) writer.stdin.end();
	});

	const writerCode = await writer.done.then((code) => {
		writerOpen = false;
		// Keep draining whatever the source still sends.
		reader.stdout.resume();
		return code;
	});
	if (writerCode !== 0) {
		reader.kill();
		await reader.done;
		throw new HostCommandError(
			target.host,
			targetCommand,
			writerCode,
			writerOutput(),
			writerErrors(),
		);
	}
	const readerCode = await reader.done;
	if (readerCode !== 0) {
		throw new HostCommandError(
			source.host,
			sourceCommand,
			readerCode,
			"",
			readerErrors(),
		);
	}
	return bytes;
};
