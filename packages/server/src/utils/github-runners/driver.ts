import { inGuest, macProbeScript } from "./macos";
import {
	type LinuxFacts,
	type MacStatus,
	parseLinuxFacts,
	parseMacStatus,
	parseRecords,
	parseRuntimeStatus,
	type RuntimeStatus,
} from "./probe";
import { linuxFactsScript, statusCommand } from "./runtime";
import type { NodeSession, RunOptions } from "./ssh";

export type RunnerPlatform = "linux" | "macos";

/** What a probe of a machine reports, whatever its platform. */
export interface NodeProbe {
	platform: RunnerPlatform;
	/** The physical machine the budget is a share of. */
	host: {
		os: string;
		arch: string;
		cpus: number;
		memoryBytes: number;
		diskFreeBytes: number;
		diskTotalBytes: number;
		load: number | null;
		memoryFreePercent: number | null;
	} | null;
	/** macOS only: the Lima VM. */
	vm: MacStatus["vm"] | null;
	limaVersion: string | null;
	githubReachable: boolean | null;
	/** Runtime inside the VM or on the Linux host; null when the VM is not running. */
	runtime: RuntimeStatus | null;
	runtimeError: string | null;
}

/**
 * Runs commands against the Linux runtime of a machine: directly (with sudo) on
 * a Linux host, through `limactl shell` on a Mac.
 */
export interface NodeDriver {
	platform: RunnerPlatform;
	session: NodeSession;
	/** Runs a command as root where the runtime lives. */
	guest: (
		command: string,
		options?: RunOptions,
	) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
	/** Runs a script on the machine itself (the Mac host for macOS). */
	host: NodeSession["run"];
	probe: () => Promise<NodeProbe>;
}

export const createNodeDriver = (
	session: NodeSession,
	node: { platform: RunnerPlatform; vmName: string; username: string },
): NodeDriver => {
	if (node.platform === "macos") {
		return {
			platform: "macos",
			session,
			guest: (command, options) =>
				session.run(inGuest(node.vmName, command), {
					...options,
					input: options?.input ?? "",
				}),
			host: session.run,
			probe: async () => {
				const { stdout } = await session.run(
					macProbeScript(node.vmName, true),
					{ label: "Probe", timeoutMs: 60_000 },
				);
				const status = parseMacStatus(stdout);
				return {
					platform: "macos",
					host: status.host
						? {
								os: `macOS ${status.host.version}`,
								arch: status.host.arch,
								cpus: status.host.cpus,
								memoryBytes: status.host.memoryBytes,
								diskFreeBytes: status.disk?.freeBytes ?? 0,
								diskTotalBytes: status.disk?.totalBytes ?? 0,
								load: status.host.load,
								memoryFreePercent: status.memoryFreePercent,
							}
						: null,
					vm: status.vm,
					limaVersion: status.limaVersion,
					githubReachable: status.githubReachable,
					runtime: status.guest,
					runtimeError: status.guestError,
				};
			},
		};
	}

	const sudo = node.username === "root" ? "" : "sudo -n ";
	return {
		platform: "linux",
		session,
		guest: (command, options) =>
			session.run(`${sudo}${command}`, {
				...options,
				input: options?.input ?? "",
			}),
		host: session.run,
		probe: async () => {
			const { stdout } = await session.run(`${sudo}${statusCommand}`, {
				label: "Probe",
				timeoutMs: 60_000,
				input: "",
			});
			const runtime = parseRuntimeStatus(parseRecords(stdout));
			return {
				platform: "linux",
				host:
					runtime.host && runtime.disk
						? {
								os: "Linux",
								arch: runtime.host.arch,
								cpus: runtime.host.cpus,
								memoryBytes: runtime.host.memoryBytes,
								diskFreeBytes: runtime.disk.freeBytes,
								diskTotalBytes: runtime.disk.totalBytes,
								load: runtime.host.load,
								memoryFreePercent:
									runtime.host.availableBytes === null
										? null
										: Math.round(
												(runtime.host.availableBytes /
													runtime.host.memoryBytes) *
													100,
											),
							}
						: null,
				vm: null,
				limaVersion: null,
				githubReachable: null,
				runtime: runtime.runtimeVersion > 0 ? runtime : null,
				runtimeError: null,
			};
		},
	};
};

export const readLinuxFacts = async (session: NodeSession) => {
	const { stdout } = await session.run(linuxFactsScript(), {
		label: "Facts",
		timeoutMs: 60_000,
	});
	return parseLinuxFacts(stdout);
};

export const readMacStatus = async (session: NodeSession, vmName: string) => {
	const { stdout } = await session.run(macProbeScript(vmName, false), {
		label: "Facts",
		timeoutMs: 60_000,
	});
	return parseMacStatus(stdout);
};

export const detectPlatform = async (
	session: NodeSession,
): Promise<RunnerPlatform | string> => {
	const { stdout } = await session.run("uname -s", {
		label: "Platform detection",
		timeoutMs: 20_000,
	});
	const kernel = stdout.trim();
	if (kernel === "Darwin") return "macos";
	if (kernel === "Linux") return "linux";
	return kernel;
};

export type { LinuxFacts, MacStatus };
