import type { OpenWrtDnsSettings, OpenWrtSettings } from "./types";

type Json = Record<string, unknown>;

/**
 * Build the manual direct upstream DNS server object (tag: "local").
 * Replaces upstream's `{ type: "local", tag: "local", neighbor_domain: [...] }`.
 */
export function buildDirectDnsServer(dns: OpenWrtDnsSettings): Json {
  const server: Json = {
    type: dns.localType,
    tag: "local",
    server: dns.localServer.trim(),
    server_port: dns.localPort,
  };

  if (dns.localType === "https") {
    server.path = dns.localPath.trim() || "/dns-query";
  }

  if (dns.localType === "tls" || dns.localType === "https") {
    const sni = dns.localServerName.trim();
    server.tls = {
      enabled: true,
      ...(sni ? { server_name: sni } : {}),
    };
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

/**
 * Adapt DNS servers, DNS rules, dns-in inbound, and route hijack rule for OpenWrt:
 * - Replace `tag: "local"` with user's mandatory manual direct upstream DNS.
 * - Remove `{ preferred_by: "local", ... }` (invalid/unused once `local` is no longer `type: "local"`).
 * - Rewrite upstream `LOCAL_DOMAINS` (.lan/.home.arpa/localhost) rule to return NXDOMAIN instead of
 *   leaking LAN queries to the external direct DNS (LAN resolution is handled exclusively by dnsmasq).
 * - Add `dns-in` direct inbound on 127.0.0.1:5335 and prepend `{ inbound: "dns-in", action: "hijack-dns" }`.
 */
export function adaptDns(config: Json, settings: OpenWrtSettings): void {
  const dnsObj = config.dns as { servers?: Json[]; rules?: Json[] } | undefined;
  if (!dnsObj) return;

  if (Array.isArray(dnsObj.servers)) {
    const directServer = buildDirectDnsServer(settings.dns);
    const idx = dnsObj.servers.findIndex((s) => s.tag === "local");
    if (idx >= 0) {
      dnsObj.servers[idx] = directServer;
    } else {
      dnsObj.servers.unshift(directServer);
    }
  }

  if (Array.isArray(dnsObj.rules)) {
    const adaptedRules: Json[] = [];
    for (const rule of dnsObj.rules) {
      // Drop `preferred_by: "local"` since `local` is now an explicit external DNS server.
      if (rule.preferred_by === "local") continue;

      // LAN domains are resolved by dnsmasq; never forward them to the external direct DNS.
      if (isLocalDomainsRouteRule(rule)) {
        const { server: _server, ...rest } = rule;
        adaptedRules.push({ ...rest, action: "predefined", rcode: "NXDOMAIN" });
        continue;
      }

      adaptedRules.push(rule);
    }
    dnsObj.rules = adaptedRules;
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

  // Prepend dns-in hijack rule at the top of route.rules.
  const route = config.route as { rules?: Json[] } | undefined;
  if (route && Array.isArray(route.rules)) {
    const hasDnsInRule = route.rules.some((r) => r.inbound === "dns-in" && r.action === "hijack-dns");
    if (!hasDnsInRule) {
      route.rules.unshift({ inbound: "dns-in", action: "hijack-dns" });
    }
  }
}
