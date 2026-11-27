# singsing v0.1.3 发布修复记录（0.1.3-r2 候选）

singsing 通过 LuCI 配置 sing-box，复用 singbox-confgen 生成 JSON，并在 OpenWrt 上使用 sing-box 原生 Linux TUN 和 Auto Redirect。当前验证核心为 **sing-box 1.14.4**。

## 原始发布包 `0.1.3-r1`（`a5ddb08`）复现问题与 `0.1.3-r2` 修复

在官方 OpenWrt 24.10.8 / 25.12.6 QEMU VM 实测中，原始 `0.1.3-r1` 发布包复现了 4 项问题，现已在本地 `0.1.3-r2` 中修复并通过两套官方 VM 与 LibWrt 真机验收：

1. **有效 DNS 误判导致无法启动（发布阻塞）**：`service-manager.sh` 的 `check_local_dns` 命令入口原将缺省参数展开为 3 个空字符串，导致跳过 UCI 读取并拒绝启动；已改为保留调用者实际参数数量并兼容零参数读 UCI 与显式传参两条路径，补齐非 stub 命令入口回归测试。
2. **OpenWrt 24.10 `.ipk` 归档带有 `1001:1001` 属主（发布阻塞）**：`.github/workflows/build.yml` 直接子目录执行 `make -C package/luci-app-singsing` 时未导出 `STAGING_DIR_HOST`/`PATH`/`TAR`，使 24.10 SDK `ipkg-build` 回退调用宿主机 `/usr/bin/tar` 绕过 `fakeroot`；已修复构建环境并添加 `--no-owner --no-group`，并在 `scripts/verify-openwrt-package.sh` 增加发布前 IPK/APK `0:0`（`root:root`）属主强制校验。
3. **首次开启规则集定时更新时 `crond` 未运行（运行集成）**：干净 OpenWrt 系统在无 crontab 任务时 `crond` 不会启动；已复用 OpenWrt 原生 `/etc/init.d/cron` 与 `ubus` 服务状态检测，在首次写入 `# singsing-ruleset` 且 `crond` 未运行时自动启用并拉起 `crond`（已运行时仅触发 `cron.update`，不重复重启）。
4. **卸载后 `luci.singsing` 仍残留在 `ubus`（运行集成）**：新增 `Package/$(PKG_NAME)/postrm`（25.12 APK 映射为 `post-deinstall`，仅卸载触发、升级不误触），清理 LuCI 缓存并执行 `/etc/init.d/rpcd reload`，卸载后 `luci.singsing` 立即注销且用户配置文件保留。

## 版本更新内容

- **原生内核级 Pre-Match Bypass 与大陆绕过**：在 `auto_redirect` 模式下，于 `{ action: "sniff" }` 前生成原生 `action: "bypass"`（带 TUN 源 IP 与 53 端口保护），覆盖中国大陆域名/IP、私网、直连列表、设备黑/白名单、非代理端口及 `Direct` 模式，同时完整保留 4 模式 Clash API 热切换；并可选路由表级 `route_exclude_address_set: ["geoip-cn"]`。
- **修复访问控制优先级与 OpenWrt IPv6 PD 适配**：设备黑/白名单及指定出口规则调整至用户自定义域名规则之前，并自动开启原生 `route.find_neighbor: true`；新增路由器直连 IPv6 策略（`direct` / `auto` / `ipv4_only`，默认 `direct` 适配 PPPoE/IPv6 PD）与可选代理侧 IPv6 开关。
- **路由器流量边界与运行时加固**：支持常用/自定义目的端口过滤（绕过 BT/PT/P2P 高端口）、仅针对代理流量的 QUIC（UDP 443）拒断、`geosite-cn` 国内规则集映射与新配置默认 `Non-CN`（不预置 `.srs` 文件）、OpenWrt `crond` 规则集定时更新（首次自动拉起 `crond`）、TUN 默认 `strict_route=0`/`mtu=9000`、`include_interface`/`default_interface`/`udp_timeout`、Linux 6.6 `QUIC_GO_DISABLE_GSO=true`、`nofile=1000000` 及 `wan` 接口 `up` 自动重载。
- **可选 `mixed-in`、直连 DNS 容灾与 Tailscale Exit Node 闭环**：新增可选局域网 HTTP/SOCKS5 `mixed-in` 入站；支持 DoT/DoH 域名 + 引导解析 IP、备用直连 DNS、`Non-CN` 远程 `SERVFAIL`/`REFUSED` 安全回落 `local` 与 `wan_dns` 探测；为 `advertise_exit_node: true` 的 Tailscale 端点自动补齐入站 53 端口 `hijack-dns` 与私网/通告子网直连放行。
- 运行概览支持「先生成校验配置，再独立开关启用服务」：新增 `write_config` RPC 与 `service-manager.sh write_config`，未启用状态下也可离线校验并原子写入 `/etc/singsing/sing-box.json`（不启动 `sing-box`、不接管 `dnsmasq`）；首页提供内联「启用服务」开关与动态「生成配置 / 生成并应用」按钮，首次无配置或坏配置启动失败时自动回滚启用状态。
- LuCI 节点（支持上游多格式静态导入）、DNS、分流（Direct / Proxy / Reject）、设备访问控制与 Tailscale/Headscale 配置的保存、重读与应用；保留 `+kmod-nft-queue` 依赖，不预置 `.srs` 规则集。

## 候选安装包与验收状态（`0.1.3-r2`，尚未推送发布）

| 附件 | SHA-256 | SDK 与静态校验 | 运行验证 |
| --- | --- | --- | --- |
| `luci-app-singsing_0.1.3-r2_all.ipk` | `ba5452deb7bbeb27445460d0139986cf69da4f90793494078cb642bbc65da092` | OpenWrt 24.10.8 正式 SDK（UID 1001 环境），`verify-openwrt-package.sh` 全项及 `data/control` `0/0` 属主通过 | 官方 OpenWrt 24.10.8 (`r29233-443ec4032a`, kernel `6.6.144`) QEMU VM 全链路、cron 实触发、重启自启、卸载清 `ubus`、`0:0` 目录属主与 `0.1.1-r1 → 0.1.3-r2` 升级均通过 |
| `luci-app-singsing-0.1.3-r2.apk` | `177abd1e6d30a4d2f6f4594872cb33241fbdddce49c5a73ad628deac5fa67272` | OpenWrt 25.12.6 正式 SDK，`verify-openwrt-package.sh` 全项及 `root:root` 属主通过 | 官方 OpenWrt 25.12.6 (`r33311-981c978eff`, kernel `6.12.112`) QEMU VM 与 LibWrt 25.12-SNAPSHOT (`r0-96a0ec8`, kernel `6.12.112`) 真机验收均通过 |

## 已知限制与待维护者确认事项

- **规则优先级语义（待维护者确认）**：实机流量已确认，当前生成的规则中，设备指定代理（`deviceRules`）与用户显式路由规则（`s.rules`）均排在目的端口过滤（`port_mode=common/custom`）与 `block_quic`（UDP 443 拒断）之前，因此命中设备指定代理或显式代理规则的流量不受端口过滤和 `block_quic` 限制。详细实测矩阵与最小调整方案见 [验收记录](rc1-validation.md)，待维护者决定后再确认是否变更语义或仅补充 LuCI 文案。
- **非标准 WAN 逻辑接口名（真机观察）**：`init.d/singsing` 的 `procd_add_interface_trigger` 与 `singsing.uc` 的 `wan_dns` 目前按小写 `wan`/`wan6` 监听；在逻辑接口命名为大写 `WAN`/`WAN_6` 的固件（如本次测试的 LibWrt）上，`ifup WAN` 不会自动触发 `reload_if_running` 且 `wan_dns` 为空（手动 `service-manager.sh reload_if_running` 正常生效）。后续可复用 OpenWrt `/lib/functions/network.sh` 的 `network_find_wan` 适配自定义 WAN 接口名。
- **测速端点协议要求**：`sing-box 1.14.4` 会将 Clash delay API 的 `http://` 目标替换为默认 HTTPS 端点；使用本地可信 HTTPS 端点后，原生单节点与代理组测速均返回真实延迟。
- **从 `0.1.1-r1` 升级行为**：保留旧 `dns.local_server`、运行 JSON 与 `tun.strict_route=1`，补齐 `mixed`/`routing` 段，`tun.ipv6_mode` 与 `tun.mtu` 在旧 UCI 保持未设置并在下次生成时默认生效为 `direct` 与 `9000`。
- 活动 JSON 本身损坏时，服务拒绝启动并回滚 `main.enabled=0`，可按 [README](../README.md#故障恢复) 从有效备份恢复。
- 下载规则集失败的诊断可能包含完整 URL（按既有维护者决定保留，外发前请移除凭据）。

安装、升级、卸载说明见 [README](../README.md#安装升级和卸载v013--013-r2-修复候选)，详细验证见 [验收记录](rc1-validation.md)。
