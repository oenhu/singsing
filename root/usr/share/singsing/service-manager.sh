#!/bin/sh
# OpenWrt service manager for luci-app-singsing
# Handles: directory setup, dnsmasq backup/takeover/restore, local rule-set download/update,
# config validation, atomic apply, health check, and automatic rollback.

set -u

CONF_DIR="/etc/singsing"
PROFILES_DIR="$CONF_DIR/profiles"
DNSMASQ_BACKUP="$CONF_DIR/dnsmasq-backup.json"
MANIFEST_FILE="$CONF_DIR/rulesets-manifest.json"

SB_DIR="/etc/sing-box"
SB_CONFIG="$SB_DIR/config.json"
SB_LAST_GOOD="$SB_DIR/config.last-good.json"

TMP_DIR="/tmp/singsing"
TMP_NEW_CONFIG="$TMP_DIR/config.new.json"
TMP_DL_DIR="$TMP_DIR/downloads"
LOCK_FILE="$TMP_DIR/apply.lock"
TX_FILE="$TMP_DIR/transaction.state"

uci_get() {
	uci -q get "singsing.$1" 2>/dev/null || printf '%s' "${2:-}"
}

get_singbox_bin() {
	uci_get "main.singbox_bin" "/usr/bin/sing-box"
}

ensure_dirs() {
	local ruleset_dir ts_root
	ruleset_dir="$(uci_get "main.ruleset_dir" "/etc/sing-box/rule-sets")"
	ts_root="$(uci_get "main.tailscale_state_root" "/etc/sing-box/tailscale")"

	mkdir -p "$PROFILES_DIR" "$SB_DIR" "$ruleset_dir" "$ts_root" "$TMP_DL_DIR"
	chmod 700 "$CONF_DIR" "$PROFILES_DIR" 2>/dev/null || true
	chmod 755 "$TMP_DIR" "$TMP_DL_DIR" 2>/dev/null || true
}

get_dnsmasq_conf_file() {
	local uci_cfg conf_dir
	uci_cfg="$(uci -q show "dhcp.@dnsmasq[0]" 2>/dev/null | awk 'NR==1 {split($0, c, /[.=]/); print c[2]}')"
	if [ -n "$uci_cfg" ] && [ -f "/tmp/etc/dnsmasq.conf.$uci_cfg" ]; then
		conf_dir="$(awk -F '=' '/^conf-dir=/ {print $2; exit}' "/tmp/etc/dnsmasq.conf.$uci_cfg")"
	fi
	[ -n "${conf_dir:-}" ] || conf_dir="/tmp/dnsmasq.d"
	printf '%s/dnsmasq-singsing.conf' "$conf_dir"
}

dnsmasq_takeover() {
	local manage listen_addr listen_port conf_file conf_dir tmp_file
	manage="$(uci_get "dns.dnsmasq_manage" "1")"
	[ "$manage" = "1" ] || return 0

	listen_addr="$(uci_get "dns.listen_address" "127.0.0.1")"
	listen_port="$(uci_get "dns.listen_port" "5335")"
	conf_file="$(get_dnsmasq_conf_file)"
	conf_dir="$(dirname "$conf_file")"

	mkdir -p "$conf_dir"
	tmp_file="${conf_file}.tmp.$$"
	cat > "$tmp_file" <<EOF
# Managed by luci-app-singsing (RAM drop-in, zero flash write)
no-resolv
cache-size=0
server=${listen_addr}#${listen_port}
EOF

	if [ -f "$conf_file" ] && cmp -s "$tmp_file" "$conf_file"; then
		rm -f "$tmp_file"
		return 0
	fi
	mv -f "$tmp_file" "$conf_file"
	/etc/init.d/dnsmasq restart >/dev/null 2>&1 || /etc/init.d/dnsmasq reload >/dev/null 2>&1 || true
}

dnsmasq_restore() {
	local conf_file changed=0
	conf_file="$(get_dnsmasq_conf_file)"

	if [ -f "$conf_file" ]; then
		rm -f "$conf_file"
		changed=1
	fi

	# Also clean up legacy /etc/config/dhcp backup if upgrading from earlier version
	if [ -f "$DNSMASQ_BACKUP" ]; then
		ucode -e '
			import { readfile } from "fs";
			import { cursor } from "uci";
			let raw = readfile("'"$DNSMASQ_BACKUP"'");
			if (!raw) exit(0);
			let data = json(raw);
			let c = cursor();
			if (data.noresolv && length(data.noresolv) > 0)
				c.set("dhcp", "@dnsmasq[0]", "noresolv", data.noresolv);
			else
				c.delete("dhcp", "@dnsmasq[0]", "noresolv");
			if (data.cachesize && length(data.cachesize) > 0)
				c.set("dhcp", "@dnsmasq[0]", "cachesize", data.cachesize);
			else
				c.delete("dhcp", "@dnsmasq[0]", "cachesize");
			c.delete("dhcp", "@dnsmasq[0]", "server");
			if (type(data.server) == "array" && length(data.server) > 0)
				c.set("dhcp", "@dnsmasq[0]", "server", data.server);
			c.commit("dhcp");
		' 2>/dev/null || true
		rm -f "$DNSMASQ_BACKUP"
		changed=1
	fi

	if [ "$changed" -eq 1 ]; then
		/etc/init.d/dnsmasq restart >/dev/null 2>&1 || /etc/init.d/dnsmasq reload >/dev/null 2>&1 || true
	fi
}

apply_download_prefix() {
	local url="$1"
	local prefix
	prefix="$(uci_get "main.ruleset_download_prefix" "")"
	if [ -n "$prefix" ]; then
		case "$url" in
			https://raw.githubusercontent.com/*|https://github.com/*)
				printf '%s%s' "$prefix" "$url"
				return 0
				;;
		esac
	fi
	printf '%s' "$url"
}

download_file() {
	local url="$1"
	local dest="$2"
	local format="${3:-binary}"
	local eff_url tmp_file dest_dir

	ensure_dirs
	eff_url="$(apply_download_prefix "$url")"
	dest_dir="$(dirname "$dest")"
	mkdir -p "$dest_dir"
	tmp_file="$TMP_DL_DIR/$(basename "$dest").$$.tmp"

	rm -f "$tmp_file"
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --connect-timeout 15 --max-time 90 -o "$tmp_file" "$eff_url" 2>/dev/null || {
			rm -f "$tmp_file"
			return 1
		}
	elif command -v uclient-fetch >/dev/null 2>&1; then
		uclient-fetch -q -T 30 -O "$tmp_file" "$eff_url" 2>/dev/null || {
			rm -f "$tmp_file"
			return 1
		}
	else
		return 127
	fi

	# Must be non-empty
	if [ ! -s "$tmp_file" ]; then
		rm -f "$tmp_file"
		return 1
	fi

	# If JSON source rule-set, verify valid JSON
	if [ "$format" = "source" ] && command -v ucode >/dev/null 2>&1; then
		ucode -e 'import { readfile } from "fs"; if (json(readfile("'"$tmp_file"'")) == null) exit(1);' 2>/dev/null || {
			rm -f "$tmp_file"
			return 1
		}
	fi

	mv -f "$tmp_file" "$dest"
	return 0
}

ensure_rulesets() {
	[ -f "$MANIFEST_FILE" ] || return 0
	ensure_dirs

	local lines line tag url format path failed=0
	lines="$(ucode -e '
		import { readfile } from "fs";
		let arr = json(readfile("'"$MANIFEST_FILE"'") || "[]");
		if (type(arr) == "array") {
			for (let r in arr)
				printf("%s\t%s\t%s\t%s\n", r.tag || "", r.url || "", r.format || "binary", r.path || "");
		}
	' 2>/dev/null || true)"

	[ -z "$lines" ] && return 0

	printf '%s\n' "$lines" | while IFS='	' read -r tag url format path; do
		[ -n "$path" ] || continue
		if [ -s "$path" ]; then
			continue
		fi
		if [ -z "$url" ]; then
			printf 'Missing local rule-set %s (%s) with no download URL\n' "$tag" "$path" >&2
			exit 1
		fi
		if ! download_file "$url" "$path" "$format"; then
			printf 'Failed to download required rule-set %s from %s\n' "$tag" "$url" >&2
			exit 1
		fi
	done
}

update_rulesets() {
	local target_tag="${1:-}"
	[ -f "$MANIFEST_FILE" ] || {
		printf '{"ok":true,"updated":[],"failed":[],"message":"No rule-set manifest found"}\n'
		return 0
	}
	ensure_dirs

	local lines updated="" failed="" changed=0
	lines="$(ucode -e '
		import { readfile } from "fs";
		let arr = json(readfile("'"$MANIFEST_FILE"'") || "[]");
		if (type(arr) == "array") {
			for (let r in arr)
				printf("%s\t%s\t%s\t%s\n", r.tag || "", r.url || "", r.format || "binary", r.path || "");
		}
	' 2>/dev/null || true)"

	local tmp_res="$TMP_DIR/ruleset-update.$$.tmp"
	: > "$tmp_res"

	printf '%s\n' "$lines" | while IFS='	' read -r tag url format path; do
		[ -n "$tag" ] && [ -n "$path" ] && [ -n "$url" ] || continue
		if [ -n "$target_tag" ] && [ "$tag" != "$target_tag" ]; then
			continue
		fi
		if download_file "$url" "$path" "$format"; then
			printf 'OK\t%s\n' "$tag" >> "$tmp_res"
		else
			printf 'FAIL\t%s\n' "$tag" >> "$tmp_res"
		fi
	done

	local ok_count=0 fail_count=0
	while IFS='	' read -r st tag; do
		[ -n "$tag" ] || continue
		if [ "$st" = "OK" ]; then
			ok_count=$((ok_count + 1))
			updated="${updated:+$updated,}\"$tag\""
			changed=1
		else
			fail_count=$((fail_count + 1))
			failed="${failed:+$failed,}\"$tag\""
		fi
	done < "$tmp_res"
	rm -f "$tmp_res"

	# Reload sing-box if running and any rule-set updated
	if [ "$changed" -eq 1 ] && [ -n "$(get_service_pid)" ]; then
		/etc/init.d/singsing restart >/dev/null 2>&1 || true
	fi

	if [ "$fail_count" -eq 0 ]; then
		printf '{"ok":true,"updated":[%s],"failed":[]}\n' "$updated"
		return 0
	else
		printf '{"ok":false,"updated":[%s],"failed":[%s]}\n' "$updated" "$failed"
		return 1
	fi
}

validate_config() {
	local cfg="${1:-$TMP_NEW_CONFIG}"
	local bin
	bin="$(get_singbox_bin)"
	if [ ! -x "$bin" ]; then
		printf 'sing-box binary not found or not executable: %s\n' "$bin" >&2
		return 127
	fi
	"$bin" check -c "$cfg" 2>&1
}

get_service_pid() {
	local pid=""
	if command -v ubus >/dev/null 2>&1 && command -v ucode >/dev/null 2>&1; then
		pid="$(ubus call service list '{"name":"singsing"}' 2>/dev/null | ucode -e '
			import { stdin } from "fs";
			let d = json(stdin.read("all") || "{}");
			let inst = d?.["singsing"]?.instances?.["singsing"];
			if (inst && inst.running && inst.pid) print(inst.pid);
		' 2>/dev/null || true)"
	fi
	printf '%s' "$pid"
}

wait_dns_ready() {
	local port timeout i pid
	port="$(uci_get "dns.listen_port" "5335")"
	timeout="${1:-10}"
	i=0
	while [ "$i" -lt "$timeout" ]; do
		pid="$(get_service_pid)"
		if [ -n "$pid" ]; then
			if command -v ss >/dev/null 2>&1; then
				if ss -lntu 2>/dev/null | grep -q ":${port}[[:space:]]"; then
					return 0
				fi
			elif command -v netstat >/dev/null 2>&1; then
				if netstat -lntu 2>/dev/null | grep -q ":${port}[[:space:]]"; then
					return 0
				fi
			else
				# Fallback: process stayed alive >= 2 seconds
				[ "$i" -ge 2 ] && return 0
			fi
		fi
		sleep 1
		i=$((i + 1))
	done
	return 1
}

apply_config() {
	ensure_dirs
	(
		flock -x -w 30 200 || {
			printf 'Another apply operation is already in progress\n' >&2
			exit 1
		}

		local local_dns auto_rollback err_out
		local_dns="$(uci_get "dns.local_server" "")"
		if [ -z "$local_dns" ]; then
			printf 'Direct upstream DNS (dns.local_server) is required before applying\n' >&2
			exit 1
		fi

		if [ ! -s "$TMP_NEW_CONFIG" ]; then
			printf 'Candidate config not found: %s\n' "$TMP_NEW_CONFIG" >&2
			exit 1
		fi

		echo "applying" > "$TX_FILE"

		# 1. Ensure local rule-sets exist (auto-download missing ones)
		if ! err_out="$(ensure_rulesets 2>&1)"; then
			rm -f "$TX_FILE"
			printf '%s\n' "$err_out" >&2
			exit 1
		fi

		# 2. Validate candidate config with sing-box check
		if ! err_out="$(validate_config "$TMP_NEW_CONFIG" 2>&1)"; then
			rm -f "$TX_FILE"
			printf 'Config check failed:\n%s\n' "$err_out" >&2
			exit 1
		fi

		# 3. Backup current good config
		if [ -s "$SB_CONFIG" ]; then
			cp -f "$SB_CONFIG" "$SB_LAST_GOOD"
			chmod 600 "$SB_LAST_GOOD" 2>/dev/null || true
		fi

		# 4. Atomically install new config
		mv -f "$TMP_NEW_CONFIG" "$SB_CONFIG"
		chmod 600 "$SB_CONFIG" 2>/dev/null || true

		# 5. Enable and restart service
		uci -q set singsing.main.enabled='1'
		uci -q commit singsing
		/etc/init.d/singsing restart >/dev/null 2>&1

		# 6. Health check
		if wait_dns_ready 12; then
			dnsmasq_takeover
			rm -f "$TX_FILE"
			exit 0
		fi

		# 7. Auto rollback on startup failure
		auto_rollback="$(uci_get "main.auto_rollback" "1")"
		if [ "$auto_rollback" = "1" ] && [ -s "$SB_LAST_GOOD" ]; then
			cp -f "$SB_LAST_GOOD" "$SB_CONFIG"
			chmod 600 "$SB_CONFIG" 2>/dev/null || true
			/etc/init.d/singsing restart >/dev/null 2>&1
			if wait_dns_ready 10; then
				dnsmasq_takeover
				rm -f "$TX_FILE"
				printf 'New config failed to start; rolled back to last good config\n' >&2
				exit 2
			fi
		fi

		# Complete failure: restore dnsmasq so router retains internet access
		dnsmasq_restore
		/etc/init.d/singsing stop >/dev/null 2>&1 || true
		rm -f "$TX_FILE"
		printf 'sing-box failed to start; dnsmasq restored for safety\n' >&2
		exit 1
	) 200>"$LOCK_FILE"
}

notify_cron() {
	# Safe BusyBox crond reload: never restart crond from inside a running cron job.
	printf '%s\n' 'root' >> /etc/crontabs/cron.update
}

cron_remove() {
	local crontab="/etc/crontabs/root"
	local cron_lock="/var/lock/root-crontab"
	local tmp changed=0
	[ -f "$crontab" ] || return 0

	mkdir -p "$(dirname "$cron_lock")"
	lock "$cron_lock" || return 1
	tmp="$(mktemp /etc/crontabs/.singbox-cron.XXXXXX)" || { lock -u "$cron_lock"; return 1; }
	grep -v "# singsing-sub" "$crontab" > "$tmp" 2>/dev/null || : > "$tmp"
	chmod 600 "$tmp" 2>/dev/null || true
	if ! cmp -s "$tmp" "$crontab"; then
		mv -f "$tmp" "$crontab"
		changed=1
	else
		rm -f "$tmp"
	fi
	lock -u "$cron_lock"
	[ "$changed" -eq 0 ] || notify_cron
}

cron_sync() {
	local auto_update interval crontab cron_lock expr tmp changed=0
	auto_update="$(uci_get "subscription.auto_update" "0")"
	interval="$(uci_get "subscription.update_interval" "86400")"
	crontab="/etc/crontabs/root"
	cron_lock="/var/lock/root-crontab"

	mkdir -p /etc/crontabs "$(dirname "$cron_lock")"
	lock "$cron_lock" || return 1
	tmp="$(mktemp /etc/crontabs/.singbox-cron.XXXXXX)" || { lock -u "$cron_lock"; return 1; }

	if [ -f "$crontab" ]; then
		grep -v "# singsing-sub" "$crontab" > "$tmp" 2>/dev/null || : > "$tmp"
	else
		: > "$tmp"
	fi

	if [ "$auto_update" = "1" ]; then
		case "$interval" in
			21600)  expr="15 */6 * * *" ;;
			43200)  expr="15 */12 * * *" ;;
			259200) expr="30 3 */3 * *" ;;
			604800) expr="30 3 * * 1" ;;
			*)      expr="30 3 * * *" ;;
		esac
		printf '%s /usr/share/singsing/subscription-updater.uc >/dev/null 2>&1 # singsing-sub\n' "$expr" >> "$tmp"
	fi

	chmod 600 "$tmp" 2>/dev/null || true
	if [ -f "$crontab" ] && cmp -s "$tmp" "$crontab"; then
		rm -f "$tmp"
	else
		mv -f "$tmp" "$crontab"
		changed=1
	fi
	lock -u "$cron_lock"
	[ "$changed" -eq 0 ] || notify_cron
}

case "${1:-}" in
	ensure_dirs)      ensure_dirs ;;
	dnsmasq_takeover) dnsmasq_takeover ;;
	dnsmasq_restore)  dnsmasq_restore ;;
	ensure_rulesets)  ensure_rulesets ;;
	update_rulesets)  update_rulesets "${2:-}" ;;
	validate_config)  validate_config "${2:-$TMP_NEW_CONFIG}" ;;
	wait_dns_ready)   wait_dns_ready "${2:-10}" ;;
	apply_config)     apply_config ;;
	cron_sync)        cron_sync ;;
	cron_remove)      cron_remove ;;
	*)
		printf 'Usage: %s {ensure_dirs|dnsmasq_takeover|dnsmasq_restore|ensure_rulesets|update_rulesets|validate_config|wait_dns_ready|apply_config|cron_sync|cron_remove}\n' "$0" >&2
		exit 1
		;;
esac
