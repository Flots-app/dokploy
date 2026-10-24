/**
 * The environment of a pool, one KEY=VALUE per line, as the form checks it, the
 * runner.env file gets it and the browser lists its keys. Blank lines and
 * comments (#) are skipped.
 */
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Each meaningful line, or null for a line that is not KEY=VALUE. */
export const parseEnvLines = (text: string) =>
	text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"))
		.map((line) => {
			const separator = line.indexOf("=");
			const key = line.slice(0, Math.max(separator, 0));
			const value = line.slice(separator + 1);
			return KEY.test(key) && !/[\0\r]/.test(value) ? { key, value } : null;
		});

export const envKeys = (text: string) =>
	parseEnvLines(text).flatMap((line) => (line ? [line.key] : []));
