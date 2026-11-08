/**
 * The shell Dokploy runs on a server for its OS updates, and the reading of
 * what it prints. Everything runs as root (sudo -n for another login).
 *
 * The steps of a run that change the system (finishing an interrupted dpkg,
 * refreshing the lists, installing) run in a transient systemd unit, apart
 * from the SSH session: a dropped connection or a Dokploy restart cannot
 * kill dpkg halfway. The unit writes its log and its result to files Dokploy
 * reads back, after a restart too.
 */
import { sh, shellQuote } from "../github-runners/runtime";
import {
	APT_ENVIRONMENT,
	APT_GET,
	APT_LISTS_TIME,
	APT_SIMULATE,
	aptUpdateRetries,
	BOOT_ID,
	CLEAN_FUNCTION,
	DEBIAN_PACKAGE,
	parseSimulation,
	rebootCommand,
	type SimulatedPackage,
} from "./apt";

export const STATE_DIR = "/var/lib/dokploy-os-updates";
/**
 * Held by every Dokploy OS update script on the server, one at a time. In
 * the root-only state directory: a lock other users could open, they could
 * hold for ever and block the updates.
 */
export const LOCK_FILE = `${STATE_DIR}/lock`;
/** How much of a step's log one read brings back. */
export const LOG_CHUNK_BYTES = 256 * 1024;

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
export type RunStep = "prepare" | "install";

/** Ids end up in paths and unit names: nanoid's alphabet only. */
export const assertRunId = (runId: string) => {
	if (!RUN_ID.test(runId)) throw new Error(`Invalid run id: ${runId}`);
	return runId;
};

export const stepUnit = (runId: string, step: RunStep) =>
	`dokploy-os-update-${assertRunId(runId)}-${step}`;

/** The command that runs a script (given on stdin) as root. */
export const rootShell = (username: string) =>
	username === "root" ? "bash -s" : "sudo -n bash -s";

/**
 * Takes the server's lock: a 0600 file in the 0700 state directory, created
 * in a subshell so that apt's maintainer scripts keep the usual umask.
 */
const lockServer = (
	waitSeconds: number,
	onBusy: string,
) => sh`(umask 077 && install -d -m 0700 ${STATE_DIR} && : >>${LOCK_FILE})
chmod 0700 ${STATE_DIR}
chmod 0600 ${LOCK_FILE}
exec 9>>${LOCK_FILE}
if ! flock -w ${waitSeconds} 9; then ${onBusy}; fi`;

/**
 * Prints "yes" when the system waits for a reboot: an update asked for it
 * (/var/run/reboot-required: Ubuntu, unattended-upgrades), or a newer kernel
 * is installed than the one running, which Debian's kernel packages never
 * report. A running kernel missing from /boot (a provider's own kernel)
 * tells nothing.
 */
export const REBOOT_PENDING_FUNCTION = sh`reboot_pending() {
	if [ -f /var/run/reboot-required ]; then echo yes; return; fi
	local running newest
	running=$(uname -r)
	newest=$(ls -1 /boot/vmlinuz-* 2>/dev/null | sed 's|^/boot/vmlinuz-||' | sort -V | tail -n 1)
	if [ -e "/boot/vmlinuz-$running" ] && [ -n "$newest" ] && [ "$newest" != "$running" ]; then echo yes; else echo no; fi
}`;

// ------------------------------------------------------------- assessment

/**
 * What the server is and what it waits for, as records on file descriptor 3
 * (the step's chatter goes to stdout): its OS, whether a reboot is pending,
 * Docker and Swarm, then apt's simulated upgrade. Only apt-based systems go
 * past the OS line. `recover` finishes an interrupted dpkg run first, and
 * `refresh` refreshes the package lists (a failure leaves the old ones).
 */
const assessmentBody = (options: {
	refresh: boolean;
	recover: boolean;
	updateAttempts: number;
}) => sh`${CLEAN_FUNCTION}
${REBOOT_PENDING_FUNCTION}
export LC_ALL=C
os_id=unknown os_like='' os_version='' os_codename='' pretty=''
if [ -r /etc/os-release ]; then
	os_id=$(. /etc/os-release && printf '%s' "\${ID:-unknown}")
	os_like=$(. /etc/os-release && printf '%s' "\${ID_LIKE:-}" | tr ' ' ,)
	os_version=$(. /etc/os-release && printf '%s' "\${VERSION_ID:-}")
	os_codename=$(. /etc/os-release && printf '%s' "\${VERSION_CODENAME:-}")
	pretty=$(. /etc/os-release && printf '%s' "\${PRETTY_NAME:-}")
fi
has_apt=no
if command -v apt-get >/dev/null 2>&1 && command -v dpkg >/dev/null 2>&1; then has_apt=yes; fi
echo "os id=$(clean "$os_id") like=$(clean "$os_like") version=$(clean "$os_version") codename=$(clean "$os_codename") kernel=$(clean "$(uname -r)") apt=$has_apt" >&3
echo "pretty $(printf '%s' "$pretty" | tr -cd '[:print:]' | head -c 120)" >&3
[ "$has_apt" = yes ] || exit 0
apt="${APT_GET}"
interrupted() { [ -n "$(ls -A /var/lib/dpkg/updates 2>/dev/null)" ] || [ -n "$(dpkg --audit 2>/dev/null)" ]; }
if ${options.recover ? "true" : "false"} && interrupted; then
	echo "==> Finishing an interrupted dpkg run (dpkg --configure -a)"
	# dpkg has no lock timeout: wait for the lock, give up on any other error.
	for attempt in $(seq 1 60); do
		if out=$(dpkg --force-confdef --force-confold --configure -a 2>&1); then
			printf '%s\n' "$out"
			break
		fi
		printf '%s\n' "$out"
		case "$out" in *lock*) ;; *) echo "error: dpkg --configure -a failed"; exit 1 ;; esac
		[ "$attempt" != 60 ] || { echo "error: dpkg stayed locked for 10 minutes"; exit 1; }
		sleep 10
	done
fi
refreshed=no
if ${options.refresh ? "true" : "false"}; then
	echo "==> Refreshing the package lists"
	if (
${aptUpdateRetries(options.updateAttempts)}
	); then refreshed=yes; else echo "warning: the package lists could not be refreshed"; fi
fi
dpkg_state=ok
if interrupted; then dpkg_state=interrupted; fi
echo "state lists=$(clean "$(${APT_LISTS_TIME} 2>/dev/null || true)") refreshed=$refreshed reboot=$(reboot_pending) dpkg=$dpkg_state boot=$(clean "${BOOT_ID}")" >&3
if [ -r /var/run/reboot-required.pkgs ]; then
	echo "reboot-packages $(sort -u /var/run/reboot-required.pkgs | tr -cd 'a-z0-9+.:\n-' | tr '\n' ' ')" >&3
fi
if command -v docker >/dev/null 2>&1; then
	echo "docker active=$(clean "$(systemctl is-active docker 2>/dev/null || true)") pid=$(clean "$(systemctl show -p MainPID --value docker 2>/dev/null || true)")" >&3
	echo "swarm $(docker info --format '{{json .Swarm}}' 2>/dev/null | tr -cd '[:print:]' | head -c 4000)" >&3
fi
echo "--- simulation" >&3
${APT_SIMULATE} --with-new-pkgs upgrade >&3 2>&1
echo "--- simulation status=$?" >&3
`;

/**
 * Assessment over SSH, without changing anything but the package lists:
 * records on stdout, apt's chatter dropped. "busy" when another Dokploy OS
 * update script holds the server.
 */
export const assessScript = (options: { refresh: boolean }) => sh`set -u
exec 3>&1 >/dev/null 2>&1
${APT_ENVIRONMENT}
${lockServer(30, 'echo "busy" >&3; exit 0')}
${assessmentBody({ refresh: options.refresh, recover: false, updateAttempts: 12 })}`;

// ------------------------------------------------------------- run steps

/**
 * The frame of a step: chatter to its log, records to its result, which only
 * appears (complete) once the step ended, with the exit code last.
 */
const stepFrame = (runId: string, step: RunStep, body: string) => {
	const dir = `${STATE_DIR}/${assertRunId(runId)}`;
	return sh`#!/bin/bash
set -uo pipefail
dir=${dir}
exec 3>"$dir/${step}.part"
exec >>"$dir/${step}.log" 2>&1
finish() {
	code=$?
	echo "exit code=$code" >&3
	exec 3>&-
	mv "$dir/${step}.part" "$dir/${step}.result"
}
trap finish EXIT
${APT_ENVIRONMENT}
${lockServer(600, 'echo "error: another Dokploy OS update held the server for 10 minutes"; exit 1')}
${body}`;
};

/** Finishes an interrupted dpkg, refreshes the lists, then assesses. */
export const prepareStep = (runId: string) =>
	stepFrame(
		runId,
		"prepare",
		assessmentBody({ refresh: true, recover: true, updateAttempts: 30 }),
	);

/**
 * Installs the pending updates named in `allowed`, and nothing else: every
 * other pending update is pinned at its installed version (and a package
 * not allowed is never installed anew) through a preferences file of this
 * run only. `apt-get upgrade` then keeps back an allowed update that needs
 * one of them, and never removes a package. Nothing starts once `deadline`
 * (seconds since the epoch) has passed.
 */
export const installStep = (input: {
	runId: string;
	allowed: string[];
	deadline: number;
}) => {
	const names = [
		...new Set(input.allowed.map((name) => name.split(":")[0] ?? name)),
	];
	for (const name of names) {
		if (!name || !DEBIAN_PACKAGE.test(name)) {
			throw new Error(`Invalid package name: ${name}`);
		}
	}
	if (!Number.isInteger(input.deadline)) throw new Error("Invalid deadline");
	return stepFrame(
		input.runId,
		"install",
		sh`set -e
export LC_ALL=C
${REBOOT_PENDING_FUNCTION}
apt="${APT_GET}"
if [ "$(date +%s)" -ge ${input.deadline} ]; then
	echo "==> The maintenance window closed: nothing installed"
	echo "result status=window-closed" >&3
	exit 0
fi
declare -A allow=()
for name in ${names.map(shellQuote).join(" ")}; do allow[$name]=1; done
prefs="$dir/preferences"
if [ -r /etc/apt/preferences ]; then cat /etc/apt/preferences >"$prefs"; else : >"$prefs"; fi
# Fails closed: without the simulation, nothing would be pinned.
simulated=$(${APT_SIMULATE} --with-new-pkgs upgrade) || { echo "error: apt could not simulate the upgrade"; exit 1; }
# Updates only in the counts: a new package (no installed version) comes
# with the update that needs it, or not at all.
held=0
refused=0
allowed_updates=0
while read -r kind name rest; do
	[ "$kind" = Inst ] || continue
	base=\${name%%:*}
	[[ "$base" =~ ^[a-z0-9][a-z0-9+.-]*$ ]] || { echo "error: unexpected package name $base"; exit 1; }
	if [ -n "\${allow[$base]:-}" ]; then
		if [[ "$rest" == "["* ]]; then allowed_updates=$((allowed_updates + 1)); fi
		continue
	fi
	if [[ "$rest" =~ ^\[([A-Za-z0-9.+~:-]+)\] ]]; then
		printf 'Package: %s\nPin: version %s\nPin-Priority: 1001\n\n' "$base" "\${BASH_REMATCH[1]}" >>"$prefs"
		held=$((held + 1))
	else
		printf 'Package: %s\nPin: version *\nPin-Priority: -1\n\n' "$base" >>"$prefs"
		refused=$((refused + 1))
	fi
done <<<"$simulated"
installed() { dpkg-query -W -f='\${binary:Package} \${Version} \${db:Status-Abbrev}\n' | awk '$3 ~ /^.i/ { print $1, $2 }' | sort; }
installed >"$dir/before"
docker_before=$(systemctl show -p MainPID --value docker 2>/dev/null || true)
echo "==> Installing the selected updates ($allowed_updates allowed, $held other pending update(s) held at their version$([ "$refused" = 0 ] || echo ", $refused new package(s) not allowed"))"
upgrade=0
$apt -o Dir::Etc::Preferences="$prefs" -y -q --with-new-pkgs upgrade || upgrade=$?
# What changed is recorded even when apt stopped halfway.
installed >"$dir/after"
join -a 1 -a 2 -e - -o 0,1.2,2.2 "$dir/before" "$dir/after" | awk '$2 != $3 { print "changed name=" $1 " from=" $2 " to=" $3 }' >&3
[ "$upgrade" = 0 ] || { echo "error: apt-get upgrade failed (exit $upgrade)"; exit "$upgrade"; }
docker_after=$(systemctl show -p MainPID --value docker 2>/dev/null || true)
echo "result status=installed reboot=$(reboot_pending) docker-before=$docker_before docker-after=$docker_after" >&3
`,
	);
};

/**
 * Writes a step's script and starts it in a transient unit. A step started
 * again once it ended (a run resumed) starts from scratch; one still running
 * is left as it is.
 */
export const startStepScript = (
	runId: string,
	step: RunStep,
	script: string,
) => {
	if (script.includes("\nDOKPLOY_EOF\n")) {
		throw new Error("The step script contains the heredoc delimiter");
	}
	const dir = `${STATE_DIR}/${assertRunId(runId)}`;
	const unit = stepUnit(runId, step);
	return sh`set -euo pipefail
${APT_ENVIRONMENT}
command -v systemd-run >/dev/null 2>&1 || { echo "error: Dokploy OS updates need systemd" >&2; exit 1; }
# Asked again after a lost answer: the step already runs, leave it be.
if systemctl is-active --quiet ${unit}; then echo "started"; exit 0; fi
install -d -m 0700 ${STATE_DIR} ${dir}
# The files of runs older than 30 days go.
find ${STATE_DIR} -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} + 2>/dev/null || true
rm -f ${dir}/${step}.result ${dir}/${step}.part ${dir}/${step}.log
cat >${dir}/${step}.sh <<'DOKPLOY_EOF'
${script.endsWith("\n") ? script : `${script}\n`}DOKPLOY_EOF
systemctl reset-failed ${unit} >/dev/null 2>&1 || true
systemd-run --unit=${unit} --description="Dokploy OS updates (${step})" --collect --quiet /bin/bash ${dir}/${step}.sh
echo "started"
`;
};

/**
 * Where a step stands: whether its unit still runs, its result once it
 * ended, and its log from `offset` (bytes).
 */
export const followStepScript = (
	runId: string,
	step: RunStep,
	offset: number,
) => {
	const dir = `${STATE_DIR}/${assertRunId(runId)}`;
	const from = Math.max(0, Math.floor(offset)) + 1;
	// The result before the size: once the result exists, the log is whole.
	return sh`set -u
${CLEAN_FUNCTION}
done=$([ -f ${dir}/${step}.result ] && echo yes || echo no)
unit=$(systemctl is-active ${stepUnit(runId, step)} 2>/dev/null || true)
size=$(stat -c %s ${dir}/${step}.log 2>/dev/null || echo 0)
echo "follow size=$(clean "$size") unit=$(clean "$unit") done=$done"
if [ "$done" = yes ]; then cat ${dir}/${step}.result; fi
echo "--- log"
tail -c +${from} ${dir}/${step}.log 2>/dev/null | head -c ${LOG_CHUNK_BYTES} || true
`;
};

/** Removes the files of a run once Dokploy read them. */
export const cleanupRunScript = (runId: string) =>
	`rm -rf ${STATE_DIR}/${assertRunId(runId)}`;

// ------------------------------------------------------------- reboot

export const rebootScript = (runId: string) =>
	rebootCommand(`dokploy-os-update-reboot-${assertRunId(runId)}`);

export const BOOT_ID_COMMAND = "cat /proc/sys/kernel/random/boot_id";

/** The managers of the Swarm this server manages, one JSON per line. */
export const SWARM_MANAGERS_COMMAND =
	"docker node ls --filter role=manager --format '{{json .}}'";

/** Docker after a boot: whether it runs, and its Swarm state. */
export const dockerStatusScript = () => sh`${CLEAN_FUNCTION}
echo "docker active=$(clean "$(systemctl is-active docker 2>/dev/null || true)")"
if command -v docker >/dev/null 2>&1; then
	echo "swarm $(docker info --format '{{json .Swarm}}' 2>/dev/null | tr -cd '[:print:]' | head -c 4000)"
fi
`;

export const RESTART_DOCKER_COMMAND = "systemctl restart docker";

// ------------------------------------------------------------- parsing

/** `kind key=value key=value` lines, as the scripts print them. */
const recordsOf = (lines: string[]) =>
	lines.flatMap((line) => {
		const [kind, ...rest] = line.trim().split(/\s+/);
		if (!kind) return [];
		const fields: Record<string, string> = {};
		for (const pair of rest) {
			const index = pair.indexOf("=");
			if (index > 0) fields[pair.slice(0, index)] = pair.slice(index + 1);
		}
		return [{ kind, fields, line }];
	});

export interface SwarmInfo {
	state: string;
	nodeId: string | null;
	/** Only a manager knows its cluster's id. */
	clusterId: string | null;
	manager: boolean;
	managers: number | null;
	nodes: number | null;
}

export const parseSwarm = (json: string): SwarmInfo | null => {
	try {
		const data = JSON.parse(json) as {
			LocalNodeState?: string;
			NodeID?: string;
			ControlAvailable?: boolean;
			Managers?: number;
			Nodes?: number;
			Cluster?: { ID?: string } | null;
		};
		if (!data || typeof data !== "object") return null;
		return {
			state: data.LocalNodeState || "inactive",
			nodeId: data.NodeID || null,
			clusterId: data.Cluster?.ID || null,
			manager: data.ControlAvailable === true,
			managers: typeof data.Managers === "number" ? data.Managers : null,
			nodes: typeof data.Nodes === "number" ? data.Nodes : null,
		};
	} catch {
		return null;
	}
};

export interface ServerAssessment {
	os: {
		id: string;
		like: string[];
		version: string;
		codename: string;
		kernel: string;
		pretty: string;
	};
	/** apt-based Debian or Ubuntu: the only systems Dokploy updates. */
	supported: boolean;
	listsAt: string | null;
	listsRefreshed: boolean;
	rebootRequired: boolean;
	rebootPackages: string[];
	dpkgInterrupted: boolean;
	bootId: string | null;
	docker: { active: boolean; pid: string | null } | null;
	swarm: SwarmInfo | null;
	packages: SimulatedPackage[];
	keptBack: string[];
	/** apt could not simulate the upgrade: its message. */
	simulationError: string | null;
}

const SUPPORTED_IDS = ["debian", "ubuntu"];

export const isSupportedOs = (os: { id: string; like: string[] }) =>
	[os.id, ...os.like].some((id) => SUPPORTED_IDS.includes(id));

export const unsupportedMessage = (os: ServerAssessment["os"] | null) =>
	`Dokploy installs OS updates on apt-based Debian and Ubuntu servers only${os ? `: this one runs ${os.pretty || os.id}` : ""}.`;

/** Reads the records of the assessment (or the prepare step). */
export const parseAssessment = (output: string): ServerAssessment | null => {
	const [head = "", rest = ""] = output.split(/^--- simulation$/m);
	const [simulation = "", tail = ""] = rest.split(/^--- simulation status=/m);
	const records = recordsOf(head.split("\n"));
	const field = (kind: string) =>
		records.find((record) => record.kind === kind)?.fields;
	const os = field("os");
	if (!os?.id) return null;
	const like = (os.like ?? "").split(",").filter(Boolean);
	const prettyLine = records.find((record) => record.kind === "pretty");
	const info = {
		id: os.id.toLowerCase(),
		like: like.map((item) => item.toLowerCase()),
		version: os.version ?? "",
		codename: os.codename ?? "",
		kernel: os.kernel ?? "",
		pretty: prettyLine
			? prettyLine.line.trim().slice("pretty".length).trim()
			: "",
	};
	const state = field("state");
	const docker = field("docker");
	const swarmLine = records.find((record) => record.kind === "swarm");
	const lists = state?.lists && /^\d+$/.test(state.lists) ? state.lists : null;
	const parsed = parseSimulation(simulation);
	const status = tail.trim().split(/\s/)[0] ?? "";
	return {
		os: info,
		supported: os.apt === "yes" && isSupportedOs(info),
		listsAt: lists ? new Date(Number(lists) * 1000).toISOString() : null,
		listsRefreshed: state?.refreshed === "yes",
		rebootRequired: state?.reboot === "yes",
		rebootPackages:
			records
				.find((record) => record.kind === "reboot-packages")
				?.line.trim()
				.split(/\s+/)
				.slice(1)
				.filter((name) => DEBIAN_PACKAGE.test(name)) ?? [],
		dpkgInterrupted: state?.dpkg === "interrupted",
		bootId: state?.boot || null,
		docker: docker
			? { active: docker.active === "active", pid: docker.pid || null }
			: null,
		swarm: swarmLine
			? parseSwarm(swarmLine.line.trim().slice("swarm".length).trim())
			: null,
		packages: parsed.packages,
		keptBack: parsed.keptBack,
		simulationError:
			os.apt === "yes" && state && status !== "0"
				? simulation
						.split("\n")
						.filter((line) => /^(E|W):/.test(line))
						.slice(-3)
						.join(" ") || "apt could not simulate the upgrade"
				: null,
	};
};

export interface StepProgress {
	/** Bytes of log the server holds. */
	size: number;
	unitActive: boolean;
	done: boolean;
	/** The step's records, once it ended. */
	result: string;
	log: string;
}

export const parseFollow = (output: string): StepProgress | null => {
	const marker = output.indexOf("\n--- log\n");
	const head = marker === -1 ? output : output.slice(0, marker);
	const log = marker === -1 ? "" : output.slice(marker + "\n--- log\n".length);
	const lines = head.split("\n");
	const follow = recordsOf(lines.slice(0, 1))[0];
	if (follow?.kind !== "follow") return null;
	const size = Number(follow.fields.size);
	return {
		size: Number.isFinite(size) ? size : 0,
		unitActive: ["active", "activating", "reloading"].includes(
			follow.fields.unit ?? "",
		),
		done: follow.fields.done === "yes",
		result: lines.slice(1).join("\n"),
		log,
	};
};

export interface PackageChange {
	name: string;
	/** "-" in the script for a package installed anew: null here. */
	from: string | null;
	to: string | null;
}

export interface InstallResult {
	status: "installed" | "window-closed";
	rebootRequired: boolean;
	dockerRestarted: boolean | null;
	changes: PackageChange[];
	exitCode: number | null;
}

/** Reads the result of the install step; null when it did not finish. */
export const parseInstallResult = (output: string): InstallResult | null => {
	const records = recordsOf(output.split("\n"));
	const exit = records.find((record) => record.kind === "exit");
	const result = records.find((record) => record.kind === "result");
	if (!exit) return null;
	const code = Number(exit.fields.code);
	const before = result?.fields["docker-before"] ?? "";
	const after = result?.fields["docker-after"] ?? "";
	return {
		status:
			result?.fields.status === "window-closed" ? "window-closed" : "installed",
		rebootRequired: result?.fields.reboot === "yes",
		// The daemon's PID changed: a package restarted it (docker-ce does,
		// Ubuntu's docker.io does not).
		dockerRestarted:
			before && after && before !== "0" && after !== "0"
				? before !== after
				: null,
		changes: records
			.filter((record) => record.kind === "changed")
			.flatMap(({ fields }) =>
				fields.name && DEBIAN_PACKAGE.test(fields.name)
					? [
							{
								name: fields.name,
								from: fields.from && fields.from !== "-" ? fields.from : null,
								to: fields.to && fields.to !== "-" ? fields.to : null,
							},
						]
					: [],
			),
		exitCode: Number.isFinite(code) ? code : null,
	};
};

/** The exit code a step's result ends with; null when it did not end. */
export const stepExitCode = (result: string) => {
	const exit = recordsOf(result.split("\n")).find(
		(record) => record.kind === "exit",
	);
	if (!exit) return null;
	const code = Number(exit.fields.code);
	return Number.isFinite(code) ? code : null;
};

export interface SwarmManager {
	self: boolean;
	hostname: string;
	status: string;
	managerStatus: string;
}

export const parseSwarmManagers = (output: string): SwarmManager[] =>
	output.split("\n").flatMap((line) => {
		try {
			const data = JSON.parse(line) as {
				Self?: boolean;
				Hostname?: string;
				Status?: string;
				ManagerStatus?: string;
			};
			return [
				{
					self: data.Self === true,
					hostname: data.Hostname ?? "",
					status: data.Status ?? "",
					managerStatus: data.ManagerStatus ?? "",
				},
			];
		} catch {
			return [];
		}
	});

/**
 * Whether a manager may reboot without losing the quorum of its Swarm: the
 * managers left reachable while it boots must stay a strict majority of all
 * the managers (2 of 3, 3 of 5; never 1 of 2). A lone manager may reboot
 * (its cluster is down while it boots, as any single server).
 */
export const swarmRebootCheck = (managers: SwarmManager[]) => {
	if (!managers.some((manager) => manager.self)) {
		return {
			safe: false,
			reason: "this server is not listed among the Swarm managers",
		};
	}
	if (managers.length === 1) return { safe: true, reason: null };
	const others = managers.filter((manager) => !manager.self);
	const down = others.filter(
		(manager) =>
			!["Leader", "Reachable"].includes(manager.managerStatus) ||
			manager.status !== "Ready",
	);
	const left = others.length - down.length;
	if (left * 2 > managers.length) return { safe: true, reason: null };
	const missing = down.length
		? `, as ${down.map((manager) => manager.hostname).join(", ")} ${down.length === 1 ? "is" : "are"} not reachable`
		: "";
	return {
		safe: false,
		reason: `rebooting it would leave ${left} of ${managers.length} Swarm managers${missing}: the Swarm would lose its quorum`,
	};
};
