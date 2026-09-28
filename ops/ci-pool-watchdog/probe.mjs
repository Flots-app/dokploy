const NAME = /^[A-Za-z0-9@._-]+$/;

/**
 * Validates the probe settings before any of them reaches a remote shell.
 * @param {{ instance?: string, runnerUnits?: string[], iosRunner?: boolean }} config
 */
export function probeSettings(config) {
	const settings = {
		instance: config.instance ?? "flots-ci-linux",
		runnerUnits: config.runnerUnits ?? [],
		iosRunner: config.iosRunner ?? true,
	};
	if (
		!NAME.test(settings.instance) ||
		settings.runnerUnits.length === 0 ||
		!settings.runnerUnits.every((unit) => NAME.test(unit))
	) {
		throw new Error("Invalid CI pool probe settings");
	}
	return settings;
}

/**
 * Builds the command run on the Mac over SSH. It always exits 0 and prints one
 * line per component, so an outage is described instead of reduced to a failed
 * command. `pgrep -x` matches the process name, never this shell's own text.
 */
export function probeCommand({ instance, runnerUnits, iosRunner }) {
	return [
		`vm=$(limactl list --format '{{.Status}}' ${instance} 2>/dev/null || true)`,
		'echo "vm ${vm:-missing}"',
		'if [ "$vm" = Running ]; then',
		`  limactl shell ${instance} sh -c 'for unit in "$@"; do echo "unit $unit $(systemctl is-active "$unit")"; done' probe ${runnerUnits.join(" ")} 2>/dev/null || true`,
		"fi",
		iosRunner
			? 'if pgrep -x Runner.Listener >/dev/null; then echo "ios running"; else echo "ios stopped"; fi'
			: "",
		"exit 0",
	]
		.filter(Boolean)
		.join("\n");
}

const shortUnit = (unit) =>
	unit.replace(/^actions\.runner\.[^.]+\./, "").replace(/\.service$/, "");

/**
 * Turns the probe output into operator-readable problems; none means healthy.
 * @returns {string[]}
 */
export function parseProbe(output, { instance, runnerUnits, iosRunner }) {
	const lines = output.split("\n").map((line) => line.trim().split(/\s+/));
	const vm = lines.find(([kind]) => kind === "vm")?.[1];
	if (!vm) return ["Sonde incomplète : état de la VM non reçu."];
	if (vm !== "Running") {
		const problems = [
			vm === "missing"
				? `VM Lima ${instance} introuvable.`
				: `VM Lima ${instance} : ${vm}.`,
		];
		if (iosRunner && lines.some(([k, v]) => k === "ios" && v === "stopped")) {
			problems.push(
				"Runner iOS arrêté sur l'hôte (session macOS non ouverte ?).",
			);
		}
		return problems;
	}
	const states = new Map(
		lines.filter(([kind]) => kind === "unit").map(([, unit, s]) => [unit, s]),
	);
	const problems = [];
	const down = runnerUnits
		.filter((unit) => states.get(unit) !== "active")
		.map((unit) => `${shortUnit(unit)} (${states.get(unit) ?? "inconnu"})`);
	if (down.length) problems.push(`Runners inactifs : ${down.join(", ")}.`);
	if (iosRunner && !lines.some(([k, v]) => k === "ios" && v === "running")) {
		problems.push(
			"Runner iOS arrêté sur l'hôte (session macOS non ouverte ?).",
		);
	}
	return problems;
}
