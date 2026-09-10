// Each destination drains its own ordered queue concurrently. A failing or slow
// webhook must not withhold recovery messages from healthy destinations.
export function createNotifier({ destinations, send, log, now = Date.now }) {
	return async (events, persist, budgetMs) => {
		if (!events.length) return [];
		const deadline = now() + budgetMs;
		const targets = await withinDeadline(destinations, budgetMs);
		if (!targets.length) return [];
		// Concurrent destinations share one atomic state file: serialize writes.
		let saving = Promise.resolve();
		const saveProgress = () => {
			saving = saving.then(persist);
			return saving;
		};
		const results = await Promise.allSettled(
			targets.map(async (target) => {
				const id = target.notificationId;
				for (const event of events) {
					if (event.delivered.includes(id)) continue;
					const remainingMs = deadline - now();
					if (remainingMs <= 0) break;
					try {
						await send(target, event, Math.min(15_000, remainingMs));
					} catch {
						break;
					}
					event.delivered.push(id);
					await saveProgress();
					log(`Discord a confirmé la notification ${event.kind} (${id}).`);
				}
			}),
		);
		const failure = results.find((result) => result.status === "rejected");
		if (failure) throw failure.reason;
		return events.filter((event) =>
			targets.every((target) =>
				event.delivered.includes(target.notificationId),
			),
		);
	};
}

async function withinDeadline(operation, timeoutMs) {
	let timer;
	try {
		return await Promise.race([
			Promise.resolve().then(operation),
			new Promise((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Notification lookup timed out")),
					timeoutMs,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
