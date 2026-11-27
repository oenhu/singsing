import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import {
  defaultOpenWrtRoutingSettings,
  defaultOpenWrtSettings,
  generateOpenWrtConfig,
  openWrtBlueprintProfile,
  validateOpenWrt,
  type OpenWrtSettings,
} from "../src/adapter/index";
import { blueprintProfile, newNode, newRule, newTailnet } from "../src/upstream/defaults";
import { sampleProfiles } from "./samples";
import { walk } from "./dnswalk";
import { routeWalk } from "./routewalk";

const schema = JSON.parse(
  readFileSync(new URL("./fixtures/sing-box-1.14.3.schema.json", import.meta.url), "utf8"),
);
const validateSchema = new Ajv2020({ strict: false, allErrors: true }).compile(schema);

function validSettings(overrides: Partial<OpenWrtSettings> = {}): OpenWrtSettings {
  const base = defaultOpenWrtSettings();
  return {
    ...base,
    ...overrides,
    dns: { ...base.dns, localServer: "223.5.5.5", ...(overrides.dns ?? {}) },
    tun: { ...base.tun, ...(overrides.tun ?? {}) },
    paths: { ...base.paths, ...(overrides.paths ?? {}) },
  };
}

describe("OpenWrt adapter generates valid sing-box 1.14.3 schema configs", () => {
  it.each(sampleProfiles().map((s) => [s.name, s.profile] as const))(
    "schema valid for sample profile: %s",
    (_name, profile) => {
      const { config } = generateOpenWrtConfig(profile, validSettings());
      const ok = validateSchema(config);
      expect(validateSchema.errors ?? [], JSON.stringify(validateSchema.errors?.slice(0, 3), null, 2)).toEqual([]);
      expect(ok).toBe(true);
    },
  );

  it.each(["udp", "tcp", "tls", "https"] as const)(
    "schema valid for direct DNS protocol: %s",
    (proto) => {
      const settings = validSettings({
        dns: {
          ...defaultOpenWrtSettings().dns,
          localType: proto,
          localServer: "223.5.5.5",
          localPort: proto === "tls" ? 853 : proto === "https" ? 443 : 53,
          localServerName: proto === "tls" || proto === "https" ? "dns.alidns.com" : "",
        },
      });
      const { config } = generateOpenWrtConfig(blueprintProfile(), settings);
      const ok = validateSchema(config);
      expect(validateSchema.errors ?? [], JSON.stringify(validateSchema.errors?.slice(0, 3), null, 2)).toEqual([]);
      expect(ok).toBe(true);
    },
  );
});

describe("Mandatory direct upstream DNS and loop prevention validation", () => {
  it("rejects empty direct upstream DNS", () => {
    const issues = validateOpenWrt(blueprintProfile(), defaultOpenWrtSettings());
    expect(issues.some((i) => i.level === "error" && i.detail.includes("必须手动填写直连上游 DNS"))).toBe(true);
  });

  it("rejects domain name as direct upstream DNS", () => {
    const issues = validateOpenWrt(
      blueprintProfile(),
      validSettings({ dns: { ...defaultOpenWrtSettings().dns, localServer: "dns.alidns.com" } }),
    );
    expect(issues.some((i) => i.level === "error" && i.detail.includes("IPv4 或 IPv6"))).toBe(true);
  });

  it.each(["127.0.0.1", "127.0.0.53", "::1", "0.0.0.0"])("rejects loopback/unspecified %s", (ip) => {
    const issues = validateOpenWrt(
      blueprintProfile(),
      validSettings({ dns: { ...defaultOpenWrtSettings().dns, localServer: ip } }),
    );
    expect(issues.some((i) => i.level === "error" && i.detail.includes("回环"))).toBe(true);
  });

  it("rejects router own LAN IP to prevent dnsmasq loop", () => {
    const issues = validateOpenWrt(
      blueprintProfile(),
      validSettings({
        dns: { ...defaultOpenWrtSettings().dns, localServer: "192.168.1.1" },
        routerLanIps: ["192.168.1.1"],
      }),
    );
    expect(issues.some((i) => i.level === "error" && i.detail.includes("路由器自身地址"))).toBe(true);
  });

  it("rejects reserved dns-in tag on user node and tailnet", () => {
    const p = blueprintProfile();
    p.nodes.push(newNode({ tag: "dns-in" }));
    const issues = validateOpenWrt(p, validSettings());
    expect(issues.some((i) => i.level === "error" && i.detail.includes("dns-in"))).toBe(true);

    const p2 = blueprintProfile();
    p2.settings.tailnets = [newTailnet({ tag: "dns-in" })];
    const issues2 = validateOpenWrt(p2, validSettings());
    expect(issues2.some((i) => i.level === "error" && i.section === "tailscale" && i.detail.includes("dns-in"))).toBe(true);
  });

  it("strictly validates malformed IPv6, expanded loopback/unspecified, and canonical IPv6 LAN IP", () => {
    for (const bad of [":::", "1:2:3:4:5:6:7:", ":1:2:3:4:5:6:7", "1:2:3:4:5:6:7:8::9"]) {
      const issues = validateOpenWrt(
        blueprintProfile(),
        validSettings({ dns: { ...defaultOpenWrtSettings().dns, localServer: bad } }),
      );
      expect(issues.some((i) => i.level === "error" && i.detail.includes("IPv4 或 IPv6"))).toBe(true);
    }

    for (const loop of ["0::1", "0:0:0:0:0:0:0:0", "::ffff:127.0.0.1"]) {
      const issues = validateOpenWrt(
        blueprintProfile(),
        validSettings({ dns: { ...defaultOpenWrtSettings().dns, localServer: loop } }),
      );
      expect(issues.some((i) => i.level === "error" && i.detail.includes("回环"))).toBe(true);
    }

    const lanV6Issues = validateOpenWrt(
      blueprintProfile(),
      validSettings({
        dns: { ...defaultOpenWrtSettings().dns, localServer: "fd00:0000:0000:0000:0000:0000:0000:0001" },
        routerLanIps: ["fd00::1"],
      }),
    );
    expect(lanV6Issues.some((i) => i.level === "error" && i.detail.includes("路由器自身地址"))).toBe(true);
  });
});

describe("DNS adaptation, LAN leak prevention, and upstream policy preservation", () => {
  const { config } = generateOpenWrtConfig(blueprintProfile(), validSettings()) as { config: any };

  it("replaces local DNS server with user manual UDP server without neighbor_domain", () => {
    const local = config.dns.servers.find((s: any) => s.tag === "local");
    expect(local).toEqual({
      type: "udp",
      tag: "local",
      server: "223.5.5.5",
      server_port: 53,
    });
  });

  it("removes preferred_by: local rule", () => {
    expect(config.dns.rules.some((r: any) => r.preferred_by === "local")).toBe(false);
  });

  it("returns NXDOMAIN for .lan / .home.arpa / localhost / bare lan / single-label hostnames instead of leaking to external direct DNS", () => {
    for (const domain of ["nas.lan", "printer.home.arpa", "localhost", "lan", "home.arpa", "nas", "openwrt"]) {
      const res = walk(config.dns.rules, { domain, qtype: "A", mode: "GFWList", publicV6Iface: true });
      expect(res.final).toBe("predefined:NXDOMAIN");
    }
  });

  it("preserves GFWList and Non-CN DNS policies including IPv6 modes", () => {
    // Default OpenWrt ipv6Mode="direct": keeps direct AAAA even if default_interface lacks global IPv6 (PPPoE/PD safe)
    const cnA = walk(config.dns.rules, { domain: "baidu.com", qtype: "A", mode: "GFWList", publicV6Iface: false });
    expect(cnA.final).toBe("route:local");

    const cnAAAADirect = walk(config.dns.rules, { domain: "baidu.com", qtype: "AAAA", mode: "GFWList", publicV6Iface: false });
    expect(cnAAAADirect.final).toBe("route:local");

    // Upstream ipv6Mode="auto": drops direct AAAA when publicV6Iface=false
    const autoCfg = generateOpenWrtConfig(
      blueprintProfile(),
      validSettings({ tun: { ...defaultOpenWrtSettings().tun, ipv6Mode: "auto" } }),
    ).config as any;
    expect(walk(autoCfg.dns.rules, { domain: "baidu.com", qtype: "AAAA", mode: "GFWList", publicV6Iface: false }).final).toBe("predefined:NOERROR");
    expect(walk(autoCfg.dns.rules, { domain: "baidu.com", qtype: "AAAA", mode: "GFWList", publicV6Iface: true }).final).toBe("route:local");

    // ipv6Mode="ipv4_only": unconditionally drops direct AAAA even if publicV6Iface=true
    const v4Cfg = generateOpenWrtConfig(
      blueprintProfile(),
      validSettings({ tun: { ...defaultOpenWrtSettings().tun, ipv6Mode: "ipv4_only" } }),
    ).config as any;
    expect(walk(v4Cfg.dns.rules, { domain: "baidu.com", qtype: "AAAA", mode: "GFWList", publicV6Iface: true }).final).toBe("predefined:NOERROR");

    const gfwA = walk(config.dns.rules, { domain: "google.com", qtype: "A", mode: "GFWList", gfw: true, publicV6Iface: true });
    expect(gfwA.evaluated).toEqual(["remote"]);

    const gfwAAAA = walk(config.dns.rules, { domain: "google.com", qtype: "AAAA", mode: "GFWList", gfw: true, publicV6Iface: true });
    expect(gfwAAAA.final).toBe("predefined:NOERROR");

    // Non-CN parallel evaluate (local + speculative remote)
    const nonCnA = walk(config.dns.rules, { domain: "example.org", qtype: "A", mode: "Non-CN", publicV6Iface: true });
    expect(nonCnA.evaluated).toEqual(["local", "remote"]);
  });

  it("adds dns-in inbound and prepends dns-in hijack-dns route rule", () => {
    const dnsIn = config.inbounds.find((i: any) => i.tag === "dns-in");
    expect(dnsIn).toEqual({
      type: "direct",
      tag: "dns-in",
      listen: "127.0.0.1",
      listen_port: 5335,
    });
    expect(config.route.rules[0]).toEqual({ inbound: "dns-in", action: "hijack-dns" });
  });

  it("preserves IP routing behavior and kernel bypass via routewalk", () => {
    // Non-TUN (post-sniff) path: CN -> direct, foreign -> proxy
    const cnDirect = routeWalk(config, { ip: "223.5.5.5", mode: "Non-CN", cn: true, publicV6Iface: true });
    expect(cnDirect).toBe("route:direct");

    const foreignProxy = routeWalk(config, { ip: "1.1.1.1", mode: "Non-CN", cn: false, publicV6Iface: true });
    expect(foreignProxy).toBe("route:proxy");

    // TUN auto_redirect pre-match path: CN -> kernel bypass, foreign -> proxy, Global -> proxy
    expect(routeWalk(config, { inbound: "tun-in", sourceIp: "192.168.1.50", ip: "223.5.5.5", mode: "Non-CN", cn: true })).toBe("bypass");
    expect(routeWalk(config, { inbound: "tun-in", sourceIp: "192.168.1.50", ip: "223.5.5.5", mode: "GFWList", cn: true })).toBe("bypass");
    expect(routeWalk(config, { inbound: "tun-in", sourceIp: "192.168.1.50", ip: "223.5.5.5", mode: "Global", cn: true })).toBe("route:proxy");
    expect(routeWalk(config, { inbound: "tun-in", sourceIp: "192.168.1.50", ip: "1.1.1.1", mode: "Direct", cn: false })).toBe("bypass");

    // TUN source IP guard prevents kernel bypass on TUN-originated sockets
    expect(routeWalk(config, { inbound: "tun-in", sourceIp: "172.19.0.1", ip: "223.5.5.5", mode: "Non-CN", cn: true })).toBe("route:direct");

    // Default ipv6Mode="direct" allows CN IPv6; ipv6Mode="auto" / "ipv4_only" rejects it without public v6
    expect(routeWalk(config, { ip: "2400:3200::1", mode: "Non-CN", cn: true, publicV6Iface: false })).toBe("route:direct");
    const autoCfg = generateOpenWrtConfig(
      blueprintProfile(),
      validSettings({ tun: { ...defaultOpenWrtSettings().tun, ipv6Mode: "auto" } }),
    ).config as any;
    expect(routeWalk(autoCfg, { ip: "2400:3200::1", mode: "Non-CN", cn: true, publicV6Iface: false })).toBe("reject");
    const v4Cfg = generateOpenWrtConfig(
      blueprintProfile(),
      validSettings({ tun: { ...defaultOpenWrtSettings().tun, ipv6Mode: "ipv4_only" } }),
    ).config as any;
    expect(routeWalk(v4Cfg, { ip: "2400:3200::1", mode: "Non-CN", cn: true, publicV6Iface: true })).toBe("reject");
  });
});

describe("TUN, localized rule-sets, and flash-friendly paths", () => {
  it("configures TUN with singtun, auto_redirect, mtu=9000, strict_route=false, and dns_mode", () => {
    const { config } = generateOpenWrtConfig(blueprintProfile(), validSettings()) as { config: any };
    const tun = config.inbounds.find((i: any) => i.tag === "tun-in");
    expect(tun).toEqual({
      type: "tun",
      tag: "tun-in",
      interface_name: "singtun",
      address: ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
      auto_route: true,
      auto_redirect: true,
      strict_route: false,
      mtu: 9000,
      dns_mode: "hijack",
    });
  });

  it("respects tun.ipv6=false, dns.hijack=false, and tun.enabled=false", () => {
    const s1 = validSettings({
      dns: { ...defaultOpenWrtSettings().dns, localServer: "223.5.5.5", hijack: false },
      tun: { ...defaultOpenWrtSettings().tun, ipv6: false, mtu: 1400 },
    });
    const r1 = generateOpenWrtConfig(blueprintProfile(), s1).config as any;
    const tun1 = r1.inbounds.find((i: any) => i.tag === "tun-in");
    expect(tun1.address).toEqual(["172.19.0.1/30"]);
    expect(tun1.dns_mode).toBe("disabled");
    expect(tun1.mtu).toBe(1400);
    // When hijack=false, only dns-in hijack-dns remains in route.rules (no port-53 client hijack)
    expect(r1.route.rules.filter((r: any) => r.action === "hijack-dns")).toEqual([
      { inbound: "dns-in", action: "hijack-dns" },
    ]);

    const s2 = validSettings({ tun: { ...defaultOpenWrtSettings().tun, enabled: false } });
    const r2 = generateOpenWrtConfig(blueprintProfile(), s2).config as any;
    expect(r2.inbounds.find((i: any) => i.tag === "tun-in")).toBeUndefined();
    expect(r2.inbounds.find((i: any) => i.tag === "dns-in")).toBeDefined();
  });

  it("localizes remote rule-sets to /etc/sing-box/rule-sets (defaulting CN site to geosite-cn) and removes unused http_clients", () => {
    const { config, ruleSets } = generateOpenWrtConfig(blueprintProfile(), validSettings()) as any;
    expect(ruleSets.length).toBeGreaterThanOrEqual(3);
    expect(ruleSets.map((r: any) => r.tag)).toEqual(expect.arrayContaining(["geoip-cn", "geosite-cn", "gfwlist"]));

    const remoteRemaining = config.route.rule_set.filter((r: any) => r.type === "remote");
    expect(remoteRemaining).toEqual([]);

    const gfwLocal = config.route.rule_set.find((r: any) => r.tag === "gfwlist");
    expect(gfwLocal).toEqual({
      type: "local",
      tag: "gfwlist",
      format: "binary",
      path: "/etc/sing-box/rule-sets/gfwlist.srs",
    });

    expect(config.http_clients).toBeUndefined();
    expect(config.route.default_http_client).toBeUndefined();
  });

  it("sets cache_file to /tmp and normalizes relative Tailscale state_directory", () => {
    const p = blueprintProfile();
    p.settings.tailnets = [newTailnet({ tag: "home" })];
    const { config } = generateOpenWrtConfig(p, validSettings()) as any;
    expect(config.experimental.cache_file).toEqual({
      enabled: true,
      path: "/tmp/singsing/cache.db",
    });
    expect(config.endpoints[0].state_directory).toBe("/etc/sing-box/tailscale/tailscale");
  });

  it("validates full Tailscale Headscale graphical configuration against sing-box 1.14.3 schema", () => {
    const p = blueprintProfile();
    p.settings.tailnets = [
      newTailnet({
        tag: "headscale",
        magicDns: true,
        acceptDefaultResolvers: true,
        asProxy: true,
        exitNode: "office-gw",
        routes: ["corp.internal", "10.20.0.0/16"],
        endpoint: JSON.stringify({
          state_directory: "tailscale-headscale",
          hostname: "openwrt-router",
          control_url: "https://headscale.example.com",
          auth_key: "tskey-auth-example",
          accept_routes: true,
          advertise_routes: ["192.168.6.0/24"],
          advertise_exit_node: true,
          exit_node_allow_lan_access: true,
          ephemeral: false,
          advertise_tags: ["tag:router"],
        }),
      }),
    ];
    const { config } = generateOpenWrtConfig(p, validSettings()) as any;
    const ok = validateSchema(config);
    expect(validateSchema.errors ?? [], JSON.stringify(validateSchema.errors?.slice(0, 3), null, 2)).toEqual([]);
    expect(ok).toBe(true);
    expect(config.endpoints[0].control_url).toBe("https://headscale.example.com");
    expect(config.endpoints[0].state_directory).toBe("/etc/sing-box/tailscale/tailscale-headscale");
  });

  it("emits zero deprecated sing-box pre-1.12 fields (no legacy DNS address, inet4_address, block/dns outbounds, inbound sniff)", () => {
    const { config } = generateOpenWrtConfig(blueprintProfile(), validSettings()) as any;
    for (const s of config.dns.servers) {
      expect(s.address).toBeUndefined();
      expect(s.type).toBeDefined();
    }
    for (const inb of config.inbounds) {
      expect(inb.inet4_address).toBeUndefined();
      expect(inb.inet6_address).toBeUndefined();
      expect(inb.sniff).toBeUndefined();
    }
    for (const out of config.outbounds) {
      expect(["block", "dns"]).not.toContain(out.type);
    }
  });

  it("rejects auto_redirect=true when auto_route=false", () => {
    const issues = validateOpenWrt(
      blueprintProfile(),
      validSettings({ tun: { ...defaultOpenWrtSettings().tun, autoRoute: false, autoRedirect: true } }),
    );
    expect(issues.some((i) => i.level === "error" && i.detail.includes("Auto Redirect"))).toBe(true);
  });

  it("propagates tun.routeExcludeAddress and rejects invalid exclude CIDRs", () => {
    const okCfg = generateOpenWrtConfig(
      blueprintProfile(),
      validSettings({ tun: { ...defaultOpenWrtSettings().tun, routeExcludeAddress: ["192.168.100.0/24", "fd00:10::/48"] } }),
    ).config as any;
    expect(validateSchema(okCfg)).toBe(true);
    expect(okCfg.inbounds.find((i: any) => i.tag === "tun-in").route_exclude_address).toEqual([
      "192.168.100.0/24",
      "fd00:10::/48",
    ]);

    const badIssues = validateOpenWrt(
      blueprintProfile(),
      validSettings({ tun: { ...defaultOpenWrtSettings().tun, routeExcludeAddress: ["not-a-cidr"] } }),
    );
    expect(badIssues.some((i) => i.level === "error" && i.detail.includes("绕过网段格式无效"))).toBe(true);
  });

  it("applies custom per-tag rule-set URL overrides while keeping type=local in sing-box config", () => {
    const customUrl = "https://mirror.example.com/gfwlist.srs";
    const s = validSettings({
      paths: {
        ...defaultOpenWrtSettings().paths,
        ruleSetUrlOverrides: { gfwlist: customUrl },
      },
    });
    const { config, ruleSets } = generateOpenWrtConfig(blueprintProfile(), s) as any;
    const gfwManifest = ruleSets.find((r: any) => r.tag === "gfwlist");
    expect(gfwManifest.url).toBe(customUrl);
    const gfwConfig = config.route.rule_set.find((r: any) => r.tag === "gfwlist");
    expect(gfwConfig).toEqual({
      type: "local",
      tag: "gfwlist",
      format: "binary",
      path: "/etc/sing-box/rule-sets/gfwlist.srs",
    });
  });
});

describe("Tailscale MagicDNS ordering and exit node validation", () => {
  it("orders .lan NXDOMAIN before MagicDNS preferred_by and single-label NXDOMAIN after MagicDNS", () => {
    const p = blueprintProfile();
    p.settings.tailnets = [
      newTailnet({
        tag: "ts-home",
        magicDns: true,
        endpoint: JSON.stringify({ state_directory: "ts-home", hostname: "router", accept_routes: true }),
      }),
    ];
    const { config, issues } = generateOpenWrtConfig(p, validSettings()) as any;
    expect(issues.filter((i: any) => i.level === "error")).toEqual([]);
    expect(validateSchema(config)).toBe(true);

    const rules = config.dns.rules as any[];
    const lanIdx = rules.findIndex((r) => r.action === "predefined" && Array.isArray(r.domain_suffix) && r.domain_suffix.includes(".lan"));
    const magicIdx = rules.findIndex((r) => r.preferred_by === "ts-home-dns" && r.server === "ts-home-dns");
    const singleIdx = rules.findIndex((r) => r.action === "predefined" && Array.isArray(r.domain_regex) && r.domain_regex.includes("^[^.]+$"));
    expect(lanIdx).toBe(0);
    expect(magicIdx).toBeGreaterThan(lanIdx);
    expect(singleIdx).toBeGreaterThan(magicIdx);
  });

  it("rejects configuring exit_node and advertise_exit_node together on the same Tailnet", () => {
    const p = blueprintProfile();
    p.settings.tailnets = [
      newTailnet({
        tag: "ts-conflict",
        exitNode: "office-gw",
        endpoint: JSON.stringify({
          state_directory: "ts-conflict",
          hostname: "router",
          advertise_exit_node: true,
        }),
      }),
    ];
    const issues = validateOpenWrt(p, validSettings());
    expect(issues.some((i) => i.level === "error" && i.section === "tailscale" && i.detail.includes("exit_node") && i.detail.includes("advertise_exit_node"))).toBe(true);
  });
});

describe("Client access control (LAN device steering) schema and rules", () => {
  it("generates schema-valid blocklist rule with logical OR for mixed IP and MAC", () => {
    const s = validSettings({
      accessControl: {
        mode: "blocklist",
        clients: ["192.168.6.50", "AA-BB-CC-DD-EE-FF"],
        deviceRules: [
          { id: "d1", name: "Apple TV", clients: ["192.168.6.88"], outbound: "proxy", enabled: true },
        ],
      },
    });
    const { config, issues } = generateOpenWrtConfig(blueprintProfile(), s) as any;
    expect(issues.filter((i: any) => i.level === "error")).toEqual([]);
    const ok = validateSchema(config);
    expect(validateSchema.errors ?? [], JSON.stringify(validateSchema.errors?.slice(0, 3), null, 2)).toEqual([]);
    expect(ok).toBe(true);

    const rules = config.route.rules as any[];
    const blockRule = rules.find(
      (r) => r.type === "logical" && r.mode === "or" && r.outbound === "direct" && JSON.stringify(r).includes("source_mac_address"),
    );
    expect(blockRule).toBeDefined();
    expect(blockRule.rules).toEqual([
      { source_ip_cidr: ["192.168.6.50/32"] },
      { source_mac_address: ["aa:bb:cc:dd:ee:ff"] },
    ]);

    const devRule = rules.find((r) => Array.isArray(r.source_ip_cidr) && r.source_ip_cidr.includes("192.168.6.88/32"));
    expect(devRule).toEqual({ source_ip_cidr: ["192.168.6.88/32"], action: "route", outbound: "proxy" });
  });

  it("generates schema-valid allowlist rule scoped to tun-in", () => {
    const s = validSettings({
      accessControl: {
        mode: "allowlist",
        clients: ["192.168.6.100", "192.168.6.0/28"],
        deviceRules: [],
      },
    });
    const { config, issues } = generateOpenWrtConfig(blueprintProfile(), s) as any;
    expect(issues.filter((i: any) => i.level === "error")).toEqual([]);
    const ok = validateSchema(config);
    expect(validateSchema.errors ?? [], JSON.stringify(validateSchema.errors?.slice(0, 3), null, 2)).toEqual([]);
    expect(ok).toBe(true);
  });

  it("rejects invalid client IP/MAC entries and nonexistent deviceRule outbounds in validation", () => {
    const s = validSettings({
      accessControl: {
        mode: "blocklist",
        clients: ["not-an-ip-or-mac"],
        deviceRules: [
          { id: "d-bad", name: "Ghost Group", clients: ["192.168.6.99"], outbound: "deleted-group", enabled: true },
        ],
      },
    });
    const issues = validateOpenWrt(blueprintProfile(), s);
    expect(issues.some((i) => i.level === "error" && i.detail.includes("访问控制设备列表格式无效"))).toBe(true);
    expect(issues.some((i) => i.level === "error" && i.detail.includes("deleted-group"))).toBe(true);
  });

  it("handles empty allowlist (routes tun-in direct), places deviceRules before allowlist, and skips tun-in when tun disabled", () => {
    const emptyAllow = validSettings({
      accessControl: {
        mode: "allowlist",
        clients: [],
        deviceRules: [
          { id: "d1", name: "VIP TV", clients: ["192.168.6.88"], outbound: "proxy", enabled: true },
        ],
      },
    });
    const { config } = generateOpenWrtConfig(blueprintProfile(), emptyAllow) as any;
    expect(validateSchema(config)).toBe(true);
    const rules = config.route.rules as any[];
    const devIdx = rules.findIndex((r) => Array.isArray(r.source_ip_cidr) && r.source_ip_cidr.includes("192.168.6.88/32"));
    const allowIdx = rules.findIndex((r) => r.inbound === "tun-in" && r.outbound === "direct");
    expect(devIdx).toBeGreaterThan(-1);
    expect(allowIdx).toBeGreaterThan(devIdx);

    const tunOffAllow = validSettings({
      tun: { ...defaultOpenWrtSettings().tun, enabled: false },
      accessControl: { mode: "allowlist", clients: ["192.168.6.100"], deviceRules: [] },
    });
    const { config: cfgNoTun } = generateOpenWrtConfig(blueprintProfile(), tunOffAllow) as any;
    expect(JSON.stringify(cfgNoTun.route.rules)).not.toContain("tun-in");
  });
});

describe("P0/P1/P2 OpenWrt gateway enhancements (bypass, ports, QUIC, interfaces, mixed, DNS resilience, Tailscale exit node)", () => {
  it("gives blocklist higher priority than custom domain rules while keeping LAN private IPs reachable for deviceRules", () => {
    const p = blueprintProfile();
    p.settings.rules = [newRule({ outbound: "proxy", lines: ["domain:openai.com", "203.0.113.10"] })];
    const s = validSettings({
      accessControl: {
        mode: "blocklist",
        clients: ["192.168.1.50"],
        deviceRules: [
          { id: "tv", name: "TV", clients: ["192.168.1.88"], outbound: "proxy", enabled: true },
        ],
      },
    });
    const { config } = generateOpenWrtConfig(p, s) as any;
    expect(validateSchema(config), JSON.stringify(validateSchema.errors)).toBe(true);

    // Blocklisted PC accessing custom-proxied domain/IP still bypasses on tun-in and goes direct post-sniff
    expect(
      routeWalk(config, { inbound: "tun-in", sourceIp: "192.168.1.50", ip: "203.0.113.10", domain: "openai.com", mode: "Non-CN" }),
    ).toBe("bypass");
    expect(
      routeWalk(config, { inbound: "mixed-in", sourceIp: "192.168.1.50", ip: "203.0.113.10", domain: "openai.com", mode: "Non-CN" }),
    ).toBe("route:direct");

    // Device with explicit proxy rule can still reach LAN NAS directly
    expect(
      routeWalk(config, { inbound: "tun-in", sourceIp: "192.168.1.88", ip: "192.168.1.2", mode: "Non-CN" }),
    ).toBe("bypass");
    // And reaches external IP via proxy
    expect(
      routeWalk(config, { inbound: "tun-in", sourceIp: "192.168.1.88", ip: "223.5.5.5", cn: true, mode: "Non-CN" }),
    ).toBe("route:proxy");
  });

  it.each([
    ["common", true],
    ["common", false],
    ["custom", true],
    ["custom", false],
  ] as const)("applies %s port filtering and UDP 443 rejection to fallback routes (pre-match bypass %s)", (portMode, bypassCn) => {
    const p = blueprintProfile();
    p.settings.rules = [newRule({ outbound: "proxy", lines: ["203.0.113.10"] })];
    const s = validSettings({
      routing: {
        ...defaultOpenWrtRoutingSettings(),
        portMode,
        bypassCn,
        customPorts: "80,443,8000-8999",
        blockQuic: true,
      },
      accessControl: {
        mode: "all",
        clients: [],
        deviceRules: [{ id: "tv", name: "TV", clients: ["192.168.1.88"], outbound: "auto", enabled: true }],
      },
    });
    const { config, issues } = generateOpenWrtConfig(p, s) as any;
    expect(issues.filter((i: any) => i.level === "error")).toEqual([]);
    expect(validateSchema(config), JSON.stringify(validateSchema.errors)).toBe(true);

    const traffic = { inbound: "tun-in", sourceIp: "192.168.1.20", ip: "1.1.1.1", mode: "Non-CN" as const };
    const direct = bypassCn ? "bypass" : "route:direct";
    expect(routeWalk(config, { ...traffic, port: 8443 })).toBe("route:proxy");
    for (const packet of [{ port: 51413, network: "tcp" }, { port: 443, network: "udp" }] as const) {
      expect(routeWalk(config, { ...traffic, ...packet })).toBe(packet.network === "udp" ? "reject" : direct);
      expect(routeWalk(config, { ...traffic, ...packet, ip: "203.0.113.10" })).toBe("route:proxy");
      expect(routeWalk(config, { ...traffic, ...packet, ip: "203.0.113.10", sourceIp: "192.168.1.88" })).toBe("route:auto");
      expect(routeWalk(config, { ...traffic, ...packet, ip: "223.5.5.5", cn: true })).toBe(direct);
    }
  });

  it("supports routeExcludeCn, includeInterface, defaultInterface, udpTimeout, and optional mixed-in inbound", () => {
    const s = validSettings({
      tun: {
        ...defaultOpenWrtSettings().tun,
        routeExcludeCn: true,
        includeInterface: ["br-lan"],
        defaultInterface: "pppoe-wan",
        udpTimeout: "5m",
      },
      mixed: {
        enabled: true,
        listenAddress: "::",
        listenPort: 5330,
      },
    });
    const { config, issues } = generateOpenWrtConfig(blueprintProfile(), s) as any;
    expect(issues.filter((i: any) => i.level === "error")).toEqual([]);
    expect(validateSchema(config), JSON.stringify(validateSchema.errors)).toBe(true);

    const tun = config.inbounds.find((i: any) => i.tag === "tun-in");
    expect(tun.route_exclude_address_set).toEqual(["geoip-cn"]);
    expect(tun.include_interface).toEqual(["br-lan"]);
    expect(tun.udp_timeout).toBe("5m");

    const mixed = config.inbounds.find((i: any) => i.tag === "mixed-in");
    expect(mixed).toEqual({
      type: "mixed",
      tag: "mixed-in",
      listen: "::",
      listen_port: 5330,
      set_system_proxy: false,
      udp_timeout: "5m",
    });

    expect(config.route.default_interface).toBe("pppoe-wan");
    expect(config.route.auto_detect_interface).toBeUndefined();
  });

  it("supports domain-based direct DoH with bootstrap IP, backup direct DNS, allowProxyIpv6, and Non-CN SERVFAIL fallback", () => {
    const s = validSettings({
      dns: {
        ...defaultOpenWrtSettings().dns,
        localType: "https",
        localServer: "dns.alidns.com",
        localPort: 443,
        localServerName: "dns.alidns.com",
        localBootstrap: "223.5.5.5",
        localBackupServer: "119.29.29.29",
        allowProxyIpv6: true,
      },
    });
    const { config, issues } = generateOpenWrtConfig(blueprintProfile(), s) as any;
    expect(issues.filter((i: any) => i.level === "error")).toEqual([]);
    expect(validateSchema(config), JSON.stringify(validateSchema.errors)).toBe(true);

    expect(config.dns.servers).toContainEqual(expect.objectContaining({
      tag: "local",
      type: "https",
      server: "dns.alidns.com",
      domain_resolver: "local-bootstrap",
    }));
    expect(config.dns.servers).toContainEqual({
      type: "udp",
      tag: "local-bootstrap",
      server: "223.5.5.5",
      server_port: 53,
    });
    expect(config.dns.servers).toContainEqual({
      type: "udp",
      tag: "local-backup",
      server: "119.29.29.29",
      server_port: 53,
    });
    // Non-CN SERVFAIL/REFUSED fallback to local exists
    expect(JSON.stringify(config.dns.rules)).toContain("SERVFAIL");
    expect(JSON.stringify(config.dns.rules)).toContain("REFUSED");
    // Proxy AAAA is allowed when allowProxyIpv6=true
    const gfwAAAA = walk(config.dns.rules, { domain: "google.com", qtype: "AAAA", mode: "GFWList", gfw: true, publicV6Iface: true });
    expect(gfwAAAA.evaluated).toEqual(["remote"]);
  });

  it("adds Tailscale Exit Node inbound DNS hijack & LAN/subnet direct rules when advertise_exit_node is enabled", () => {
    const p = blueprintProfile();
    p.settings.tailnets = [
      newTailnet({
        tag: "ts-exit",
        endpoint: JSON.stringify({
          state_directory: "ts-exit",
          hostname: "openwrt",
          advertise_exit_node: true,
          advertise_routes: ["192.168.10.0/24"],
          exit_node_allow_lan_access: true,
        }),
      }),
    ];
    const { config, issues } = generateOpenWrtConfig(p, validSettings()) as any;
    expect(issues.filter((i: any) => i.level === "error")).toEqual([]);
    expect(validateSchema(config), JSON.stringify(validateSchema.errors)).toBe(true);
    expect(config.route.rules).toContainEqual({ inbound: "ts-exit", port: 53, action: "hijack-dns" });
    expect(config.route.rules).toContainEqual({
      inbound: "ts-exit",
      ip_is_private: true,
      ip_cidr: ["192.168.10.0/24"],
      action: "route",
      outbound: "direct",
    });
  });

  it("openWrtBlueprintProfile defaults to Non-CN without mutating upstream blueprintProfile", () => {
    expect(openWrtBlueprintProfile().settings.defaultMode).toBe("Non-CN");
    expect(blueprintProfile().settings.defaultMode).toBe("GFWList");
  });
});
