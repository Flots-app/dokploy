/**
 * How runner machines enforce the firewall their jobs follow (from the
 * Firewalls service): pf on the Mac host, outside the VM a job could be root
 * in, through a root helper the setup script installs; nftables on Linux,
 * through the sudo rights of the account Dokploy logs in with. A machine
 * reports the hash of the rules it loaded: the controller gives it jobs only
 * while that hash is the one it expects.
 */
import {
	NFT_TABLE,
	NFT_UID_PLACEHOLDER,
	type Ruleset,
} from "../firewall/backends";
import { parseRecords } from "./probe";
import { sh } from "./runtime";
import { MANAGER_ACCOUNT } from "./setup-constants";

/** Root helper on the Mac; the account Dokploy logs in with may sudo it. */
export const MAC_FIREWALL_HELPER =
	"/Library/PrivilegedHelperTools/com.dokploy.firewall";
/** LaunchDaemon that loads the saved rules again at boot. */
export const MAC_FIREWALL_DAEMON = "com.dokploy.firewall";

/**
 * The helper. It accepts the rules pfRuleset renders and nothing else (each
 * line is checked against the only forms Dokploy writes), binds every rule to
 * the account Lima runs as, and loads them in an anchor under com.apple, which
 * the main ruleset of macOS calls. pf is enabled with a reference of its own,
 * released by "clear".
 */
export const macFirewallHelper = sh`#!/bin/bash
# Managed by Dokploy (GitHub runners): installed by the setup script, do not edit.
# Loads pf rules for the outbound TCP and UDP traffic of ${MANAGER_ACCOUNT}
# (the Lima processes of the runner VM), and nothing else.
#   apply   loads the rules read on stdin, and keeps them for the next boot
#   clear   removes them
#   status  prints what is loaded
#   boot    loads the kept rules again (launchd, at boot)
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
ACCOUNT=${MANAGER_ACCOUNT}
ANCHOR=com.apple/dokploy.firewall
STATE=/var/db/dokploy-firewall
LOADED=/var/run/dokploy-firewall.hash
fail() { echo "error: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail "run it as root"

header_re='^# dokploy-firewall [a-f0-9]{32}$'
table_re='^table <dk[0-9]{1,3}> const \{ [0-9a-fA-F.:/, ]+ \}$'
port='[0-9]{1,5}(:[0-9]{1,5})?'
rule_re="^(pass|block return) out quick( on lo0)? proto (tcp|udp|\{ tcp udp \}) from any to (any|(! )?<dk[0-9]{1,3}>)( port ($port|\{( $port)+ \}))?$"

validate() {
	local count=0 line
	while IFS= read -r line || [ -n "$line" ]; do
		count=$((count + 1))
		[ "$count" -le 2000 ] || fail "too many lines"
		if [ "$count" = 1 ]; then
			[[ $line =~ $header_re ]] || fail "not a Dokploy firewall"
			continue
		fi
		[[ $line =~ $table_re ]] && continue
		[[ $line =~ $rule_re ]] && continue
		fail "line $count is not a rule Dokploy writes"
	done <"$1"
	[ "$count" -gt 1 ] || fail "no rule"
}

# Every rule is bound to the account: other traffic of the Mac is never matched.
render() {
	local uid line
	uid=$(id -u "$ACCOUNT") || fail "no account $ACCOUNT"
	tail -n +2 "$1" | while IFS= read -r line || [ -n "$line" ]; do
		case "$line" in
		table*) printf '%s\n' "$line" ;;
		*) printf '%s user %s\n' "$line" "$uid" ;;
		esac
	done
}

main_calls_anchor() { pfctl -sr 2>/dev/null | grep -q '^anchor "com.apple/\*"'; }

enable() {
	local token
	if [ -s "$STATE/token" ] && pfctl -s References 2>/dev/null | grep -qw "$(cat "$STATE/token")"; then
		return 0
	fi
	token=$(pfctl -E 2>&1 | sed -n 's/^Token : //p')
	[ -n "$token" ] || fail "pf could not be enabled"
	printf '%s\n' "$token" >"$STATE/token"
}

load() {
	install -d -m 700 "$STATE"
	render "$1" >"$STATE/anchor.conf"
	pfctl -q -a "$ANCHOR" -f "$STATE/anchor.conf" 2>"$STATE/pfctl.log" ||
		fail "pf rejected the rules: $(tail -n 3 "$STATE/pfctl.log" | tr '\n' ' ')"
	# macOS loads /etc/pf.conf at boot, which calls the com.apple anchors.
	main_calls_anchor || pfctl -q -f /etc/pf.conf 2>/dev/null || true
	main_calls_anchor || fail "the main pf ruleset does not call the com.apple anchors (/etc/pf.conf was changed)"
	enable
	sed -n '1s/^# dokploy-firewall //p' "$1" >"$LOADED.tmp"
	chmod 644 "$LOADED.tmp"
	mv -f "$LOADED.tmp" "$LOADED"
}

status() {
	local loaded=none
	if [ -s "$LOADED" ] && pfctl -s info 2>/dev/null | grep -q '^Status: Enabled' &&
		[ -n "$(pfctl -a "$ANCHOR" -sr 2>/dev/null)" ] && main_calls_anchor; then
		loaded=$(cat "$LOADED")
	fi
	echo "firewall helper=yes loaded=$loaded"
}

case "\${1:-}" in
apply)
	install -d -m 700 "$STATE"
	tmp=$(mktemp "$STATE/rules.XXXXXX")
	trap 'rm -f "$tmp"' EXIT
	head -c 262144 >"$tmp"
	validate "$tmp"
	load "$tmp"
	mv -f "$tmp" "$STATE/rules"
	status
	;;
clear)
	pfctl -q -a "$ANCHOR" -F all 2>/dev/null || true
	[ ! -s "$STATE/token" ] || pfctl -X "$(cat "$STATE/token")" >/dev/null 2>&1 || true
	rm -f "$STATE/token" "$STATE/rules" "$STATE/anchor.conf" "$LOADED"
	status
	;;
status) status ;;
boot)
	[ -f "$STATE/rules" ] || exit 0
	validate "$STATE/rules"
	load "$STATE/rules"
	status
	;;
*) fail "usage: $0 apply|clear|status|boot" ;;
esac
`;

/** Setup script lines (as root, macOS): the helper, its sudo rule and its boot daemon. */
export const macFirewallInstall = sh`
step "Firewall of the jobs: pf helper"
install -d -o root -g wheel -m 755 /Library/PrivilegedHelperTools
helper_tmp=$(mktemp /Library/PrivilegedHelperTools/.dokploy.XXXXXX)
cat >"$helper_tmp" <<'DOKPLOY_EOF'
${macFirewallHelper}DOKPLOY_EOF
chown root:wheel "$helper_tmp"
chmod 755 "$helper_tmp"
mv -f "$helper_tmp" ${MAC_FIREWALL_HELPER}
sudoers=/etc/sudoers.d/dokploy-firewall
printf '%s ALL=(root) NOPASSWD: %s\n' "$MANAGER_USER" ${MAC_FIREWALL_HELPER} >"$sudoers.tmp"
chmod 440 "$sudoers.tmp"
visudo -cf "$sudoers.tmp" >/dev/null || { rm -f "$sudoers.tmp"; fail "sudo rejected the rule"; }
mv -f "$sudoers.tmp" "$sudoers"
firewall_daemon=/Library/LaunchDaemons/${MAC_FIREWALL_DAEMON}.plist
cat >"$firewall_daemon" <<DOKPLOY_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${MAC_FIREWALL_DAEMON}</string>
	<key>ProgramArguments</key>
	<array><string>${MAC_FIREWALL_HELPER}</string><string>boot</string></array>
	<key>RunAtLoad</key><true/>
	<key>StandardErrorPath</key><string>/var/log/dokploy-firewall.log</string>
</dict>
</plist>
DOKPLOY_EOF
chown root:wheel "$firewall_daemon"
chmod 644 "$firewall_daemon"
launchctl bootout system/${MAC_FIREWALL_DAEMON} >/dev/null 2>&1 || true
launchctl bootstrap system "$firewall_daemon"
`;

/** Setup script lines for --uninstall (as root, macOS). */
export const macFirewallUninstall = sh`
	launchctl bootout system/${MAC_FIREWALL_DAEMON} >/dev/null 2>&1 || true
	[ ! -x ${MAC_FIREWALL_HELPER} ] || ${MAC_FIREWALL_HELPER} clear >/dev/null 2>&1 || true
	rm -f /Library/LaunchDaemons/${MAC_FIREWALL_DAEMON}.plist ${MAC_FIREWALL_HELPER} /etc/sudoers.d/dokploy-firewall
	rm -rf /var/db/dokploy-firewall
`;

/** Probe lines (as the account Dokploy logs in with, macOS). */
export const macFirewallStatus = sh`if [ -x ${MAC_FIREWALL_HELPER} ]; then
	sudo -n ${MAC_FIREWALL_HELPER} status 2>/dev/null || echo "firewall helper=denied"
else
	echo "firewall helper=missing"
fi`;

const LINUX_RULES = "/etc/dokploy-runners/firewall.nft";
const LINUX_HASH = "/etc/dokploy-runners/firewall.hash";
const LINUX_LOADED = "/run/dokploy-firewall.hash";

const linuxUnit = `[Unit]
Description=Dokploy firewall of the GitHub Actions jobs
DefaultDependencies=no
After=local-fs.target
Before=network-pre.target shutdown.target
Wants=network-pre.target
Conflicts=shutdown.target
ConditionPathExists=${LINUX_RULES}

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=nft -f ${LINUX_RULES}
ExecStartPost=cp ${LINUX_HASH} ${LINUX_LOADED}
ExecStop=-nft delete table inet ${NFT_TABLE}
ExecStopPost=rm -f ${LINUX_LOADED}

[Install]
WantedBy=multi-user.target
`;

/** Probe command (as root, Linux). */
export const linuxFirewallStatus = `sh -c 'if [ -s ${LINUX_LOADED} ] && nft list table inet ${NFT_TABLE} >/dev/null 2>&1; then echo "firewall helper=yes loaded=$(cat ${LINUX_LOADED})"; else echo "firewall helper=yes loaded=none"; fi'`;

/**
 * Loads a ruleset on a Linux machine, as root with `bash -s`: checked by nft
 * first, then kept for the boot (a systemd unit loads it before the network).
 */
export const linuxFirewallApplyScript = (ruleset: Ruleset) => {
	if (
		ruleset.text.includes("\nDOKPLOY_EOF\n") ||
		!/^[a-f0-9]{32}$/.test(ruleset.hash)
	) {
		throw new Error("Unexpected ruleset");
	}
	return `set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
fail() { echo "error: $*" >&2; exit 1; }
if ! command -v nft >/dev/null 2>&1; then
	command -v apt-get >/dev/null 2>&1 || fail "nft is missing and this system has no apt-get"
	apt-get -o DPkg::Lock::Timeout=300 install -y -qq nftables >/dev/null
fi
uid=$(id -u dokploy-runner 2>/dev/null) || fail "no dokploy-runner account: install the runtime first"
install -d -m 0755 /etc/dokploy-runners
tmp=$(mktemp ${LINUX_RULES}.XXXXXX)
trap 'rm -f "$tmp"' EXIT
cat >"$tmp" <<'DOKPLOY_EOF'
${ruleset.text}DOKPLOY_EOF
sed -i "s/${NFT_UID_PLACEHOLDER}/$uid/" "$tmp"
nft -c -f "$tmp" || fail "nftables rejected the rules"
mv -f "$tmp" ${LINUX_RULES}
printf '%s\\n' ${ruleset.hash} >${LINUX_HASH}
cat >/etc/systemd/system/dokploy-firewall.service <<'DOKPLOY_EOF'
${linuxUnit}DOKPLOY_EOF
systemctl daemon-reload
systemctl enable dokploy-firewall.service >/dev/null 2>&1
nft -f ${LINUX_RULES}
cp ${LINUX_HASH} ${LINUX_LOADED}
${linuxFirewallStatus}
`;
};

/** Removes what linuxFirewallApplyScript installed (as root). */
export const linuxFirewallClearScript = () => `set -u
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
systemctl disable --now dokploy-firewall.service >/dev/null 2>&1 || true
command -v nft >/dev/null 2>&1 && nft delete table inet ${NFT_TABLE} >/dev/null 2>&1 || true
rm -f ${LINUX_RULES} ${LINUX_HASH} ${LINUX_LOADED} /etc/systemd/system/dokploy-firewall.service
systemctl daemon-reload
echo "firewall helper=yes loaded=none"
`;

export interface FirewallStatus {
	/** yes; missing or denied: the Mac needs the setup script again. */
	helper: "yes" | "missing" | "denied" | "error";
	/** Hash of the rules loaded; null for none. */
	loaded: string | null;
}

/** Reads the "firewall" line of a probe or of the helper; null when absent. */
export const parseFirewallStatus = (output: string): FirewallStatus | null => {
	const record = parseRecords(output).find((item) => item.kind === "firewall");
	if (!record) return null;
	const helper = record.fields.helper;
	const loaded = record.fields.loaded;
	return {
		helper:
			helper === "yes" || helper === "missing" || helper === "denied"
				? helper
				: "error",
		loaded: loaded && /^[a-f0-9]{32}$/.test(loaded) ? loaded : null,
	};
};
