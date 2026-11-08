/**
 * Which pending updates a run installs: the classification picks them, the
 * include list (when set) keeps only the packages it names, the exclude list
 * removes some, and Docker's packages stay out unless the user opts in.
 * Filters run here only: no pattern ever reaches a shell.
 */
import { z } from "zod";
import type { SimulatedPackage } from "./apt";

/**
 * Upgrading these restarts the Docker daemon (and with it every container of
 * the server) or its runtime. They move together, so they are held together.
 */
export const DOCKER_PACKAGE_PATTERNS = [
	"docker-ce*",
	"docker.io",
	"docker-buildx*",
	"docker-compose*",
	"containerd",
	"containerd.io",
	"runc",
];

/** A package name, with * (any characters) and ? (one character). */
export const packagePatternSchema = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.regex(
		/^[a-z0-9*?][a-z0-9+.:*?-]*$/,
		"Package names use lowercase letters, digits, + - . : and the wildcards * and ?",
	);

const patternsSchema = z.array(packagePatternSchema).max(100).default([]);

export const osUpdateSettingsSchema = z.object({
	/** security: updates from a security pocket only; all: every update. */
	classification: z.enum(["security", "all"]).default("security"),
	/** When not empty, only the packages matching one of these. */
	includePackages: patternsSchema,
	excludePackages: patternsSchema,
	/** if-required: when an update asks for it (/var/run/reboot-required). */
	reboot: z.enum(["if-required", "never", "always"]).default("if-required"),
	/** Docker's packages restart every container of the server. */
	allowDockerUpdates: z.boolean().default(false),
});

export type OsUpdateSettings = z.infer<typeof osUpdateSettingsSchema>;

export const DEFAULT_OS_UPDATE_SETTINGS: OsUpdateSettings = {
	classification: "security",
	includePackages: [],
	excludePackages: [],
	reboot: "if-required",
	allowDockerUpdates: false,
};

/**
 * Glob matching without a RegExp: a regular expression built from "*?*?…"
 * backtracks exponentially. On a mismatch after a `*`, only the last `*`
 * takes one more character, so the work is at most the product of the
 * lengths (100 × a package name).
 */
export const globMatches = (text: string, pattern: string) => {
	let t = 0;
	let p = 0;
	let star = -1;
	let resume = 0;
	while (t < text.length) {
		const symbol = pattern[p];
		if (symbol === "*") {
			star = p;
			resume = t;
			p += 1;
		} else if (p < pattern.length && (symbol === "?" || symbol === text[t])) {
			p += 1;
			t += 1;
		} else if (star !== -1) {
			p = star + 1;
			resume += 1;
			t = resume;
		} else {
			return false;
		}
	}
	while (pattern[p] === "*") p += 1;
	return p === pattern.length;
};

/**
 * Whether a package matches a pattern. A pattern without an architecture
 * matches every architecture of the package (libc6 matches libc6:i386).
 */
export const matchesPattern = (name: string, pattern: string) => {
	const target = pattern.includes(":") ? name : (name.split(":")[0] ?? name);
	return globMatches(target, pattern);
};

const matchesAny = (name: string, patterns: string[]) =>
	patterns.some((pattern) => matchesPattern(name, pattern));

export const isDockerPackage = (name: string) =>
	matchesAny(name, DOCKER_PACKAGE_PATTERNS);

export type SkipReason =
	| "docker"
	| "excluded"
	| "not-included"
	| "not-security";

export const SKIP_REASONS: Record<SkipReason, string> = {
	docker: "Docker package (restarts every container): not allowed",
	excluded: "excluded",
	"not-included": "not in the include list",
	"not-security": "not a security update",
};

/**
 * Splits the pending updates into those to install and those to skip.
 * A package the upgrade would install anew is only ever pulled in by an
 * update that needs it: it follows the exclusions, not the classification
 * nor the include list (the kernel image a security update of
 * linux-image-generic brings is installed with it).
 */
export const selectPackages = (
	packages: SimulatedPackage[],
	settings: OsUpdateSettings,
) => {
	const selected: SimulatedPackage[] = [];
	const skipped: { package: SimulatedPackage; reason: SkipReason }[] = [];
	for (const item of packages) {
		const reason: SkipReason | null =
			!settings.allowDockerUpdates && isDockerPackage(item.name)
				? "docker"
				: matchesAny(item.name, settings.excludePackages)
					? "excluded"
					: item.from === null
						? null
						: settings.classification === "security" && !item.security
							? "not-security"
							: settings.includePackages.length &&
									!matchesAny(item.name, settings.includePackages)
								? "not-included"
								: null;
		if (reason) skipped.push({ package: item, reason });
		else selected.push(item);
	}
	return { selected, skipped };
};
