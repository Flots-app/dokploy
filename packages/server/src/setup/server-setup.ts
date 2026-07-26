import path from "node:path";
import { IS_CLOUD, paths } from "@dokploy/server/constants";
import { getDokployUrl } from "@dokploy/server/services/admin";
import {
	createServerDeployment,
	updateDeploymentStatus,
} from "@dokploy/server/services/deployment";
import {
	findServerById,
	updateServerById,
} from "@dokploy/server/services/server";
import {
	getDefaultMiddlewares,
	getDefaultServerTraefikConfig,
	TRAEFIK_HTTP3_PORT,
	TRAEFIK_PORT,
	TRAEFIK_SSL_PORT,
	TRAEFIK_VERSION,
} from "@dokploy/server/setup/traefik-setup";
import slug from "slugify";
import { Client } from "ssh2";
import { recreateDirectory } from "../utils/filesystem/directory";
import {
	remoteCommandEnvironment,
	withRemoteCommandEnvironment,
} from "../utils/process/execAsync";
import { setupMonitoring } from "./monitoring-setup";

const generateToken = () => {
	const array = new Uint8Array(64);
	crypto.getRandomValues(array);
	return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
};

export const slugify = (text: string | undefined) => {
	if (!text) {
		return "";
	}

	const cleanedText = text.trim().replace(/[^a-zA-Z0-9\s]/g, "");

	return slug(cleanedText, {
		lower: true,
		trim: true,
		strict: true,
	});
};

export const serverSetup = async (
	serverId: string,
	onData?: (data: any) => void,
) => {
	const server = await findServerById(serverId);
	const { LOGS_PATH } = paths();

	const slugifyName = slugify(`server ${server.name}`);

	const fullPath = path.join(LOGS_PATH, slugifyName);

	await recreateDirectory(fullPath);

	const deployment = await createServerDeployment({
		serverId: server.serverId,
		title: "Setup Server",
		description: "Setup Server",
	});

	try {
		const isBuildServer = server.serverType === "build";
		onData?.(
			isBuildServer
				? "\nInstalling Build Server Dependencies: ✅\n"
				: "\nInstalling Server Dependencies: ✅\n",
		);
		await installRequirements(serverId, onData);

		if (IS_CLOUD) {
			onData?.("\nConfiguring Monitoring: 🔄\n");

			const baseUrl = await getDokployUrl();
			const token = generateToken();
			const urlCallback = `${baseUrl}/api/trpc/notification.receiveNotification`;

			// Update server with monitoring configuration
			await updateServerById(serverId, {
				metricsConfig: {
					server: {
						...server.metricsConfig.server,
						token: token,
						urlCallback: urlCallback,
					},
					containers: server.metricsConfig.containers,
				},
			});

			await setupMonitoring(serverId);
			onData?.("\nMonitoring Configured: ✅\n");
		}

		await updateDeploymentStatus(deployment.deploymentId, "done");

		onData?.("\nSetup Server: ✅\n");
	} catch (err) {
		console.log(err);

		await updateDeploymentStatus(deployment.deploymentId, "error");
		onData?.(`${err} ❌\n`);
	}
};

export const reportDockerVersion = () => `
if command -v docker >/dev/null 2>&1; then
	INSTALLED_DOCKER_VERSION=$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)
	if [ -z "$INSTALLED_DOCKER_VERSION" ]; then
		INSTALLED_DOCKER_VERSION=$(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',' || true)
	fi
	if [ -z "$INSTALLED_DOCKER_VERSION" ]; then
		INSTALLED_DOCKER_VERSION="unknown"
	fi
	DOCKER_VERSION_REPORT="$INSTALLED_DOCKER_VERSION (already installed)"
else
	DOCKER_VERSION_REPORT="$DOCKER_VERSION (will be installed)"
fi
`;

export const validateBuildServerDependencies = () => `
	echo "Validating Build Server dependencies."
	for dependency in git nixpacks pack railpack docker; do
		if ! command -v "$dependency" >/dev/null 2>&1; then
			echo "Required Build Server dependency '$dependency' is unavailable in PATH. ❌" >&2
			exit 1
		fi
	done
	if ! docker info >/dev/null 2>&1; then
		echo "Docker CLI is installed but the Docker engine is unavailable. ❌" >&2
		exit 1
	fi
	if ! docker compose version >/dev/null 2>&1; then
		echo "Docker Compose plugin is unavailable. ❌" >&2
		exit 1
	fi
	if ! docker buildx version >/dev/null 2>&1; then
		echo "Docker Buildx plugin is unavailable. ❌" >&2
		exit 1
	fi
	echo "Build Server dependencies validated ✅"
`;

export const detectOperatingSystem = (isBuildServer = false) => `
IS_BUILD_SERVER=${isBuildServer ? "true" : "false"}
KERNEL_NAME=$(uname -s)
SYS_ARCH=$(uname -m)

if [ "$KERNEL_NAME" = "Darwin" ]; then
	OS_TYPE="macos"
	OS_VERSION=$(sw_vers -productVersion)
	MACOS_MAJOR_VERSION=$(echo "$OS_VERSION" | cut -d "." -f 1)
	if [ "$MACOS_MAJOR_VERSION" -lt 13 ]; then
		echo "macOS 13 or newer is required for Build Servers. Detected $OS_VERSION. ❌" >&2
		exit 1
	fi
else
	if [ ! -f /etc/os-release ]; then
		echo "Unsupported operating system: /etc/os-release is missing. ❌" >&2
		exit 1
	fi
	OS_TYPE=$(grep -w "ID" /etc/os-release | cut -d "=" -f 2 | tr -d '"')

	if [ "$OS_TYPE" = "arch" ] || [ "$OS_TYPE" = "archarm" ]; then
		OS_VERSION="rolling"
	else
		OS_VERSION=$(grep -w "VERSION_ID" /etc/os-release | cut -d "=" -f 2 | tr -d '"')
	fi
fi

if [ "$OS_TYPE" = "macos" ] && [ "$IS_BUILD_SERVER" != "true" ]; then
	echo "macOS is supported only for Build Servers. Runtime/deploy servers must use Linux. ❌" >&2
	exit 1
fi
`;

export const defaultCommand = (isBuildServer = false) => {
	const bashCommand = `
set -e
${remoteCommandEnvironment()}
DOCKER_VERSION=28.5.0
${detectOperatingSystem(isBuildServer)}
CURRENT_USER=$(id -un)
CURRENT_GROUP=$(id -gn "$CURRENT_USER")

echo "Installing requirements for: OS: $OS_TYPE"

# Auto-detect sudo requirement
if [ "$(id -u)" -eq 0 ]; then
	SUDO_CMD=""
	echo "Running as root"
else
	if sudo -n true 2>/dev/null; then
		SUDO_CMD="sudo"
		echo "Running as $CURRENT_USER with sudo privileges"
	else
		echo "Error: Non-root user requires passwordless sudo access. ❌"
		echo "Configure with: echo '$CURRENT_USER ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/$CURRENT_USER"
		exit 1
	fi
fi

# Check if the OS is manjaro, if so, change it to arch
if [ "$OS_TYPE" = "manjaro" ] || [ "$OS_TYPE" = "manjaro-arm" ]; then
	OS_TYPE="arch"
fi

# Check if the OS is Asahi Linux, if so, change it to fedora
if [ "$OS_TYPE" = "fedora-asahi-remix" ]; then
	OS_TYPE="fedora"
fi

# Check if the OS is popOS, if so, change it to ubuntu
if [ "$OS_TYPE" = "pop" ]; then
	OS_TYPE="ubuntu"
fi

# Check if the OS is linuxmint, if so, change it to ubuntu
if [ "$OS_TYPE" = "linuxmint" ]; then
	OS_TYPE="ubuntu"
fi

#Check if the OS is zorin, if so, change it to ubuntu
if [ "$OS_TYPE" = "zorin" ]; then
	OS_TYPE="ubuntu"
fi

if [ "$OS_TYPE" != "macos" ] && [ "$OS_TYPE" != "arch" ] && [ "$OS_TYPE" != "archarm" ]; then
	OS_VERSION=$(grep -w "VERSION_ID" /etc/os-release | cut -d "=" -f 2 | tr -d '"')
fi

if [ "$OS_TYPE" = 'amzn' ]; then
    $SUDO_CMD dnf install -y findutils >/dev/null
fi

case "$OS_TYPE" in
arch | ubuntu | debian | raspbian | centos | fedora | rhel | ol | rocky | sles | opensuse-leap | opensuse-tumbleweed | almalinux | opencloudos | amzn | alpine | macos) ;;
*)
	echo "This script supports macOS Build Servers and Debian, Redhat, Arch Linux, Alpine Linux, or SLES based operating systems. ❌" >&2
	exit 1
	;;
esac

${reportDockerVersion()}
echo -e "---------------------------------------------"
echo "| CPU Architecture  | $SYS_ARCH"
echo "| Operating System  | $OS_TYPE $OS_VERSION"
echo "| Docker            | $DOCKER_VERSION_REPORT"
${isBuildServer ? 'echo "| Server Type       | Build Server"' : ""}
echo -e "---------------------------------------------\n"
echo -e "1. Installing required packages (curl, wget, git, jq, openssl). "

command_exists() {
	command -v "$@" > /dev/null 2>&1
}

${installUtilities()}

${
	!isBuildServer
		? `
echo -e "2. Validating ports. "
${validatePorts()}



echo -e "3. Installing RClone. "
${installRClone()}

echo -e "4. Installing Docker. "
${installDocker()}

echo -e "5. Setting up Docker Swarm"
${setupSwarm()}

echo -e "6. Setting up Network"
${setupNetwork()}

echo -e "7. Setting up Directories"
${setupMainDirectory()}
${setupDirectories()}

echo -e "8. Setting up Traefik"
${createTraefikConfig()}

echo -e "9. Setting up Middlewares"
${createDefaultMiddlewares()}

echo -e "10. Setting up Traefik Instance"
${createTraefikInstance()}

echo -e "11. Installing Nixpacks"
${installNixpacks()}

echo -e "12. Installing Buildpacks"
${installBuildpacks()}

echo -e "13. Installing Railpack"
${installRailpack()}

echo -e "14. Configuring permissions"
${setupPermissions()}
`
		: `
echo -e "2. Installing Docker. "
${installDocker()}

echo -e "3. Setting up Directories"
${setupMainDirectory()}
${setupDirectories()}

echo -e "4. Installing Nixpacks"
${installNixpacks()}

echo -e "5. Installing Buildpacks"
${installBuildpacks()}

echo -e "6. Installing Railpack"
${installRailpack()}

echo -e "7. Configuring permissions"
${setupPermissions()}

echo -e "8. Validating Build Server"
${validateBuildServerDependencies()}
`
}
				`;

	return bashCommand;
};

const installRequirements = async (
	serverId: string,
	onData?: (data: any) => void,
) => {
	const client = new Client();
	const server = await findServerById(serverId);
	if (!server.sshKeyId) {
		onData?.("❌ No SSH Key found, please assign one to this server");
		throw new Error("No SSH Key found");
	}

	const isBuildServer = server.serverType === "build";

	return new Promise<void>((resolve, reject) => {
		client
			.once("ready", () => {
				const command = server.command || defaultCommand(isBuildServer);
				const remoteCommand = withRemoteCommandEnvironment(command);
				client.exec(remoteCommand, (err, stream) => {
					if (err) {
						onData?.(err.message);
						reject(err);
						return;
					}
					stream
						.on("close", (code: number | null, signal: string) => {
							client.end();
							if (code === 0) {
								resolve();
								return;
							}
							reject(
								new Error(
									`Setup command failed with exit code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`,
								),
							);
						})
						.on("data", (data: string) => {
							onData?.(data.toString());
						})
						.stderr.on("data", (data) => {
							onData?.(data.toString());
						});
				});
			})
			.on("error", (err) => {
				client.end();
				if (err.level === "client-authentication") {
					const technicalDetail = `Error: ${err.message} ${err.level}`;
					const friendlyMessage = [
						"",
						"❌ Couldn't connect to your server — the SSH key was not accepted.",
						"",
						"This usually means the key doesn't match what's on the server, or the key format is invalid.",
						"",
						`Technical details: ${technicalDetail}`,
						"",
						"💡 Hints:",
						"  • Check that the SSH key you added in Dokploy is the same one installed on the server (e.g. in ~/.ssh/authorized_keys).",
						"  • Try generating a new SSH key in Dokploy and add only the public key to the server, then try again.",
						"  • Make sure to follow the instructions on the Setup Server Button on the SSH Keys tab",
					].join("\n");
					onData?.(friendlyMessage);
					reject(
						new Error(
							`Authentication failed: Invalid SSH private key. ${technicalDetail}`,
						),
					);
				} else {
					const technicalDetail = `${err.message} ${err.level ?? ""}`.trim();
					const friendlyMessage = [
						"",
						"❌ Couldn't connect to your server.",
						"",
						"The connection failed before setup could run. Common causes: wrong IP or port, firewall blocking access, or the server is offline.",
						"",
						`Technical details: ${technicalDetail}`,
						"",
						"💡 Hints:",
						"  • Check that the server IP address and SSH port are correct and the server is powered on.",
						"  • If the server is in a private network, ensure Dokploy can reach it (VPN, firewall rules, or correct security groups).",
						"  • Make sure the SSH port (usually 22) is open and the SSH service is running on the server.",
					].join("\n");
					onData?.(friendlyMessage);
					reject(new Error(`SSH connection error: ${technicalDetail}`));
				}
			})
			.connect({
				host: server.ipAddress,
				port: server.port,
				username: server.username,
				privateKey: server.sshKey?.privateKey,
			});
	});
};

const setupDirectories = () => {
	const { SSH_PATH } = paths(true);
	const directories = Object.values(paths(true));

	const createDirsCommand = directories
		.map((dir) => `mkdir -p "${dir}"`)
		.join(" && ");
	const chmodCommand = `chmod 700 "${SSH_PATH}"`;

	const command = `
	${createDirsCommand}
	${chmodCommand}
	`;

	return command;
};

const setupMainDirectory = () => `
	# Check if the /etc/dokploy directory exists
	if [ -d /etc/dokploy ]; then
		echo "/etc/dokploy already exists ✅"
	else
		# Create the /etc/dokploy directory
		$SUDO_CMD mkdir -p /etc/dokploy
		echo "Directory /etc/dokploy created ✅"
	fi
	# Ensure the current user owns the directory
	if [ -n "$SUDO_CMD" ]; then
		$SUDO_CMD chown -R "$CURRENT_USER:$CURRENT_GROUP" /etc/dokploy
	fi
`;

export const setupSwarm = () => `
		# Check if the node is already part of a Docker Swarm
		if $SUDO_CMD docker info | grep -q 'Swarm: active'; then
			echo "Already part of a Docker Swarm ✅"
		else
			# Get IP address
			get_ip() {
				local ip=""

				# Try IPv4 with multiple services
				# First attempt: ifconfig.io
				ip=\$(curl -4s --connect-timeout 5 https://ifconfig.io 2>/dev/null)

				# Second attempt: icanhazip.com
				if [ -z "\$ip" ]; then
					ip=\$(curl -4s --connect-timeout 5 https://icanhazip.com 2>/dev/null)
				fi

				# Third attempt: ipecho.net
				if [ -z "\$ip" ]; then
					ip=\$(curl -4s --connect-timeout 5 https://ipecho.net/plain 2>/dev/null)
				fi

				# If no IPv4, try IPv6 with multiple services
				if [ -z "\$ip" ]; then
					# Try IPv6 with ifconfig.io
					ip=\$(curl -6s --connect-timeout 5 https://ifconfig.io 2>/dev/null)

					# Try IPv6 with icanhazip.com
					if [ -z "\$ip" ]; then
						ip=\$(curl -6s --connect-timeout 5 https://icanhazip.com 2>/dev/null)
					fi

					# Try IPv6 with ipecho.net
					if [ -z "\$ip" ]; then
						ip=\$(curl -6s --connect-timeout 5 https://ipecho.net/plain 2>/dev/null)
					fi
				fi

				if [ -z "\$ip" ]; then
					echo "Error: Could not determine server IP address automatically (neither IPv4 nor IPv6)." >&2
					echo "Please set the ADVERTISE_ADDR environment variable manually." >&2
					echo "Example: export ADVERTISE_ADDR=<your-server-ip>" >&2
					exit 1
				fi

				echo "\$ip"
			}
			advertise_addr=\$(get_ip)
			echo "Advertise address: \$advertise_addr"

			# Initialize Docker Swarm
			$SUDO_CMD docker swarm init --advertise-addr \$advertise_addr
			echo "Swarm initialized ✅"
		fi
	`;

const setupNetwork = () => `
	# Check if the dokploy-network already exists
	if $SUDO_CMD docker network ls | grep -q 'dokploy-network'; then
		echo "Network dokploy-network already exists ✅"
	else
		# Create the dokploy-network if it doesn't exist
		if $SUDO_CMD docker network create --driver overlay --attachable dokploy-network; then
			echo "Network created ✅"
		else
			echo "Failed to create dokploy-network ❌" >&2
			exit 1
		fi
	fi
`;

const validatePorts = () => `
	# check if something is running on port 80
	if ss -tulnp | grep ':80 ' >/dev/null; then
		echo "Something is already running on port 80" >&2
	fi

	# check if something is running on port 443
	if ss -tulnp | grep ':443 ' >/dev/null; then
		echo "Something is already running on port 443" >&2
	fi
`;

const installUtilities = () => `

	case "$OS_TYPE" in
	macos)
		if ! xcode-select -p >/dev/null 2>&1; then
			echo "Xcode Command Line Tools are required on macOS. Run 'xcode-select --install' in the logged-in desktop session, then retry. ❌" >&2
			exit 1
		fi

		if ! command -v brew >/dev/null 2>&1; then
			echo "Installing Homebrew..."
			NONINTERACTIVE=1 CI=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
		fi

		if [ -x /opt/homebrew/bin/brew ]; then
			eval "$(/opt/homebrew/bin/brew shellenv)"
		elif [ -x /usr/local/bin/brew ]; then
			eval "$(/usr/local/bin/brew shellenv)"
		else
			echo "Homebrew installation completed but brew is not available in a supported prefix. ❌" >&2
			exit 1
		fi

		export HOMEBREW_NO_AUTO_UPDATE=1
		brew install curl wget git git-lfs jq openssl
		git lfs install --skip-repo
		;;
	arch)
		$SUDO_CMD pacman -Sy --noconfirm --needed curl wget git git-lfs jq openssl >/dev/null || true
		;;
	alpine)
		$SUDO_CMD sed -i '/^#.*\/community/s/^#//' /etc/apk/repositories
		$SUDO_CMD apk update >/dev/null
		$SUDO_CMD apk add curl wget git git-lfs jq openssl sudo unzip tar >/dev/null
		;;
	ubuntu | debian | raspbian)
		export DEBIAN_FRONTEND=noninteractive
		$SUDO_CMD apt-get update -y >/dev/null
		$SUDO_CMD apt-get install -y unzip curl wget git git-lfs jq openssl >/dev/null
		;;
	centos | fedora | rhel | ol | rocky | almalinux | opencloudos | amzn)
		if [ "$OS_TYPE" = "amzn" ]; then
			$SUDO_CMD dnf install -y wget git git-lfs jq openssl >/dev/null
		else
			if ! command -v dnf >/dev/null; then
				$SUDO_CMD yum install -y dnf >/dev/null
			fi
			if ! command -v curl >/dev/null; then
				$SUDO_CMD dnf install -y curl >/dev/null
			fi
			$SUDO_CMD dnf install -y wget git git-lfs jq openssl unzip >/dev/null
		fi
		;;
	sles | opensuse-leap | opensuse-tumbleweed)
		$SUDO_CMD zypper refresh >/dev/null
		$SUDO_CMD zypper install -y curl wget git git-lfs jq openssl >/dev/null
		;;
	*)
		echo "This script supports macOS Build Servers and Debian, Redhat, Arch Linux, Alpine Linux, or SLES based operating systems. ❌" >&2
		exit 1
		;;
	esac
`;

export const installMacDocker = () => `
	echo "Installing the macOS Docker build runtime with Homebrew and Colima."
	export HOMEBREW_NO_AUTO_UPDATE=1
	brew install colima docker docker-compose docker-buildx

	HOMEBREW_PREFIX=$(brew --prefix)
	DOCKER_CONFIG_DIR="$HOME/.docker"
	DOCKER_CONFIG_FILE="$DOCKER_CONFIG_DIR/config.json"
	DOCKER_PLUGIN_DIR="$HOMEBREW_PREFIX/lib/docker/cli-plugins"
	mkdir -p "$DOCKER_CONFIG_DIR"

	if [ -s "$DOCKER_CONFIG_FILE" ] && ! jq empty "$DOCKER_CONFIG_FILE" >/dev/null 2>&1; then
		echo "Docker config $DOCKER_CONFIG_FILE is not valid JSON; refusing to overwrite it. ❌" >&2
		exit 1
	fi

	DOCKER_CONFIG_TMP=$(mktemp)
	if [ -s "$DOCKER_CONFIG_FILE" ]; then
		jq --arg pluginDir "$DOCKER_PLUGIN_DIR" \
			'.cliPluginsExtraDirs = (((.cliPluginsExtraDirs // []) + [$pluginDir]) | unique)' \
			"$DOCKER_CONFIG_FILE" > "$DOCKER_CONFIG_TMP"
	else
		jq -n --arg pluginDir "$DOCKER_PLUGIN_DIR" \
			'{cliPluginsExtraDirs: [$pluginDir]}' > "$DOCKER_CONFIG_TMP"
	fi
	chmod 600 "$DOCKER_CONFIG_TMP"
	mv "$DOCKER_CONFIG_TMP" "$DOCKER_CONFIG_FILE"

	if brew services list | awk '$1 == "colima" && $2 == "started" { found=1 } END { exit !found }'; then
		echo "Colima autostart is already configured ✅"
	else
		HOST_CPUS=$(sysctl -n hw.ncpu)
		HOST_MEMORY_BYTES=$(sysctl -n hw.memsize)
		COLIMA_CPUS=$((HOST_CPUS / 2))
		COLIMA_MEMORY=$((HOST_MEMORY_BYTES / 1024 / 1024 / 1024 / 2))
		COLIMA_DISK=100

		if [ "$COLIMA_CPUS" -lt 2 ]; then COLIMA_CPUS=2; fi
		if [ "$COLIMA_CPUS" -gt 8 ]; then COLIMA_CPUS=8; fi
		if [ "$COLIMA_MEMORY" -lt 4 ]; then COLIMA_MEMORY=4; fi
		if [ "$COLIMA_MEMORY" -gt 16 ]; then COLIMA_MEMORY=16; fi

		if [ -n "$DOKPLOY_COLIMA_CPUS" ]; then COLIMA_CPUS="$DOKPLOY_COLIMA_CPUS"; fi
		if [ -n "$DOKPLOY_COLIMA_MEMORY" ]; then COLIMA_MEMORY="$DOKPLOY_COLIMA_MEMORY"; fi
		if [ -n "$DOKPLOY_COLIMA_DISK" ]; then COLIMA_DISK="$DOKPLOY_COLIMA_DISK"; fi

		echo "Initializing Colima with $COLIMA_CPUS CPUs, $COLIMA_MEMORY GiB memory and $COLIMA_DISK GiB disk."
		if colima status >/dev/null 2>&1; then
			colima stop
		fi
		colima start --runtime docker --cpu "$COLIMA_CPUS" --memory "$COLIMA_MEMORY" --disk "$COLIMA_DISK"
		colima stop
		brew services start colima
	fi

	DOCKER_READY=false
	_attempt=0
	while [ "$_attempt" -lt 60 ]; do
		if docker info >/dev/null 2>&1; then
			DOCKER_READY=true
			break
		fi
		_attempt=$((_attempt + 1))
		sleep 2
	done

	if [ "$DOCKER_READY" != "true" ]; then
		echo "Colima did not expose a working Docker engine within 120 seconds. Check 'brew services info colima' and 'colima status'. ❌" >&2
		exit 1
	fi

	docker compose version
	docker buildx version
	echo "macOS Docker runtime is ready and configured for autostart ✅"
`;

const installDocker = () => `

if [ "$OS_TYPE" = "macos" ]; then
	${installMacDocker()}
else
# Detect if docker is installed via snap
if [ -x "$(command -v snap)" ]; then
    SNAP_DOCKER_INSTALLED=$(snap list docker >/dev/null 2>&1 && echo "true" || echo "false")
    if [ "$SNAP_DOCKER_INSTALLED" = "true" ]; then
        echo " - Docker is installed via snap."
        echo "   Please note that Dokploy does not support Docker installed via snap."
        echo "   Please remove Docker with snap (snap remove docker) and reexecute this script."
        exit 1
    fi
fi

echo -e "3. Check Docker Installation. "
if ! [ -x "$(command -v docker)" ]; then
    echo " - Docker is not installed. Installing Docker. It may take a while."
    case "$OS_TYPE" in
        "almalinux" | "rocky" | "centos" | "rhel" | "ol")
            $SUDO_CMD dnf config-manager --add-repo=https://download.docker.com/linux/centos/docker-ce.repo >/dev/null 2>&1
            $SUDO_CMD dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null 2>&1
            if ! [ -x "$(command -v docker)" ]; then
                echo " - Docker could not be installed automatically. Please visit https://docs.docker.com/engine/install/ and install Docker manually to continue."
                exit 1
            fi
            $SUDO_CMD systemctl start docker >/dev/null 2>&1
            $SUDO_CMD systemctl enable docker >/dev/null 2>&1
            ;;
	"opencloudos")
            # Special handling for OpenCloud OS
            echo " - Installing Docker for OpenCloud OS..."
            $SUDO_CMD dnf install -y docker >/dev/null 2>&1
            if ! [ -x "$(command -v docker)" ]; then
                echo " - Docker could not be installed automatically. Please visit https://docs.docker.com/engine/install/ and install Docker manually to continue."
                exit 1
            fi

            # Remove --live-restore parameter from Docker configuration if it exists
            if [ -f "/etc/sysconfig/docker" ]; then
                echo " - Removing --live-restore parameter from Docker configuration..."
                $SUDO_CMD sed -i 's/--live-restore[^[:space:]]*//' /etc/sysconfig/docker >/dev/null 2>&1
                $SUDO_CMD sed -i 's/--live-restore//' /etc/sysconfig/docker >/dev/null 2>&1
                # Clean up any double spaces that might be left
                $SUDO_CMD sed -i 's/  */ /g' /etc/sysconfig/docker >/dev/null 2>&1
            fi

            $SUDO_CMD systemctl enable docker >/dev/null 2>&1
            $SUDO_CMD systemctl start docker >/dev/null 2>&1
            echo " - Docker configured for OpenCloud OS"
            ;;
        "alpine")
            $SUDO_CMD apk add docker docker-cli-compose >/dev/null 2>&1
            $SUDO_CMD rc-update add docker default >/dev/null 2>&1
            $SUDO_CMD service docker start >/dev/null 2>&1
            if ! [ -x "$(command -v docker)" ]; then
                echo " - Failed to install Docker with apk. Try to install it manually."
                echo "   Please visit https://wiki.alpinelinux.org/wiki/Docker for more information."
                exit 1
            fi
            ;;
        "arch")
            $SUDO_CMD pacman -Sy docker docker-compose --noconfirm >/dev/null 2>&1
            $SUDO_CMD systemctl enable docker.service >/dev/null 2>&1
            if ! [ -x "$(command -v docker)" ]; then
                echo " - Failed to install Docker with pacman. Try to install it manually."
                echo "   Please visit https://wiki.archlinux.org/title/docker for more information."
                exit 1
            fi
            ;;
        "amzn")
            $SUDO_CMD dnf install docker -y >/dev/null 2>&1
            DOCKER_CONFIG=/usr/local/lib/docker
            $SUDO_CMD mkdir -p $DOCKER_CONFIG/cli-plugins >/dev/null 2>&1
            $SUDO_CMD curl -sL "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o "$DOCKER_CONFIG/cli-plugins/docker-compose" >/dev/null 2>&1
            $SUDO_CMD chmod +x $DOCKER_CONFIG/cli-plugins/docker-compose >/dev/null 2>&1
            $SUDO_CMD systemctl start docker >/dev/null 2>&1
            $SUDO_CMD systemctl enable docker >/dev/null 2>&1
            if ! [ -x "$(command -v docker)" ]; then
                echo " - Failed to install Docker with dnf. Try to install it manually."
                echo "   Please visit https://www.cyberciti.biz/faq/how-to-install-docker-on-amazon-linux-2/ for more information."
                exit 1
            fi
            ;;
        "fedora")
            if [ -x "$(command -v dnf5)" ]; then
                # dnf5 is available
                $SUDO_CMD dnf config-manager addrepo --from-repofile=https://download.docker.com/linux/fedora/docker-ce.repo --overwrite >/dev/null 2>&1
            else
                # dnf5 is not available, use dnf
                $SUDO_CMD dnf config-manager --add-repo=https://download.docker.com/linux/fedora/docker-ce.repo >/dev/null 2>&1
            fi
            $SUDO_CMD dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null 2>&1
            if ! [ -x "$(command -v docker)" ]; then
                echo " - Docker could not be installed automatically. Please visit https://docs.docker.com/engine/install/ and install Docker manually to continue."
                exit 1
            fi
            $SUDO_CMD systemctl start docker >/dev/null 2>&1
            $SUDO_CMD systemctl enable docker >/dev/null 2>&1
            ;;
        *)
            if [ "$OS_TYPE" = "ubuntu" ] && [ "$OS_VERSION" = "24.10" ]; then
                echo "Docker automated installation is not supported on Ubuntu 24.10 (non-LTS release)."
                    echo "Please install Docker manually."
                exit 1
            fi

            if ! [ -x "$(command -v docker)" ]; then
                curl -s https://get.docker.com | $SUDO_CMD sh -s -- --version $DOCKER_VERSION 2>&1
                if ! [ -x "$(command -v docker)" ]; then
                    echo " - Docker installation failed."
                    echo "   Maybe your OS is not supported?"
                    echo " - Please visit https://docs.docker.com/engine/install/ and install Docker manually to continue."
                    exit 1
                fi
            fi
			if [ "$OS_TYPE" = "rocky" ]; then
				$SUDO_CMD systemctl start docker >/dev/null 2>&1
				$SUDO_CMD systemctl enable docker >/dev/null 2>&1
			fi

			if [ "$OS_TYPE" = "centos" ]; then
				$SUDO_CMD systemctl start docker >/dev/null 2>&1
				$SUDO_CMD systemctl enable docker >/dev/null 2>&1
			fi


    esac
    echo " - Docker installed successfully."
else
    echo " - Docker is installed."
fi
fi
`;

const createTraefikConfig = () => {
	const config = getDefaultServerTraefikConfig();

	const command = `
	if [ -f "/etc/dokploy/traefik/dynamic/acme.json" ]; then
		chmod 600 "/etc/dokploy/traefik/dynamic/acme.json"
	fi
	if [ -f "/etc/dokploy/traefik/traefik.yml" ]; then
		echo "Traefik config already exists ✅"
	else
		echo "${config}" > /etc/dokploy/traefik/traefik.yml
	fi
	`;

	return command;
};

const createDefaultMiddlewares = () => {
	const config = getDefaultMiddlewares();
	const command = `
	if [ -f "/etc/dokploy/traefik/dynamic/middlewares.yml" ]; then
		echo "Middlewares config already exists ✅"
	else
		echo "${config}" > /etc/dokploy/traefik/dynamic/middlewares.yml
	fi
	`;
	return command;
};

export const installRClone = () => `
    if command_exists rclone; then
		echo "RClone already installed ✅"
	else
		curl https://rclone.org/install.sh | $SUDO_CMD bash
		RCLONE_VERSION=$(rclone --version | head -n 1 | awk '{print $2}' | sed 's/^v//')
		echo "RClone version $RCLONE_VERSION installed ✅"
	fi
`;

export const createTraefikInstance = () => {
	const command = `
	    # Check if dokpyloy-traefik exists
		if $SUDO_CMD docker service inspect dokploy-traefik > /dev/null 2>&1; then
			echo "Migrating Traefik to Standalone..."
			$SUDO_CMD docker service rm dokploy-traefik
			sleep 8
			echo "Traefik migrated to Standalone ✅"
		fi

		if $SUDO_CMD docker inspect dokploy-traefik > /dev/null 2>&1; then
			echo "Traefik already exists ✅"
		else
			# Create the dokploy-traefik container
			TRAEFIK_VERSION=${TRAEFIK_VERSION}
			$SUDO_CMD docker run -d \
				--name dokploy-traefik \
				--restart always \
				-v /etc/dokploy/traefik/traefik.yml:/etc/traefik/traefik.yml \
				-v /etc/dokploy/traefik/dynamic:/etc/dokploy/traefik/dynamic \
				-v /var/run/docker.sock:/var/run/docker.sock \
				-p ${TRAEFIK_SSL_PORT}:${TRAEFIK_SSL_PORT} \
				-p ${TRAEFIK_PORT}:${TRAEFIK_PORT} \
				-p ${TRAEFIK_HTTP3_PORT}:${TRAEFIK_HTTP3_PORT}/udp \
				traefik:v$TRAEFIK_VERSION

			$SUDO_CMD docker network connect dokploy-network dokploy-traefik;
			echo "Traefik version $TRAEFIK_VERSION installed ✅"
		fi
	`;

	return command;
};

const installNixpacks = () => `
	if command_exists nixpacks; then
		echo "Nixpacks already installed ✅"
	else
	    export NIXPACKS_VERSION=1.41.0
		if [ "$OS_TYPE" = "macos" ]; then
			curl -fsSL https://nixpacks.com/install.sh | bash -s -- --yes --bin-dir "$(brew --prefix)/bin"
		else
			$SUDO_CMD bash -c "$(curl -fsSL https://nixpacks.com/install.sh)"
		fi
		echo "Nixpacks version $NIXPACKS_VERSION installed ✅"
	fi
`;

const installRailpack = () => `
	if command_exists railpack; then
		echo "Railpack already installed ✅"
	else
	    export RAILPACK_VERSION=0.15.4
		if [ "$OS_TYPE" = "macos" ]; then
			curl -fsSL https://railpack.com/install.sh | bash -s -- --yes --bin-dir "$(brew --prefix)/bin"
		else
			$SUDO_CMD bash -c "$(curl -fsSL https://railpack.com/install.sh)"
		fi
		echo "Railpack version $RAILPACK_VERSION installed ✅"
	fi
`;

const setupPermissions = () => `
	if [ "$OS_TYPE" = "macos" ]; then
		$SUDO_CMD chown -R "$CURRENT_USER:$CURRENT_GROUP" /etc/dokploy
		echo "Permissions configured for $CURRENT_USER; Colima provides Docker access without a docker group ✅"
	# Add user to docker group if not root
	elif [ -n "$SUDO_CMD" ]; then
		if ! groups $CURRENT_USER | grep -qw docker; then
			$SUDO_CMD usermod -aG docker $CURRENT_USER
			echo "User $CURRENT_USER added to docker group ✅"
		else
			echo "User $CURRENT_USER already in docker group ✅"
		fi
		# Ensure the user owns the dokploy directory
		$SUDO_CMD chown -R "$CURRENT_USER:$CURRENT_GROUP" /etc/dokploy
		echo "Permissions configured for $CURRENT_USER ✅"
	else
		echo "Running as root, no extra permissions needed ✅"
	fi
`;

const installBuildpacks = () => `
	if command_exists pack; then
		echo "Buildpacks already installed ✅"
	else
		BUILDPACKS_VERSION=0.39.1
		SUFFIX=""
		if [ "$SYS_ARCH" = "aarch64" ] || [ "$SYS_ARCH" = "arm64" ]; then
			SUFFIX="-arm64"
		fi
		if [ "$OS_TYPE" = "macos" ]; then
			curl -sSL "https://github.com/buildpacks/pack/releases/download/v$BUILDPACKS_VERSION/pack-v$BUILDPACKS_VERSION-macos$SUFFIX.tgz" | tar -C "$(brew --prefix)/bin" --no-same-owner -xzv pack
		else
			curl -sSL "https://github.com/buildpacks/pack/releases/download/v$BUILDPACKS_VERSION/pack-v$BUILDPACKS_VERSION-linux$SUFFIX.tgz" | $SUDO_CMD tar -C /usr/local/bin/ --no-same-owner -xzv pack
		fi
		echo "Buildpacks version $BUILDPACKS_VERSION installed ✅"
	fi
`;
