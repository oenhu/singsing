import type { OpenWrtSettings } from "./types";

type Json = Record<string, unknown>;

/**
 * Adapt the `tun-in` inbound for OpenWrt (fw4 / nftables auto_redirect + native dns_mode).
 */
export function adaptTun(config: Json, settings: OpenWrtSettings): void {
  const inbounds = (config.inbounds as Json[]) ?? [];
  const idx = inbounds.findIndex((i) => i.tag === "tun-in" || i.type === "tun");

  if (!settings.tun.enabled) {
    if (idx >= 0) inbounds.splice(idx, 1);
    config.inbounds = inbounds;
    return;
  }

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

  const excludes = settings.tun.routeExcludeAddress.map((x) => x.trim()).filter(Boolean);
  if (excludes.length > 0) {
    tunInbound.route_exclude_address = excludes;
  }

  if (idx >= 0) {
    inbounds[idx] = tunInbound;
  } else {
    inbounds.unshift(tunInbound);
  }
  config.inbounds = inbounds;
}
