import {
	FIREWALL_OBJECT_LABELS,
	FIREWALL_OBJECTS,
	type FirewallPolicy,
	type FirewallRule,
} from "@dokploy/server/utils/firewall/rules";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { newRuleId, ruleError } from "./rule-helpers";

export type Direction = FirewallRule["direction"];

const parseAddresses = (text: string) =>
	text
		.split(/[\s,]+/)
		.map((item) => item.trim())
		.filter(Boolean);

const AddressesInput = ({
	id,
	value,
	onChange,
}: {
	id: string;
	value: string[];
	onChange: (value: string[]) => void;
}) => {
	// The text keeps what is being typed (a trailing comma, a half address).
	const [text, setText] = useState(() => value.join(", "));
	return (
		<Input
			id={id}
			value={text}
			placeholder="10.0.0.0/8, 192.168.1.20, fd00::/8"
			onChange={(event) => {
				setText(event.target.value);
				onChange(parseAddresses(event.target.value));
			}}
		/>
	);
};

const RuleRow = ({
	rule,
	index,
	count,
	onChange,
	onMove,
	onRemove,
}: {
	rule: FirewallRule;
	index: number;
	count: number;
	onChange: (rule: FirewallRule) => void;
	onMove: (offset: -1 | 1) => void;
	onRemove: () => void;
}) => {
	const set = (patch: Partial<FirewallRule>) => onChange({ ...rule, ...patch });
	const peer = rule.peer.type === "object" ? rule.peer.object : "addresses";
	const error = ruleError(rule);
	const where = rule.direction === "outbound" ? "To" : "From";
	return (
		<div className="grid gap-2 rounded-lg border p-3">
			<div className="flex items-center justify-between gap-2">
				<span className="text-xs font-medium text-muted-foreground">
					Rule {index + 1}
				</span>
				<div className="flex gap-1">
					<Button
						type="button"
						size="icon"
						variant="ghost"
						className="size-7"
						aria-label="Move up"
						disabled={index === 0}
						onClick={() => onMove(-1)}
					>
						<ArrowUp className="size-3.5" />
					</Button>
					<Button
						type="button"
						size="icon"
						variant="ghost"
						className="size-7"
						aria-label="Move down"
						disabled={index === count - 1}
						onClick={() => onMove(1)}
					>
						<ArrowDown className="size-3.5" />
					</Button>
					<Button
						type="button"
						size="icon"
						variant="ghost"
						className="size-7 text-destructive"
						aria-label="Remove rule"
						onClick={onRemove}
					>
						<Trash2 className="size-3.5" />
					</Button>
				</div>
			</div>
			<div className="grid gap-2 sm:grid-cols-[7rem_7rem_1fr]">
				<Select
					value={rule.action}
					onValueChange={(action) =>
						set({ action: action as FirewallRule["action"] })
					}
				>
					<SelectTrigger aria-label="Action">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="allow">Allow</SelectItem>
						<SelectItem value="deny">Deny</SelectItem>
					</SelectContent>
				</Select>
				<Select
					value={rule.protocol}
					onValueChange={(protocol) =>
						set({
							protocol: protocol as FirewallRule["protocol"],
							ports: protocol === "icmp" ? null : rule.ports,
						})
					}
				>
					<SelectTrigger aria-label="Protocol">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="any">TCP + UDP</SelectItem>
						<SelectItem value="tcp">TCP</SelectItem>
						<SelectItem value="udp">UDP</SelectItem>
						<SelectItem value="icmp">ICMP</SelectItem>
					</SelectContent>
				</Select>
				<Input
					aria-label="Ports"
					placeholder={
						rule.protocol === "icmp"
							? "No ports"
							: "All ports, or 443, 8000-9000"
					}
					disabled={rule.protocol === "icmp"}
					value={rule.ports ?? ""}
					onChange={(event) => set({ ports: event.target.value || null })}
				/>
			</div>
			<div className="grid gap-2 sm:grid-cols-[7rem_1fr]">
				<Label className="self-center text-xs text-muted-foreground">
					{where}
				</Label>
				<Select
					value={peer}
					onValueChange={(value) =>
						set({
							peer:
								value === "addresses"
									? { type: "addresses", addresses: [] }
									: {
											type: "object",
											object: value as (typeof FIREWALL_OBJECTS)[number],
										},
						})
					}
				>
					<SelectTrigger aria-label={where}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{FIREWALL_OBJECTS.map((object) => (
							<SelectItem key={object} value={object}>
								{FIREWALL_OBJECT_LABELS[object]}
							</SelectItem>
						))}
						<SelectItem value="addresses">Addresses or networks…</SelectItem>
					</SelectContent>
				</Select>
			</div>
			{rule.peer.type === "addresses" && (
				<AddressesInput
					id={`${rule.id}-addresses`}
					value={rule.peer.addresses}
					onChange={(addresses) =>
						set({ peer: { type: "addresses", addresses } })
					}
				/>
			)}
			<Input
				aria-label="Description"
				placeholder="Description (optional)"
				value={rule.description ?? ""}
				onChange={(event) => set({ description: event.target.value || null })}
			/>
			{error && <p className="text-xs text-destructive">{error}</p>}
		</div>
	);
};

/** Rules of one direction, in order: the first matching rule decides. */
export const DirectionEditor = ({
	direction,
	policy,
	onPolicyChange,
	rules,
	onRulesChange,
}: {
	direction: Direction;
	policy: FirewallPolicy;
	onPolicyChange: (policy: FirewallPolicy) => void;
	/** Every rule of the firewall: the editor changes this direction's only. */
	rules: FirewallRule[];
	onRulesChange: (rules: FirewallRule[]) => void;
}) => {
	const mine = rules.filter((rule) => rule.direction === direction);
	const others = rules.filter((rule) => rule.direction !== direction);
	const commit = (next: FirewallRule[]) => onRulesChange([...others, ...next]);
	const move = (index: number, offset: -1 | 1) => {
		const next = [...mine];
		const [rule] = next.splice(index, 1);
		if (rule) next.splice(index + offset, 0, rule);
		commit(next);
	};
	const add = () =>
		commit([
			...mine,
			{
				id: newRuleId(),
				direction,
				action: "allow",
				protocol: "tcp",
				ports: "443",
				peer: { type: "object", object: "internet" },
				description: null,
			},
		]);
	return (
		<div className="grid gap-3">
			<div className="grid gap-2 sm:grid-cols-[1fr_14rem] sm:items-center">
				<Label htmlFor={`${direction}-policy`} className="font-normal">
					Traffic no rule matches
				</Label>
				<Select
					value={policy}
					onValueChange={(value) => onPolicyChange(value as FirewallPolicy)}
				>
					<SelectTrigger id={`${direction}-policy`}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="allow">Allowed</SelectItem>
						<SelectItem value="deny">Denied</SelectItem>
					</SelectContent>
				</Select>
			</div>
			{mine.map((rule, index) => (
				<RuleRow
					key={rule.id}
					rule={rule}
					index={index}
					count={mine.length}
					onChange={(changed) =>
						commit(mine.map((item) => (item.id === rule.id ? changed : item)))
					}
					onMove={(offset) => move(index, offset)}
					onRemove={() => commit(mine.filter((item) => item.id !== rule.id))}
				/>
			))}
			<Button type="button" variant="outline" size="sm" onClick={add}>
				<Plus className="size-4" />
				Add a rule
			</Button>
			<p className="text-xs text-muted-foreground">
				Rules are checked in order: the first one that matches decides. Loopback
				and DNS always pass, so names still resolve.
			</p>
		</div>
	);
};
