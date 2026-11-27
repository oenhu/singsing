# singsing v0.1.3 发布修复记录（0.1.3-r3 候选）

singsing 通过 LuCI 配置 sing-box，复用 singbox-confgen 生成 JSON，并在 OpenWrt 上使用 sing-box 原生 Linux TUN 和 Auto Redirect。当前验证核心为 **sing-box 1.14.4**。

## 原始发布包 `0.1.3-r1`（`a5ddb08`）复现问题与 `0.1.3-r2` / `0.1.3-r3` 修复

在官方 OpenWrt 24.10.8 / 25.12.6 QEMU VM 与真机实测中，原始 `0.1.3-r1` 复现的 4 项问题以及 `0.1.3-r2` 真机观察项已全部修复并通过两套官方 VM 与 LibWrt 真机验收：

1. **有效 DNS 误判导致无法启动（发布阻塞）**：`service-manager.sh` 的 `check_local_dns` 命令入口原将缺省参数展开为 3 个空字符串，导致跳过 UCI 读取并拒绝启动；已改为保留调用者实际参数数量并兼容零参数读 UCI 与显式传参两条路径，补齐非 stub 命令入口回归测试。
2. **OpenWrt 24.10 `.ipk` 归档带有 `1001:1001` 属主（发布阻塞）**：`.github/workflows/build.yml` 直接子目录执行 `make -C package/luci-app-singsing` 时未导出 `STAGING_DIR_HOST`/`PATH`/`TAR`，使 24.10 SDK `ipkg-build` 回退调用宿主机 `/usr/bin/tar` 绕过 `fakeroot`；已修复构建环境并添加 `--no-owner --no-group`，并在 `scripts/verify-openwrt-package.sh` 增加发布前 IPK/APK `0:0`（`root:root`）属主强制校验。
3. **规则集定时更新尊重系统 `cron` 设置（运行集成）**：复用 OpenWrt 原生 `/etc/init.d/cron` 状态检测——仅当系统 `cron` 已启用开机自启但尚未运行（干净系统首次写入 crontab）时拉起 `crond`；若用户明确关闭了系统 `cron` 开机自启，则保留计划条目并记录等待日志，不强行改写系统 `cron` 启停策略。
4. **卸载后 `luci.singsing` 仍残留在 `ubus`（运行集成）**：新增 `Package/$(PKG_NAME)/postrm`（25.12 APK 映射为 `post-deinstall`，仅卸载触发、升级不误触），清理 LuCI 缓存并执行 `/etc/init.d/rpcd reload`，卸载后 `luci.singsing` 立即注销且用户配置文件保留。
5. **动态 WAN 接口检测与热插拔（`0.1.3-r3`）**：移除 `init.d/singsing` 硬编码小写 `wan` trigger，改由 `/etc/hotplug.d/iface/95-singsing` + OpenWrt 原生 `network_find_wan`/`network_find_wan6` 适配任意逻辑 WAN 名称（如 `wan`、`WAN`、`WAN_6`、`fiber_main`），同时响应 `ifup` 及带 `IFUPDATE_ADDRESSES=1`/`IFUPDATE_PREFIXES=1` 的 `ifupdate`（忽略无变更常规续租），并统一用于 `wan_dns` 探测。
6. **Tailscale Exit Node 通告子网放行规则修复（`0.1.3-r3`）**：当同时启用 `advertise_exit_node: true` 与 `advertise_routes` 时，改用原生逻辑 `and([inbound, or([ip_is_private, ip_cidr])])` 放行局域网与通告子网（避免原单对象 AND 误阻断非私网通告子网或非通告私网），并在 `exit_node_allow_lan_access: false` 时仍独立放行通告子网。

## 版本更新内容

- **原生内核级 Pre-Match Bypass 与大陆绕过**：在 `auto_redirect` 模式下，于 `{ action: "sniff" }` 前生成原生 `action: "bypass"`（带 TUN 源 IP 与 53 端口保护），覆盖中国大陆域名/IP、私网、直连列表、设备黑/白名单、非代理端口及 `Direct` 模式，同时完整保留 4 模式 Clash API 热切换；并可选路由表级 `route_exclude_address_set: ["geoip-cn"]`。
- **修复访问控制优先级与 OpenWrt IPv6 PD 适配**：设备黑/白名单及指定出口规则调整至用户自定义域名规则之前，并自动开启原生 `route.find_neighbor: true`；新增路由器直连 IPv6 策略（`direct` / `auto` / `ipv4_only`，默认 `direct` 适配 PPPoE/IPv6 PD）与可选代理侧 IPv6 开关。
- **路由器流量边界与运行时加固**：支持常用/自定义目的端口过滤（绕过 BT/PT/P2P 高端口）、仅针对代理流量的 QUIC（UDP 443）拒断、`geosite-cn` 国内规则集映射与新配置默认 `Non-CN`（不预置 `.srs` 文件）、OpenWrt `crond` 规则集定时更新（首次自动拉起 `crond`）、TUN 默认 `strict_route=0`/`mtu=9000`、`include_interface`/`default_interface`/`udp_timeout`、Linux 6.6 `QUIC_GO_DISABLE_GSO=true`、`nofile=1000000` 及 `wan` 接口 `up` 自动重载。
- **可选 `mixed-in`、直连 DNS 容灾与 Tailscale Exit Node 闭环**：新增可选局域网 HTTP/SOCKS5 `mixed-in` 入站；支持 DoT/DoH 域名 + 引导解析 IP、备用直连 DNS、`Non-CN` 远程 `SERVFAIL`/`REFUSED` 安全回落 `local` 与 `wan_dns` 探测；为 `advertise_exit_node: true` 的 Tailscale 端点自动补齐入站 53 端口 `hijack-dns` 与私网/通告子网直连放行。
- 运行概览支持「先生成校验配置，再独立开关启用服务」：新增 `write_config` RPC 与 `service-manager.sh write_config`，未启用状态下也可离线校验并原子写入 `/etc/singsing/sing-box.json`（不启动 `sing-box`、不接管 `dnsmasq`）；首页提供内联「启用服务」开关与动态「生成配置 / 生成并应用」按钮，首次无配置或坏配置启动失败时自动回滚启用状态。
- LuCI 节点（支持上游多格式静态导入）、DNS、分流（Direct / Proxy / Reject）、设备访问控制与 Tailscale/Headscale 配置的保存、重读与应用；保留 `+kmod-nft-queue` 依赖，不预置 `.srs` 规则集。

## 候选安装包与验收状态（`0.1.3-r3`）

| 附件 | SHA-256 | SDK 与静态校验 | 运行验证 |
| --- | --- | --- | --- |
| `luci-app-singsing_0.1.3-r3_all.ipk` | `199ebc7f6b321e6ba0e3a6c91b8c20c16c15341df4079bb2da9172e2a0ace87d` | OpenWrt 24.10.8 正式 SDK，`verify-openwrt-package.sh` 全项及 `data/control` `0/0` 属主通过 | 官方 OpenWrt 24.10.8 (`r29233-443ec4032a`, kernel `6.6.144`) QEMU VM 全链路、cron 实触发与禁用尊重、动态 WAN 热插拔、重启自启、卸载清 `ubus` 与升级均通过 |
| `luci-app-singsing-0.1.3-r3.apk` | `9f40c9e2b6557efe54593ac0df3879b572f2efc992b2599361385e45116c0c24` | OpenWrt 25.12.6 正式 SDK，`verify-openwrt-package.sh` 全项及 `root:root` 属主通过 | 官方 OpenWrt 25.12.6 (`r33311-981c978eff`, kernel `6.12.112`) QEMU VM 与 LibWrt 25.12-SNAPSHOT 真机（含大写 `WAN`/`WAN_6` 真实 PPPoE 重拨、运营商 IPv6 PD 续租、`ifupdate` 热插拔与 `cron` 禁用尊重）均通过 |

## 已知说明与限制

- **规则优先级语义（已在 LuCI 界面明确说明）**：设备指定代理（`deviceRules`）与用户显式路由规则（`s.rules`）排在目的端口过滤（`port_mode=common/custom`）与 `block_quic`（UDP 443 拒断）之前，端口过滤与 QUIC 拒断仅作用于默认分流走代理的流量。
- **测速端点协议要求**：`sing-box 1.14.4` 会将 Clash delay API 的 `http://` 目标替换为默认 HTTPS 端点；使用本地可信 HTTPS 端点后，原生单节点与代理组测速均返回真实延迟。
- **从 `0.1.1-r1` 升级行为**：保留旧 `dns.local_server`、运行 JSON 与 `tun.strict_route=1`，补齐 `mixed`/`routing` 段，`tun.ipv6_mode` 与 `tun.mtu` 在旧 UCI 保持未设置并在下次生成时默认生效为 `direct` 与 `9000`。
- 活动 JSON 本身损坏时，服务拒绝启动并回滚 `main.enabled=0`，可按 [README](../README.md#故障恢复) 从有效备份恢复。
- 下载规则集失败的诊断可能包含完整 URL（按既有维护者决定保留，外发前请移除凭据）。

安装、升级、卸载说明见 [README](../README.md#安装升级和卸载v013--013-r3-修复候选)，详细验证见 [验收记录](rc1-validation.md)。
