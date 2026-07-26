import { execFileSync, execSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	defaultCommand,
	detectOperatingSystem,
	installMacDocker,
	remoteCommandEnvironment,
	reportDockerVersion,
	serverValidationCommand,
	validateBuildServerDependencies,
	validateDocker,
	validateOperatingSystem,
	withRemoteCommandEnvironment,
} from "@dokploy/server";
import { describe, expect, it } from "vitest";

const resolveBin = (name: string) =>
	execSync(`command -v ${name}`, { encoding: "utf8" }).trim();

/**
 * Build a sandbox PATH so `command -v docker` only sees our fake docker
 * binary (or nothing), regardless of what the host has installed.
 */
const makeSandbox = (dockerShim?: string) => {
	const dir = mkdtempSync(path.join(tmpdir(), "dokploy-server-setup-"));
	for (const tool of ["awk", "cut", "sed", "tr"]) {
		const shim = path.join(dir, tool);
		writeFileSync(shim, `#!/bin/sh\nexec ${resolveBin(tool)} "$@"\n`);
		chmodSync(shim, 0o755);
	}
	if (dockerShim) {
		const shim = path.join(dir, "docker");
		writeFileSync(shim, dockerShim);
		chmodSync(shim, 0o755);
	}
	return dir;
};

const addShim = (dir: string, name: string, contents: string) => {
	const shim = path.join(dir, name);
	writeFileSync(shim, contents);
	chmodSync(shim, 0o755);
};

const makeDarwinSandbox = (version = "14.7.2") => {
	const dir = makeSandbox();
	addShim(
		dir,
		"uname",
		[
			"#!/bin/sh",
			'[ "$1" = "-s" ] && { echo Darwin; exit 0; }',
			'[ "$1" = "-m" ] && { echo arm64; exit 0; }',
			"echo Darwin",
		].join("\n"),
	);
	addShim(
		dir,
		"sw_vers",
		[
			"#!/bin/sh",
			`[ "$1" = "-productVersion" ] && { echo ${version}; exit 0; }`,
			"exit 1",
		].join("\n"),
	);
	return dir;
};

const runReport = (sandboxPath: string) => {
	const script = [
		"DOCKER_VERSION=28.5.0",
		reportDockerVersion(),
		'echo "$DOCKER_VERSION_REPORT"',
	].join("\n");
	return execFileSync(resolveBin("bash"), ["-c", script], {
		encoding: "utf8",
		env: { ...process.env, PATH: sandboxPath },
	})
		.trim()
		.split("\n")
		.pop();
};

describe("reportDockerVersion", () => {
	it("reports the engine version when docker and its daemon are available", () => {
		const sandbox = makeSandbox(
			[
				"#!/bin/sh",
				'if [ "$1" = "--version" ]; then',
				'	echo "Docker version 25.0.0, build aaaaaaa"',
				"	exit 0",
				"fi",
				'if [ "$1" = "version" ]; then',
				'	echo "29.4.3"',
				"	exit 0",
				"fi",
				"exit 1",
			].join("\n"),
		);
		expect(runReport(sandbox)).toBe("29.4.3 (already installed)");
	});

	it("falls back to the client version when the daemon is unreachable", () => {
		const sandbox = makeSandbox(
			[
				"#!/bin/sh",
				'if [ "$1" = "--version" ]; then',
				'	echo "Docker version 29.4.3, build 055a478"',
				"	exit 0",
				"fi",
				'echo "Cannot connect to the Docker daemon" >&2',
				"exit 1",
			].join("\n"),
		);
		expect(runReport(sandbox)).toBe("29.4.3 (already installed)");
	});

	it("reports the pinned version to be installed when docker is missing", () => {
		expect(runReport(makeSandbox())).toBe("28.5.0 (will be installed)");
	});
});

describe("defaultCommand", () => {
	it.each([false, true])(
		"prints the detected Docker version in the setup banner (isBuildServer=%s)",
		(isBuildServer) => {
			const script = defaultCommand(isBuildServer);
			expect(script).toContain(reportDockerVersion());
			expect(script).toContain(
				'echo "| Docker            | $DOCKER_VERSION_REPORT"',
			);
			expect(script).not.toContain(
				'echo "| Docker            | $DOCKER_VERSION"',
			);
		},
	);

	it.each([false, true])(
		"is valid shell syntax (isBuildServer=%s)",
		(value) => {
			expect(() =>
				execFileSync(resolveBin("bash"), ["-n"], {
					input: defaultCommand(value),
				}),
			).not.toThrow();
		},
	);

	it("contains the idempotent macOS Build Server setup", () => {
		const script = defaultCommand(true);
		expect(script).toContain("IS_BUILD_SERVER=true");
		expect(script).toContain(
			"brew install colima docker docker-compose docker-buildx",
		);
		expect(script).toContain("brew services start colima");
		expect(script).toContain("cliPluginsExtraDirs");
		expect(script).toContain(validateBuildServerDependencies());
	});

	it("keeps macOS unsupported for runtime/deploy servers", () => {
		const script = defaultCommand(false);
		expect(script).toContain("IS_BUILD_SERVER=false");
		expect(script).toContain(
			"macOS is supported only for Build Servers. Runtime/deploy servers must use Linux.",
		);
	});
});

describe("macOS platform detection", () => {
	it("detects an Apple Silicon Build Server", () => {
		const output = execFileSync(
			resolveBin("bash"),
			[
				"-c",
				`${detectOperatingSystem(true)}\nprintf '%s|%s|%s' "$OS_TYPE" "$OS_VERSION" "$SYS_ARCH"`,
			],
			{
				encoding: "utf8",
				env: { ...process.env, PATH: makeDarwinSandbox() },
			},
		);
		expect(output).toBe("macos|14.7.2|arm64");
	});

	it("rejects macOS for runtime/deploy servers", () => {
		expect(() =>
			execFileSync(resolveBin("bash"), ["-c", detectOperatingSystem(false)], {
				env: { ...process.env, PATH: makeDarwinSandbox() },
				stdio: "pipe",
			}),
		).toThrow();
	});

	it("rejects macOS versions older than 13", () => {
		expect(() =>
			execFileSync(resolveBin("bash"), ["-c", detectOperatingSystem(true)], {
				env: { ...process.env, PATH: makeDarwinSandbox("12.7.6") },
				stdio: "pipe",
			}),
		).toThrow();
	});

	it("marks macOS validation as supported only for Build Servers", () => {
		const buildOutput = execFileSync(
			resolveBin("bash"),
			[
				"-c",
				`${validateOperatingSystem(true)}\nprintf '%s|%s|%s|%s' "$operatingSystemType" "$operatingSystemVersion" "$operatingSystemArchitecture" "$operatingSystemSupported"`,
			],
			{
				encoding: "utf8",
				env: { ...process.env, PATH: makeDarwinSandbox() },
			},
		);
		expect(buildOutput).toBe("macos|14.7.2|arm64|true");
	});

	it("produces the complete macOS validation response", () => {
		const sandbox = makeDarwinSandbox();
		addShim(
			sandbox,
			"docker",
			[
				"#!/bin/sh",
				'case "$*" in',
				'  "--version") echo "Docker version 29.6.2, build abc"; exit 0 ;;',
				'  "info") exit 0 ;;',
				'  "info --format "*) echo inactive; exit 0 ;;',
				'  "compose version") exit 0 ;;',
				'  "buildx version") exit 0 ;;',
				'  "network ls") exit 1 ;;',
				"esac",
				"exit 1",
			].join("\n"),
		);
		addShim(sandbox, "nixpacks", "#!/bin/sh\necho 'nixpacks 1.41.0'\n");
		addShim(sandbox, "pack", "#!/bin/sh\necho '0.39.1'\n");
		addShim(sandbox, "railpack", "#!/bin/sh\necho 'railpack version 0.15.4'\n");
		addShim(sandbox, "sudo", "#!/bin/sh\nexit 0\n");
		addShim(sandbox, "colima", "#!/bin/sh\nexit 0\n");

		const output = execFileSync(
			resolveBin("bash"),
			["-c", serverValidationCommand(true)],
			{
				encoding: "utf8",
				env: { ...process.env, PATH: `${sandbox}:${process.env.PATH}` },
			},
		);
		const result = JSON.parse(output);
		expect(result.operatingSystem).toEqual({
			type: "macos",
			version: "14.7.2",
			architecture: "arm64",
			supported: true,
		});
		expect(result.docker).toMatchObject({
			version: "29.6.2",
			enabled: true,
			installed: true,
			engineEnabled: true,
			composeEnabled: true,
			buildxEnabled: true,
			runtime: "colima",
		});
		expect(result.nixpacks).toEqual({ version: "1.41.0", enabled: true });
		expect(result.buildpacks).toEqual({ version: "0.39.1", enabled: true });
		expect(result.railpack).toEqual({ version: "0.15.4", enabled: true });
		expect(result.dockerGroupMember).toBe(true);
	});
});

describe("macOS Docker runtime", () => {
	it("configures Colima, Compose, Buildx and autostart", () => {
		const script = installMacDocker();
		expect(script).toContain(
			"brew install colima docker docker-compose docker-buildx",
		);
		expect(script).toContain("brew services start colima");
		expect(script).toContain("docker compose version");
		expect(script).toContain("docker buildx version");
		expect(script).toContain("Docker config");
	});

	it("validates the Docker engine and both CLI plugins", () => {
		const sandbox = makeSandbox(
			[
				"#!/bin/sh",
				'case "$*" in',
				'  "--version") echo "Docker version 29.6.2, build abc"; exit 0 ;;',
				'  "info") exit 0 ;;',
				'  "compose version") exit 0 ;;',
				'  "buildx version") exit 0 ;;',
				"esac",
				"exit 1",
			].join("\n"),
		);
		const output = execFileSync(
			resolveBin("bash"),
			[
				"-c",
				`command_exists() { command -v "$@" >/dev/null 2>&1; }\n${validateDocker()}`,
			],
			{
				encoding: "utf8",
				env: { ...process.env, PATH: sandbox },
			},
		).trim();
		expect(output).toBe("29.6.2 true true true true");
	});
});

describe("remote command environment", () => {
	it("makes Homebrew binaries available to non-interactive SSH commands", () => {
		expect(remoteCommandEnvironment()).toContain("/opt/homebrew/bin");
		expect(withRemoteCommandEnvironment("docker info")).toBe(
			`${remoteCommandEnvironment()}\ndocker info`,
		);
	});
});
