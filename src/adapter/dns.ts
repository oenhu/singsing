import {
  BUILT_IN_RULE_TARGETS,
  matchCount,
  matchFields,
  memberTags,
  nodeObject,
  parseRuleList,
  type DomainMatch,
} from "../upstream/generate";
import { resolveRuleSet, sagerNetUrl, type ResolvedRuleSet } from "../upstream/rule-sets";
import type { Profile } from "../upstream/types";
import type { Ipv6Mode, NonCnDnsStrategy, OpenWrtDnsSettings, OpenWrtSettings } from "./types";
import { isValidHostname, isValidIp } from "./validation";

type Json = Record<string, unknown>;

const IPV6_CARRIERS = ["AAAA", "HTTPS", "SVCB"];
const CUSTOM_DIRECT = "custom-direct-domains";

const BUILT_IN_SETS: Record<string, string> = {
  [sagerNetUrl("geoip", "cn")]: "geoip-cn",
  [sagerNetUrl("geosite", "geolocation-cn")]: "geosite-geolocation-cn",
  "https://raw.githubusercontent.com/Dreista/sing-box-rule-set-cn/rule-set/gfwlist.txt.srs": "gfwlist",
};
const GENERATOR_SET_TAGS = [
  ...Object.values(BUILT_IN_SETS),
  "telegram-ip",
  "gfwlist-custom-domains",
  "gfwlist-custom-ips",
  CUSTOM_DIRECT,
  "custom-direct-ips",
  "custom-rule-domains",
  "custom-rule-ips",
  "custom-dns-domains",
];

const and = (rules: Json[], extra: Json = {}): Json => ({ type: "logical", mode: "and", rules, ...extra });
const or = (rules: Json[], extra: Json = {}): Json => ({ type: "logical", mode: "or", rules, ...extra });
const oneOrList = (xs: string[]) => (xs.length === 1 ? xs[0] : xs);

function invertRule(rule: Json): Json {
  const cloned = structuredClone(rule);
  if (cloned.invert === true) {
    delete cloned.invert;
    return cloned;
  }
  return { ...cloned, invert: true };
}

/**
 * Determine the `domain_resolver.strategy` used by sing-box when dialing outbounds or DoT/DoH hosts.
 * - `ipv4_only`: strictly query IPv4 so dialers never waste time on unreachable AAAA records.
 * - `direct` / `auto`: `prefer_ipv4` keeps dual-stack proxy/DoH dialing reliable while still supporting IPv6-only hosts.
 */
export function resolveDomainStrategy(ipv6Mode: Ipv6Mode): "ipv4_only" | "prefer_ipv4" {
  return ipv6Mode === "ipv4_only" ? "ipv4_only" : "prefer_ipv4";
}

/**
 * Build the direct upstream DNS server object (tag: "local").
 * Supports IPv4/IPv6 direct servers and domain-based DoT/DoH servers when `localBootstrap` is provided.
 */
export function buildDirectDnsServer(dns: OpenWrtDnsSettings, ipv6Mode: Ipv6Mode = "direct"): Json {
  const host = dns.localServer.trim();
  const bootstrap = (dns.localBootstrap || "").trim();
  const encrypted = dns.localType === "tls" || dns.localType === "https";

  const server: Json = {
    type: dns.localType,
    tag: "local",
    server: host,
    server_port: dns.localPort,
  };

  if (dns.localType === "https") {
    server.path = dns.localPath.trim() || "/dns-query";
  }

  if (encrypted) {
    const sni = dns.localServerName.trim();
    server.tls = {
      enabled: true,
      ...(sni ? { server_name: sni } : {}),
    };
    if (!isValidIp(host) && isValidHostname(host) && bootstrap) {
      server.domain_resolver = {
        server: "local-bootstrap",
        strategy: resolveDomainStrategy(ipv6Mode),
      };
    }
  }

  return server;
}

function isLocalDomainsRouteRule(rule: Json): boolean {
  return (
    rule.action === "route" &&
    rule.server === "local" &&
    Array.isArray(rule.domain) &&
    rule.domain.includes("localhost") &&
    Array.isArray(rule.domain_suffix) &&
    rule.domain_suffix.includes(".lan")
  );
}

function isNoPublicV6Condition(item: Json): boolean {
  return (
    item.invert === true &&
    Array.isArray(item.default_interface_address) &&
    item.default_interface_address.includes("2000::/3")
  );
}

function isIpv6CarriersCondition(item: Json): boolean {
  return (
    Array.isArray(item.query_type) &&
    IPV6_CARRIERS.every((t) => (item.query_type as unknown[]).includes(t))
  );
}

function isProxyIpv6DropRule(rule: Json): boolean {
  if (rule.action !== "predefined" || rule.rcode !== "NOERROR") return false;
  if (isIpv6CarriersCondition(rule)) return true;
  if (rule.type === "logical" && rule.mode === "and" && Array.isArray(rule.rules)) {
    return (rule.rules as Json[]).some(isIpv6CarriersCondition);
  }
  return false;
}

function isMainDirectLocalRule(rule: Json): boolean {
  return (
    rule.action === "route" &&
    rule.server === "local" &&
    rule.type === "logical" &&
    rule.mode === "or" &&
    Array.isArray(rule.rules) &&
    (rule.rules as Json[]).some((r) => r.clash_mode === "Direct")
  );
}

function isCustomProxyRemoteRule(rule: Json): boolean {
  return rule.action === "route" && rule.server === "remote" && rule.type === "logical" && rule.mode === "and";
}

function referencesLocalAnswer(rule: Json): boolean {
  if (rule.tag === "local-answer" || rule.match_response === "local-answer") return true;
  if (rule.type === "logical" && Array.isArray(rule.rules)) {
    return (rule.rules as Json[]).some(referencesLocalAnswer);
  }
  return false;
}

function isLocalPrivateRaceRule(rule: Json): boolean {
  return rule.match_response === "local-answer" && rule.ip_is_private === true && rule.action === "respond";
}

function isRemoteEvaluateRule(rule: Json): boolean {
  return rule.action === "evaluate" && rule.server === "remote" && rule.tag === "remote-answer";
}

function isRemoteRespondRule(rule: Json): boolean {
  return rule.match_response === "remote-answer" && rule.action === "respond";
}

function isFinalServfailRule(rule: Json): boolean {
  return rule.action === "predefined" && rule.rcode === "SERVFAIL" && Object.keys(rule).length === 2;
}

/**
 * Adapt a single DNS rule for OpenWrt router IPv6 mode:
 * - "auto": keep upstream `default_interface_address` guard unchanged.
 * - "direct": drop rules gated on `noPublicV6Interface` so PPPoE/PD IPv6 LAN clients get AAAA records.
 * - "ipv4_only": strip `noPublicV6Interface` so direct AAAA records are unconditionally dropped.
 */
function adaptDnsRuleIpv6(rule: Json, ipv6Mode: Ipv6Mode): Json | null {
  if (ipv6Mode === "auto") return rule;
  if (rule.type === "logical" && rule.mode === "and" && Array.isArray(rule.rules)) {
    const sub = rule.rules as Json[];
    const hasGuard = sub.some(isNoPublicV6Condition);
    if (!hasGuard) return rule;
    if (ipv6Mode === "direct") return null;
    const remaining = sub.filter((item) => !isNoPublicV6Condition(item));
    if (remaining.length === 0) return null;
    return { ...rule, rules: remaining };
  }
  return rule;
}

/** Build a direct `local` DNS route, upgrading to `local` -> `local-backup` failover when a backup server exists. */
function buildLocalRouteRules(condition: Json, evalTag: string, hasBackup: boolean): Json[] {
  if (!hasBackup) {
    return [{ ...structuredClone(condition), action: "route", server: "local" }];
  }
  return [
    {
      ...structuredClone(condition),
      action: "evaluate",
      server: "local",
      tag: evalTag,
      timeout: "1500ms",
    },
    or(
      [
        { match_response: evalTag, response_rcode: "SERVFAIL" },
        { match_response: evalTag, response_rcode: "REFUSED" },
      ],
      { action: "route", server: "local-backup" },
    ),
    {
      match_response: evalTag,
      action: "respond",
    },
    {
      ...structuredClone(condition),
      action: "route",
      server: "local-backup",
    },
  ];
}

interface DerivedRuleDns {
  servers: Json[];
  rules: Json[];
}

/**
 * Derive per-outbound DNS servers (cloned from `remote` with `detour: <targetTag>`) for custom
 * routing rules targeting a specific node/group/exit-node so streaming/AI split rules resolve
 * through their actual egress without domestic ECS bias.
 */
function buildDerivedRuleDns(config: Json, profile: Profile | undefined): DerivedRuleDns {
  if (!profile || !profile.settings.rules.length) return { servers: [], rules: [] };

  const dnsObj = config.dns as { servers?: Json[] } | undefined;
  if (!dnsObj || !Array.isArray(dnsObj.servers)) return { servers: [], rules: [] };

  const remoteServer = dnsObj.servers.find((s) => s.tag === "remote");
  if (!remoteServer || typeof remoteServer.detour !== "string" || !remoteServer.detour) {
    return { servers: [], rules: [] };
  }

  // Collect valid outbound/endpoint tags capable of forwarding external DNS queries.
  const validTargets = new Set<string>();
  if (Array.isArray(config.outbounds)) {
    for (const o of config.outbounds as Json[]) {
      if (typeof o.tag === "string" && o.tag !== "direct" && o.tag !== "proxy") {
        validTargets.add(o.tag);
      }
    }
  }
  if (Array.isArray(config.endpoints)) {
    for (const ep of config.endpoints as Json[]) {
      if (typeof ep.tag !== "string") continue;
      if (ep.type === "tailscale") {
        // Only tailnets configured with an exit_node can forward external DNS reliably.
        if (typeof ep.exit_node === "string" && ep.exit_node.trim().length > 0) {
          validTargets.add(ep.tag);
        }
      } else {
        validTargets.add(ep.tag);
      }
    }
  }
  if (validTargets.size === 0) return { servers: [], rules: [] };

  // Mirror upstream tag resolution for nodes, groups, and rule-sets so tags match 1:1.
  const nodes = profile.nodes.flatMap((node) => {
    const { object, endpoint } = nodeObject(node);
    return object ? [{ node, object, endpoint: !!endpoint }] : [];
  });
  const tags = memberTags(profile, nodes);

  const byUrl = new Map<string, string>(Object.entries(BUILT_IN_SETS));
  const usedSetTags = new Set(GENERATOR_SET_TAGS);
  const tagForSet = (r: ResolvedRuleSet): string => {
    let tag = byUrl.get(r.url);
    if (!tag) {
      tag = r.baseTag;
      for (let i = 2; usedSetTags.has(tag); i++) tag = `${r.baseTag}-${i}`;
      usedSetTags.add(tag);
      byUrl.set(r.url, tag);
    }
    return tag;
  };

  interface DomainRuleInfo {
    targetTag: string;
    domains: DomainMatch;
    domainSets: string[];
  }

  const resolvedRules: DomainRuleInfo[] = [];
  for (const rule of profile.settings.rules) {
    const targetTag = BUILT_IN_RULE_TARGETS.find((t) => t.id === rule.outbound)?.tag ?? tags.get(rule.outbound);
    if (!targetTag) continue;
    const { domains } = parseRuleList(rule.lines.join("\n"));
    const domainSets: string[] = [];
    for (const ref of rule.ruleSets) {
      const r = resolveRuleSet(ref);
      if ("problem" in r) continue;
      const setTag = tagForSet(r);
      if (r.content === "domain" && !domainSets.includes(setTag)) {
        domainSets.push(setTag);
      }
    }
    if (matchCount(domains) > 0 || domainSets.length > 0) {
      resolvedRules.push({ targetTag, domains, domainSets });
    }
  }

  const usedServerTags = new Set(dnsObj.servers.map((s) => String(s.tag ?? "")));
  const targetToServerTag = new Map<string, string>();
  const servers: Json[] = [];
  const rules: Json[] = [];
  const earlierMatchers: Json[] = [];
  let seq = 1;

  const directListExclude = and([{ clash_mode: "Global", invert: true }, { rule_set: CUSTOM_DIRECT }], { invert: true });

  for (const r of resolvedRules) {
    const parts: Json[] = [];
    if (matchCount(r.domains) > 0) parts.push(matchFields(r.domains));
    if (r.domainSets.length > 0) parts.push({ rule_set: oneOrList(r.domainSets) });
    const ruleMatch = parts.length === 1 ? parts[0] : or(parts);

    if (r.targetTag !== "direct" && r.targetTag !== "reject" && r.targetTag !== "proxy" && validTargets.has(r.targetTag)) {
      let serverTag = targetToServerTag.get(r.targetTag);
      if (!serverTag) {
        while (usedServerTags.has(`remote-detour-${seq}`)) seq++;
        serverTag = `remote-detour-${seq++}`;
        usedServerTags.add(serverTag);
        targetToServerTag.set(r.targetTag, serverTag);
        const cloned = structuredClone(remoteServer);
        cloned.tag = serverTag;
        cloned.detour = r.targetTag;
        servers.push(cloned);
      }

      const condParts: Json[] = [directListExclude];
      if (earlierMatchers.length === 1) {
        condParts.push(invertRule(earlierMatchers[0]));
      } else if (earlierMatchers.length > 1) {
        condParts.push(or(earlierMatchers.map((m) => structuredClone(m)), { invert: true }));
      }
      condParts.push(ruleMatch);
      rules.push(and(condParts, { action: "route", server: serverTag }));
    }

    earlierMatchers.push(ruleMatch);
  }

  return { servers, rules };
}

/**
 * Rewrite string `"local"` `domain_resolver` references on `route.default_domain_resolver`,
 * `outbounds`, and `endpoints` to explicit `{ server: "local", strategy }` objects.
 * Preserves any user-customized resolver objects or non-`"local"` tags.
 */
function adaptDomainResolvers(config: Json, ipv6Mode: Ipv6Mode): void {
  const strategy = resolveDomainStrategy(ipv6Mode);
  const resolverObj = () => ({ server: "local", strategy });

  const route = config.route as Json | undefined;
  if (route && route.default_domain_resolver === "local") {
    route.default_domain_resolver = resolverObj();
  }
  if (Array.isArray(config.outbounds)) {
    for (const out of config.outbounds as Json[]) {
      if (out.domain_resolver === "local") {
        out.domain_resolver = resolverObj();
      }
    }
  }
  if (Array.isArray(config.endpoints)) {
    for (const ep of config.endpoints as Json[]) {
      if (ep.domain_resolver === "local") {
        ep.domain_resolver = resolverObj();
      }
    }
  }
}

/**
 * Adapt DNS servers, DNS rules, `domain_resolver` strategies, dns-in inbound, and route hijack rule for OpenWrt:
 * - Replace `tag: "local"` with user's manual direct upstream DNS (+ optional bootstrap/backup servers).
 * - Apply explicit `domain_resolver.strategy` (`ipv4_only` / `prefer_ipv4`) to `default_domain_resolver` and nodes.
 * - Remove `{ preferred_by: "local", ... }` and prevent LAN/single-label DNS leaks via NXDOMAIN.
 * - Derive per-outbound `detour` DNS servers for custom routing rules targeting specific nodes/groups.
 * - Route `gfwlist` directly to `remote` in `Non-CN` mode to eliminate blocked-domain DNS leaks.
 * - Support `remote_verify` (default anti-pollution) and `race` (hardened parallel race) Non-CN DNS strategies
 *   with full `local-backup` failover across direct and fallback rules.
 * - Add `dns-in` direct inbound and prepend `{ inbound: "dns-in", action: "hijack-dns" }`.
 */
export function adaptDns(config: Json, settings: OpenWrtSettings, profile?: Profile): void {
  const dnsObj = config.dns as { servers?: Json[]; rules?: Json[] } | undefined;
  if (!dnsObj) return;

  const bootstrap = (settings.dns.localBootstrap || "").trim();
  const backup = (settings.dns.localBackupServer || "").trim();
  const directHost = settings.dns.localServer.trim();
  const encrypted = settings.dns.localType === "tls" || settings.dns.localType === "https";
  const needsBootstrap = encrypted && !isValidIp(directHost) && isValidHostname(directHost) && !!bootstrap;
  const ipv6Mode: Ipv6Mode = settings.tun.ipv6Mode ?? (settings.tun.ipv6 ? "direct" : "ipv4_only");
  const allowProxyIpv6 = settings.dns.allowProxyIpv6 === true;
  const nonCnStrategy: NonCnDnsStrategy = settings.dns.nonCnStrategy ?? "remote_verify";
  const ecsVal = (profile?.settings.clientSubnet || "").trim();
  const ecs: Json = ecsVal ? { client_subnet: ecsVal } : {};

  if (Array.isArray(dnsObj.servers)) {
    const directServer = buildDirectDnsServer(settings.dns, ipv6Mode);
    const idx = dnsObj.servers.findIndex((s) => s.tag === "local");
    if (idx >= 0) {
      dnsObj.servers[idx] = directServer;
    } else {
      dnsObj.servers.unshift(directServer);
    }

    if (needsBootstrap && !dnsObj.servers.some((s) => s.tag === "local-bootstrap")) {
      dnsObj.servers.push({
        type: "udp",
        tag: "local-bootstrap",
        server: bootstrap,
        server_port: 53,
      });
    }

    if (backup && !dnsObj.servers.some((s) => s.tag === "local-backup")) {
      dnsObj.servers.push({
        type: "udp",
        tag: "local-backup",
        server: backup,
        server_port: 53,
      });
    }
  }

  // Derive per-outbound DNS servers for custom split rules targeting non-default proxy outbounds.
  const derived = buildDerivedRuleDns(config, profile);
  if (Array.isArray(dnsObj.servers) && derived.servers.length > 0) {
    dnsObj.servers.push(...derived.servers);
  }

  // Apply explicit domain_resolver.strategy on route default and outbounds/endpoints.
  adaptDomainResolvers(config, ipv6Mode);

  if (Array.isArray(dnsObj.rules)) {
    let localDomainRule: Json | null = null;
    const magicDnsRules: Json[] = [];
    const adaptedRules: Json[] = [];
    let insertedDerivedRules = false;
    let insertedNonCnGfw = false;

    const pushNonCnGfwDirectRemote = () => {
      if (insertedNonCnGfw) return;
      insertedNonCnGfw = true;
      if (!allowProxyIpv6) {
        adaptedRules.push(
          and(
            [{ query_type: IPV6_CARRIERS }, { clash_mode: "Non-CN" }, { rule_set: "gfwlist" }],
            { action: "predefined", rcode: "NOERROR" },
          ),
        );
      }
      adaptedRules.push(
        and([{ clash_mode: "Non-CN" }, { rule_set: "gfwlist" }], {
          action: "route",
          server: "remote",
          ...ecs,
        }),
      );
    };

    for (const rule of dnsObj.rules) {
      // Drop `preferred_by: "local"` since `local` is now an explicit external DNS server.
      if (rule.preferred_by === "local") continue;

      // Keep Tailscale MagicDNS rules ahead of single-label NXDOMAIN protection.
      if (typeof rule.preferred_by === "string" && rule.action === "route") {
        magicDnsRules.push(rule);
        continue;
      }

      // LAN domains and single-label hostnames are resolved by dnsmasq; never forward to external DNS.
      if (isLocalDomainsRouteRule(rule)) {
        const { server: _server, ...rest } = rule;
        const suffixes = Array.isArray(rest.domain_suffix) ? (rest.domain_suffix as string[]) : [];
        const bareRoots = suffixes.map((s) => s.replace(/^\./, "")).filter(Boolean);
        const domain = Array.from(
          new Set([...(Array.isArray(rest.domain) ? (rest.domain as string[]) : []), ...bareRoots]),
        );
        localDomainRule = { ...rest, domain, action: "predefined", rcode: "NXDOMAIN" };
        continue;
      }

      if (allowProxyIpv6 && isProxyIpv6DropRule(rule)) {
        continue;
      }

      const v6Adapted = adaptDnsRuleIpv6(rule, ipv6Mode);
      if (!v6Adapted) continue;

      // Insert per-outbound derived DNS rules right before the generic custom-proxy -> remote rule.
      if (!insertedDerivedRules && derived.rules.length > 0 && isCustomProxyRemoteRule(v6Adapted)) {
        adaptedRules.push(...derived.rules);
        insertedDerivedRules = true;
      }

      // Main direct rule: wire backup failover when configured, then insert Non-CN gfwlist leak guard.
      if (isMainDirectLocalRule(v6Adapted)) {
        const { action: _action, server: _server, ...condition } = v6Adapted;
        adaptedRules.push(...buildLocalRouteRules(condition, "local-direct", !!backup));
        pushNonCnGfwDirectRemote();
        continue;
      }

      // Handle Non-CN unknown-domain strategy: remote_verify (anti-pollution default) vs hardened race.
      if (nonCnStrategy === "remote_verify") {
        if (referencesLocalAnswer(v6Adapted)) {
          continue;
        }
        if (isRemoteEvaluateRule(v6Adapted)) {
          const { speculative: _spec, ...rest } = v6Adapted;
          adaptedRules.push({
            ...rest,
            timeout: "3s",
          });
          continue;
        }
        if (isRemoteRespondRule(v6Adapted)) {
          const fallbackCond = and([
            { clash_mode: "Non-CN" },
            or([
              { match_response: "remote-answer", response_rcode: "NOERROR", rule_set: "geoip-cn" },
              { match_response: "remote-answer", response_rcode: "SERVFAIL" },
              { match_response: "remote-answer", response_rcode: "REFUSED" },
            ]),
          ]);
          if (allowProxyIpv6 && ipv6Mode === "ipv4_only") {
            adaptedRules.push(and([{ query_type: "AAAA" }, fallbackCond], { action: "predefined", rcode: "NOERROR" }));
          }
          adaptedRules.push(...buildLocalRouteRules(fallbackCond, "local-fallback", !!backup));
          adaptedRules.push(v6Adapted);
          continue;
        }
        if (isFinalServfailRule(v6Adapted)) {
          if (allowProxyIpv6 && ipv6Mode === "ipv4_only") {
            adaptedRules.push(
              and([{ query_type: "AAAA" }, { clash_mode: "Non-CN" }], { action: "predefined", rcode: "NOERROR" }),
            );
          }
          adaptedRules.push(...buildLocalRouteRules({ clash_mode: "Non-CN" }, "local-timeout-fallback", !!backup));
          adaptedRules.push(v6Adapted);
          continue;
        }
      } else {
        // Hardened race mode: drop `ip_is_private` race winner to prevent 127.0.0.1/0.0.0.0/10.x poisoning hijacks.
        if (isLocalPrivateRaceRule(v6Adapted)) {
          continue;
        }
        if (isRemoteRespondRule(v6Adapted)) {
          const errFallbackCond = and([
            { clash_mode: "Non-CN" },
            or([
              { match_response: "remote-answer", response_rcode: "SERVFAIL" },
              { match_response: "remote-answer", response_rcode: "REFUSED" },
            ]),
          ]);
          adaptedRules.push(...buildLocalRouteRules(errFallbackCond, "local-fallback", !!backup));
          adaptedRules.push(v6Adapted);
          continue;
        }
      }

      adaptedRules.push(v6Adapted);
    }

    const prefixRules: Json[] = [];
    if (localDomainRule) prefixRules.push(localDomainRule);
    prefixRules.push(...magicDnsRules);
    if (localDomainRule) prefixRules.push({ domain_regex: ["^[^.]+$"], action: "predefined", rcode: "NXDOMAIN" });
    dnsObj.rules = [...prefixRules, ...adaptedRules];
  }

  // Add dedicated dns-in direct inbound for dnsmasq forwarding.
  const inbounds = (config.inbounds as Json[]) ?? [];
  const dnsInbound: Json = {
    type: "direct",
    tag: "dns-in",
    listen: settings.dns.listenAddress.trim(),
    listen_port: settings.dns.listenPort,
  };
  const existingIdx = inbounds.findIndex((i) => i.tag === "dns-in");
  if (existingIdx >= 0) {
    inbounds[existingIdx] = dnsInbound;
  } else {
    inbounds.push(dnsInbound);
  }
  config.inbounds = inbounds;

  // Prepend dns-in hijack rule at the top of route.rules; remove general port-53 hijack when hijack=false.
  const route = config.route as { rules?: Json[] } | undefined;
  if (route && Array.isArray(route.rules)) {
    if (!settings.dns.hijack) {
      route.rules = route.rules.filter((r) => !(r.action === "hijack-dns" && r.inbound !== "dns-in"));
    }
    const hasDnsInRule = route.rules.some((r) => r.inbound === "dns-in" && r.action === "hijack-dns");
    if (!hasDnsInRule) {
      route.rules.unshift({ inbound: "dns-in", action: "hijack-dns" });
    }
  }
}
