import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";
import { blueprintProfile, defaultOpenWrtSettings, generateOpenWrtConfig, newDnsRule, newGroup, newNode, newRule, newTailnet } from "../src/adapter/index";
import type { OpenWrtAccessControl } from "../src/adapter/index";
import type { Profile } from "../src/upstream/types";
import { serviceApplyFixture } from "./service-apply-harness";

const binary = process.env.SINGSING_SING_BOX ? resolve(process.env.SINGSING_SING_BOX) : "sing-box";
let validateSchema: ValidateFunction | undefined;

function run(...args: string[]) {
  return execFileSync(binary, args, {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
  });
}

function generatedConfig(
  dir: string,
  mode: "GFWList" | "Non-CN" | "Global" | "Direct" = "Direct",
  accessControl?: OpenWrtAccessControl,
  customize?: (p: Profile) => void,
) {
  const p = blueprintProfile();
  const node = newNode({
    tag: "mvp-vless",
    body: JSON.stringify({
      type: "vless", server: "proxy.example", server_port: 443, uuid: "025792b0-4e8e-4b76-a999-4f4ac68be9c1",
    }),
  });
  p.nodes = [node];
  p.settings.clashController = "";
  p.settings.clashSecret = "";
  p.settings.defaultMode = mode;
  p.settings.proxyDefault = node.id;
  p.settings.dnsRules = [newDnsRule({ server: "remote", lines: ["domain:split.example"] })];
  p.settings.rules = [
    newRule({ outbound: "reject", lines: ["domain:blocked.example", "203.0.113.5", "198.51.100.0/24"] }),
    newRule({ outbound: "proxy", lines: ["domain:proxy.example"] }),
    newRule({ outbound: "direct", lines: ["domain:direct.example"], ruleSets: [{ source: "geosite-netflix", content: "domain" }] }),
  ];
  customize?.(p);
  const settings = defaultOpenWrtSettings();
  settings.dns.localServer = "223.5.5.5";
  settings.dns.localType = "tls";
  settings.dns.localPort = 853;
  settings.dns.localServerName = "dns.alidns.com";
  settings.paths.cacheFile = join(dir, "cache.db");
  settings.paths.ruleSetDir = dir;
  settings.paths.tailscaleStateRoot = join(dir, "tailscale");
  settings.accessControl = accessControl;
  const generated = generateOpenWrtConfig(p, settings);
  expect(generated.issues.filter(({ level }) => level === "error")).toEqual([]);
  return generated;
}

function writeLocalRuleSets(dir: string, manifest: ReturnType<typeof generatedConfig>["ruleSets"]) {
  for (const entry of manifest) {
    const file = join(dir, entry.tag + ".fixture.json");
    const rules = entry.tag.startsWith("geoip-") ? [{ ip_cidr: ["192.0.2.0/24"] }] : [{ domain: ["fixture.example"] }];
    writeFileSync(file, JSON.stringify({ version: 3, rules }));
    if (entry.format === "binary") run("rule-set", "compile", file, "-o", entry.path);
    else writeFileSync(entry.path, readFileSync(file));
  }
}

function writeCheckedJSON(file: string, value: unknown) {
  writeFileSync(file, JSON.stringify(value, null, 2));
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  validateSchema ??= new Ajv2020({ strict: false, allErrors: true }).compile(JSON.parse(run("schema")));
  expect(validateSchema(parsed), JSON.stringify(validateSchema.errors)).toBe(true);
}

describe.skipIf(process.env.SINGSING_VERIFY_CORE !== "1")("sing-box 1.14.4 binary", () => {
  it("runs the pinned core version", () => {
    expect(run("version").split("\n")[0]).toBe("sing-box version 1.14.4");
  });

  it.each(["Direct", "GFWList", "Non-CN", "Global"] as const)("checks generated JSON, Schema and the real core in %s mode", (mode) => {
    const f = serviceApplyFixture();
    try {
      const { config, ruleSets } = generatedConfig(f.dir, mode);
      writeLocalRuleSets(f.dir, ruleSets);
      writeCheckedJSON(f.config, config);
      expect(() => run("check", "-c", f.config)).not.toThrow();
    } finally {
      f.dispose();
    }
  });

  it.each(["allowlist", "blocklist"] as const)("accepts native device selectors and a custom node with %s", (mode) => {
    const f = serviceApplyFixture();
    try {
      const { config, ruleSets } = generatedConfig(f.dir, "Direct", {
        mode,
        clients: ["192.0.2.42", "2001:db8:21::/64", "02:00:00:00:00:42"],
        deviceRules: [
          {
            id: "test-device",
            name: "Example device",
            clients: ["2001:db8:21::42"],
            outbound: "mvp-vless",
            enabled: true,
          },
        ],
      });
      writeLocalRuleSets(f.dir, ruleSets);
      writeCheckedJSON(f.config, config);
      expect(() => run("check", "-c", f.config)).not.toThrow();
    } finally {
      f.dispose();
    }
  });

  it("accepts 1.14.4 native Tailscale and Headscale endpoints, MagicDNS, and proxy group selectors", () => {
    const f = serviceApplyFixture();
    try {
      const { config, ruleSets } = generatedConfig(
        f.dir,
        "GFWList",
        {
          mode: "all",
          clients: [],
          deviceRules: [
            {
              id: "tailnet-device",
              name: "Lab client via Headscale",
              clients: ["192.0.2.55"],
              outbound: "hs-lab",
              enabled: true,
            },
          ],
        },
        (p) => {
          const official = newTailnet({
            id: "ts-official-id",
            tag: "ts-official",
            magicDns: true,
            acceptDefaultResolvers: true,
            asProxy: true,
            exitNode: "office-gw",
            routes: ["corp.internal", "10.42.0.0/16"],
            endpoint: JSON.stringify({
              state_directory: "tailscale-official",
              hostname: "openwrt-router",
              auth_key: "tskey-auth-synthetic-1144-a",
              accept_routes: true,
              advertise_routes: ["192.168.21.0/24", "2001:db8:21::/64"],
              exit_node_allow_lan_access: true,
              advertise_tags: ["tag:router"],
              listen_port: 41641,
              udp_timeout: "5m",
            }),
          });
          const headscale = newTailnet({
            id: "ts-headscale-id",
            tag: "hs-lab",
            magicDns: true,
            acceptDefaultResolvers: false,
            asProxy: false,
            exitNode: "",
            routes: ["10.99.0.0/16"],
            endpoint: JSON.stringify({
              state_directory: "tailscale-headscale",
              hostname: "openwrt-hs",
              control_url: "https://headscale.example.test",
              auth_key: "tskey-auth-synthetic-1144-b",
              accept_routes: false,
              advertise_exit_node: true,
              ephemeral: true,
            }),
          });
          p.settings.tailnets = [official, headscale];
          p.groups = [newGroup({ id: "ts-group-id", tag: "ts-group", members: [official.id] })];
          p.settings.proxyDefault = official.id;
          p.settings.dnsRules.push(
            newDnsRule({ server: "tailnet", tailnet: official.id, lines: ["domain:intranet.example"] }),
          );
        },
      );

      const typed = config as {
        endpoints: Record<string, unknown>[];
        dns: { servers: Record<string, unknown>[]; rules: Record<string, unknown>[] };
        outbounds: Record<string, unknown>[];
        route: { rules: Record<string, unknown>[] };
      };
      expect(typed.endpoints).toEqual([
        expect.objectContaining({
          type: "tailscale",
          tag: "ts-official",
          state_directory: join(f.dir, "tailscale", "tailscale-official"),
          exit_node: "office-gw",
          advertise_routes: ["192.168.21.0/24", "2001:db8:21::/64"],
          listen_port: 41641,
          udp_timeout: "5m",
        }),
        expect.objectContaining({
          type: "tailscale",
          tag: "hs-lab",
          control_url: "https://headscale.example.test",
          state_directory: join(f.dir, "tailscale", "tailscale-headscale"),
          accept_routes: false,
          advertise_exit_node: true,
          ephemeral: true,
        }),
      ]);
      expect(typed.dns.servers).toEqual(expect.arrayContaining([
        {
          type: "tailscale",
          tag: "ts-official-dns",
          endpoint: "ts-official",
          accept_default_resolvers: true,
          accept_search_domain: true,
        },
        {
          type: "tailscale",
          tag: "hs-lab-dns",
          endpoint: "hs-lab",
          accept_search_domain: true,
        },
      ]));
      expect(typed.dns.rules).toEqual(expect.arrayContaining([
        { preferred_by: "ts-official-dns", action: "route", server: "ts-official-dns" },
        { preferred_by: "hs-lab-dns", action: "route", server: "hs-lab-dns" },
        { domain: ["intranet.example"], action: "route", server: "ts-official-dns" },
      ]));
      expect(typed.route.rules).toEqual(expect.arrayContaining([
        { preferred_by: "ts-official", action: "route", outbound: "ts-official" },
        { preferred_by: "hs-lab", action: "route", outbound: "hs-lab" },
        { domain_suffix: ["corp.internal"], ip_cidr: ["10.42.0.0/16"], action: "route", outbound: "ts-official" },
        { ip_cidr: ["10.99.0.0/16"], action: "route", outbound: "hs-lab" },
        { source_ip_cidr: ["192.0.2.55/32"], action: "route", outbound: "hs-lab" },
      ]));
      const proxyOut = typed.outbounds.find((o) => o.tag === "proxy") as { outbounds: string[]; default: string };
      expect(proxyOut.outbounds).toEqual(expect.arrayContaining(["ts-group", "ts-official"]));
      expect(proxyOut.outbounds).not.toContain("hs-lab");
      expect(proxyOut.default).toBe("ts-official");
      expect(typed.outbounds).toContainEqual(expect.objectContaining({
        type: "selector",
        tag: "ts-group",
        outbounds: ["ts-official"],
      }));

      writeLocalRuleSets(f.dir, ruleSets);
      writeCheckedJSON(f.config, config);
      expect(() => run("check", "-c", f.config)).not.toThrow();
    } finally {
      f.dispose();
    }
  });

  it("fails a schema-valid candidate with an absent rule set without replacing working files", () => {
    const f = serviceApplyFixture();
    try {
      const { config, ruleSets } = generatedConfig(f.dir);
      writeLocalRuleSets(f.dir, ruleSets);
      writeCheckedJSON(f.config, config);
      run("check", "-c", f.config);
      writeFileSync(f.lastGood, readFileSync(f.config));
      writeFileSync(f.manifest, JSON.stringify(ruleSets));
      writeFileSync(f.running, "5335");
      const oldDNS = "no-resolv\nserver=127.0.0.1#5335\n";
      writeFileSync(f.dropIn, oldDNS);

      // A non-existent file is legal under the Schema. Only the actual core can reject it.
      const invalid = structuredClone(config) as { route: { rule_set: { tag: string; path?: string }[] } };
      const entry = invalid.route.rule_set.find(({ tag }) => tag === "gfwlist");
      expect(entry?.path).toBeDefined();
      entry!.path = join(f.dir, "intentionally-missing.srs");
      writeCheckedJSON(f.candidate, invalid);
      writeFileSync(f.candidateManifest, "[]");
      const files = [f.config, f.lastGood, f.manifest, f.dropIn, f.running];
      const before = files.map((file) => readFileSync(file));
      const result = f.apply({ MOCK_BOX: binary });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toMatch(/Config check failed:[\s\S]*intentionally-missing\.srs/);
      expect(files.map((file) => readFileSync(file))).toEqual(before);
    } finally {
      f.dispose();
    }
  });

  it("accepts v0.1.3 gateway features (pre-match bypass, geosite-cn, route_exclude_cn, mixed-in, port_mode, block_quic, DoH bootstrap, backup DNS)", () => {
    const f = serviceApplyFixture();
    try {
      const p = blueprintProfile();
      const node = newNode({
        tag: "mvp-vless",
        body: JSON.stringify({
          type: "vless", server: "proxy.example", server_port: 443, uuid: "025792b0-4e8e-4b76-a999-4f4ac68be9c1",
        }),
      });
      p.nodes = [node];
      p.settings.defaultMode = "Non-CN";
      p.settings.proxyDefault = node.id;
      p.settings.rules = [newRule({ outbound: "proxy", lines: ["domain:force-proxy.example"] })];

      const settings = defaultOpenWrtSettings();
      settings.dns.localType = "https";
      settings.dns.localServer = "dns.alidns.com";
      settings.dns.localPort = 443;
      settings.dns.localServerName = "dns.alidns.com";
      settings.dns.localBootstrap = "223.5.5.5";
      settings.dns.localBackupServer = "119.29.29.29";
      settings.dns.allowProxyIpv6 = true;
      settings.tun.ipv6Mode = "direct";
      settings.tun.strictRoute = false;
      settings.tun.mtu = 9000;
      settings.tun.udpTimeout = "5m";
      settings.tun.routeExcludeCn = true;
      settings.tun.includeInterface = ["br-lan"];
      settings.tun.defaultInterface = "pppoe-WAN";
      settings.mixed = { enabled: true, listenAddress: "::", listenPort: 5330 };
      settings.routing = {
        bypassCn: true,
        cnSiteRuleset: "geosite-cn",
        portMode: "custom",
        customPorts: "80,443,8000-8999",
        blockQuic: true,
      };
      settings.paths.cacheFile = join(f.dir, "cache.db");
      settings.paths.ruleSetDir = f.dir;
      settings.paths.tailscaleStateRoot = join(f.dir, "tailscale");
      settings.accessControl = {
        mode: "blocklist",
        clients: ["192.168.21.50", "28:75:d8:8a:80:03"],
        deviceRules: [
          { id: "dev-1", name: "Workstation", clients: ["28:75:d8:8a:80:03"], outbound: "mvp-vless", enabled: true },
        ],
      };

      const generated = generateOpenWrtConfig(p, settings);
      expect(generated.issues.filter(({ level }) => level === "error")).toEqual([]);
      writeLocalRuleSets(f.dir, generated.ruleSets);
      writeCheckedJSON(f.config, generated.config);
      expect(() => run("check", "-c", f.config)).not.toThrow();
    } finally {
      f.dispose();
    }
  });

  it.each(["direct", "auto", "ipv4_only"] as const)("accepts tun.ipv6Mode=%s with common port_mode and Tailscale exit node advertised routes", (ipv6Mode) => {
    const f = serviceApplyFixture();
    try {
      const p = blueprintProfile();
      const node = newNode({
        tag: "mvp-vless",
        body: JSON.stringify({
          type: "vless", server: "proxy.example", server_port: 443, uuid: "025792b0-4e8e-4b76-a999-4f4ac68be9c1",
        }),
      });
      p.nodes = [node];
      p.settings.defaultMode = "GFWList";
      p.settings.tailnets = [
        newTailnet({
          tag: "hs-exit",
          endpoint: JSON.stringify({
            state_directory: "ts-exit",
            hostname: "openwrt-exit",
            advertise_exit_node: true,
            advertise_routes: ["198.51.100.0/24"],
            exit_node_allow_lan_access: true,
          }),
        }),
      ];

      const settings = defaultOpenWrtSettings();
      settings.dns.localServer = "223.5.5.5";
      settings.tun.ipv6Mode = ipv6Mode;
      settings.routing = {
        bypassCn: true,
        cnSiteRuleset: "geosite-cn",
        portMode: "common",
        customPorts: "",
        blockQuic: true,
      };
      settings.paths.cacheFile = join(f.dir, "cache.db");
      settings.paths.ruleSetDir = f.dir;
      settings.paths.tailscaleStateRoot = join(f.dir, "tailscale");

      const generated = generateOpenWrtConfig(p, settings);
      expect(generated.issues.filter(({ level }) => level === "error")).toEqual([]);
      writeLocalRuleSets(f.dir, generated.ruleSets);
      writeCheckedJSON(f.config, generated.config);
      expect(() => run("check", "-c", f.config)).not.toThrow();
    } finally {
      f.dispose();
    }
  });

  it.each(["remote_verify", "race"] as const)(
    "accepts 90a2bd1 features with nonCnStrategy=%s (derived detour DNS, TCP/UDP port split, pure pre-match bypass, domain_resolver.strategy, urltest idle_timeout guard)",
    (nonCnStrategy) => {
      const f = serviceApplyFixture();
      try {
        const p = blueprintProfile();
        const jpNode = newNode({
          id: "node-jp",
          tag: "jp-vless",
          body: JSON.stringify({
            type: "vless",
            server: "jp.example",
            server_port: 443,
            uuid: "025792b0-4e8e-4b76-a999-4f4ac68be9c1",
          }),
        });
        const usNode = newNode({
          id: "node-us",
          tag: "us-vless",
          body: JSON.stringify({
            type: "vless",
            server: "us.example",
            server_port: 443,
            uuid: "125792b0-4e8e-4b76-a999-4f4ac68be9c2",
          }),
        });
        p.nodes = [jpNode, usNode];
        p.groups = [
          newGroup({
            id: "grp-auto-jp",
            tag: "auto-jp",
            type: "urltest",
            members: [jpNode.id, usNode.id],
            interval: "45m",
          }),
        ];
        p.settings.defaultMode = "Non-CN";
        p.settings.proxyDefault = "auto";
        p.settings.rules = [
          newRule({ outbound: jpNode.id, lines: ["domain:streaming-jp.example"] }),
          newRule({ outbound: "grp-auto-jp", lines: ["domain:ai-app.example"] }),
          newRule({ outbound: "direct", lines: ["domain:local-direct.example"] }),
          newRule({ outbound: "reject", lines: ["domain:ads-blocked.example"] }),
        ];

        const settings = defaultOpenWrtSettings();
        settings.dns.localServer = "223.5.5.5";
        settings.dns.localBackupServer = "119.29.29.29";
        settings.dns.nonCnStrategy = nonCnStrategy;
        settings.tun.ipv6Mode = nonCnStrategy === "race" ? "ipv4_only" : "direct";
        settings.tun.routeExcludeCn = true;
        settings.routing = {
          bypassCn: true,
          cnSiteRuleset: "geosite-cn",
          portMode: "common",
          customPorts: "",
          udpPortMode: "custom",
          customUdpPorts: "53,443,3478-3481",
          blockQuic: true,
        };
        settings.paths.cacheFile = join(f.dir, "cache.db");
        settings.paths.ruleSetDir = f.dir;
        settings.paths.tailscaleStateRoot = join(f.dir, "tailscale");
        settings.accessControl = {
          mode: "blocklist",
          clients: ["192.168.21.50"],
          deviceRules: [
            { id: "dev-us", name: "AppleTV", clients: ["192.168.21.66"], outbound: "us-vless", enabled: true },
          ],
        };

        const generated = generateOpenWrtConfig(p, settings);
        expect(generated.issues.filter(({ level }) => level === "error")).toEqual([]);
        const cfg = generated.config as {
          dns: { servers: Record<string, unknown>[] };
          outbounds: Record<string, unknown>[];
          route: { rules: Record<string, unknown>[]; default_domain_resolver: Record<string, unknown> };
        };
        expect(cfg.dns.servers.some((s) => String(s.tag).startsWith("remote-detour-") && s.detour === "jp-vless")).toBe(true);
        expect(cfg.dns.servers.some((s) => String(s.tag).startsWith("remote-detour-") && s.detour === "auto-jp")).toBe(true);
        expect(cfg.outbounds).toContainEqual(expect.objectContaining({ tag: "auto-jp", idle_timeout: "5400s" }));
        expect(cfg.route.default_domain_resolver).toEqual({
          server: "local",
          strategy: nonCnStrategy === "race" ? "ipv4_only" : "prefer_ipv4",
        });
        const sniffIdx = cfg.route.rules.findIndex((r) => r.action === "sniff");
        const preSniffTun = cfg.route.rules.slice(0, sniffIdx).filter((r) => r.inbound !== "dns-in");
        expect(preSniffTun.some((r) => r.action === "route")).toBe(false);

        writeLocalRuleSets(f.dir, generated.ruleSets);
        writeCheckedJSON(f.config, generated.config);
        expect(() => run("check", "-c", f.config)).not.toThrow();
      } finally {
        f.dispose();
      }
    },
  );
});
