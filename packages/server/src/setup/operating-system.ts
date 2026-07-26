const LINUX_OPERATING_SYSTEM_ALIASES = {
	"manjaro | manjaro-arm": "arch",
	"fedora-asahi-remix": "fedora",
	pop: "ubuntu",
	linuxmint: "ubuntu",
	zorin: "ubuntu",
} as const;

const SUPPORTED_LINUX_OPERATING_SYSTEMS = [
	"arch",
	"ubuntu",
	"debian",
	"raspbian",
	"centos",
	"fedora",
	"rhel",
	"ol",
	"rocky",
	"sles",
	"opensuse-leap",
	"opensuse-tumbleweed",
	"almalinux",
	"opencloudos",
	"amzn",
	"alpine",
] as const;

const validateShellVariable = (variableName: string) => {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variableName)) {
		throw new Error(`Invalid shell variable name: ${variableName}`);
	}
};

export const normalizeOperatingSystemType = (variableName: string) => {
	validateShellVariable(variableName);

	const aliases = Object.entries(LINUX_OPERATING_SYSTEM_ALIASES)
		.map(
			([operatingSystems, normalizedOperatingSystem]) =>
				`${operatingSystems}) ${variableName}="${normalizedOperatingSystem}" ;;`,
		)
		.join("\n");

	return `
case "$${variableName}" in
${aliases}
esac
`;
};

export const supportedLinuxOperatingSystemCasePattern = () =>
	SUPPORTED_LINUX_OPERATING_SYSTEMS.join(" | ");
