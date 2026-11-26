import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serviceApplyFixture } from "./service-apply-harness";

const previous = '{"marker":"previous","inbounds":[{"tag":"dns-in","listen":"127.0.0.1","listen_port":5335}]}';
const candidate = '{"marker":"candidate","inbounds":[{"tag":"dns-in","listen":"127.0.0.1","listen_port":5336}]}';
const previousDropIn = "no-resolv\nserver=127.0.0.1#5335\n";
const activeManifest = '[{"tag":"previous"}]';
let f: ReturnType<typeof serviceApplyFixture>;

const read = (file: string) => readFileSync(file, "utf8");

beforeEach(() => {
  f = serviceApplyFixture();
  writeFileSync(f.config, previous);
  writeFileSync(f.lastGood, previous);
  writeFileSync(f.manifest, activeManifest);
  writeFileSync(f.candidate, candidate);
  writeFileSync(f.candidateManifest, '[{"tag":"candidate"}]');
});

afterEach(() => f.dispose());

function startPrevious() {
  writeFileSync(f.running, "5335");
  writeFileSync(f.dropIn, previousDropIn);
}

describe("service-manager application transaction (OpenWrt commands mocked)", () => {
  it("rejects the candidate before replacing any file or restarting the service", () => {
    startPrevious();
    writeFileSync(f.candidate, '{"marker":"invalid"}');
    const result = f.apply();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Config check failed/);
    expect(read(f.config)).toBe(previous);
    expect(read(f.lastGood)).toBe(previous);
    expect(read(f.manifest)).toBe(activeManifest);
    expect(read(f.dropIn)).toBe(previousDropIn);
    expect(read(f.events)).toBe("check\n");
  });

  it("restores the previous listener and DNS handoff after candidate startup fails with a new DNS port", () => {
    startPrevious();
    const result = f.apply({ MOCK_FAIL_START: "1", MOCK_NEW_PORT: "5336" });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/rolled back/i);
    expect(read(f.config)).toBe(previous);
    expect(read(f.manifest)).toBe(activeManifest);
    expect(read(f.running)).toBe("5335");
    expect(read(f.dropIn)).toBe(previousDropIn);
  });

  it("preserves the previous config and stays stopped if it was stopped before applying", () => {
    const result = f.apply({ MOCK_FAIL_START: "1" });
    expect(result.status).toBe(1);
    expect(read(f.config)).toBe(previous);
    expect(read(f.manifest)).toBe(activeManifest);
    expect(existsSync(f.running)).toBe(false);
    expect(read(f.events)).not.toContain("start-previous");
  });

  it("always restores the last working config on disk even with automatic restart disabled", () => {
    startPrevious();
    const result = f.apply({ MOCK_FAIL_START: "1", MOCK_ROLLBACK: "0" });
    expect(result.status).toBe(1);
    expect(read(f.config)).toBe(previous);
    expect(read(f.lastGood)).toBe(previous);
    expect(read(f.manifest)).toBe(activeManifest);
    expect(existsSync(f.running)).toBe(false);
  });

  it("rolls back instead of reporting success when dnsmasq cannot take over the new listener", () => {
    startPrevious();
    const result = f.apply({ MOCK_FAIL_DNS: "1", MOCK_NEW_PORT: "5336" });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/dnsmasq/i);
    expect(read(f.config)).toBe(previous);
    expect(read(f.manifest)).toBe(activeManifest);
    expect(read(f.dropIn)).toBe(previousDropIn);
  });

  it("reports a failed stop while applying a disabled configuration", () => {
    startPrevious();
    const result = f.apply({ MOCK_ENABLED: "0", MOCK_FAIL_STOP: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/stop/i);
    expect(read(f.running)).toBe("5335");
  });

  it("atomically replaces the active config inode, records verified last-good, publishes manifest, and updates dnsmasq drop-in on success", () => {
    startPrevious();
    const beforeIno = statSync(f.config).ino;
    const result = f.apply({ MOCK_NEW_PORT: "5336" });
    expect(result.status, result.stderr).toBe(0);
    expect(statSync(f.config).ino).not.toBe(beforeIno);
    expect(read(f.config)).toBe(candidate);
    expect(read(f.lastGood)).toBe(candidate);
    expect(read(f.manifest)).toBe('[{"tag":"candidate"}]');
    expect(read(f.running)).toBe("5336");
    expect(read(f.dropIn)).toContain("server=127.0.0.1#5336");
    expect(read(f.events)).toBe("check\nstart-candidate\n");
  });

  it("creates last-good on the first successful apply", () => {
    unlinkSync(f.config);
    unlinkSync(f.lastGood);
    const result = f.apply({ MOCK_NEW_PORT: "5336" });
    expect(result.status, result.stderr).toBe(0);
    expect(read(f.config)).toBe(candidate);
    expect(read(f.lastGood)).toBe(candidate);
  });

  it("rolls back when a TUN-enabled candidate never brings up its TUN interface", () => {
    startPrevious();
    const tunCandidate = '{"marker":"candidate","inbounds":[{"type":"tun","tag":"tun-in","interface_name":"singtun"},{"tag":"dns-in","listen":"127.0.0.1","listen_port":5336}]}';
    writeFileSync(f.candidate, tunCandidate);
    const result = f.apply({ MOCK_FAIL_TUN: "1", MOCK_NEW_PORT: "5336" });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/TUN/i);
    expect(read(f.config)).toBe(previous);
    expect(read(f.lastGood)).toBe(previous);
    expect(read(f.running)).toBe("5335");
    expect(read(f.dropIn)).toBe(previousDropIn);
  });

  it("removes the failed active config and restores dnsmasq when first-time apply fails startup", () => {
    unlinkSync(f.config);
    unlinkSync(f.lastGood);
    const result = f.apply({ MOCK_FAIL_START: "1", MOCK_NEW_PORT: "5336" });
    expect(result.status).toBe(1);
    expect(existsSync(f.config)).toBe(false);
    expect(existsSync(f.lastGood)).toBe(false);
    expect(existsSync(f.running)).toBe(false);
    expect(existsSync(f.dropIn)).toBe(false);
    expect(read(f.manifest)).toBe(activeManifest);
  });

  it("writes config and manifest atomically while stopped without starting sing-box or touching dnsmasq/last-good", () => {
    unlinkSync(f.config);
    const result = f.write({ MOCK_ENABLED: "0" });
    expect(result.status, result.stderr).toBe(0);
    expect(read(f.config)).toBe(candidate);
    expect(read(f.manifest)).toBe('[{"tag":"candidate"}]');
    expect(read(f.lastGood)).toBe(previous);
    expect(existsSync(f.running)).toBe(false);
    expect(existsSync(f.dropIn)).toBe(false);
    expect(existsSync(f.events)).toBe(false);
  });

  it("refuses write_config while sing-box is running so live updates go through apply_config", () => {
    startPrevious();
    const result = f.write();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/apply_config/);
    expect(read(f.config)).toBe(previous);
    expect(read(f.manifest)).toBe(activeManifest);
    expect(read(f.running)).toBe("5335");
  });
});
