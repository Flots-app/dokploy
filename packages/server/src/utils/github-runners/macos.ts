import { shellQuote, statusCommand } from "./runtime";

/**
 * On a Mac the runners live in a Lima VM whose size is the budget. Commands run
 * over SSH as the macOS user owning Lima; they never need sudo on the host.
 */
const prelude = "export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH";

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
${withGuest ? "" : networkCheck}
if ! command -v limactl >/dev/null 2>&1; then
	echo "lima version="
	exit 0
fi
echo "lima version=$(limactl --version 2>/dev/null | awk '{print $NF}')"
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
limactl start --tty=false "$name"
`;

/** Graceful shutdown of the guest. Never --force: see macStartVmScript. */
export const macStopVmScript = (vmName: string) => `${prelude}
set -eu
name=${vm(vmName)}
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

export const macDeleteVmScript = (vmName: string) => `${prelude}
set -eu
name=${vm(vmName)}
if limactl list --format '{{.Status}}' "$name" >/dev/null 2>&1; then
	limactl stop "$name" >/dev/null 2>&1 || true
	limactl delete "$name"
fi
`;
