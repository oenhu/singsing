# singsing RC1 · 0.1.0-r3

singsing 通过 LuCI 配置 sing-box，复用 singbox-confgen 生成 JSON，并在 OpenWrt 上使用 sing-box 原生 Linux TUN 和 Auto Redirect。本候选版本的验证核心为 **sing-box 1.14.4**。

## 候选内容

- LuCI 节点、DNS 和分流的保存、重新读取与应用，支持 Direct、Proxy、Reject。Reject 可匹配域名、IP 或 CIDR。
- 提交 UCI、读取损坏 Profile、停止服务和应用失败均显示对应错误。应用前执行真实 `sing-box check`，校验失败时保留运行配置。
- DNS 端口严格校验，DoT 默认端口为 853，显式 DNS 规则受 LAN 域名保护约束。

## 下载与验证范围

| 附件 | SDK 验证 | 运行验证 |
| --- | --- | --- |
| `luci-app-singsing_0.1.0-r3_all.ipk` | OpenWrt 24.10.8 正式 SDK，包检查通过 | 24.10.8 官方固件尚未验证 |
| `luci-app-singsing-0.1.0-r3.apk` | OpenWrt 25.12.6 正式 SDK，包检查通过 | LibWrt 25.12-SNAPSHOT 真机通过；25.12.6 官方固件尚未验证 |
| `SHA256SUMS` | 两个安装包的 SHA-256 | 下载后校验 |

LibWrt 真机完成了正常整机重启、开机自动启动、Profile 持久化、启动失败恢复、IPv6 Direct/Proxy/Reject、IPv6 DNS、双栈流量和 r2 → r3 数据保留验证。用真实客户端复测了卸载后的 DNS 与直接访问。

## 已知限制

- 卸载 APK 后，rpcd 可能保留旧方法注册（维护者已标为「不处理」，不作为发布门槛）。卸载后可执行 `/etc/init.d/rpcd reload`，完整步骤见 [README](../README.md#卸载)。
- 活动 JSON 本身损坏时，服务拒绝启动，可按 [README](../README.md#故障恢复) 从有效备份恢复。
- 首次下载规则集依赖设备能够访问对应地址。本次现场的公开规则集下载失败，离线恢复通过，通过可访问的测试镜像补齐缺失 SRS 也已验证。
- 下载规则集失败的诊断可能包含完整 URL（维护者已标为「不处理」，保留现有诊断行为）。外发诊断前请移除 URL 凭据。
- 当前策略对已配置走代理的域名抑制 AAAA。显式 IPv6 代理路由在本次设备上已验证。
- 整机断电恢复、官方 Tailscale 控制面实机联调与两个 OpenWrt 官方固件运行尚未验证（专用 Headscale 真机联调已补验通过，详见 README）。

安装、升级、卸载说明见 [README](../README.md#rc1-安装升级和卸载)，详细验证见 [RC1 真机验收](rc1-validation.md)。

维护者发布设置建议为 **Pre-release**。附件使用经校验的 r3 安装包与 `SHA256SUMS`。上述两项 RC1 遗留项已按维护者决定标为「不处理」；正式发布前仍建议补齐两个官方固件的实际运行验证及官方 Tailscale 控制面联调。
