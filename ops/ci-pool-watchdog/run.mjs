import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createNotifier } from "./delivery.mjs";
import { parseProbe, probeCommand, probeSettings } from "./probe.mjs";
import { checkPool } from "./state.mjs";

const configPath = process.argv[2];
if (!configPath)
	throw new Error("Usage: node run.mjs /absolute/path/config.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const settings = probeSettings(config);
const root = config.dokployPackage ?? "/app/node_modules/@dokploy/server";
const load = (name) => import(pathToFileURL(join(root, "dist", name)).href);
const require = createRequire(join(root, "package.json"));
const { Client } = require("ssh2");
const { db } = await load("db/index.js");
const { findServerById } = await load("services/server.js");
const { sendDiscordNotification } = await load("utils/notifications/utils.js");
// The CI pool runs in a Lima VM on the Mac registered as the build server, so
// the probe reuses its stored SSH key; no GitHub or Discord credential is copied.
const target = await findServerById(config.serverId);
if (
	target.serverType !== "build" ||
	target.organizationId !== config.organizationId
) {
	throw new Error(
		"Watchdog target must be a build server in the configured organization",
	);
}
const statePath = join(dirname(configPath), "state.json");
let state;
try {
	state = JSON.parse(await readFile(statePath, "utf8"));
} catch (error) {
	if (error.code !== "ENOENT") throw error;
	state = {};
}
const log = (message) => console.log(`[ci-pool-watchdog] ${message}`);
const save = async (value) => {
	await writeFile(`${statePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, {
		mode: 0o600,
	});
	await rename(`${statePath}.tmp`, statePath);
};

// Bound both handshake and execution: a monitor must never wait indefinitely.
const remote = (command, timeoutMs) =>
	new Promise((resolve, reject) => {
		const client = new Client();
		let output = "";
		let finished = false;
		const finish = (error) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			client.destroy();
			if (error) reject(error);
			else resolve(output);
		};
		const timer = setTimeout(
			() => finish(new Error("SSH command timed out")),
			timeoutMs,
		);
		client.on("error", () => finish(new Error("Mac SSH unavailable")));
		client.once("ready", () => {
			client.exec(
				`export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH";\n${command}`,
				(error, stream) => {
					if (error) return finish(new Error("SSH command rejected"));
					stream.on("data", (data) => {
						output = (output + data).slice(-4096);
					});
					stream.on("close", (code) =>
						finish(code === 0 ? null : new Error("Probe command failed")),
					);
				},
			);
		});
		client.connect({
			host: target.ipAddress,
			port: target.port,
			username: target.username,
			privateKey: target.sshKey?.privateKey,
			readyTimeout: 10_000,
		});
	});

const probe = async () =>
	parseProbe(await remote(probeCommand(settings), 45_000), settings);

const titles = {
	unavailable: "🚨 Pool CI Mac indisponible",
	reminder: "⏳ Pool CI Mac toujours indisponible",
	recovered: "✅ Pool CI Mac rétabli",
};
const requestTimeout = new AsyncLocalStorage();
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options = {}) =>
	nativeFetch(url, {
		...options,
		signal: AbortSignal.timeout(requestTimeout.getStore() ?? 15_000),
	});

// dryRun logs what would be sent, to rehearse detection without a message.
const notify = config.dryRun
	? async (events) => {
			for (const event of events)
				log(`[dry-run] ${event.kind} : ${event.message}`);
			return events;
		}
	: createNotifier({
			// Same destinations as the build-server watchdog: Discord channels with
			// build errors enabled, loaded at run time without copying credentials.
			destinations: async () => {
				const notifications = await db.query.notifications.findMany({
					where: (n, { and, eq }) =>
						and(
							eq(n.organizationId, config.organizationId),
							eq(n.appBuildError, true),
						),
					with: { discord: true },
				});
				return notifications.filter((n) => n.discord);
			},
			send: async (destination, event, timeoutMs) => {
				const url = new URL(destination.discord.webhookUrl);
				url.searchParams.set("wait", "true");
				return requestTimeout.run(timeoutMs, () =>
					sendDiscordNotification(
						{ ...destination.discord, webhookUrl: url.href },
						{
							title: `${config.validation ? "[TEST CONTRÔLÉ] " : ""}${titles[event.kind]}`,
							color: event.kind === "recovered" ? 0x57f287 : 0xed4245,
							description: event.message,
							fields: [
								{ name: "Hôte", value: target.name },
								{
									name: "Runners",
									value:
										"https://github.com/Flots-app/monorepo/settings/actions/runners",
								},
								{
									name: "Runbook",
									value:
										"monorepo · docs/operations/ci-runner-routing.md · Recover the VM after a Mac restart",
								},
							],
							timestamp: new Date(event.at).toISOString(),
							footer: { text: "Dokploy · surveillance du pool CI" },
						},
					),
				);
			},
			log,
		});

try {
	await checkPool(state, { probe, notify, save, log }, Date.now(), {
		failuresBeforeAlert: config.failuresBeforeAlert,
		reminderMs:
			config.reminderHours === undefined
				? undefined
				: config.reminderHours * 60 * 60_000,
	});
	log(
		state.healthy
			? `Pool CI disponible ; notifications en attente : ${state.pending.length}.`
			: `Pool CI en échec (${state.failures}) : ${state.problems.join(" ")} Notifications en attente : ${state.pending.length}.`,
	);
	// An observed outage is a completed check, not a scheduler failure.
	process.exit(0);
} catch {
	log(
		"Échec du contrôle ; consulter la configuration et la connectivité du Mac.",
	);
	process.exit(1);
}
