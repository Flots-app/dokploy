import { FormLabel } from "@/components/ui/form";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

export interface BackupSource {
	backupId: string;
	appName: string;
	prefix: string;
	schedule: string;
	keepLatestCount?: number | null;
	destinationId: string;
	destination: {
		name: string;
	};
}

interface Props {
	backups: BackupSource[];
	selectedBackupId: string;
	onSelect: (backup: BackupSource) => void;
	onManualBrowse: () => void;
}

export const BackupSourceSelect = ({
	backups,
	selectedBackupId,
	onSelect,
	onManualBrowse,
}: Props) => {
	const selectedBackup = backups.find(
		(backup) => backup.backupId === selectedBackupId,
	);

	return (
		<div className="space-y-2">
			<FormLabel htmlFor="backup-source">Backup Configuration</FormLabel>
			<p className="text-xs text-muted-foreground">
				Select a configured storage prefix to open its backup files directly.
			</p>
			<Select
				value={selectedBackupId || undefined}
				onValueChange={(backupId) => {
					if (backupId === "manual") {
						onManualBrowse();
						return;
					}

					const backup = backups.find((item) => item.backupId === backupId);
					if (backup) {
						onSelect(backup);
					}
				}}
			>
				<SelectTrigger id="backup-source" className="w-full">
					<SelectValue placeholder="Select by storage prefix" />
				</SelectTrigger>
				<SelectContent>
					{backups.map((backup) => (
						<SelectItem key={backup.backupId} value={backup.backupId}>
							{backup.prefix || "/"} · {backup.destination.name}
						</SelectItem>
					))}
					<SelectItem value="manual">Browse destination manually</SelectItem>
				</SelectContent>
			</Select>
			{selectedBackup && (
				<div className="rounded-lg border bg-muted/40 p-3 text-sm">
					<div className="flex justify-between gap-4">
						<span className="text-muted-foreground">Prefix Storage</span>
						<code>{selectedBackup.prefix || "/"}</code>
					</div>
					<div className="mt-1 flex justify-between gap-4">
						<span className="text-muted-foreground">Schedule</span>
						<code>{selectedBackup.schedule}</code>
					</div>
					<div className="mt-1 flex justify-between gap-4">
						<span className="text-muted-foreground">Keep Latest</span>
						<span>{selectedBackup.keepLatestCount || "All"}</span>
					</div>
				</div>
			)}
		</div>
	);
};
