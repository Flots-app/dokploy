import assert from "node:assert/strict";
import test from "node:test";
import { checkPool, formatDuration, unreachable } from "./state.mjs";

const MINUTE = 60_000;

function harness() {
	const h = {
		problems: [],
		reachable: true,
		deliveryWorks: true,
		events: [],
		disk: {},
	};
	h.io = {
		probe: async () => {
			if (!h.reachable) throw new Error("Mac SSH unavailable");
			return h.problems;
		},
		notify: async (events) => {
			if (!h.deliveryWorks) throw new Error("Discord unavailable");
			h.events.push(...events.map((event) => [event.kind, event.message]));
			return events;
		},
		save: async (state) => {
			h.disk = structuredClone(state);
		},
		log: () => {},
	};
	h.run = (minute, options) =>
		checkPool(h.disk, h.io, minute * MINUTE, options);
	return h;
}

test("a healthy pool is silent", async () => {
	const h = harness();
	for (const minute of [1, 2, 3, 4]) await h.run(minute);
	assert.deepEqual(h.events, []);
	assert.equal(h.disk.healthy, true);
});

test("short outages such as a Mac restart do not alert", async () => {
	const h = harness();
	h.reachable = false;
	await h.run(1);
	await h.run(2);
	h.reachable = true;
	await h.run(3);
	assert.deepEqual(h.events, []);
	assert.equal(h.disk.failures, 0);
});

test("a confirmed outage alerts once with its cause and duration, then recovers", async () => {
	const h = harness();
	h.problems = ["VM Lima flots-ci-linux : Broken."];
	for (const minute of [1, 2, 3, 4, 5]) await h.run(minute);
	assert.equal(h.events.length, 1);
	const [kind, message] = h.events[0];
	assert.equal(kind, "unavailable");
	assert.match(message, /depuis 2 min\. VM Lima flots-ci-linux : Broken\./);
	h.problems = [];
	await h.run(10);
	assert.deepEqual(
		h.events.map(([k]) => k),
		["unavailable", "recovered"],
	);
	assert.match(h.events[1][1], /après 9 min d'indisponibilité/);
	assert.equal(h.disk.incident, undefined);
});

test("an unreachable Mac is an outage, not a failed check", async () => {
	const h = harness();
	h.reachable = false;
	for (const minute of [1, 2, 3]) await h.run(minute);
	assert.equal(h.events[0][0], "unavailable");
	assert.ok(h.events[0][1].includes(unreachable));
});

test("a long outage is reminded at the configured interval, not every check", async () => {
	const h = harness();
	h.problems = ["Runners inactifs : macmini-m4-pool-2 (failed)."];
	for (let minute = 1; minute <= 3 + 6 * 60; minute++) await h.run(minute);
	assert.deepEqual(
		h.events.map(([k]) => k),
		["unavailable", "reminder"],
	);
	assert.match(h.events[1][1], /depuis 6 h 02\./);
});

test("thresholds come from the configuration", async () => {
	const h = harness();
	h.problems = ["VM Lima flots-ci-linux : Stopped."];
	await h.run(1, { failuresBeforeAlert: 1 });
	assert.equal(h.events.length, 1);
});

test("an undelivered alert is kept and retried on the next check", async () => {
	const h = harness();
	h.problems = ["VM Lima flots-ci-linux : Broken."];
	h.deliveryWorks = false;
	for (const minute of [1, 2, 3]) await h.run(minute);
	assert.equal(h.disk.pending.length, 1);
	h.deliveryWorks = true;
	await h.run(4);
	assert.deepEqual(
		h.events.map(([k]) => k),
		["unavailable"],
	);
	assert.equal(h.disk.pending.length, 0);
});

test("durations read naturally", () => {
	assert.equal(formatDuration(30_000), "1 min");
	assert.equal(formatDuration(59 * MINUTE), "59 min");
	assert.equal(formatDuration(60 * MINUTE), "1 h");
	assert.equal(formatDuration(1432 * MINUTE), "23 h 52");
});
