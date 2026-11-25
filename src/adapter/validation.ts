import { nodeObject, tailnetEndpoint, usableGroups, validate as validateUpstream, type Issue } from "../upstream/generate";
import type { Profile } from "../upstream/types";
import { parseClientEntries } from "./access";
import type { DirectDnsType, OpenWrtSettings } from "./types";

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const DIRECT_DNS_TYPES: readonly DirectDnsType[] = ["udp", "tcp", "tls", "https"];
const IFACE_RE = /^[a-zA-Z0-9_-]{1,15}$/;
const OPENWRT_RESERVED_TAGS = ["dns-in"];

export function isValidIpv4(ip: string): boolean {
  return IPV4_RE.test(ip.trim());
}

/**
 * Parse and expand an IPv6 address (including compressed `::` and IPv4-mapped `::ffff:a.b.c.d`)
 * into 8 16-bit words, or return null if invalid.
 */
export function expandIpv6(raw: string): number[] | null {
  let ip = raw.trim();
  if (!ip.includes(":")) return null;
  if ((ip.startsWith(":") && !ip.startsWith("::")) || (ip.endsWith(":") && !ip.endsWith("::"))) {
    return null;
  }

  // Handle IPv4-mapped / embedded trailing dotted quad (e.g. ::ffff:127.0.0.1)
  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!IPV4_RE.test(tail)) return null;
    const octets = tail.split(".").map(Number);
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = ip.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (seg: string): number[] | null => {
    if (!seg) return [];
    const parts = seg.split(":");
    const nums: number[] = [];
    for (const p of parts) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
      nums.push(parseInt(p, 16));
    }
    return nums;
  };

  const left = parseGroups(halves[0]);
  if (!left) return null;

  if (halves.length === 2) {
    const right = parseGroups(halves[1]);
    if (!right) return null;
    if (left.length + right.length > 7) return null;
    const zeros = new Array<number>(8 - left.length - right.length).fill(0);
    return [...left, ...zeros, ...right];
  }

  return left.length === 8 ? left : null;
}

export function isValidIpv6(ip: string): boolean {
  return expandIpv6(ip) !== null;
}

export function isValidIp(ip: string): boolean {
  return isValidIpv4(ip) || isValidIpv6(ip);
}

export function isValidCidr(cidr: string, version: 4 | 6): boolean {
  const parts = cidr.trim().split("/");
  if (parts.length !== 2) return false;
  const [addr, prefix] = parts;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const len = Number(prefix);
  if (version === 4) return isValidIpv4(addr) && len >= 0 && len <= 32;
  return isValidIpv6(addr) && len >= 0 && len <= 128;
}

export function isLoopbackOrUnspecified(ip: string): boolean {
  const trimmed = ip.trim().toLowerCase();
  if (isValidIpv4(trimmed)) {
    return trimmed === "0.0.0.0" || trimmed.startsWith("127.");
  }
  const v6 = expandIpv6(trimmed);
  if (!v6) return false;
  const first5Zero = v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0;
  // :: (unspecified) or ::1 (loopback)
  if (first5Zero && v6[5] === 0 && v6[6] === 0 && (v6[7] === 0 || v6[7] === 1)) {
    return true;
  }
  // ::ffff:0.0.0.0 or ::ffff:127.0.0.0/8
  if (first5Zero && v6[5] === 0xffff) {
    if (v6[6] === 0 && v6[7] === 0) return true;
    if ((v6[6] >> 8) === 127) return true;
  }
  return false;
}

function sameIp(a: string, b: string): boolean {
  const ta = a.trim();
  const tb = b.trim();
  if (isValidIpv4(ta) && isValidIpv4(tb)) return ta === tb;
  const va = expandIpv6(ta);
  const vb = expandIpv6(tb);
  if (va && vb) return va.every((w, idx) => w === vb[idx]);
  return ta.toLowerCase() === tb.toLowerCase();
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
  } else if (settings.routerLanIps?.some((lanIp) => sameIp(lanIp, server))) {
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
    for (const t of profile.settings.tailnets) {
      if (t.tag === reserved) {
        issues.push({
          level: "error",
          section: "tailscale",
          id: t.id,
          detail: `标签 ${reserved} 为 OpenWrt 适配层保留，请换一个`,
          message: `Tailscale「${t.tag}」：标签 ${reserved} 为 OpenWrt 适配层保留，请换一个`,
        });
      }
    }
  }

  // Validate Tailscale state_directory path traversal & post-normalization collisions
  const tsRoot = settings.paths.tailscaleStateRoot.trim().replace(/\/+$/, "");
  const resolvedStateDirs = new Map<string, string>();
  for (const t of profile.settings.tailnets) {
    const { endpoint } = tailnetEndpoint(t);
    if (!endpoint) continue;
    const rawDir = typeof endpoint.state_directory === "string" ? endpoint.state_directory.trim() : "tailscale";
    if (rawDir.split("/").includes("..")) {
      issues.push({
        level: "error",
        section: "tailscale",
        id: t.id,
        detail: `state_directory「${rawDir}」不能包含上级目录 ..`,
        message: `Tailscale「${t.tag}」：state_directory「${rawDir}」不能包含上级目录 ..`,
      });
      continue;
    }
    const fullDir = rawDir.startsWith("/") ? rawDir.replace(/\/+$/, "") : `${tsRoot}/${rawDir.replace(/^\/+/, "") || t.tag || "tailscale"}`;
    const prev = resolvedStateDirs.get(fullDir);
    if (prev && rawDir !== prev) {
      issues.push({
        level: "error",
        section: "tailscale",
        id: t.id,
        detail: `状态目录解析后为「${fullDir}」，与另一 Tailnet 冲突`,
        message: `Tailscale「${t.tag}」：状态目录解析后为「${fullDir}」，与另一 Tailnet 冲突`,
      });
    }
    resolvedStateDirs.set(fullDir, rawDir);
  }

  // Validate per-device access control outbound targets exist in generated config
  if (settings.accessControl?.deviceRules?.length) {
    const validTargets = new Set<string>(["direct", "proxy"]);
    const outboundIds = new Set<string>();
    let hasGroupedNode = false;
    for (const n of profile.nodes) {
      if (!nodeObject(n).error) {
        validTargets.add(n.tag);
        outboundIds.add(n.id);
        if (n.inGroups) hasGroupedNode = true;
      }
    }
    if (hasGroupedNode) validTargets.add("auto");
    for (const t of profile.settings.tailnets) {
      if (tailnetEndpoint(t).endpoint) {
        validTargets.add(t.tag);
        outboundIds.add(t.id);
      }
    }
    const usable = usableGroups(profile.groups, outboundIds);
    for (const g of profile.groups) {
      if (usable.has(g.id)) validTargets.add(g.tag);
    }

    for (const dr of settings.accessControl.deviceRules) {
      if (dr.enabled === false) continue;
      const out = (dr.outbound || "").trim();
      if (!out || !validTargets.has(out)) {
        issues.push({
          level: "error",
          section: "routing",
          id: dr.id,
          detail: `设备分流规则「${dr.name || "未命名"}」指定的出口「${out || "(空)"}」不存在或为空`,
          message: `客户端访问控制：设备分流规则「${dr.name || "未命名"}」指定的出口「${out || "(空)"}」不存在或为空`,
        });
      }
    }
  }

  return issues;
}
