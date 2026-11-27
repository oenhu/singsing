import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run the repository shell with its constant paths rewritten into a private
// directory. Only the host OpenWrt commands and the optional check binary are simulated.
export function serviceApplyFixture() {
  const dir = mkdtempSync(join(tmpdir(), "singsing-service-"));
  const configDir = join(dir, "config");
  const runtimeDir = join(dir, "runtime");
  const initDir = join(dir, "init.d");
  const dnsDir = join(dir, "dns");
  const cronDir = join(dir, "crontabs");
  const binDir = join(dir, "bin");
  for (const path of [configDir, runtimeDir, initDir, dnsDir, cronDir, binDir]) mkdirSync(path);
  const config = join(configDir, "sing-box.json");
  const lastGood = join(configDir, "sing-box.last-good.json");
  const manifest = join(configDir, "rulesets-manifest.json");
  const candidate = join(dir, "candidate.json");
  const candidateManifest = join(dir, "candidate-manifest.json");
  const running = join(dir, "running");
  const dropIn = join(dnsDir, "dnsmasq-singsing.conf");
  const cronFile = join(cronDir, "root");
  const cronLock = join(runtimeDir, "root-crontab");
  const cronUpdate = join(cronDir, "cron.update");
  const cronEvents = join(dir, "cron-events");
  const events = join(dir, "events");
  const mockBox = join(dir, "sing-box-mock");
  const manager = join(dir, "service-manager.sh");
  const source = readFileSync(new URL("../root/usr/share/singsing/service-manager.sh", import.meta.url), "utf8")
    .replace(/\/etc\/init\.d\/(singsing|sing-box|dnsmasq|cron)/g, initDir + "/$1")
    .replace('CONF_DIR="/etc/singsing"', 'CONF_DIR="' + configDir + '"')
    .replace('SB_DIR="/etc/sing-box"', 'SB_DIR="' + join(dir, "sing-box-state") + '"')
    .replace('TMP_DIR="/tmp/singsing"', 'TMP_DIR="' + runtimeDir + '"')
    .replace('CRON_FILE="/etc/crontabs/root"', 'CRON_FILE="' + cronFile + '"')
    .replace('CRON_LOCK="/var/lock/root-crontab"', 'CRON_LOCK="' + cronLock + '"')
    .replaceAll("/tmp/dnsmasq.d/", dnsDir + "/")
    .replaceAll("/tmp/dnsmasq.*.d/", dnsDir + "/*/");
  const dispatch = source.lastIndexOf('\ncase "\u0024{1:-}" in');
  if (dispatch < 0) throw new Error("Could not isolate the service-manager dispatch");
  const stubs = [
    'uci_get() {',
    '  case "$1" in',
    '    main.enabled) printf "%s" "\u0024{MOCK_ENABLED:-1}";;',
    '    main.auto_rollback) printf "%s" "\u0024{MOCK_ROLLBACK:-1}";;',
    '    main.singbox_bin) printf "%s" "$MOCK_BOX";;',
    '    main.ruleset_dir|main.tailscale_state_root) printf "%s" "$MOCK_DATA_DIR";;',
    '    main.ruleset_auto_update) printf "%s" "\u0024{MOCK_CRON_ENABLED:-0}";;',
    '    main.ruleset_update_cron) printf "%s" "\u0024{MOCK_CRON_EXPR:-0 4 * * *}";;',
    '    dns.local_server) printf "%s" "\u0024{MOCK_LOCAL_SERVER-223.5.5.5}";;',
    '    dns.local_type) printf "%s" "\u0024{MOCK_LOCAL_TYPE:-udp}";;',
    '    dns.local_bootstrap) printf "%s" "\u0024{MOCK_LOCAL_BOOTSTRAP:-}";;',
    '    dns.listen_port) printf "%s" "\u0024{MOCK_NEW_PORT:-5335}";;',
    '    *) printf "%s" "\u0024{2:-}";;',
    '  esac',
    '}',
    'if [ "\u0024{MOCK_REAL_CHECK_DNS:-0}" != "1" ]; then check_local_dns() { return 0; }; fi',
    'if [ "\u0024{MOCK_CRON_RUNNING_MODE:-}" = "running" ]; then is_cron_running() { return 0; }; elif [ "\u0024{MOCK_CRON_RUNNING_MODE:-}" = "stopped" ]; then is_cron_running() { return 1; }; fi',
    'flock() { return 0; }',
    'ensure_rulesets() { return 0; }',
    'get_service_pid() { if [ -f "$MOCK_RUNNING" ]; then printf 123; fi; }',
    'get_dnsmasq_main_conf() { :; }',
    'get_dnsmasq_conf_file() { printf "%s" "$MOCK_DROP_IN"; }',
    'get_config_dns_field() {',
    '  case "$1" in',
    '    listen) printf 127.0.0.1;;',
    '    listen_port) if grep -q "5336" "$SB_CONFIG"; then printf 5336; else printf 5335; fi;;',
    '    *) return 1;;',
    '  esac',
    '}',
    'get_config_tun_iface() {',
    '  if grep -q \x27"type":"tun"\x27 "$SB_CONFIG"; then printf singtun; fi',
    '}',
    'is_tun_ready() {',
    '  [ -z "$1" ] && return 0',
    '  if grep -q candidate "$SB_CONFIG" && [ "\u0024{MOCK_FAIL_TUN:-0}" = 1 ]; then return 1; fi',
    '  return 0',
    '}',
    'is_port_listening() {',
    '  [ "$1" = 53 ] && return 0',
    '  [ -f "$MOCK_RUNNING" ] && [ "$1" = "$(cat "$MOCK_RUNNING")" ]',
    '}',
    'ss() { :; }',
    'sleep() { :; }',
  ].join("\n");
  writeFileSync(manager, source.slice(0, dispatch) + "\n" + stubs + source.slice(dispatch), { mode: 0o700 });
  writeFileSync(join(initDir, "cron"), [
    "#!/bin/sh",
    'printf "cron:%s\\n" "$1" >> "$MOCK_CRON_EVENTS"',
    'if [ "$1" = "enabled" ]; then exit "${MOCK_CRON_INIT_ENABLED:-1}"; fi',
    "exit 0",
  ].join("\n"), { mode: 0o700 });
  // Lightweight ucode shim for check_local_dns dispatch tests on hosts without OpenWrt ucode
  writeFileSync(join(binDir, "ucode"), [
    "#!/usr/bin/env node",
    'const { isIP } = require("node:net");',
    'const rawSrv = (process.env.DNS_SRV || "").trim().toLowerCase();',
    'const rawType = (process.env.DNS_TYPE || "udp").trim().toLowerCase();',
    'const rawBoot = (process.env.DNS_BOOTSTRAP || "").trim().toLowerCase();',
    'const lanIps = JSON.parse(process.env.MOCK_ROUTER_IPS || "[]").map((x) => x.toLowerCase());',
    'function expandV6(raw) {',
    '  let ip = raw.trim();',
    '  if (!ip.includes(":")) return null;',
    '  if ((ip.startsWith(":") && !ip.startsWith("::")) || (ip.endsWith(":") && !ip.endsWith("::"))) return null;',
    '  const lc = ip.lastIndexOf(":"); const tail = ip.slice(lc + 1);',
    '  if (tail.includes(".")) {',
    '    if (isIP(tail) !== 4) return null;',
    '    const p = tail.split(".").map(Number);',
    '    ip = ip.slice(0, lc + 1) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);',
    '  }',
    '  const halves = ip.split("::"); if (halves.length > 2) return null;',
    '  const parse = (s) => { if (!s) return []; const o = []; for (const g of s.split(":")) { if (!/^[0-9a-f]{1,4}$/.test(g)) return null; o.push(parseInt(g, 16)); } return o; };',
    '  const l = parse(halves[0]); if (!l) return null;',
    '  if (halves.length === 2) { const r = parse(halves[1]); if (!r || l.length + r.length > 7) return null; return [...l, ...Array(8 - l.length - r.length).fill(0), ...r]; }',
    '  return l.length === 8 ? l : null;',
    '}',
    'const isHost = (h) => { const d = h.replace(/\\.$/, ""); return d.length > 0 && d.length <= 253 && isIP(d) !== 4 && /^([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\\.)+[a-z]{2,63}$/.test(d); };',
    'let s = rawSrv; let v4 = isIP(s) === 4; let v6 = v4 ? null : expandV6(s);',
    'if (!v4 && !v6 && (rawType === "tls" || rawType === "https") && isHost(rawSrv) && rawBoot.length > 0) { s = rawBoot; v4 = isIP(s) === 4; v6 = v4 ? null : expandV6(s); }',
    'if (!v4 && !v6) process.exit(1);',
    'if (v4 && (s === "0.0.0.0" || s.startsWith("127."))) process.exit(1);',
    'if (v6) {',
    '  const z5 = v6.slice(0, 5).every((x) => x === 0);',
    '  if (z5 && v6[5] === 0 && v6[6] === 0 && (v6[7] === 0 || v6[7] === 1)) process.exit(1);',
    '  if (z5 && v6[5] === 0xffff && ((v6[6] === 0 && v6[7] === 0) || ((v6[6] >> 8) === 127))) process.exit(1);',
    '}',
    'for (const lip of lanIps) {',
    '  if (v4 && lip === s) process.exit(1);',
    '  if (v6) { const lv6 = expandV6(lip); if (lv6 && JSON.stringify(lv6) === JSON.stringify(v6)) process.exit(1); }',
    '}',
    'process.exit(0);',
  ].join("\n"), { mode: 0o700 });
  writeFileSync(mockBox, [
    "#!/bin/sh",
    '[ "$1" = check ] && [ "$2" = -c ] || exit 90',
    'printf "check\\n" >> "$MOCK_EVENTS"',
    'if grep -q invalid "$3"; then printf "invalid candidate from check\\n" >&2; exit 1; fi',
    "exit 0",
  ].join("\n"), { mode: 0o700 });
  writeFileSync(join(initDir, "singsing"), [
    "#!/bin/sh",
    'case "$1" in',
    '  restart)',
    '    rm -f "$MOCK_RUNNING" "$MOCK_DROP_IN"',
    '    if grep -q candidate "$MOCK_CONFIG"; then',
    '      printf "start-candidate\\n" >> "$MOCK_EVENTS"',
    '      [ "\u0024{MOCK_FAIL_START:-0}" != 1 ] || exit 1',
    '      printf "%s" "\u0024{MOCK_NEW_PORT:-5335}" > "$MOCK_RUNNING"',
    '    else',
    '      printf "start-previous\\n" >> "$MOCK_EVENTS"',
    '      [ "\u0024{MOCK_FAIL_PREVIOUS:-0}" != 1 ] || exit 1',
    '      printf 5335 > "$MOCK_RUNNING"',
    '    fi;;',
    '  stop)',
    '    printf "stop\\n" >> "$MOCK_EVENTS"',
    '    [ "\u0024{MOCK_FAIL_STOP:-0}" != 1 ] || exit 1',
    '    rm -f "$MOCK_RUNNING" "$MOCK_DROP_IN";;',
    '  *) exit 90;;',
    'esac',
  ].join("\n"), { mode: 0o700 });
  writeFileSync(join(initDir, "dnsmasq"), [
    "#!/bin/sh",
    'if [ "\u0024{MOCK_FAIL_DNS:-0}" = 1 ] && grep -q "#5336" "$MOCK_DROP_IN"; then exit 1; fi',
    "exit 0",
  ].join("\n"), { mode: 0o700 });

  return {
    dir, config, lastGood, manifest, candidate, candidateManifest, running, dropIn, events, cronFile, cronUpdate, cronEvents,
    run(args: string[], overrides: Record<string, string> = {}) {
      return spawnSync("sh", [manager, ...args], {
        encoding: "utf8", timeout: 10_000,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          MOCK_BOX: mockBox, MOCK_RUNNING: running, MOCK_DROP_IN: dropIn,
          MOCK_EVENTS: events, MOCK_CRON_EVENTS: cronEvents, MOCK_CONFIG: config,
          MOCK_DATA_DIR: join(dir, "data"), ...overrides,
        },
      });
    },
    apply(overrides: Record<string, string> = {}) {
      return spawnSync("sh", [manager, "apply_config", candidate, candidateManifest], {
        encoding: "utf8", timeout: 10_000,
        env: {
          ...process.env, MOCK_BOX: mockBox, MOCK_RUNNING: running,
          MOCK_DROP_IN: dropIn, MOCK_EVENTS: events, MOCK_CRON_EVENTS: cronEvents, MOCK_CONFIG: config, MOCK_DATA_DIR: join(dir, "data"), ...overrides,
        },
      });
    },
    write(overrides: Record<string, string> = {}) {
      return spawnSync("sh", [manager, "write_config", candidate, candidateManifest], {
        encoding: "utf8", timeout: 10_000,
        env: {
          ...process.env, MOCK_BOX: mockBox, MOCK_RUNNING: running,
          MOCK_DROP_IN: dropIn, MOCK_EVENTS: events, MOCK_CRON_EVENTS: cronEvents, MOCK_CONFIG: config, MOCK_DATA_DIR: join(dir, "data"), ...overrides,
        },
      });
    },
    dispose() { rmSync(dir, { recursive: true, force: true }); },
  };
}
