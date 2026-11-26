# luci-app-singsing

基于 [riverscn/singbox-confgen](https://github.com/riverscn/singbox-confgen) 开发的 OpenWrt 原生 LuCI `sing-box` 管理插件，提供 **OpenWrt 24.10（`opkg`/`.ipk`）** 与 **OpenWrt 25.12（`apk`/`.apk`）** SDK 构建目标，面向 **sing-box 1.14+**。

## 核心特性

- **完整保留上游配置引擎**：`src/upstream/` 原样保留上游 DNS/IPv6 策略（GFWList / Non-CN 并行竞速 / Global / Direct）、20+ 协议模板与多格式导入解析器（sing-box JSON / Clash / Mihomo / Base64 / SIP008 / 分享链接）。
- **强制手动指定直连上游 DNS**：不依赖 WAN 自动获取的 DNS；未填写有效直连 DNS IP 时禁止应用与启动，自动拦截回环地址及路由器自身 LAN IP，局域网域名（`.lan`/`.home.arpa`）到达 sing-box 后优先返回 NXDOMAIN，避免转发到外部上游。
- **闪存友好与断电自愈**：
  - `cache.db` 及动态运行文件默认放在 `/tmp/singsing/`（RAM tmpfs），零闪存擦写损耗。
  - `dnsmasq` 采用 `/tmp/dnsmasq.d/dnsmasq-singsing.conf` 内存盘 Drop-in 接管，**不修改 `/etc/config/dhcp`**，断电重启自动恢复原状。
- **规则集本地化管理**：所有分流模式引用的规则集（`gfwlist` / `geosite-geolocation-cn` / `geoip-cn` / 自定义路由规则集）直接展示，支持自定义在线 URL、加速前缀、首次启动缺失自动下载、手动更新及**离线上传 `.srs`/`.json`**，sing-box 直接从本地目录读取。
- **原生透明代理与客户端访问控制**：使用 sing-box 原生 Linux TUN + `auto_redirect` + `dns_mode: hijack`，基于原生 `source_ip_cidr` / `source_mac_address` 实现局域网设备白名单/黑名单及指定出口分流（支持读取在线 DHCP/ARP 设备一键选取）。
- **全图形化 Tailscale / Headscale**：支持多 Tailnet、自定义控制服务器（`control_url`）、`auth_key`、MagicDNS、子网路由与出口节点，无需手写 JSON。
- **Clash API 实时控制与连接管理**：后端 `rpcd` 安全代理本机 `127.0.0.1:9090`（密钥不暴露给前端），支持分流模式/代理组热切换、节点测速、保存为默认、分流连通性一键检测及实时连接管理。
- **零外部依赖多订阅与定时更新**：纯 OpenWrt 原生 `ucode` + `cron`（安全 `cron.update` 重载），无需 Node.js / QuickJS / Python / Lua，支持关键词/正则过滤、重命名、去重、稳定节点 ID 保持与失败保护。
- **安全事务与自动回滚**：独立运行配置路径 `/etc/singsing/sing-box.json`（自动停用系统冲突的 `/etc/init.d/sing-box`），应用前强制 `sing-box check`，支持自定义核心路径与 `no_new_privs` 加固，启动失败自动回滚并还原 `dnsmasq`。

## 开发与测试

```bash
npm install
npm run build
npm test
```

## OpenWrt SDK 编译

将本仓库放到 OpenWrt SDK 的 `package/luci-app-singsing` 目录后执行：

```bash
make package/luci-app-singsing/compile V=s
```

也可直接从本仓库的 **GitHub Actions / Releases** 下载自动构建的 `.ipk`（OpenWrt 24.10）和 `.apk`（OpenWrt 25.12）安装包。

## MVP 验证记录

| 验证环境 | 执行内容 | 结果 |
| --- | --- | --- |
| 本地 Vitest | `npm test`，运行 LuCI 回调并模拟 RPC、UCI 和服务命令 | 107 项通过。另有 4 项二进制用例由独立命令运行。 |
| sing-box 1.14.4 | `SINGSING_SING_BOX=/path/to/sing-box npm run test:sing-box` | 4 项通过，涵盖 JSON、核心导出的 Schema、真实 `sing-box check` 和校验失败保护。 |
| OpenWrt 正式 SDK | 24.10.8 构建 IPK，25.12.6 构建 APK，执行 `scripts/verify-openwrt-package.sh` | 两包通过依赖、安装与卸载脚本语法、关键文件一致性检查。 |
| LibWrt 25.12-SNAPSHOT 真机 | 安装 SDK APK，在 LuCI 录入、保存、重读和应用配置 | 节点增删改、detour 引用、损坏 Profile 提示、DNS 与规则顺序、启停重启和日志均通过。 |
| LibWrt 25.12-SNAPSHOT 真机与 LAN 客户端 | 验证 TUN、DNS 和自定义分流 | 直连 HTTP 200，代理 HTTP 204，域名、单 IP、CIDR 分别命中 Reject。显式远程 DNS 规则无法绕过 `.lan` 保护。 |
| LibWrt 25.12-SNAPSHOT 真机 | 通过 RPC 注入缺失规则集和启动端口冲突 | 校验失败保持运行配置及进程。启动失败恢复上一次有效配置、TUN 和 dnsmasq 转发，LAN 客户端直连与代理再次通过。 |

修改前，LuCI 补测复现 12 项故障，应用事务补测复现 5 项故障。第五阶段分别复现 1 项 UCI 会话提交故障和 2 项可选 ECS 表单故障。修复后的回归包含在上述 Vitest 结果中。

包构建和真机运行分别验证。尚无 24.10.8 与 25.12.6 官方固件的运行结果，也未进行虚拟机、主动整机重启、断电恢复和 IPv6 端到端转发测试。

## 致谢

- 配置生成核心引擎基于 [riverscn/singbox-confgen](https://github.com/riverscn/singbox-confgen)
- OpenWrt 工程实践参考了 [VIKINGYFY/packages (luci-app-homeproxy)](https://github.com/VIKINGYFY/packages/tree/main/luci-app-homeproxy) 与 PassWall
