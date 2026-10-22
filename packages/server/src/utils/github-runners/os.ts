/**
 * The operating system of a machine (and of a Mac's VM): its version, the
 * updates waiting, a pending reboot, and whether its vendor still supports
 * it. Dokploy only reports it: the administrator updates the OS.
 */
import type { GithubRunnerOsInfo } from "@dokploy/server/db/schema";
import { parseRecords } from "./probe";
import { sh } from "./runtime";
import { compareVersions } from "./versions";

/** Support ending within this delay is flagged. */
export const OS_SUPPORT_WARNING_MS = 90 * 24 * 60 * 60_000;
/** Package lists older than this may not show the latest updates. */
export const STALE_LISTS_MS = 7 * 24 * 60 * 60_000;

const clean = sh`clean() { printf '%s' "$1" | tr -cd 'A-Za-z0-9._+~-'; }`;

/**
 * Linux (a machine, or the VM of a Mac). Read-only: it counts the updates
 * the package lists already know of (apt refreshes them daily) and never
 * installs anything.
 */
export const linuxOsReportScript = () => sh`set -u
${clean}
os_id=unknown
os_version=
if [ -r /etc/os-release ]; then
	os_id=$(. /etc/os-release && printf '%s' "\${ID:-unknown}")
	os_version=$(. /etc/os-release && printf '%s' "\${VERSION_ID:-}")
fi
echo "os id=$(clean "$os_id") version=$(clean "$os_version") kernel=$(clean "$(uname -r)")"
updates=
security=
if [ -x /usr/lib/update-notifier/apt-check ]; then
	counts=$(/usr/lib/update-notifier/apt-check 2>&1 >/dev/null || true)
	case "$counts" in
	*\;*) updates=\${counts%%;*} security=\${counts#*;} ;;
	esac
elif command -v apt-get >/dev/null 2>&1; then
	simulated=$(apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null || true)
	updates=$(printf '%s\n' "$simulated" | grep -c '^Inst ' || true)
	security=$(printf '%s\n' "$simulated" | grep '^Inst ' | grep -ci security || true)
fi
lists=$(stat -c %Y /var/lib/apt/lists 2>/dev/null || true)
reboot=$([ -f /var/run/reboot-required ] && echo yes || echo no)
echo "updates pending=$(clean "$updates") security=$(clean "$security") lists=$(clean "$lists") reboot=$reboot"
`;

/**
 * macOS, as the standard account Dokploy logs in with: softwareupdate lists
 * the available updates without installing them (it asks Apple's servers, so
 * it takes a while).
 */
export const macOsReportScript = () => sh`set -u
${clean}
echo "os id=macos version=$(clean "$(sw_vers -productVersion)") build=$(clean "$(sw_vers -buildVersion)") kernel=$(clean "$(uname -r)")"
list=$(softwareupdate --list 2>&1 || true)
case "$list" in
*"No new software available"* | *"* Label:"*)
	updates=$(printf '%s\n' "$list" | grep -c '^\* Label:' || true)
	recommended=$(printf '%s\n' "$list" | grep -c 'Recommended: YES' || true)
	;;
*) updates='' recommended='' ;;
esac
echo "updates pending=$updates security=$recommended lists= reboot="
`;

const count = (value: string | undefined) =>
	value && /^\d+$/.test(value) ? Number(value) : null;

/** Reads the report of either script; null when the OS line is missing. */
export const parseOsReport = (output: string): GithubRunnerOsInfo | null => {
	const records = parseRecords(output);
	const os = records.find((record) => record.kind === "os")?.fields;
	if (!os?.id) return null;
	const updates = records.find((record) => record.kind === "updates")?.fields;
	const lists = count(updates?.lists);
	return {
		id: os.id.toLowerCase(),
		version: os.version ?? "",
		build: os.build || null,
		kernel: os.kernel ?? "",
		updates: count(updates?.pending),
		security: count(updates?.security),
		reboot:
			updates?.reboot === "yes"
				? true
				: updates?.reboot === "no"
					? false
					: null,
		listsAt: lists ? new Date(lists * 1000).toISOString() : null,
	};
};

// ------------------------------------------------------------- support dates

/** A release line of an OS, as endoflife.date publishes it. */
export interface OsRelease {
	name: string;
	isEol: boolean;
	eolFrom: string | null;
	/** Latest point release of that line, e.g. macOS 27.0.1. */
	latest: string | null;
}

/** endoflife.date products for the os-release IDs Dokploy knows. */
const PRODUCTS: Record<string, string> = {
	ubuntu: "ubuntu",
	debian: "debian",
	macos: "macos",
	fedora: "fedora",
	rhel: "rhel",
	rocky: "rocky-linux",
	almalinux: "almalinux",
};

export const osProduct = (id: string) => PRODUCTS[id] ?? null;

type Fetch = typeof fetch;

/** Release lines of a product, from https://endoflife.date (v1 API). */
export const fetchOsReleases = async (
	product: string,
	options: { fetch?: Fetch } = {},
): Promise<OsRelease[]> => {
	const response = await (options.fetch ?? fetch)(
		`https://endoflife.date/api/v1/products/${encodeURIComponent(product)}`,
		{
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(20_000),
		},
	);
	if (!response.ok) {
		throw new Error(
			`endoflife.date answered ${response.status} for ${product}`,
		);
	}
	const data = (await response.json()) as {
		result?: {
			releases?: {
				name?: string;
				isEol?: boolean;
				eolFrom?: string | null;
				latest?: { name?: string } | null;
			}[];
		};
	};
	return (data.result?.releases ?? []).flatMap((release) =>
		release.name
			? [
					{
						name: release.name,
						isEol: release.isEol === true,
						eolFrom: release.eolFrom ?? null,
						latest: release.latest?.name ?? null,
					},
				]
			: [],
	);
};

/** The release line of a version: "24.04" for Ubuntu, "27" for macOS 27.0.1. */
export const osReleaseOf = (version: string, releases: OsRelease[]) => {
	const byName = new Map(releases.map((release) => [release.name, release]));
	const parts = version.split(".");
	for (let length = parts.length; length > 0; length--) {
		const release = byName.get(parts.slice(0, length).join("."));
		if (release) return release;
	}
	return null;
};

const NAMES: Record<string, string> = {
	ubuntu: "Ubuntu",
	debian: "Debian",
	macos: "macOS",
	fedora: "Fedora",
	rhel: "RHEL",
	rocky: "Rocky Linux",
	almalinux: "AlmaLinux",
};

export const osLabel = (info: Pick<GithubRunnerOsInfo, "id" | "version">) =>
	`${NAMES[info.id] ?? info.id} ${info.version}`.trim();

/**
 * - current: supported, nothing waiting;
 * - updates: updates waiting, none of them security ones;
 * - outdated: security (or recommended) updates waiting, a reboot pending,
 *   or support ending within 90 days;
 * - unsupported: the vendor no longer supports this release;
 * - unknown: not reported yet.
 */
export type OsState =
	| "current"
	| "updates"
	| "outdated"
	| "unsupported"
	| "unknown";

export interface OsStatus {
	state: OsState;
	label: string | null;
	/** End of the vendor's support for this release, when known. */
	supportEnds: string | null;
	message: string;
}

const day = (iso: string) => iso.slice(0, 10);
/** Starts a sentence, leaving names such as macOS as they are. */
const capitalize = (text: string) =>
	/^macOS\b/.test(text) ? text : text.charAt(0).toUpperCase() + text.slice(1);
const plural = (value: number, word: string) =>
	`${value} ${word}${value === 1 ? "" : "s"}`;

export const osStatus = (input: {
	info: GithubRunnerOsInfo | null;
	/** Release lines of its product; empty when not known. */
	releases: OsRelease[];
	now: number;
}): OsStatus => {
	const { info, releases, now } = input;
	if (!info) {
		return {
			state: "unknown",
			label: null,
			supportEnds: null,
			message: "The operating system has not been reported yet",
		};
	}
	const label = osLabel(info);
	const release = osReleaseOf(info.version, releases);
	const supportEnds = release?.eolFrom ?? null;
	const ended =
		release?.isEol || (supportEnds !== null && now >= Date.parse(supportEnds));
	const mac = info.id === "macos";
	const fix = mac
		? "Install them in System Settings › General › Software Update."
		: "Install them with sudo apt upgrade, then reboot if asked, while no job runs.";
	if (ended) {
		return {
			state: "unsupported",
			label,
			supportEnds,
			message: `${label} is no longer supported by its vendor${supportEnds ? ` since ${day(supportEnds)}` : ""}: it gets no security fixes. Upgrade to a supported release.`,
		};
	}
	const problems: string[] = [];
	if (supportEnds && Date.parse(supportEnds) - now <= OS_SUPPORT_WARNING_MS) {
		problems.push(`support ends on ${day(supportEnds)}`);
	}
	if (info.security) {
		problems.push(
			mac
				? `${plural(info.security, "recommended update")} waiting`
				: `${plural(info.security, "security update")} waiting`,
		);
	}
	if (info.reboot) problems.push("a reboot is needed to finish an update");
	if (
		mac &&
		info.updates === null &&
		release?.latest &&
		compareVersions(info.version, release.latest) < 0
	) {
		problems.push(`macOS ${release.latest} is available`);
	}
	const stale =
		info.listsAt && now - Date.parse(info.listsAt) > STALE_LISTS_MS
			? ` The package lists date from ${day(info.listsAt)}: run sudo apt update to see recent updates.`
			: "";
	if (problems.length) {
		const first = problems[0] ?? "";
		return {
			state: "outdated",
			label,
			supportEnds,
			message: `${label}: ${[capitalize(first), ...problems.slice(1)].join(", ")}. ${fix}${stale}`,
		};
	}
	if (info.updates) {
		return {
			state: "updates",
			label,
			supportEnds,
			message: `${label}: ${plural(info.updates, "update")} waiting, none for security. ${fix}${stale}`,
		};
	}
	return {
		state: "current",
		label,
		supportEnds,
		message: `${label}${supportEnds ? `, supported until ${day(supportEnds)}` : ""}${info.updates === null ? "" : ", up to date"}.${stale}`,
	};
};

// ------------------------------------------------------------- OS updates

/**
 * Installs the pending updates of a Linux system (a machine, or the VM of a
 * Mac), as root, once its jobs ended. apt only. Keeps the configuration files
 * as they are, allows the new packages a kernel update needs, removes
 * nothing. Prints whether a reboot is needed.
 */
export const osPatchScript = () => sh`set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
command -v apt-get >/dev/null 2>&1 || { echo "error: Dokploy installs OS updates with apt only" >&2; exit 1; }
apt="apt-get -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"
$apt update -qq
$apt -y -q --with-new-pkgs upgrade
echo "patched boot=$(cat /proc/sys/kernel/random/boot_id) reboot=$([ -f /var/run/reboot-required ] && echo yes || echo no)"
`;

/** Reads the line osPatchScript ends with. */
export const parsePatchResult = (output: string) => {
	const record = parseRecords(output).find((item) => item.kind === "patched");
	return record
		? {
				bootId: record.fields.boot ?? null,
				reboot: record.fields.reboot === "yes",
			}
		: null;
};
