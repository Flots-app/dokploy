import type {
	GithubRunnerCaches,
	GithubRunnerCleanup,
	GithubRunnerCleanupKind,
	GithubRunnerJob,
} from "@dokploy/server/db/schema";

/** A probe line: `<kind> key=value key=value`, values never contain spaces. */
export interface ProbeRecord {
	kind: string;
	fields: Record<string, string>;
}

export const parseRecords = (output: string, prefix = ""): ProbeRecord[] =>
	output
		.split("\n")
		.map((line) => line.replace(/\r$/, ""))
		.filter((line) => (prefix ? line.startsWith(prefix) : true))
		.map((line) => (prefix ? line.slice(prefix.length) : line).trim())
		.filter(Boolean)
		.flatMap((line) => {
			const [kind, ...rest] = line.split(/\s+/);
			if (!kind || !/^[a-z]+$/.test(kind)) return [];
			const fields: Record<string, string> = {};
			for (const token of rest) {
				const separator = token.indexOf("=");
				if (separator <= 0) continue;
				fields[token.slice(0, separator)] = token.slice(separator + 1);
			}
			return [{ kind, fields }];
		});

const find = (records: ProbeRecord[], kind: string) =>
	records.find((record) => record.kind === kind)?.fields ?? {};

const int = (value: string | undefined) => {
	if (value === undefined || value === "" || !/^-?\d+$/.test(value)) {
		return null;
	}
	return Number(value);
};

const float = (value: string | undefined) => {
	if (value === undefined || value === "") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
};

export type LocalJob = GithubRunnerJob & { completedAt: string | null };

export interface LocalSlot {
	slot: number;
	/** systemd ActiveState of the slot unit. */
	active: string;
	/** Epoch seconds the unit entered its active state. */
	since: number | null;
	runnerName: string | null;
	job: LocalJob | null;
}

/** The last job of a slot, reported until the slot is armed again. */
export interface JobFile {
	slot: number;
	runnerName: string | null;
	job: LocalJob;
}

export interface RuntimeStatus {
	runtimeVersion: number;
	host: {
		cpus: number;
		memoryBytes: number;
		availableBytes: number | null;
		arch: string;
		load: number | null;
	} | null;
	disk: { totalBytes: number; freeBytes: number } | null;
	release: string | null;
	cpu: { busy: number; total: number } | null;
	slice: {
		usageUsec: number | null;
		memoryCurrentBytes: number | null;
		memoryMaxBytes: number | null;
	};
	dockerActive: boolean;
	slots: LocalSlot[];
	jobFiles: JobFile[];
	/** Registrations kept for each slot, to arm itself without a controller. */
	spares: { slot: number; name: string; createdAt: number }[];
	/** Slots the machine armed on its own: how many, and the last time (epoch seconds). */
	autonomy: { armed: number; last: number } | null;
	/**
	 * What autoarm follows, as `runnerctl autonomy` takes it ("on 2 1024 host",
	 * "off"); null from a runtime older than v8, which does not tell.
	 */
	autonomySetting: string | null;
}

const epochToIso = (value: string | undefined) => {
	const seconds = int(value);
	return seconds ? new Date(seconds * 1000).toISOString() : null;
};

/** Decodes the job file written by the runtime hooks (base64 of key=value lines). */
export const parseJob = (encoded: string | undefined): LocalJob | null => {
	if (!encoded) return null;
	let text: string;
	try {
		text = Buffer.from(encoded, "base64").toString("utf8");
	} catch {
		return null;
	}
	const values: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const separator = line.indexOf("=");
		if (separator > 0) {
			values[line.slice(0, separator)] = line.slice(separator + 1).trim();
		}
	}
	if (!values.repository && !values.run_id) return null;
	return {
		repository: values.repository ?? "",
		runId: values.run_id ?? "",
		runAttempt: values.run_attempt ?? "",
		workflow: values.workflow ?? "",
		job: values.job ?? "",
		startedAt: epochToIso(values.started),
		completedAt: epochToIso(values.completed),
	};
};

export const parseRuntimeStatus = (records: ProbeRecord[]): RuntimeStatus => {
	const host = find(records, "host");
	const disk = find(records, "disk");
	const cpu = find(records, "cpu");
	const slice = find(records, "slice");
	const memoryKib = int(host.memory_kib);
	const totalKib = int(disk.total_kib);
	const freeKib = int(disk.free_kib);
	const busy = int(cpu.busy);
	const total = int(cpu.total);
	const availableKib = int(host.available_kib);
	const jobFiles = records
		.filter((record) => record.kind === "jobfile")
		.flatMap((record): JobFile[] => {
			const slot = int(record.fields.id);
			const job = parseJob(record.fields.job);
			if (!slot || !job) return [];
			return [{ slot, runnerName: record.fields.name || null, job }];
		});
	return {
		runtimeVersion: int(find(records, "runtime").version) ?? 0,
		host:
			int(host.cpus) && memoryKib
				? {
						cpus: int(host.cpus) ?? 0,
						memoryBytes: memoryKib * 1024,
						availableBytes: availableKib === null ? null : availableKib * 1024,
						arch: host.arch ?? "",
						load: float(host.load),
					}
				: null,
		disk:
			totalKib !== null && freeKib !== null
				? { totalBytes: totalKib * 1024, freeBytes: freeKib * 1024 }
				: null,
		release: find(records, "release").current || null,
		cpu: busy !== null && total !== null ? { busy, total } : null,
		slice: {
			usageUsec: int(slice.usage_usec),
			memoryCurrentBytes: int(slice.memory_current),
			memoryMaxBytes: int(slice.memory_max),
		},
		dockerActive: find(records, "docker").state === "active",
		slots: records
			.filter((record) => record.kind === "slot")
			.flatMap((record): LocalSlot[] => {
				const slot = int(record.fields.id);
				if (!slot) return [];
				const runnerName = record.fields.name || null;
				const file = jobFiles.find(
					(item) => item.slot === slot && item.runnerName === runnerName,
				);
				return [
					{
						slot,
						active: record.fields.active ?? "inactive",
						since: int(record.fields.since),
						runnerName,
						job: file?.job ?? null,
					},
				];
			}),
		jobFiles,
		spares: records
			.filter((record) => record.kind === "spare")
			.flatMap((record) => {
				const slot = int(record.fields.slot);
				const createdAt = int(record.fields.created);
				const name = record.fields.name ?? "";
				return slot && createdAt && /^[A-Za-z0-9._-]+$/.test(name)
					? [{ slot, name, createdAt }]
					: [];
			}),
		autonomy: (() => {
			const record = find(records, "autonomy");
			const armed = int(record.armed);
			const last = int(record.last);
			return armed && last ? { armed, last } : null;
		})(),
		autonomySetting: (() => {
			const record = records.find((item) => item.kind === "autonomyset");
			if (!record) return null;
			if (record.fields.state === "off") return "off";
			const { max_runners, min_free_kib, firewall } = record.fields;
			return int(max_runners) !== null && int(min_free_kib) !== null && firewall
				? `on ${int(max_runners)} ${int(min_free_kib)} ${firewall}`
				: null;
		})(),
	};
};

export interface MacStatus {
	host: {
		cpus: number;
		memoryBytes: number;
		arch: string;
		version: string;
		load: number | null;
	} | null;
	memoryFreePercent: number | null;
	disk: { totalBytes: number; freeBytes: number } | null;
	githubReachable: boolean;
	limaVersion: string | null;
	/** Lima installed by Dokploy in ~/.dokploy, rather than Homebrew's. */
	limaManaged: boolean;
	/** What the setup script configures, as the machine reports it now. */
	setup: {
		admin: boolean;
		/** System sleep after this many minutes; 0 never sleeps. */
		sleepMinutes: number | null;
		fileVault: boolean;
		bootDaemon: boolean;
	} | null;
	vm: {
		status: string;
		cpus: number | null;
		memoryBytes: number | null;
		diskBytes: number | null;
		type: string | null;
	};
	/** Runtime status inside the VM; null when it is not running. */
	guest: RuntimeStatus | null;
	guestError: string | null;
}

export const parseMacStatus = (output: string): MacStatus => {
	const records = parseRecords(output);
	const host = find(records, "mac");
	const disk = find(records, "macdisk");
	const vm = find(records, "vm");
	const guestLines = output
		.split("\n")
		.filter((line) => line.startsWith("guest: "))
		.map((line) => line.slice("guest: ".length));
	const guestRecords = parseRecords(guestLines.join("\n"));
	// A status that stopped half-way may miss the slots that run: an error.
	const hasGuest =
		guestRecords.some((record) => record.kind === "runtime") &&
		!guestRecords.some((record) => record.kind === "statusfail");
	const memoryBytes = int(host.memory_bytes);
	const totalKib = int(disk.total_kib);
	const freeKib = int(disk.free_kib);
	return {
		host:
			int(host.cpus) && memoryBytes
				? {
						cpus: int(host.cpus) ?? 0,
						memoryBytes,
						arch: host.arch ?? "",
						version: host.version ?? "",
						load: float(host.load),
					}
				: null,
		memoryFreePercent: float(find(records, "macmem").free_percent),
		disk:
			totalKib !== null && freeKib !== null
				? { totalBytes: totalKib * 1024, freeBytes: freeKib * 1024 }
				: null,
		githubReachable: /^[1-5]\d\d$/.test(find(records, "network").github ?? ""),
		limaVersion: find(records, "lima").version || null,
		limaManaged: find(records, "lima").managed === "yes",
		setup: (() => {
			const facts = find(records, "macsetup");
			return facts.admin
				? {
						admin: facts.admin === "yes",
						sleepMinutes: int(facts.sleep),
						fileVault: facts.filevault === "on",
						bootDaemon: facts.daemon === "yes",
					}
				: null;
		})(),
		vm: {
			status: vm.status ?? "missing",
			cpus: int(vm.cpus),
			memoryBytes: int(vm.memory_bytes),
			diskBytes: int(vm.disk_bytes),
			type: vm.type ?? null,
		},
		guest: hasGuest ? parseRuntimeStatus(guestRecords) : null,
		guestError:
			guestLines.length && !hasGuest
				? guestLines.join("\n").trim().slice(0, 500)
				: null,
	};
};

export interface LinuxFacts {
	kernel: string;
	arch: string;
	distro: string;
	distroVersion: string;
	cpus: number;
	memoryBytes: number;
	root: boolean;
	sudo: boolean;
	systemd: boolean;
	cgroupV2: boolean;
	apt: boolean;
	diskFreeBytes: number | null;
	diskTotalBytes: number | null;
	docker: { present: boolean; swarm: string | null; containers: number | null };
	githubReachable: boolean;
	runtimeVersion: number;
}

export const parseLinuxFacts = (output: string): LinuxFacts => {
	const records = parseRecords(output);
	const os = find(records, "os");
	const distro = find(records, "distro");
	const host = find(records, "host");
	const user = find(records, "user");
	const disk = find(records, "disk");
	const docker = find(records, "docker");
	const totalKib = int(disk.total_kib);
	const freeKib = int(disk.free_kib);
	return {
		kernel: os.kernel ?? "",
		arch: os.arch ?? "",
		distro: distro.id ?? "unknown",
		distroVersion: distro.version ?? "",
		cpus: int(host.cpus) ?? 0,
		memoryBytes: (int(host.memory_kib) ?? 0) * 1024,
		root: user.root === "yes",
		sudo: user.sudo === "yes",
		systemd: find(records, "systemd").present === "yes",
		cgroupV2: find(records, "cgroup").fs === "cgroup2fs",
		apt: find(records, "apt").present === "yes",
		diskFreeBytes: freeKib === null ? null : freeKib * 1024,
		diskTotalBytes: totalKib === null ? null : totalKib * 1024,
		docker: {
			present: docker.present === "yes",
			swarm: docker.swarm ?? null,
			containers: int(docker.containers),
		},
		githubReachable: /^[1-5]\d\d$/.test(find(records, "network").github ?? ""),
		runtimeVersion: int(find(records, "runtime").version) ?? 0,
	};
};

const SIZE_UNITS: Record<string, number> = {
	B: 1,
	KB: 1e3,
	kB: 1e3,
	MB: 1e6,
	GB: 1e9,
	TB: 1e12,
};

/** Parses the human sizes of `docker system df` ("1.234GB", "0B"). */
export const parseDockerSize = (value: string | undefined) => {
	const match = value?.match(/^([\d.]+)\s*([kKMGT]?B)$/);
	if (!match?.[1] || !match[2]) return null;
	const unit = SIZE_UNITS[match[2]] ?? SIZE_UNITS[match[2].toUpperCase()];
	return unit ? Math.round(Number(match[1]) * unit) : null;
};

export const parseCaches = (output: string, at: Date): GithubRunnerCaches => {
	const records = parseRecords(output);
	const docker = (type: string) =>
		records.find(
			(record) => record.kind === "docker" && record.fields.type === type,
		)?.fields;
	const dir = (name: string) => {
		const kib = int(
			records.find(
				(record) => record.kind === "dir" && record.fields.name === name,
			)?.fields.kib,
		);
		return kib === null ? null : kib * 1024;
	};
	const reclaimable = ["Images", "Containers", "Local_Volumes", "Build_Cache"]
		.map((type) => parseDockerSize(docker(type)?.reclaimable))
		.filter((value): value is number => value !== null);
	return {
		at: at.toISOString(),
		dockerImagesBytes: parseDockerSize(docker("Images")?.size),
		dockerContainersBytes: parseDockerSize(docker("Containers")?.size),
		dockerVolumesBytes: parseDockerSize(docker("Local_Volumes")?.size),
		dockerBuildCacheBytes: parseDockerSize(docker("Build_Cache")?.size),
		dockerReclaimableBytes: reclaimable.length
			? reclaimable.reduce((sum, value) => sum + value, 0)
			: null,
		toolCacheBytes: dir("tool_cache"),
		homeCacheBytes: dir("home"),
		workspacesBytes: dir("workspaces"),
	};
};

export type CleanupOutput = Pick<
	GithubRunnerCleanup,
	| "mode"
	| "freeBeforeBytes"
	| "freeAfterBytes"
	| "targetBytes"
	| "reached"
	| "idle"
	| "freed"
>;

const CLEANUP_KINDS: GithubRunnerCleanupKind[] = [
	"containers",
	"volumes",
	"images",
	"build_cache",
	"tool_cache",
	"home",
	"workspaces",
	"other",
];

/** Output of `runnerctl gc`: one `freed` line per kind, then the `gc` summary. */
export const parseCleanup = (output: string): CleanupOutput | null => {
	const records = parseRecords(output);
	const summary = records.find((record) => record.kind === "gc")?.fields;
	if (!summary) return null;
	const mode = summary.mode;
	if (mode !== "auto" && mode !== "light" && mode !== "full") return null;
	const bytes = (kib: string | undefined) => (int(kib) ?? 0) * 1024;
	const idle = summary.idle;
	const freed = records
		.filter((record) => record.kind === "freed")
		.flatMap((record) => {
			const kind = CLEANUP_KINDS.find((item) => item === record.fields.kind);
			if (!kind) return [];
			return [
				{
					kind,
					bytes: bytes(record.fields.kib),
					count: int(record.fields.count) ?? 0,
				},
			];
		})
		.filter((item) => item.bytes > 0 || item.count > 0)
		.sort((a, b) => b.bytes - a.bytes);
	return {
		mode,
		freeBeforeBytes: bytes(summary.before_kib),
		freeAfterBytes: bytes(summary.free_kib),
		targetBytes: mode === "auto" ? bytes(summary.target_kib) : null,
		reached: summary.reached === "yes",
		idle: idle === "done" || idle === "skipped-jobs" ? idle : "not-needed",
		freed,
	};
};

/** Output of `runnerctl bench`: work units per second, one core and every core. */
export const parseBenchmark = (output: string) => {
	const fields = parseRecords(output).find(
		(record) => record.kind === "bench",
	)?.fields;
	const cpus = int(fields?.cpus);
	const single = int(fields?.single);
	const multi = int(fields?.multi);
	return cpus && single && multi ? { cpus, single, multi } : null;
};
