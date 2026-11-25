import type { Issue } from "../upstream/generate";

export type DirectDnsType = "udp" | "tcp" | "tls" | "https";
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "panic";

export interface OpenWrtDnsSettings {
  /** Direct upstream DNS protocol. */
  localType: DirectDnsType;
  /** Mandatory manual direct upstream DNS IP address (IPv4 or IPv6). Empty blocks apply/start. */
  localServer: string;
  /** Direct upstream DNS port (defaults: 53 for udp/tcp, 853 for tls, 443 for https). */
  localPort: number;
  /** TLS SNI hostname when localType is tls or https. */
  localServerName: string;
  /** DoH path when localType is https (default: /dns-query). */
  localPath: string;
  /** Local listen address for sing-box dns-in direct inbound. */
  listenAddress: string;
  /** Local listen port for sing-box dns-in direct inbound (default: 5335). */
  listenPort: number;
  /** Enable sing-box native TUN DNS hijack (dns_mode: "hijack" vs "disabled"). */
  hijack: boolean;
  /** Automatically configure dnsmasq to forward external queries to dns-in. */
  dnsmasqManage: boolean;
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
  strictRoute: boolean;
  /** Include IPv6 address on TUN interface. */
  ipv6: boolean;
  /** Optional custom MTU; null/undefined uses sing-box default. */
  mtu: number | null;
  /** Optional CIDRs excluded from TUN routing. */
  routeExcludeAddress: string[];
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

export function defaultOpenWrtSettings(): OpenWrtSettings {
  return {
    dns: {
      localType: "udp",
      localServer: "",
      localPort: 53,
      localServerName: "",
      localPath: "/dns-query",
      listenAddress: "127.0.0.1",
      listenPort: 5335,
      hijack: true,
      dnsmasqManage: true,
    },
    tun: {
      enabled: true,
      interfaceName: "singtun",
      addressV4: "172.19.0.1/30",
      addressV6: "fdfe:dcba:9876::1/126",
      autoRoute: true,
      autoRedirect: true,
      strictRoute: true,
      ipv6: true,
      mtu: null,
      routeExcludeAddress: [],
    },
    paths: {
      cacheFile: "/tmp/singsing/cache.db",
      ruleSetDir: "/etc/sing-box/rule-sets",
      tailscaleStateRoot: "/etc/sing-box/tailscale",
    },
    logLevel: "info",
    routerLanIps: [],
  };
}
