import assert from "node:assert/strict";
import test from "node:test";
import { checkServer } from "./state.mjs";

function harness() {
	const h = {
		healthy: true,
		recoveryWorks: true,
		deliveryWorks: true,
		attempts: 0,
		events: [],
		disk: {},
	};
	h.io = {
		probe: async () => {
			if (!h.healthy) throw new Error("Docker unavailable");
		},
		recover: async () => {
			h.attempts++;
			if (h.recoveryWorks) h.healthy = true;
			else throw new Error("Recovery failed");
		},
		notify: async (event) => {
			if (!h.deliveryWorks) throw new Error("Discord unavailable");
			h.events.push(event.kind);
		},
		save: async (state) => {
			h.disk = structuredClone(state);
		},
		log: () => {},
	};
	return h;
}

test("healthy checks are silent and never restart Docker", async () => {
	const h = harness();
	await checkServer({}, h.io, 60_000);
	await checkServer(h.disk, h.io, 120_000);
	assert.equal(h.attempts, 0);
	assert.deepEqual(h.events, []);
});

test("one transient failure does not trigger an alert or recovery", async () => {
	const h = harness();
	h.healthy = false;
	await checkServer({}, h.io, 60_000);
	h.healthy = true;
	await checkServer(h.disk, h.io, 120_000);
	assert.equal(h.attempts, 0);
	assert.deepEqual(h.events, []);
});

test("confirmed outage is notified before recovery and a fresh probe confirms restoration", async () => {
	const h = harness();
	h.healthy = false;
	await checkServer({}, h.io, 60_000);
	await checkServer(h.disk, h.io, 120_000);
	assert.equal(h.attempts, 1);
	assert.deepEqual(h.events, ["unavailable", "recovered"]);
	assert.equal(h.disk.healthy, true);
	assert.equal(h.disk.incident, undefined);
	await checkServer(h.disk, h.io, 180_000);
	assert.equal(h.events.length, 2);
});

test("recovery command success alone cannot mark the server healthy", async () => {
	const h = harness();
	h.healthy = false;
	h.io.recover = async () => {
		h.attempts++;
	};
	await checkServer({}, h.io, 60_000);
	await checkServer(h.disk, h.io, 120_000);
	assert.equal(h.disk.healthy, false);
	assert.deepEqual(h.events, ["unavailable"]);
});

test("failed recovery survives process restarts, respects cooldown, and stops after three attempts", async () => {
	const h = harness();
	h.healthy = false;
	h.recoveryWorks = false;
	for (let minute = 1; minute <= 30; minute++)
		await checkServer(structuredClone(h.disk), h.io, minute * 60_000);
	assert.equal(h.attempts, 3);
	assert.deepEqual(h.events, ["unavailable", "failed"]);
	assert.equal(h.disk.incident.attempts, 3);
	h.healthy = true;
	await checkServer(h.disk, h.io, 31 * 60_000);
	assert.deepEqual(h.events, ["unavailable", "failed", "recovered"]);
});

test("Discord failure does not prevent recovery and pending alerts are delivered in order later", async () => {
	const h = harness();
	h.healthy = false;
	h.deliveryWorks = false;
	await checkServer({}, h.io, 60_000);
	await checkServer(h.disk, h.io, 120_000);
	assert.equal(h.attempts, 1);
	assert.equal(h.disk.pending.length, 2);
	h.deliveryWorks = true;
	await checkServer(h.disk, h.io, 180_000);
	assert.deepEqual(h.events, ["unavailable", "recovered"]);
	assert.equal(h.disk.pending.length, 0);
});

test("an interrupted recovery consumes an attempt and cannot create a restart loop", async () => {
	const h = harness();
	h.healthy = false;
	await checkServer(
		{
			failures: 1,
			incident: { since: 60_000, attempts: 1, lastAttempt: 60_000 },
			pending: [],
		},
		h.io,
		120_000,
	);
	assert.equal(h.attempts, 0);
	await checkServer(h.disk, h.io, 360_000);
	assert.equal(h.attempts, 1);
});

test("partial delivery progress is persisted so successful destinations are not notified twice", async () => {
	const h = harness();
	let failing = true;
	const delivered = [];
	h.io.notify = async (event, persist) => {
		for (const id of ["a", "b"]) {
			if (event.delivered.includes(id)) continue;
			if (id === "b" && failing) throw new Error("temporary HTTP failure");
			event.delivered.push(id);
			delivered.push(id);
			await persist();
		}
	};
	await checkServer(
		{ pending: [{ kind: "unavailable", delivered: [] }] },
		h.io,
		60_000,
	);
	failing = false;
	await checkServer(h.disk, h.io, 120_000);
	assert.deepEqual(delivered, ["a", "b"]);
});
