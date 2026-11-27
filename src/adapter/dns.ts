import type { Ipv6Mode, OpenWrtDnsSettings, OpenWrtSettings } from "./types";
import { isValidHostname, isValidIp } from "./validation";

type Json = Record<string, unknown>;

const IPV6_CARRIERS = ["AAAA", "HTTPS", "SVCB"];

/**
 * Build the direct upstream DNS server object (tag: "local").
 * Supports IPv4/IPv6 direct servers and domain-based DoT/DoH servers when `localBootstrap` is provided.
 */
export function buildDirectDnsServer(dns: OpenWrtDnsSettings): Json {
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
      server.domain_resolver = "local-bootstrap";
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
    // ipv4_only: keep the rule unconditionally without the interface-address guard
    const remaining = sub.filter((item) => !isNoPublicV6Condition(item));
    if (remaining.length === 0) return null;
    return { ...rule, rules: remaining };
  }
  return rule;
}

/**
 * Adapt DNS servers, DNS rules, dns-in inbound, and route hijack rule for OpenWrt:
 * - Replace `tag: "local"` with user's manual direct upstream DNS (+ optional bootstrap/backup servers).
 * - Remove `{ preferred_by: "local", ... }` (invalid/unused once `local` is no longer `type: "local"`).
 * - Rewrite upstream `LOCAL_DOMAINS` (.lan/.home.arpa/localhost) rule to return NXDOMAIN before MagicDNS,
 *   and single-label hostnames (`^[^.]+$`) after MagicDNS so LAN names never leak to external DNS.
 * - Apply OpenWrt IPv6 mode (`direct` / `auto` / `ipv4_only`) and optional `allowProxyIpv6`.
 * - Add Non-CN `remote-answer` SERVFAIL/REFUSED safe fallback to `local`.
 * - Add `dns-in` direct inbound and prepend `{ inbound: "dns-in", action: "hijack-dns" }`.
 */
export function adaptDns(config: Json, settings: OpenWrtSettings): void {
  const dnsObj = config.dns as { servers?: Json[]; rules?: Json[] } | undefined;
  if (!dnsObj) return;

  const bootstrap = (settings.dns.localBootstrap || "").trim();
  const backup = (settings.dns.localBackupServer || "").trim();
  const directHost = settings.dns.localServer.trim();
  const encrypted = settings.dns.localType === "tls" || settings.dns.localType === "https";
  const needsBootstrap = encrypted && !isValidIp(directHost) && isValidHostname(directHost) && !!bootstrap;
  const ipv6Mode: Ipv6Mode = settings.tun.ipv6Mode ?? (settings.tun.ipv6 ? "direct" : "ipv4_only");
  const allowProxyIpv6 = settings.dns.allowProxyIpv6 === true;

  if (Array.isArray(dnsObj.servers)) {
    const directServer = buildDirectDnsServer(settings.dns);
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

  if (Array.isArray(dnsObj.rules)) {
    let localDomainRule: Json | null = null;
    const magicDnsRules: Json[] = [];
    const adaptedRules: Json[] = [];

    for (const rule of dnsObj.rules) {
      // Drop `preferred_by: "local"` since `local` is now an explicit external DNS server.
      if (rule.preferred_by === "local") continue;

      // Keep Tailscale MagicDNS rules ahead of single-label NXDOMAIN protection so single-label
      // tailnet peer names resolve via MagicDNS while .lan/.home.arpa remain strictly local.
      if (typeof rule.preferred_by === "string" && rule.action === "route") {
        magicDnsRules.push(rule);
        continue;
      }

      // LAN domains and single-label hostnames are resolved by dnsmasq; never forward them to external DNS.
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

      // In Non-CN mode, if the speculative remote resolver returns SERVFAIL/REFUSED, fall back safely to local.
      if (v6Adapted.match_response === "remote-answer" && v6Adapted.action === "respond") {
        adaptedRules.push({
          type: "logical",
          mode: "and",
          rules: [
            { clash_mode: "Non-CN" },
            {
              type: "logical",
              mode: "or",
              rules: [
                { match_response: "remote-answer", response_rcode: "SERVFAIL" },
                { match_response: "remote-answer", response_rcode: "REFUSED" },
              ],
            },
          ],
          action: "route",
          server: "local",
        });
      }

      // If a backup direct DNS server is configured, convert the main direct `route: local` rule
      // into evaluate-with-fallback so primary outage fails over cleanly to `local-backup`.
      if (
        backup &&
        v6Adapted.action === "route" &&
        v6Adapted.server === "local" &&
        v6Adapted.type === "logical" &&
        v6Adapted.mode === "or"
      ) {
        const { action: _action, server: _server, ...condition } = v6Adapted;
        adaptedRules.push(
          {
            ...condition,
            action: "evaluate",
            server: "local",
            tag: "local-direct",
            timeout: "1500ms",
          },
          {
            type: "logical",
            mode: "or",
            rules: [
              { match_response: "local-direct", response_rcode: "SERVFAIL" },
              { match_response: "local-direct", response_rcode: "REFUSED" },
            ],
            action: "route",
            server: "local-backup",
          },
          {
            match_response: "local-direct",
            action: "respond",
          },
          {
            ...condition,
            action: "route",
            server: "local-backup",
          },
        );
        continue;
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
