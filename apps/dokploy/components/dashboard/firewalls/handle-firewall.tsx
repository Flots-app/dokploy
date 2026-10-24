import {
	FIREWALL_TEMPLATES,
	type FirewallPolicy,
	type FirewallRule,
} from "@dokploy/server/utils/firewall/rules";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, type RouterOutputs } from "@/utils/api";
import { errorText } from "../github-runners/format";
import { DirectionEditor } from "./rule-editor";
import { newRuleId, ruleError } from "./rule-helpers";

export type FirewallRow = RouterOutputs["firewall"]["list"][number];

interface Draft {
	name: string;
	description: string;
	inboundPolicy: FirewallPolicy;
	outboundPolicy: FirewallPolicy;
	rules: FirewallRule[];
}

const fromTemplate = (id: string): Draft => {
	const template =
		FIREWALL_TEMPLATES.find((item) => item.id === id) ?? FIREWALL_TEMPLATES[0];
	return {
		name: template?.name ?? "",
		description: template?.description ?? "",
		inboundPolicy: template?.inboundPolicy ?? "allow",
		outboundPolicy: template?.outboundPolicy ?? "allow",
		rules: (template?.rules ?? []).map((rule) => ({
			...rule,
			id: newRuleId(),
		})),
	};
};

const fromFirewall = (firewall: FirewallRow): Draft => ({
	name: firewall.name,
	description: firewall.description ?? "",
	inboundPolicy: firewall.inboundPolicy,
	outboundPolicy: firewall.outboundPolicy,
	rules: firewall.rules,
});

const TemplatePicker = ({ onPick }: { onPick: (id: string) => void }) => (
	<div className="grid gap-2">
		<Label>Start from</Label>
		<div className="grid gap-2 sm:grid-cols-3">
			{FIREWALL_TEMPLATES.map((template) => (
				<button
					key={template.id}
					type="button"
					className="rounded-lg border p-3 text-left text-sm transition-colors hover:bg-muted"
					onClick={() => onPick(template.id)}
				>
					<span className="font-medium">{template.name}</span>
					<span className="mt-1 block text-xs text-muted-foreground">
						{template.description}
					</span>
				</button>
			))}
		</div>
	</div>
);

const FirewallForm = ({
	firewall,
	onDone,
}: {
	firewall: FirewallRow | null;
	onDone: () => void;
}) => {
	const utils = api.useUtils();
	const create = api.firewall.create.useMutation();
	const update = api.firewall.update.useMutation();
	const [draft, setDraft] = useState<Draft>(() =>
		firewall ? fromFirewall(firewall) : fromTemplate("internet-only"),
	);
	const set = (patch: Partial<Draft>) =>
		setDraft((current) => ({ ...current, ...patch }));
	const invalid =
		!draft.name.trim() || draft.rules.some((rule) => ruleError(rule));
	const pending = create.isPending || update.isPending;

	const save = async () => {
		const input = {
			name: draft.name.trim(),
			description: draft.description.trim() || null,
			inboundPolicy: draft.inboundPolicy,
			outboundPolicy: draft.outboundPolicy,
			rules: draft.rules,
		};
		try {
			if (firewall) {
				await update.mutateAsync({ ...input, firewallId: firewall.firewallId });
			} else {
				await create.mutateAsync(input);
			}
			await Promise.all([
				utils.firewall.list.invalidate(),
				utils.githubRunner.overview.invalidate(),
			]);
			toast.success(
				firewall
					? `Firewall ${input.name} saved: the machines behind it load the new rules`
					: `Firewall ${input.name} created`,
			);
			onDone();
		} catch (error) {
			toast.error(errorText(error, "The firewall could not be saved"));
		}
	};

	return (
		<>
			<div className="grid max-h-[65vh] gap-4 overflow-y-auto pr-1">
				{!firewall && (
					<TemplatePicker onPick={(id) => setDraft(fromTemplate(id))} />
				)}
				<div className="grid gap-2">
					<Label htmlFor="firewall-name">Name</Label>
					<Input
						id="firewall-name"
						value={draft.name}
						maxLength={64}
						onChange={(event) => set({ name: event.target.value })}
					/>
				</div>
				<div className="grid gap-2">
					<Label htmlFor="firewall-description">Description</Label>
					<Textarea
						id="firewall-description"
						rows={2}
						maxLength={500}
						value={draft.description}
						onChange={(event) => set({ description: event.target.value })}
					/>
				</div>
				<Tabs defaultValue="outbound">
					<TabsList>
						<TabsTrigger value="outbound">Outbound</TabsTrigger>
						<TabsTrigger value="inbound">Inbound</TabsTrigger>
					</TabsList>
					<TabsContent value="outbound" className="pt-2">
						<DirectionEditor
							direction="outbound"
							policy={draft.outboundPolicy}
							onPolicyChange={(outboundPolicy) => set({ outboundPolicy })}
							rules={draft.rules}
							onRulesChange={(rules) => set({ rules })}
						/>
					</TabsContent>
					<TabsContent value="inbound" className="pt-2">
						<DirectionEditor
							direction="inbound"
							policy={draft.inboundPolicy}
							onPolicyChange={(inboundPolicy) => set({ inboundPolicy })}
							rules={draft.rules}
							onRulesChange={(rules) => set({ rules })}
						/>
						<p className="mt-2 text-xs text-muted-foreground">
							GitHub runner jobs take no connection from the network: inbound
							rules apply to resources that do, such as servers.
						</p>
					</TabsContent>
				</Tabs>
			</div>
			<DialogFooter>
				<Button variant="outline" onClick={onDone}>
					Cancel
				</Button>
				<Button onClick={save} disabled={invalid || pending}>
					{pending && <Loader2 className="size-4 animate-spin" />}
					{firewall ? "Save" : "Create"}
				</Button>
			</DialogFooter>
		</>
	);
};

export const HandleFirewall = ({
	firewall,
	open,
	onOpenChange,
}: {
	firewall: FirewallRow | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) => (
	<Dialog open={open} onOpenChange={onOpenChange}>
		<DialogContent className="sm:max-w-3xl">
			<DialogHeader>
				<DialogTitle>
					{firewall ? `Edit ${firewall.name}` : "New firewall"}
				</DialogTitle>
				<DialogDescription>
					Ordered rules for each direction, and what happens to the traffic no
					rule matches.
				</DialogDescription>
			</DialogHeader>
			{open && (
				<FirewallForm firewall={firewall} onDone={() => onOpenChange(false)} />
			)}
		</DialogContent>
	</Dialog>
);
