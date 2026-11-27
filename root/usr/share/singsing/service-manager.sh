#!/bin/sh
# OpenWrt service manager for luci-app-singsing
# Handles: directory setup, dnsmasq backup/takeover/restore, local rule-set download/update,
# config validation, atomic apply, health check, and automatic rollback.

set -u

CONF_DIR="/etc/singsing"
PROFILES_DIR="$CONF_DIR/profiles"
DNSMASQ_BACKUP="$CONF_DIR/dnsmasq-backup.json"
MANIFEST_FILE="$CONF_DIR/rulesets-manifest.json"
SB_CONFIG="$CONF_DIR/sing-box.json"
SB_LAST_GOOD="$CONF_DIR/sing-box.last-good.json"

SB_DIR="/etc/sing-box"

TMP_DIR="/tmp/singsing"
TMP_NEW_CONFIG="$TMP_DIR/config.new.json"
TMP_DL_DIR="$TMP_DIR/downloads"
LOCK_FILE="$TMP_DIR/apply.lock"
TX_FILE="$TMP_DIR/transaction.state"
CRON_FILE="/etc/crontabs/root"
CRON_LOCK="/var/lock/root-crontab"
CRON_TAG="# singsing-ruleset"

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
	chmod 700 "$CONF_DIR" "$PROFILES_DIR" "$ts_root" 2>/dev/null || true
	[ -f "$SB_CONFIG" ] && chmod 600 "$SB_CONFIG" 2>/dev/null || true
	chmod 755 "$TMP_DIR" "$TMP_DL_DIR" 2>/dev/null || true
}

disable_stock_singbox() {
	if [ -x /etc/init.d/sing-box ]; then
		if [ "$(uci -q get sing-box.main.enabled 2>/dev/null)" = "1" ]; then
			uci -q set sing-box.main.enabled='0' && uci -q commit sing-box 2>/dev/null || true
		fi
		/etc/init.d/sing-box stop >/dev/null 2>&1 || true
		/etc/init.d/sing-box disable >/dev/null 2>&1 || true
	fi
}

is_port_listening() {
	local port="$1"
	if command -v ss >/dev/null 2>&1; then
		if ss -Hlntu 2>/dev/null | awk -v p=":$port" '$5 ~ p "$" {found=1; exit} END {exit !found}'; then
			return 0
		fi
	fi
	if command -v netstat >/dev/null 2>&1; then
		if netstat -lntu 2>/dev/null | awk -v p=":$port" '$4 ~ p "$" {found=1; exit} END {exit !found}'; then
			return 0
		fi
	fi
	return 1
}

wait_port_listening() {
	local port="$1"
	local timeout="${2:-5}"
	local i=0
	if ! command -v ss >/dev/null 2>&1 && ! command -v netstat >/dev/null 2>&1; then
		sleep 1
		return 0
	fi
	while [ "$i" -lt "$timeout" ]; do
		if is_port_listening "$port"; then
			return 0
		fi
		sleep 1
		i=$((i + 1))
	done
	return 1
}

check_local_dns() {
	local srv="" ltype="" bootstrap=""
	if [ "$#" -gt 0 ]; then
		srv="$1"
		ltype="${2:-$(uci_get "dns.local_type" "udp")}"
		bootstrap="${3:-$(uci_get "dns.local_bootstrap" "")}"
	else
		srv="$(uci_get "dns.local_server" "")"
		ltype="$(uci_get "dns.local_type" "udp")"
		bootstrap="$(uci_get "dns.local_bootstrap" "")"
	fi
	[ -n "$srv" ] || return 1

	DNS_SRV="$srv" DNS_TYPE="$ltype" DNS_BOOTSTRAP="$bootstrap" ucode -e '
		import { popen } from "fs";

		function isV4(ip) {
			let m = match(ip, /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/);
			if (!m) return false;
			for (let i = 1; i <= 4; i++) if (int(m[i]) > 255) return false;
			return true;
		}

		function expandV6(raw) {
			let ip = trim(raw);
			if (index(ip, ":") < 0) return null;
			if ((substr(ip, 0, 1) == ":" && substr(ip, 0, 2) != "::") ||
			    (substr(ip, length(ip) - 1, 1) == ":" && substr(ip, length(ip) - 2, 2) != "::"))
				return null;
			let lcIdx = rindex(ip, ":");
			let tail = substr(ip, lcIdx + 1);
			if (index(tail, ".") >= 0) {
				if (!isV4(tail)) return null;
				let p = split(tail, ".");
				let hi = sprintf("%x", (int(p[0]) << 8) | int(p[1]));
				let lo = sprintf("%x", (int(p[2]) << 8) | int(p[3]));
				ip = substr(ip, 0, lcIdx + 1) + hi + ":" + lo;
			}
			let halves = split(ip, "::");
			if (length(halves) > 2) return null;
			let parseSeg = (seg) => {
				if (!seg || length(seg) == 0) return [];
				let out = [];
				for (let g in split(seg, ":")) {
					if (!match(g, /^[0-9a-fA-F]{1,4}$/)) return null;
					push(out, hex(g));
				}
				return out;
			};
			let left = parseSeg(halves[0]);
			if (left == null) return null;
			if (length(halves) == 2) {
				let right = parseSeg(halves[1]);
				if (right == null || length(left) + length(right) > 7) return null;
				let res = [...left];
				for (let z = 0; z < 8 - length(left) - length(right); z++) push(res, 0);
				for (let w in right) push(res, w);
				return res;
			}
			return length(left) == 8 ? left : null;
		}

		function isHost(h) {
			let d = replace(lc(trim(h || "")), /\.$/, "");
			return length(d) > 0 && length(d) <= 253 && !isV4(d) && match(d, /^([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z]{2,63}$/);
		}

		let rawSrv = lc(trim(getenv("DNS_SRV") || ""));
		let rawType = lc(trim(getenv("DNS_TYPE") || "udp"));
		let rawBoot = lc(trim(getenv("DNS_BOOTSTRAP") || ""));
		let s = rawSrv;

		let v4 = isV4(s);
		let v6 = v4 ? null : expandV6(s);
		if (!v4 && !v6) {
			if ((rawType == "tls" || rawType == "https") && isHost(rawSrv) && length(rawBoot) > 0) {
				s = rawBoot;
				v4 = isV4(s);
				v6 = v4 ? null : expandV6(s);
			}
		}
		if (!v4 && !v6) exit(1);
		if (v4 && (s == "0.0.0.0" || substr(s, 0, 4) == "127.")) exit(1);
		if (v6) {
			let z5 = (v6[0] == 0 && v6[1] == 0 && v6[2] == 0 && v6[3] == 0 && v6[4] == 0);
			if (z5 && v6[5] == 0 && v6[6] == 0 && (v6[7] == 0 || v6[7] == 1)) exit(1);
			if (z5 && v6[5] == 0xffff && ((v6[6] == 0 && v6[7] == 0) || ((v6[6] >> 8) == 127))) exit(1);
		}

		let p = popen("ubus call network.interface dump 2>/dev/null", "r");
		if (p) {
			let raw = p.read("all") || "";
			p.close();
			let d = json(raw);
			for (let ifc in (d?.interface || [])) {
				for (let k in ["ipv4-address", "ipv6-address"]) {
					for (let a in (ifc[k] || [])) {
						let lip = lc(trim("" + (a?.address || "")));
						if (!lip) continue;
						if (v4 && lip == s) exit(1);
						if (v6) {
							let lv6 = expandV6(lip);
							if (lv6 && sprintf("%J", lv6) == sprintf("%J", v6)) exit(1);
						}
					}
				}
				for (let pa in (ifc["ipv6-prefix-assignment"] || [])) {
					let lip = lc(trim("" + (pa?.["local-address"]?.address || "")));
					if (v6 && lip) {
						let lv6 = expandV6(lip);
						if (lv6 && sprintf("%J", lv6) == sprintf("%J", v6)) exit(1);
					}
				}
			}
		}
		exit(0);
	' 2>/dev/null
}

get_dnsmasq_main_conf() {
	local uci_cfg
	uci_cfg="$(uci -q show "dhcp.@dnsmasq[0]" 2>/dev/null | awk 'NR==1 {split($0, c, /[.=]/); print c[2]}')"
	if [ -n "$uci_cfg" ] && [ -f "/tmp/etc/dnsmasq.conf.$uci_cfg" ]; then
		printf '/tmp/etc/dnsmasq.conf.%s' "$uci_cfg"
	fi
}

get_dnsmasq_conf_file() {
	local main_conf conf_dir=""
	main_conf="$(get_dnsmasq_main_conf)"
	if [ -n "$main_conf" ] && [ -f "$main_conf" ]; then
		conf_dir="$(awk -F '=' '/^conf-dir=/ {sub(/,.*/, "", $2); print $2; exit}' "$main_conf")"
	fi
	[ -n "${conf_dir:-}" ] || conf_dir="/tmp/dnsmasq.d"
	printf '%s/dnsmasq-singsing.conf' "$conf_dir"
}

get_config_dns_field() {
	CONFIG_FILE="$SB_CONFIG" DNS_FIELD="$1" ucode -e '
		import { readfile } from "fs";
		let config = json(readfile(getenv("CONFIG_FILE")) || "{}");
		for (let inbound in (config?.inbounds || [])) {
			if (inbound?.tag != "dns-in") continue;
			let value = inbound[getenv("DNS_FIELD")];
			if (value == null || value == "") exit(1);
			print(value);
			exit(0);
		}
		exit(1);
	'
}

get_config_tun_iface() {
	CONFIG_FILE="$SB_CONFIG" ucode -e '
		import { readfile } from "fs";
		let config = json(readfile(getenv("CONFIG_FILE")) || "{}");
		for (let inbound in (config?.inbounds || [])) {
			if (inbound?.type != "tun") continue;
			let name = inbound?.interface_name || "";
			if (name != "") { print(name); exit(0); }
		}
		exit(0);
	' 2>/dev/null || true
}

is_tun_ready() {
	local iface="$1"
	[ -z "$iface" ] && return 0
	[ -e "/sys/class/net/$iface" ]
}

reload_dnsmasq() {
	if ! /etc/init.d/dnsmasq restart >/dev/null 2>&1 && ! /etc/init.d/dnsmasq reload >/dev/null 2>&1; then
		printf 'dnsmasq restart and reload both failed\n' >&2
		return 1
	fi
	if ! wait_port_listening 53 5; then
		printf 'dnsmasq did not resume listening on port 53\n' >&2
		return 1
	fi
}

dnsmasq_takeover() {
	local manage listen_addr listen_port main_conf conf_file conf_dir tmp_file
	manage="$(uci_get "dns.dnsmasq_manage" "1")"
	if [ "$manage" != "1" ]; then
		dnsmasq_restore
		return $?
	fi

	listen_addr="$(get_config_dns_field listen)" && listen_port="$(get_config_dns_field listen_port)" || {
		printf 'Cannot read the dns-in listener from the active configuration\n' >&2
		return 1
	}
	main_conf="$(get_dnsmasq_main_conf)"
	conf_file="$(get_dnsmasq_conf_file)"
	conf_dir="$(dirname "$conf_file")"

	mkdir -p "$conf_dir" || return 1
	tmp_file="${conf_file}.tmp.$$"
	{
		printf '# Managed by luci-app-singsing (RAM drop-in, zero flash write)\n'
		printf 'no-poll\n'
		printf 'no-resolv\n'
		if [ -z "$main_conf" ] || ! grep -q '^cache-size=' "$main_conf" 2>/dev/null; then
			printf 'cache-size=0\n'
		fi
		printf 'server=%s#%s\n' "$listen_addr" "$listen_port"
	} > "$tmp_file" || return 1

	if [ -f "$conf_file" ] && cmp -s "$tmp_file" "$conf_file"; then
		rm -f "$tmp_file"
		wait_port_listening 53 5
		return $?
	fi
	mv -f "$tmp_file" "$conf_file" || return 1

	if [ -n "$main_conf" ] && command -v dnsmasq >/dev/null 2>&1; then
		if ! dnsmasq --test -C "$main_conf" >/dev/null 2>&1; then
			rm -f "$conf_file"
			logger -t singsing -p daemon.err "dnsmasq --test failed with drop-in; aborted takeover"
			return 1
		fi
	fi

	reload_dnsmasq
}

dnsmasq_restore() {
	local conf_file f changed=0
	conf_file="$(get_dnsmasq_conf_file)"

	for f in "$conf_file" /tmp/dnsmasq.d/dnsmasq-singsing.conf /tmp/dnsmasq.*.d/dnsmasq-singsing.conf; do
		if [ -f "$f" ]; then
			rm -f "$f" || return 1
			changed=1
		fi
	done

	# Also clean up legacy /etc/config/dhcp backup if upgrading from earlier version
	if [ -f "$DNSMASQ_BACKUP" ]; then
		DNSMASQ_BACKUP_FILE="$DNSMASQ_BACKUP" ucode -e '
			import { readfile } from "fs";
			import { cursor } from "uci";
			let raw = readfile(getenv("DNSMASQ_BACKUP_FILE"));
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
		reload_dnsmasq
	fi
}

restore_dnsmasq_handoff() {
	local snapshot="$1" conf_file="$2" tmp_file
	if [ -z "$snapshot" ]; then
		dnsmasq_restore
		return $?
	fi
	mkdir -p "$(dirname "$conf_file")" || return 1
	tmp_file="$(mktemp "$(dirname "$conf_file")/.singsing-restore.XXXXXX")" || return 1
	if ! cp "$snapshot" "$tmp_file" || ! mv -f "$tmp_file" "$conf_file"; then
		rm -f "$tmp_file"
		return 1
	fi
	reload_dnsmasq
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
	case "$eff_url" in
		https://*|http://*) ;;
		*) return 1 ;;
	esac

	dest_dir="$(dirname "$dest")"
	mkdir -p "$dest_dir"
	tmp_file="$TMP_DL_DIR/$(basename "$dest").$$.tmp"

	rm -f "$tmp_file"
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --proto '=http,https' --proto-redir '=http,https' --connect-timeout 6 --max-time 15 -o "$tmp_file" "$eff_url" 2>/dev/null || {
			rm -f "$tmp_file"
			return 1
		}
	elif command -v uclient-fetch >/dev/null 2>&1; then
		uclient-fetch -q -T 15 -O "$tmp_file" "$eff_url" 2>/dev/null || {
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

	# If JSON source rule-set, verify valid JSON safely via getenv
	if [ "$format" = "source" ] && command -v ucode >/dev/null 2>&1; then
		TMP_JSON_FILE="$tmp_file" ucode -e 'import { readfile } from "fs"; if (json(readfile(getenv("TMP_JSON_FILE"))) == null) exit(1);' 2>/dev/null || {
			rm -f "$tmp_file"
			return 1
		}
	fi

	chmod 644 "$tmp_file" 2>/dev/null || true
	mv -f "$tmp_file" "$dest"
	return 0
}

read_safe_manifest() {
	local manifest="${1:-$MANIFEST_FILE}" ruleset_dir
	ruleset_dir="$(uci_get "main.ruleset_dir" "/etc/sing-box/rule-sets")"
	MANIFEST_PATH="$manifest" RULESET_DIR="$ruleset_dir" ucode -e '
		import { readfile } from "fs";
		let dir = replace(getenv("RULESET_DIR") || "/etc/sing-box/rule-sets", /\/+$/, "");
		if (substr(dir, 0, 1) != "/" || index(dir, "..") >= 0) exit(1);
		let arr = json(readfile(getenv("MANIFEST_PATH")) || "[]");
		if (type(arr) == "array") {
			for (let r in arr) {
				if (type(r) != "object") continue;
				let tag = "" + (r.tag || "");
				if (index(tag, "..") >= 0 || !match(tag, /^[a-zA-Z0-9_!@-][a-zA-Z0-9_!@.-]{0,127}$/)) continue;
				let fmt = (r.format == "source") ? "source" : "binary";
				let url = trim("" + (r.url || ""));
				if (length(url) > 0 && !match(url, /^https?:\/\/[^[:space:]]+$/)) continue;
				let ext = (fmt == "source") ? "json" : "srs";
				printf("%s\t%s\t%s\t%s/%s.%s\n", tag, url, fmt, dir, tag, ext);
			}
		}
	' 2>/dev/null || true
}

ensure_rulesets() {
	local manifest="${1:-$MANIFEST_FILE}"
	[ -f "$manifest" ] || return 0
	ensure_dirs

	local lines tag url format path
	lines="$(read_safe_manifest "$manifest")"
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

	(
		flock -x -n 9 || {
			printf '{"ok":false,"updated":[],"failed":[],"error":"Another apply or update operation is in progress"}\n'
			exit 1
		}

		local lines tmp_res changed=0
		lines="$(read_safe_manifest)"
		tmp_res="$TMP_DIR/ruleset-update.$$.tmp"
		trap 'rm -f "$tmp_res"' EXIT INT TERM
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

		if grep -q '^OK	' "$tmp_res" 2>/dev/null && [ -n "$(get_service_pid)" ]; then
			SINGSING_FROM_APPLY=1 /etc/init.d/singsing restart >/dev/null 2>&1 || true
			if wait_dns_ready 8; then
				dnsmasq_takeover
			fi
		fi

		RES_FILE="$tmp_res" ucode -e '
			import { readfile } from "fs";
			let raw = readfile(getenv("RES_FILE")) || "";
			let updated = [], failed = [];
			for (let line in split(raw, "\n")) {
				let p = split(line, "\t");
				if (length(p) < 2 || length(p[1]) == 0) continue;
				if (p[0] == "OK") push(updated, p[1]);
				else push(failed, p[1]);
			}
			let ok = (length(failed) == 0);
			printf("%J\n", { ok: ok, updated: updated, failed: failed });
			exit(ok ? 0 : 1);
		'
	) 9>"$LOCK_FILE"
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
			let d = null;
			try { d = json(stdin.read("all") || "{}"); } catch (e) { d = null; }
			let inst = d?.["singsing"]?.instances?.["singsing"];
			if (inst && inst.running && inst.pid) print(inst.pid);
		' 2>/dev/null || true)"
	fi
	printf '%s' "$pid"
}

reload_if_running() {
	[ -n "$(get_service_pid)" ] || return 0
	(
		flock -x -n 9 || exit 0
		if [ -n "$(get_service_pid)" ]; then
			SINGSING_FROM_APPLY=1 /etc/init.d/singsing restart >/dev/null 2>&1 || true
			if wait_dns_ready 8; then
				dnsmasq_takeover
			fi
		fi
	) 9>"$LOCK_FILE"
}

wait_dns_ready() {
	local port tun_iface timeout i pid has_sock_tool=0
	port="$(get_config_dns_field listen_port)" || return 1
	tun_iface="$(get_config_tun_iface)"
	timeout="${1:-10}"
	if command -v ss >/dev/null 2>&1 || command -v netstat >/dev/null 2>&1; then
		has_sock_tool=1
	fi
	i=0
	while [ "$i" -lt "$timeout" ]; do
		pid="$(get_service_pid)"
		if [ -n "$pid" ]; then
			if [ "$has_sock_tool" -eq 1 ]; then
				if is_port_listening "$port" && is_tun_ready "$tun_iface"; then
					return 0
				fi
			else
				# Fallback: process stayed alive >= 2 seconds and TUN ready
				if [ "$i" -ge 2 ] && is_tun_ready "$tun_iface"; then
					return 0
				fi
			fi
		fi
		sleep 1
		i=$((i + 1))
	done
	return 1
}

wait_service_stopped() {
	local i=0
	while [ "$i" -lt 6 ]; do
		[ -n "$(get_service_pid)" ] || return 0
		sleep 1
		i=$((i + 1))
	done
	printf 'sing-box is still running after stop\n' >&2
	return 1
}

apply_config() {
	local candidate="${1:-$TMP_NEW_CONFIG}" candidate_manifest="${2:-}"
	ensure_dirs
	(
		flock -x -n 9 || {
			printf 'Another apply operation is already in progress\n' >&2
			exit 1
		}

		local staged_config="" staged_manifest="" previous_config="" staged_last_good="" previous_dns="" dns_conf=""
		local had_config=0 was_running=0 failed_step
		trap 'rm -f "$TX_FILE" "$staged_config" "$staged_manifest" "$previous_config" "$staged_last_good" "$previous_dns"' EXIT
		trap 'exit 1' INT TERM

		local enabled_flag local_dns auto_rollback err_out
		enabled_flag="$(uci_get "main.enabled" "0")"
		if [ "$enabled_flag" != "1" ]; then
			[ "$candidate" != "$TMP_NEW_CONFIG" ] || rm -f "$TMP_NEW_CONFIG"
			if [ -n "$(get_service_pid)" ]; then
				if ! /etc/init.d/singsing stop || ! wait_service_stopped; then
					printf 'Could not stop sing-box while applying disabled settings\n' >&2
					exit 1
				fi
			fi
			dnsmasq_restore || exit 1
			cron_remove >/dev/null 2>&1 || true
			exit 0
		fi

		if ! check_local_dns; then
			printf 'Valid direct upstream DNS configuration (dns.local_server / dns.local_bootstrap) is required before applying\n' >&2
			exit 1
		fi

		if [ ! -s "$candidate" ]; then
			printf 'Candidate config not found: %s\n' "$candidate" >&2
			exit 1
		fi

		echo "applying" > "$TX_FILE"

		# 1. Ensure local rule-sets exist (auto-download missing ones)
		if ! err_out="$(ensure_rulesets "${candidate_manifest:-$MANIFEST_FILE}" 2>&1)"; then
			printf '%s\n' "$err_out" >&2
			exit 1
		fi

		# 2. Validate candidate config with sing-box check
		if ! err_out="$(validate_config "$candidate" 2>&1)"; then
			printf 'Config check failed:\n%s\n' "$err_out" >&2
			exit 1
		fi

		# Stage on the persistent filesystem so publishing uses a rename.
		umask 077
		staged_config="$(mktemp "$CONF_DIR/.config.XXXXXX")" &&
			cp "$candidate" "$staged_config" || exit 1
		if [ -n "$candidate_manifest" ]; then
			staged_manifest="$(mktemp "$CONF_DIR/.manifest.XXXXXX")" &&
				cp "$candidate_manifest" "$staged_manifest" || exit 1
		fi

		# Save the current config and DNS handoff in transaction-local temps before changing either.
		if [ -n "$(get_service_pid)" ]; then
			was_running=1
			dns_conf="$(get_dnsmasq_conf_file)"
			if [ -f "$dns_conf" ]; then
				previous_dns="$(mktemp "$TMP_DIR/.dnsmasq.XXXXXX")" &&
					cp "$dns_conf" "$previous_dns" || exit 1
			fi
		fi
		if [ -s "$SB_CONFIG" ]; then
			previous_config="$(mktemp "$CONF_DIR/.prev.XXXXXX")" &&
				cp "$SB_CONFIG" "$previous_config" || exit 1
			had_config=1
		fi

		# 4. Atomically install new config and ensure stock sing-box init does not collide
		mv -f "$staged_config" "$SB_CONFIG" || exit 1
		staged_config=""
		[ "$candidate" != "$TMP_NEW_CONFIG" ] || rm -f "$TMP_NEW_CONFIG"
		disable_stock_singbox >/dev/null 2>&1 || true

		# 5. Restart, verify DNS + TUN readiness, take over dnsmasq, publish manifest, and record last-good.
		if ! SINGSING_FROM_APPLY=1 /etc/init.d/singsing restart; then
			failed_step='sing-box restart failed'
		elif ! wait_dns_ready 10; then
			failed_step='sing-box DNS or TUN did not become ready'
		elif ! dnsmasq_takeover; then
			failed_step='dnsmasq takeover failed'
		elif [ -n "$staged_manifest" ] && ! mv -f "$staged_manifest" "$MANIFEST_FILE"; then
			failed_step='Could not publish the rule-set manifest'
		else
			staged_manifest=""
			cron_sync >/dev/null 2>&1 || true
			staged_last_good="$(mktemp "$CONF_DIR/.last-good.XXXXXX")" &&
				cp "$SB_CONFIG" "$staged_last_good" &&
				mv -f "$staged_last_good" "$SB_LAST_GOOD" &&
				staged_last_good="" ||
				logger -t singsing -p daemon.warn "Applied config succeeded, but failed to update $SB_LAST_GOOD"
			exit 0
		fi
		printf '%s\n' "$failed_step" >&2

		# Always restore files. The setting controls whether to restart the old service.
		auto_rollback="$(uci_get "main.auto_rollback" "1")"
		if [ "$had_config" -eq 1 ]; then
			staged_config="$(mktemp "$CONF_DIR/.restore.XXXXXX")" || staged_config=""
			if [ -z "$staged_config" ] || ! cp "$previous_config" "$staged_config" || ! mv -f "$staged_config" "$SB_CONFIG"; then
				printf 'Could not restore active config; the last good copy is at %s\n' "$SB_LAST_GOOD" >&2
				had_config=0
			elif [ "$auto_rollback" = "1" ] && [ "$was_running" -eq 1 ]; then
				staged_config=""
				if SINGSING_FROM_APPLY=1 /etc/init.d/singsing restart &&
					wait_dns_ready 8 && restore_dnsmasq_handoff "$previous_dns" "$dns_conf"; then
					printf 'Rolled back to previous config and restored the previous service\n' >&2
					exit 2
				fi
				printf 'Could not restore the previous running service\n' >&2
			else
				staged_config=""
			fi
		fi

		if ! /etc/init.d/singsing stop || ! wait_service_stopped; then
			printf 'Could not stop the failed service\n' >&2
		fi
		dnsmasq_restore || printf 'Could not restore normal dnsmasq service\n' >&2
		[ "$had_config" -ne 0 ] || rm -f "$SB_CONFIG" || printf 'Could not remove the failed active config\n' >&2
		exit 1
	) 9>"$LOCK_FILE"
}

write_config() {
	local candidate="${1:-$TMP_NEW_CONFIG}" candidate_manifest="${2:-}"
	ensure_dirs
	(
		flock -x -n 9 || {
			printf 'Another apply operation is already in progress\n' >&2
			exit 1
		}

		local staged_config="" staged_manifest="" local_dns
		trap 'rm -f "$staged_config" "$staged_manifest"' EXIT
		trap 'exit 1' INT TERM

		if [ -n "$(get_service_pid)" ]; then
			printf 'sing-box is currently running; use apply_config to update a live service\n' >&2
			exit 1
		fi

		if ! check_local_dns; then
			printf 'Valid direct upstream DNS configuration (dns.local_server / dns.local_bootstrap) is required before writing config\n' >&2
			exit 1
		fi

		if [ ! -s "$candidate" ]; then
			printf 'Candidate config not found: %s\n' "$candidate" >&2
			exit 1
		fi

		umask 077
		staged_config="$(mktemp "$CONF_DIR/.config.XXXXXX")" &&
			cp "$candidate" "$staged_config" || exit 1
		if [ -n "$candidate_manifest" ]; then
			staged_manifest="$(mktemp "$CONF_DIR/.manifest.XXXXXX")" &&
				cp "$candidate_manifest" "$staged_manifest" || exit 1
		fi

		mv -f "$staged_config" "$SB_CONFIG" || exit 1
		staged_config=""
		[ "$candidate" != "$TMP_NEW_CONFIG" ] || rm -f "$TMP_NEW_CONFIG"
		if [ -n "$staged_manifest" ]; then
			mv -f "$staged_manifest" "$MANIFEST_FILE" || exit 1
			staged_manifest=""
		fi
		exit 0
	) 9>"$LOCK_FILE"
}

validate_cron_number() {
	case "$1" in
		''|*[!0-9]*) return 1 ;;
	esac
	[ "$1" -ge "$2" ] 2>/dev/null && [ "$1" -le "$3" ] 2>/dev/null
}

validate_cron_field() {
	local field="$1" minimum="$2" maximum="$3"
	local item base step start end old_ifs
	case "$field" in
		''|,*|*,|*,,*|*[!0-9*/,-]*) return 1 ;;
	esac
	old_ifs="$IFS"
	IFS=','
	set -f
	# shellcheck disable=SC2086
	set -- $field
	set +f
	IFS="$old_ifs"
	for item in "$@"; do
		base="${item%%/*}"
		if [ "$base" != "$item" ]; then
			step="${item#*/}"
			[ "${step#*/}" = "$step" ] || return 1
			validate_cron_number "$step" 1 "$((maximum - minimum + 1))" || return 1
		fi
		[ "$base" = '*' ] && continue
		start="${base%%-*}"
		if [ "$start" != "$base" ]; then
			end="${base#*-}"
			[ -n "$start" ] && [ -n "$end" ] && [ "${end#*-}" = "$end" ] || return 1
			validate_cron_number "$start" "$minimum" "$maximum" || return 1
			validate_cron_number "$end" "$minimum" "$maximum" || return 1
			[ "$start" -le "$end" ] || return 1
		else
			validate_cron_number "$base" "$minimum" "$maximum" || return 1
		fi
	done
}

validate_cron_expr() {
	local expr="$1"
	case "$expr" in
		""|*[!0-9*/,\ -]*) return 1 ;;
	esac
	set -f
	# shellcheck disable=SC2086
	set -- $expr
	set +f
	[ "$#" -eq 5 ] || return 1
	validate_cron_field "$1" 0 59 &&
		validate_cron_field "$2" 0 23 &&
		validate_cron_field "$3" 1 31 &&
		validate_cron_field "$4" 1 12 &&
		validate_cron_field "$5" 0 6
}

cron_configure() {
	local want_enabled="$1" expr="$2"
	local cron_dir lock_dir tmp="" changed=0

	if [ "$want_enabled" != "1" ] && [ ! -f "$CRON_FILE" ]; then
		return 0
	fi
	if [ "$want_enabled" != "1" ] && ! grep -qF "$CRON_TAG" "$CRON_FILE" 2>/dev/null; then
		return 0
	fi

	cron_dir="$(dirname "$CRON_FILE")"
	lock_dir="$(dirname "$CRON_LOCK")"
	mkdir -p "$cron_dir" "$lock_dir" || return 1

	(
		if command -v lock >/dev/null 2>&1; then
			lock "$CRON_LOCK" || exit 1
			trap 'rm -f "$tmp"; lock -u "$CRON_LOCK"' EXIT INT TERM
		else
			trap 'rm -f "$tmp"' EXIT INT TERM
		fi

		tmp="$(mktemp "$cron_dir/.singsing-cron.XXXXXX")" || exit 1
		if [ -f "$CRON_FILE" ]; then
			grep -vF "$CRON_TAG" "$CRON_FILE" > "$tmp" 2>/dev/null || : > "$tmp"
		else
			: > "$tmp"
		fi

		if [ "$want_enabled" = "1" ]; then
			if validate_cron_expr "$expr"; then
				printf '%s /usr/share/singsing/service-manager.sh update_rulesets >/dev/null 2>&1 %s\n' "$expr" "$CRON_TAG" >> "$tmp"
			else
				logger -t singsing -p daemon.warn "Ignoring invalid ruleset_update_cron expression: $expr"
			fi
		fi

		chmod 600 "$tmp" || exit 1
		if [ -f "$CRON_FILE" ] && cmp -s "$tmp" "$CRON_FILE"; then
			rm -f "$tmp"
			tmp=""
		else
			mv -f "$tmp" "$CRON_FILE" || exit 1
			tmp=""
			changed=1
		fi

		if [ "$changed" -eq 1 ]; then
			printf 'root\n' >> "$cron_dir/cron.update" 2>/dev/null || true
		fi
	)
}

cron_sync() {
	local enabled auto_update expr
	enabled="$(uci_get "main.enabled" "0")"
	auto_update="$(uci_get "main.ruleset_auto_update" "0")"
	expr="$(uci_get "main.ruleset_update_cron" "0 4 * * *")"
	if [ "$enabled" = "1" ] && [ "$auto_update" = "1" ]; then
		cron_configure 1 "$expr"
	else
		cron_configure 0 ""
	fi
}

cron_remove() {
	cron_configure 0 ""
}

case "${1:-}" in
	ensure_dirs)            ensure_dirs ;;
	disable_stock_singbox)  disable_stock_singbox ;;
	check_local_dns)        check_local_dns "${2:-}" "${3:-}" "${4:-}" ;;
	dnsmasq_takeover)       dnsmasq_takeover ;;
	dnsmasq_restore)        dnsmasq_restore ;;
	ensure_rulesets)        ensure_rulesets ;;
	update_rulesets)        update_rulesets "${2:-}" ;;
	cron_sync)              cron_sync ;;
	cron_remove)            cron_remove ;;
	reload_if_running)      reload_if_running ;;
	validate_config)        validate_config "${2:-$TMP_NEW_CONFIG}" ;;
	wait_dns_ready)         wait_dns_ready "${2:-10}" ;;
	wait_service_stopped)   wait_service_stopped ;;
	write_config)           write_config "${2:-}" "${3:-}" ;;
	apply_config)           apply_config "${2:-}" "${3:-}" ;;
	*)
		printf 'Usage: %s {ensure_dirs|disable_stock_singbox|check_local_dns|dnsmasq_takeover|dnsmasq_restore|ensure_rulesets|update_rulesets|cron_sync|cron_remove|reload_if_running|validate_config|wait_dns_ready|write_config|apply_config}\n' "$0" >&2
		exit 1
		;;
esac
