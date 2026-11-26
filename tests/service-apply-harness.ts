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
  for (const path of [configDir, runtimeDir, initDir, dnsDir]) mkdirSync(path);
  const config = join(configDir, "sing-box.json");
  const lastGood = join(configDir, "sing-box.last-good.json");
  const manifest = join(configDir, "rulesets-manifest.json");
  const candidate = join(dir, "candidate.json");
  const candidateManifest = join(dir, "candidate-manifest.json");
  const running = join(dir, "running");
  const dropIn = join(dnsDir, "dnsmasq-singsing.conf");
  const events = join(dir, "events");
  const mockBox = join(dir, "sing-box-mock");
  const manager = join(dir, "service-manager.sh");
  const source = readFileSync(new URL("../root/usr/share/singsing/service-manager.sh", import.meta.url), "utf8")
    .replace(/\/etc\/init\.d\/(singsing|sing-box|dnsmasq)/g, initDir + "/$1")
    .replace('CONF_DIR="/etc/singsing"', 'CONF_DIR="' + configDir + '"')
    .replace('SB_DIR="/etc/sing-box"', 'SB_DIR="' + join(dir, "sing-box-state") + '"')
    .replace('TMP_DIR="/tmp/singsing"', 'TMP_DIR="' + runtimeDir + '"')
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
    '    dns.local_server) printf "223.5.5.5";;',
    '    dns.listen_port) printf "%s" "\u0024{MOCK_NEW_PORT:-5335}";;',
    '    *) printf "%s" "\u0024{2:-}";;',
    '  esac',
    '}',
    'check_local_dns() { return 0; }',
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
    dir, config, lastGood, manifest, candidate, candidateManifest, running, dropIn, events,
    apply(overrides: Record<string, string> = {}) {
      return spawnSync("sh", [manager, "apply_config", candidate, candidateManifest], {
        encoding: "utf8", timeout: 10_000,
        env: {
          ...process.env, MOCK_BOX: mockBox, MOCK_RUNNING: running,
          MOCK_DROP_IN: dropIn, MOCK_EVENTS: events, MOCK_CONFIG: config, MOCK_DATA_DIR: join(dir, "data"), ...overrides,
        },
      });
    },
    write(overrides: Record<string, string> = {}) {
      return spawnSync("sh", [manager, "write_config", candidate, candidateManifest], {
        encoding: "utf8", timeout: 10_000,
        env: {
          ...process.env, MOCK_BOX: mockBox, MOCK_RUNNING: running,
          MOCK_DROP_IN: dropIn, MOCK_EVENTS: events, MOCK_CONFIG: config, MOCK_DATA_DIR: join(dir, "data"), ...overrides,
        },
      });
    },
    dispose() { rmSync(dir, { recursive: true, force: true }); },
  };
}
