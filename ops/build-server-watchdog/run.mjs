import { readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkServer } from "./state.mjs";

const configPath = process.argv[2];
if (!configPath)
	throw new Error("Usage: node run.mjs /absolute/path/config.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const root = config.dokployPackage ?? "/app/node_modules/@dokploy/server";
const load = (name) => import(pathToFileURL(join(root, "dist", name)).href);
const require = createRequire(join(root, "package.json"));
const { Client } = require("ssh2");
const { db } = await load("db/index.js");
const { findServerById } = await load("services/server.js");
const { sendDiscordNotification } = await load("utils/notifications/utils.js");
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
const log = (message) => console.log(`[build-server-watchdog] ${message}`);
const save = async (value) => {
	await writeFile(`${statePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`, {
		mode: 0o600,
	});
	await rename(`${statePath}.tmp`, statePath);
};

// Bound both handshake and execution. Dokploy's deployment SSH executor does
// not bound execution time; a health monitor must never wait indefinitely.
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
			else resolve(output.trim());
		};
		const timer = setTimeout(
			() => finish(new Error("SSH command timed out")),
			timeoutMs,
		);
		client.on("error", () => finish(new Error("Build server SSH unavailable")));
		client.once("ready", () => {
			client.exec(
				`export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH";\n${command}`,
				(error, stream) => {
					if (error) return finish(new Error("SSH command rejected"));
					stream.on("data", (data) => {
						output = (output + data).slice(-4096);
					});
					stream.on("close", (code) =>
						finish(
							code === 0
								? null
								: new Error("Remote health/recovery command failed"),
						),
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

const probe = async () => {
	const platform = await remote(
		"docker info --format '{{.OSType}}/{{.Architecture}}'",
		15_000,
	);
	if (!/^linux\/(aarch64|arm64|x86_64|amd64)$/.test(platform))
		throw new Error("Docker platform unavailable");
};

const recover = async () => {
	log("Tentative de récupération de Colima.");
	// Only recover the existing default Colima VM. Never create/delete a VM,
	// touch volumes, or restart Docker on a Linux deployment server.
	await remote(
		`set -e
[ "$(uname -s)" = Darwin ]
command -v colima >/dev/null
[ -f "$HOME/.colima/default/colima.yaml" ]
if colima status >/dev/null 2>&1; then
  colima restart
else
  colima start
fi`,
		150_000,
	);
};

const titles = {
	unavailable: "⚠️ Serveur de build indisponible",
	recovered: "✅ Serveur de build rétabli",
	failed: "🚨 Récupération automatique impossible",
};
const notify = async (event, persist) => {
	// Read destinations from Dokploy every time: no copied webhook or SSH key,
	// and existing notification switches continue to control delivery.
	const notifications = await db.query.notifications.findMany({
		where: (n, { and, eq }) =>
			and(
				eq(n.organizationId, config.organizationId),
				eq(n.appBuildError, true),
			),
		with: { discord: true },
	});
	const destinations = notifications.filter((n) => n.discord);
	if (!destinations.length)
		throw new Error("No enabled Dokploy Discord build-error notification");
	const errors = [];
	for (const destination of destinations) {
		if (event.delivered.includes(destination.notificationId)) continue;
		try {
			const url = new URL(destination.discord.webhookUrl);
			// Discord confirms message creation with wait=true rather than silently
			// discarding an unsuccessful fire-and-forget delivery.
			url.searchParams.set("wait", "true");
			await sendDiscordNotification(
				{ ...destination.discord, webhookUrl: url.href },
				{
					title: `${config.validation ? "[TEST CONTRÔLÉ] " : ""}${titles[event.kind]}`,
					color: event.kind === "recovered" ? 0x57f287 : 0xed4245,
					description: event.message,
					fields: [
						{ name: "Serveur", value: target.name },
						{ name: "Dokploy", value: config.dashboardUrl },
					],
					timestamp: new Date(event.at).toISOString(),
					footer: { text: "Dokploy · surveillance du serveur de build" },
				},
			);
			event.delivered.push(destination.notificationId);
			await persist();
			log(
				`Discord a confirmé la notification ${event.kind} (${destination.notificationId}).`,
			);
		} catch {
			errors.push(destination.notificationId);
		}
	}
	if (errors.length) throw new Error("Notification delivery pending");
};

// Bound notification requests too. This process is dedicated to the watchdog;
// the native Dokploy sender itself has no network timeout.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options = {}) =>
	nativeFetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
try {
	await checkServer(state, { probe, recover, notify, save, log });
	log(
		`Docker ${state.healthy ? "disponible" : "indisponible"}; notifications en attente : ${state.pending.length}.`,
	);
	// An observed outage is a completed check, not a scheduler failure. Incident
	// status and delivery retries are persisted independently of the job status.
	process.exit(0);
} catch {
	log(
		"Échec du contrôle ; consulter la configuration et la connectivité du serveur.",
	);
	process.exit(1);
}
