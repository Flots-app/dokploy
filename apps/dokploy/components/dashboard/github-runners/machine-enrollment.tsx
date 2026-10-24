import { MACHINE_NAME } from "@dokploy/server/utils/github-runners/setup-constants";
import { Download, Loader2, ShieldCheck } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, type RouterOutputs } from "@/utils/api";
import { CheckList } from "./add-machine";
import { BudgetFields } from "./budget-fields";
import { type BudgetValues, defaultBudget, parseLabels } from "./budget-values";
import { downloadScript, readSetupCode } from "./enrollment-code";
import { errorText, type RunnerMachine } from "./format";
import { Step } from "./pool-access";
import { CopyCode } from "./shared";

type CheckResult = RouterOutputs["githubRunner"]["completeEnrollment"];

interface Enrolling {
	id: string;
	name: string;
	platform: "linux" | "macos";
}

/** Step 1: what the machine is; Dokploy then generates its key and script. */
const DescribeStep = ({
	poolId,
	onStarted,
}: {
	poolId: string;
	onStarted: (enrolling: Enrolling) => void;
}) => {
	const utils = api.useUtils();
	const start = api.githubRunner.startEnrollment.useMutation();
	const [name, setName] = useState("");
	const [platform, setPlatform] = useState<"linux" | "macos">("macos");
	const [keepAwake, setKeepAwake] = useState(true);
	const onStart = async () => {
		try {
			const { node, ...script } = await start.mutateAsync({
				githubRunnerPoolId: poolId,
				name,
				platform,
				keepAwake,
			});
			utils.githubRunner.setupScript.setData(
				{ githubRunnerNodeId: node.githubRunnerNodeId },
				script,
			);
			await utils.githubRunner.overview.invalidate();
			onStarted({ id: node.githubRunnerNodeId, name: node.name, platform });
		} catch (error) {
			toast.error(errorText(error, "Unable to start the setup"));
		}
	};
	return (
		<Step number={1} title="The machine">
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-2">
					<Label htmlFor="enroll-name">Name</Label>
					<Input
						id="enroll-name"
						placeholder="m6"
						value={name}
						onChange={(event) => setName(event.target.value.toLowerCase())}
					/>
					{name && !MACHINE_NAME.test(name) && (
						<p className="text-xs text-destructive">
							Lowercase letters, digits and hyphens, 24 characters at most.
						</p>
					)}
				</div>
				<div className="space-y-2">
					<Label htmlFor="enroll-platform">Platform</Label>
					<Select
						value={platform}
						onValueChange={(value) => setPlatform(value as "linux" | "macos")}
					>
						<SelectTrigger id="enroll-platform">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="macos">Mac</SelectItem>
							<SelectItem value="linux">Linux machine or VM</SelectItem>
						</SelectContent>
					</Select>
				</div>
			</div>
			{platform === "macos" && (
				<div className="flex items-start justify-between gap-4 rounded-lg border p-3">
					<div className="space-y-1">
						<Label htmlFor="enroll-awake">Keep the Mac awake</Label>
						<p className="text-xs text-muted-foreground">
							No system sleep (the display still sleeps) and a restart after a
							power loss, so its runners stay available.
						</p>
					</div>
					<Switch
						id="enroll-awake"
						checked={keepAwake}
						onCheckedChange={setKeepAwake}
					/>
				</div>
			)}
			<Button
				onClick={() => void onStart()}
				disabled={!MACHINE_NAME.test(name) || start.isPending}
				className="w-fit"
			>
				{start.isPending && <Loader2 className="size-4 animate-spin" />}
				Generate its setup script
			</Button>
		</Step>
	);
};

/** Step 2: the script to run once on the machine, as an administrator. */
const ScriptStep = ({ enrolling }: { enrolling: Enrolling }) => {
	const { data, error } = api.githubRunner.setupScript.useQuery(
		{ githubRunnerNodeId: enrolling.id },
		{ staleTime: Number.POSITIVE_INFINITY },
	);
	return (
		<Step
			number={2}
			title="Run the script on the machine, once"
			description={
				enrolling.platform === "macos"
					? "It creates the dokploy-manager account (no admin rights), lets it log in over SSH with its own key only, keeps the Mac awake and starts the runner VM after a reboot."
					: "It creates the dokploy-manager account (root through sudo, the machine is dedicated to the runners) and lets it log in over SSH with its own key only."
			}
		>
			{error && <AlertBlock type="error">{errorText(error)}</AlertBlock>}
			{!data && !error && (
				<Loader2 className="size-4 animate-spin text-muted-foreground" />
			)}
			{data && (
				<>
					<Button
						type="button"
						variant="outline"
						className="w-fit"
						onClick={() => downloadScript(data.fileName, data.script)}
					>
						<Download className="size-4" />
						Download {data.fileName}
					</Button>
					<div className="grid gap-1.5 text-sm text-muted-foreground">
						<span>In a terminal on the machine:</span>
						<CopyCode code={`sudo bash ~/Downloads/${data.fileName}`} />
						<span>
							or from another computer, through an administrator account:
						</span>
						<CopyCode
							code={`ssh admin@machine 'sudo bash -s' < ${data.fileName}`}
						/>
					</div>
					<p className="text-xs text-muted-foreground">
						SHA-256 of the script:{" "}
						<code className="break-all">{data.sha256}</code> · key of the
						machine: <code className="break-all">{data.keyFingerprint}</code>.
						Running it again is safe.
					</p>
				</>
			)}
		</Step>
	);
};

/** Where Dokploy connects: an address the code lists, or one typed in, and a port. */
const useSetupTarget = (code: string) => {
	const [selected, setSelected] = useState("");
	const [custom, setCustom] = useState("");
	const [port, setPort] = useState("");
	const parsed = readSetupCode(code);
	const hosts = parsed?.hosts ?? [];
	const listed = hosts.includes(selected) ? selected : (hosts[0] ?? "");
	const targetPort = port ? Number(port) : (parsed?.port ?? 22);
	return {
		parsed,
		hosts,
		listed,
		setSelected,
		custom,
		setCustom,
		port,
		setPort,
		host: custom || listed,
		targetPort,
		portValid:
			Number.isInteger(targetPort) && targetPort > 0 && targetPort < 65536,
	};
};

type SetupTarget = ReturnType<typeof useSetupTarget>;

const ListedAddresses = ({ target }: { target: SetupTarget }) => (
	<div className="space-y-2">
		<Label htmlFor="enroll-listed">Dokploy reaches it at</Label>
		<Select
			value={target.listed}
			onValueChange={target.setSelected}
			disabled={Boolean(target.custom)}
		>
			<SelectTrigger id="enroll-listed">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{target.hosts.map((item) => (
					<SelectItem key={item} value={item}>
						{item}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	</div>
);

const AddressFields = ({
	target,
	defaultPort,
}: {
	target: SetupTarget;
	defaultPort: number;
}) => {
	const listed = target.hosts.length > 0;
	return (
		<div className="grid gap-2 sm:grid-cols-[1fr_1fr_6rem]">
			{listed && <ListedAddresses target={target} />}
			<div className="space-y-2">
				<Label htmlFor="enroll-host">
					{listed ? "Or another address" : "Address"}
				</Label>
				<Input
					id="enroll-host"
					placeholder="m6.tailnet.ts.net"
					value={target.custom}
					onChange={(event) => target.setCustom(event.target.value.trim())}
				/>
			</div>
			<div className="space-y-2">
				<Label htmlFor="enroll-port">Port</Label>
				<Input
					id="enroll-port"
					inputMode="numeric"
					placeholder={String(defaultPort)}
					value={target.port}
					onChange={(event) =>
						target.setPort(event.target.value.replace(/\D/g, ""))
					}
				/>
			</div>
			<p className="text-xs text-muted-foreground sm:col-span-3">
				A Tailscale address comes first when the machine has one: it reaches the
				machine wherever it is, without opening a port. Dokploy only connects if
				the machine shows one of the host keys in the code.
			</p>
		</div>
	);
};

/** Step 3: the code the script printed; the host key must be one it lists. */
const CodeStep = ({
	enrolling,
	onChecked,
}: {
	enrolling: Enrolling;
	onChecked: (result: CheckResult) => void;
}) => {
	const complete = api.githubRunner.completeEnrollment.useMutation();
	const [code, setCode] = useState("");
	const target = useSetupTarget(code);
	const ready = Boolean(target.parsed && target.host && target.portValid);
	const onCheck = async () => {
		try {
			onChecked(
				await complete.mutateAsync({
					githubRunnerNodeId: enrolling.id,
					code,
					host: target.host,
					port: target.targetPort,
				}),
			);
		} catch {
			// Shown below.
		}
	};
	return (
		<Step number={3} title="Paste the code it printed">
			<Textarea
				rows={3}
				spellCheck={false}
				className="field-sizing-fixed h-24 resize-none break-all font-mono text-xs md:text-xs"
				placeholder="dokploy-runner-setup:…"
				value={code}
				onChange={(event) => setCode(event.target.value)}
			/>
			{target.parsed && (
				<AddressFields target={target} defaultPort={target.parsed.port} />
			)}
			{complete.error && (
				<AlertBlock type="error">{errorText(complete.error)}</AlertBlock>
			)}
			<Button
				onClick={() => void onCheck()}
				disabled={!ready || complete.isPending}
				className="w-fit"
			>
				{complete.isPending && <Loader2 className="size-4 animate-spin" />}
				Check the machine
			</Button>
		</Step>
	);
};

/** Step 4: what Dokploy found, the budget, then provisioning. */
const FinishStep = ({
	enrolling,
	result,
	onDone,
}: {
	enrolling: Enrolling;
	result: CheckResult;
	onDone: () => void;
}) => {
	const utils = api.useUtils();
	const finish = api.githubRunner.finishEnrollment.useMutation();
	const [budget, setBudget] = useState<BudgetValues>(defaultBudget);
	const onFinish = async () => {
		try {
			await finish.mutateAsync({
				githubRunnerNodeId: enrolling.id,
				cpuPercent: budget.cpuPercent,
				memoryPercent: budget.memoryPercent,
				diskReserveGb: budget.diskReserveGb,
				diskCleanupGb: budget.diskCleanupGb,
				maxRunners: budget.maxRunners,
				vmDiskGb: budget.vmDiskGb,
				extraLabels: parseLabels(budget.extraLabels),
			});
			await utils.githubRunner.overview.invalidate();
			toast.success(`${enrolling.name} added: provisioning started`);
			onDone();
		} catch (error) {
			toast.error(errorText(error, "Unable to add the machine"));
		}
	};
	return (
		<Step number={4} title="How much of it the runners get">
			<p className="flex items-center gap-2 text-sm text-muted-foreground">
				<ShieldCheck className="size-4 text-emerald-500" />
				Host key <code className="break-all">{result.fingerprint}</code>,
				verified against the setup code.
			</p>
			<CheckList result={result} />
			{result.host && (
				<BudgetFields
					platform={enrolling.platform}
					host={result.host}
					value={budget}
					onChange={setBudget}
				/>
			)}
			<DialogFooter>
				<Button
					onClick={() => void onFinish()}
					disabled={!result.canProvision || finish.isPending}
				>
					{finish.isPending && <Loader2 className="size-4 animate-spin" />}
					Add and provision
				</Button>
			</DialogFooter>
		</Step>
	);
};

/**
 * Setup with a script: the recommended way. A machine left halfway (dialog
 * closed) waits in the pool and resumes here at step 2.
 */
export const EnrollMachine = ({
	poolId,
	resume,
	onDone,
}: {
	poolId: string;
	resume?: RunnerMachine;
	onDone: () => void;
}) => {
	const [enrolling, setEnrolling] = useState<Enrolling | null>(
		resume
			? {
					id: resume.githubRunnerNodeId,
					name: resume.name,
					platform: resume.platform,
				}
			: null,
	);
	const [result, setResult] = useState<CheckResult | null>(null);
	if (!enrolling) {
		return <DescribeStep poolId={poolId} onStarted={setEnrolling} />;
	}
	return (
		<div className="grid gap-6">
			<ScriptStep enrolling={enrolling} />
			<CodeStep enrolling={enrolling} onChecked={setResult} />
			{result && (
				<FinishStep enrolling={enrolling} result={result} onDone={onDone} />
			)}
		</div>
	);
};

/** Picks up the setup of a machine still waiting for its script to run. */
export const ContinueEnrollmentDialog = ({
	machine,
	open,
	onOpenChange,
}: {
	machine: RunnerMachine;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) => (
	<Dialog open={open} onOpenChange={onOpenChange}>
		<DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
			<DialogHeader>
				<DialogTitle>Finish the setup of {machine.name}</DialogTitle>
				<DialogDescription>
					Dokploy connects as dokploy-manager with a key of its own, and only to
					the host keys the script reports.
				</DialogDescription>
			</DialogHeader>
			{open && (
				<EnrollMachine
					poolId={machine.githubRunnerPoolId}
					resume={machine}
					onDone={() => onOpenChange(false)}
				/>
			)}
		</DialogContent>
	</Dialog>
);
