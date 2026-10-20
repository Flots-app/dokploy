import {
	AlertTriangle,
	CheckCircle2,
	CircleX,
	KeyRound,
	Loader2,
	PlusIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, type RouterOutputs } from "@/utils/api";
import { BudgetFields } from "./budget-fields";
import { type BudgetValues, defaultBudget, parseLabels } from "./budget-values";
import { formatBytes, formatCpus } from "./format";
import { EnrollMachine } from "./machine-enrollment";
import { GenerateKeyButton, MachinePrep } from "./machine-setup";

type CheckResult = RouterOutputs["githubRunner"]["checkMachine"];

interface Connection {
	name: string;
	platform: "linux" | "macos";
	host: string;
	port: number;
	username: string;
	sshKeyId: string;
	vmName: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;

const CheckIcon = ({ status }: { status: string }) =>
	status === "pass" ? (
		<CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
	) : status === "warn" ? (
		<AlertTriangle className="size-4 shrink-0 text-orange-500" />
	) : (
		<CircleX className="size-4 shrink-0 text-red-500" />
	);

export const CheckList = ({ result }: { result: CheckResult }) => (
	<ul className="grid gap-2">
		{result.checks.map((check) => (
			<li key={check.id} className="flex gap-2 text-sm">
				<CheckIcon status={check.status} />
				<span>
					<span className="font-medium">{check.label}: </span>
					<span className="text-muted-foreground">{check.message}</span>
				</span>
			</li>
		))}
	</ul>
);

const ConnectionFields = ({
	value,
	onChange,
}: {
	value: Connection;
	onChange: (value: Connection) => void;
}) => {
	const { data: sshKeys } = api.sshKey.all.useQuery();
	const set = (patch: Partial<Connection>) => onChange({ ...value, ...patch });
	return (
		<>
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-2">
					<Label htmlFor="machine-name">Name</Label>
					<Input
						id="machine-name"
						placeholder="m6"
						value={value.name}
						onChange={(event) =>
							set({ name: event.target.value.toLowerCase() })
						}
					/>
					{value.name && !NAME.test(value.name) && (
						<p className="text-xs text-destructive">
							Lowercase letters, digits and hyphens, 24 characters at most.
						</p>
					)}
				</div>
				<div className="space-y-2">
					<Label htmlFor="machine-platform">Platform</Label>
					<Select
						value={value.platform}
						onValueChange={(platform) =>
							set({
								platform: platform as Connection["platform"],
								username:
									value.username || (platform === "linux" ? "root" : ""),
							})
						}
					>
						<SelectTrigger id="machine-platform">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="macos">Mac (Lima VM)</SelectItem>
							<SelectItem value="linux">Linux machine or VM</SelectItem>
						</SelectContent>
					</Select>
				</div>
				<div className="space-y-2">
					<Label htmlFor="machine-host">Host</Label>
					<Input
						id="machine-host"
						placeholder="192.168.1.20 or m6.tailnet.ts.net"
						value={value.host}
						onChange={(event) => set({ host: event.target.value })}
					/>
				</div>
				<div className="grid grid-cols-[1fr_6rem] gap-2">
					<div className="space-y-2">
						<Label htmlFor="machine-user">SSH user</Label>
						<Input
							id="machine-user"
							placeholder={
								value.platform === "macos" ? "your macOS user" : "root"
							}
							value={value.username}
							onChange={(event) => set({ username: event.target.value })}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="machine-port">Port</Label>
						<Input
							id="machine-port"
							type="number"
							value={value.port}
							onChange={(event) =>
								set({ port: Number(event.target.value) || 22 })
							}
						/>
					</div>
				</div>
				<div className="space-y-2">
					<Label htmlFor="machine-ssh-key">SSH key</Label>
					<Select
						value={value.sshKeyId}
						onValueChange={(sshKeyId) => set({ sshKeyId })}
					>
						<SelectTrigger id="machine-ssh-key">
							<SelectValue placeholder="Select a key" />
						</SelectTrigger>
						<SelectContent>
							{sshKeys?.map((key) => (
								<SelectItem key={key.sshKeyId} value={key.sshKeyId}>
									{key.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
						<GenerateKeyButton onCreated={(sshKeyId) => set({ sshKeyId })} />
						{sshKeys?.length === 0 ? (
							"No key yet: generate one for the runner machines."
						) : (
							<Link
								href="/dashboard/settings/ssh-keys"
								className="text-primary"
							>
								Manage keys
							</Link>
						)}
					</div>
				</div>
				{value.platform === "macos" && (
					<div className="space-y-2">
						<Label htmlFor="machine-vm">VM name</Label>
						<Input
							id="machine-vm"
							value={value.vmName}
							onChange={(event) =>
								set({ vmName: event.target.value.toLowerCase() })
							}
						/>
						<p className="text-xs text-muted-foreground">
							An existing VM with this name is adopted, never deleted.
						</p>
					</div>
				)}
			</div>
			<MachinePrep
				platform={value.platform}
				publicKey={
					sshKeys?.find((key) => key.sshKeyId === value.sshKeyId)?.publicKey ??
					null
				}
				username={value.username}
			/>
		</>
	);
};

const CheckOutcome = ({
	result,
	host,
	platform,
	acceptedKey,
	onAcceptKey,
	budget,
	onBudgetChange,
}: {
	result: CheckResult;
	host: string;
	platform: Connection["platform"];
	acceptedKey: boolean;
	onAcceptKey: (accepted: boolean) => void;
	budget: BudgetValues;
	onBudgetChange: (budget: BudgetValues) => void;
}) => (
	<div className="grid gap-4 rounded-lg border p-4">
		<CheckList result={result} />
		<div className="flex items-start gap-3 rounded-md bg-muted p-3 text-sm">
			<KeyRound className="mt-0.5 size-4 shrink-0" />
			<div className="space-y-2">
				<p>
					Host key <code className="break-all">{result.fingerprint}</code>
				</p>
				<p className="text-xs text-muted-foreground">
					Dokploy will refuse any other key for this machine. Compare it with{" "}
					<code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> on the
					machine.
				</p>
				<label className="flex items-center gap-2 text-xs">
					<input
						type="checkbox"
						checked={acceptedKey}
						onChange={(event) => onAcceptKey(event.target.checked)}
					/>
					This is the key of {host}
				</label>
			</div>
		</div>
		{result.host && (
			<>
				<p className="text-sm text-muted-foreground">
					{result.host.os} · {result.host.arch} · {formatCpus(result.host.cpus)}{" "}
					· {formatBytes(result.host.memoryBytes)}
				</p>
				<BudgetFields
					platform={platform}
					host={result.host}
					value={budget}
					onChange={onBudgetChange}
				/>
			</>
		)}
	</div>
);

const connectionKey = (connection: Connection) =>
	JSON.stringify([
		connection.platform,
		connection.host.trim(),
		connection.port,
		connection.username.trim(),
		connection.sshKeyId,
		connection.vmName,
	]);

/** Mounted only while the dialog is open, so each opening starts afresh. */
const isConnectionReady = (connection: Connection) =>
	NAME.test(connection.name) &&
	Boolean(connection.host.trim()) &&
	Boolean(connection.username.trim()) &&
	Boolean(connection.sshKeyId) &&
	connection.port > 0;

const connectionInput = (connection: Connection) => ({
	host: connection.host.trim(),
	port: connection.port,
	username: connection.username.trim(),
	sshKeyId: connection.sshKeyId,
	platform: connection.platform,
	vmName: connection.vmName,
});

const budgetInput = (budget: BudgetValues) => ({
	cpuPercent: budget.cpuPercent,
	memoryPercent: budget.memoryPercent,
	diskReserveGb: budget.diskReserveGb,
	diskCleanupGb: budget.diskCleanupGb,
	maxRunners: budget.maxRunners,
	vmDiskGb: budget.vmDiskGb,
});

const ErrorBlock = ({ error }: { error: { message: string } | null }) =>
	error ? <AlertBlock type="error">{error.message}</AlertBlock> : null;

const PendingButton = ({
	pending,
	children,
	...props
}: React.ComponentProps<typeof Button> & { pending: boolean }) => (
	<Button {...props}>
		{pending && <Loader2 className="size-4 animate-spin" />}
		{children}
	</Button>
);

/** Mounted only while the dialog is open, so each opening starts afresh. */
const AddMachineForm = ({
	poolId,
	onDone,
}: {
	poolId: string;
	onDone: () => void;
}) => {
	const utils = api.useUtils();
	const check = api.githubRunner.checkMachine.useMutation();
	const create = api.githubRunner.createMachine.useMutation();
	const [connection, setConnection] = useState<Connection>({
		name: "",
		platform: "macos",
		host: "",
		port: 22,
		username: "",
		sshKeyId: "",
		vmName: "dokploy-runners",
	});
	const [budget, setBudget] = useState<BudgetValues>(defaultBudget);
	const [checkedKey, setCheckedKey] = useState<string | null>(null);
	const [acceptedFingerprint, setAcceptedFingerprint] = useState<string | null>(
		null,
	);

	// Checks only hold for the connection they ran against.
	const result =
		checkedKey === connectionKey(connection) ? (check.data ?? null) : null;
	const acceptedKey = acceptedFingerprint === result?.fingerprint;
	const canCreate = Boolean(result?.canProvision) && acceptedKey;

	const runChecks = () => {
		setCheckedKey(connectionKey(connection));
		check
			.mutateAsync({
				...connectionInput(connection),
				...budgetInput(budget),
				githubRunnerNodeId: null,
			})
			.catch(() => undefined);
	};

	const onCreate = async () => {
		if (!result) return;
		try {
			await create.mutateAsync({
				...connectionInput(connection),
				...budgetInput(budget),
				githubRunnerPoolId: poolId,
				name: connection.name,
				description: null,
				hostKeyFingerprint: result.fingerprint,
				extraLabels: parseLabels(budget.extraLabels),
			});
			await utils.githubRunner.overview.invalidate();
			toast.success(`${connection.name} added: provisioning started`);
			onDone();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Unable to add the machine",
			);
		}
	};

	return (
		<>
			<ConnectionFields value={connection} onChange={setConnection} />
			<PendingButton
				variant="secondary"
				onClick={runChecks}
				pending={check.isPending}
				disabled={!isConnectionReady(connection) || check.isPending}
			>
				Run checks
			</PendingButton>
			<ErrorBlock error={check.error} />
			{result && (
				<CheckOutcome
					result={result}
					host={connection.host}
					platform={connection.platform}
					acceptedKey={acceptedKey}
					onAcceptKey={(accepted) =>
						setAcceptedFingerprint(accepted ? result.fingerprint : null)
					}
					budget={budget}
					onBudgetChange={setBudget}
				/>
			)}
			<ErrorBlock error={create.error} />
			<DialogFooter>
				<PendingButton
					onClick={onCreate}
					pending={create.isPending}
					disabled={!canCreate || create.isPending}
				>
					Add and provision
				</PendingButton>
			</DialogFooter>
		</>
	);
};

export const AddMachine = ({ poolId }: { poolId: string }) => {
	const [open, setOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="outline" size="sm">
					<PlusIcon className="size-4" />
					Add machine
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Add a runner machine</DialogTitle>
					<DialogDescription>
						A Mac runs the jobs in a Lima VM sized to the budget; a Linux
						machine runs them in a systemd slice. Dokploy reaches it over SSH
						and installs everything.
					</DialogDescription>
				</DialogHeader>
				<Tabs defaultValue="script">
					<TabsList>
						<TabsTrigger value="script">Setup script (recommended)</TabsTrigger>
						<TabsTrigger value="ssh">Existing SSH access</TabsTrigger>
					</TabsList>
					<TabsContent value="script" className="grid gap-6 pt-4">
						<p className="text-sm text-muted-foreground">
							Run one script on the machine as an administrator: it creates a
							dedicated account without admin rights, which only Dokploy's own
							key for this machine can log into. No password is shared.
						</p>
						<EnrollMachine poolId={poolId} onDone={() => setOpen(false)} />
					</TabsContent>
					<TabsContent value="ssh" className="grid gap-4 pt-4">
						<AddMachineForm poolId={poolId} onDone={() => setOpen(false)} />
					</TabsContent>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
};
