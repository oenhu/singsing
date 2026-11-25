import { validate as validateUpstream, type Issue } from "../upstream/generate";
import type { Profile } from "../upstream/types";
import { parseClientEntries } from "./access";
import type { DirectDnsType, OpenWrtSettings } from "./types";

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const DIRECT_DNS_TYPES: readonly DirectDnsType[] = ["udp", "tcp", "tls", "https"];
const IFACE_RE = /^[a-zA-Z0-9_-]{1,15}$/;
const OPENWRT_RESERVED_TAGS = ["dns-in"];

export function isValidIpv4(ip: string): boolean {
  return IPV4_RE.test(ip);
}

export function isValidIpv6(ip: string): boolean {
  if (!ip.includes(":") || !/^[0-9a-fA-F:]+$/.test(ip)) return false;
  if (ip.split("::").length > 2) return false;
  const parts = ip.split(":").filter((p) => p.length > 0);
  if (parts.some((p) => p.length > 4)) return false;
  if (!ip.includes("::") && ip.split(":").length !== 8) return false;
  return true;
}

export function isValidIp(ip: string): boolean {
  return isValidIpv4(ip) || isValidIpv6(ip);
}

export function isValidCidr(cidr: string, version: 4 | 6): boolean {
  const parts = cidr.split("/");
  if (parts.length !== 2) return false;
  const [addr, prefix] = parts;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const len = Number(prefix);
  if (version === 4) return isValidIpv4(addr) && len >= 0 && len <= 32;
  return isValidIpv6(addr) && len >= 0 && len <= 128;
}

export function isLoopbackOrUnspecified(ip: string): boolean {
  const lower = ip.trim().toLowerCase();
  if (lower === "0.0.0.0" || lower === "::" || lower === "::1") return true;
  if (lower.startsWith("127.")) return true;
  if (/^0+:0*:0*:0*:0*:0*:0*:0*1$/.test(lower)) return true;
  return false;
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/** Validate OpenWrt-specific settings (mandatory direct DNS, loop detection, TUN, paths). */
export function validateOpenWrtSettings(settings: OpenWrtSettings): Issue[] {
  const issues: Issue[] = [];
  const err = (detail: string) =>
    issues.push({ level: "error", detail, message: `OpenWrt 设置：${detail}`, section: "settings" });
  const warn = (detail: string) =>
    issues.push({ level: "warning", detail, message: `OpenWrt 设置：${detail}`, section: "settings" });

  const { dns, tun, paths } = settings;

  if (!DIRECT_DNS_TYPES.includes(dns.localType)) {
    err(`直连上游 DNS 协议必须是 ${DIRECT_DNS_TYPES.join(" / ")} 之一`);
  }

  const server = dns.localServer.trim();
  if (!server) {
    err("必须手动填写直连上游 DNS 地址（如 223.5.5.5、119.29.29.29 等），未填写禁止应用与启动");
  } else if (!isValidIp(server)) {
    err(`直连上游 DNS「${server}」必须是有效的 IPv4 或 IPv6 地址（不可填域名，避免引导解析循环）`);
  } else if (isLoopbackOrUnspecified(server)) {
    err(`直连上游 DNS 不能设为本地回环或未指定地址（${server}），否则会导致 DNS 循环`);
  } else if (settings.routerLanIps?.some((lanIp) => lanIp.trim().toLowerCase() === server.toLowerCase())) {
    err(`直连上游 DNS 不能设为路由器自身地址（${server}），否则会导致 dnsmasq 与 sing-box 循环`);
  }

  if (!isValidPort(dns.localPort)) {
    err(`直连上游 DNS 端口无效：${dns.localPort}`);
  }
  if ((dns.localType === "tls" || dns.localType === "https") && !dns.localServerName.trim()) {
    warn(`使用 ${dns.localType.toUpperCase()} 加密直连 DNS 时建议填写 TLS Server Name（SNI）`);
  }

  if (!isValidIp(dns.listenAddress.trim())) {
    err(`sing-box DNS 监听地址无效：${dns.listenAddress}`);
  }
  if (!isValidPort(dns.listenPort)) {
    err(`sing-box DNS 监听端口无效：${dns.listenPort}`);
  }
  if (dns.dnsmasqManage && dns.listenPort === 53 && isLoopbackOrUnspecified(dns.listenAddress)) {
    err("启用 dnsmasq 接管时，sing-box DNS 监听端口不能为 53（会与 dnsmasq 冲突）");
  }

  if (tun.enabled) {
    if (!IFACE_RE.test(tun.interfaceName)) {
      err(`TUN 接口名称「${tun.interfaceName}」无效（仅支持 1-15 位字母、数字、-、_）`);
    }
    if (!isValidCidr(tun.addressV4.trim(), 4)) {
      err(`TUN IPv4 网段格式无效：${tun.addressV4}`);
    }
    if (tun.ipv6 && !isValidCidr(tun.addressV6.trim(), 6)) {
      err(`TUN IPv6 网段格式无效：${tun.addressV6}`);
    }
    if (tun.mtu !== null && (!Number.isInteger(tun.mtu) || tun.mtu < 576 || tun.mtu > 65535)) {
      err(`TUN MTU 必须是 576-65535 之间的整数`);
    }
    if (tun.autoRedirect && !tun.autoRoute) {
      err("开启 Auto Redirect 时必须同时开启 Auto Route（sing-box 原生要求）");
    }
  }

  if (!paths.cacheFile.trim().startsWith("/")) {
    err(`缓存文件路径必须是绝对路径：${paths.cacheFile}`);
  }
  if (!paths.ruleSetDir.trim().startsWith("/")) {
    err(`规则集本地目录必须是绝对路径：${paths.ruleSetDir}`);
  }
  if (!paths.tailscaleStateRoot.trim().startsWith("/")) {
    err(`Tailscale 状态根目录必须是绝对路径：${paths.tailscaleStateRoot}`);
  }

  if (settings.accessControl) {
    const ac = settings.accessControl;
    const listCheck = parseClientEntries(ac.clients || []);
    if (listCheck.invalid.length > 0) {
      err(`访问控制设备列表格式无效（支持 IPv4/IPv6/CIDR/MAC）：${listCheck.invalid.join("、")}`);
    }
    if (ac.mode === "allowlist" && listCheck.cidrs.length === 0 && listCheck.macs.length === 0) {
      warn("访问控制处于「仅指定设备代理」模式但列表为空，所有局域网设备将直连");
    }
    for (const dr of ac.deviceRules || []) {
      const dc = parseClientEntries(dr.clients || []);
      if (dc.invalid.length > 0) {
        err(`设备分流规则「${dr.name || "未命名"}」地址无效：${dc.invalid.join("、")}`);
      }
    }
  }

  return issues;
}

/** Combined validation for Profile (upstream rules) + OpenWrt settings + reserved OpenWrt tags. */
export function validateOpenWrt(profile: Profile, settings: OpenWrtSettings): Issue[] {
  const issues: Issue[] = [...validateUpstream(profile), ...validateOpenWrtSettings(settings)];

  for (const reserved of OPENWRT_RESERVED_TAGS) {
    for (const n of profile.nodes) {
      if (n.tag === reserved) {
        issues.push({
          level: "error",
          section: "nodes",
          id: n.id,
          detail: `标签 ${reserved} 为 OpenWrt 适配层保留，请换一个`,
          message: `节点「${n.tag}」：标签 ${reserved} 为 OpenWrt 适配层保留，请换一个`,
        });
      }
    }
    for (const g of profile.groups) {
      if (g.tag === reserved) {
        issues.push({
          level: "error",
          section: "groups",
          id: g.id,
          detail: `标签 ${reserved} 为 OpenWrt 适配层保留，请换一个`,
          message: `代理组「${g.tag}」：标签 ${reserved} 为 OpenWrt 适配层保留，请换一个`,
        });
      }
    }
  }

  return issues;
}
