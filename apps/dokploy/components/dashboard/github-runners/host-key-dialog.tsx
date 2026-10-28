import { Loader2 } from "lucide-react";
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
import { api } from "@/utils/api";
import { errorText, type RunnerMachine } from "./format";

/** Mounted only while the dialog is open: the presented key is read afresh. */
const HostKeyForm = ({
	machine,
	onDone,
}: {
	machine: RunnerMachine;
	onDone: () => void;
}) => {
	const read = api.githubRunner.presentedHostKey.useMutation();
	const accept = api.githubRunner.acceptHostKey.useMutation();
	const utils = api.useUtils();
	const presented = read.data?.presented;

	const onTrust = async () => {
		if (!presented) return;
		await accept.mutateAsync({
			githubRunnerNodeId: machine.githubRunnerNodeId,
			fingerprint: presented,
		});
		await utils.githubRunner.overview.invalidate();
		toast.success("Host key accepted");
		onDone();
	};

	return (
		<>
			<p className="break-all text-sm">
				Pinned: <code>{machine.hostKeyFingerprint ?? "none"}</code>
			</p>
			{presented && (
				<p className="break-all text-sm">
					Presented now: <code>{presented}</code>
				</p>
			)}
			{read.error && (
				<AlertBlock type="error">{errorText(read.error)}</AlertBlock>
			)}
			{accept.error && (
				<AlertBlock type="error">{errorText(accept.error)}</AlertBlock>
			)}
			<DialogFooter>
				{!presented ? (
					<Button
						variant="outline"
						disabled={read.isPending}
						onClick={() =>
							read
								.mutateAsync({ githubRunnerNodeId: machine.githubRunnerNodeId })
								.catch(() => undefined)
						}
					>
						{read.isPending && <Loader2 className="size-4 animate-spin" />}
						Read the presented key
					</Button>
				) : (
					<Button
						variant="destructive"
						disabled={
							accept.isPending || presented === machine.hostKeyFingerprint
						}
						onClick={() => onTrust().catch(() => undefined)}
					>
						Trust this key
					</Button>
				)}
			</DialogFooter>
		</>
	);
};

export const HostKeyDialog = ({
	machine,
	open,
	onOpenChange,
}: {
	machine: RunnerMachine;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) => (
	<Dialog open={open} onOpenChange={onOpenChange}>
		<DialogContent className="sm:max-w-lg">
			<DialogHeader>
				<DialogTitle>SSH host key of {machine.name}</DialogTitle>
				<DialogDescription>
					Only accept a new key if you reinstalled the machine or its SSH
					server. A key that changed for no reason may mean someone intercepts
					the connection.
				</DialogDescription>
			</DialogHeader>
			<HostKeyForm machine={machine} onDone={() => onOpenChange(false)} />
		</DialogContent>
	</Dialog>
);
