import { formatDistanceToNow } from "date-fns";
import { Loader2, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/utils/api";
import { errorText } from "../github-runners/format";
import {
	browserTimeZone,
	dateText,
	handoffState,
	macosText,
	type OsUpdateMacRow,
	RUN_STATUS,
} from "./format";

const HandOffForm = ({
	mac,
	onDone,
}: {
	mac: OsUpdateMacRow;
	onDone: () => void;
}) => {
	const utils = api.useUtils();
	const handOff = api.osUpdate.handOffMacos.useMutation();
	const [hours, setHours] = useState(24);
	const invalid = !(Number.isInteger(hours) && hours >= 1 && hours <= 72);
	const submit = async () => {
		try {
			await handOff.mutateAsync({
				githubRunnerNodeId: mac.githubRunnerNodeId,
				maxHours: hours,
			});
			await Promise.all([
				utils.osUpdate.overview.invalidate(),
				utils.osUpdate.runs.invalidate(),
			]);
			toast.success(
				`${mac.name} takes no new job: it is ready for its macOS update once its jobs end`,
			);
			onDone();
		} catch (error) {
			toast.error(errorText(error, "The hand-off could not start"));
		}
	};
	return (
		<>
			<div className="grid gap-3 text-sm">
				<ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
					<li>{mac.name} takes no new job; its running jobs end.</li>
					<li>
						Dokploy tells you (OS Updates notifications) that it is ready. Its
						owner updates macOS in System Settings › General › Software Update,
						restarting it if macOS asks.
					</li>
					<li>
						Once {mac.name} reports another macOS version, it takes jobs again.
					</li>
				</ol>
				<p className="text-muted-foreground">
					Dokploy never installs macOS updates: they need the Mac's owner (or an
					MDM). The Linux VM of the Mac is updated by the maintenance
					configurations, in the Machines table.
				</p>
				<div className="grid gap-2">
					<Label htmlFor="os-handoff-hours">Give it back after (hours)</Label>
					<Input
						id="os-handoff-hours"
						type="number"
						min={1}
						max={72}
						step={1}
						value={hours}
						onChange={(event) => setHours(Number(event.target.value))}
					/>
					<p className="text-xs text-muted-foreground">
						If macOS has not changed by then, {mac.name} takes jobs again. Give
						it back earlier from its menu.
					</p>
				</div>
			</div>
			<DialogFooter>
				<Button variant="outline" onClick={onDone}>
					Cancel
				</Button>
				<Button onClick={submit} disabled={invalid || handOff.isPending}>
					{handOff.isPending && <Loader2 className="size-4 animate-spin" />}
					Hand off
				</Button>
			</DialogFooter>
		</>
	);
};

const MacActions = ({
	mac,
	canRun,
}: {
	mac: OsUpdateMacRow;
	canRun: boolean;
}) => {
	const utils = api.useUtils();
	const cancel = api.osUpdate.cancelRun.useMutation();
	const [open, setOpen] = useState(false);
	const current = handoffState(mac) ? mac.lastHandoff : null;
	if (!canRun) return null;
	const giveBack = async () => {
		if (!current) return;
		try {
			await cancel.mutateAsync({ osUpdateRunId: current.osUpdateRunId });
			await Promise.all([
				utils.osUpdate.overview.invalidate(),
				utils.osUpdate.runs.invalidate(),
			]);
			toast.success(`${mac.name} takes jobs again`);
		} catch (error) {
			toast.error(errorText(error, `${mac.name} could not be given back`));
		}
	};
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						size="icon"
						variant="ghost"
						aria-label={`Actions for ${mac.name} (macOS)`}
					>
						<MoreHorizontal className="size-4" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-60">
					{current ? (
						<DropdownMenuItem
							disabled={cancel.isPending}
							onSelect={() => void giveBack()}
						>
							Give back now
						</DropdownMenuItem>
					) : (
						<DropdownMenuItem
							disabled={!mac.active}
							onSelect={() => setOpen(true)}
						>
							Hand off for a macOS update…
						</DropdownMenuItem>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>Hand {mac.name} off for a macOS update</DialogTitle>
						<DialogDescription>
							{macosText(mac)}
							{mac.macos?.security
								? `: ${mac.macos.security} recommended update${mac.macos.security === 1 ? "" : "s"} waiting`
								: ""}
							.
						</DialogDescription>
					</DialogHeader>
					{open && <HandOffForm mac={mac} onDone={() => setOpen(false)} />}
				</DialogContent>
			</Dialog>
		</>
	);
};

/**
 * macOS of the Mac runner machines: reported, and handed to its owner for
 * an update. Their Linux VM is a row of the machines table.
 */
export const MacsTable = ({
	macs,
	canRun,
}: {
	macs: OsUpdateMacRow[];
	canRun: boolean;
}) => {
	const zone = browserTimeZone();
	return (
		<div className="grid gap-2">
			<div>
				<h3 className="text-sm font-medium">macOS of the Mac runners</h3>
				<p className="text-xs text-muted-foreground">
					Updated by each Mac's owner: Dokploy takes the Mac out of service
					meanwhile and gives it back once macOS reports another version.
				</p>
			</div>
			<div className="overflow-x-auto rounded-lg border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Mac</TableHead>
							<TableHead>macOS</TableHead>
							<TableHead>Hand-off</TableHead>
							<TableHead>Last hand-off ({zone})</TableHead>
							<TableHead />
						</TableRow>
					</TableHeader>
					<TableBody>
						{macs.map((mac) => {
							const state = handoffState(mac);
							const last = mac.lastHandoff;
							const pending = mac.macos?.updates ?? null;
							return (
								<TableRow key={mac.githubRunnerNodeId}>
									<TableCell>
										<span className="block font-medium">{mac.name}</span>
										<span className="block text-xs text-muted-foreground">
											GitHub runner · {mac.poolName}
											{mac.enabled ? "" : " · disabled"}
										</span>
									</TableCell>
									<TableCell className="whitespace-normal">
										<div className="grid min-w-52 gap-1 text-xs">
											<span>{macosText(mac)}</span>
											{pending === null ? null : pending === 0 ? (
												<Badge variant="green" className="w-fit">
													up to date
												</Badge>
											) : (
												<Badge
													variant={mac.macos?.security ? "orange" : "blank"}
													className="w-fit"
												>
													{pending} update{pending === 1 ? "" : "s"}
													{mac.macos?.security
														? `, ${mac.macos.security} recommended`
														: ""}
												</Badge>
											)}
											{mac.reportedAt && (
												<span className="text-muted-foreground">
													reported{" "}
													{formatDistanceToNow(new Date(mac.reportedAt), {
														addSuffix: true,
													})}
												</span>
											)}
										</div>
									</TableCell>
									<TableCell className="min-w-40 text-xs whitespace-normal">
										{state ?? <span className="text-muted-foreground">—</span>}
										{state && last && (
											<span className="block text-muted-foreground">
												back to work by {dateText(last.deadline, zone)} at the
												latest
											</span>
										)}
									</TableCell>
									<TableCell>
										{last ? (
											<span className="grid gap-1 text-xs">
												<Badge
													variant={RUN_STATUS[last.status].variant}
													className="w-fit"
												>
													{RUN_STATUS[last.status].label}
												</Badge>
												<span className="text-muted-foreground">
													{dateText(
														last.finishedAt ?? last.startedAt ?? last.createdAt,
														zone,
													)}
												</span>
											</span>
										) : (
											<span className="text-xs text-muted-foreground">—</span>
										)}
									</TableCell>
									<TableCell>
										<MacActions mac={mac} canRun={canRun} />
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</div>
		</div>
	);
};
