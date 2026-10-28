import { SETUP_CODE_PREFIX } from "@dokploy/server/utils/github-runners/setup-constants";

/**
 * How a setup code says Dokploy can reach the machine, to fill the form. The
 * server checks the whole code again; this only reads it.
 */
export const readSetupCode = (
	code: string,
): { hosts: string[]; port: number } | null => {
	const text = code.trim().replace(/\s+/g, "");
	if (!text.startsWith(SETUP_CODE_PREFIX)) return null;
	try {
		const data = JSON.parse(atob(text.slice(SETUP_CODE_PREFIX.length))) as {
			hosts?: unknown;
			port?: unknown;
		};
		return {
			hosts: Array.isArray(data.hosts)
				? data.hosts.filter(
						(host): host is string =>
							typeof host === "string" && /^[A-Za-z0-9.:-]{1,253}$/.test(host),
					)
				: [],
			port:
				Number.isInteger(data.port) &&
				(data.port as number) > 0 &&
				(data.port as number) < 65536
					? (data.port as number)
					: 22,
		};
	} catch {
		return null;
	}
};

/** Saves the setup script as a file the operator can inspect, then run. */
export const downloadScript = (fileName: string, script: string) => {
	const url = URL.createObjectURL(
		new Blob([script], { type: "text/x-shellscript" }),
	);
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	link.click();
	URL.revokeObjectURL(url);
};
