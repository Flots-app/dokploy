import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";
import { errorText } from "./format";
import { CopyCode } from "./shared";

/** Creates the SSH key Dokploy uses to reach the runner machines, in one click. */
export const GenerateKeyButton = ({
	onCreated,
}: {
	onCreated: (sshKeyId: string) => void;
}) => {
	const utils = api.useUtils();
	const generate = api.sshKey.generate.useMutation();
	const create = api.sshKey.create.useMutation();
	const pending = generate.isPending || create.isPending;
	const onClick = async () => {
		try {
			const pair = await generate.mutateAsync({ type: "ed25519" });
			await create.mutateAsync({
				name: "GitHub runners",
				description: "Dokploy reaches the GitHub runner machines with it",
				privateKey: pair.privateKey,
				publicKey: pair.publicKey,
				organizationId: "",
			});
			await utils.sshKey.all.invalidate();
			const keys = await utils.sshKey.all.fetch();
			const key = keys.find(
				(item) => item.publicKey.trim() === pair.publicKey.trim(),
			);
			if (key) onCreated(key.sshKeyId);
			toast.success("Key created: authorize it on the machine (step below)");
		} catch (error) {
			toast.error(errorText(error, "Unable to create the key"));
		}
	};
	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			onClick={() => void onClick()}
			disabled={pending}
		>
			{pending ? (
				<Loader2 className="size-4 animate-spin" />
			) : (
				<KeyRound className="size-4" />
			)}
			Generate a key
		</Button>
	);
};

/** What to do on the machine before Dokploy can reach it, ready to copy. */
export const MachinePrep = ({
	platform,
	publicKey,
	username,
}: {
	platform: "linux" | "macos";
	publicKey: string | null;
	username: string;
}) => {
	const authorize = publicKey
		? `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${publicKey.trim()}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`
		: null;
	return (
		<div className="grid gap-2 rounded-lg border p-3 text-sm">
			<p className="font-medium">
				Prepare the {platform === "macos" ? "Mac" : "machine"}
			</p>
			<ol className="grid list-decimal gap-2 pl-4 text-muted-foreground marker:text-foreground">
				{platform === "macos" ? (
					<>
						<li>
							Turn on <strong>Remote Login</strong> in System Settings → General
							→ Sharing. The SSH user is your macOS account (<code>whoami</code>
							); no sudo is needed.
						</li>
						<li className="space-y-1">
							Install Lima with Homebrew:
							<CopyCode code="brew install lima" />
						</li>
					</>
				) : (
					<li>
						Use a machine dedicated to the runners, with systemd (Ubuntu,
						Debian…). Connect as <strong>root</strong> or a user with
						passwordless sudo: Dokploy installs Docker and everything else.
					</li>
				)}
				<li className="space-y-1">
					{authorize ? (
						<>
							Authorize Dokploy's key
							{username.trim() ? ` as ${username.trim()}` : ""}, in a terminal
							on the machine:
							<CopyCode code={authorize} />
						</>
					) : (
						"Select or generate an SSH key above: its authorization command shows up here."
					)}
				</li>
				<li>
					Then <strong>Run checks</strong>: Dokploy tells you what is missing,
					if anything.
				</li>
			</ol>
		</div>
	);
};
