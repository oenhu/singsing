# singsing 测试工作交接文档（v0.1.3 及后续验证）

> 本文档面向接手本仓库测试与验收工作的维护者或 AI 助手，整理了当前代码基线、已完成与待完成的测试矩阵、`v0.1.3` 新增特性的重点验证项、以及前期真机与 VM 实测中踩过的环境坑点与排障经验。

---

## 1. 当前基线与开发准则

### 1.1 代码与发布状态

- **仓库**：`https://github.com/oenhu/singsing`（分支 `main`）
- **当前最新正式版本**：`v0.1.3`（commit `a5ddb08`，GitHub Release 已自动生成 `luci-app-singsing_0.1.3-r1_all.ipk`、`luci-app-singsing-0.1.3-r1.apk`、`SHA256SUMS`）
- **核心验证目标**：`sing-box 1.14.4`（OpenWrt 24.10.8 `opkg` / OpenWrt 25.12.6 `apk` / LibWrt 25.12-SNAPSHOT 真机）
- **自 `v0.1.1` 以来的主要功能提交**：
  1. `a84fc4d`（`v0.1.2`）：运行概览解耦「先生成校验配置，再独立开关启用服务」
     - `service-manager.sh write_config` + `luci.singsing.write_config` RPC + ACL 放行：停机状态下通过离线 stub 完成 `sing-box check` 并原子写入 `0600` 权限的 `/etc/singsing/sing-box.json` 与 `rulesets-manifest.json`，不启动 `sing-box`、不接管 `dnsmasq`、不覆盖 `last-good`；运行中调用则拒绝并提示改走 `apply_config`。
     - 加固 `service_action`（`start`/`restart`）：校验核心 PID 非 0，从停用状态启动失败时自动将 `main.enabled` 回滚为 `0`。
     - 首页内联「启用服务」开关 + 动态「生成配置 / 生成并应用」按钮，无配置直接启动时自动生成并支持失败回滚。
  2. `4482c70`（`v0.1.3`）：原生内核级 Pre-Match Bypass、路由器 IPv6/DNS 容灾与运行时加固
     - `auto_redirect` 模式下于 `{ action: "sniff" }` 前生成原生 `action: "bypass"`（带 TUN 源 IP 与 53 端口保护），并支持 `tun.route_exclude_cn`（`route_exclude_address_set: ["geoip-cn"]`）。
     - 修复设备访问控制优先级（设备黑/白名单与指定出口置于用户域名规则之前）并自动开启原生 `route.find_neighbor: true`。
     - 路由器 IPv6 PD 策略 `tun.ipv6_mode`（`direct` / `auto` / `ipv4_only`，默认 `direct`）及 `dns.allow_proxy_ipv6` 开关。
     - 路由器流量边界与运行时加固：`routing.port_mode`（`all` / `common` / `custom` + `custom_ports`）、代理侧 QUIC 拒断（`routing.block_quic`）、`routing.cn_site_ruleset`（默认 `geosite-cn`，新配置默认 `Non-CN`）、OpenWrt `crond` 规则集定时更新（`main.ruleset_auto_update` / `ruleset_update_cron` + `cron_sync`/`cron_remove`）、TUN 默认 `strict_route=0` / `mtu=9000` / `include_interface` / `default_interface` / `udp_timeout`、Linux 6.6 `QUIC_GO_DISABLE_GSO=true`、`nofile=1000000`、`wan` 接口 `up` 自动重载（`service_triggers` + `reload_if_running`）。
     - 可选局域网 `mixed-in`（`mixed.enabled` / `listen_address` / `listen_port`，默认 `::` / `5330`）。
     - 直连 DNS 容灾：DoT/DoH 域名 + `dns.local_bootstrap` 引导 IP、`dns.local_backup_server`、`Non-CN` 远程 `SERVFAIL`/`REFUSED` 安全回落 `local`、`dns_check` 新增 `wan_dns` 探测。
     - Tailscale Exit Node 闭环：`advertise_exit_node: true` 自动补齐入站 53 端口 `hijack-dns` 与私网/通告子网直连放行。

### 1.2 长期开发与测试红线（接手前必读）

- **职责边界**：`singbox-confgen` 负责生成配置，`singsing` 仅负责 OpenWrt 平台适配与运行集成，避免演化成独立的 sing-box 配置管理生态。
- **三问原则**：任何新增模块或改动前先确认：(1) `sing-box` 是否原生支持？(2) `singbox-confgen` 是否已支持？(3) OpenWrt 是否已有系统机制？任一层已有能力优先复用。
- **已定决策（勿回退）**：
  - 订阅管理已永久移除（只保留节点管理页静态多格式导入）；
  - `+kmod-nft-queue` 作为必需依赖保留；
  - 官方 Tailscale 控制面不纳入验收范围（仅联调自建 Headscale）。
- **真机安全原则**：测试期间确保路由器与测试客户端 SSH 始终可达；真机测试前持久化备份配置（不要只放 `/tmp`），测试完毕必须完整还原路由器与客户端状态。

---

## 2. 验证状态总览

| 测试类别 | v0.1.2 状态 | v0.1.3 (`a5ddb08`) 状态 | 说明 |
| --- | --- | --- | --- |
| 构建与单测（`npm run build` / `npm test`） | 已通过（132/132） | **待在本地重新执行确认** | `4482c70` 新增了大量适配器/路由/LuCI 单测，需确认全部通过 |
| Linux `sing-box 1.14.4` 核心测试（`test:sing-box`） | 已通过（9/9） | **待重新执行确认** | 需用 Linux 版 `sing-box 1.14.4` 验证 `v0.1.3` 新生成的 bypass / IPv6 / mixed / DNS 配置 |
| OpenWrt 24.10 / 25.12 SDK 打包与包检查 | 已通过（`0.1.1-r1`） | GitHub Actions 已构建发布 `v0.1.3` | 需下载或本地构建 `0.1.3-r1` `.ipk`/`.apk` 用于 VM 和真机测试 |
| 官方 OpenWrt 24.10.8 (`opkg`) QEMU VM 全链路 | 已通过（含 `write_config`） | **待用 `0.1.3-r1` 重跑** | 重点补测 Linux 6.6 `QUIC_GO_DISABLE_GSO=true`、`nofile=1000000`、`cron_sync`/`cron_remove` |
| 官方 OpenWrt 25.12.6 (`apk`) QEMU VM 全链路 | 已通过（含 `write_config`） | **待用 `0.1.3-r1` 重跑** | 重点补测 `0.1.3-r1` 默认 `Non-CN`、`bypass_cn`、`mixed-in` 与卸载清理 |
| 真机升级、ACL 会话、`write_config`、运行中自动回滚 | 已通过（`0.1.0-r4 -> 0.1.1-r1`） | **待升级至 `0.1.3-r1` 重测** | 路由器当前装的是 `0.1.1-r1`（见 §3.2），需测 `0.1.1-r1 -> 0.1.3-r1` 升级与 `99-singsing` 迁移 |
| 真机数据面（Clash API 测速/热切换、MAC 设备分流、黑名单、Headscale、真机重启自启） | **未跑完**（卡在局域网测试代理延迟超时，见 §5.4） | **待完整执行并闭环** | 同时一并验收 `v0.1.3` 全部新特性（见 §4） |

---

## 3. 测试环境与可复用命令

### 3.1 本地与远程设备（凭据请向用户获取或从本地环境变量传入）

- **代码仓库**：当前项目根目录
- **本地容器/虚拟机**：
  - OpenWrt SDK Docker 容器（若存在 `singsing-mvp-sdk-r2`，内置 `/build/sdk-24` 与 `/build/sdk-25`）；
  - Linux `sing-box 1.14.4`（macOS 版 `sing-box` 不支持 `auto_redirect`，必须通过 Linux 环境/OrbStack/容器执行 `test:sing-box`）；
  - QEMU `qemu-system-aarch64`（用于官方 OpenWrt `armsr/armv8` 24.10.8 与 25.12.6 VM 验证）。
- **真机路由器**：`<ROUTER_IP>`（LibWrt 25.12-SNAPSHOT，`aarch64`，`apk`，`sing-box 1.14.4`，带公网 IPv6 PD 前缀，当前已安装 `luci-app-singsing 0.1.1-r1`，处于停用干净状态 `enabled=0`）。
- **局域网测试客户端**：`<CLIENT_IP>`（Debian 13 `x86_64`，默认网关指向路由器，具备 `python3`、`dig`、`wget`，可用于数据面验证、临时 SOCKS5/HTTP 测试代理及临时 Headscale 控制面）。

### 3.2 本地自动化测试与语法检查

```sh
# 1. 类型检查 + 构建 engine-bundle.js
npm run build

# 2. 单元测试（含适配器、LuCI 视图、service-manager 事务）
npm test

# 3. 真实 Linux sing-box 1.14.4 核心校验（必须指向 Linux 二进制）
SINGSING_SING_BOX=/path/to/linux-sing-box-1.14.4 npm run test:sing-box

# 4. Shell / JSON / LuCI JS 语法检查（与 CI 保持一致）
sh -n root/usr/share/singsing/service-manager.sh
sh -n root/etc/init.d/singsing
sh -n root/etc/uci-defaults/99-singsing
node -e '
  const fs = require("fs");
  for (const f of [
    "root/usr/share/luci/menu.d/luci-app-singsing.json",
    "root/usr/share/rpcd/acl.d/luci-app-singsing.json",
    "root/etc/capabilities/singsing.json"
  ]) JSON.parse(fs.readFileSync(f, "utf8"));
  for (const f of [
    "htdocs/luci-static/resources/singsing/api.js",
    ...fs.readdirSync("htdocs/luci-static/resources/view/singsing")
      .map(x => "htdocs/luci-static/resources/view/singsing/" + x)
  ]) new Function(fs.readFileSync(f, "utf8"));
  console.log("SYNTAX_OK");
'
```

### 3.3 OpenWrt SDK 快速打包与校验

> 务必使用 `make -C package/luci-app-singsing`（约 3 秒完成），避免直接跑 `make package/luci-app-singsing/compile` 触发编译全部内核模块。

```sh
# 在 macOS 打包源码 tarball 时务必禁用 AppleDouble 元数据：
COPYFILE_DISABLE=1 tar --no-xattrs --exclude='.git' --exclude='node_modules' \
  --exclude='tests' --exclude='src' --exclude='scripts' --exclude='._*' \
  -czf src.tar.gz .

# 在 SDK 目录内编译：
make -C package/luci-app-singsing TOPDIR="$PWD" CONFIG_LUCI_JSMIN= V=s clean compile

# 校验产物（依赖、conffiles、prerm/postinst、payload）：
sh scripts/verify-openwrt-package.sh path/to/luci-app-singsing_0.1.3-r1_all.ipk
sh scripts/verify-openwrt-package.sh path/to/luci-app-singsing-0.1.3-r1.apk /path/to/host/bin/apk
```

---

## 4. 待执行完整验收清单（针对 `v0.1.3`）

### 4.1 官方 OpenWrt 24.10.8 & 25.12.6 QEMU VM 验证

在两套官方干净镜像（`armsr/armv8`）中分别安装 `luci-app-singsing_0.1.3-r1_all.ipk`（`opkg`）与 `luci-app-singsing-0.1.3-r1.apk`（`apk`），验证：

1. 安装依赖拉取完整（确认 `+kmod-nft-queue`、`+kmod-nft-tproxy`、`+kmod-tun`、`+firewall4`、`+rpcd-mod-ucode` 均装齐），无旧订阅文件残留。
2. `ucode -c /usr/share/rpcd/ucode/singsing.uc` 通过，且 `rpcd` 自动注册 `luci.singsing`（含 `write_config`）。
3. **先生成再启用流程**：`enabled=0` 调用 `write_config`（缺本地规则集时离线 stub 校验通过、写入 `0600` 文件、不启核心、不接管 `dnsmasq`）→ 调用 `service_action("start")` 自动补齐规则集并拉起 → 运行中拒绝 `write_config` → `apply_config` 刷新 `sing-box.last-good.json`。
4. **v0.1.3 运行时加固验证**：
   - OpenWrt 24.10.8（Linux 6.6）：验证 `/proc/$PID/environ` 中包含 `QUIC_GO_DISABLE_GSO=true`；
   - 两套 VM 均验证 `/proc/$PID/limits` 中 `Max open files` 为 `1000000`；
   - 验证 `main.ruleset_auto_update='1'` 启动时写入 `/etc/crontabs/root`，停止或卸载时自动清理；
   - 验证 `ubus call service list '{"name":"singsing"}'` 中包含 `wan` 接口 `up` 触发器。
5. Clash API（`/version`、204 切换模式/代理、路径穿越拦截）、分片上传 `ruleset_upload`、多 Profile 增删保护。
6. `opkg remove` / `apk del` 卸载后：`sing-box` 进程停止、`singtun` 销毁、`dnsmasq` drop-in 清除、`/etc/singsing/sing-box.json` 与 `/etc/config/singsing` 保留。

### 4.2 真机全量验收（路由器 + Debian 客户端）

> **前置准备**：将路由器 `/etc/config/singsing`、`/etc/config/dhcp`、`/etc/config/firewall`、`/etc/singsing/`、`/etc/crontabs/root`、`/etc/sing-box/rule-sets/` 备份至 `/root/singsing-hw-backup/`（持久化目录，避免 `reboot` 后丢失）。

1. **包升级与配置迁移（`0.1.1-r1 -> 0.1.3-r1`）**
   - `apk add --allow-untrusted --no-network luci-app-singsing-0.1.3-r1.apk`；
   - 确认 `99-singsing` 补齐 `v0.1.3` 新增的 UCI 默认字段（`mixed`、`routing`、`tun.ipv6_mode`、`tun.strict_route` 等）同时保留原有 `dns.local_server` 与 `/etc/singsing/` 配置；
   - 确认 `uhttpd` 正常返回 `200`（`overview.js`、`settings.js`、`api.js`、`engine-bundle.js`）。
2. **真实 `rpcd` 会话 ACL 鉴权测试（不可只用 root `ubus` 绕过）**
   - 通过 `ubus call session login` 获取真实 `ubus_rpc_session`；
   - 逐一调用 `session.access` 验证 `acl.d/luci-app-singsing.json` 中所有读写 RPC（特别包含 `write_config`、`apply_config`、`service_action`、`clash_api`、`dns_check`、`get_lan_clients`、`save_access_control`、`ruleset_upload`）。
3. **首页「先生成配置再开关启用」与失败回滚**
   - `enabled=0`、移除 `/etc/singsing/sing-box.json` → `write_config` 写入 `0600` 文件且保持停机未接管；
   - `service_action("start")` 直接拉起并接管 `dnsmasq` 与 `singtun`；
   - 运行中调用 `write_config` 被拒绝；
   - 停机后写入损坏 JSON 调用 `service_action("start")` → 返回 `ok: false` 且 `main.enabled` 自动回滚为 `0`。
4. **核心 `apply_config` 事务与运行中自动回滚**
   - 语法非法候选配置 → 拒绝且原服务不受影响；
   - 语法合法但运行期启动失败（如绑定不可达监听 IP `198.51.100.254`）→ 验证返回 `rolled_back: true`，且自动恢复上一版 `last-good` 配置、进程、`singtun` 与 `dnsmasq`。
5. **v0.1.3 原生 Pre-Match Bypass 与 4 模式热切换**
   - 用实际 `engine-bundle.js` 生成包含 `bypass_cn=1`（原生 `action: "bypass"` 在 `sniff` 之前）的配置并应用；
   - 验证 `sing-box 1.14.4` 正常启动且 `nft list table inet sing-box` 就绪；
   - 从 Debian 客户端实测 4 模式（`Non-CN` / `GFWList` / `Global` / `Direct`）通过 Clash API（启用 `clashSecret`）实时热切换生效；
   - 额外验证 `tun.route_exclude_cn=1`（`route_exclude_address_set: ["geoip-cn"]`）可被核心正常加载运行。
6. **Clash API 完整控制面与数据面**
   - `/version`、`PATCH /configs`、`PUT /proxies/proxy`（在客户端用回显测试代理实测流量从 `proxy-a` 热切换到 `proxy-b`）、`/group/proxy/delay` 与 `/proxies/<tag>/delay` 真实返回延迟、`GET /connections`、路径穿越拦截（`/proxies/../restart` 返回失败）。
7. **设备访问控制优先级与 `find_neighbor: true`（Debian 客户端实测）**
   - 验证 `get_lan_clients` 发现 Debian 客户端 IP 与 MAC；
   - 配置 `deviceRules`（按 MAC 指定出口 `proxy-b`，同时加一条冲突的用户域名规则指向 `proxy-a`），确认**设备规则优先于用户域名规则**生效；
   - 验证 `blocklist`（`Global` 模式下将客户端加入黑名单，实测旁路直连）与 `allowlist`（仅白名单设备走代理）。
8. **IPv6 PD 策略、端口过滤、代理侧 QUIC 拒断与 `mixed-in`（v0.1.3 新增重点）**
   - **IPv6 PD**：验证默认 `ipv6_mode=direct` 下客户端直连 IPv6 正常，代理域名默认抑制 AAAA；开启 `allow_proxy_ipv6=1` 后校验生成配置与解析行为；验证 `ipv6_mode=ipv4_only` 正常应用。
   - **端口过滤 & QUIC**：测试 `port_mode=common` / `custom`（高端口绕过代理直连）及 `block_quic=1`（仅代理目标 UDP 443 拒断，直连 UDP 443 正常）。
   - **`mixed-in`**：开启 `mixed.enabled=1`（端口 `5330`），从 Debian 客户端分别以 HTTP 代理与 SOCKS5 代理访问 `http://<ROUTER_IP>:5330` 与 `socks5://<ROUTER_IP>:5330` 验证可用。
9. **直连 DNS 容灾与防泄漏**
   - 客户端 `dig @<ROUTER_IP> router.lan` 与 `dig @<ROUTER_IP> singlelabel` 返回 `NXDOMAIN`；正常域名返回 `NOERROR`；
   - 验证 `dns_check` 返回 `wan_dns` 探测结果，且拒绝路由器自身 LAN IP 与回环地址；
   - 测试 DoT/DoH 域名 + `local_bootstrap` IP、以及 `local_backup_server` 配置可正常通过 `sing-box check` 并启动；
   - 验证 `Non-CN` 模式下远程 DNS 异常时 `SERVFAIL`/`REFUSED` 安全回落规则生效。
10. **规则集生命周期与定时更新**
    - 测试 `geosite-cn` 规则集状态、分片上传 `ruleset_upload`（>= 2 片并校验内容与临时文件清理）、`save_ruleset_urls` / `get_ruleset_urls`；
    - 开启 `main.ruleset_auto_update=1`，验证启动后 `/etc/crontabs/root` 写入对应任务，停用后自动清理。
11. **Headscale 原生联调 + Exit Node (`advertise_exit_node: true`)**
    - 在 Debian 客户端起临时 Headscale `v0.25.1`（需带最小本地 `derp.yaml`，见 §5.5）；
    - 路由器应用带 Headscale 端点的配置，确认 `headscale nodes list -o json` 中路由器注册为 `online: true`、分配到 `100.64.x.x` IP、通告了 `192.168.21.0/24`、状态目录 `/etc/sing-box/tailscale/...` 已持久化、Clash `/proxies` 包含该 Tailnet 出口；
    - 额外测试带 `advertise_exit_node: true` 的配置，验证自动生成的入站 53 端口 `hijack-dns` 与私网/通告子网直连规则通过 `sing-box 1.14.4` 加载与运行。
12. **WAN `up` 自动重载 + 真机重启断电自启 + 停机完整恢复**
    - 验证 `service-manager.sh reload_if_running` 在运行中触发重载、停机时不误拉起；
    - 保持 `enabled=1`、`auto_start=1` 执行 `reboot`，等待路由器重启上线后，**不人工干预**验证：`running=true`、`tun_up=true`、`dnsmasq_taken_over=true`、`nft list table inet sing-box` 存在、且 Debian 客户端 DNS 与透明代理流量直接可用；
    - 执行 `service_action("stop")`，验证 `singtun` 与 `table inet sing-box` 彻底清除，且 Debian 客户端执行 `dig @<ROUTER_IP> baidu.com` 仍正常返回 `NOERROR`（证明 `dnsmasq` 恢复正常）。
13. **完整还原**
    - 从 `/root/singsing-hw-backup/` 还原全部配置并删除备份与临时目录；
    - 停止 Debian 端临时代理与 Headscale 并清理 `/tmp`；
    - 确认路由器回到干净停用状态、SSH 正常。

---

## 5. 已知坑点与排障经验（避免重复踩坑）

1. **macOS 无法直接运行 `test:sing-box`**
   - macOS 版 `sing-box` 会报 `auto_redirect is only supported on Linux`。
   - 解法：`vitest` 仍在 macOS 跑（避免 Linux 下缺 `@rollup/rollup-linux-*`），仅把 `SINGSING_SING_BOX` 指向调用 Linux `sing-box 1.14.4` 的包装脚本（例如通过 OrbStack/Docker 运行 Linux 二进制，并确保临时目录路径可互通）。
2. **OpenWrt 25.12 VM 中 `sing-box` 二进制必须是 musl 静态链接版**
   - GitHub 官方 `sing-box-*-linux-arm64`（glibc）在 OpenWrt musl 环境下会报 `/usr/bin/sing-box: not found`；必须使用 `sing-box-1.14.4-linux-arm64-musl`。
3. **OpenWrt Dropbear / BusyBox 常见差异**
   - `scp` 传文件到 OpenWrt 必须加 `-O`（Dropbear 无 `sftp-server`）；
   - BusyBox 没有 `install` 命令，脚本里请用 `cp` + `chmod`；
   - `apk` v3 不支持 `--reinstall`，重装同版本需先 `apk del --no-network --no-scripts luci-app-singsing` 再 `apk add --allow-untrusted --no-network`；
   - QEMU 串口终端单行输入超过 ~250 字符会被截断，务必将测试脚本写入镜像 `/root/test/` 后再执行短命令。
4. **【重点待排查】局域网测试代理在 `sing-box` 运行时的连通性**
   - 路由器默认路由在 `pppoe-WAN`，配置开启 `auto_detect_interface: true` 时，`sing-box` 出站默认绑定 WAN 接口；指向局域网客户端的测试代理节点与 Headscale 端点需在节点/端点 JSON 中加 `"bind_interface": "br-lan"`。
   - 前期在 `v0.1.2`（当时默认 `strict_route=1`）真机测试中，路由器停机时 `curl --socks5 <CLIENT_IP>:18081` 正常返回 `VIA_PROXY_A`，但启动 `sing-box` 后通过 Clash API 测速 `/proxies/proxy-a/delay?url=http%3A%2F%2F1.1.1.1%2Fgenerate_204` 返回 `504 Timeout`（尚未排查完原因即进入 `v0.1.3` 交接）。
   - **排查方向**：
     1. `v0.1.3` 已将默认 `strict_route` 改为 `0`，先直接用 `v0.1.3` 复测；
     2. 在代理回显脚本里打 `accept` 与收包日志，同时在路由器执行 `logread | grep -iE 'sing-box|singsing'` 与 `ip rule show` / `nft list table inet sing-box`，确认到底是 `sing-box` 出站去 `<CLIENT_IP>:18081` 被 TUN/路由表拦住，还是 SOCKS5 握手细节问题；
     3. 若是回显目标 `1.1.1.1` 受路由器策略影响，可改用任意明确走代理的测试域名或检查 `route_exclude_address` 排除 `<CLIENT_IP>/32`。
5. **Headscale v0.25 临时拉起要点**
   - Headscale 启动强制要求非空 DERPMap，需提供最小本地 `derp.yaml`（单 region 指向本机 LAN IP，`stunonly: true`）；
   - `headscale preauthkeys create` 使用用户名（`--user hwtest`）而非数字 ID。
6. **Debian 13 后台进程存活问题**
   - 客户端 `loginctl show-user` 为 `Linger=no`，SSH 命令退出后 `systemd-logind` 会清理该会话的后台进程（即便用了 `nohup` / `setsid`）。
   - 解法：在测试编排脚本里维持一条持久 SSH 会话（末尾 `sleep`）承载临时代理与 Headscale，测试结束时统一 `terminate` 并清理。
7. **其他实测注意点**
   - 即使路由器存在 `/sbin/ujail`，`init.d/singsing` 未启用文件系统 `procd_add_jail` 时 `/proc/$PID/status` 的 `NoNewPrivs` 可能为 `0`，属 OpenWrt `procd` 正常行为；
   - 国内直连 `raw.githubusercontent.com` 偶发 6 秒连接超时，真机测试不要在未备份的情况下删除 `/etc/sing-box/rule-sets/*.srs`，验证规则集自动下载建议使用局域网 HTTP 源或 `ruleset_download_prefix`。

---

## 6. 交付要求

完成全部测试后，建议：

1. 将 `v0.1.3` 的实测结果（自动化测试数、24.10.8 / 25.12.6 VM 结果、真机各项含 `v0.1.3` 新特性结果、发现并修复的问题）同步补充到 `docs/rc1-validation.md`；
2. 若测试中发现代码缺陷，遵循 §1.2 长期开发准则修复、补充单测，并视情况发布 `v0.1.4`；
3. 确认路由器与测试客户端恢复至干净状态且 SSH 正常。
