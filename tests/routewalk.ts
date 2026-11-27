// Walks route rules for a connection to an IP address (and optional metadata) to see where it ends.
// IP prefixes are matched for real (inline rule-sets included); remote rule-sets other than
// geoip-cn/geosite-cn/geosite-geolocation-cn/gfwlist never match unless flagged on the connection.

import { BlockList, isIPv6 } from "node:net";

type Json = Record<string, any>;

export interface Connection {
  mode: "Direct" | "GFWList" | "Non-CN" | "Global";
  ip: string;
  port?: number;
  network?: "tcp" | "udp";
  inbound?: string;
  sourceIp?: string;
  sourceMac?: string;
  domain?: string;
  /** The address is in geoip-cn. */
  cn?: boolean;
  /** The reverse-mapped/sniffed domain is in geosite-cn / geosite-geolocation-cn. */
  cnSite?: boolean;
  /** The domain is in gfwlist. */
  gfw?: boolean;
  /** This device has a public IPv6 address. */
  publicV6Iface?: boolean;
}

const list = (v: unknown): any[] => ([] as any[]).concat(v ?? []);

function inPrefixes(ip: string, prefixes: string[]): boolean {
  const block = new BlockList();
  for (const p of prefixes) {
    const [addr, len] = p.split("/");
    const type = isIPv6(addr) ? "ipv6" : "ipv4";
    block.addSubnet(addr, Number(len ?? (type === "ipv6" ? 128 : 32)), type);
  }
  return block.check(ip, isIPv6(ip) ? "ipv6" : "ipv4");
}

const PRIVATE_PREFIXES = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
];

function inRuleSet(tag: string, config: Json, c: Connection): boolean {
  if (tag === "geoip-cn") return !!c.cn;
  if (tag === "geosite-cn" || tag === "geosite-geolocation-cn") return !!c.cnSite;
  if (tag === "gfwlist") return !!c.gfw;
  const set = config.route.rule_set.find((r: Json) => r.tag === tag);
  if (set?.type !== "inline") return false;
  return set.rules.some((r: Json) => {
    if (r.ip_cidr && inPrefixes(c.ip, r.ip_cidr)) return true;
    if (c.domain && r.domain && list(r.domain).includes(c.domain)) return true;
    if (c.domain && r.domain_suffix && list(r.domain_suffix).some((s: string) => c.domain === s || c.domain!.endsWith(s.startsWith(".") ? s : `.${s}`))) return true;
    return false;
  });
}

function inPortRanges(port: number, ranges: string[]): boolean {
  return ranges.some((r) => {
    const [a, b] = r.split(":").map(Number);
    return port >= a && port <= b;
  });
}

const DESTINATION = ["domain", "domain_suffix", "domain_keyword", "domain_regex", "ip_cidr", "ip_is_private"];

function matchesDestination(rule: Json, c: Connection): boolean {
  const keys = DESTINATION.filter((k) => k in rule);
  if (keys.length === 0) return true;
  return keys.some((k) => {
    if (k === "ip_cidr") return inPrefixes(c.ip, list(rule.ip_cidr));
    if (k === "ip_is_private") return rule.ip_is_private === inPrefixes(c.ip, PRIVATE_PREFIXES);
    if (!c.domain) return false;
    if (k === "domain") return list(rule.domain).includes(c.domain);
    if (k === "domain_suffix") {
      return list(rule.domain_suffix).some((s: string) => c.domain === s || c.domain!.endsWith(s.startsWith(".") ? s : `.${s}`));
    }
    if (k === "domain_keyword") return list(rule.domain_keyword).some((kw: string) => c.domain!.includes(kw));
    if (k === "domain_regex") return list(rule.domain_regex).some((re: string) => new RegExp(re).test(c.domain!));
    return false;
  });
}

function matches(rule: Json, config: Json, c: Connection): boolean {
  let ok: boolean;
  if (rule.type === "logical") {
    const results = rule.rules.map((r: Json) => matches(r, config, c));
    ok = rule.mode === "and" ? results.every(Boolean) : results.some(Boolean);
  } else {
    const port = c.port ?? 443;
    const net = c.network ?? "tcp";
    ok =
      matchesDestination(rule, c) &&
      Object.entries(rule).every(([k, v]) => {
        if (DESTINATION.includes(k)) return true;
        switch (k) {
          case "action":
          case "outbound":
          case "method":
          case "no_drop":
          case "invert":
            return true;
          case "inbound":
            return !!c.inbound && list(v).includes(c.inbound);
          case "clash_mode":
            return c.mode === v;
          case "network":
            return list(v).includes(net);
          case "ip_version":
            return v === (isIPv6(c.ip) ? 6 : 4);
          case "rule_set":
            return list(v).some((tag) => inRuleSet(tag, config, c));
          case "default_interface_address":
            return !!c.publicV6Iface;
          case "port":
            return list(v).includes(port);
          case "port_range":
            return inPortRanges(port, list(v));
          case "source_ip_cidr":
            return !!c.sourceIp && inPrefixes(c.sourceIp, list(v));
          case "source_mac_address":
            return !!c.sourceMac && list(v).includes(c.sourceMac.toLowerCase());
          default:
            return false;
        }
      });
  }
  return rule.invert ? !ok : ok;
}

/** The first final action the connection reaches: "bypass", "reject", or "route:<outbound>". */
export function routeWalk(config: Json, c: Connection): string {
  for (const rule of config.route.rules) {
    if (rule.action === "sniff" || rule.action === "hijack-dns") continue;
    if (!matches(rule, config, c)) continue;
    return rule.action === "route" ? `route:${rule.outbound}` : rule.action;
  }
  return `route:${config.route.final}`;
}

/**
 * Simulates Linux `auto_redirect` pre-match (NFQUEUE) evaluation:
 * - For TCP, stops upon reaching `{ action: "sniff" }` (SYN has no payload).
 * - Returns `"bypass"`, `"reject"`, `"route:<outbound>"`, or `"userspace"` if it falls into TUN.
 */
export function preMatchWalk(config: Json, c: Connection): string {
  const net = c.network ?? "tcp";
  for (const rule of config.route.rules) {
    if (rule.action === "sniff") {
      if (net === "tcp") return "userspace";
      continue;
    }
    if (!matches(rule, config, c)) continue;
    if (rule.action === "bypass") return "bypass";
    if (rule.action === "reject") return "reject";
    return "userspace";
  }
  return "userspace";
}

/**
 * Simulates normal userspace `RouteConnectionEx` evaluation:
 * - Skips pure `action: "bypass"` rules (no `outbound`), matching sing-box 1.13+ semantics.
 * - Tracks whether the flow passed through `{ action: "sniff" }` and whether it hit `hijack-dns`.
 */
export function userspaceWalk(config: Json, c: Connection): { action: string; sniffed: boolean; hijackedDns: boolean } {
  let sniffed = false;
  for (const rule of config.route.rules) {
    if (rule.action === "bypass" && !rule.outbound) continue;
    if (rule.action === "sniff") {
      sniffed = true;
      continue;
    }
    if (!matches(rule, config, c)) continue;
    if (rule.action === "hijack-dns") {
      return { action: "hijack-dns", sniffed, hijackedDns: true };
    }
    return {
      action: rule.action === "route" ? `route:${rule.outbound}` : rule.action,
      sniffed,
      hijackedDns: false,
    };
  }
  return { action: `route:${config.route.final}`, sniffed, hijackedDns: false };
}
