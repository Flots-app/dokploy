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
			incident.attempts++;
			incident.lastAttempt = now;
			// Record attempts before running commands: a killed process must not
			// repeatedly restart the machine on the next scheduled invocation.
			await io.save(state);
			await flushNotifications(state, io);
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
				if (incident.attempts === 3) {
					enqueue(
						"failed",
						"Docker reste indisponible après trois tentatives espacées de cinq minutes. Les relances automatiques sont suspendues pour cet incident ; intervention nécessaire. La surveillance continue.",
					);
				}
			}
		}
	}
	state.checkedAt = now;
	state.healthy = healthy;
	await io.save(state);
	await flushNotifications(state, io);
	return state;
}

async function flushNotifications(state, io) {
	while (state.pending.length) {
		const event = state.pending[0];
		try {
			// The transport persists each successful destination independently.
			// Failed deliveries are retried on the next check, including recovery.
			await io.notify(event, () => io.save(state));
			state.pending.shift();
			await io.save(state);
		} catch {
			io.log("Notification en attente : nouvel essai au prochain contrôle.");
			break;
		}
	}
}
