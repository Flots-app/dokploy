const PROMETHEUS_READ_ENDPOINTS = new Set([
	"/api/v1/query",
	"/api/v1/query_range",
]);

const splitMatchers = (selector: string): string[] => {
	const matchers: string[] = [];
	let current = "";
	let inString = false;
	let escaped = false;

	for (const character of selector) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && inString) {
			current += character;
			escaped = true;
			continue;
		}
		if (character === '"') {
			inString = !inString;
			current += character;
			continue;
		}
		if (character === "," && !inString) {
			if (current.trim()) matchers.push(current.trim());
			current = "";
			continue;
		}
		current += character;
	}

	if (inString) throw new Error("Unterminated string in PromQL selector");
	if (current.trim()) matchers.push(current.trim());
	return matchers;
};

const unescapeLabelValue = (value: string) =>
	value.replaceAll('\\"', '"').replaceAll("\\\\", "\\");

const PROMQL_NON_METRIC_IDENTIFIERS = new Set([
	"and",
	"or",
	"unless",
	"offset",
	"bool",
	"by",
	"without",
	"on",
	"ignoring",
	"group_left",
	"group_right",
	"sum",
	"avg",
	"min",
	"max",
	"group",
	"stddev",
	"stdvar",
	"count",
	"count_values",
	"bottomk",
	"topk",
	"quantile",
	"limitk",
	"limit_ratio",
	"NaN",
	"Inf",
]);

const maskStringsAndSelectors = (query: string) => {
	const masked = [...query];
	let inString = false;
	let escaped = false;
	let selectorDepth = 0;

	for (let index = 0; index < query.length; index += 1) {
		const character = query[index];
		if (escaped) {
			masked[index] = " ";
			escaped = false;
			continue;
		}
		if (character === "\\" && inString) {
			masked[index] = " ";
			escaped = true;
			continue;
		}
		if (character === '"') {
			masked[index] = " ";
			inString = !inString;
			continue;
		}
		if (inString) {
			masked[index] = " ";
			continue;
		}
		if (character === "{") {
			selectorDepth += 1;
			continue;
		}
		if (character === "}") {
			selectorDepth -= 1;
			continue;
		}
		if (selectorDepth > 0) {
			masked[index] = " ";
		}
	}

	return masked.join("");
};

const getGroupingRanges = (query: string) => {
	const ranges: Array<[number, number]> = [];
	const modifier = /\b(?:by|without|on|ignoring|group_left|group_right)\s*\(/g;
	for (const match of query.matchAll(modifier)) {
		const open = (match.index ?? 0) + match[0].lastIndexOf("(");
		let depth = 0;
		for (let index = open; index < query.length; index += 1) {
			if (query[index] === "(") depth += 1;
			if (query[index] !== ")") continue;
			depth -= 1;
			if (depth === 0) {
				ranges.push([open, index]);
				break;
			}
		}
	}
	return ranges;
};

const assertNoBareVectorSelectors = (query: string) => {
	const masked = maskStringsAndSelectors(query);
	const groupingRanges = getGroupingRanges(masked);
	const isGroupingLabel = (index: number) =>
		groupingRanges.some(([start, end]) => index > start && index < end);

	for (let index = 0; index < masked.length; index += 1) {
		const character = masked[index] ?? "";
		if (!/[a-zA-Z_:]/.test(character)) continue;

		const previous = masked[index - 1] ?? "";
		let end = index + 1;
		while (/[a-zA-Z0-9_:]/.test(masked[end] ?? "")) end += 1;
		const identifier = masked.slice(index, end);
		const nextIndex = masked.slice(end).search(/\S/);
		const next = nextIndex === -1 ? "" : masked[end + nextIndex];

		if (
			/[0-9.]/.test(previous) ||
			isGroupingLabel(index) ||
			PROMQL_NON_METRIC_IDENTIFIERS.has(identifier) ||
			next === "{" ||
			next === "("
		) {
			index = end - 1;
			continue;
		}

		throw new Error(
			`Bare PromQL vector selector is not allowed: ${identifier}`,
		);
	}
};

const assertSelectorScope = (selector: string, serviceId: string) => {
	const exactServiceMatchers = splitMatchers(selector).filter((matcher) => {
		const match = matcher.match(
			/^service_id\s*(=|!=|=~|!~)\s*"((?:\\.|[^"\\])*)"$/,
		);
		return (
			match?.[1] === "=" && unescapeLabelValue(match[2] ?? "") === serviceId
		);
	});
	if (exactServiceMatchers.length !== 1) {
		throw new Error(
			"Every PromQL selector must contain one exact service_id matcher",
		);
	}
};

/**
 * Conservative PromQL guard for Grafana's datasource gateway.
 *
 * It rejects queries without an explicit selector and requires every selector
 * to include `service_id="<authorized service>"`. Regex, negative, missing, and
 * cross-service matchers therefore fail closed. Braces inside quoted strings
 * are ignored.
 */
export const assertPromQlServiceScope = (query: string, serviceId: string) => {
	if (!query.trim() || query.length > 20_000) {
		throw new Error("Invalid PromQL query");
	}

	let selectorCount = 0;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < query.length; index += 1) {
		const character = query[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\" && inString) {
			escaped = true;
			continue;
		}
		if (character === '"') {
			inString = !inString;
			continue;
		}
		if (character !== "{" || inString) continue;

		let selector = "";
		let selectorInString = false;
		let selectorEscaped = false;
		let closed = false;
		for (index += 1; index < query.length; index += 1) {
			const selectorCharacter = query[index];
			if (selectorEscaped) {
				selector += selectorCharacter;
				selectorEscaped = false;
				continue;
			}
			if (selectorCharacter === "\\" && selectorInString) {
				selector += selectorCharacter;
				selectorEscaped = true;
				continue;
			}
			if (selectorCharacter === '"') {
				selectorInString = !selectorInString;
				selector += selectorCharacter;
				continue;
			}
			if (selectorCharacter === "}" && !selectorInString) {
				closed = true;
				break;
			}
			selector += selectorCharacter;
		}
		if (!closed) throw new Error("Unterminated PromQL selector");
		assertSelectorScope(selector, serviceId);
		selectorCount += 1;
	}

	if (inString) throw new Error("Unterminated string in PromQL query");
	if (selectorCount === 0) {
		throw new Error("PromQL query must contain a scoped vector selector");
	}
	assertNoBareVectorSelectors(query);
};

export const assertPrometheusReadEndpoint = (pathname: string) => {
	if (!PROMETHEUS_READ_ENDPOINTS.has(pathname)) {
		throw new Error("Prometheus endpoint is not allowed");
	}
};
