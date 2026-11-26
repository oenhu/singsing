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
- 验证结束后从本机备份还原路由器配置，5 项基线文件 SHA-256 全部一致，确认 `sing-box` 无残留进程、无 `singtun`、无 `dnsmasq` drop-in。
