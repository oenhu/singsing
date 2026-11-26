# luci-app-singsing

基于 [riverscn/singbox-confgen](https://github.com/riverscn/singbox-confgen) 开发的 OpenWrt 原生 LuCI `sing-box` 管理插件，提供 **OpenWrt 24.10（`opkg`/`.ipk`）** 与 **OpenWrt 25.12（`apk`/`.apk`）** SDK 构建目标，面向 **sing-box 1.14+**。

## 核心特性

- **完整保留上游配置引擎**：`src/upstream/` 原样保留上游 DNS/IPv6 策略（GFWList / Non-CN 并行竞速 / Global / Direct）、20+ 协议模板与多格式导入解析器（sing-box JSON / Clash / Mihomo / Base64 / SIP008 / 分享链接）。
- **强制手动指定直连上游 DNS**：不依赖 WAN 自动获取的 DNS；未填写有效直连 DNS IP 时禁止应用与启动，自动拦截回环地址及路由器自身 LAN IP，局域网域名（`.lan`/`.home.arpa`）到达 sing-box 后优先返回 NXDOMAIN，避免转发到外部上游。
- **内存盘缓存与 DNS 转发**：
  - `cache.db` 及动态运行文件默认放在 `/tmp/singsing/`（RAM tmpfs），运行缓存默认无需写入闪存。
  - `dnsmasq` 采用 `/tmp/dnsmasq.d/dnsmasq-singsing.conf` 内存盘 Drop-in 接管，**不修改 `/etc/config/dhcp`**，停服时清除该转发片段。
- **规则集本地化管理**：所有分流模式引用的规则集（`gfwlist` / `geosite-geolocation-cn` / `geoip-cn` / 自定义路由规则集）直接展示，支持自定义在线 URL、加速前缀、首次启动缺失自动下载、手动更新及**离线上传 `.srs`/`.json`**，sing-box 直接从本地目录读取。
- **原生透明代理与客户端访问控制**：使用 sing-box 原生 Linux TUN + `auto_redirect` + `dns_mode: hijack`，基于原生 `source_ip_cidr` / `source_mac_address` 实现局域网设备白名单/黑名单及指定出口分流（支持读取在线 DHCP/ARP 设备一键选取）。
- **全图形化 Tailscale / Headscale**：支持多 Tailnet、自定义控制服务器（`control_url`）、`auth_key`、MagicDNS、子网路由与出口节点，无需手写 JSON。
- **Clash API 实时控制与连接管理**：后端 `rpcd` 安全代理本机 `127.0.0.1:9090`（密钥不暴露给前端），支持分流模式/代理组热切换、节点测速、保存为默认、分流连通性一键检测及实时连接管理。
- **零外部依赖多订阅与定时更新**：纯 OpenWrt 原生 `ucode` + `cron`（安全 `cron.update` 重载），无需 Node.js / QuickJS / Python / Lua，支持关键词/正则过滤、重命名、去重、稳定节点 ID 保持与失败保护。
- **安全事务与自动回滚**：独立运行配置路径 `/etc/singsing/sing-box.json`（自动停用系统冲突的 `/etc/init.d/sing-box`），应用前强制 `sing-box check`，支持自定义核心路径与 `no_new_privs` 加固，启动失败自动回滚并还原 `dnsmasq`。

## RC1 安装、升级和卸载

### 环境与安装包

| 环境 | 安装包 | 验证范围 |
| --- | --- | --- |
| OpenWrt 24.10.8 | `luci-app-singsing_0.1.0-r3_all.ipk` | 正式 SDK 构建与包检查通过，官方固件运行尚未验证 |
| OpenWrt 25.12.6 | `luci-app-singsing-0.1.0-r3.apk` | 正式 SDK 构建与包检查通过，官方固件运行尚未验证 |
| LibWrt 25.12-SNAPSHOT | 同一 r3 APK | 现有真机验证，核心为 sing-box 1.14.4 |

在路由器上先执行 `sing-box version`。RC1 的验证核心为 **1.14.4**，默认路径是 `/usr/bin/sing-box`。选择对应固件的安装包，并对照 Release 的 `SHA256SUMS` 检查文件。

```sh
# OpenWrt 24.10
opkg install ./luci-app-singsing_0.1.0-r3_all.ipk

# OpenWrt 25.12 / 本次验证的 LibWrt Snapshot
apk add --allow-untrusted ./luci-app-singsing-0.1.0-r3.apk
```

依赖包来自设备固件对应的软件源。安装后进入 **服务 → Sing-Box**，填写直连上游 DNS IP，保存节点及分流。先在运行概览预览配置，再启用服务并应用。成功后在运行概览确认 TUN 状态，在运行日志确认 DNS 转发。

### 升级

在维护窗口内备份插件配置，保存副本到本机，再使用目标版本的安装命令覆盖安装。归档含节点凭据，请限制读取权限。如果配置使用自定义规则集目录，也备份其中的离线规则集。

```sh
umask 077
tar -czf /root/singsing-backup.tgz -C / etc/config/singsing etc/singsing
/etc/init.d/singsing stop
```

升级后检查活动 Profile、节点及 DNS 设置，预览并应用配置，再从局域网客户端验证 DNS、直连和代理。如果新包无法正常运行，停止服务，重新安装上一个可用包并从备份恢复插件配置，再运行 `sing-box check` 后启动。

### 卸载

先按升级步骤备份并停止服务，再按固件选择卸载命令。

```sh
opkg remove luci-app-singsing    # OpenWrt 24.10
apk del luci-app-singsing        # OpenWrt 25.12
```

卸载后执行 `/etc/init.d/rpcd reload` 清除 r3 可能保留的旧 RPC 注册。随后从客户端确认路由器 DNS 和直连 HTTPS 恢复。备份用于重新安装后恢复 Profile 和插件设置。重新安装前确认已有配置的启用状态，设备可能按保留的启用设置自动启动服务。

### 故障恢复

候选配置校验失败时，检查 LuCI 报错和路由器上的规则集文件。公开规则集地址不可达时，可用规则集管理页面上传匹配的离线 SRS。分享下载失败信息前，移除规则集 URL 中的凭据。活动 JSON 文件本身已损坏时，在维护窗口中通过 SSH 停止服务。确认上一版存在且通过检查，再在同一目录恢复。

```sh
/etc/init.d/singsing stop
set -e
sing-box check -c /etc/singsing/sing-box.last-good.json
umask 077
temp="$(mktemp /etc/singsing/.restore.XXXXXX)"
cp /etc/singsing/sing-box.last-good.json "$temp"
mv -f "$temp" /etc/singsing/sing-box.json
/etc/init.d/singsing start
```

如果最后有效文件缺失，从升级前的备份恢复并重新执行核心校验。

## 架构与规划对照

审计基线为 GitHub `main` 的 `242d10a`。实现、自动化校验和真机运行分别记录。部署与升级证据见 [RC1 真机验收](docs/rc1-validation.md)。

| 模块 | 当前职责与证据 | 规划差距 |
| --- | --- | --- |
| 配置生成 | [upstream](src/upstream) 管理 Profile、节点、代理组、DNS、路由和原生 Tailscale Endpoint。常规 LuCI 生成通过 [adapter](src/adapter/config.ts) 调用上游。 | 定时订阅另有局部配置生成路径，见下文。 |
| OpenWrt 适配 | [adapter](src/adapter) 调整 TUN、dnsmasq 对接用 DNS 入站、设备规则、本地规则集、缓存及状态目录。RC1 与阶段二已验证原生 TUN、Auto Redirect、DNS、IPv4/IPv6 与设备分流。 | 待决的设备策略边界和配置生成收敛待维护者确认。 |
| LuCI 与 RPC | [LuCI API](htdocs/luci-static/resources/singsing/api.js) 让预览、核心校验和应用共用生成入口；[RPC](root/usr/share/rpcd/ucode/singsing.uc) 读取设置、保存 Profile、接受候选 JSON。Profile 和运行 JSON 分开存放。 | 不同操作各自读取当前设置。编辑配置后重新应用会重新生成候选；当前没有部署某次预览快照的约定。 |
| 服务管理 | [procd 脚本](root/etc/init.d/singsing) 和 [Service Manager](root/usr/share/singsing/service-manager.sh) 管理规则集、真实核心校验、原子替换、启停、DNS 接管及恢复。RC1 在 LibWrt Snapshot 上验证重启、自启、候选拒绝和启动失败回滚；单测补充原子替换与首次启动失败清理。 | 目前先备份被替换的配置，按进程与 DNS 监听判断就绪。规划的“启动成功后记录新配置为最后有效版本”和单独 TUN 就绪检查仍需界定。 |
| 设备分流 | [access.ts](src/adapter/access.ts) 生成原生 `source_ip_cidr`、`source_mac_address`。阶段二已补齐 LuCI 保存与重读、IPv4/IPv6/MAC、重叠规则顺序、1.14.4 核心校验与真实客户端匹配证据。 | 随机 MAC 说明已记入文档；设备策略读取失败回落与 `all` 模式旧列表边界已用隔离单测记录，是否调整待维护者确认。 |
| Tailscale | [Tailscale 页面](htdocs/luci-static/resources/view/singsing/tailscale.js) 已有多 Tailnet、官方与 Headscale 控制服务器、Auth Key、MagicDNS、接收与通告子网、使用与通告出口，导入的高级原生字段可保留。阶段三已通过 LuCI 保存重读/校验测试、1.14.4 导出 Schema 及真实 `sing-box 1.14.4`（含路由器实机核心）离线校验。 | 同一端点同时填 `exit_node` 与 `advertise_exit_node` 会被 1.14.4 核心拒绝（表单未前置拦截，应用前由 `sing-box check` 拒绝）。独立真实 Tailnet / Headscale 联调等待维护者提供测试环境；1.15 新字段留待最低版本升级。 |
| 发布 | 两个正式 SDK 的 r3 包构建与校验已通过，LibWrt Snapshot 有硬件结果；阶段一至阶段四未修改任何打包运行文件，r3 包内容与 `242d10a` 一致。 | 卸载后 rpcd 注册残留、规则集下载失败诊断含完整 URL 均已按维护者决定标为「不处理」（保留既有证据与手动重载办法）。OpenWrt 24.10.8 和 25.12.6 官方固件运行仍未验证。 |

### 需要确认的现有行为

- **设备规则优先级与边界。** 同一配置的生成结果显示，DNS 及内置保护、适用的直连列表和有序自定义规则可在设备规则之前命中。设备指定出口按保存顺序排列，并先于白名单或黑名单规则；设备规则整体早于默认分流模式。若让设备策略覆盖普通自定义规则，命中两者的用户流量会改道。现有“所有设备按分流策略”模式也能保存旧的无效设备列表，生成时仍报错；读取设备策略失败时，生成入口回落到 `all`。两项边界已用隔离单测记录，保持现状直至维护者确认。
- **Tailscale 出口节点互斥约束。** 真实 `sing-box 1.14.4` 拒绝同一 Tailscale 端点同时设置 `exit_node` 与 `advertise_exit_node: true`（即使 Schema 允许）。目前应用前由 `sing-box check` 拦截，图形表单暂未前置阻止；是否增加表单与适配层校验待维护者确认。
- **订阅配置生成。** LuCI 订阅导入使用上游引擎。[定时订阅程序](root/usr/share/singsing/subscription-updater.uc) 自行解析部分订阅格式，并在 `patchRunningConfig` 重建节点与代理组片段，然后把候选交给 Service Manager。这是目前最明确的重复生成代码。应先对照两条路径的输出与升级行为。移除局部生成必须先解决后台自动应用的兼容性。
- **运行备份的语义。** 现有 `last-good` 在下一次应用开始时保存当时的活动文件。要改为始终保存最近健康的配置，需要明确首次应用成功、关闭自动回滚和活动文件已损坏时的预期行为。

在生产代码中未发现自建的代理协议、DNS 解析器、设备探测守护进程或 nftables 转发引擎。节点测速选择交由 sing-box 原生代理组，设备 MAC 匹配交由原生邻居解析，现有定时订阅使用 OpenWrt cron。字段和版本依据见 [sing-box 路由规则](https://sing-box.sagernet.org/configuration/route/rule/)、[邻居解析](https://sing-box.sagernet.org/configuration/shared/neighbor/)与 [Tailscale Endpoint](https://sing-box.sagernet.org/configuration/endpoint/tailscale/)。

### 最小实施顺序

1. 阶段一：提交本审计，保留现有 Profile、UCI 和生成架构（已完成）。
2. 阶段二：设备阶段锁定当前规则顺序，补 LuCI 保存与重读、IPv4/IPv6/MAC、1.14.4 核心检查与真机实测证据（已完成）。
3. 阶段三：Tailscale 阶段使用合成数据完成 LuCI 测试与 1.14.4 Endpoint 离线核心校验；待维护者提供专用测试环境后再验证真实 Tailnet / Headscale 控制面、路由和状态持久化（离线部分已完成，在线真机待验）。
4. 阶段四：部署复核 procd、校验、原子替换、失败恢复、DNS 清理与安装包，按维护者决定将两项 RC1 遗留项更新为「不处理」并保留旧验收事实（已完成）。
5. 最终复跑构建、测试、真实 1.14.4 核心、语法检查与非破坏性硬件复核；官方 24.10.8 / 25.12.6 固件运行结论等待对应环境。

### 设备分流验证

- LuCI Mock 已覆盖从在线设备选择 IP 或 MAC、页面保存与重读、指定组和节点、无效地址拒绝，以及预览与应用候选一致。
- 白名单和黑名单的 IPv4、IPv6/CIDR、MAC 混合配置通过 LibWrt 25.12-SNAPSHOT 路由器上的 1.14.4 `sing-box check`。
- Debian 客户端实际 IPv4、IPv6 和 MAC 命中相应设备规则；重叠设备规则按保存顺序命中，普通域名规则仍先命中。与默认全局代理对照，黑名单内与白名单外的同一个客户端选择直连。
- 真机临时 TUN 只接管测试客户端到指定地址的流量。现有 UCI、DHCP 与防火墙配置保持一致。当前环境用一台客户端完成了上述探测。
- 手机或电脑启用随机 MAC 后，设备可能无法命中原 MAC 规则。可在对应网络中使用固定的私有 MAC，或用稳定 IP/CIDR 作为补充。

### Tailscale 离线校验

- LuCI Mock 已覆盖官方 Tailscale 与 Headscale 控制服务器切换、合成 Auth Key、多 Tailnet 互异状态目录、接收与通告子网（IPv4/IPv6 CIDR）、出口节点、代理组与默认出口集成、导入 Profile 原有 1.14 原生高级字段保留，以及无效 CIDR、非法 `control_url`、路径穿越、原始与归一化状态目录冲突、`<tag>-dns` 冲突、节点 `detour` / 设备规则 / DNS 规则引用校验。
- 真实 `sing-box 1.14.4`（含 `with_tailscale` 编译标签）及其导出 Schema 已校验多 Tailnet（官方 + Headscale）、Tailscale DNS Server（`accept_default_resolvers` / `accept_search_domain`）、MagicDNS `preferred_by` 路由、自定义 DNS 规则、代理组与设备分流目标，且在 LibWrt 25.12-SNAPSHOT 路由器的 `1.14.4` 核心复核通过。
- 真实 `1.14.4` 核心确认同一端点不能同时设置 `exit_node` 与 `advertise_exit_node: true`（即使 Schema 允许，核心会拒绝初始化）；当前图形表单尚未前端拦截该组合，应用前由 `sing-box check` 拒绝，后续变更待维护者确认。
- 真实 Tailnet / Headscale 在线注册、重启状态复用、MagicDNS 与子网连通、通告批准、Exit Node 转发及日志凭据审查等待维护者提供专用测试环境后执行（当前标为待验）。

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

MVP 完成后的整机重启、自启、IPv6、升级、安全及卸载复测记录在 [RC1 真机验收](docs/rc1-validation.md)。OpenWrt 24.10.8 与 25.12.6 官方固件运行和整机断电恢复仍未验证。

### 阶段二至阶段四补充验证

| 验证环境 | 执行内容 | 结果 |
| --- | --- | --- |
| 本地 Vitest（Mock） | `npm ci && npm run build && npm test` | 123 项通过（覆盖适配器、LuCI 节点/DNS/分流/设备/Tailscale 往返与边界、服务应用事务原子替换与回滚）。另有 7 项核心用例由独立命令运行。 |
| 语法与静态检查 | POSIX `sh -n`、JSON 解析与 LuCI JS 语法检查 | 4 个 Shell 脚本、3 个 JSON 与 13 个 LuCI JS 文件全部通过。 |
| sing-box 1.14.4（Linux ARM64） | `SINGSING_SING_BOX=/path/to/sing-box npm run test:sing-box` | 7 项全部通过（1.14.4 版本、Direct/GFWList、设备白/黑名单、官方+Headscale Tailscale Endpoint/MagicDNS/代理组、缺失规则集失败保护）。 |
| OpenWrt 正式 SDK（r3） | `git diff 242d10a -- root/ htdocs/ src/ Makefile` 核对 | 阶段一至阶段四未修改打包运行文件，已验 r3 `.ipk` / `.apk` 产物内容保持一致。 |
| LibWrt 25.12-SNAPSHOT 真机与 Debian | 非破坏性核对 r3 实装文件、`ash`/`ucode` 语法、1.14.4 `with_tailscale` 核心离线 `check` 及设备分流实测 | 9/9 核心运行文件 SHA-256 与仓库一致，Tailscale 配置通过路由器 `sing-box check`，服务保持停用无残留，Debian 链路正常；真实 Tailnet 联调与官方 24.10.8 / 25.12.6 固件运行待验。 |

## 致谢

- 配置生成核心引擎基于 [riverscn/singbox-confgen](https://github.com/riverscn/singbox-confgen)
- OpenWrt 工程实践参考了 [VIKINGYFY/packages (luci-app-homeproxy)](https://github.com/VIKINGYFY/packages/tree/main/luci-app-homeproxy) 与 PassWall
