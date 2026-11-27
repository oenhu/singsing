# singsing v0.1.3（0.1.3-r1）

singsing 通过 LuCI 配置 sing-box，复用 singbox-confgen 生成 JSON，并在 OpenWrt 上使用 sing-box 原生 Linux TUN 和 Auto Redirect。本正式版本的验证核心为 **sing-box 1.14.4**。

## 版本更新内容

- **原生内核级 Pre-Match Bypass 与大陆绕过**：在 `auto_redirect` 模式下，于 `{ action: "sniff" }` 前生成原生 `action: "bypass"`（带 TUN 源 IP 与 53 端口保护），覆盖中国大陆域名/IP、私网、直连列表、设备黑/白名单、非代理端口及 `Direct` 模式，同时完整保留 4 模式 Clash API 热切换；并可选路由表级 `route_exclude_address_set: ["geoip-cn"]`。
- **修复访问控制优先级与 OpenWrt IPv6 PD 适配**：设备黑/白名单及指定出口规则调整至用户自定义域名规则之前，并自动开启原生 `route.find_neighbor: true`；新增路由器直连 IPv6 策略（`direct` / `auto` / `ipv4_only`，默认 `direct` 适配 PPPoE/IPv6 PD）与可选代理侧 IPv6 开关。
- **路由器流量边界与运行时加固**：支持常用/自定义目的端口过滤（绕过 BT/PT/P2P 高端口）、仅针对代理流量的 QUIC（UDP 443）拒断、`geosite-cn` 国内规则集映射与新配置默认 `Non-CN`（不预置 `.srs` 文件）、OpenWrt `crond` 规则集定时更新、TUN 默认 `strict_route=0`/`mtu=9000`、`include_interface`/`default_interface`/`udp_timeout`、Linux 6.6 `QUIC_GO_DISABLE_GSO=true`、`nofile=1000000` 及 `wan` 接口 `up` 自动重载。
- **可选 `mixed-in`、直连 DNS 容灾与 Tailscale Exit Node 闭环**：新增可选局域网 HTTP/SOCKS5 `mixed-in` 入站；支持 DoT/DoH 域名 + 引导解析 IP、备用直连 DNS、`Non-CN` 远程 `SERVFAIL`/`REFUSED` 安全回落 `local` 与 `wan_dns` 探测；为 `advertise_exit_node: true` 的 Tailscale 端点自动补齐入站 53 端口 `hijack-dns` 与私网/通告子网直连放行。
- 运行概览支持「先生成校验配置，再独立开关启用服务」：新增 `write_config` RPC 与 `service-manager.sh write_config`，未启用状态下也可离线校验并原子写入 `/etc/singsing/sing-box.json`（不启动 `sing-box`、不接管 `dnsmasq`）；首页提供内联「启用服务」开关与动态「生成配置 / 生成并应用」按钮，首次无配置直接启动失败时自动回滚启用状态。
- LuCI 节点（支持上游多格式静态导入）、DNS、分流（Direct / Proxy / Reject）、设备访问控制与 Tailscale/Headscale 配置的保存、重读与应用。
- 移除内置订阅管理与后台 `ucode` 订阅更新器（`subscription-updater.uc` / `subscriptions.js` / cron 同步），升级时 `99-singsing` 自动清理遗留 `# singsing-sub` cron 条目；保留 `+kmod-nft-queue` 依赖。
- 修复 OpenWrt 24.10.8 `ucode-mod-fs` 不导出 `mkdtemp` 导致 `rpcd` 无法加载 `luci.singsing` 的兼容性问题（改为 `mktemp -d`）。
- 补齐 Tailscale `exit_node` 与 `advertise_exit_node` 互斥前置校验，并调整 DNS 规则顺序使单标签 MagicDNS 主机名优先于 `^[^.]+$` `NXDOMAIN` 解析（同时保留 `.lan`/`.home.arpa` 最优先保护）。
- 收敛访问控制边界（`get_access_control` 失败显式阻断生成、`all` 模式保存与应用一致忽略未启用旧列表），并在服务应用事务中增加 TUN 接口就绪检查与成功后原子刷新 `sing-box.last-good.json`。

## 下载与验证范围

| 附件 | SDK 验证 | 运行验证 |
| --- | --- | --- |
| `luci-app-singsing_0.1.3-r1_all.ipk` | OpenWrt 24.10.8 正式 SDK，包检查通过 | 官方 OpenWrt 24.10.8 `armsr/armv8` QEMU VM 安装/运行/卸载全链路通过 |
| `luci-app-singsing-0.1.3-r1.apk` | OpenWrt 25.12.6 正式 SDK，包检查通过 | 官方 OpenWrt 25.12.6 `armsr/armv8` QEMU VM 与 LibWrt 25.12-SNAPSHOT 真机均通过 |
| `SHA256SUMS` | 两个安装包的 SHA-256 | 下载后校验 |

LibWrt 真机完成了 r3 → r4 升级、Clash API（204 模式与代理切换、分组测速、连接管理、安全拦截）、300KB 分片离线上传、多 Profile、Non-CN 模式、整机重启、开机自启、SysRq 硬复位断电恢复、IPv6 双栈、专用 Headscale 联调及卸载恢复验证。

## 已知限制

- 卸载 APK 后，rpcd 可能保留旧方法注册（维护者已标为「不处理」，不作为发布门槛）。卸载后可执行 `/etc/init.d/rpcd reload`，完整步骤见 [README](../README.md#卸载)。
- 活动 JSON 本身损坏时，服务拒绝启动，可按 [README](../README.md#故障恢复) 从有效备份恢复。
- 首次下载规则集依赖设备能够访问对应地址。公开规则集不可达时，可通过规则集管理页离线上传 `.srs` / `.json`。
- 下载规则集失败的诊断可能包含完整 URL（维护者已标为「不处理」，保留现有诊断行为）。外发诊断前请移除 URL 凭据。
- 默认策略对已配置走代理的域名抑制 AAAA（可在代理 DNS 设置中按需放开）。显式 IPv6 代理路由已在真机验证。
- 专用 Headscale 真机联调、SysRq 硬复位模拟断电恢复及官方 OpenWrt 24.10.8 / 25.12.6 VM 运行验证均已通过（详见 README 与 [RC1 真机验收](rc1-validation.md)）；官方 Tailscale 控制面按维护者决定不考虑。

安装、升级、卸载说明见 [README](../README.md#安装升级和卸载v013)，详细验证见 [RC1 真机验收](rc1-validation.md)。

本版本作为正式版 **v0.1.3** 发布，附件由 GitHub Actions 自动构建并提供经校验的 `.ipk` / `.apk` 安装包与 `SHA256SUMS`。
