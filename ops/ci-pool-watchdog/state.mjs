// Persistent incident state of the Mac CI pool. This watchdog only alerts:
// launchd already restarts the Lima VM, and acting on the pool from here could
// kill running CI jobs. IO is injected so every transition runs without a Mac.
export const defaults = {
	failuresBeforeAlert: 3,
	reminderMs: 6 * 60 * 60_000,
};

export const unreachable = "Mac mini injoignable en SSH depuis Dokploy.";

export function formatDuration(ms) {
	const minutes = Math.max(1, Math.round(ms / 60_000));
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours} h ${String(rest).padStart(2, "0")}` : `${hours} h`;
}

export async function checkPool(state, io, now = Date.now(), options = {}) {
	const failuresBeforeAlert =
		options.failuresBeforeAlert ?? defaults.failuresBeforeAlert;
	const reminderMs = options.reminderMs ?? defaults.reminderMs;
	state.version ??= 1;
	state.failures ??= 0;
	state.pending ??= [];
	const enqueue = (kind, message) => {
		state.pending.push({ kind, message, at: now, delivered: [] });
	};
	let problems;
	try {
		problems = await io.probe();
	} catch {
		problems = [unreachable];
	}
	if (problems.length === 0) {
		if (state.incident) {
			enqueue(
				"recovered",
				`Pool CI de nouveau disponible après ${formatDuration(now - state.incident.since)} d'indisponibilité.`,
			);
			delete state.incident;
		}
		state.failures = 0;
		delete state.firstFailureAt;
	} else {
		if (state.failures === 0) state.firstFailureAt = now;
		state.failures++;
		const since = state.firstFailureAt ?? now;
		const detail = problems.join(" ");
		if (!state.incident && state.failures >= failuresBeforeAlert) {
			state.incident = { since, lastNotified: now };
			enqueue(
				"unavailable",
				`Pool CI indisponible depuis ${formatDuration(now - since)}. ${detail} Les jobs ciblant flots-mac-mini-parallel restent en file d'attente sans échouer.`,
			);
		} else if (
			state.incident &&
			now - state.incident.lastNotified >= reminderMs
		) {
			state.incident.lastNotified = now;
			enqueue(
				"reminder",
				`Pool CI toujours indisponible depuis ${formatDuration(now - state.incident.since)}. ${detail}`,
			);
		}
	}
	state.problems = problems;
	state.checkedAt = now;
	state.healthy = problems.length === 0;
	await io.save(state);
	try {
		const completed = await io.notify(
			state.pending,
			() => io.save(state),
			20_000,
		);
		state.pending = state.pending.filter((event) => !completed.includes(event));
		await io.save(state);
	} catch {
		io.log("Notification en attente : nouvel essai au prochain contrôle.");
	}
	return state;
}
