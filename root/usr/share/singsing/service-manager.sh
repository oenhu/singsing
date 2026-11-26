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
	local srv=""
	if [ "$#" -gt 0 ]; then
		srv="$1"
	else
		srv="$(uci_get "dns.local_server" "")"
	fi
	[ -n "$srv" ] || return 1

	DNS_SRV="$srv" ucode -e '
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

		let s = lc(trim(getenv("DNS_SRV") || ""));
		let v4 = isV4(s);
		let v6 = v4 ? null : expandV6(s);
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

dnsmasq_takeover() {
	local manage listen_addr listen_port main_conf conf_file conf_dir tmp_file
	manage="$(uci_get "dns.dnsmasq_manage" "1")"
	if [ "$manage" != "1" ]; then
		dnsmasq_restore
		return 0
	fi

	listen_addr="$(uci_get "dns.listen_address" "127.0.0.1")"
	listen_port="$(uci_get "dns.listen_port" "5335")"
	main_conf="$(get_dnsmasq_main_conf)"
	conf_file="$(get_dnsmasq_conf_file)"
	conf_dir="$(dirname "$conf_file")"

	mkdir -p "$conf_dir"
	tmp_file="${conf_file}.tmp.$$"
	{
		printf '# Managed by luci-app-singsing (RAM drop-in, zero flash write)\n'
		printf 'no-poll\n'
		printf 'no-resolv\n'
		if [ -z "$main_conf" ] || ! grep -q '^cache-size=' "$main_conf" 2>/dev/null; then
			printf 'cache-size=0\n'
		fi
		printf 'server=%s#%s\n' "$listen_addr" "$listen_port"
	} > "$tmp_file"

	if [ -f "$conf_file" ] && cmp -s "$tmp_file" "$conf_file"; then
		rm -f "$tmp_file"
		return 0
	fi
	mv -f "$tmp_file" "$conf_file"

	if [ -n "$main_conf" ] && command -v dnsmasq >/dev/null 2>&1; then
		if ! dnsmasq --test -C "$main_conf" >/dev/null 2>&1; then
			rm -f "$conf_file"
			logger -t singsing -p daemon.err "dnsmasq --test failed with drop-in; aborted takeover"
			return 1
		fi
	fi

	/etc/init.d/dnsmasq restart >/dev/null 2>&1 || /etc/init.d/dnsmasq reload >/dev/null 2>&1 || true
	wait_port_listening 53 5 || true
}

dnsmasq_restore() {
	local conf_file f changed=0
	conf_file="$(get_dnsmasq_conf_file)"

	for f in "$conf_file" /tmp/dnsmasq.d/dnsmasq-singsing.conf /tmp/dnsmasq.*.d/dnsmasq-singsing.conf; do
		if [ -f "$f" ]; then
			rm -f "$f"
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
		/etc/init.d/dnsmasq restart >/dev/null 2>&1 || /etc/init.d/dnsmasq reload >/dev/null 2>&1 || true
		wait_port_listening 53 5 || true
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
	local port timeout i pid has_sock_tool=0
	port="$(uci_get "dns.listen_port" "5335")"
	timeout="${1:-10}"
	if command -v ss >/dev/null 2>&1 || command -v netstat >/dev/null 2>&1; then
		has_sock_tool=1
	fi
	i=0
	while [ "$i" -lt "$timeout" ]; do
		pid="$(get_service_pid)"
		if [ -n "$pid" ]; then
			if [ "$has_sock_tool" -eq 1 ]; then
				if is_port_listening "$port"; then
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
	local candidate="${1:-$TMP_NEW_CONFIG}" candidate_manifest="${2:-}"
	ensure_dirs
	(
		flock -x -n 9 || {
			printf 'Another apply operation is already in progress\n' >&2
			exit 1
		}

		local staged_config="" staged_manifest="" had_config=0
		trap 'rm -f "$TX_FILE" "$staged_config" "$staged_manifest"' EXIT
		trap 'exit 1' INT TERM

		local enabled_flag local_dns auto_rollback err_out
		enabled_flag="$(uci_get "main.enabled" "0")"
		if [ "$enabled_flag" != "1" ]; then
			[ "$candidate" != "$TMP_NEW_CONFIG" ] || rm -f "$TMP_NEW_CONFIG"
			if [ -n "$(get_service_pid)" ]; then
				/etc/init.d/singsing stop >/dev/null 2>&1 || true
			fi
			dnsmasq_restore
			exit 0
		fi

		local_dns="$(uci_get "dns.local_server" "")"
		if ! check_local_dns "$local_dns"; then
			printf 'Valid direct upstream DNS IP (dns.local_server) is required before applying\n' >&2
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

		# 3. Backup current good config
		if [ -s "$SB_CONFIG" ]; then
			cp -f "$SB_CONFIG" "$SB_LAST_GOOD" || exit 1
			had_config=1
		fi

		# 4. Atomically install new config and ensure stock sing-box init does not collide
		mv -f "$staged_config" "$SB_CONFIG" || exit 1
		[ "$candidate" != "$TMP_NEW_CONFIG" ] || rm -f "$TMP_NEW_CONFIG"
		disable_stock_singbox >/dev/null 2>&1 || true

		# 5. Restart and publish the matching manifest after the health check.
		if SINGSING_FROM_APPLY=1 /etc/init.d/singsing restart >/dev/null 2>&1 &&
			wait_dns_ready 10 && dnsmasq_takeover; then
			if [ -z "$staged_manifest" ] || mv -f "$staged_manifest" "$MANIFEST_FILE"; then
				exit 0
			fi
		fi

		# 6. Auto rollback on startup failure
		auto_rollback="$(uci_get "main.auto_rollback" "1")"
		if [ "$auto_rollback" = "1" ] && [ "$had_config" -eq 1 ] &&
			cp "$SB_LAST_GOOD" "$staged_config" &&
			mv -f "$staged_config" "$SB_CONFIG" &&
			SINGSING_FROM_APPLY=1 /etc/init.d/singsing restart >/dev/null 2>&1 &&
			wait_dns_ready 8 && dnsmasq_takeover; then
			printf 'New config failed to start; rolled back to last good config\n' >&2
			exit 2
		fi

		# Complete failure: restore dnsmasq so router retains internet access
		dnsmasq_restore
		/etc/init.d/singsing stop >/dev/null 2>&1 || true
		[ "$had_config" -ne 0 ] || rm -f "$SB_CONFIG"
		printf 'sing-box failed to start; dnsmasq restored for safety\n' >&2
		exit 1
	) 9>"$LOCK_FILE"
}

notify_cron() {
	# Safe BusyBox crond reload: never restart crond if already running (safe inside cron jobs).
	# If crond is not running yet (e.g. fresh OpenWrt install where /etc/crontabs was empty), start it.
	local cron_running=0
	if command -v ubus >/dev/null 2>&1 && command -v ucode >/dev/null 2>&1; then
		cron_running="$(ubus call service list '{"name":"cron"}' 2>/dev/null | ucode -e '
			import { stdin } from "fs";
			let d = json(stdin.read("all") || "{}");
			let insts = d?.cron?.instances;
			if (type(insts) == "object") {
				for (let k, v in insts) if (v && v.running) { print(1); exit(0); }
			}
			print(0);
		' 2>/dev/null || printf '0')"
	fi
	if [ "$cron_running" = "1" ]; then
		printf '%s\n' 'root' >> /etc/crontabs/cron.update
	else
		/etc/init.d/cron start >/dev/null 2>&1 || true
	fi
}

cron_remove() {
	local crontab="/etc/crontabs/root"
	local cron_lock="/var/lock/root-crontab"
	local tmp="" changed=0
	[ -f "$crontab" ] || return 0

	mkdir -p "$(dirname "$cron_lock")"
	(
		lock "$cron_lock" || exit 1
		trap '[ -n "${tmp:-}" ] && rm -f "$tmp"; lock -u "$cron_lock" 2>/dev/null || true' EXIT INT TERM
		tmp="$(mktemp /etc/crontabs/.singbox-cron.XXXXXX)" || exit 1
		grep -v "# singsing-sub" "$crontab" > "$tmp" 2>/dev/null || : > "$tmp"
		chmod 600 "$tmp" 2>/dev/null || true
		if ! cmp -s "$tmp" "$crontab"; then
			mv -f "$tmp" "$crontab"
			tmp=""
			changed=1
		fi
		[ "$changed" -eq 0 ] || notify_cron
	)
}

cron_sync() {
	local auto_update interval crontab cron_lock expr tmp="" changed=0
	auto_update="$(uci_get "subscription.auto_update" "0")"
	interval="$(uci_get "subscription.update_interval" "86400")"
	crontab="/etc/crontabs/root"
	cron_lock="/var/lock/root-crontab"

	mkdir -p /etc/crontabs "$(dirname "$cron_lock")"
	(
		lock "$cron_lock" || exit 1
		trap '[ -n "${tmp:-}" ] && rm -f "$tmp"; lock -u "$cron_lock" 2>/dev/null || true' EXIT INT TERM
		tmp="$(mktemp /etc/crontabs/.singbox-cron.XXXXXX)" || exit 1

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
			tmp=""
		else
			mv -f "$tmp" "$crontab"
			tmp=""
			changed=1
		fi
		[ "$changed" -eq 0 ] || notify_cron
	)
}

case "${1:-}" in
	ensure_dirs)            ensure_dirs ;;
	disable_stock_singbox)  disable_stock_singbox ;;
	check_local_dns)        check_local_dns "${2:-}" ;;
	dnsmasq_takeover)       dnsmasq_takeover ;;
	dnsmasq_restore)        dnsmasq_restore ;;
	ensure_rulesets)        ensure_rulesets ;;
	update_rulesets)        update_rulesets "${2:-}" ;;
	reload_if_running)      reload_if_running ;;
	validate_config)        validate_config "${2:-$TMP_NEW_CONFIG}" ;;
	wait_dns_ready)         wait_dns_ready "${2:-10}" ;;
	apply_config)           apply_config "${2:-}" "${3:-}" ;;
	cron_sync)              cron_sync ;;
	cron_remove)            cron_remove ;;
	*)
		printf 'Usage: %s {ensure_dirs|disable_stock_singbox|check_local_dns|dnsmasq_takeover|dnsmasq_restore|ensure_rulesets|update_rulesets|reload_if_running|validate_config|wait_dns_ready|apply_config|cron_sync|cron_remove}\n' "$0" >&2
		exit 1
		;;
esac
