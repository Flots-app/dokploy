import assert from "node:assert/strict";
import test from "node:test";
import { createNotifier } from "./delivery.mjs";

test("a slow first destination cannot starve a healthy destination and per-channel order is preserved", async () => {
	const events = ["unavailable", "recovered"].map((kind) => ({
		kind,
		delivered: [],
	}));
	let rejectSlow;
	const slow = new Promise((_, reject) => {
		rejectSlow = reject;
	});
	const sent = [];
	const notify = createNotifier({
		destinations: async () => [
			{ notificationId: "slow" },
			{ notificationId: "healthy" },
		],
		send: async ({ notificationId }, event) => {
			if (notificationId === "slow") return slow;
			sent.push(event.kind);
		},
		log: () => {},
	});
	const running = notify(events, async () => {}, 20_000);
	await new Promise(setImmediate);
	assert.deepEqual(sent, ["unavailable", "recovered"]);
	rejectSlow(new Error("Timed out"));
	assert.deepEqual(await running, []);
});

test("concurrent destinations serialize state writes", async () => {
	let writes = 0;
	let maxWrites = 0;
	const events = [{ kind: "unavailable", delivered: [] }];
	const notify = createNotifier({
		destinations: async () =>
			["a", "b", "c"].map((notificationId) => ({ notificationId })),
		send: async () => {},
		log: () => {},
	});
	const completed = await notify(
		events,
		async () => {
			writes++;
			maxWrites = Math.max(maxWrites, writes);
			await new Promise(setImmediate);
			writes--;
		},
		20_000,
	);
	assert.equal(maxWrites, 1);
	assert.deepEqual(completed, events);
	assert.deepEqual(events[0].delivered.sort(), ["a", "b", "c"]);
});

test("requests use only their remaining delivery budget", async () => {
	let clock = 0;
	const timeouts = [];
	const notify = createNotifier({
		destinations: async () => [{ notificationId: "a" }],
		now: () => clock,
		send: async (_, __, timeout) => {
			timeouts.push(timeout);
			clock += 7_000;
		},
		log: () => {},
	});
	const events = ["unavailable", "recovered", "unavailable"].map((kind) => ({
		kind,
		delivered: [],
	}));
	const completed = await notify(events, async () => {}, 10_000);
	assert.deepEqual(timeouts, [10_000, 3_000]);
	assert.equal(completed.length, 2);
});

test("a stuck database lookup is bounded and sends nothing", async () => {
	let sends = 0;
	const notify = createNotifier({
		destinations: () => new Promise(() => {}),
		send: async () => {
			sends++;
		},
		log: () => {},
	});
	await assert.rejects(
		notify([{ kind: "unavailable", delivered: [] }], async () => {}, 10),
		/lookup timed out/,
	);
	assert.equal(sends, 0);
});
