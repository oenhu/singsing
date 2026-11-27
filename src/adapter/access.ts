import type { OpenWrtAccessControl, OpenWrtSettings } from "./types";
import { isValidCidr, isValidIpv4, isValidIpv6 } from "./validation";

type Json = Record<string, unknown>;

const MAC_RE = /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/;

export function isValidMac(mac: string): boolean {
  return MAC_RE.test(mac.trim());
}

export function normalizeMac(mac: string): string {
  return mac.trim().toLowerCase().replace(/-/g, ":");
}

export interface ParsedClients {
  cidrs: string[];
  macs: string[];
  invalid: string[];
}

export function parseClientEntries(entries: string[]): ParsedClients {
  const cidrs: string[] = [];
  const macs: string[] = [];
  const invalid: string[] = [];

  for (const raw of entries) {
    const v = raw.trim();
    if (!v) continue;
    if (isValidMac(v)) {
      const norm = normalizeMac(v);
      if (!macs.includes(norm)) macs.push(norm);
    } else if (isValidIpv4(v)) {
      const c = `${v}/32`;
      if (!cidrs.includes(c)) cidrs.push(c);
    } else if (isValidIpv6(v)) {
      const c = `${v.toLowerCase()}/128`;
      if (!cidrs.includes(c)) cidrs.push(c);
    } else if (isValidCidr(v, 4) || isValidCidr(v, 6)) {
      const c = v.toLowerCase();
      if (!cidrs.includes(c)) cidrs.push(c);
    } else {
      invalid.push(v);
    }
  }

  return { cidrs, macs, invalid };
}

/** Build a sing-box matcher for source IPs and/or source MACs (using logical OR when both exist). */
export function buildClientMatch(cidrs: string[], macs: string[], invert = false): Json | null {
  const parts: Json[] = [];
  if (cidrs.length > 0) parts.push({ source_ip_cidr: cidrs });
  if (macs.length > 0) parts.push({ source_mac_address: macs });
  if (parts.length === 0) return null;

  if (parts.length === 1) {
    return invert ? { ...parts[0], invert: true } : parts[0];
  }
  return {
    type: "logical",
    mode: "or",
    rules: parts,
    ...(invert ? { invert: true } : {}),
  };
}

/** Whether any active client access control or device rule uses MAC matching. */
export function hasMacAccessControl(ac: OpenWrtAccessControl | undefined): boolean {
  if (!ac) return false;
  if (ac.mode !== "all" && parseClientEntries(ac.clients || []).macs.length > 0) {
    return true;
  }
  for (const dr of ac.deviceRules || []) {
    if (dr.enabled === false) continue;
    if ((dr.outbound || "").trim() && parseClientEntries(dr.clients || []).macs.length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Build normal-path (post-sniff) client access control route rules.
 * Placed after `ip_is_private -> direct` and BEFORE custom domain/IP rules (`s.rules`) so
 * blocklisted / non-allowlisted devices never get hijacked by user domain rules while
 * LAN-to-LAN traffic always remains reachable.
 */
export function buildPostSniffAccessControlRules(settings: OpenWrtSettings): Json[] {
  const ac = settings.accessControl;
  if (!ac) return [];

  const injected: Json[] = [];

  // 1. Per-device outbound overrides first so explicit device rules take priority over global mode
  for (const dr of ac.deviceRules || []) {
    if (dr.enabled === false) continue;
    const out = (dr.outbound || "").trim();
    if (!out) continue;
    const parsed = parseClientEntries(dr.clients || []);
    const m = buildClientMatch(parsed.cidrs, parsed.macs, false);
    if (m) {
      injected.push({ ...m, action: "route", outbound: out });
    }
  }

  // 2. Global allowlist / blocklist mode
  if (ac.mode === "blocklist") {
    const parsed = parseClientEntries(ac.clients || []);
    const m = buildClientMatch(parsed.cidrs, parsed.macs, false);
    if (m) {
      injected.push({ ...m, action: "route", outbound: "direct" });
    }
  } else if (ac.mode === "allowlist" && settings.tun.enabled) {
    const parsed = parseClientEntries(ac.clients || []);
    const m = buildClientMatch(parsed.cidrs, parsed.macs, true);
    if (m) {
      injected.push({
        type: "logical",
        mode: "and",
        rules: [{ inbound: "tun-in" }, m],
        action: "route",
        outbound: "direct",
      });
    } else {
      injected.push({
        inbound: "tun-in",
        action: "route",
        outbound: "direct",
      });
    }
  }

  return injected;
}

/**
 * Inject client access control rules into `config.route.rules` and configure native
 * neighbor lookup (`find_neighbor` + `dhcp_lease_files`) when MAC selectors are present.
 */
export function adaptAccessControl(config: Json, settings: OpenWrtSettings): void {
  const route = config.route as { rules?: Json[]; find_neighbor?: boolean; dhcp_lease_files?: string[] } | undefined;
  if (!route || !Array.isArray(route.rules)) return;

  if (hasMacAccessControl(settings.accessControl)) {
    route.find_neighbor = true;
  }

  const injected = buildPostSniffAccessControlRules(settings);
  if (injected.length === 0) return;

  const privIdx = route.rules.findIndex(
    (r) => r.ip_is_private === true && r.action === "route" && r.outbound === "direct",
  );
  const insertAt = privIdx >= 0 ? privIdx + 1 : 0;
  route.rules.splice(insertAt, 0, ...injected);
}
