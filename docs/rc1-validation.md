# singsing RC1 真机验收

## 基线与环境

- 测试日期为 2026-11-26。r3 安装包的源码基线为 `16752c6`。
- 路由器 `192.168.21.1` 运行 LibWrt 25.12-SNAPSHOT r0-96a0ec8，目标 qualcommax/ipq60xx，核心为 sing-box 1.14.4（Linux ARM64）。
- Debian 客户端 `192.168.21.2` 通过该路由器发起 DNS 和 HTTPS。故障注入、安装和服务操作在路由器上执行。
- OpenWrt 24.10.8 正式 SDK 的 IPK 和 OpenWrt 25.12.6 正式 SDK 的 APK 构建及包检查已通过。两个官方固件的运行均未验证。此次采用现有硬件。

## 生命周期、升级和卸载

| 检查 | 结果与证据 |
| --- | --- |
| 启动、停止、重启 | 通过。启动时 procd、TUN 和 dnsmasq 转发均就绪。停止后进程、TUN、sing-box nftables 表和 DNS 转发片段消失。重启后取得新 PID。 |
| 正常整机重启、开机自启、Profile 持久化 | 通过。维护窗口内对已通过检查的运行配置执行 `/sbin/reboot`。新 boot ID、SSH 主机指纹和自动启动状态均核对通过。UCI、测试 Profile、运行 JSON 与规则集清单的 SHA-256 不变。客户端复测直连 HTTP 200 和代理 HTTP 204。 |
| Profile 损坏 | 通过。清空临时测试 Profile 后，RPC 返回读取错误，文件未被模板替换，运行 PID 不变。恢复备份后再次读取成功。 |
| 已部署 JSON 损坏 | 通过故障拒绝和人工恢复。真实核心拒绝损坏文件，重启服务后进程保持停止，dnsmasq 接管被清除。用最后有效配置原子替换、执行 `sing-box check` 并启动后，TUN 和 DNS 恢复。 |
| 缺失规则集 | 通过拒绝和恢复。候选引用不存在的 SRS 时，`sing-box check` 拒绝应用，原 PID、活动 JSON、最后有效文件、清单及 DNS 转发保持不变。公开上游下载在本次环境失败。补回已保存 SRS 后核心校验与服务启动通过。随后在路由器上用临时回环镜像验证自动下载，补齐的 SRS 与源文件一致。 |
| r2 → r3 安装升级 | 通过。先在停服状态装回 r2，再由真实 APK 升到 r3。UCI、两个 Profile、运行 JSON、最后有效文件及规则集清单的 SHA-256 保持不变。启动后客户端直连 HTTP 200、代理 HTTP 204。 |
| APK 卸载和客户端恢复 | 网络清理通过。由运行状态卸载后，进程、TUN、sing-box nftables 表、dnsmasq 转发和自启链接均消失。客户端再次读到 `LibWrt.lan` 和外部 A 记录，直连 HTTPS 返回 200。测试 Profile 保留。 |
| APK 卸载的 RPC 清理 | 存在缺陷。包文件与 ACL 文件已从磁盘删除，老的 rpcd 进程仍注册 `luci.singsing`，具有权限的本地调用仍能读取测试 Profile。无会话的 HTTP 请求被拒绝。执行 `/etc/init.d/rpcd reload` 后已验证旧注册消失。 |
| 现场恢复 | 重新安装原始 r3 文件，从独立备份还原原 Profile、UCI 和运行文件，服务恢复为测试前的停用状态。SSH 主机指纹、DHCP 与防火墙文件校验和一致。 |

## IPv6

路由器和客户端均有公网 IPv6 地址及默认路由。重启前，客户端通过公网 IPv6 完成阿里 DNS 的 TLS 握手。重启后运营商更新了委派前缀，客户端一度继续选用先前的临时地址，IPv6 探测超时。将探测进程绑定到已由路由器下发的新前缀后复测，现有网络设置保持原样。

| 检查 | 实际结果 |
| --- | --- |
| IPv6 Direct | `2400:3200::1` 完成 TLS 和 HTTPS，服务返回预期的无参数 HTTP 400，路由日志命中 `route(direct)`。 |
| IPv6 Proxy | `2001:4860:4860::8888` 经测试代理节点访问 Google 的 DNS HTTPS 端点，返回 HTTP 200，日志命中 `route(proxy)`。 |
| IPv6 Reject | `2400:3200:baba::1/128` 的 TLS 连接被重置，路由日志确认 `reject`。 |
| IPv6 DNS | 由 IPv6 发往外部解析器的 UDP 请求被接管。直连的 `example.com`、`www.baidu.com` 获得 AAAA；代理的 `www.gstatic.com` 获得 A，AAAA 按当前策略为空。 |
| 双栈与 IPv4 回退 | 同一直接服务 `dns.alidns.com` 的 IPv4 和 IPv6 都完成 HTTPS。客户端仍选用旧 IPv6 前缀时 IPv4 仍可用；隔离探测的 IPv6 目标超时后改用 IPv4 也成功。未执行断开 WAN IPv6 的测试。 |

现有固件的 dnsmasq 启用了 `filter_aaaa`，其链路本地 DNS 返回空 AAAA。该结果与由 TUN 接管的 IPv6 DNS 分开记录。

## 安全与配置替换

- 路由器上的配置目录与 Profile 目录由 root 持有，模式为 `0700`。测试 Profile、活动 JSON、最后有效 JSON 和清单为 `0600`。UCI 主配置为 `0644`，测试节点凭据保存在受保护的 Profile 和生成 JSON。
- 未登录的 HTTP ubus 请求不能查询状态、读取 Profile、保存 Profile 或应用配置。已登录的管理操作通过。现有设备未配置独立的只读 LuCI 用户，因此委派角色的浏览器权限未单独验证。
- 在该测试配置的运行日志中检查了 2 个实际凭据值，均未出现。带合成令牌的规则集 URL 下载失败时，失败诊断包含完整 URL。该令牌未出现在此次收集的 syslog。分享失败诊断前应移除凭据。
- Shell 语法和 ucode 编译通过。真实服务脚本拒绝 IPv4/IPv6 回环、路由器自身 IPv4、域名和无效 IPv4 作为直连上游 DNS，接受测试用 IPv4、IPv6 地址。
- 成功应用后，运行 JSON 的 inode 发生替换，文件内容与候选一致；失败校验保持活动文件内容、最后有效文件及进程。现场验证覆盖了路径可见的替换效果。

## 自动化与发布判断

本轮 `npm run build`、`npm test` 通过，107 项常规用例通过。基线的 4 项 sing-box 1.14.4 独立二进制用例通过，本轮在真实路由器上重新执行了 1.14.4 的配置校验和失败路径。断电恢复和两个 OpenWrt 官方固件的运行未验证。

r3 建议用于带已知限制的预发布。RC1 验收时曾记录两项待处置问题（卸载 APK 后 rpcd 注册残留、规则集下载失败诊断包含完整 URL）。公开规则集无法在线下载时可先准备离线 SRS。已部署配置损坏后的人工恢复步骤见 README。

### 维护者处置更新（2026-11-26）

保留上述 RC1 验收事实与复现证据，按维护者决定更新处置状态如下：

- **APK 卸载后可能残留 rpcd 注册**：标为**「不处理」**（不再作为发布门槛）。设备部署后通常不卸载，保留已有证据与已验证的手动重载办法 `/etc/init.d/rpcd reload`。
- **规则集下载失败诊断包含原始 URL**：标为**「不处理」**（不再作为发布门槛）。保留现有诊断行为，分享失败诊断前由使用者自行移除 URL 凭据。
- **`.lan` 查询被 sing-box 提前接管**：已接受现有行为，继续保留防止显式远程 DNS 规则将 `.lan` 转发到外部的保护。

### 补充验证：SysRq 硬复位（模拟异常断电恢复，2026-11-26）

在 `192.168.21.1`（LibWrt 25.12-SNAPSHOT）与 Debian 客户端 `192.168.21.2` 上，使用 Linux SysRq 立即硬复位（`echo b > /proc/sysrq-trigger`，跳过 `procd` 优雅停服、`dnsmasq_restore` 与文件系统正常卸载）模拟运行中突然断电（注：属软件触发硬复位模拟，不等同于物理拔电源）：

- **场景一（`enabled=1, auto_start=1` 运行态硬复位）**：在 `sing-box`、`singtun` 与 RAM `dnsmasq` 接管生效时触发硬复位；约 83 秒恢复 SSH 后确认产生新 `boot_id`，`procd` 自动拉起 `sing-box`、`singtun`、`cache.db` 与 `dnsmasq-singsing.conf`，无残留事务文件；5 项持久化配置（UCI、DHCP、防火墙、活动 JSON、规则集清单）SHA-256 全部一致；Debian 客户端 DNS、直连访问及 `tun-in` 规则接管恢复正常，硬复位后再次执行 `apply_config` 通过（无残留锁）。
- **场景二（`enabled=1, auto_start=0` 且 RAM `dnsmasq` 接管生效时硬复位）**：触发第二次硬复位后确认产生新 `boot_id`，`/tmp` 内存盘 `dnsmasq-singsing.conf` 随断电自动清除、`/etc/config/dhcp` 未被修改、`sing-box` 保持停用；Debian 客户端无需任何人工干预即直接恢复正常 DNS 与直连访问（无 DNS 黑洞）。
- 验证结束后从本机备份还原路由器配置，5 项基线文件 SHA-256 全部一致，确认 `sing-box` 无残留进程、无 `singtun`、无 `dnsmasq` drop-in。维护者已确认上述硬复位验证足以覆盖断电恢复场景，不再单独要求物理拔电测试。

### 补充验证：0.1.0-r4 真机专项与官方 OpenWrt 24.10.8 / 25.12.6 QEMU 虚拟机（2026-11-26）

#### 1. LibWrt 25.12-SNAPSHOT 真机（`192.168.21.1` + Debian `192.168.21.2`）
- **r3 → r4 升级与订阅移除验证**：`apk add --allow-untrusted --no-network luci-app-singsing-0.1.0-r4.apk` 升级后，`subscription-updater.uc` 与 `subscriptions.js` 均已移除，测试注入的旧 `# singsing-sub` cron 条目由 `99-singsing` 自动清除，`ubus -v list luci.singsing` 仅保留 20 个核心接口，原有 UCI、Profile、DHCP、防火墙文件 SHA-256 保持一致。
- **首次应用 `last-good` 与 TUN 就绪**：删除旧 `sing-box.last-good.json` 后经 `ubus call luci.singsing apply_config` 应用 `Non-CN` 候选配置，返回 `ok: true`，`sing-box.last-good.json` 立即生成且与活动 JSON 完全一致，`singtun` 与 `dnsmasq` drop-in 同步就绪。
- **Clash API 全生命周期与安全边界**：实测 `GET /version`（`sing-box 1.14.4`）、`PATCH /configs`（`Non-CN` ↔ `GFWList` 返回 `204` 并确认生效）、`PUT /proxies/proxy`（返回 `204` 并确认当前出口切换为 `lab-sel`）、`GET /group/lab-sel/delay`（返回 `200` 未阻塞 `rpcd`）、`GET /connections`、`DELETE /connections`（`204`）；越权请求 `GET /proxies/../restart`、`PUT /configs` 与非 `mode` 的 `PATCH /configs` 均被 `rpcd` 拒绝。
- **并发连通性检测、分片上传与多 Profile**：`connectivity_check` 4 路并发总耗时 2s（国内 `baidu` HTTP 200 / `cn204` HTTP 204 经 `Non-CN` 直连通过）；`ruleset_upload` 2 分片 300KB 二进制上传字节一致并触发 `reloaded: true`，非法 `.json` 被拒绝；多 Profile `save_profile`/`list_profiles`/`get_profile`/`delete_profile` 通过且拒绝删除 `default`。Debian 客户端 `getent hosts www.baidu.com` 经路由器正常解析。还原备份后 4 项基线 SHA-256 一致，无残留进程或接管。

#### 2. 官方 OpenWrt 24.10.8 与 25.12.6 QEMU 虚拟机（`armsr/armv8` + 静态 musl `sing-box 1.14.4`）
- **OpenWrt 24.10.8 (`r29233-443ec4032a`, kernel `6.6.144`, `opkg`)**：
  - 首轮实测发现 24.10.8 的 `ucode-mod-fs`（`2025.07.18`）不导出 `mkdtemp`，导致 `rpcd` 启动加载 `singsing.uc` 失败；已将 `singsing.uc` 改为 `mktemp -d` 并重编 `0.1.0-r4` 包。
  - 修复后在全新 24.10.8 VM 实测：`opkg update && opkg install luci-app-singsing_0.1.0-r4_all.ipk` 自动从官方源安装 `kmod-tun`、`kmod-nft-tproxy`、`kmod-nft-queue`、`curl` 等全部依赖；安装后 `luci.singsing` 无需手动重启 `rpcd` 即注册就绪；`apply_config`、`singtun`、nftables `table inet sing-box`、`/tmp/dnsmasq.cfg01411c.d/dnsmasq-singsing.conf`、`sing-box.last-good.json`、Clash API（`204` 与路径拦截）、分片上传、多 Profile 与 `opkg remove` 清理（停服、撤 TUN、还原 dnsmasq、保留配置）全部通过。
- **OpenWrt 25.12.6 (`r33311-981c978eff`, kernel `6.12.112`, `apk`)**：
  - 全新 25.12.6 VM 实测：`apk update && apk add --allow-untrusted luci-app-singsing-0.1.0-r4.apk` 自动安装 9 个依赖包（含 `kmod-nft-queue`、`kmod-nft-tproxy`、`kmod-tun`、`curl`）；`rpcd` 注册、`apply_config`、`singtun`、nftables `table inet sing-box`、`dnsmasq` drop-in、`last-good`、Clash API（`204` 与安全拦截）、分片上传、多 Profile 与 `apk del` 清理全部通过。


---

### 补充验证：v0.1.3 发布修复回归（`0.1.3-r1` 复现 vs `0.1.3-r2` 验收，2026-11-27）

#### 1. 原始发布包 `0.1.3-r1`（`a5ddb08`）复现记录
在官方 OpenWrt 24.10.8 / 25.12.6 QEMU VM 实测中，原始 `0.1.3-r1` 发布包确认存在以下 4 项问题（此前 README / Release 说明中“v0.1.3 全链路通过”的表述已据此修正）：
1. **有效 DNS 误判拒绝启动**：`service-manager.sh` 的 `check_local_dns` 入口展开 3 个空参数导致跳过 UCI，已配置有效 DNS 时 `write_config` 成功但 `service_action start` 拒绝启动。
2. **24.10 `.ipk` 属主 `1001:1001` 污染**：打包时未优先使用 SDK `staging_dir/host/bin/tar`，归档内 `/etc`、`/etc/init.d`、`/etc/config`、`/usr` 为 `1001:1001`，装包后改写系统目录属主且卸载后残留。
3. **首次开启 `ruleset_auto_update=1` 后 `crond` 未运行**：干净系统无历史 crontab 时 `crond` 未启动，写入 `/etc/crontabs/root` 与 `cron.update` 后任务不会自动触发。
4. **卸载后 `luci.singsing` 仍留在 `ubus`**：卸载包后旧 `rpcd` 仍保留方法注册，需手工执行 `/etc/init.d/rpcd reload`。

#### 2. 本地自动化、核心测试与 `0.1.3-r2` 安装包清单
- **构建与静态检查**：`npm run build` 通过（`tsc --noEmit` + `engine-bundle.js`）；`sh -n`、3 个 JSON 与 11 个 LuCI JS 语法检查全部通过。
- **常规回归测试**：`npm test` **142 项通过 / 0 失败**（较 `b06569d` 基线 139 项新增非 stub `check_local_dns` 命令入口全场景与 `cron_sync`/`cron_remove` 回归）。
- **真实 Linux `sing-box 1.14.4` 核心测试**：`npm run test:sing-box` **9/9 通过**。
- **SDK 打包（非 root UID 1001 环境）与 `verify-openwrt-package.sh` 属主门禁**：
  - `luci-app-singsing_0.1.3-r2_all.ipk` — SHA-256: `ba5452deb7bbeb27445460d0139986cf69da4f90793494078cb642bbc65da092`（`data.tar.gz` 与 `control.tar.gz` 全部条目 `0/0`，含 `postrm`）
  - `luci-app-singsing-0.1.3-r2.apk` — SHA-256: `177abd1e6d30a4d2f6f4594872cb33241fbdddce49c5a73ad628deac5fa67272`（`apk adbdump` 全部条目 `root:root`，含 `post-deinstall`）

#### 3. 两套官方 OpenWrt QEMU VM（`armsr/armv8` + `sing-box 1.14.4`）验收结果

| 验收项 | OpenWrt 24.10.8 (`r29233-443ec4032a`, kernel `6.6.144`, `opkg`) | OpenWrt 25.12.6 (`r33311-981c978eff`, kernel `6.12.112`, `apk`) |
| --- | --- | --- |
| 安装前/后/卸载后系统目录及执行文件属主 | 通过：`/etc`、`/etc/init.d`、`/etc/config`、`/usr`、`/usr/share`、`/usr/share/rpcd` 与执行脚本全程 `0:0` | 通过：同上全程 `0:0` |
| `check_local_dns` 实际命令入口（零参 UCI + 显式传参，16 组用例） | 通过：合法 IPv4/IPv6、空值、回环、LAN IP `192.168.1.1`、DoT/DoH 域名+引导 IP 均符合预期 | 通过：全部 16 组用例符合预期 |
| `write_config` → `start` → `restart` → `apply_config` → 坏配置 `enabled` 回滚 | 通过：`PID 4456 → 5137`，`nofile=1000000`，Linux 6.6 `QUIC_GO_DISABLE_GSO=true`，坏配置启服失败回滚 `enabled=0` | 通过：`PID 4083 → 4761`，`nofile=1000000`，坏配置启服失败回滚 `enabled=0` |
| 首次开启规则集定时更新与实际触发 | 通过：初始无 `crond`，启服后自动拉起 `crond`，重复同步去重仅 1 条，保留 `# keep-me-other`，**实测定时触发更新 `geoip-cn.srs`**，停服仅清理本应用条目 | 通过：同上，**实测定时触发更新 `geoip-cn.srs`**，停服保留其他条目 |
| 整机重启自启（零人工干预） | 通过：重启后 `running: true`、`tun_up: true`、`dnsmasq_taken_over: true`、`table inet sing-box` 自动就绪 | 通过：同上自动就绪 |
| 卸载清理与 `ubus` 注销 | 通过：`opkg remove` 清理进程/TUN/nftables/dnsmasq/cron，**`ubus list luci.singsing` 立即为空**，配置文件保留 | 通过：`apk del` 执行 `pre-deinstall` + `post-deinstall`，全部资源清理、**`ubus list luci.singsing` 立即为空**，配置文件保留 |
| `0.1.1-r1 → 0.1.3-r2` 升级 | 通过：保留 `dns.local_server=218.104.78.2`、运行 JSON 与 `tun.strict_route=1`，补齐 `mixed`/`routing`，`tun.ipv6_mode`/`tun.mtu` 保持 `<unset>`（下次生成按 `direct`/`9000` 生效），`luci.singsing` 保持注册 | 通过：同上（`post-upgrade` 正常执行，不误触卸载注销） |

#### 4. LibWrt 25.12-SNAPSHOT 真机（`192.168.21.1`）与 Debian 客户端（`192.168.21.2`）验收结果
- **真机升级与 ACL**：`0.1.1-r1 → 0.1.3-r2` 覆盖升级成功，原有配置/JSON SHA-256 保持不变，`uhttpd` 静态资源 HTTP 200，`rpcd` 登录会话对 `status`/`write_config`/`apply_config`/`clash_api` 均返回 `access: true`，系统目录属主全为 `0:0`。
- **4 模式实际出口与 `mixed-in`**：通过 Clash API 热切验证 `Non-CN`（`www.baidu.com`/`223.5.5.5` 直连、`example.com`/`1.1.1.1` 走 `proxy-a`）、`GFWList`（`www.google.com` 走 `proxy-a`、`example.com`/`www.baidu.com` 直连）、`Global`（全走 `proxy-a`）、`Direct`（全直连）全部命中预期；`mixed-in`（`:5330`）HTTP 与 SOCKS5 均成功经 `proxy-a` 出口。
- **原生测速（本地可信 HTTPS）**：对可信 HTTPS 端点 `https://192.168.21.2:18443/generate_204` 实测单节点（`proxy-a`、`proxy-b`）与代理组（`/group/proxy/delay` → `{"auto":66,"proxy-a":27,"proxy-b":66}`）均返回 HTTP 200 实际延迟。
- **规则优先级实测矩阵（`port_mode=common`/`custom(80,443)` 与 `block_quic=1`）**：
  - 默认代理（`1.1.1.1`）：允许端口（80 / 8080）走 `proxy-a`，非代理端口（9999）绕过直连，UDP 443 被 `block_quic` 返回 ICMP 拒断。
  - 显式 `s.rules` 代理（`1.0.0.1`、`example.org`）：**非代理端口 9999 仍走 `proxy-a`，UDP 443 仍走 `proxy-a`（不受端口过滤和 `block_quic` 拦截）**。
  - 设备指定代理（`deviceRules -> proxy-b`）：**非代理端口 9999 仍走 `proxy-b`，UDP 443（含 `1.1.1.1` 与 `223.5.5.5`）仍走 `proxy-b`（不受端口过滤和 `block_quic` 拦截）**。
  - 显式直连 / CN 直连（`9.9.9.9`、`www.baidu.com`、`223.5.5.5`）：直连且 UDP 443 不被 `block_quic` 拒断。
  - *注：因存在多种合理语义，本轮保持现有优先级不变，已整理最小调整方案供维护者决策。*
- **MAC 规则冲突与访问控制**：启用 `find_neighbor: true`，Debian 真实 MAC（`28:75:d8:8a:80:03`）配置 `deviceRules -> proxy-b` 时优先于冲突的 `s.rules`（`example.com -> proxy-a`、`1.0.0.1 -> direct`）；MAC 黑名单与白名单（含未列入/已列入对照）均按预期生效。
- **DNS 容灾与防泄漏**：DoH 域名 + 引导 IP（`dns.alidns.com` + `223.5.5.5`）解析正常；`sing-box` `dns-in`（`:5335`）对 `.lan` 与单标签主机返回 `NXDOMAIN`；`local_backup_server` 在主 DNS 返回 `SERVFAIL` 及丢包超时两种故障下均自动回退备用 DNS；`Non-CN` 远程 DNS 返回 `SERVFAIL` 时安全回落 `local`。
- **IPv6 PD 续租与 WAN 重拨**：`ipv6_mode=direct` 下国内 AAAA 与 IPv6 直连 TLS（`2400:3200::1:443`）通过，代理域名 `example.com` AAAA 受 `allow_proxy_ipv6=0` 抑制；`ipv6_mode=ipv4_only` 抑制国内 AAAA；`ifup WAN` 重拨后前缀由 `2408:8244:310:1c98::/64` 续租切换至新前缀并保持 IPv6 直连可用。**待改进观察**：因该 LibWrt 将逻辑 WAN 接口命名为大写 `WAN`（而非小写 `wan`），`ifup WAN` 未命中当前硬编码的 `"wan"` procd trigger，且 `wan_dns` 返回空数组；手工执行 `service-manager.sh reload_if_running` 可正常平滑重载。
- **自建 Headscale 子网与 Exit Node 转发**：在 Debian 自建 Headscale `v0.29.8`（本地可信 HTTPS 嵌入式 DERP），路由器以 `0600` 持久化状态注册上线并通告子网 `10.199.99.0/24` 与 Exit Node（`0.0.0.0/0`、`::/0`）；批准路由后，Debian 对端节点经 Tailscale 隧道成功访问路由器通告子网 `10.199.99.1:80`（HTTP 200）、经 Exit Node 代理转发 `1.1.1.1:80`（`VIA=proxy-a`）、直连转发 `223.5.5.5:80`（HTTP 404）以及 53 端口 TCP DNS 接管（`rcode=0, ancount=1`）。
- **整机重启自启与现场还原**：执行 `/sbin/reboot` 核对新 `boot_id`（`4f777a96-... → 24cf2749-...`），无需人工干预自动恢复 `sing-box`、`singtun`、`dnsmasq` 接管与 `table inet sing-box`，Debian 直连 HTTP 200；验证结束后完整还原备份（4 项基线文件 SHA-256 与测试前完全一致）、清理测试临时文件并复核两台设备 SSH 与外网连通性。
### 补充验证：`0.1.3-r3` 本地候选（2026-11-27）

本轮基线为 `b5308d1`。两套 OpenWrt 正式 SDK 构建和包检查通过。运行验证使用 Debian 上的 QEMU/KVM，固件为官方 OpenWrt 24.10.8（6.6.144，opkg）和 25.12.6（6.12.112，apk），两者均为 `x86/64` 并运行 sing-box 1.14.4。构建通过，150 项常规测试和 9 项真实核心测试通过。

| 安装包 | SHA-256 |
| --- | --- |
| `luci-app-singsing_0.1.3-r3_all.ipk` | `4676559ab888114affc09f7d52367bda3cbfa0cd5fb1def06e65f66e59a2dd3c` |
| `luci-app-singsing-0.1.3-r3.apk` | `f06dd7f99e796b4ddca3dd1624bcf768f056e2cfb3adc557e94477853a41ac27` |

- **规则集定时更新**。两版 VM 都由 `crond` 实际下载并替换了规则集，重复同步只有一条本应用任务。24.10 上验证了系统 cron 已启用但首次开机没有实例时自动启动，以及原生启动失败时记录日志且 sing-box 正常运行。25.12 上验证了 cron 开机自启关闭时任务等待，手动启动 cron 后任务执行，开机自启设置在重启和卸载后继续保持关闭。其他任务保持原样。
- **WAN 事件与 DNS 提示**。`wan`、`WAN`、`fiber_main` 和 `WAN_6` 的实际 `ifup` 事件均触发了运行中的核心重载。通过 PID、TUN、dnsmasq、DNS 查询和 Mixed HTTP 请求验证重载恢复。无默认上联网口时 `wan_dns` 为空，访客接口上线和停机后的 WAN 上线保持原有进程状态。`status` 与 `dns_check` 均返回去重后的 WAN DNS，过滤了回环及路由器自身地址。
- **端口与 QUIC**。常规测试覆盖 common/custom、开启与关闭内核 bypass、默认代理与直连、设备指定代理和显式代理。LuCI 文案与既有规则优先级一致。
- **发布门槛**。两版均复测目录属主、有效 DNS 启动、重启自启、坏配置启动回滚、运行期配置应用失败回滚，以及卸载后清理 RPC、TUN、dnsmasq 接管和热插拔脚本。两版运行中的 `0.1.3-r2 → 0.1.3-r3` 升级均保留配置和运行服务，旧 procd WAN 触发器完成注销。

### 补充验证：`0.1.3-r3` 实机 PPPoE 重拨、IPv6 PD 续租与边界修复（2026-11-27）

在 `2174725` 基础上补充修复并验证以下 3 项：
1. **Tailscale Exit Node 放行规则修复**（`src/adapter/routing.ts`）：同时配置 `advertise_exit_node: true` 与 `advertise_routes` 时，原规则将 `ip_is_private: true` 与 `ip_cidr` 置于同一规则对象导致按逻辑 AND 匹配（非私网通告子网与非通告私网均无法命中）；已改为原生逻辑 `and([inbound, or([ip_is_private, ip_cidr])])`，并在 `exit_node_allow_lan_access: false` 时仍独立放行通告子网。
2. **WAN 热插拔支持地址/前缀变更的 `ifupdate`**（`root/etc/hotplug.d/iface/95-singsing`）：除 `ACTION=ifup` 外，在 `ACTION=ifupdate` 且 `IFUPDATE_ADDRESSES=1` 或 `IFUPDATE_PREFIXES=1` 时触发 `wan_ifup` 重载，常规无变更续租（未设置该标记）仍忽略不重启。
3. **真实 `sing-box 1.14.4` 核心用例扩充**（`tests/sing-box.test.ts`）：新增 4 项 `v0.1.3` 网关特性核心与 Schema 校验用例（Pre-Match Bypass、`geosite-cn`、`route_exclude_cn`、`mixed-in`、`port_mode`、`block_quic`、DoH 域名+引导 IP、备用直连 DNS、3 种 `tun.ipv6_mode` 及 Tailscale Exit Node 通告子网规则）。

- **本地自动化与核心测试**：`npm run build` 通过、`npm test` **151/151 通过**、`npm run test:sing-box` **13/13 通过**（Linux `sing-box 1.14.4`），两套正式 SDK 打包与 `verify-openwrt-package.sh`（含 `0:0` 属主门禁）均通过：
  - `luci-app-singsing_0.1.3-r3_all.ipk` — SHA-256: `199ebc7f6b321e6ba0e3a6c91b8c20c16c15341df4079bb2da9172e2a0ace87d`
  - `luci-app-singsing-0.1.3-r3.apk` — SHA-256: `9f40c9e2b6557efe54593ac0df3879b572f2efc992b2599361385e45116c0c24`
- **LibWrt 25.12-SNAPSHOT 真机（`192.168.21.1`，大写 `WAN` / `WAN_6`）与 Debian 客户端（`192.168.21.2`）实测**：
  - `0.1.1-r1 → 0.1.3-r3` 覆盖升级成功，系统目录及 `95-singsing` 属主全为 `0:0`；`status` 与 `dns_check` 均自动探测并去重大写 `WAN`/`WAN_6` DNS（`218.104.78.2`、`58.242.2.2`、`2408:8000:c000::8888`）。
  - 热插拔精准性：`lan` `ifup` 与无变更的 `WAN_6` `ifupdate` 均保持原 PID（`12430`）不重启；`WAN_6` `ifupdate`（`IFUPDATE_PREFIXES=1`）重载 `12430 → 13116`，`WAN` `ifupdate`（`IFUPDATE_ADDRESSES=1`）重载 `13116 → 13737`。
  - **真实 PPPoE 重拨与运营商 IPv6 PD 续租**：执行 `ifup WAN` 后，`95-singsing` 自动重载 `sing-box`（`13737 → 15125`），随后 `WAN_6` 取得新委派前缀（`2408:8244:210:24b8::/64 → 2408:8244:310:bcb::/64`）并自动完成重载（`15125 → 15988`）；Debian 客户端自动获取新前缀地址 `2408:8244:310:bcb:...`，DNS（`www.baidu.com` `NOERROR`、`router.lan` `NXDOMAIN`）、IPv4 HTTP 与 IPv6 直连 TLS（`2400:3200::1:443`）全部通过。
  - **系统 cron 禁用态尊重与停服还原**：禁用并停止系统 `cron` 后执行 `cron_sync`，保留 `# singsing-ruleset` 计划且不强行开启/拉起 `cron`；停服后 Debian 客户端 `dig @192.168.21.1 www.baidu.com` 恢复 `NOERROR`；还原备份后 4 项基线文件 SHA-256 完全一致。
