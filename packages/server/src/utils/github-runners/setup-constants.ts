/** Shared by the setup script and the browser, without Node dependencies. */
export const MANAGER_ACCOUNT = "dokploy-manager";
export const SETUP_CODE_PREFIX = "dokploy-runner-setup:";
/** A machine name: it prefixes the runner names and goes into shell scripts. */
export const MACHINE_NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;
/** LaunchDaemon that starts the runner VM of a Mac at boot. */
export const BOOT_DAEMON = "com.dokploy.github-runners";

/**
 * What Virtualization.framework shares with a Linux VM to run x86_64 programs:
 * present once Rosetta is installed on the Mac (see x64.ts).
 */
export const ROSETTA_LINUX = "/Library/Apple/usr/libexec/oah/RosettaLinux";
