import assert from "node:assert/strict";
import test from "node:test";
import { parseProbe, probeCommand, probeSettings } from "./probe.mjs";

const units = [
	"actions.runner.Flots-app-monorepo.macmini-m4-pool-1.service",
	"actions.runner.Flots-app-monorepo.macmini-m4-pool-2.service",
	"actions.runner.Flots-app.macmini-m4-linux.service",
];
const settings = probeSettings({ runnerUnits: units });

const output = (vm, states, ios = "running") =>
	[
		`vm ${vm}`,
		...states.map((state, index) => `unit ${units[index]} ${state}`),
		`ios ${ios}`,
	].join("\n");

test("a running VM with active runners and the iOS runner is healthy", () => {
	assert.deepEqual(
		parseProbe(output("Running", ["active", "active", "active"]), settings),
		[],
	);
});

test("the Broken VM of the 2026-09-27 outage is reported as such", () => {
	assert.deepEqual(parseProbe(output("Broken", []), settings), [
		"VM Lima flots-ci-linux : Broken.",
	]);
});

test("a missing VM and an unreadable probe are reported", () => {
	assert.deepEqual(parseProbe(output("missing", []), settings), [
		"VM Lima flots-ci-linux introuvable.",
	]);
	assert.deepEqual(parseProbe("", settings), [
		"Sonde incomplète : état de la VM non reçu.",
	]);
});

test("inactive or unreported runner services are named", () => {
	assert.deepEqual(
		parseProbe(output("Running", ["active", "failed"]), settings),
		[
			"Runners inactifs : macmini-m4-pool-2 (failed), macmini-m4-linux (inconnu).",
		],
	);
});

test("a stopped iOS runner is reported, and can be ignored", () => {
	const stopped = output("Running", ["active", "active", "active"], "stopped");
	assert.deepEqual(parseProbe(stopped, settings), [
		"Runner iOS arrêté sur l'hôte (session macOS non ouverte ?).",
	]);
	const linuxOnly = probeSettings({ runnerUnits: units, iosRunner: false });
	assert.deepEqual(parseProbe(stopped, linuxOnly), []);
	assert.doesNotMatch(probeCommand(linuxOnly), /pgrep/);
});

test("settings that could inject shell are refused", () => {
	assert.throws(() => probeSettings({ runnerUnits: ["a; rm -rf /"] }));
	assert.throws(() =>
		probeSettings({ instance: "$(reboot)", runnerUnits: units }),
	);
	assert.throws(() => probeSettings({ runnerUnits: [] }));
});

test("the remote command always exits 0 and never matches itself", () => {
	const command = probeCommand(settings);
	assert.match(command, /exit 0$/);
	assert.match(command, /pgrep -x Runner\.Listener/);
	assert.doesNotMatch(command, /pgrep -f/);
});
