/**
 * Runs the steps one after the other, in order: for side effects that depend on
 * each other (files rewritten by every step, undo actions, bandwidth-bound copies).
 */
export const sequentially = async <T>(
	items: readonly T[],
	run: (item: T) => Promise<unknown>,
	index = 0,
): Promise<void> => {
	if (index >= items.length) return;
	await run(items[index] as T);
	await sequentially(items, run, index + 1);
};

/** OpenSSH accepts 10 concurrent sessions per connection by default. */
export const SSH_PROBE_CONCURRENCY = 4;

/** Maps the items with at most `limit` operations in flight, keeping their order. */
export const mapWithConcurrency = async <T, R>(
	items: readonly T[],
	limit: number,
	map: (item: T) => Promise<R>,
): Promise<R[]> => {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		const index = next;
		next += 1;
		if (index >= items.length) return;
		results[index] = await map(items[index] as T);
		await worker();
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, () => worker()),
	);
	return results;
};
