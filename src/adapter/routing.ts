import { sagerNetUrl } from "../upstream/rule-sets";
import {
  buildClientMatch,
  buildPostSniffAccessControlRules,
  hasMacAccessControl,
  parseClientEntries,
} from "./access";
import {
  COMMON_ROUTING_PORTS,
  defaultOpenWrtRoutingSettings,
  type Ipv6Mode,
  type OpenWrtSettings,
  type RoutingPortMode,
} from "./types";
import { parseRoutingPorts } from "./validation";

type Json = Record<string, unknown>;

const UPSTREAM_CN_SITE = "geosite-geolocation-cn";
const FULL_CN_SITE = "geosite-cn";

const and = (rules: Json[], extra: Json = {}): Json => ({ type: "logical", mode: "and", rules, ...extra });
const or = (rules: Json[], extra: Json = {}): Json => ({ type: "logical", mode: "or", rules, ...extra });

function invertRule(rule: Json): Json {
  const cloned = structuredClone(rule);
  if (cloned.invert === true) {
    delete cloned.invert;
    return cloned;
  }
  return { ...cloned, invert: true };
}

function isNoPublicV6Condition(item: Json): boolean {
  return (
    item.invert === true &&
    Array.isArray(item.default_interface_address) &&
    item.default_interface_address.includes("2000::/3")
  );
}

function isLocalDomainsRule(rule: Json): boolean {
  return (
    rule.action === "route" &&
    rule.outbound === "direct" &&
    Array.isArray(rule.domain) &&
    rule.domain.includes("localhost") &&
    Array.isArray(rule.domain_suffix) &&
    rule.domain_suffix.includes(".lan")
  );
}

function isCustomDirectRule(rule: Json): boolean {
  if (rule.action !== "route" || rule.outbound !== "direct") return false;
  if (rule.type !== "logical" || rule.mode !== "and" || !Array.isArray(rule.rules)) return false;
  return (rule.rules as Json[]).some(
    (r) =>
      r.rule_set === "custom-direct-domains" ||
      (Array.isArray(r.rule_set) && r.rule_set.includes("custom-direct-domains")),
  );
}

function isPrivateDirectRule(rule: Json): boolean {
  return rule.ip_is_private === true && rule.action === "route" && rule.outbound === "direct";
}

function isDirectModeRule(rule: Json): boolean {
  return rule.clash_mode === "Direct" && rule.action === "route" && rule.outbound === "direct";
}

function isCustomProxyRule(rule: Json): boolean {
  return (
    rule.action === "route" &&
    rule.outbound === "proxy" &&
    Array.isArray(rule.rule_set) &&
    rule.rule_set.includes("gfwlist-custom-domains")
  );
}

function isGlobalModeRule(rule: Json): boolean {
  return rule.clash_mode === "Global" && rule.action === "route" && rule.outbound === "proxy";
}

function isNonCnDirectRule(rule: Json): boolean {
  if (rule.action !== "route" || rule.outbound !== "direct") return false;
  if (rule.type !== "logical" || rule.mode !== "and" || !Array.isArray(rule.rules)) return false;
  return (rule.rules as Json[]).some((r) => r.clash_mode === "Non-CN");
}

function isGfwlistDirectRule(rule: Json): boolean {
  if (rule.action !== "route" || rule.outbound !== "direct") return false;
  if (rule.type !== "logical" || rule.mode !== "and" || !Array.isArray(rule.rules)) return false;
  return (rule.rules as Json[]).some((r) => r.clash_mode === "GFWList");
}

/** Recursively replace references to `geosite-geolocation-cn` with `geosite-cn`. */
function rewriteRuleSetTag(value: unknown, fromTag: string, toTag: string): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (value[i] === fromTag) value[i] = toTag;
      else rewriteRuleSetTag(value[i], fromTag, toTag);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  const obj = value as Json;
  if (obj.rule_set === fromTag) {
    obj.rule_set = toTag;
  } else if (Array.isArray(obj.rule_set)) {
    obj.rule_set = Array.from(
      new Set((obj.rule_set as string[]).map((t) => (t === fromTag ? toTag : t))),
    );
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === "rule_set") continue;
    if (v && typeof v === "object") rewriteRuleSetTag(v, fromTag, toTag);
  }
}

/** Remap upstream `geosite-geolocation-cn` to `geosite-cn` (includes CN CDNs such as Apple/MS/Google CN). */
function adaptCnSiteRuleSet(config: Json, cnSiteRuleset: string): string {
  if (cnSiteRuleset !== FULL_CN_SITE) return UPSTREAM_CN_SITE;

  const route = config.route as { rule_set?: Json[]; rules?: Json[] } | undefined;
  const dns = config.dns as { rules?: Json[] } | undefined;
  if (!route || !Array.isArray(route.rule_set)) return UPSTREAM_CN_SITE;

  const hasFullAlready = route.rule_set.some((rs) => rs.tag === FULL_CN_SITE);
  if (hasFullAlready) {
    route.rule_set = route.rule_set.filter((rs) => rs.tag !== UPSTREAM_CN_SITE);
  } else {
    for (const rs of route.rule_set) {
      if (rs.tag === UPSTREAM_CN_SITE) {
        rs.tag = FULL_CN_SITE;
        if (rs.type === "remote") {
          rs.url = sagerNetUrl("geosite", "cn");
        }
      }
    }
  }

  if (Array.isArray(route.rules)) rewriteRuleSetTag(route.rules, UPSTREAM_CN_SITE, FULL_CN_SITE);
  if (dns && Array.isArray(dns.rules)) rewriteRuleSetTag(dns.rules, UPSTREAM_CN_SITE, FULL_CN_SITE);
  return FULL_CN_SITE;
}

/** Build a sing-box matcher for a single port mode ("all" -> null). */
function buildSinglePortMatch(mode: RoutingPortMode, customPorts: string): Json | null {
  if (mode === "all") return null;
  const raw = mode === "common" ? COMMON_ROUTING_PORTS : customPorts || "";
  const { ports, ranges } = parseRoutingPorts(raw);
  const parts: Json[] = [];
  if (ports.length > 0) parts.push({ port: ports });
  if (ranges.length > 0) parts.push({ port_range: ranges });
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0] : or(parts);
}

/**
 * Build a matcher for traffic whose destination port should bypass default proxying.
 * Supports shared TCP+UDP port filtering (`udpPortMode: "follow"`) as well as independent TCP/UDP modes.
 */
function buildBypassPortsMatch(settings: OpenWrtSettings): Json | null {
  const routing = settings.routing ?? defaultOpenWrtRoutingSettings();
  const udpMode = routing.udpPortMode ?? "follow";

  if (udpMode === "follow") {
    const included = buildSinglePortMatch(routing.portMode, routing.customPorts);
    return included ? invertRule(included) : null;
  }

  const tcpIncluded = buildSinglePortMatch(routing.portMode, routing.customPorts);
  const udpIncluded = buildSinglePortMatch(udpMode, routing.customUdpPorts || "");
  const parts: Json[] = [];
  if (tcpIncluded) {
    parts.push(and([{ network: "tcp" }, invertRule(tcpIncluded)]));
  }
  if (udpIncluded) {
    parts.push(and([{ network: "udp" }, invertRule(udpIncluded)]));
  }
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0] : or(parts);
}

/** Strip route action/outbound fields from a rule to reuse its exact matcher. */
function stripRouteAction(rule: Json): Json {
  const { action: _action, outbound: _outbound, method: _method, no_drop: _noDrop, ...matcher } = rule;
  return structuredClone(matcher);
}

/**
 * Adapt `config.route` for OpenWrt gateway operation:
 * 1. Remap `geosite-geolocation-cn` -> `geosite-cn` when selected.
 * 2. Adapt CN public IPv6 reject rule for OpenWrt `ipv6Mode` (`direct` / `auto` / `ipv4_only`).
 * 3. Add Tailscale Exit Node inbound rules (`advertise_exit_node: true`) for DNS hijack and LAN/subnet reachability.
 * 4. Fix post-sniff priority: `ip_is_private -> direct` -> `accessControl` -> `custom-direct` -> `s.rules` -> port filter -> mode rules -> optional proxied QUIC reject.
 * 5. Emit sing-box 1.13+ Linux `auto_redirect` pre-match `action: "bypass"` rules BEFORE `{ action: "sniff" }`.
 *    STRICTLY emits pure `action: "bypass"` (never `action: "route"` / `"reject"`) using accumulated
 *    `noBypass` exclusions so normal-path userspace traffic ALWAYS runs `sniff`, `hijack-dns`, and `block_quic`.
 * 6. Enable native `find_neighbor: true` when MAC selectors are present.
 */
export function adaptRouting(config: Json, settings: OpenWrtSettings): void {
  const route = config.route as {
    rules?: Json[];
    rule_set?: Json[];
    find_neighbor?: boolean;
    dhcp_lease_files?: string[];
  } | undefined;
  if (!route || !Array.isArray(route.rules)) return;

  const routing = settings.routing ?? defaultOpenWrtRoutingSettings();
  const ipv6Mode: Ipv6Mode = settings.tun.ipv6Mode ?? (settings.tun.ipv6 ? "direct" : "ipv4_only");
  const cnSiteTag = adaptCnSiteRuleSet(config, routing.cnSiteRuleset);

  if (hasMacAccessControl(settings.accessControl)) {
    route.find_neighbor = true;
  }

  // 1. Adapt upstream CN IPv6 pre-sniff reject rule for OpenWrt IPv6 mode
  route.rules = route.rules.flatMap((rule): Json[] => {
    if (
      rule.action === "reject" &&
      rule.type === "logical" &&
      rule.mode === "and" &&
      Array.isArray(rule.rules) &&
      (rule.rules as Json[]).some(isNoPublicV6Condition)
    ) {
      if (ipv6Mode === "direct") return [];
      if (ipv6Mode === "ipv4_only") {
        const remaining = (rule.rules as Json[]).filter((r) => !isNoPublicV6Condition(r));
        return remaining.length ? [{ ...rule, rules: remaining }] : [];
      }
    }
    return [rule];
  });

  const sniffIdx = route.rules.findIndex((r) => r.action === "sniff");
  if (sniffIdx < 0) return;

  const preSniffExisting = route.rules.slice(0, sniffIdx);
  const dnsInRules = preSniffExisting.filter((r) => r.inbound === "dns-in" && r.action === "hijack-dns");
  const preSniffOther = preSniffExisting.filter((r) => !(r.inbound === "dns-in" && r.action === "hijack-dns"));
  const postSniffExisting = route.rules.slice(sniffIdx); // starts with { action: "sniff" }

  // 2. Collect Tailscale Exit Node inbound rules (advertise_exit_node: true)
  const tailscaleInboundRules: Json[] = [];
  if (Array.isArray(config.endpoints)) {
    for (const ep of config.endpoints as Json[]) {
      if (ep.type !== "tailscale" || ep.advertise_exit_node !== true || typeof ep.tag !== "string") continue;
      tailscaleInboundRules.push({ inbound: ep.tag, port: 53, action: "hijack-dns" });
      const allowLan = ep.exit_node_allow_lan_access !== false;
      const advRoutes = Array.isArray(ep.advertise_routes)
        ? (ep.advertise_routes as string[]).map((x) => x.trim()).filter(Boolean)
        : [];
      if (allowLan && advRoutes.length > 0) {
        tailscaleInboundRules.push(
          and(
            [{ inbound: ep.tag }, or([{ ip_is_private: true }, { ip_cidr: advRoutes }])],
            { action: "route", outbound: "direct" },
          ),
        );
      } else if (allowLan) {
        tailscaleInboundRules.push({
          inbound: ep.tag,
          ip_is_private: true,
          action: "route",
          outbound: "direct",
        });
      } else if (advRoutes.length > 0) {
        tailscaleInboundRules.push({
          inbound: ep.tag,
          ip_cidr: advRoutes,
          action: "route",
          outbound: "direct",
        });
      }
    }
  }

  // 3. Reorganize post-sniff rules:
  //    sniff -> hijack-dns -> iCloud QUIC -> Tailscale inbound/outbound -> LOCAL_DOMAINS -> ip_is_private
  //    -> accessControl (deviceRules / blocklist / allowlist) -> custom-direct -> user s.rules
  //    -> port filter fallback -> Direct -> custom-proxy -> GFWList -> Non-CN -> optional proxied QUIC reject -> Global
  const postSniff: Json[] = [];
  const privRule = postSniffExisting.find(isPrivateDirectRule);
  const localDomainsRule = postSniffExisting.find(isLocalDomainsRule);
  const customDirectRule = postSniffExisting.find(isCustomDirectRule);
  const customProxyRule = postSniffExisting.find(isCustomProxyRule);
  const nonCnRule = postSniffExisting.find(isNonCnDirectRule);

  // Extract user s.rules + tailnet outbound rules (from upstream post-sniff) so pre-match stays 100% in sync
  const customDirectIdx = postSniffExisting.findIndex(isCustomDirectRule);
  const privIdx = postSniffExisting.findIndex(isPrivateDirectRule);
  const userRouteRules =
    customDirectIdx >= 0 && privIdx > customDirectIdx
      ? postSniffExisting.slice(customDirectIdx + 1, privIdx)
      : [];

  const tailnetTags = new Set(
    Array.isArray(config.endpoints)
      ? (config.endpoints as Json[])
          .filter((ep) => ep.type === "tailscale" && typeof ep.tag === "string")
          .map((ep) => String(ep.tag))
      : [],
  );
  const tailnetOutboundRules = postSniffExisting.filter(
    (r) =>
      r.action === "route" &&
      typeof r.outbound === "string" &&
      tailnetTags.has(r.outbound) &&
      !userRouteRules.includes(r),
  );

  const accessControlPost = buildPostSniffAccessControlRules(settings);
  const bypassPortsMatch = buildBypassPortsMatch(settings);

  let insertedPrivateAndAccess = false;
  let insertedPortAndQuic = false;

  for (const rule of postSniffExisting) {
    // Skip original ip_is_private position; we re-insert it right after LOCAL_DOMAINS (before accessControl & s.rules)
    if (rule === privRule) continue;

    // Insert Tailscale inbound rules right after sniff
    if (rule.action === "sniff") {
      postSniff.push(rule);
      if (tailscaleInboundRules.length > 0) {
        postSniff.push(...tailscaleInboundRules);
      }
      continue;
    }

    // Re-place ip_is_private + accessControl immediately after LOCAL_DOMAINS (and before custom-direct / s.rules)
    if (rule === localDomainsRule) {
      postSniff.push(rule);
      if (privRule) postSniff.push(privRule);
      if (accessControlPost.length > 0) postSniff.push(...accessControlPost);
      insertedPrivateAndAccess = true;
      continue;
    }

    // Insert post-sniff port filter right before Direct mode fallback (after user s.rules)
    if (isDirectModeRule(rule)) {
      if (bypassPortsMatch) {
        postSniff.push({ ...bypassPortsMatch, action: "route", outbound: "direct" });
      }
      postSniff.push(rule);
      continue;
    }

    // Insert proxied QUIC (UDP 443) reject right before Global -> proxy (after all direct/CN/GFWList rules)
    if (isGlobalModeRule(rule)) {
      if (routing.blockQuic) {
        postSniff.push({
          network: "udp",
          port: 443,
          action: "reject",
          method: "default",
          no_drop: true,
        });
      }
      insertedPortAndQuic = true;
      postSniff.push(rule);
      continue;
    }

    postSniff.push(rule);
  }

  if (!insertedPrivateAndAccess) {
    if (privRule) postSniff.splice(1, 0, privRule);
    if (accessControlPost.length > 0) postSniff.splice(privRule ? 2 : 1, 0, ...accessControlPost);
  }
  if (!insertedPortAndQuic && routing.blockQuic) {
    postSniff.push({
      network: "udp",
      port: 443,
      action: "reject",
      method: "default",
      no_drop: true,
    });
  }

  // 4. Build sing-box 1.13+ Linux auto_redirect pre-match `action: "bypass"` layer.
  //    ONLY pure `action: "bypass"` (without outbound) is emitted here; higher-priority proxy/reject/tailnet
  //    rules are accumulated in `noBypass` and negated on subsequent bypass rules so userspace traffic never
  //    short-circuits `sniff`, `hijack-dns`, or `block_quic`.
  const preMatch: Json[] = [];
  const enablePreMatchBypass =
    settings.tun.enabled &&
    settings.tun.autoRoute &&
    settings.tun.autoRedirect &&
    routing.bypassCn !== false;

  if (enablePreMatchBypass) {
    const tunAddresses = [settings.tun.addressV4.trim()];
    if (settings.tun.ipv6 && settings.tun.addressV6.trim()) {
      tunAddresses.push(settings.tun.addressV6.trim());
    }

    const noBypass: Json[] = [];

    const pushBypass = (matcher: Json | null, protectPort53 = true): void => {
      const parts: Json[] = [{ inbound: "tun-in" }];
      if (matcher) parts.push(structuredClone(matcher));
      if (noBypass.length === 1) {
        parts.push(invertRule(noBypass[0]));
      } else if (noBypass.length > 1) {
        parts.push(or(noBypass.map((m) => structuredClone(m)), { invert: true }));
      }
      parts.push({ source_ip_cidr: tunAddresses, invert: true });
      if (protectPort53 && settings.dns.hijack) {
        parts.push({ port: 53, invert: true });
      }
      preMatch.push(and(parts, { action: "bypass" }));
    };

    // 4a. Tailscale outbound routes must not be bypassed by ip_is_private (Tailscale uses 100.64.0.0/10 CGNAT).
    for (const r of tailnetOutboundRules) {
      noBypass.push(stripRouteAction(r));
    }

    // 4b. LAN / private & local domains bypass first (so every device can reach LAN/router directly).
    const lanTargets: Json[] = [{ ip_is_private: true }];
    if (localDomainsRule) {
      lanTargets.push(stripRouteAction(localDomainsRule));
    }
    pushBypass(lanTargets.length === 1 ? lanTargets[0] : or(lanTargets), true);

    // 4c. Client Access Control (highest priority over user domain rules and mode rules).
    const ac = settings.accessControl;
    if (ac) {
      for (const dr of ac.deviceRules || []) {
        if (dr.enabled === false) continue;
        const out = (dr.outbound || "").trim();
        if (!out) continue;
        const parsed = parseClientEntries(dr.clients || []);
        const m = buildClientMatch(parsed.cidrs, parsed.macs, false);
        if (!m) continue;
        if (out === "direct") {
          pushBypass(m, false);
        } else {
          noBypass.push(m);
        }
      }

      if (ac.mode === "blocklist") {
        const parsed = parseClientEntries(ac.clients || []);
        const m = buildClientMatch(parsed.cidrs, parsed.macs, false);
        if (m) pushBypass(m, false);
      } else if (ac.mode === "allowlist") {
        const parsed = parseClientEntries(ac.clients || []);
        const m = buildClientMatch(parsed.cidrs, parsed.macs, true);
        pushBypass(m, false);
      }
    }

    // 4d. Non-Global custom direct list -> bypass
    if (customDirectRule) {
      pushBypass(stripRouteAction(customDirectRule), true);
    }

    // 4e. Ordered user custom routing rules (direct -> bypass; proxy/node/group/reject -> exclude from later bypass)
    for (const r of userRouteRules) {
      const matcher = stripRouteAction(r);
      if (r.action === "route" && r.outbound === "direct") {
        pushBypass(matcher, true);
      } else if (r.action === "reject" || (r.action === "route" && typeof r.outbound === "string")) {
        noBypass.push(matcher);
      }
    }

    // 4f & 4g. Non-proxy destination ports + Direct Clash mode share the same `noBypass` snapshot.
    const portAndDirectTargets: Json[] = [];
    if (bypassPortsMatch) portAndDirectTargets.push(bypassPortsMatch);
    portAndDirectTargets.push({ clash_mode: "Direct" });
    pushBypass(portAndDirectTargets.length === 1 ? portAndDirectTargets[0] : or(portAndDirectTargets), true);

    // 4h. Explicit custom proxy list -> prevent CN bypass below from overriding explicit proxy entries.
    if (customProxyRule) {
      noBypass.push(stripRouteAction(customProxyRule));
    }

    // Preserve pre-sniff CN IPv6 reject behavior (auto / ipv4_only) for non-excluded devices.
    for (const r of preSniffOther) {
      if (r.action === "reject") {
        noBypass.push(stripRouteAction(r));
      }
    }

    // 4i. Mainland China kernel bypass (preserves Global mode & GFWList explicit proxy entries).
    //     When `routeExcludeCn` is enabled, `geoip-cn` is already bypassed at Layer 1 (route_exclude_address_set).
    const steamDirect = nonCnRule && JSON.stringify(nonCnRule).includes("steamcontent.com");
    const includeGeoipCn = settings.tun.routeExcludeCn !== true;

    const nonCnTargets: Json[] = [
      { rule_set: cnSiteTag },
      ...(includeGeoipCn ? [{ rule_set: "geoip-cn" }] : []),
      ...(steamDirect ? [{ domain_suffix: ["steamcontent.com"] }] : []),
    ];
    const cnBypassBranches: Json[] = [
      and([
        { clash_mode: "Non-CN" },
        nonCnTargets.length === 1 ? nonCnTargets[0] : or(nonCnTargets),
      ]),
    ];

    const hasGfwRule = postSniffExisting.some(isGfwlistDirectRule);
    if (hasGfwRule) {
      const gfwCnTargets: Json[] = [
        { rule_set: cnSiteTag },
        ...(includeGeoipCn ? [{ rule_set: "geoip-cn" }] : []),
      ];
      cnBypassBranches.push(
        and([
          { clash_mode: "GFWList" },
          { rule_set: ["gfwlist", "telegram-ip"], invert: true },
          gfwCnTargets.length === 1 ? gfwCnTargets[0] : or(gfwCnTargets),
        ]),
      );
    }

    pushBypass(cnBypassBranches.length === 1 ? cnBypassBranches[0] : or(cnBypassBranches), true);
  }

  route.rules = [...dnsInRules, ...preMatch, ...preSniffOther, ...postSniff];
}
