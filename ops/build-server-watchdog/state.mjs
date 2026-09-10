// Persistent incident state. IO is injected so recovery and delivery failures can
// be exercised without stopping a real build server.
export async function checkServer(state, io, now = Date.now()) {
	state.version ??= 1;
	state.failures ??= 0;
	state.pending ??= [];
	const enqueue = (kind, message) => {
		state.pending.push({ kind, message, at: now, delivered: [] });
	};
	let healthy = false;
	try {
		await io.probe();
		healthy = true;
	} catch {
		state.failures++;
	}
	if (healthy) {
		state.failures = 0;
		if (state.incident) {
			enqueue(
				"recovered",
				`Docker est de nouveau disponible. Tentatives de récupération : ${state.incident.attempts}.`,
			);
			delete state.incident;
		}
	} else if (state.failures >= 2) {
		if (!state.incident) {
			state.incident = { since: now, attempts: 0, lastAttempt: 0 };
			enqueue(
				"unavailable",
				"Docker est indisponible après deux contrôles consécutifs. Récupération automatique de Colima prévue ; les services déjà déployés restent indépendants de ce serveur de build.",
			);
		}
		const incident = state.incident;
		if (
			incident.attempts < 3 &&
			(!incident.lastAttempt || now - incident.lastAttempt >= 5 * 60_000)
		) {
			await io.save(state);
			await flushNotifications(state, io, 10_000);
			incident.attempts++;
			incident.lastAttempt = io.now?.() ?? now;
			// Record attempts before running commands: a killed process must not
			// repeatedly restart the machine on the next scheduled invocation.
			await io.save(state);
			try {
				await io.recover();
				await io.probe();
				healthy = true;
				state.failures = 0;
				enqueue(
					"recovered",
					`Docker répond après la récupération automatique de Colima (tentative ${incident.attempts}/3).`,
				);
				delete state.incident;
			} catch {
				// Reconcile exhaustion below, also when the previous process died
				// after persisting its final attempt but before reporting the result.
			}
		}
		if (state.incident?.attempts >= 3 && !state.incident.exhaustionQueued) {
			state.incident.exhaustionQueued = true;
			if (
				!state.pending.some(
					(event) => event.kind === "failed" && event.at >= incident.since,
				)
			) {
				enqueue(
					"failed",
					"Docker reste indisponible après trois tentatives espacées de cinq minutes. Les relances automatiques sont suspendues pour cet incident ; intervention nécessaire. La surveillance continue.",
				);
			}
		}
	}
	state.checkedAt = now;
	state.healthy = healthy;
	await io.save(state);
	await flushNotifications(state, io);
	return state;
}

async function flushNotifications(state, io, budgetMs = 20_000) {
	try {
		const completed = await io.notify(
			state.pending,
			() => io.save(state),
			budgetMs,
		);
		state.pending = state.pending.filter((event) => !completed.includes(event));
		await io.save(state);
	} catch {
		io.log("Notification en attente : nouvel essai au prochain contrôle.");
	}
}
