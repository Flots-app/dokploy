import { macFirewallStatus } from "./firewall";
import { shellQuote, statusCommand } from "./runtime";
import { BOOT_DAEMON } from "./setup-constants";

/**
 * On a Mac the runners live in a Lima VM whose size is the budget. Commands run
 * over SSH as the macOS user owning Lima; they never need sudo on the host.
 * Dokploy installs its own pinned Lima in ~/.dokploy/lima, ahead of Homebrew.
 */
const prelude =
	'export PATH="$HOME/.dokploy/lima/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"';

/** Lima release Dokploy installs on Macs; bump it deliberately. */
export const LIMA_VERSION = "2.2.1";

/** Present while the VM should run: the boot daemon starts it after a reboot. */
const enabledFlag = '"$HOME/.dokploy/enabled"';

/** github.com, not the API: unauthenticated API calls share a 60 per hour quota per IP. */
const networkCheck = `echo "network github=$(curl -sS -o /dev/null -m 10 -w '%{http_code}' https://github.com 2>/dev/null || echo 000)"`;

const vm = (name: string) => {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
		throw new Error(`Invalid VM name: ${name}`);
	}
	return name;
};

/** Runs a command as root inside the VM. */
export const inGuest = (vmName: string, command: string) =>
	`${prelude}\nexec limactl shell --workdir / ${vm(vmName)} sudo -n ${command}`;

/**
 * Host facts, VM state and, when it runs, the runtime status of the VM (lines
 * prefixed with "guest:"). The checks call it without the guest status but with
 * a GitHub reachability test, which must not run on every controller tick.
 */
export const macProbeScript = (
	vmName: string,
	withGuest: boolean,
) => `${prelude}
name=${vm(vmName)}
echo "mac cpus=$(sysctl -n hw.ncpu) memory_bytes=$(sysctl -n hw.memsize) arch=$(uname -m) version=$(sw_vers -productVersion) load=$(sysctl -n vm.loadavg | awk '{print $2}')"
echo "macmem free_percent=$(memory_pressure -Q 2>/dev/null | awk -F': ' '/free percentage/ {gsub("%", "", $2); print $2}')"
lima_home="\${LIMA_HOME:-$HOME/.lima}"
[ -d "$lima_home" ] || lima_home="$HOME"
df -Pk "$lima_home" | awk 'NR==2 {print "macdisk total_kib=" $2 " free_kib=" $4}'
admin=$(id -Gn | tr ' ' '\n' | grep -qx admin && echo yes || echo no)
sleep_minutes=$(pmset -g 2>/dev/null | awk '$1 == "sleep" {print $2; exit}')
filevault=$(fdesetup isactive >/dev/null 2>&1 && echo on || echo off)
daemon=$([ -f /Library/LaunchDaemons/${BOOT_DAEMON}.plist ] && echo yes || echo no)
echo "macsetup admin=$admin sleep=\${sleep_minutes:-unknown} filevault=$filevault daemon=$daemon"
${macFirewallStatus}
${withGuest ? "" : networkCheck}
if ! command -v limactl >/dev/null 2>&1; then
	echo "lima version= managed=no"
	exit 0
fi
echo "lima version=$(limactl --version 2>/dev/null | awk '{print $NF}') managed=$([ -x "$HOME/.dokploy/lima/bin/limactl" ] && echo yes || echo no)"
info=$(limactl list --format '{{.Status}}|{{.CPUs}}|{{.Memory}}|{{.Disk}}|{{.VMType}}' "$name" 2>/dev/null || true)
if [ -z "$info" ]; then
	echo "vm status=missing"
	exit 0
fi
IFS='|' read -r status cpus memory disk type <<EOF
$info
EOF
echo "vm status=$status cpus=$cpus memory_bytes=$memory disk_bytes=$disk type=$type"
${
	withGuest
		? `if [ "$status" = Running ]; then
	limactl shell --workdir / "$name" sudo -n ${statusCommand} 2>&1 | sed 's/^/guest: /' || echo "guest: error"
fi`
		: ""
}
`;

/** Creates the VM like the CI runbook: plain mode, no host mount, no port forwarding. */
export const macCreateVmScript = (
	vmName: string,
	size: { cpus: number; memoryGiB: string; diskGb: number },
) => `${prelude}
set -eu
limactl create --tty=false --name=${vm(vmName)} --plain --vm-type=vz \\
	--cpus=${size.cpus} --memory=${shellQuote(size.memoryGiB)} --disk=${size.diskGb} \\
	template:ubuntu-24.04
`;

/**
 * Starts the VM. After a Mac restart Lima can leave PID files of the previous
 * boot behind (lima-vm/lima#5087): `limactl start` then fails, or worse, a
 * forced stop would signal an unrelated process that reused the PID. Only files
 * older than the current boot are removed.
 */
export const macStartVmScript = (vmName: string) => `${prelude}
set -eu
name=${vm(vmName)}
status=$(limactl list --format '{{.Status}}' "$name")
if [ "$status" = Running ]; then
	echo "VM $name already running"
	exit 0
fi
dir=$(limactl list --format '{{.Dir}}' "$name")
boot=$(sysctl -n kern.boottime | sed -E 's/^\\{ sec = ([0-9]+).*/\\1/')
for file in "$dir"/*.pid; do
	[ -f "$file" ] || continue
	if [ "$(stat -f %m "$file")" -lt "$boot" ]; then
		echo "Removing $(basename "$file") left by a previous boot"
		rm -f "$file"
	fi
done
mkdir -p "$HOME/.dokploy"
touch ${enabledFlag}
limactl start --tty=false "$name"
`;

/** Graceful shutdown of the guest. Never --force: see macStartVmScript. */
export const macStopVmScript = (vmName: string) => `${prelude}
set -eu
name=${vm(vmName)}
rm -f ${enabledFlag}
if [ "$(limactl list --format '{{.Status}}' "$name" 2>/dev/null)" = Running ]; then
	limactl stop "$name"
fi
`;

/** Resizes a stopped VM. The disk can only grow. */
export const macResizeVmScript = (
	vmName: string,
	size: { cpus: number; memoryGiB: string; diskGb: number | null },
) => `${prelude}
set -eu
limactl edit --tty=false ${vm(vmName)} --cpus=${size.cpus} --memory=${shellQuote(size.memoryGiB)}${size.diskGb ? ` --disk=${size.diskGb}` : ""}
`;

/** Deletes the VM; the boot daemon no longer starts it. */
export const macDeleteVmScript = (vmName: string) => `${prelude}
set -eu
name=${vm(vmName)}
rm -f ${enabledFlag}
if limactl list --format '{{.Status}}' "$name" >/dev/null 2>&1; then
	limactl stop "$name" >/dev/null 2>&1 || true
	limactl delete "$name"
fi
`;

/**
 * Installs the pinned Lima release in ~/.dokploy (verified against the SHA-256
 * GitHub publishes), and keeps the previous one for a rollback. No Homebrew,
 * no admin rights: it belongs to the account Dokploy logs in with.
 */
export const macInstallLimaScript = (release: {
	version: string;
	url: string;
	sha256: string;
}) => {
	if (
		!/^\d+\.\d+\.\d+$/.test(release.version) ||
		!/^https:\/\/[A-Za-z0-9./_-]+$/.test(release.url) ||
		!/^[a-f0-9]{64}$/.test(release.sha256)
	) {
		throw new Error("Invalid Lima release");
	}
	return `${prelude}
set -euo pipefail
root="$HOME/.dokploy"
target="$root/lima-${release.version}"
if [ ! -x "$target/bin/limactl" ]; then
	mkdir -p "$root/downloads"
	tmp=$(mktemp -d "$root/downloads/lima.XXXXXX")
	trap 'rm -rf "$tmp"' EXIT
	curl -fsSL --retry 3 --connect-timeout 20 -o "$tmp/lima.tar.gz" ${shellQuote(release.url)}
	echo ${shellQuote(`${release.sha256}  `)}"$tmp/lima.tar.gz" | shasum -a 256 -c --status - ||
		{ echo "checksum mismatch for Lima ${release.version}" >&2; exit 1; }
	mkdir "$tmp/lima"
	tar -xzf "$tmp/lima.tar.gz" -C "$tmp/lima"
	"$tmp/lima/bin/limactl" --version >/dev/null
	rm -rf "$target"
	mv "$tmp/lima" "$target"
fi
ln -sfh "$target" "$root/lima"
ls -dt "$root"/lima-[0-9]* 2>/dev/null | tail -n +3 | while read -r old; do
	[ "$old" = "$target" ] || rm -rf "$old"
done
echo "lima installed=$("$root/lima/bin/limactl" --version | awk '{print $NF}')"
`;
};

/**
 * Script the boot daemon of the setup script runs at every boot: it starts the
 * VM when it should run, even if Dokploy is not reachable yet.
 */
export const macWriteBootScript = (vmName: string) => {
	const body = `#!/bin/bash
# Managed by Dokploy: started by the ${BOOT_DAEMON} daemon at boot.
[ -f ${enabledFlag} ] || exit 0
${macStartVmScript(vmName)}`;
	if (body.includes("\nDOKPLOY_EOF\n"))
		throw new Error("Unexpected boot script");
	return `set -eu
mkdir -p "$HOME/.dokploy/bin"
tmp=$(mktemp "$HOME/.dokploy/bin/boot.XXXXXX")
cat >"$tmp" <<'DOKPLOY_EOF'
${body}DOKPLOY_EOF
chmod 755 "$tmp"
mv -f "$tmp" "$HOME/.dokploy/bin/boot.sh"
`;
};
