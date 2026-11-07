/**
 * apt as Dokploy drives it on the Linux systems it updates: the GitHub runner
 * machines (github-runners/os.ts) and the servers of OS updates share these
 * shell fragments, so both wait for apt's locks and read its simulated
 * upgrades the same way.
 */
import { sh } from "../github-runners/runtime";

/** No prompt, and root's usual PATH: a script run through sudo may lack it. */
export const APT_ENVIRONMENT = sh`export DEBIAN_FRONTEND=noninteractive
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

/**
 * apt-get waiting up to 10 minutes for dpkg's locks, and keeping the
 * configuration files an administrator changed.
 */
export const APT_GET =
	"apt-get -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold";

/**
 * Refreshes the package lists with `$apt` (APT_GET), and exits once every
 * attempt failed: about 5 minutes with the default 30 attempts.
 */
export const aptUpdateRetries = (
	attempts = 30,
) => sh`# The package lists lock has no timeout, unlike dpkg's: apt-daily may hold it.
for attempt in $(seq 1 ${attempts}); do
	$apt update -qq && break
	[ "$attempt" != ${attempts} ] || exit 1
	sleep 10
done`;

/** A simulated run: no lock taken, nothing changed, any user may run it. */
export const APT_SIMULATE = "apt-get -s -o Debug::NoLocking=1";

/** When the package lists were last refreshed (seconds since the epoch). */
export const APT_LISTS_TIME = "stat -c %Y /var/lib/apt/lists";

/** "yes" when an installed update waits for a reboot (Debian and Ubuntu). */
export const REBOOT_REQUIRED = sh`$([ -f /var/run/reboot-required ] && echo yes || echo no)`;

/** Changes at every boot: tells a machine that rebooted. */
export const BOOT_ID = sh`$(cat /proc/sys/kernel/random/boot_id)`;

/** Keeps the characters a report field may carry. */
export const CLEAN_FUNCTION = sh`clean() { printf '%s' "$1" | tr -cd 'A-Za-z0-9._+~-'; }`;

/**
 * Reboots 5 seconds later, from a transient unit: the SSH command that asks
 * for it returns first.
 */
export const rebootCommand = (unit: string) =>
	`systemd-run --on-active=5 --unit=${unit} systemctl reboot`;

// ------------------------------------------------------------- simulation

/** Debian policy: lowercase letters, digits, + - . (and a :arch qualifier). */
export const DEBIAN_PACKAGE = /^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?$/;
/** Debian version strings, epoch and revision included. */
export const DEBIAN_VERSION = /^[A-Za-z0-9.+~:-]+$/;

/**
 * An update is a security one when its candidate comes from a security
 * pocket (noble-security, bookworm-security...), as the runners count them.
 */
export const isSecurityOrigin = (origins: string) => /security/i.test(origins);

export interface SimulatedPackage {
	name: string;
	arch: string | null;
	/** Installed version; null for a package the upgrade would install anew. */
	from: string | null;
	to: string;
	/** "Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security". */
	origins: string;
	security: boolean;
}

// Inst libssl3t64 [3.0.13-0ubuntu3.1] (3.0.13-0ubuntu3.4 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])
const INST =
	/^Inst (\S+) (?:\[(\S+)\] )?\((\S+)(?: (.*?))?(?: \[([^\]\s]+)\])?\)(?: \[.*\])?$/;

/**
 * Reads `apt-get -s upgrade` (LC_ALL=C): the packages it would install, and
 * those it keeps back (phased updates, or updates that need a removal).
 */
export const parseSimulation = (output: string) => {
	const packages: SimulatedPackage[] = [];
	const keptBack: string[] = [];
	let inKeptBack = false;
	for (const line of output.split("\n")) {
		if (line.startsWith("The following packages have been kept back")) {
			inKeptBack = true;
			continue;
		}
		if (inKeptBack) {
			if (line.startsWith(" ")) {
				keptBack.push(
					...line
						.trim()
						.split(/\s+/)
						.filter((name) => DEBIAN_PACKAGE.test(name)),
				);
				continue;
			}
			inKeptBack = false;
		}
		const match = INST.exec(line.trimEnd());
		if (!match) continue;
		const [, name = "", from, to = "", origins = "", arch] = match;
		if (!DEBIAN_PACKAGE.test(name) || !DEBIAN_VERSION.test(to)) continue;
		if (from !== undefined && !DEBIAN_VERSION.test(from)) continue;
		packages.push({
			name,
			arch: arch ?? null,
			from: from ?? null,
			to,
			origins,
			security: isSecurityOrigin(origins),
		});
	}
	return { packages, keptBack };
};
