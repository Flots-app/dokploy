import { formatDistanceToNow } from "date-fns";
import type { RunnerMachine } from "./format";

const KIND_LABELS = {
	runner: "updating actions/runner",
	runtime: "updating the runtime",
	os: "installing OS updates",
} as const;

/** An update running on the machine, and the outcome of its OS updates. */
export const UpdateProgress = ({ machine }: { machine: RunnerMachine }) => {
	const { inProgress, osPatches, patchedAt, patchError } = machine.updates;
	return (
		<>
			{inProgress && <span>{KIND_LABELS[inProgress.kind]}</span>}
			{patchError ? (
				<span className="text-destructive" title={patchError}>
					OS updates failed
				</span>
			) : (
				osPatches &&
				patchedAt && (
					<span>
						OS updated{" "}
						{formatDistanceToNow(new Date(patchedAt), { addSuffix: true })}
					</span>
				)
			)}
		</>
	);
};

/** The reserve the machine arms itself with while Dokploy does not answer. */
export const ReserveLine = ({ machine }: { machine: RunnerMachine }) => {
	const autonomy = machine.observed?.autonomy;
	if (!autonomy?.reserve) return null;
	const wanted = autonomy.reserve * machine.resolvedMaxRunners;
	return (
		<span title="Runner registrations kept on the machine, used when Dokploy stops answering">
			reserve {autonomy.spares}/{wanted}
			{autonomy.armed && autonomy.last
				? ` · armed itself ${autonomy.armed}× (last ${formatDistanceToNow(new Date(autonomy.last), { addSuffix: true })})`
				: ""}
		</span>
	);
};
