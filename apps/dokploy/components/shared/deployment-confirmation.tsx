import { useId, useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { isDeploymentConfirmationValid } from "@/utils/deployment-confirmation";

interface Props {
	children: React.ReactNode;
	description?: React.ReactNode;
	disabled?: boolean;
	environmentName: string;
	onConfirm: () => void | Promise<void>;
	requireConfirmation?: boolean;
	title?: React.ReactNode;
}

export const DeploymentConfirmation = ({
	children,
	description,
	disabled,
	environmentName,
	onConfirm,
	requireConfirmation,
	title,
}: Props) => {
	const inputId = useId();
	const [isOpen, setIsOpen] = useState(false);
	const [confirmation, setConfirmation] = useState("");

	const handleOpenChange = (open: boolean) => {
		if (open && requireConfirmation === false) {
			if (!disabled) {
				void onConfirm();
			}
			return;
		}
		if (open && requireConfirmation === undefined) return;

		setIsOpen(open);
		if (!open) {
			setConfirmation("");
		}
	};

	return (
		<AlertDialog open={isOpen} onOpenChange={handleOpenChange}>
			<AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title ?? "Confirm deployment"}</AlertDialogTitle>
					<AlertDialogDescription>
						{description ??
							"This action will deploy the selected service to the environment below."}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<div className="space-y-2">
					<label className="text-sm font-medium" htmlFor={inputId}>
						Type <span className="font-mono">{environmentName}</span> to confirm
					</label>
					<Input
						id={inputId}
						autoComplete="off"
						autoFocus
						placeholder={environmentName}
						value={confirmation}
						onChange={(event) => setConfirmation(event.target.value)}
					/>
					<p className="text-xs text-muted-foreground">
						The environment name is case-sensitive.
					</p>
				</div>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						disabled={
							disabled ||
							!environmentName ||
							!isDeploymentConfirmationValid(confirmation, environmentName)
						}
						onClick={() => void onConfirm()}
					>
						Deploy
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
};
