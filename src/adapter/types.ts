import type { Issue } from "../upstream/generate";

export type DirectDnsType = "udp" | "tcp" | "tls" | "https";
export type NonCnDnsStrategy = "remote_verify" | "race";
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "panic";
export type Ipv6Mode = "direct" | "auto" | "ipv4_only";
export type CnSiteRuleset = "geosite-cn" | "geosite-geolocation-cn";
export type RoutingPortMode = "all" | "common" | "custom";
export type UdpPortMode = "follow" | "all" | "common" | "custom";

/** Standard common ports used when `routing.portMode === "common"`. */
export const COMMON_ROUTING_PORTS =
  "20,21,22,25,53,80,110,119,123,143,389,443,465,514,563,587,636,853,873,989,990,993,995,1194,1883,3306,3389,5222,5432,5671,5672,5900,6379,6443,6514,8080,8443,8883,9418";

export interface OpenWrtDnsSettings {
  /** Direct upstream DNS protocol. */
  localType: DirectDnsType;
  /** Mandatory direct upstream DNS IP (or domain for DoT/DoH when `localBootstrap` is provided). */
  localServer: string;
  /** Direct upstream DNS port (defaults: 53 for udp/tcp, 853 for tls, 443 for https). */
  localPort: number;
  /** TLS SNI hostname when localType is tls or https. */
  localServerName: string;
  /** DoH path when localType is https (default: /dns-query). */
  localPath: string;
  /** Optional bootstrap IP (IPv4/IPv6) used to resolve a domain-based direct DoT/DoH server. */
  localBootstrap?: string;
  /** Optional backup direct DNS IP (IPv4/IPv6) used if the primary direct DNS fails or times out. */
  localBackupServer?: string;
  /** Local listen address for sing-box dns-in direct inbound. */
  listenAddress: string;
  /** Local listen port for sing-box dns-in direct inbound (default: 5335). */
  listenPort: number;
  /** Enable sing-box native TUN DNS hijack (dns_mode: "hijack" vs "disabled"). */
  hijack: boolean;
  /** Automatically configure dnsmasq to forward external queries to dns-in. */
  dnsmasqManage: boolean;
  /** Allow AAAA/HTTPS/SVCB records on proxied domains (default false: IPv4-only proxy DNS). */
  allowProxyIpv6?: boolean;
  /** Non-CN unknown-domain DNS strategy: "remote_verify" (anti-pollution, default) or "race" (upstream parallel). */
  nonCnStrategy?: NonCnDnsStrategy;
}

export interface OpenWrtTunSettings {
  /** Enable TUN transparent proxy inbound. */
  enabled: boolean;
  /** Linux TUN interface name (default: singtun). */
  interfaceName: string;
  /** TUN IPv4 CIDR (default: 172.19.0.1/30). */
  addressV4: string;
  /** TUN IPv6 CIDR (default: fdfe:dcba:9876::1/126). */
  addressV6: string;
  autoRoute: boolean;
  autoRedirect: boolean;
  /** Default false on OpenWrt routers to avoid multi-WAN / SO_BINDTODEVICE / IPTV conflicts. */
  strictRoute: boolean;
  /** Include IPv6 address on TUN interface. */
  ipv6: boolean;
  /** Router IPv6 strategy: "direct" (PD-safe), "auto" (upstream default_interface_address), or "ipv4_only". */
  ipv6Mode?: Ipv6Mode;
  /** Optional custom MTU; null/undefined uses sing-box default (9000 on Linux TUN). */
  mtu: number | null;
  /** Optional UDP NAT timeout duration (e.g. "5m"); empty uses sing-box default. */
  udpTimeout?: string;
  /** Optional CIDRs excluded from TUN routing. */
  routeExcludeAddress: string[];
  /** Exclude geoip-cn at the routing table level (`route_exclude_address_set: ["geoip-cn"]`). */
  routeExcludeCn?: boolean;
  /** Optional LAN interfaces to capture via `tun.include_interface` (e.g. ["br-lan"]). */
  includeInterface?: string[];
  /** Optional outbound WAN interface bound via `route.default_interface` (disables auto_detect_interface). */
  defaultInterface?: string;
}

export interface OpenWrtMixedSettings {
  /** Enable optional LAN mixed (HTTP + SOCKS5) proxy inbound. */
  enabled: boolean;
  /** Listen address for mixed-in (default "::"). */
  listenAddress: string;
  /** Listen port for mixed-in (default 5330). */
  listenPort: number;
}

export interface OpenWrtRoutingSettings {
  /** Emit sing-box 1.13+ Linux auto_redirect pre-match `action: "bypass"` rules for direct/CN/LAN traffic. */
  bypassCn: boolean;
  /** Domestic site rule-set used in Non-CN and CN bypass ("geosite-cn" covers CN CDNs; "geosite-geolocation-cn" is upstream). */
  cnSiteRuleset: CnSiteRuleset;
  /** Destination port filter: "all" (proxy all ports), "common" (bypass non-common ports), or "custom". */
  portMode: RoutingPortMode;
  /** Comma-separated ports and ranges (e.g. "80,443,8000-8999") when `portMode === "custom"`. */
  customPorts: string;
  /** Optional UDP destination port filter: "follow" (match portMode), "all", "common", or "custom". */
  udpPortMode?: UdpPortMode;
  /** Comma-separated UDP ports and ranges when `udpPortMode === "custom"`. */
  customUdpPorts?: string;
  /** Reject QUIC (UDP/443) for proxied traffic so clients fall back cleanly to TCP/TLS (domestic QUIC unaffected). */
  blockQuic: boolean;
}

export interface OpenWrtPathsSettings {
  /** sing-box cache_file path; defaults to tmpfs (/tmp) to avoid flash wear. */
  cacheFile: string;
  /** Local directory storing downloaded .srs / .json rule-set files. */
  ruleSetDir: string;
  /** Persistent root directory for Tailscale state directories. */
  tailscaleStateRoot: string;
  /** Optional per-tag download URL overrides (e.g. custom mirror or self-hosted .srs). */
  ruleSetUrlOverrides?: Record<string, string>;
}

export type AccessControlMode = "all" | "allowlist" | "blocklist";

export interface ClientOutboundRule {
  id: string;
  name: string;
  /** IPv4, IPv6, CIDR, or MAC addresses. */
  clients: string[];
  /** Target outbound tag ("direct", "proxy", "auto", or user group/node tag). */
  outbound: string;
  enabled: boolean;
}

export interface OpenWrtAccessControl {
  mode: AccessControlMode;
  clients: string[];
  deviceRules: ClientOutboundRule[];
}

export interface OpenWrtSettings {
  dns: OpenWrtDnsSettings;
  tun: OpenWrtTunSettings;
  mixed?: OpenWrtMixedSettings;
  routing?: OpenWrtRoutingSettings;
  paths: OpenWrtPathsSettings;
  logLevel: LogLevel;
  /** Optional list of router LAN IP addresses used to detect DNS loop configurations. */
  routerLanIps?: string[];
  /** Optional LAN client access control & per-device outbound rules. */
  accessControl?: OpenWrtAccessControl;
}

export interface RuleSetManifestEntry {
  tag: string;
  url: string;
  format: "binary" | "source";
  path: string;
}

export interface OpenWrtGenerateResult {
  config: Record<string, unknown>;
  ruleSets: RuleSetManifestEntry[];
  issues: Issue[];
}

export function defaultPortForDnsType(type: DirectDnsType): number {
  if (type === "tls") return 853;
  if (type === "https") return 443;
  return 53;
}

export function defaultOpenWrtRoutingSettings(): OpenWrtRoutingSettings {
  return {
    bypassCn: true,
    cnSiteRuleset: "geosite-cn",
    portMode: "all",
    customPorts: "",
    udpPortMode: "follow",
    customUdpPorts: "",
    blockQuic: false,
  };
}

export function defaultOpenWrtMixedSettings(): OpenWrtMixedSettings {
  return {
    enabled: false,
    listenAddress: "::",
    listenPort: 5330,
  };
}

export function defaultOpenWrtSettings(): OpenWrtSettings {
  return {
    dns: {
      localType: "udp",
      localServer: "",
      localPort: 53,
      localServerName: "",
      localPath: "/dns-query",
      localBootstrap: "",
      localBackupServer: "",
      listenAddress: "127.0.0.1",
      listenPort: 5335,
      hijack: true,
      dnsmasqManage: true,
      allowProxyIpv6: false,
      nonCnStrategy: "remote_verify",
    },
    tun: {
      enabled: true,
      interfaceName: "singtun",
      addressV4: "172.19.0.1/30",
      addressV6: "fdfe:dcba:9876::1/126",
      autoRoute: true,
      autoRedirect: true,
      strictRoute: false,
      ipv6: true,
      ipv6Mode: "direct",
      mtu: 9000,
      udpTimeout: "",
      routeExcludeAddress: [],
      routeExcludeCn: false,
      includeInterface: [],
      defaultInterface: "",
    },
    mixed: defaultOpenWrtMixedSettings(),
    routing: defaultOpenWrtRoutingSettings(),
    paths: {
      cacheFile: "/tmp/singsing/cache.db",
      ruleSetDir: "/etc/sing-box/rule-sets",
      tailscaleStateRoot: "/etc/sing-box/tailscale",
    },
    logLevel: "info",
    routerLanIps: [],
  };
}
