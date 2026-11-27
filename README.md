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
- **静态节点多格式导入**：节点管理页直接复用上游 `singbox-confgen` 解析器，支持粘贴导入 sing-box JSON / Clash / Mihomo YAML / Base64 / SIP008 / 分享链接，不内置后台订阅定时拉取或第二套配置生成引擎。
- **安全事务与自动回滚**：独立运行配置路径 `/etc/singsing/sing-box.json`（自动停用系统冲突的 `/etc/init.d/sing-box`），应用前强制 `sing-box check`，支持自定义核心路径与 `no_new_privs` 加固，启动检查同时覆盖进程、DNS 监听与 TUN 接口就绪，成功后原子刷新 `sing-box.last-good.json`，失败自动回滚并还原 `dnsmasq`。

## 安装、升级和卸载（v0.1.3 / 0.1.3-r3 修复候选）

### 环境与安装包

> [!IMPORTANT]
> GitHub 原始发布包 `v0.1.3`（`0.1.3-r1`，基线 `a5ddb08`）在两套官方 OpenWrt VM 复测中复现 4 项问题（无参 `check_local_dns` 误判、24.10 `.ipk` 属主污染、首次开启规则集定时更新未启动 `crond`、卸载后 `luci.singsing` 残留），已在 `0.1.3-r2` 与 `0.1.3-r3` 中全部修复；`0.1.3-r3` 进一步尊重系统 `cron` 开关、通过 OpenWrt 原生 `network_find_wan`/`hotplug.d` 适配任意逻辑 WAN 名称及 `ifupdate` 地址/前缀变更，并修复 Tailscale Exit Node 通告子网 OR 放行规则。

| 环境 | 安装包（`0.1.3-r3`） | SHA-256 | 验证范围 |
| --- | --- | --- | --- |
| OpenWrt 24.10.8 (`r29233-443ec4032a`, kernel `6.6.144`) | `luci-app-singsing_0.1.3-r3_all.ipk` | `199ebc7f6b321e6ba0e3a6c91b8c20c16c15341df4079bb2da9172e2a0ace87d` | 正式 SDK 构建、静态包与 `0:0` 属主校验、官方 24.10.8 QEMU VM 新装/启停/重启/规则集 cron 实触发/动态 WAN 热插拔/卸载清理及升级全部通过 |
| OpenWrt 25.12.6 (`r33311-981c978eff`, kernel `6.12.112`) | `luci-app-singsing-0.1.3-r3.apk` | `9f40c9e2b6557efe54593ac0df3879b572f2efc992b2599361385e45116c0c24` | 正式 SDK 构建、静态包与 `root:root` 属主校验、官方 25.12.6 QEMU VM 新装/启停/重启/规则集 cron 禁用尊重/动态 WAN 热插拔/卸载清理及升级全部通过 |
| LibWrt 25.12-SNAPSHOT (`r0-96a0ec8`, kernel `6.12.112`, `qualcommax/ipq60xx`) | 同一 `0.1.3-r3` APK | `9f40c9e2b6557efe54593ac0df3879b572f2efc992b2599361385e45116c0c24` | 真机 `0.1.1-r1 → 0.1.3-r3` 升级、`0:0` 属主、大写 `WAN`/`WAN_6` 自动识别与 `wan_dns` 去重、真实 PPPoE 重拨与运营商 IPv6 PD 续租自动重载、`ifupdate` 地址/前缀热插拔与禁用 `cron` 尊重均通过（核心 `sing-box 1.14.4`） |

在路由器上先执行 `sing-box version`。当前验证核心为 **1.14.4**，默认路径是 `/usr/bin/sing-box`。选择对应固件的安装包，并对照 Release 的 `SHA256SUMS` 检查文件。

```sh
# OpenWrt 24.10
opkg install ./luci-app-singsing_0.1.3-r3_all.ipk

# OpenWrt 25.12 / 本次验证的 LibWrt Snapshot
apk add --allow-untrusted ./luci-app-singsing-0.1.3-r3.apk
```

依赖包来自设备固件对应的软件源。安装后进入 **服务 → Sing-Box**，填写直连上游 DNS IP，保存节点及分流。可在运行概览先点击「生成配置」完成离线校验与写入，再通过「启用服务」开关或「启动」按钮一键拉起服务。成功后在运行概览确认 TUN 状态，在运行日志确认 DNS 转发。

### 升级与新装默认行为差异

在维护窗口内备份插件配置，保存副本到本机，再使用目标版本的安装命令覆盖安装。归档含节点凭据，请限制读取权限。如果配置使用自定义规则集目录，也备份其中的离线规则集。

```sh
umask 077
tar -czf /root/singsing-backup.tgz -C / etc/config/singsing etc/singsing
/etc/init.d/singsing stop
```

- **全新安装默认 UCI（`0.1.3-r3`）**：`tun.strict_route='0'`、`tun.ipv6_mode='direct'`、`tun.mtu='9000'`、`mixed.enabled='0'`、`routing.bypass_cn='1'`、`routing.cn_site_ruleset='geosite-cn'`、`routing.port_mode='all'`、`routing.block_quic='0'`、`main.ruleset_auto_update='0'`、`main.ruleset_update_cron='0 4 * * *'`。
- **从 `0.1.1-r1` 升级行为（已实测）**：旧 `/etc/config/singsing`（含原有 `dns.local_server` 与 `tun.strict_route='1'`）及 `/etc/singsing/sing-box.json` 均完整保留；`uci-defaults/99-singsing` 仅按缺失补齐 `mixed` 与 `routing` 段，**不覆盖已有 `tun` 段**，因此旧 UCI 中 `tun.strict_route` 保持 `'1'`，`tun.ipv6_mode` 与 `tun.mtu` 在 UCI 中保持未设置（`<unset>`）；再次通过 LuCI 预览/生成配置时，前端 `api.js` 与适配层会对缺失的 `tun.ipv6_mode` 按 `'direct'`、缺失的 `tun.mtu` 按 `9000` 生成有效配置（`strict_route` 仍沿用旧值 `true`，用户可在设置页按需改为关闭）。

升级后检查活动 Profile、节点及 DNS 设置，预览并应用配置，再从局域网客户端验证 DNS、直连和代理。如果新包无法正常运行，停止服务，重新安装上一个可用包并从备份恢复插件配置，再运行 `sing-box check` 后启动。

### 卸载

先按升级步骤备份并停止服务，再按固件选择卸载命令。

```sh
opkg remove luci-app-singsing    # OpenWrt 24.10
apk del luci-app-singsing        # OpenWrt 25.12
```

`0.1.3-r2` / `0.1.3-r3` 已在包卸载钩子中自动停止服务、清理 TUN / nftables / dnsmasq 接管 / `# singsing-ruleset` 定时任务，并在 `postrm`（24.10）/ `post-deinstall`（25.12）清理 LuCI 缓存并执行 `/etc/init.d/rpcd reload`，卸载后 `luci.singsing` 立即从 `ubus` 注销且用户配置文件保留（如从旧版 `0.1.3-r1` 及更早版本卸载，仍需手动执行一次 `/etc/init.d/rpcd reload`）。随后从客户端确认路由器 DNS 和直连 HTTPS 恢复。备份用于重新安装后恢复 Profile 和插件设置。重新安装前确认已有配置的启用状态，设备可能按保留的启用设置自动启动服务。

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

| 模块 | 当前职责与证据 | 状态与后续事项 |
| --- | --- | --- |
| 配置生成 | [upstream](src/upstream) 管理 Profile、节点、代理组、DNS、路由和原生 Tailscale Endpoint；全部配置生成统一经 [adapter](src/adapter/config.ts) 调用上游。 | 已移除重复的后台订阅解析/生成代码（`subscription-updater.uc`）；后续随上游同步关注 `src/upstream/generate.ts` 本地改动。 |
| OpenWrt 适配 | [adapter](src/adapter) 调整 TUN、dnsmasq 对接用 DNS 入站、设备规则、本地规则集、缓存及状态目录。已覆盖 4 种分流模式与双栈校验。 | 已收敛访问控制边界与单标签 MagicDNS 规则顺序。 |
| LuCI 与 RPC | [LuCI API](htdocs/luci-static/resources/singsing/api.js) 让预览、核心校验和应用共用生成入口；[RPC](root/usr/share/rpcd/ucode/singsing.uc) 读取设置、保存 Profile、接受候选 JSON 并代理本机 Clash API。 | 已修复 OpenWrt 24.10.8 `ucode-mod-fs` 无 `mkdtemp` 导致的 RPC 加载失败；读取访问控制失败时显式报错不静默降级。 |
| 服务管理 | [procd 脚本](root/etc/init.d/singsing) 和 [Service Manager](root/usr/share/singsing/service-manager.sh) 管理规则集、真实核心校验、原子替换、启停、DNS 接管及恢复。 | 已在就绪检查中纳入 TUN 接口检测，并在应用成功后原子刷新 `sing-box.last-good.json`（含首次成功应用）。 |
| 设备分流 | [access.ts](src/adapter/access.ts) 生成原生 `source_ip_cidr`、`source_mac_address`，已通过 LuCI、1.14.4 核心及真机客户端匹配验证。 | `all` 模式下保存与应用一致忽略未使用的旧设备列表；`get_access_control` 失败显式阻断生成。 |
| Tailscale | [Tailscale 页面](htdocs/luci-static/resources/view/singsing/tailscale.js) 已支持多 Tailnet、官方与 Headscale、MagicDNS、子网路由与出口节点，并完成专用 Headscale 真机闭环联调。 | 1) 已在表单与 `validation.ts` 前置禁止同一端点同时配置 `exit_node` 与 `advertise_exit_node`；2) 已调整 DNS 规则顺序为 `.lan` 保护 → Tailscale MagicDNS `preferred_by` → 单标签 `^[^.]+$` `NXDOMAIN`；3) 官方 Tailscale 控制面按维护者决定不再单独考虑，后续仅随上游关注 1.15 新字段。 |
| 发布 | `0.1.3-r3` `.ipk`（24.10.8 SDK）与 `.apk`（25.12.6 SDK）已通过构建、`0:0` 属主静态门禁、官方 24.10.8 / 25.12.6 QEMU VM 与 LibWrt 真机（含 PPPoE 重拨、IPv6 PD 续租与 `ifupdate` 热插拔）全链路验收，保留 `+kmod-nft-queue` 依赖。 | 已修复卸载 `rpcd` 注册残留、系统 `cron` 开关尊重、动态 WAN 检测及 Tailscale Exit Node 子网 OR 放行；规则集下载失败诊断含完整 URL 维持不处理。 |

### 已收敛的设计边界（r4）

- **移除订阅管理，专注平台适配**：已删除 `subscription-updater.uc`、`subscriptions.js`、`src/adapter/subscriptions.ts` 及 cron 定时同步，升级脚本 `99-singsing` 会自动清理旧版本遗留的 `# singsing-sub` cron 条目；用户直接在「节点管理」页面复用上游多格式导入器导入静态节点。
- **Tailscale 出口节点互斥与单标签 MagicDNS**：表单与适配层校验均前置拒绝同时设置 `exit_node` 和 `advertise_exit_node: true`；DNS 规则顺序调整为 `.lan`/`.home.arpa` `NXDOMAIN` → Tailscale `preferred_by` → 单标签 `^[^.]+$` `NXDOMAIN`，既放行单标签 MagicDNS 主机名又不泄漏普通局域网主机名。
- **访问控制边界收敛**：`buildCurrentConfig()` 在 `get_access_control` RPC 失败时直接报错中止，不再静默回落到 `all`；`all` 模式下验证层忽略未启用的 `clients` 字段，与前端保存行为一致。
- **运行备份与 TUN 就绪检查**：`apply_config` 在验证通过并完成启服、DNS 监听与 TUN 接口就绪（`is_tun_ready`）、`dnsmasq` 接管后，原子刷新 `sing-box.last-good.json`；失败回滚使用事务内临时备份，不污染 `last-good`。

在生产代码中未发现自建的代理协议、DNS 解析器、设备探测守护进程或 nftables 转发引擎。节点测速选择交由 sing-box 原生代理组，设备 MAC 匹配交由原生邻居解析。字段和版本依据见 [sing-box 路由规则](https://sing-box.sagernet.org/configuration/route/rule/)、[邻居解析](https://sing-box.sagernet.org/configuration/shared/neighbor/)与 [Tailscale Endpoint](https://sing-box.sagernet.org/configuration/endpoint/tailscale/)。

### 实施与验证里程碑

1. 阶段一：架构审计与规划对照（已完成）。
2. 阶段二：设备分流规则锁定、LuCI 与真机客户端实测（已完成）。
3. 阶段三：Tailscale 离线核心校验与专用 Headscale 真机闭环联调（已完成；官方 Tailscale 控制面不考虑）。
4. 阶段四：部署事务、SysRq 硬复位断电恢复、RC1 维护者决策（已完成）。
5. r4 收口：移除订阅管理、修复 24.10 `mkdtemp` 兼容性与上述边界、补齐 Clash API / 分片上传 / 多 Profile / `Non-CN` 真机验证，以及官方 OpenWrt 24.10.8 / 25.12.6 QEMU VM 实机安装运行验证（已完成）。

### 设备分流验证

- LuCI Mock 已覆盖从在线设备选择 IP 或 MAC、页面保存与重读、指定组和节点、无效地址拒绝，以及预览与应用候选一致。
- 白名单和黑名单的 IPv4、IPv6/CIDR、MAC 混合配置通过 LibWrt 25.12-SNAPSHOT 路由器上的 1.14.4 `sing-box check`。
- Debian 客户端实际 IPv4、IPv6 和 MAC 命中相应设备规则；重叠设备规则按保存顺序命中，普通域名规则仍先命中。与默认全局代理对照，黑名单内与白名单外的同一个客户端选择直连。
- 真机临时 TUN 只接管测试客户端到指定地址的流量。现有 UCI、DHCP 与防火墙配置保持一致。当前环境用一台客户端完成了上述探测。
- 手机或电脑启用随机 MAC 后，设备可能无法命中原 MAC 规则。可在对应网络中使用固定的私有 MAC，或用稳定 IP/CIDR 作为补充。

### Tailscale 与 Headscale 验证

- LuCI Mock 已覆盖官方 Tailscale 与 Headscale 控制服务器切换、合成 Auth Key、多 Tailnet 互异状态目录、接收与通告子网（IPv4/IPv6 CIDR）、出口节点、代理组与默认出口集成、导入 Profile 原有 1.14 原生高级字段保留，以及无效 CIDR、非法 `control_url`、路径穿越、原始与归一化状态目录冲突、`<tag>-dns` 冲突、节点 `detour` / 设备规则 / DNS 规则引用校验。
- 真实 `sing-box 1.14.4`（含 `with_tailscale` 编译标签）及其导出 Schema 已校验多 Tailnet（官方 + Headscale）、Tailscale DNS Server（`accept_default_resolvers` / `accept_search_domain`）、MagicDNS `preferred_by` 路由、自定义 DNS 规则、代理组与设备分流目标，且在 LibWrt 25.12-SNAPSHOT 路由器的 `1.14.4` 核心复核通过。
- 在维护者提供的专用 Headscale 环境（配合 `tun.route_exclude_address` 保护局域网管理网段）下，于路由器独立状态目录 `/etc/sing-box/tailscale/live-test-hs` 完成实机闭环验证：
  - **注册与重启复用**：首次带临时预授权密钥经真实 `service-manager.sh apply_config` 上线注册并生成 `0600` 权限的 `tailscaled.state`；移除 `auth_key` 重启至新 PID 后复用同一 Headscale 节点 ID 与 Tailscale IP，未产生重复节点。
  - **MagicDNS 与对端/子网互通**：Debian 局域网客户端经路由器 DNS 解析对端 FQDN MagicDNS 成功并 `ping` 通对端 IP 与 FQDN（0% 丢包）；路由器通告独立测试子网 `198.51.100.0/24` 经 Headscale 批准后，对端节点 `ping` 通该通告子网（0% 丢包）。无后缀单标签主机名受 `src/adapter/dns.ts` 的 `^[^.]+$` 保护规则优先拦截返回 `NXDOMAIN`。
  - **Exit Node 与按 tag 选流**：直连对照请求返回路由器 WAN 出口 IP；按 Tailscale tag 分流的 HTTP 请求经在线 Exit Node 出口返回对端公网 IP，核心日志确认命中 `endpoint/tailscale[hs-live]`；独立配置 `advertise_exit_node: true` 后 Headscale 收到 `0.0.0.0/0` 与 `::/0` 并批准生效。
  - **凭据脱敏与现场还原**：全量 `logread` 核对临时预授权密钥及控制面 API 密钥出现次数均为 `0`；验证结束后已删除临时 Headscale 节点并使临时密钥过期，路由器停服还原备份，UCI、DHCP、防火墙与活动配置 SHA-256 全部一致。
- 官方 Tailscale 控制面实机联调按维护者决定不考虑；1.15 新增字段作为后续版本随上游同步事项。

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

MVP 完成后的整机重启、自启、IPv6、升级、安全、SysRq 硬复位断电恢复及卸载复测记录在 [RC1 真机验收](docs/rc1-validation.md)。

### r4 补充验证（含官方 OpenWrt 24.10.8 / 25.12.6 虚拟机）

| 验证环境 | 执行内容 | 结果 |
| --- | --- | --- |
| 本地 Vitest（Mock） | `npm run build && npm test` | 127 项通过（含 Tailscale 互斥/单标签 MagicDNS 排序、访问控制失败阻断、`all` 模式旧列表忽略、TUN 就绪回滚与首次 `last-good` 写入）。另有 9 项 Linux 核心用例由独立命令运行。 |
| 语法与静态检查 | POSIX `sh -n`、JSON 解析与 LuCI JS 语法检查 | 4 个 Shell 脚本、3 个 JSON 与 11 个 LuCI JS 文件全部通过，无订阅模块残留引用。 |
| sing-box 1.14.4（Linux ARM64） | `SINGSING_SING_BOX=... npm run test:sing-box` | 9 项全部通过（1.14.4 版本、Direct / GFWList / Non-CN / Global 四模式、设备白/黑名单、官方+Headscale Tailscale Endpoint/MagicDNS/代理组、缺失规则集失败保护）。 |
| OpenWrt 正式 SDK（r4） | 24.10.8 SDK 构建 `.ipk` + 25.12.6 SDK 构建 `.apk` + `verify-openwrt-package.sh` | 两包均通过版本（`0.1.0-r4`）、依赖（含 `kmod-nft-queue`）、安装卸载钩子与文件一致性校验。 |
| 官方 OpenWrt 24.10.8 VM（QEMU `armsr/armv8`） | `opkg update && opkg install` r4 `.ipk` + `sing-box 1.14.4`（musl）+ `apply_config` + Clash API + 分片上传 + 多 Profile + `opkg remove` | 发现并修复了 24.10.8 `ucode-mod-fs` 无 `mkdtemp` 导致 RPC 加载失败的兼容性问题；修复后重编 r4 `.ipk` 全链路通过（`rpcd` 立即注册、`singtun`、nftables `table inet sing-box`、`dnsmasq` drop-in、`last-good`、Clash API 204、卸载清理）。 |
| 官方 OpenWrt 25.12.6 VM（QEMU `armsr/armv8`） | `apk update && apk add` r4 `.apk` + `sing-box 1.14.4`（musl）+ `apply_config` + Clash API + 分片上传 + 多 Profile + `apk del` | 全链路通过（依赖自动安装含 `kmod-nft-queue`、`rpcd` 注册、`singtun`、nftables `auto_redirect`、`dnsmasq` drop-in、`last-good`、Clash API 204、卸载清理）。 |
| LibWrt 25.12-SNAPSHOT 真机与 Debian | r3 → r4 升级、遗留 `# singsing-sub` cron 自动清理、`Non-CN` 模式、Clash API（204 模式/代理切换、分组测速、连接管理、SSRF/路径穿越拦截）、并发连通性检测、300KB 分片上传、多 Profile CRUD、Headscale 联调与 SysRq 硬复位 | 全项通过；最终路由器实装 r4 文件 SHA-256 与仓库一致，现场备份还原后校验和一致，服务停用无残留。 |

## 致谢

- 配置生成核心引擎基于 [riverscn/singbox-confgen](https://github.com/riverscn/singbox-confgen)
- OpenWrt 工程实践参考了 [VIKINGYFY/packages (luci-app-homeproxy)](https://github.com/VIKINGYFY/packages/tree/main/luci-app-homeproxy) 与 PassWall
