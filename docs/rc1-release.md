# singsing RC1 · 0.1.0-r4

singsing 通过 LuCI 配置 sing-box，复用 singbox-confgen 生成 JSON，并在 OpenWrt 上使用 sing-box 原生 Linux TUN 和 Auto Redirect。本候选版本的验证核心为 **sing-box 1.14.4**。

## 候选内容（r4 更新）

- LuCI 节点（支持上游多格式静态导入）、DNS、分流（Direct / Proxy / Reject）、设备访问控制与 Tailscale/Headscale 配置的保存、重读与应用。
- 移除内置订阅管理与后台 `ucode` 订阅更新器（`subscription-updater.uc` / `subscriptions.js` / cron 同步），升级时 `99-singsing` 自动清理遗留 `# singsing-sub` cron 条目；保留 `+kmod-nft-queue` 依赖。
- 修复 OpenWrt 24.10.8 `ucode-mod-fs` 不导出 `mkdtemp` 导致 `rpcd` 无法加载 `luci.singsing` 的兼容性问题（改为 `mktemp -d`）。
- 补齐 Tailscale `exit_node` 与 `advertise_exit_node` 互斥前置校验，并调整 DNS 规则顺序使单标签 MagicDNS 主机名优先于 `^[^.]+$` `NXDOMAIN` 解析（同时保留 `.lan`/`.home.arpa` 最优先保护）。
- 收敛访问控制边界（`get_access_control` 失败显式阻断生成、`all` 模式保存与应用一致忽略未启用旧列表），并在服务应用事务中增加 TUN 接口就绪检查与成功后原子刷新 `sing-box.last-good.json`。

## 下载与验证范围

| 附件 | SDK 验证 | 运行验证 |
| --- | --- | --- |
| `luci-app-singsing_0.1.0-r4_all.ipk` | OpenWrt 24.10.8 正式 SDK，包检查通过 | 官方 OpenWrt 24.10.8 `armsr/armv8` QEMU VM 安装/运行/卸载全链路通过 |
| `luci-app-singsing-0.1.0-r4.apk` | OpenWrt 25.12.6 正式 SDK，包检查通过 | 官方 OpenWrt 25.12.6 `armsr/armv8` QEMU VM 与 LibWrt 25.12-SNAPSHOT 真机均通过 |
| `SHA256SUMS` | 两个安装包的 SHA-256 | 下载后校验 |

LibWrt 真机完成了 r3 → r4 升级、Clash API（204 模式与代理切换、分组测速、连接管理、安全拦截）、300KB 分片离线上传、多 Profile、Non-CN 模式、整机重启、开机自启、SysRq 硬复位断电恢复、IPv6 双栈、专用 Headscale 联调及卸载恢复验证。

## 已知限制

- 卸载 APK 后，rpcd 可能保留旧方法注册（维护者已标为「不处理」，不作为发布门槛）。卸载后可执行 `/etc/init.d/rpcd reload`，完整步骤见 [README](../README.md#卸载)。
- 活动 JSON 本身损坏时，服务拒绝启动，可按 [README](../README.md#故障恢复) 从有效备份恢复。
- 首次下载规则集依赖设备能够访问对应地址。公开规则集不可达时，可通过规则集管理页离线上传 `.srs` / `.json`。
- 下载规则集失败的诊断可能包含完整 URL（维护者已标为「不处理」，保留现有诊断行为）。外发诊断前请移除 URL 凭据。
- 当前策略对已配置走代理的域名抑制 AAAA。显式 IPv6 代理路由已在真机验证。
- 专用 Headscale 真机联调、SysRq 硬复位模拟断电恢复及官方 OpenWrt 24.10.8 / 25.12.6 VM 运行验证均已通过（详见 README 与 [RC1 真机验收](rc1-validation.md)）；官方 Tailscale 控制面按维护者决定不考虑。

安装、升级、卸载说明见 [README](../README.md#安装升级和卸载010-r4)，详细验证见 [RC1 真机验收](rc1-validation.md)。

维护者发布设置建议为 **Pre-release**，附件使用经校验的 r4 安装包与 `SHA256SUMS`。
