import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * Asks before a change that makes servers install right away (a window is
 * open). Open while `message` is set.
 */
export const ConfirmChange = ({
	message,
	onConfirm,
	onCancel,
}: {
	message: string | null;
	onConfirm: () => void;
	onCancel: () => void;
}) => (
	<AlertDialog
		open={message !== null}
		onOpenChange={(open) => {
			if (!open) onCancel();
		}}
	>
		<AlertDialogContent>
			<AlertDialogHeader>
				<AlertDialogTitle>Install the updates now?</AlertDialogTitle>
				<AlertDialogDescription>{message}</AlertDialogDescription>
			</AlertDialogHeader>
			<AlertDialogFooter>
				<AlertDialogCancel>Cancel</AlertDialogCancel>
				<AlertDialogAction onClick={onConfirm}>Confirm</AlertDialogAction>
			</AlertDialogFooter>
		</AlertDialogContent>
	</AlertDialog>
);
