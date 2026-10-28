import {
	type FirewallRule,
	firewallRuleSchema,
} from "@dokploy/server/utils/firewall/rules";

/** 12 hex characters: getRandomValues also exists on plain HTTP, randomUUID does not. */
export const newRuleId = () =>
	Array.from(globalThis.crypto.getRandomValues(new Uint8Array(6)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");

/** The first problem of a rule, for the row that shows it. */
export const ruleError = (rule: FirewallRule) => {
	const parsed = firewallRuleSchema.safeParse(rule);
	return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Invalid");
};
