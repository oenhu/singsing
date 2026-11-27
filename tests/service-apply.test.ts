import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

describe("service-manager check_local_dns command dispatch regression", () => {
  const realDnsEnv = (extra: Record<string, string> = {}) => ({
    MOCK_REAL_CHECK_DNS: "1",
    MOCK_ROUTER_IPS: JSON.stringify(["192.168.21.1", "fd00::1"]),
    ...extra,
  });

  it("reads UCI settings when invoked with zero arguments (regression for v0.1.3-r1 startup failure)", () => {
    expect(f.run(["check_local_dns"], realDnsEnv({ MOCK_LOCAL_SERVER: "223.5.5.5" })).status).toBe(0);
    expect(f.run(["check_local_dns"], realDnsEnv({ MOCK_LOCAL_SERVER: "2400:3200::1" })).status).toBe(0);
    expect(f.run(["check_local_dns"], realDnsEnv({ MOCK_LOCAL_SERVER: "" })).status).toBe(1);
    expect(
      f.run(
        ["check_local_dns"],
        realDnsEnv({ MOCK_LOCAL_TYPE: "https", MOCK_LOCAL_SERVER: "dns.alidns.com", MOCK_LOCAL_BOOTSTRAP: "223.5.5.5" }),
      ).status,
    ).toBe(0);
    expect(
      f.run(
        ["check_local_dns"],
        realDnsEnv({ MOCK_LOCAL_TYPE: "https", MOCK_LOCAL_SERVER: "dns.alidns.com", MOCK_LOCAL_BOOTSTRAP: "" }),
      ).status,
    ).toBe(1);
  });

  it("validates explicit arguments for IPv4/IPv6, empty, loopback, router own IPs, and DoT/DoH domain + bootstrap", () => {
    expect(f.run(["check_local_dns", "223.5.5.5"], realDnsEnv()).status).toBe(0);
    expect(f.run(["check_local_dns", "2400:3200::1"], realDnsEnv()).status).toBe(0);
    expect(f.run(["check_local_dns", ""], realDnsEnv({ MOCK_LOCAL_SERVER: "223.5.5.5" })).status).toBe(1);
    for (const bad of ["127.0.0.1", "127.0.0.53", "0.0.0.0", "::1", "::", "::ffff:127.0.0.1", "192.168.21.1", "fd00:0000:0000:0000:0000:0000:0000:0001"]) {
      expect(f.run(["check_local_dns", bad], realDnsEnv()).status, bad).toBe(1);
    }
    expect(f.run(["check_local_dns", "dns.alidns.com", "udp", "223.5.5.5"], realDnsEnv()).status).toBe(1);
    expect(f.run(["check_local_dns", "dns.alidns.com", "tls", "223.5.5.5"], realDnsEnv()).status).toBe(0);
    expect(f.run(["check_local_dns", "dns.alidns.com", "https", "127.0.0.1"], realDnsEnv()).status).toBe(1);
    expect(f.run(["check_local_dns", "dns.alidns.com", "https", "192.168.21.1"], realDnsEnv()).status).toBe(1);
    expect(f.run(["check_local_dns", "dns.alidns.com", "https", ""], realDnsEnv({ MOCK_LOCAL_BOOTSTRAP: "223.5.5.5" })).status).toBe(1);
  });
});

describe("service-manager cron_sync and cron_remove lifecycle", () => {
  it("starts native OpenWrt cron on first enable when crond is not running, avoids duplicates, and preserves other entries", () => {
    writeFileSync(f.cronFile, "*/15 * * * * /usr/bin/other-job # other\n");

    const first = f.run(["cron_sync"], {
      MOCK_ENABLED: "1",
      MOCK_CRON_ENABLED: "1",
      MOCK_CRON_EXPR: "*/5 * * * *",
      MOCK_CRON_RUNNING_MODE: "stopped",
      MOCK_CRON_INIT_ENABLED: "0",
    });
    expect(first.status).toBe(0);
    const crontab1 = read(f.cronFile);
    expect(crontab1).toContain("/usr/bin/other-job # other");
    expect(crontab1.split("\n").filter((l) => l.includes("# singsing-ruleset"))).toHaveLength(1);
    expect(read(f.cronUpdate)).toContain("root");
    expect(read(f.cronEvents)).toBe("cron:running\ncron:enabled\ncron:start\ncron:running\n");

    // A manually started daemon still reads the schedule with boot disabled.
    writeFileSync(f.cronEvents, "");
    const second = f.run(["cron_sync"], {
      MOCK_ENABLED: "1",
      MOCK_CRON_ENABLED: "1",
      MOCK_CRON_EXPR: "*/5 * * * *",
      MOCK_CRON_RUNNING_MODE: "running",
      MOCK_CRON_INIT_ENABLED: "1",
    });
    expect(second.status).toBe(0);
    expect(read(f.cronFile).split("\n").filter((l) => l.includes("# singsing-ruleset"))).toHaveLength(1);
    expect(read(f.cronEvents)).toBe("cron:running\n");

    // cron_remove strips only singsing entry and preserves unrelated jobs
    const removed = f.run(["cron_remove"], { MOCK_CRON_RUNNING_MODE: "running" });
    expect(removed.status).toBe(0);
    expect(read(f.cronFile)).toContain("/usr/bin/other-job # other");
    expect(read(f.cronFile)).not.toContain("# singsing-ruleset");
  });

  it("keeps the task pending when system cron is disabled and stopped", () => {
    const result = f.run(["cron_sync"], {
      MOCK_CRON_ENABLED: "1",
      MOCK_CRON_INIT_ENABLED: "1",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("waiting for system cron to start");
    expect(read(f.cronFile)).toContain("# singsing-ruleset");
    expect(read(f.cronEvents)).toBe("cron:running\ncron:enabled\n");
  });

  it("reports a failed native cron start while retaining the schedule", () => {
    const result = f.run(["cron_sync"], {
      MOCK_CRON_ENABLED: "1",
      MOCK_CRON_START_STATUS: "1",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not start system cron");
    expect(read(f.cronFile)).toContain("# singsing-ruleset");
    expect(read(f.cronEvents)).toBe("cron:running\ncron:enabled\ncron:start\n");
  });

  it("reports that cron never started even if the init command returned success", () => {
    const result = f.run(["cron_sync"], {
      MOCK_CRON_ENABLED: "1",
      MOCK_CRON_AFTER_START_STATUS: "1",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not start system cron");
    expect(read(f.cronFile)).toContain("# singsing-ruleset");
    expect(read(f.cronEvents)).toBe("cron:running\ncron:enabled\ncron:start\ncron:running\n");
  });
});

describe("service-manager WAN integration", () => {
  const upstream = {
    MOCK_WAN4: "WAN",
    MOCK_WAN6: "uplink6",
    MOCK_WAN4_DNS: "192.0.2.53 192.0.2.54",
    MOCK_WAN6_DNS: "2001:db8::53",
  };

  it("reads DNS from each default uplink, querying a shared interface only once", () => {
    expect(f.run(["wan_dns"], upstream).stdout).toBe("192.0.2.53 192.0.2.54\n2001:db8::53\n");
    expect(f.run(["wan_dns"], { ...upstream, MOCK_WAN6: "WAN" }).stdout).toBe("192.0.2.53 192.0.2.54\n");
    expect(f.run(["wan_dns"]).stdout).toBe("");
  });

  it("restarts only a running service on an event for a current default uplink", () => {
    writeFileSync(f.events, "");
    expect(f.run(["wan_ifup", "WAN"], upstream).status).toBe(0);
    expect(read(f.events)).toBe("");
    writeFileSync(f.running, "5335");
    expect(f.run(["wan_ifup", "guest"], upstream).status).toBe(0);
    expect(f.run(["wan_ifup", "WAN"]).status).toBe(0);
    expect(read(f.events)).toBe("");
    expect(f.run(["wan_ifup", "WAN"], upstream).status).toBe(0);
    expect(read(f.events)).toBe("start-previous\n");
    expect(f.run(["wan_ifup", "uplink6"], upstream).status).toBe(0);
    expect(read(f.events)).toBe("start-previous\nstart-previous\n");
  });

  it("hotplug script reloads on ifup and address/prefix ifupdate while ignoring plain lease renewals", () => {
    const hotplugSrc = readFileSync(new URL("../root/etc/hotplug.d/iface/95-singsing", import.meta.url), "utf8");
    const callLog = join(f.dir, "hotplug-calls");
    const fakeMgr = join(f.dir, "fake-mgr.sh");
    const testHotplug = join(f.dir, "95-singsing");
    writeFileSync(fakeMgr, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${callLog}"\n`, { mode: 0o700 });
    // Run synchronously in test (strip trailing background &) to avoid flaky timing races
    writeFileSync(
      testHotplug,
      hotplugSrc
        .replace("/usr/share/singsing/service-manager.sh", fakeMgr)
        .replace(" >/dev/null 2>&1 &", " >/dev/null 2>&1"),
      { mode: 0o700 },
    );

    const fire = (env: Record<string, string>) =>
      spawnSync("sh", [testHotplug], { encoding: "utf8", env: { ...process.env, ...env } });

    expect(fire({ ACTION: "ifdown", INTERFACE: "WAN" }).status).toBe(0);
    expect(fire({ ACTION: "ifupdate", INTERFACE: "WAN_6" }).status).toBe(0);
    expect(fire({ ACTION: "ifupdate", INTERFACE: "WAN_6", IFUPDATE_DATA: "1" }).status).toBe(0);
    expect(existsSync(callLog)).toBe(false);

    expect(fire({ ACTION: "ifup", INTERFACE: "WAN" }).status).toBe(0);
    expect(fire({ ACTION: "ifupdate", INTERFACE: "WAN_6", IFUPDATE_PREFIXES: "1" }).status).toBe(0);
    expect(fire({ ACTION: "ifupdate", INTERFACE: "WAN", IFUPDATE_ADDRESSES: "1" }).status).toBe(0);
    expect(read(callLog)).toBe("wan_ifup WAN\nwan_ifup WAN_6\nwan_ifup WAN\n");
  });
});
