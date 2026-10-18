/**
 * The Linux runtime Dokploy installs on every runner machine: on the host for
 * Linux machines, inside the Lima VM for Macs. Bump RUNTIME_VERSION whenever a
 * file below changes; the controller reinstalls the runtime when the machine
 * reports an older version.
 */
export const RUNTIME_VERSION = 3;

const RUNTIME_ROOT = "/opt/dokploy-runners";
export const RUNNERCTL = `${RUNTIME_ROOT}/bin/runnerctl`;

/**
 * Shell source kept verbatim (backslashes included); `\${` stands for a literal
 * `${` so that bash expansions are not taken for template placeholders.
 */
export const sh = (strings: TemplateStringsArray, ...values: unknown[]) =>
	String.raw(
		{ raw: strings.raw.map((part) => part.replace(/\\\$\{/g, "${")) },
		...values,
	);

const runnerctl = sh`#!/bin/bash
# Managed by Dokploy (GitHub runners): reinstalled with the runtime, do not edit.
set -euo pipefail
umask 022
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ROOT=/opt/dokploy-runners
STATE=/var/lib/dokploy-runners
ETC=/etc/dokploy-runners
RUNNER_USER=dokploy-runner
SLICE=dokploy-runners.slice

die() { echo "runnerctl: $*" >&2; exit 1; }

slot_arg() {
	[[ "\${1:-}" =~ ^[0-9]{1,2}$ ]] || die "invalid slot: \${1:-}"
	local slot=$((10#$1))
	((slot >= 1 && slot <= 32)) || die "invalid slot: $slot"
	echo "$slot"
}

unit_of() { echo "dokploy-runner@$1.service"; }

kib_free() { df -Pk "$ROOT" | awk 'NR==2 {print $4}'; }

cmd_status() {
	echo "runtime version=$(cat "$ETC/runtime-version" 2>/dev/null || echo 0)"
	echo "host cpus=$(nproc --all) memory_kib=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo) available_kib=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo) arch=$(uname -m) load=$(cut -d' ' -f1 /proc/loadavg)"
	df -Pk "$ROOT" | awk 'NR==2 {print "disk total_kib=" $2 " free_kib=" $4}'
	local release=""
	if [ -L "$ROOT/releases/current" ]; then release=$(basename "$(readlink -f "$ROOT/releases/current")"); fi
	echo "release current=$release"
	awk '/^cpu / {busy=$2+$3+$4+$7+$8+$9; print "cpu busy=" busy " total=" busy+$5+$6}' /proc/stat
	# A dash in a unit name nests it: the slice lives in dokploy.slice.
	local cg="" group
	group=$(systemctl show -p ControlGroup --value "$SLICE" 2>/dev/null || true)
	[ -n "$group" ] && cg="/sys/fs/cgroup$group"
	if [ -n "$cg" ] && [ -r "$cg/cpu.stat" ]; then
		echo "slice usage_usec=$(awk '$1=="usage_usec" {print $2}' "$cg/cpu.stat") memory_current=$(cat "$cg/memory.current" 2>/dev/null || true) memory_max=$(cat "$cg/memory.max" 2>/dev/null || true)"
	else
		echo "slice usage_usec= memory_current= memory_max="
	fi
	echo "docker state=$(systemctl is-active docker 2>/dev/null || true)"
	local uptime now
	uptime=$(cut -d' ' -f1 /proc/uptime)
	now=$(date +%s)
	systemctl list-units --all --plain --no-legend --no-pager 'dokploy-runner@*.service' 2>/dev/null |
		while read -r unit _load active _sub _rest; do
			local slot=\${unit#dokploy-runner@}
			slot=\${slot%.service}
			[[ "$slot" =~ ^[0-9]+$ ]] || continue
			local mono since name
			mono=$(systemctl show -p ActiveEnterTimestampMonotonic --value "$unit" 2>/dev/null || echo 0)
			since=$(awk -v now="$now" -v up="$uptime" -v mono="\${mono:-0}" 'BEGIN { if (mono > 0) printf "%d", now - (up - mono / 1000000) }')
			name=$(cat "$ROOT/slots/$slot/.dokploy-runner-name" 2>/dev/null || true)
			echo "slot id=$slot active=$active since=$since name=$name"
		done
	# Job files outlive their runner until the slot is armed again, so a job that
	# ended between two probes is still reported with its completion time.
	local file id
	for file in "$STATE"/jobs/*; do
		[ -f "$file" ] || continue
		id=\${file##*/}
		[[ "$id" =~ ^[0-9]+$ ]] || continue
		echo "jobfile id=$id name=$(cat "$ROOT/slots/$id/.dokploy-runner-name" 2>/dev/null || true) job=$(base64 -w0 <"$file")"
	done
}

cmd_caches() {
	if command -v docker >/dev/null 2>&1 && systemctl is-active --quiet docker; then
		timeout 60 docker system df --format '{{.Type}}|{{.Size}}|{{.Reclaimable}}' 2>/dev/null |
			while IFS='|' read -r type size reclaimable; do
				echo "docker type=\${type// /_} size=$size reclaimable=\${reclaimable%% *}"
			done || true
	fi
	echo "dir name=tool_cache kib=$(timeout 60 du -sk "$ROOT/tool-cache" 2>/dev/null | cut -f1 || true)"
	echo "dir name=home kib=$(timeout 60 du -sk "$STATE/home" 2>/dev/null | cut -f1 || true)"
	echo "dir name=workspaces kib=$( (timeout 60 du -sk "$ROOT"/slots/*/_work 2>/dev/null || true) | awk '{s += $1} END {print s + 0}')"
}

cmd_arm() {
	local slot min_free_kib unit state free release dir key value
	slot=$(slot_arg "\${1:-}")
	min_free_kib=\${2:-0}
	[[ "$min_free_kib" =~ ^[0-9]+$ ]] || die "invalid disk reserve"
	unit=$(unit_of "$slot")
	state=$(systemctl show -p ActiveState --value "$unit" 2>/dev/null || echo inactive)
	case "$state" in
	active | activating | deactivating | reloading) die "slot $slot is $state" ;;
	esac
	free=$(kib_free)
	if ((free < min_free_kib)); then
		echo "admission refused free_kib=$free"
		exit 3
	fi
	[ -L "$ROOT/releases/current" ] || die "no runner release installed"
	release=$(readlink -f "$ROOT/releases/current")
	[ -x "$release/run.sh" ] || die "runner release $release is incomplete"
	dir="$ROOT/slots/$slot"
	# Each slot runs its own copy, refreshed only when the release changes.
	if [ "$(cat "$dir/.dokploy-release" 2>/dev/null || true)" != "$release" ]; then
		rm -rf "$dir" "$dir.new"
		cp -a "$release" "$dir.new"
		echo "$release" >"$dir.new/.dokploy-release"
		chown -R "$RUNNER_USER:$RUNNER_USER" "$dir.new"
		mv "$dir.new" "$dir"
	fi
	# Ephemeral: nothing of the previous job survives in the slot. Shared caches
	# (tool cache, home, Docker images and build cache) are kept for speed.
	rm -rf "$dir/_work" "$dir/_diag" "$dir/.runner" "$dir/.credentials" \
		"$dir/.credentials_rsaparams" "$dir/.dokploy-runner-name" "$STATE/jobs/$slot"
	install -d -o "$RUNNER_USER" -g "$RUNNER_USER" -m 0700 "$dir/_work"
	while IFS=' ' read -r key value || [ -n "\${key:-}" ]; do
		case "$key" in
		.runner | .credentials | .credentials_rsaparams)
			[[ "$value" =~ ^[A-Za-z0-9+/=]+$ ]] || die "invalid $key"
			install -o "$RUNNER_USER" -g "$RUNNER_USER" -m 0600 /dev/null "$dir/$key"
			printf '%s' "$value" | base64 -d >"$dir/$key"
			;;
		name)
			[[ "$value" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid runner name"
			printf '%s\n' "$value" >"$dir/.dokploy-runner-name"
			;;
		'') ;;
		*) die "unexpected input: $key" ;;
		esac
		key=""
	done
	[ -s "$dir/.runner" ] && [ -s "$dir/.credentials" ] || die "incomplete JIT configuration"
	systemctl reset-failed "$unit" >/dev/null 2>&1 || true
	systemctl start --no-block "$unit"
	echo "armed slot=$slot"
}

cmd_stop() {
	local slot
	slot=$(slot_arg "\${1:-}")
	systemctl stop "$(unit_of "$slot")" >/dev/null 2>&1 || true
	systemctl reset-failed "$(unit_of "$slot")" >/dev/null 2>&1 || true
	echo "stopped slot=$slot"
}

cmd_stop_all() {
	systemctl stop 'dokploy-runner@*.service' >/dev/null 2>&1 || true
	systemctl reset-failed 'dokploy-runner@*.service' >/dev/null 2>&1 || true
	echo "stopped all"
}

cmd_limits() {
	local quota=\${1:-} cpus=\${2:-} memory=\${3:-}
	local args=()
	if [ "$quota" = none ]; then args+=("CPUQuota="); else
		[[ "$quota" =~ ^[0-9]+$ ]] || die "invalid CPU quota"
		args+=("CPUQuota=\${quota}%")
	fi
	if [ "$cpus" = none ]; then args+=("AllowedCPUs="); else
		[[ "$cpus" =~ ^[0-9]+(-[0-9]+)?$ ]] || die "invalid CPU list"
		args+=("AllowedCPUs=$cpus")
	fi
	if [ "$memory" = none ]; then args+=("MemoryMax=infinity"); else
		[[ "$memory" =~ ^[0-9]+$ ]] || die "invalid memory limit"
		args+=("MemoryMax=$memory")
	fi
	systemctl start "$SLICE"
	systemctl set-property "$SLICE" "\${args[@]}"
	echo "limits applied \${args[*]}"
}

cmd_env() {
	local tmp
	tmp=$(mktemp "$ETC/runner.env.XXXXXX")
	cat >"$tmp"
	chown "root:$RUNNER_USER" "$tmp"
	chmod 0640 "$tmp"
	mv -f "$tmp" "$ETC/runner.env"
	echo "environment written"
}

cmd_install_release() {
	local version=\${1:-} url=\${2:-} sha=\${3:-} target tmp
	[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid version"
	[[ "$url" =~ ^https://[A-Za-z0-9./_-]+$ ]] || die "invalid URL"
	[[ "$sha" =~ ^[a-f0-9]{64}$ ]] || die "invalid SHA-256"
	target="$ROOT/releases/$version"
	if [ ! -x "$target/run.sh" ]; then
		tmp=$(mktemp -d "$ROOT/releases/.download.XXXXXX")
		trap 'rm -rf "$tmp"' EXIT
		curl -fsSL --retry 3 --connect-timeout 20 -o "$tmp/runner.tar.gz" "$url"
		echo "$sha  $tmp/runner.tar.gz" | sha256sum -c --quiet - || die "checksum mismatch for actions/runner $version"
		mkdir "$tmp/runner"
		tar -xzf "$tmp/runner.tar.gz" -C "$tmp/runner"
		if [ -x "$tmp/runner/bin/installdependencies.sh" ]; then
			"$tmp/runner/bin/installdependencies.sh" >/dev/null 2>&1 ||
				echo "warning: the runner dependency installer failed" >&2
		fi
		chown -R root:root "$tmp/runner"
		rm -rf "$target"
		mv "$tmp/runner" "$target"
		rm -rf "$tmp"
		trap - EXIT
	fi
	ln -sfn "$target" "$ROOT/releases/current.new"
	mv -T "$ROOT/releases/current.new" "$ROOT/releases/current"
	# Keep the current release and the previous one.
	find "$ROOT/releases" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*' -printf '%T@ %p\n' |
		sort -rn | tail -n +3 | cut -d' ' -f2- | while read -r old; do
			[ "$old" != "$target" ] && rm -rf "$old"
		done
	echo "release installed=$version"
}

cmd_prune() {
	local mode=\${1:-normal}
	if command -v docker >/dev/null 2>&1 && systemctl is-active --quiet docker; then
		docker container prune -f --filter until=30m >/dev/null 2>&1 || true
		docker network prune -f --filter until=30m >/dev/null 2>&1 || true
		docker volume prune -f >/dev/null 2>&1 || true
		if [ "$mode" = aggressive ]; then
			docker image prune -af --filter until=24h >/dev/null 2>&1 || true
			docker builder prune -af --filter until=24h >/dev/null 2>&1 || true
		else
			# Images and recent build cache make the next jobs fast: keep them.
			docker image prune -f >/dev/null 2>&1 || true
			docker builder prune -f --filter until=168h >/dev/null 2>&1 || true
		fi
	fi
	fstrim -a >/dev/null 2>&1 || true
	echo "pruned mode=$mode free_kib=$(kib_free)"
}

cmd_uninstall() {
	cmd_stop_all >/dev/null
	systemctl stop "$SLICE" >/dev/null 2>&1 || true
	rm -f /etc/systemd/system/dokploy-runner@.service "/etc/systemd/system/$SLICE"
	rm -rf "/etc/systemd/system.control/$SLICE.d" "/etc/systemd/system/$SLICE.d"
	if [ -f /etc/docker/daemon.json ] && command -v jq >/dev/null 2>&1 &&
		jq -e '."cgroup-parent" == "dokploy-runners.slice"' /etc/docker/daemon.json >/dev/null 2>&1; then
		jq 'del(."cgroup-parent")' /etc/docker/daemon.json >/etc/docker/daemon.json.dokploy
		mv -f /etc/docker/daemon.json.dokploy /etc/docker/daemon.json
		systemctl restart docker || true
	fi
	systemctl daemon-reload
	userdel "$RUNNER_USER" >/dev/null 2>&1 || true
	rm -rf "$ROOT" "$STATE" "$ETC"
	echo "uninstalled"
}

case "\${1:-}" in
status) cmd_status ;;
caches) cmd_caches ;;
arm) cmd_arm "\${2:-}" "\${3:-0}" ;;
stop) cmd_stop "\${2:-}" ;;
stop-all) cmd_stop_all ;;
limits) cmd_limits "\${2:-}" "\${3:-}" "\${4:-}" ;;
env) cmd_env ;;
install-release) cmd_install_release "\${2:-}" "\${3:-}" "\${4:-}" ;;
prune) cmd_prune "\${2:-normal}" ;;
uninstall) cmd_uninstall ;;
*) die "usage: runnerctl status|caches|arm|stop|stop-all|limits|env|install-release|prune|uninstall" ;;
esac
`;

const recordJob = sh`	{
		printf 'repository=%s\n' "\${GITHUB_REPOSITORY:-}"
		printf 'run_id=%s\n' "\${GITHUB_RUN_ID:-}"
		printf 'run_attempt=%s\n' "\${GITHUB_RUN_ATTEMPT:-}"
		printf 'workflow=%s\n' "\${GITHUB_WORKFLOW:-}"
		printf 'job=%s\n' "\${GITHUB_JOB:-}"
		printf 'started=%s\n' "$(date +%s)"
	} >"$state.tmp" 2>/dev/null && mv -f "$state.tmp" "$state" 2>/dev/null || true`;

const recordCompletion = sh`	printf 'completed=%s\n' "$(date +%s)" >>"$state" 2>/dev/null || true`;

const jobHook = (phase: "started" | "completed") => sh`#!/bin/bash
# Managed by Dokploy: records the job of this runner slot, then runs the pool hook.
slot="\${DOKPLOY_RUNNER_SLOT:-}"
if [[ "$slot" =~ ^[0-9]+$ ]]; then
	state="/var/lib/dokploy-runners/jobs/$slot"
${phase === "started" ? recordJob : recordCompletion}
fi
hook="\${DOKPLOY_JOB_${phase.toUpperCase()}_HOOK:-}"
if [ -n "$hook" ]; then
	case "$hook" in
	*.sh) exec /bin/bash "$hook" "$@" ;;
	*) exec "$hook" "$@" ;;
	esac
fi
`;

const slice = `[Unit]
Description=Dokploy GitHub Actions runners
Before=slices.target

[Slice]
CPUAccounting=yes
MemoryAccounting=yes
TasksAccounting=yes
`;

const runnerUnit = `[Unit]
Description=Dokploy GitHub Actions runner (slot %i)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=dokploy-runner
Group=dokploy-runner
Slice=dokploy-runners.slice
WorkingDirectory=/opt/dokploy-runners/slots/%i
EnvironmentFile=-/etc/dokploy-runners/runner.env
Environment=HOME=/var/lib/dokploy-runners/home
Environment=DOKPLOY_RUNNER_SLOT=%i
# run.sh forwards SIGTERM to the listener as SIGINT: the job is cancelled and
# reported to GitHub instead of being cut off.
Environment=RUNNER_MANUALLY_TRAP_SIG=1
ExecStart=/opt/dokploy-runners/slots/%i/run.sh
KillMode=mixed
# run.sh exits with 143 after forwarding SIGTERM: a clean stop.
SuccessExitStatus=143
TimeoutStopSec=60
Restart=no
LimitNOFILE=1048576
`;

const files: { path: string; mode: string; content: string }[] = [
	{ path: RUNNERCTL, mode: "0755", content: runnerctl },
	{
		path: `${RUNTIME_ROOT}/bin/job-started.sh`,
		mode: "0755",
		content: jobHook("started"),
	},
	{
		path: `${RUNTIME_ROOT}/bin/job-completed.sh`,
		mode: "0755",
		content: jobHook("completed"),
	},
	{
		path: "/etc/systemd/system/dokploy-runners.slice",
		mode: "0644",
		content: slice,
	},
	{
		path: "/etc/systemd/system/dokploy-runner@.service",
		mode: "0644",
		content: runnerUnit,
	},
];

const heredoc = (content: string) => {
	if (content.includes("\nDOKPLOY_EOF\n")) {
		throw new Error("Runtime file contains the heredoc delimiter");
	}
	return `<<'DOKPLOY_EOF'\n${content.endsWith("\n") ? content : `${content}\n`}DOKPLOY_EOF`;
};

/**
 * Idempotent installation of the runtime, run as root with `bash -s`. Docker is
 * installed when missing and every container it starts is placed in the runner
 * slice, so jobs and their containers share one budget.
 */
export const installRuntimeScript = () => `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
log() { echo "==> $*"; }
fail() { echo "error: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail "the runtime must be installed as root"
[ -d /run/systemd/system ] || fail "systemd is required"
[ "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs ] || fail "cgroup v2 is required"

if command -v apt-get >/dev/null 2>&1; then
	log "Installing packages"
	apt-get -o DPkg::Lock::Timeout=300 update -qq
	apt-get -o DPkg::Lock::Timeout=300 install -y -qq ca-certificates curl tar jq git >/dev/null
	if ! command -v docker >/dev/null 2>&1; then
		log "Installing Docker"
		apt-get -o DPkg::Lock::Timeout=300 install -y -qq docker.io >/dev/null
		for optional in docker-buildx docker-compose-v2; do
			apt-get -o DPkg::Lock::Timeout=300 install -y -qq "$optional" >/dev/null 2>&1 || echo "warning: $optional is not available"
		done
	fi
else
	for tool in curl tar jq git; do
		command -v "$tool" >/dev/null 2>&1 || fail "$tool is missing and this system has no apt-get"
	done
	command -v docker >/dev/null 2>&1 || echo "warning: Docker is missing, jobs will not be able to use it"
fi

log "Creating the runner account"
getent group docker >/dev/null || groupadd --system docker
install -d -m 0755 /var/lib/dokploy-runners
if ! id dokploy-runner >/dev/null 2>&1; then
	useradd --system --home-dir /var/lib/dokploy-runners/home --create-home --shell /bin/bash dokploy-runner
fi
usermod -aG docker dokploy-runner
install -d -m 0755 ${RUNTIME_ROOT} ${RUNTIME_ROOT}/bin ${RUNTIME_ROOT}/releases /etc/dokploy-runners
install -d -m 0755 -o dokploy-runner -g dokploy-runner ${RUNTIME_ROOT}/slots ${RUNTIME_ROOT}/tool-cache
install -d -m 0700 -o dokploy-runner -g dokploy-runner /var/lib/dokploy-runners/jobs /var/lib/dokploy-runners/home

log "Installing the runtime"
write_file() {
	local tmp
	tmp=$(mktemp "$1.XXXXXX")
	cat >"$tmp"
	chmod "$2" "$tmp"
	mv -f "$tmp" "$1"
}
${files.map((file) => `write_file ${file.path} ${file.mode} ${heredoc(file.content)}`).join("\n")}
[ -f /etc/dokploy-runners/runner.env ] || install -m 0640 -o root -g dokploy-runner /dev/null /etc/dokploy-runners/runner.env
systemctl daemon-reload

if command -v docker >/dev/null 2>&1; then
	log "Placing job containers in the runner budget"
	install -d -m 0755 /etc/docker
	current='{}'
	[ -s /etc/docker/daemon.json ] && current=$(cat /etc/docker/daemon.json)
	desired=$(printf '%s' "$current" | jq '."cgroup-parent" = "dokploy-runners.slice"')
	systemctl enable docker >/dev/null 2>&1 || true
	if [ "$desired" != "$(printf '%s' "$current" | jq .)" ]; then
		printf '%s\\n' "$desired" >/etc/docker/daemon.json.dokploy
		mv -f /etc/docker/daemon.json.dokploy /etc/docker/daemon.json
		systemctl restart docker
	else
		systemctl start docker
	fi
fi

# Return the space freed by deleted Docker data to the host every day (sparse VM disks).
install -d -m 0755 /etc/systemd/system/fstrim.timer.d
printf '[Timer]\\nOnCalendar=\\nOnCalendar=daily\\n' >/etc/systemd/system/fstrim.timer.d/dokploy-runners.conf
systemctl daemon-reload
systemctl enable --now fstrim.timer >/dev/null 2>&1 || true
systemctl start dokploy-runners.slice
echo ${RUNTIME_VERSION} >/etc/dokploy-runners/runtime-version
log "Runtime ${RUNTIME_VERSION} installed"
`;

/** Facts gathered before anything is installed on a Linux machine. */
export const linuxFactsScript = () => `S=""
[ "$(id -u)" = 0 ] || S="sudo -n"
echo "os kernel=$(uname -s) arch=$(uname -m)"
( . /etc/os-release 2>/dev/null; echo "distro id=\${ID:-unknown} version=\${VERSION_ID:-}" )
echo "host cpus=$(nproc --all 2>/dev/null || echo 0) memory_kib=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null)"
if [ "$(id -u)" = 0 ]; then echo "user root=yes sudo=yes"; elif sudo -n true 2>/dev/null; then echo "user root=no sudo=yes"; else echo "user root=no sudo=no"; fi
if [ -d /run/systemd/system ]; then echo "systemd present=yes"; else echo "systemd present=no"; fi
echo "cgroup fs=$(stat -fc %T /sys/fs/cgroup 2>/dev/null)"
if command -v apt-get >/dev/null 2>&1; then echo "apt present=yes"; else echo "apt present=no"; fi
df -Pk / | awk 'NR==2 {print "disk total_kib=" $2 " free_kib=" $4}'
if command -v docker >/dev/null 2>&1; then
	echo "docker present=yes swarm=$($S docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null || echo unknown) containers=$($S docker ps -aq 2>/dev/null | wc -l | tr -d ' ')"
else
	echo "docker present=no"
fi
echo "network github=$(curl -sS -o /dev/null -m 10 -w '%{http_code}' https://github.com 2>/dev/null || echo 000)"
echo "runtime version=$(cat /etc/dokploy-runners/runtime-version 2>/dev/null || echo 0)"
`;

/** runnerctl status, or a runtime version of 0 when nothing is installed yet. */
export const statusCommand = `sh -c 'if [ -x ${RUNNERCTL} ]; then exec ${RUNNERCTL} status; else echo "runtime version=0"; fi'`;

const quoteEnv = (value: string) =>
	`"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$")}"`;

/**
 * runner.env of a pool: shared tool cache, the Dokploy job hooks (which then call
 * the pool hooks) and the pool environment.
 */
export const runnerEnvironment = (pool: {
	runnerEnv: string;
	jobStartedHook: string | null;
	jobCompletedHook: string | null;
}) => {
	const lines = [
		`RUNNER_TOOL_CACHE=${RUNTIME_ROOT}/tool-cache`,
		`AGENT_TOOLSDIRECTORY=${RUNTIME_ROOT}/tool-cache`,
		`ACTIONS_RUNNER_HOOK_JOB_STARTED=${RUNTIME_ROOT}/bin/job-started.sh`,
		`ACTIONS_RUNNER_HOOK_JOB_COMPLETED=${RUNTIME_ROOT}/bin/job-completed.sh`,
	];
	if (pool.jobStartedHook) {
		lines.push(`DOKPLOY_JOB_STARTED_HOOK=${quoteEnv(pool.jobStartedHook)}`);
	}
	if (pool.jobCompletedHook) {
		lines.push(`DOKPLOY_JOB_COMPLETED_HOOK=${quoteEnv(pool.jobCompletedHook)}`);
	}
	for (const raw of pool.runnerEnv.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		const key = line.slice(0, separator);
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		lines.push(`${key}=${quoteEnv(line.slice(separator + 1))}`);
	}
	return `${lines.join("\n")}\n`;
};

export const shellQuote = (value: string) =>
	`'${value.replace(/'/g, "'\\''")}'`;
