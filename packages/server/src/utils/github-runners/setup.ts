/**
 * Enrollment of a runner machine. Dokploy generates a key for the machine and
 * a setup script an administrator runs once on it. The script creates the
 * account Dokploy logs in with (dokploy-manager: no admin rights on a Mac, key
 * only, no forwarding, no terminal), and prints a code to paste back in
 * Dokploy: the host keys of the machine, so the very first connection is
 * already verified, and the addresses it answers on. Nothing calls Dokploy
 * from the machine, so it works behind Cloudflare Access or a VPN.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { sh, shellQuote } from "./runtime";

import {
	BOOT_DAEMON,
	MANAGER_ACCOUNT,
	SETUP_CODE_PREFIX,
} from "./setup-constants";

export { BOOT_DAEMON, MANAGER_ACCOUNT, SETUP_CODE_PREFIX };

const PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [A-Za-z0-9@._-]+)?$/;
const MACHINE = /^[a-z0-9][a-z0-9-]{0,23}$/;

/** SHA256 fingerprint of an OpenSSH public key, as ssh-keygen prints it. */
export const publicKeyFingerprint = (publicKey: string) => {
	const blob = publicKey.trim().split(/\s+/)[1] ?? "";
	return `SHA256:${createHash("sha256")
		.update(Buffer.from(blob, "base64"))
		.digest("base64")
		.replace(/=+$/, "")}`;
};

/** Root sshd drop-in: the runner account logs in with its key and nothing else. */
const sshdDropIn = `# Managed by Dokploy: the GitHub runners account logs in with its key only.
Match User ${MANAGER_ACCOUNT}
	PasswordAuthentication no
	KbdInteractiveAuthentication no
	AuthenticationMethods publickey
	AllowTcpForwarding no
	AllowAgentForwarding no
	AllowStreamLocalForwarding no
	X11Forwarding no
	PermitTTY no
	PermitUserRC no
# Ends the block: what follows in sshd_config applies to every account again.
Match all
`;

/** Prints the code: facts gathered by each platform script into these variables. */
const report = sh`
key_file=$(mktemp)
printf '%s\n' "$PUBLIC_KEY" >"$key_file"
key=$(ssh-keygen -lf "$key_file" -E sha256 | awk '{print $2}')
rm -f "$key_file"
host_keys=""
for file in /etc/ssh/ssh_host_*_key.pub; do
	[ -f "$file" ] || continue
	host_keys="$host_keys,\"$(ssh-keygen -lf "$file" -E sha256 | awk '{print $2}')\""
done
hosts=""
for host in $candidates; do
	[[ "$host" =~ ^[A-Za-z0-9.:-]+$ ]] || continue
	case ",$hosts," in *",\"$host\","*) continue ;; esac
	hosts="$hosts,\"$host\""
done
os=$(printf '%s' "$os" | tr -cd 'A-Za-z0-9 ._()/-' | cut -c1-100)
json=$(printf '{"v":1,"machine":"%s","platform":"%s","user":"%s","port":22,"key":"%s","hostKeys":[%s],"hosts":[%s],"os":"%s","arch":"%s","fileVault":"%s","keepAwake":%s}' \
	"$MACHINE" "$PLATFORM" "$MANAGER_USER" "$key" "\${host_keys#,}" "\${hosts#,}" "$os" "$(uname -m)" "$filevault" "$keep_awake")
echo
echo "Setup done. Paste this code in Dokploy:"
echo
echo "${SETUP_CODE_PREFIX}$(printf '%s' "$json" | base64 | tr -d '\n')"
`;

const header = (
	machine: string,
	publicKey: string,
	platform: string,
) => sh`#!/bin/bash
# Dokploy GitHub runners: setup of machine "${machine}" (${platform}).
#
# Run it once on the machine as an administrator:  sudo bash <this file>
# It creates the account Dokploy logs in with (${MANAGER_ACCOUNT}), lets it
# log in over SSH with the key below only, and prints a code to paste in
# Dokploy. Running it again is safe: it only puts things back as they should be.
# Once the machine is removed from Dokploy, undo it all with:
#   sudo bash <this file> --uninstall
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MACHINE=${shellQuote(machine)}
MANAGER_USER=${MANAGER_ACCOUNT}
PUBLIC_KEY=${shellQuote(publicKey)}
DROPIN=/etc/ssh/sshd_config.d/050-dokploy-manager.conf
UNINSTALL=0
case "\${1:-}" in
	"") ;;
	--uninstall) UNINSTALL=1 ;;
	*) echo "usage: sudo bash $0 [--uninstall]" >&2; exit 2 ;;
esac
fail() { echo "error: $*" >&2; exit 1; }
step() { echo "==> $*"; }
warn() { echo "warning: $*" >&2; }
[ "$(id -u)" = 0 ] || fail "run it with sudo"
`;

const installSshd = sh`
step "SSH login with the key of $MACHINE only"
[ -f /etc/ssh/ssh_host_ed25519_key ] || ssh-keygen -A >/dev/null
grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config.d/' /etc/ssh/sshd_config ||
	fail "/etc/ssh/sshd_config does not include /etc/ssh/sshd_config.d"
install -d -m 700 -o "$MANAGER_USER" -g "$MANAGER_GROUP" "$MANAGER_HOME/.ssh"
printf 'restrict %s\n' "$PUBLIC_KEY" >"$MANAGER_HOME/.ssh/authorized_keys"
chown "$MANAGER_USER:$MANAGER_GROUP" "$MANAGER_HOME/.ssh/authorized_keys"
chmod 600 "$MANAGER_HOME/.ssh/authorized_keys"
cat >"$DROPIN" <<'DOKPLOY_EOF'
${sshdDropIn}DOKPLOY_EOF
chmod 644 "$DROPIN"
if ! sshd_check=$(/usr/sbin/sshd -t 2>&1); then
	rm -f "$DROPIN"
	fail "sshd rejected the configuration: $sshd_check"
fi
allowed=$(/usr/sbin/sshd -T -C "user=$MANAGER_USER,host=localhost,addr=127.0.0.1" 2>/dev/null | awk '$1 == "allowusers" || $1 == "allowgroups"' || true)
[ -z "$allowed" ] || warn "sshd restricts who may log in ($allowed): allow $MANAGER_USER there"
`;

const macScript = (machine: string, publicKey: string, keepAwake: boolean) =>
	`${header(machine, publicKey, "macOS")}${sh`
PLATFORM=macos
MANAGER_HOME=/Users/$MANAGER_USER
MANAGER_GROUP=staff
KEEP_AWAKE=${keepAwake ? 1 : 0}
[ "$(uname -s)" = Darwin ] || fail "this script is for macOS"

if [ "$UNINSTALL" = 1 ]; then
	step "Removing $MANAGER_USER, its runner VM and what this script set up"
	launchctl bootout system/${BOOT_DAEMON} >/dev/null 2>&1 || true
	rm -f /Library/LaunchDaemons/${BOOT_DAEMON}.plist
	# Stops the runner VM: its disk goes with the home folder below.
	pkill -u "$MANAGER_USER" >/dev/null 2>&1 || true
	rm -f "$DROPIN"
	if id "$MANAGER_USER" >/dev/null 2>&1; then
		dseditgroup -o edit -d "$MANAGER_USER" -t user com.apple.access_ssh >/dev/null 2>&1 || true
		sysadminctl -deleteUser "$MANAGER_USER" >/dev/null 2>&1 ||
			fail "sysadminctl could not delete $MANAGER_USER"
	fi
	echo "Done. Power settings are left as they are: review them with pmset -g."
	exit 0
fi

step "Account $MANAGER_USER: standard, hidden, no password login"
if ! id "$MANAGER_USER" >/dev/null 2>&1; then
	# A random password nobody keeps: the account only logs in with its key.
	# No pipe: under pipefail, tr would die of SIGPIPE once head has enough.
	password=$(openssl rand -hex 20)
	sysadminctl -addUser "$MANAGER_USER" -fullName "Dokploy GitHub runners" \
		-shell /bin/bash -home "$MANAGER_HOME" -password "$password" >/dev/null 2>&1 ||
		fail "sysadminctl could not create $MANAGER_USER"
	unset password
fi
[ -d "$MANAGER_HOME" ] || createhomedir -c -u "$MANAGER_USER" >/dev/null
dscl . -create "/Users/$MANAGER_USER" IsHidden 1
if dseditgroup -o checkmember -m "$MANAGER_USER" admin 2>/dev/null | grep -q '^yes'; then
	fail "$MANAGER_USER is an administrator: Dokploy needs no admin rights, remove it from the admin group"
fi

step "Remote Login"
if ! launchctl print system/com.openssh.sshd >/dev/null 2>&1; then
	systemsetup -setremotelogin on >/dev/null 2>&1 ||
		fail "turn on Remote Login in System Settings > General > Sharing, then run this script again"
fi
# "Only these users": the runner account joins them; "All users" needs nothing.
if dscl . -read /Groups/com.apple.access_ssh >/dev/null 2>&1; then
	dseditgroup -o edit -a "$MANAGER_USER" -t user com.apple.access_ssh
fi
`}${installSshd}${sh`
step "Runner VM started again after a reboot"
install -d -m 755 -o "$MANAGER_USER" -g staff "$MANAGER_HOME/.dokploy" "$MANAGER_HOME/.dokploy/bin"
boot="$MANAGER_HOME/.dokploy/bin/boot.sh"
if [ ! -f "$boot" ]; then
	printf '#!/bin/bash\n# Written by Dokploy once the machine is provisioned.\nexit 0\n' >"$boot"
	chown "$MANAGER_USER:staff" "$boot"
	chmod 755 "$boot"
fi
daemon=/Library/LaunchDaemons/${BOOT_DAEMON}.plist
cat >"$daemon" <<DOKPLOY_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${BOOT_DAEMON}</string>
	<key>UserName</key><string>$MANAGER_USER</string>
	<key>ProgramArguments</key>
	<array><string>/bin/bash</string><string>$boot</string></array>
	<key>EnvironmentVariables</key>
	<dict><key>HOME</key><string>$MANAGER_HOME</string></dict>
	<key>RunAtLoad</key><true/>
	<key>AbandonProcessGroup</key><true/>
	<key>StandardOutPath</key><string>$MANAGER_HOME/.dokploy/boot.log</string>
	<key>StandardErrorPath</key><string>$MANAGER_HOME/.dokploy/boot.log</string>
</dict>
</plist>
DOKPLOY_EOF
chown root:wheel "$daemon"
chmod 644 "$daemon"
launchctl bootout system/${BOOT_DAEMON} >/dev/null 2>&1 || true
launchctl bootstrap system "$daemon"

keep_awake=false
if [ "$KEEP_AWAKE" = 1 ]; then
	step "Always on: no system sleep (the display still sleeps), restart after a power loss"
	pmset -a sleep 0 disksleep 0 autorestart 1 womp 1 >/dev/null
	keep_awake=true
fi
filevault=$(fdesetup isactive >/dev/null 2>&1 && echo on || echo off)
if [ "$filevault" = on ]; then
	warn "FileVault is on: after a power loss the Mac waits for someone to unlock it, and its runners stay off until then. Restart it with: sudo fdesetup authrestart"
fi
for legacy in /Library/LaunchDaemons/io.lima-vm.*.plist; do
	[ -f "$legacy" ] || continue
	label=$(basename "$legacy" .plist)
	warn "a Lima VM is started outside Dokploy ($label). Once this machine runs in Dokploy, stop it with: sudo launchctl bootout system/$label"
done

os="macOS $(sw_vers -productVersion)"
tailscale=""
for cli in /Applications/Tailscale.app/Contents/MacOS/Tailscale /opt/homebrew/bin/tailscale /usr/local/bin/tailscale; do
	[ -x "$cli" ] && tailscale=$("$cli" ip -4 2>/dev/null | head -n 1) && break
done
candidates="$tailscale $(scutil --get LocalHostName 2>/dev/null).local $(ipconfig getifaddr en0 2>/dev/null || true) $(ipconfig getifaddr en1 2>/dev/null || true)"
`}${report}`;

const linuxScript = (machine: string, publicKey: string) =>
	`${header(machine, publicKey, "Linux")}${sh`
PLATFORM=linux
MANAGER_HOME=/home/$MANAGER_USER
MANAGER_GROUP=$MANAGER_USER
[ "$(uname -s)" = Linux ] || fail "this script is for Linux"
[ -d /run/systemd/system ] || fail "systemd is required"

if [ "$UNINSTALL" = 1 ]; then
	step "Removing $MANAGER_USER and what this script set up"
	rm -f "$DROPIN" /etc/sudoers.d/dokploy-manager
	systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
	if id "$MANAGER_USER" >/dev/null 2>&1; then
		pkill -u "$MANAGER_USER" >/dev/null 2>&1 || true
		sleep 1
		userdel --remove "$MANAGER_USER" 2>/dev/null || userdel "$MANAGER_USER" ||
			fail "userdel could not delete $MANAGER_USER"
	fi
	[ ! -d /opt/dokploy-runners ] ||
		warn "the runner runtime is still installed: remove the machine from Dokploy with \"Uninstall the runtime\" first"
	echo "Done."
	exit 0
fi

step "Account $MANAGER_USER: key login, root through sudo"
if ! id "$MANAGER_USER" >/dev/null 2>&1; then
	useradd --system --create-home --home-dir "$MANAGER_HOME" --shell /bin/bash "$MANAGER_USER"
fi
passwd -l "$MANAGER_USER" >/dev/null
# The runtime installs Docker and systemd units: the machine is dedicated to the runners.
sudoers=/etc/sudoers.d/dokploy-manager
printf '%s ALL=(root) NOPASSWD: ALL\n' "$MANAGER_USER" >"$sudoers.tmp"
chmod 440 "$sudoers.tmp"
visudo -cf "$sudoers.tmp" >/dev/null || { rm -f "$sudoers.tmp"; fail "sudo rejected the rule"; }
mv -f "$sudoers.tmp" "$sudoers"
`}${installSshd}${sh`
systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
filevault=off
keep_awake=null
# shellcheck source=/dev/null
# Every fact below is best effort: under set -e a failed lookup would stop
# the script before it prints the code.
os=$(. /etc/os-release 2>/dev/null && echo "\${PRETTY_NAME:-Linux}" || echo Linux)
tailscale=$(command -v tailscale >/dev/null 2>&1 && tailscale ip -4 2>/dev/null | head -n 1 || true)
candidates="$tailscale $(hostname -f 2>/dev/null || hostname 2>/dev/null || true) $(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' || true)"
`}${report}`;

/** The script an administrator runs once on the machine. */
export const machineSetupScript = (input: {
	platform: "linux" | "macos";
	machine: string;
	publicKey: string;
	keepAwake: boolean;
}) => {
	if (!MACHINE.test(input.machine)) {
		throw new Error(`Invalid machine name: ${input.machine}`);
	}
	if (!PUBLIC_KEY.test(input.publicKey.trim())) {
		throw new Error("The machine key must be an ed25519 public key");
	}
	return input.platform === "macos"
		? macScript(input.machine, input.publicKey.trim(), input.keepAwake)
		: linuxScript(input.machine, input.publicKey.trim());
};

const fingerprint = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/);

const setupCode = z.object({
	v: z.literal(1),
	machine: z.string().regex(MACHINE),
	platform: z.enum(["linux", "macos"]),
	user: z.literal(MANAGER_ACCOUNT),
	port: z.number().int().min(1).max(65535),
	key: fingerprint,
	hostKeys: z.array(fingerprint).min(1).max(10),
	hosts: z.array(z.string().regex(/^[A-Za-z0-9.:-]{1,253}$/)).max(10),
	os: z.string().max(100),
	arch: z.string().regex(/^[A-Za-z0-9_]{1,20}$/),
	fileVault: z.enum(["on", "off"]),
	keepAwake: z.boolean().nullable(),
});

export type SetupCode = z.infer<typeof setupCode>;

/** Reads the code the setup script printed; throws a message for the operator. */
export const parseSetupCode = (input: string): SetupCode => {
	const text = input.trim().replace(/\s+/g, "");
	if (!text.startsWith(SETUP_CODE_PREFIX)) {
		throw new Error(
			`Paste the whole code the script printed, starting with ${SETUP_CODE_PREFIX}`,
		);
	}
	let data: unknown;
	try {
		data = JSON.parse(
			Buffer.from(text.slice(SETUP_CODE_PREFIX.length), "base64").toString(
				"utf8",
			),
		);
	} catch {
		throw new Error("The code is incomplete: copy it again from the terminal");
	}
	const parsed = setupCode.safeParse(data);
	if (!parsed.success) {
		throw new Error(
			"The code does not come from a Dokploy setup script, or was changed",
		);
	}
	return parsed.data;
};
