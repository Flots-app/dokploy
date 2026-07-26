import { Client } from "ssh2";
import { findServerById } from "../services/server";
import { withRemoteCommandEnvironment } from "../utils/process/execAsync";

export const validateDocker = () => `
  dockerVersion="0.0.0"
  dockerInstalled=false
  dockerEngineEnabled=false
  dockerComposeEnabled=false
  dockerBuildxEnabled=false
  if command_exists docker; then
    dockerInstalled=true
    dockerVersion="$(docker --version | awk '{print $3}' | sed 's/,//')"
    if docker info >/dev/null 2>&1; then
      dockerEngineEnabled=true
    fi
    if docker compose version >/dev/null 2>&1; then
      dockerComposeEnabled=true
    fi
    if docker buildx version >/dev/null 2>&1; then
      dockerBuildxEnabled=true
    fi
  fi
  echo "$dockerVersion $dockerInstalled $dockerEngineEnabled $dockerComposeEnabled $dockerBuildxEnabled"
`;

export const validateRClone = () => `
  if command_exists rclone; then
    echo "$(rclone --version | head -n 1 | awk '{print $2}' | sed 's/^v//') true"
  else
    echo "0.0.0 false"
  fi
`;

export const validateSwarm = () => `
  if docker info --format '{{.Swarm.LocalNodeState}}' | grep -q 'active'; then
    echo true
  else
    echo false
  fi
`;

export const validateNixpacks = () => `
  if command_exists nixpacks; then
	version=$(nixpacks --version | awk '{print $2}')
    if [ -n "$version" ]; then
      echo "$version true"
    else
      echo "0.0.0 false"
    fi
  else
    echo "0.0.0 false"
  fi
`;

export const validateRailpack = () => `
  if command_exists railpack; then
    version=$(railpack --version | awk '{print $3}')
    if [ -n "$version" ]; then
      echo "$version true"
    else
      echo "0.0.0 false"
    fi
  else
    echo "0.0.0 false"
  fi
`;
export const validateBuildpacks = () => `
  if command_exists pack; then
    version=$(pack --version | awk '{print $1}')
    if [ -n "$version" ]; then
      echo "$version true"
    else
      echo "0.0.0 false"
    fi
  else
    echo "0.0.0 false"
  fi
`;

export const validateMainDirectory = () => `
  if [ -d "/etc/dokploy" ]; then
	echo true
  else
	echo false
  fi
`;

export const validateDokployNetwork = () => `
  if docker network ls | grep -q 'dokploy-network'; then
	echo true
  else
	echo false
  fi
`;

export const validateSudoAccess = () => `
  if [ "$(id -u)" -eq 0 ]; then
    echo "root true"
  elif sudo -n true 2>/dev/null; then
    echo "sudo true"
  else
    echo "none false"
  fi
`;

export const validateDockerGroup = () => `
  if [ "$(uname -s)" = "Darwin" ]; then
    if docker info >/dev/null 2>&1; then
      echo true
    else
      echo false
    fi
  elif groups | grep -qw docker; then
    echo true
  else
    echo false
  fi
`;

export const validateOperatingSystem = (isBuildServer: boolean) => `
  operatingSystemKernel=$(uname -s)
  operatingSystemArchitecture=$(uname -m)
  if [ "$operatingSystemKernel" = "Darwin" ]; then
    operatingSystemType="macos"
    operatingSystemVersion=$(sw_vers -productVersion)
    operatingSystemMajorVersion=$(echo "$operatingSystemVersion" | cut -d "." -f 1)
    operatingSystemSupported=false
    if [ "$operatingSystemMajorVersion" -ge 13 ] && [ "${isBuildServer ? "true" : "false"}" = "true" ]; then
      operatingSystemSupported=true
    fi
  elif [ -f /etc/os-release ]; then
    operatingSystemType=$(grep -w "ID" /etc/os-release | cut -d "=" -f 2 | tr -d '"')
    operatingSystemVersion=$(grep -w "VERSION_ID" /etc/os-release | cut -d "=" -f 2 | tr -d '"')
    operatingSystemSupported=true
  else
    operatingSystemType="unknown"
    operatingSystemVersion="unknown"
    operatingSystemSupported=false
  fi
`;

export const serverValidationCommand = (isBuildServer: boolean) => `
  command_exists() {
    command -v "$@" > /dev/null 2>&1
  }

  ${validateOperatingSystem(isBuildServer)}
  dockerVersionEnabled=$(${validateDocker()})
  rcloneVersionEnabled=$(${validateRClone()})
  nixpacksVersionEnabled=$(${validateNixpacks()})
  buildpacksVersionEnabled=$(${validateBuildpacks()})
  railpackVersionEnabled=$(${validateRailpack()})
  dockerVersion=$(echo $dockerVersionEnabled | awk '{print $1}')
  dockerInstalled=$(echo $dockerVersionEnabled | awk '{print $2}')
  dockerEngineEnabled=$(echo $dockerVersionEnabled | awk '{print $3}')
  dockerComposeEnabled=$(echo $dockerVersionEnabled | awk '{print $4}')
  dockerBuildxEnabled=$(echo $dockerVersionEnabled | awk '{print $5}')
  dockerRuntime="native"
  if [ "$operatingSystemType" = "macos" ] && command_exists colima; then
    dockerRuntime="colima"
  fi

  rcloneVersion=$(echo $rcloneVersionEnabled | awk '{print $1}')
  rcloneEnabled=$(echo $rcloneVersionEnabled | awk '{print $2}')

  nixpacksVersion=$(echo $nixpacksVersionEnabled | awk '{print $1}')
  nixpacksEnabled=$(echo $nixpacksVersionEnabled | awk '{print $2}')

  railpackVersion=$(echo $railpackVersionEnabled | awk '{print $1}')
  railpackEnabled=$(echo $railpackVersionEnabled | awk '{print $2}')

  buildpacksVersion=$(echo $buildpacksVersionEnabled | awk '{print $1}')
  buildpacksEnabled=$(echo $buildpacksVersionEnabled | awk '{print $2}')

  isDokployNetworkInstalled=$(${validateDokployNetwork()})
  isSwarmInstalled=$(${validateSwarm()})
  isMainDirectoryInstalled=$(${validateMainDirectory()})

  sudoAccessResult=$(${validateSudoAccess()})
  privilegeMode=$(echo $sudoAccessResult | awk '{print $1}')
  isDockerGroupMember=$(${validateDockerGroup()})

  echo "{\\"operatingSystem\\": {\\"type\\": \\"$operatingSystemType\\", \\"version\\": \\"$operatingSystemVersion\\", \\"architecture\\": \\"$operatingSystemArchitecture\\", \\"supported\\": $operatingSystemSupported}, \\"docker\\": {\\"version\\": \\"$dockerVersion\\", \\"enabled\\": $dockerEngineEnabled, \\"installed\\": $dockerInstalled, \\"engineEnabled\\": $dockerEngineEnabled, \\"composeEnabled\\": $dockerComposeEnabled, \\"buildxEnabled\\": $dockerBuildxEnabled, \\"runtime\\": \\"$dockerRuntime\\"}, \\"rclone\\": {\\"version\\": \\"$rcloneVersion\\", \\"enabled\\": $rcloneEnabled}, \\"nixpacks\\": {\\"version\\": \\"$nixpacksVersion\\", \\"enabled\\": $nixpacksEnabled}, \\"buildpacks\\": {\\"version\\": \\"$buildpacksVersion\\", \\"enabled\\": $buildpacksEnabled}, \\"railpack\\": {\\"version\\": \\"$railpackVersion\\", \\"enabled\\": $railpackEnabled}, \\"isDokployNetworkInstalled\\": $isDokployNetworkInstalled, \\"isSwarmInstalled\\": $isSwarmInstalled, \\"isMainDirectoryInstalled\\": $isMainDirectoryInstalled, \\"privilegeMode\\": \\"$privilegeMode\\", \\"dockerGroupMember\\": $isDockerGroupMember}"
`;

export const serverValidate = async (serverId: string) => {
	const client = new Client();
	const server = await findServerById(serverId);
	if (!server.sshKeyId) {
		throw new Error("No SSH Key found");
	}
	const isBuildServer = server.serverType === "build";

	return new Promise<string>((resolve, reject) => {
		client
			.once("ready", () => {
				client.exec(
					withRemoteCommandEnvironment(serverValidationCommand(isBuildServer)),
					(err, stream) => {
						if (err) {
							reject(err);
							return;
						}
						let output = "";
						stream
							.on("close", () => {
								client.end();
								try {
									const result = JSON.parse(output.trim());
									resolve(result);
								} catch (parseError) {
									reject(
										new Error(
											`Failed to parse output: ${parseError instanceof Error ? parseError.message : parseError}`,
										),
									);
								}
							})
							.on("data", (data: string) => {
								output += data;
							})
							.stderr.on("data", (_data) => {});
					},
				);
			})
			.on("error", (err) => {
				client.end();
				if (err.level === "client-authentication") {
					reject(
						new Error(
							`Authentication failed: Invalid SSH private key. ❌ Error: ${err.message} ${err.level}`,
						),
					);
				} else {
					reject(new Error(`SSH connection error: ${err.message}`));
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
