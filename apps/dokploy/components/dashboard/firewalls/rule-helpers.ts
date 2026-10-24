import {
	type FirewallRule,
	firewallRuleSchema,
} from "@dokploy/server/utils/firewall/rules";

export const newRuleId = () =>
	globalThis.crypto?.randomUUID?.().slice(0, 12) ??
	Math.random().toString(36).slice(2, 14);

/** The first problem of a rule, for the row that shows it. */
export const ruleError = (rule: FirewallRule) => {
	const parsed = firewallRuleSchema.safeParse(rule);
	return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Invalid");
};
