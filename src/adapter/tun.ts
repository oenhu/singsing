import type { OpenWrtSettings } from "./types";

type Json = Record<string, unknown>;

/**
 * Adapt `tun-in`, optional `mixed-in` LAN proxy inbound, and `route.default_interface`
 * for OpenWrt (fw4 / nftables auto_redirect + native dns_mode).
 */
export function adaptTun(config: Json, settings: OpenWrtSettings): void {
  const inbounds = (config.inbounds as Json[]) ?? [];
  const idx = inbounds.findIndex((i) => i.tag === "tun-in" || i.type === "tun");

  if (!settings.tun.enabled) {
    if (idx >= 0) inbounds.splice(idx, 1);
  } else {
    const addresses = [settings.tun.addressV4.trim()];
    if (settings.tun.ipv6 && settings.tun.addressV6.trim()) {
      addresses.push(settings.tun.addressV6.trim());
    }

    const tunInbound: Json = {
      type: "tun",
      tag: "tun-in",
      interface_name: settings.tun.interfaceName.trim(),
      address: addresses,
      auto_route: settings.tun.autoRoute,
      auto_redirect: settings.tun.autoRedirect,
      strict_route: settings.tun.strictRoute,
      dns_mode: settings.dns.hijack ? "hijack" : "disabled",
    };

    if (settings.tun.mtu !== null && Number.isInteger(settings.tun.mtu)) {
      tunInbound.mtu = settings.tun.mtu;
    }

    const udpTimeout = (settings.tun.udpTimeout || "").trim();
    if (udpTimeout) {
      tunInbound.udp_timeout = udpTimeout;
    }

    const excludes = (settings.tun.routeExcludeAddress || []).map((x) => x.trim()).filter(Boolean);
    if (excludes.length > 0) {
      tunInbound.route_exclude_address = excludes;
    }

    if (settings.tun.routeExcludeCn === true) {
      tunInbound.route_exclude_address_set = ["geoip-cn"];
    }

    const includes = (settings.tun.includeInterface || []).map((x) => x.trim()).filter(Boolean);
    if (includes.length > 0) {
      tunInbound.include_interface = includes;
    }

    if (idx >= 0) {
      inbounds[idx] = tunInbound;
    } else {
      inbounds.unshift(tunInbound);
    }
  }

  // Optional LAN mixed (HTTP + SOCKS5) inbound
  const mixedIdx = inbounds.findIndex((i) => i.tag === "mixed-in");
  if (settings.mixed?.enabled) {
    const udpTimeout = (settings.tun.udpTimeout || "").trim();
    const mixedInbound: Json = {
      type: "mixed",
      tag: "mixed-in",
      listen: settings.mixed.listenAddress.trim() || "::",
      listen_port: settings.mixed.listenPort,
      set_system_proxy: false,
      ...(udpTimeout ? { udp_timeout: udpTimeout } : {}),
    };
    if (mixedIdx >= 0) {
      inbounds[mixedIdx] = mixedInbound;
    } else {
      inbounds.push(mixedInbound);
    }
  } else if (mixedIdx >= 0) {
    inbounds.splice(mixedIdx, 1);
  }

  config.inbounds = inbounds;

  // Bind outbound WAN interface when explicitly configured (mutually exclusive with auto_detect_interface)
  const route = config.route as Json | undefined;
  if (route) {
    const defIface = (settings.tun.defaultInterface || "").trim();
    if (defIface) {
      route.default_interface = defIface;
      delete route.auto_detect_interface;
    }
  }
}
