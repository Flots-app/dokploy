/**
 * The Linux runtime Dokploy installs on every runner machine: on the host for
 * Linux machines, inside the Lima VM for Macs. Bump RUNTIME_VERSION whenever a
 * file below changes; the controller reinstalls the runtime when the machine
 * reports an older version.
 */
import { parseEnvLines } from "./env";

export const RUNTIME_VERSION = 7;
/**
 * The oldest runtime this controller can drive. An older one is updated at
 * once, whatever the update policy; a newer optional runtime waits for it.
 * v6 changed the disk cleanup records, so it is required. v7 adds the
 * reserve a machine arms itself with while no controller answers: optional.
 */
export const MIN_RUNTIME_VERSION = 6;

const RUNTIME_ROOT = "/opt/dokploy-runners";
export const RUNNERCTL = `${RUNTIME_ROOT}/bin/runnerctl`;
/** Touched by every controller contact; autonomy starts after this much silence. */
export const CONTROLLER_SEEN = "/var/lib/dokploy-runners/controller-seen";
export const AUTONOMY_AFTER_S = 90;
/**
 * A reserved registration is used before this age: GitHub removes an ephemeral
 * runner that never connected after a day.
 */
export const SPARE_MAX_AGE_S = 20 * 60 * 60;

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
GC_LOCK="$STATE/gc.lock"
SEEN="$STATE/image-seen"
GC_SUFFIX=.dokploy-gc
SPARES="$STATE/spares"

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
	# The controller probes every few seconds: the machine knows it is watched.
	touch "$STATE/controller-seen" 2>/dev/null || true
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
	local docker_state
	docker_state=$(systemctl is-active docker 2>/dev/null || true)
	echo "docker state=$docker_state"
	# Docker keeps no "last used" time: the images running containers use are
	# noted here, every probe, for the least-recently-used cleanup.
	if [ "$docker_state" = active ] && [ -d "$SEEN" ]; then
		(timeout 5 docker ps --format '{{.Image}}' 2>/dev/null || true) | sort -u |
			while read -r image; do
				[ -n "$image" ] && touch "$SEEN/$(printf '%s' "$image" | tr -c 'A-Za-z0-9._-' '_')" 2>/dev/null || true
			done
	fi
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
	for file in "$SPARES"/*/*; do
		[ -f "$file" ] || continue
		id=$(basename "$(dirname "$file")")
		[[ "$id" =~ ^[0-9]+$ ]] || continue
		echo "spare slot=$id name=\${file##*/} created=$(stat -c %Y "$file")"
	done
	if [ -s "$STATE/autonomy.log" ]; then
		echo "autonomy armed=$(wc -l <"$STATE/autonomy.log") last=$(tail -n 1 "$STATE/autonomy.log" | cut -d' ' -f1)"
	fi
}

# Reads the arm input (JIT files and runner name) into the slot directory.
read_jit() {
	local dir=$1 key value
	while IFS=' ' read -r key value || [ -n "\${key:-}" ]; do
		case "$key" in
		.runner | .credentials | .credentials_rsaparams)
			[[ "$value" =~ ^[A-Za-z0-9+/=]+$ ]] || die "invalid $key"
			install -o "$RUNNER_USER" -g "$RUNNER_USER" -m 0600 /dev/null "$dir/$key" || die "could not write $key"
			printf '%s' "$value" | base64 -d >"$dir/$key" || die "could not decode $key"
			;;
		name)
			[[ "$value" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid runner name"
			printf '%s\n' "$value" >"$dir/.dokploy-runner-name" || die "could not write the runner name"
			;;
		'') ;;
		*) die "unexpected input: $key" ;;
		esac
		key=""
	done
}

# A registration kept for the slot, armed by autoarm while no controller answers.
cmd_spare_add() {
	local slot name tmp
	slot=$(slot_arg "\${1:-}")
	install -d -m 0700 "$SPARES" "$SPARES/$slot"
	tmp=$(mktemp "$SPARES/$slot/.new.XXXXXX")
	cat >"$tmp"
	name=$(awk '$1 == "name" {print $2}' "$tmp")
	[[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || { rm -f "$tmp"; die "invalid runner name"; }
	grep -q '^.credentials ' "$tmp" || { rm -f "$tmp"; die "incomplete JIT configuration"; }
	chmod 0600 "$tmp"
	mv -f "$tmp" "$SPARES/$slot/$name"
	echo "spare slot=$slot name=$name"
}

cmd_spare_drop() {
	local slot name
	slot=$(slot_arg "\${1:-}")
	name=\${2:-}
	[[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid runner name"
	rm -f "$SPARES/$slot/$name"
	echo "dropped slot=$slot name=$name"
}

# on <max runners> <disk reserve KiB> <firewall hash|host|none>, or off.
cmd_autonomy() {
	case "\${1:-}" in
	off)
		# The reserve stays: the controller drops it (spare-drop) when the machine
		# takes no job any more, and unregisters it from GitHub at the same time.
		rm -f "$ETC/autonomy"
		echo "autonomy off"
		;;
	on)
		[[ "\${2:-}" =~ ^[0-9]{1,2}$ ]] || die "invalid runner count"
		[[ "\${3:-}" =~ ^[0-9]+$ ]] || die "invalid disk reserve"
		[[ "\${4:-}" =~ ^([a-f0-9]{32}|host|none)$ ]] || die "invalid firewall"
		printf 'max_runners=%s min_free_kib=%s firewall=%s\n' "$2" "$3" "$4" >"$ETC/autonomy.new"
		mv -f "$ETC/autonomy.new" "$ETC/autonomy"
		echo "autonomy on"
		;;
	*) die "usage: runnerctl autonomy on <runners> <reserve KiB> <firewall>|off" ;;
	esac
}

# Run by a timer: once no controller has been seen for a while, free slots are
# armed with the registrations kept for them, oldest first.
cmd_autoarm() {
	local settings seen now max min_free firewall slot spare name mtime
	[ -f "$ETC/autonomy" ] || return 0
	now=$(date +%s)
	seen=$(stat -c %Y "$STATE/controller-seen" 2>/dev/null || echo 0)
	((now - seen >= ${AUTONOMY_AFTER_S})) || return 0
	settings=$(cat "$ETC/autonomy")
	max=$(printf '%s' "$settings" | sed -n 's/.*max_runners=\([0-9]*\).*/\1/p')
	min_free=$(printf '%s' "$settings" | sed -n 's/.*min_free_kib=\([0-9]*\).*/\1/p')
	firewall=$(printf '%s' "$settings" | sed -n 's/.*firewall=\([a-z0-9]*\).*/\1/p')
	[[ "$max" =~ ^[0-9]+$ && "$min_free" =~ ^[0-9]+$ ]] || return 0
	# Linux: no job without the firewall it must run behind (a Mac filters on the host).
	if [[ "$firewall" =~ ^[a-f0-9]{32}$ ]] && [ "$(cat /run/dokploy-firewall.hash 2>/dev/null)" != "$firewall" ]; then
		echo "runnerctl: firewall not loaded, no slot armed" >&2
		return 0
	fi
	for ((slot = 1; slot <= max; slot++)); do
		case "$(slot_state "$slot")" in
		active | activating | deactivating | reloading) continue ;;
		esac
		spare=""
		while read -r mtime name; do
			if ((now - \${mtime%.*} > ${SPARE_MAX_AGE_S})); then
				rm -f "$SPARES/$slot/$name"
				continue
			fi
			spare="$SPARES/$slot/$name"
			break
		done < <(find "$SPARES/$slot" -maxdepth 1 -type f ! -name '.*' -printf '%T@ %f\n' 2>/dev/null | sort -n)
		[ -n "$spare" ] || continue
		if (cmd_arm "$slot" "$min_free" <"$spare") >/dev/null; then
			rm -f "$spare"
			echo "$now slot=$slot name=\${spare##*/}" >>"$STATE/autonomy.log"
		else
			# Disk below the reserve, or a slot that would not start: next round.
			return 0
		fi
	done
}

# Measures what a job gets: run inside the runner slice, so under the same CPU
# quota and CPUs as the jobs (on a Mac, the VM is the budget).
cmd_bench() {
	systemd-run --quiet --wait --pipe --collect --slice="$SLICE" \
		/bin/bash "$ROOT/bin/bench.sh"
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
	local slot min_free_kib unit state free release dir
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
	# Every step fails loudly: autoarm runs this inside an if, where set -e
	# does not apply, and must keep its registration when a slot cannot start.
	if [ "$(cat "$dir/.dokploy-release" 2>/dev/null || true)" != "$release" ]; then
		rm -rf "$dir" "$dir.new"
		cp -a "$release" "$dir.new" || die "slot $slot: could not copy the runner release"
		echo "$release" >"$dir.new/.dokploy-release" || die "slot $slot: could not write"
		chown -R "$RUNNER_USER:$RUNNER_USER" "$dir.new" || die "slot $slot: could not chown"
		mv "$dir.new" "$dir" || die "slot $slot: could not install the release"
	fi
	# Ephemeral: nothing of the previous job survives in the slot. Shared caches
	# (tool cache, home, Docker images and build cache) are kept for speed.
	rm -rf "$dir/_work" "$dir/_diag" "$dir/.runner" "$dir/.credentials" \
		"$dir/.credentials_rsaparams" "$dir/.dokploy-runner-name" "$STATE/jobs/$slot"
	install -d -o "$RUNNER_USER" -g "$RUNNER_USER" -m 0700 "$dir/_work" || die "slot $slot: could not create its workspace"
	read_jit "$dir"
	[ -s "$dir/.runner" ] && [ -s "$dir/.credentials" ] || die "incomplete JIT configuration"
	systemctl reset-failed "$unit" >/dev/null 2>&1 || true
	systemctl start --no-block "$unit" || die "slot $slot did not start"
	echo "armed slot=$slot"
}

# A runner that did not stop may still run its job: never reported as stopped.
cmd_stop() {
	local slot unit
	slot=$(slot_arg "\${1:-}")
	unit=$(unit_of "$slot")
	systemctl stop "$unit" >/dev/null 2>&1 || die "slot $slot did not stop (state: $(slot_state "$slot"))"
	systemctl reset-failed "$unit" >/dev/null 2>&1 || true
	echo "stopped slot=$slot"
}

cmd_stop_all() {
	if ! systemctl stop 'dokploy-runner@*.service' >/dev/null 2>&1; then
		echo "runnerctl: some runner slots did not stop" >&2
		return 1
	fi
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
			# Not "!= && rm": a false test would end the loop, and the
			# pipeline, with status 1 under pipefail.
			[ "$old" = "$target" ] || rm -rf "$old"
		done
	echo "release installed=$version"
}

# ---------------------------------------------------------------- disk cleanup
# Like the kubelet image garbage collector: caches grow freely, and when the disk
# runs low the least recently used ones are removed until the target is free.
#   1. waste, at no speed cost: stopped containers, dangling images and build
#      cache, unused anonymous volumes, workspaces of stopped slots;
#   2. caches unused for 30, 7 and 3 days, then for 25 hours: Docker images and
#      build cache, tool cache versions, caches in the runner home. A running job
#      has used what it needs within 24 hours (relatime), so it keeps them;
#   3. still below the threshold: every cache, only while no job runs. Jobs that
#      start meanwhile wait in their started hook.
declare -gA GC_FREED=() GC_COUNT=()
GC_FREE=0
GC_TARGET=0
# The cache directories, resolved: entries are compared with them (gc_cache_entry).
GC_TOOL_CACHE=$(readlink -f "$ROOT/tool-cache" 2>/dev/null || echo "$ROOT/tool-cache")
GC_HOME=$(readlink -f "$STATE/home" 2>/dev/null || echo "$STATE/home")

gc_reached() { ((GC_FREE >= GC_TARGET)); }

# Adds what an action gave back to its kind (other writers can make it negative).
gc_note() {
	local kind=$1 before=$2 counted=\${3:-0} now
	now=$(kib_free)
	if ((now > before)); then GC_FREED[$kind]=$((\${GC_FREED[$kind]:-0} + now - before)); fi
	if ((counted)); then GC_COUNT[$kind]=$((\${GC_COUNT[$kind]:-0} + 1)); fi
	GC_FREE=$now
}

gc_docker() { command -v docker >/dev/null 2>&1 && systemctl is-active --quiet docker; }

slot_state() { systemctl show -p ActiveState --value "$(unit_of "$1")" 2>/dev/null || echo inactive; }

gc_waste() {
	local before dir slot
	if gc_docker; then
		before=$GC_FREE
		docker container prune -f --filter until=30m >/dev/null 2>&1 || true
		docker network prune -f --filter until=30m >/dev/null 2>&1 || true
		gc_note containers "$before"
		before=$GC_FREE
		docker volume prune -f >/dev/null 2>&1 || true
		gc_note volumes "$before"
		before=$GC_FREE
		docker image prune -f >/dev/null 2>&1 || true
		gc_note images "$before"
		before=$GC_FREE
		docker builder prune -f >/dev/null 2>&1 || true
		gc_note build_cache "$before"
	fi
	for dir in "$ROOT"/slots/*/_work; do
		[ -d "$dir" ] || continue
		slot=\${dir%/_work}
		slot=\${slot##*/}
		[[ "$slot" =~ ^[0-9]+$ ]] || continue
		case "$(slot_state "$slot")" in inactive | failed) ;; *) continue ;; esac
		before=$GC_FREE
		rm -rf "$dir"
		gc_note workspaces "$before" 1
	done
	before=$GC_FREE
	find "$ROOT/tool-cache" "$STATE/home" -maxdepth 3 -name "*$GC_SUFFIX-*" -prune -exec rm -rf {} + 2>/dev/null || true
	find "$ROOT/releases" -maxdepth 1 -name '.download.*' -mmin +60 -exec rm -rf {} + 2>/dev/null || true
	find "$SEEN" -type f -mtime +60 -delete 2>/dev/null || true
	gc_note other "$before"
}

# Last use of a cache entry, in epoch seconds: the newest access or change of
# its files, and the newest change of its directories. Directory access times
# are left out: listing them (du, find, this very scan) updates them.
gc_last_used() {
	find "$1" -xdev \( -type f -printf '%A@ %T@\n' \) -o \( -type d -printf '%T@\n' \) 2>/dev/null |
		awk '{ for (i = 1; i <= NF; i++) if ($i > m) m = $i } END { printf "%d", m }'
}

# Splits a record of gc_candidates into the last, kind, tags and entry variables
# of the caller. The entry comes last: it is a path, which may hold tabs.
gc_parse() {
	local rest
	last=\${1%%$'\t'*}
	rest=\${1#*$'\t'}
	kind=\${rest%%$'\t'*}
	rest=\${rest#*$'\t'}
	tags=\${rest%%$'\t'*}
	entry=\${rest#*$'\t'}
	# Evaluated in arithmetic: never anything but digits.
	[[ "$last" =~ ^[0-9]+$ ]] || last=0
}

# Whether a path is an entry of a cache directory (a tool version, a cache of
# the runner home) with no symbolic link, "." or ".." on the way: jobs write
# these directories, and the cleanup runs as root.
gc_cache_entry() {
	local target=$1 parent
	[ "$(readlink -f -- "$target" 2>/dev/null)" = "$target" ] || return 1
	parent=\${target%/*}
	case "$parent" in
	"$GC_HOME" | "$GC_HOME/.cache" | "$GC_HOME/.local/share") return 0 ;;
	esac
	[ "\${parent%/*}" = "$GC_TOOL_CACHE" ]
}

# "<last used>\t<kind>\t<tags>\t<target>", NUL-terminated, for every cache entry
# no container uses. A file name can hold anything but NUL: a job naming a
# directory with a newline cannot forge a record.
gc_candidates() {
	local dev id last tags tag file seen dir name home=$GC_HOME
	dev=$(stat -c %d "$ROOT")
	if gc_docker && [ "$(stat -c %d "$(docker info -f '{{.DockerRootDir}}' 2>/dev/null)" 2>/dev/null)" = "$dev" ]; then
		local used
		used=" $( (docker ps -aq --no-trunc 2>/dev/null | xargs -r docker inspect -f '{{.Image}}' 2>/dev/null || true) | tr '\n' ' ') "
		(docker image ls -q --no-trunc 2>/dev/null | sort -u | xargs -r docker image inspect 2>/dev/null |
			jq -r '.[] | [.Id, ((.Metadata.LastTagTime // "") | sub("\\.[0-9]+"; "") | try fromdateiso8601 catch 0), ((.RepoTags // []) | join(" "))] | @tsv' || true) |
			while IFS=$'\t' read -r id last tags; do
				[ -n "$id" ] || continue
				[[ "$used" == *" $id "* ]] && continue
				last=\${last%%.*}
				[[ "$last" =~ ^[0-9]+$ ]] || last=0
				for tag in $tags; do
					file="$SEEN/$(printf '%s' "$tag" | tr -c 'A-Za-z0-9._-' '_')"
					if [ -f "$file" ]; then
						seen=$(stat -c %Y "$file")
						if ((seen > last)); then last=$seen; fi
					fi
				done
				printf '%s\timage\t%s\t%s\0' "$last" "$tags" "$id"
			done
	fi
	for dir in "$GC_TOOL_CACHE"/*/*; do
		[ -d "$dir" ] && [ ! -L "$dir" ] || continue
		[[ "$dir" == *"$GC_SUFFIX"* ]] && continue
		gc_cache_entry "$dir" || continue
		[ "$(stat -c %d "$dir")" = "$dev" ] || continue
		printf '%s\ttool_cache\t\t%s\0' "$(gc_last_used "$dir")" "$dir"
	done
	for dir in "$home"/.cache/* "$home"/.local/share/* "$home"/* "$home"/.[!.]*; do
		[ -d "$dir" ] && [ ! -L "$dir" ] || continue
		name=\${dir#"$home"/}
		case "$name" in
		.cache | .local | .config | .ssh | .gnupg | .docker | *"$GC_SUFFIX"*) continue ;;
		esac
		gc_cache_entry "$dir" || continue
		[ "$(stat -c %d "$dir")" = "$dev" ] || continue
		printf '%s\thome\t\t%s\0' "$(gc_last_used "$dir")" "$dir"
	done
}

gc_remove() {
	local kind=$1 target=$2 tags=$3 before=$GC_FREE
	if [ "$kind" = image ]; then
		[[ "$target" =~ ^sha256:[a-f0-9]{64}$ ]] || return 0
		if [ -n "$tags" ]; then
			# shellcheck disable=SC2086 # one argument per tag: the last one deletes the image
			docker image rm $tags >/dev/null 2>&1 || return 0
		else
			docker image rm "$target" >/dev/null 2>&1 || return 0
		fi
		gc_note images "$before" 1
		return 0
	fi
	[ -d "$target" ] && [ ! -L "$target" ] && gc_cache_entry "$target" || return 0
	# Renamed first: a job looking for it from now on sees a cache miss.
	mv -T "$target" "$target$GC_SUFFIX-$$" 2>/dev/null || return 0
	rm -rf "$target$GC_SUFFIX-$$"
	gc_note "$kind" "$before" 1
}

gc_build_cache() {
	local before=$GC_FREE
	gc_docker || return 0
	if [ "$1" = all ]; then
		docker builder prune -af >/dev/null 2>&1 || true
	else
		docker builder prune -af --filter "until=\${1}h" >/dev/null 2>&1 || true
	fi
	gc_note build_cache "$before"
}

# A job is running in a slot: its job file has no completion and its unit runs.
gc_jobs_running() {
	local file slot
	for file in "$STATE"/jobs/*; do
		[ -f "$file" ] || continue
		slot=\${file##*/}
		[[ "$slot" =~ ^[0-9]+$ ]] || continue
		grep -q '^completed=' "$file" && continue
		case "$(slot_state "$slot")" in active | activating | deactivating | reloading) return 0 ;; esac
	done
	return 1
}

cmd_gc() {
	local mode=\${1:-light} threshold=\${2:-0} target=\${3:-0} start hours cutoff i last kind entry tags line atime=yes idle=not-needed
	case "$mode" in
	auto)
		[[ "$threshold" =~ ^[0-9]+$ && "$target" =~ ^[0-9]+$ ]] || die "invalid thresholds"
		;;
	light) threshold=0 target=0 ;;
	full)
		threshold=$(df -Pk "$ROOT" | awk 'NR==2 {print $2}')
		target=$threshold
		;;
	*) die "usage: runnerctl gc auto <threshold_kib> <target_kib> | light | full" ;;
	esac
	install -d -m 0700 "$SEEN"
	trap 'rm -f "$GC_LOCK"' EXIT
	start=$(kib_free)
	GC_FREE=$start
	GC_TARGET=$target
	gc_waste
	if [ "$mode" != light ] && ! gc_reached; then
		# Without access times, file caches only go in the idle step.
		findmnt -no OPTIONS -T "$ROOT" 2>/dev/null | grep -qw noatime && atime=no
		local -a entries=()
		mapfile -d '' -t entries < <(gc_candidates | sort -z -t $'\t' -n -k1,1)
		i=0
		for hours in 720 168 72 25; do
			gc_build_cache "$hours"
			gc_reached && break
			cutoff=$(($(date +%s) - hours * 3600))
			while ((i < \${#entries[@]})); do
				gc_parse "\${entries[i]}"
				((last < cutoff)) || break
				i=$((i + 1))
				[ "$kind" = image ] || [ "$atime" = yes ] || continue
				gc_remove "$kind" "$entry" "$tags"
				gc_reached && break 2
			done
		done
		if ((GC_FREE < threshold)); then
			# The lock comes before the job check: a job starting after the check
			# finds the lock and waits (see the job started hook).
			printf '%s %s\n' "$$" "$(date +%s)" >"$GC_LOCK"
			if gc_jobs_running; then
				idle=skipped-jobs
				rm -f "$GC_LOCK"
			else
				idle="done"
				gc_build_cache all
				for line in "\${entries[@]}"; do
					gc_reached && break
					gc_parse "$line"
					gc_remove "$kind" "$entry" "$tags"
				done
				rm -f "$GC_LOCK"
			fi
		fi
	fi
	# Hands the freed blocks back to the hypervisor (sparse VM disks): online
	# discard only runs once the journal commits the deletions, so commit first.
	sync -f "$ROOT" 2>/dev/null || sync
	timeout 120 fstrim -a >/dev/null 2>&1 || true
	GC_FREE=$(kib_free)
	for kind in "\${!GC_FREED[@]}"; do
		echo "freed kind=$kind kib=\${GC_FREED[$kind]} count=\${GC_COUNT[$kind]:-0}"
	done
	echo "gc mode=$mode before_kib=$start free_kib=$GC_FREE threshold_kib=$threshold target_kib=$target reached=$(gc_reached && echo yes || echo no) idle=$idle"
}

cmd_uninstall() {
	systemctl disable --now dokploy-runner-autoarm.timer >/dev/null 2>&1 || true
	rm -f /etc/systemd/system/dokploy-runner-autoarm.timer /etc/systemd/system/dokploy-runner-autoarm.service
	cmd_stop_all >/dev/null || echo "warning: removing the runtime anyway" >&2
	systemctl stop "$SLICE" >/dev/null 2>&1 || true
	rm -f /etc/systemd/system/dokploy-runner@.service "/etc/systemd/system/$SLICE" \
		/etc/systemd/system/fstrim.timer.d/dokploy-runners.conf
	rmdir /etc/systemd/system/fstrim.timer.d 2>/dev/null || true
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
bench) cmd_bench ;;
arm) cmd_arm "\${2:-}" "\${3:-0}" ;;
stop) cmd_stop "\${2:-}" ;;
stop-all) cmd_stop_all ;;
limits) cmd_limits "\${2:-}" "\${3:-}" "\${4:-}" ;;
env) cmd_env ;;
install-release) cmd_install_release "\${2:-}" "\${3:-}" "\${4:-}" ;;
gc) cmd_gc "\${2:-}" "\${3:-}" "\${4:-}" ;;
spare-add) cmd_spare_add "\${2:-}" ;;
spare-drop) cmd_spare_drop "\${2:-}" "\${3:-}" ;;
autonomy) cmd_autonomy "\${2:-}" "\${3:-}" "\${4:-}" "\${5:-}" ;;
autoarm) cmd_autoarm ;;
uninstall) cmd_uninstall ;;
*) die "usage: runnerctl status|caches|bench|gc|arm|stop|stop-all|limits|env|install-release|spare-add|spare-drop|autonomy|autoarm|uninstall" ;;
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

/**
 * Runs after the job file is written: a cleanup that needs every cache idle
 * takes its lock before looking for running jobs, so a job either shows up in
 * that check or finds the lock here. A lock older than 20 minutes is stale.
 */
const waitForCleanup = sh`	if [ -e /var/lib/dokploy-runners/gc.lock ]; then
		echo "Dokploy: waiting for the disk cleanup of this machine to finish"
		while [ -n "$(find /var/lib/dokploy-runners/gc.lock -mmin -20 2>/dev/null)" ]; do sleep 3; done
	fi`;

const recordCompletion = sh`	printf 'completed=%s\n' "$(date +%s)" >>"$state" 2>/dev/null || true`;

const jobHook = (phase: "started" | "completed") => sh`#!/bin/bash
# Managed by Dokploy: records the job of this runner slot, then runs the pool hook.
slot="\${DOKPLOY_RUNNER_SLOT:-}"
if [[ "$slot" =~ ^[0-9]+$ ]]; then
	state="/var/lib/dokploy-runners/jobs/$slot"
${phase === "started" ? `${recordJob}\n${waitForCleanup}` : recordCompletion}
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

/**
 * CPU benchmark of the runner budget, about 3 seconds: hashing (crypto units)
 * and gzip (branchy integer code), once on one core, then on every CPU of the
 * budget at once. Prints work units per second, x1000.
 */
const bench = sh`#!/bin/bash
# Managed by Dokploy (GitHub runners): reinstalled with the runtime, do not edit.
set -euo pipefail
dir=$(mktemp -d /dev/shm/dokploy-bench.XXXXXX 2>/dev/null || mktemp -d)
trap 'rm -rf "$dir"' EXIT
head -c 16777216 /dev/urandom >"$dir/data"
work() {
	for _ in 1 2 3 4; do
		sha256sum "$dir/data" >/dev/null
		gzip -1 -c "$dir/data" >/dev/null
	done
}
now() { date +%s%N; }
cpus=$(nproc)
work
start=$(now)
work
single=$(($(now) - start))
start=$(now)
for _ in $(seq "$cpus"); do work & done
wait
multi=$(($(now) - start))
echo "bench cpus=$cpus single=$((1000000000000 / single)) multi=$((cpus * 1000000000000 / multi))"
`;

const autoarmService = `[Unit]
Description=Dokploy GitHub Actions runners: arm free slots while no controller answers

[Service]
Type=oneshot
ExecStart=${RUNNERCTL} autoarm
`;

const autoarmTimer = `[Unit]
Description=Dokploy GitHub Actions runners: autonomy check

[Timer]
OnBootSec=60
OnUnitActiveSec=20
AccuracySec=5

[Install]
WantedBy=timers.target
`;

const files: { path: string; mode: string; content: string }[] = [
	{ path: RUNNERCTL, mode: "0755", content: runnerctl },
	{ path: `${RUNTIME_ROOT}/bin/bench.sh`, mode: "0755", content: bench },
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
	{
		path: "/etc/systemd/system/dokploy-runner-autoarm.service",
		mode: "0644",
		content: autoarmService,
	},
	{
		path: "/etc/systemd/system/dokploy-runner-autoarm.timer",
		mode: "0644",
		content: autoarmTimer,
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
install -d -m 0700 /var/lib/dokploy-runners/image-seen

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
install -d -m 0700 /var/lib/dokploy-runners/spares
systemctl enable --now dokploy-runner-autoarm.timer >/dev/null
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
	// The form refuses other lines; one stored before that check is left out.
	for (const entry of parseEnvLines(pool.runnerEnv)) {
		if (entry) lines.push(`${entry.key}=${quoteEnv(entry.value)}`);
	}
	return `${lines.join("\n")}\n`;
};

export const shellQuote = (value: string) =>
	`'${value.replace(/'/g, "'\\''")}'`;
