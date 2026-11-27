'use strict';
'require view';
'require form';
'require ui';
'require uci';
'require singsing.api as api';

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('singsing'),
			api.loadActiveProfile(),
			api.status().catch(function() { return {}; })
		]);
	},

	render: function(data) {
		var loaded = data[1];
		var statusInfo = data[2] || {};
		var wanDnsList = Array.isArray(statusInfo.wan_dns) ? statusInfo.wan_dns : [];
		var profile = loaded.profile;
		var engine = loaded.engine;
		var m, s, o;

		this._loaded = loaded;
		this._profile = profile;

		m = new form.Map('singsing', '基本设置',
			'统一配置 sing-box 核心运行参数、直连与代理 DNS（必填直连上游 DNS，局域网域名由 dnsmasq 直接解析），以及原生 TUN + Auto Redirect 透明代理。');
		this._map = m;

		// ---------------------------------------------------------------
		// 1. 核心与运行设置
		s = m.section(form.NamedSection, 'main', 'global', '核心与运行设置');

		o = s.option(form.Flag, 'enabled', '启用服务', '开启后将在保存应用或开机时启动 sing-box');
		o.rmempty = false;

		o = s.option(form.Value, 'singbox_bin', 'sing-box 核心路径', '可手动指定自定义路径的 sing-box 1.14+ 可执行文件');
		o.default = '/usr/bin/sing-box';
		o.rmempty = false;

		o = s.option(form.ListValue, '_default_mode', '默认分流模式', '保存在当前 Profile 中，保留原项目 4 种完整分流策略（推荐 Non-CN 绕过中国大陆）');
		o.value('Non-CN', 'Non-CN（国内域名/IP 绕过直连，其余走代理，保留并行 DNS 竞速）');
		o.value('GFWList', 'GFWList（仅 GFWList 与自定义代理走代理）');
		o.value('Global', 'Global（除局域网等必要例外外全部走代理）');
		o.value('Direct', 'Direct（未命中自定义规则的流量直连）');
		o.cfgvalue = function() {
			return (profile && profile.settings && profile.settings.defaultMode) || 'Non-CN';
		};
		o.write = function(section_id, value) {
			profile.settings.defaultMode = value;
		};
		o.remove = function() {};

		o = s.option(form.Flag, 'auto_start', '开机自启', '路由器启动时自动运行 sing-box（需同时开启「启用服务」）');
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Value, 'boot_delay', '开机延时启动（秒）', '路由器开机后延时启动（0 为不延时，最大 300 秒）。无 RTC 电池的路由器建议设 15-30 秒，等待系统对时与 WAN 就绪，且不阻塞系统启动流程。');
		o.datatype = 'range(0,300)';
		o.default = '0';
		o.depends('auto_start', '1');

		o = s.option(form.Flag, 'auto_rollback', '启动失败后恢复原服务', '始终保留上一次有效配置。启用后，应用失败时还会恢复先前正在运行的服务。');
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.ListValue, 'log_level', '日志级别');
		o.value('debug', 'debug');
		o.value('info', 'info');
		o.value('warn', 'warn');
		o.value('error', 'error');
		o.default = 'info';

		o = s.option(form.Value, '_clash_controller', 'Clash API 监听地址',
			'保存在当前 Profile 中，用于运行概览动态切换模式/节点、测速与连接管理。推荐 127.0.0.1:9090（仅本机由 LuCI 安全代理）；如需局域网外部面板直连可填 0.0.0.0:9090 或 [::]:9090（请务必设置密钥）；留空则关闭 Clash API。');
		o.placeholder = '127.0.0.1:9090（留空关闭）';
		o.cfgvalue = function() {
			return (profile && profile.settings && typeof profile.settings.clashController === 'string')
				? profile.settings.clashController : '';
		};
		o.write = function(section_id, value) {
			profile.settings.clashController = String(value || '').trim();
		};
		o.remove = function() {
			profile.settings.clashController = '';
		};

		o = s.option(form.Value, '_clash_secret', 'Clash API 密钥 (Secret)',
			'保存在当前 Profile 中，作为 Clash API 的 Bearer 访问密钥（LuCI 后端代理自动附带；监听 0.0.0.0 / [::] 时强烈建议设置强密钥）。');
		o.password = true;
		o.placeholder = '留空无认证（建议设置强密钥）';
		o.cfgvalue = function() {
			return (profile && profile.settings && typeof profile.settings.clashSecret === 'string')
				? profile.settings.clashSecret : '';
		};
		o.write = function(section_id, value) {
			profile.settings.clashSecret = String(value || '').trim();
		};
		o.remove = function() {
			profile.settings.clashSecret = '';
		};

		o = s.option(form.Value, 'cache_file', '缓存数据库路径（cache.db）', '默认存放在内存盘 /tmp 以保护路由器闪存；x86 或外置存储可自定义持久化路径');
		o.default = '/tmp/singsing/cache.db';
		o.rmempty = false;

		o = s.option(form.Value, 'ruleset_dir', '本地规则集目录', 'sing-box 从此本地目录读取 .srs / .json 规则集文件');
		o.default = '/etc/sing-box/rule-sets';
		o.rmempty = false;

		o = s.option(form.Value, 'ruleset_download_prefix', '规则集下载加速前缀（可选）', '例如 https://ghfast.top/ ；用于首次无代理时自动下载 GitHub 规则集，留空则直连 GitHub');
		o.placeholder = '留空直连 GitHub';

		o = s.option(form.Flag, 'ruleset_auto_update', '定时自动更新本地规则集', '服务启用时由 OpenWrt 系统 cron 定时更新规则集。系统 cron 停止且关闭开机自启时，任务会等待 cron 启动。');
		o.default = '0';
		o.rmempty = false;

		o = s.option(form.Value, 'ruleset_update_cron', '规则集更新计划（Cron）', '标准 5 字段 Cron 表达式，默认每天凌晨 4 点（0 4 * * *）');
		o.default = '0 4 * * *';
		o.depends('ruleset_auto_update', '1');

		o = s.option(form.Value, 'tailscale_state_root', 'Tailscale 状态持久化目录', '必须位于闪存持久化目录，防止重启后丢失 Tailscale 登录凭证');
		o.default = '/etc/sing-box/tailscale';
		o.rmempty = false;

		// ---------------------------------------------------------------
		// 2. DNS 设置（全部展开，明确三部分同时生效，避免误解为三选一）
		s = m.section(form.NamedSection, 'dns', 'dns', 'DNS 设置',
			'以下三部分同时生效，共同组成完整 DNS 分流链路：局域网请求先经「本地 DNS 与 dnsmasq 协调」进入 sing-box，再按分流规则分别发往「直连上游 DNS」（国内/直连域名）与「代理上游 DNS」（境外/代理域名）。');

		var addDnsGroupHeader = function(id, title, desc) {
			var h = s.option(form.DummyValue, id, title);
			h.rawhtml = true;
			h.cfgvalue = function() {
				return '<div style="font-size:12px;opacity:0.8;padding:4px 0;border-bottom:1px solid var(--border-color-medium, rgba(127,127,127,0.25));">' + desc + '</div>';
			};
			h.write = function() {};
			h.remove = function() {};
		};

		addDnsGroupHeader('_dns_grp_direct', '① 直连上游 DNS（必填）', '负责解析国内域名、直连规则以及节点服务器域名；同时生效，与下方代理 DNS 配合分流。');

		var savedDnsType = uci.get('singsing', 'dns', 'local_type') || 'udp';
		var savedDnsPort = uci.get('singsing', 'dns', 'local_port');
		var localPortOption;
		o = s.option(form.ListValue, 'local_type', '直连 DNS 协议');
		o.value('udp', 'UDP');
		o.value('tcp', 'TCP');
		o.value('tls', 'DoT (TLS)');
		o.value('https', 'DoH (HTTPS)');
		o.default = 'udp';
		o.write = function(section_id, value) {
			uci.set('singsing', section_id, 'local_type', value);
			if (value !== savedDnsType && savedDnsPort === String(engine.defaultPortForDnsType(savedDnsType)) &&
				localPortOption.formvalue(section_id) === savedDnsPort) {
				uci.unset('singsing', section_id, 'local_port');
			}
		};

		var wanHint = wanDnsList.length ? (' 当前检测到的 WAN DNS：' + wanDnsList.join('、') + '。') : '';
		o = s.option(form.Value, 'local_server', '直连上游 DNS 地址（必填）',
			'支持 IPv4/IPv6（不可填 127.0.0.1 或路由器 LAN IP）；DoT/DoH 如填域名请同时填写下方引导解析 IP。' + wanHint + '参考：阿里 223.5.5.5、DNSPod 119.29.29.29。');
		o.placeholder = wanDnsList[0] || '例如 223.5.5.5';
		o.rmempty = false;

		o = localPortOption = s.option(form.Value, 'local_port', '直连上游 DNS 端口', '留空使用协议默认端口：UDP / TCP 为 53，DoT 为 853，DoH 为 443。');
		o.datatype = 'port';
		o.placeholder = '协议默认端口';

		o = s.option(form.Value, 'local_server_name', 'TLS Server Name (SNI)', '仅 DoT / DoH 协议需要填写，例如 dns.alidns.com');
		o.depends('local_type', 'tls');
		o.depends('local_type', 'https');

		o = s.option(form.Value, 'local_path', 'DoH 路径', '仅 DoH 协议需要填写');
		o.default = '/dns-query';
		o.depends('local_type', 'https');

		o = s.option(form.Value, 'local_bootstrap', '引导解析 DNS IP（域名模式必填）', '当 DoT/DoH 上游填写域名（如 dns.alidns.com）时，用于解析该域名的直连 IP（如 223.5.5.5）');
		o.placeholder = wanDnsList[0] || '例如 223.5.5.5';
		o.depends('local_type', 'tls');
		o.depends('local_type', 'https');

		o = s.option(form.Value, 'local_backup_server', '备用直连 DNS IP（可选）', '主直连 DNS 超时或返回 SERVFAIL/REFUSED 时自动回退的备用 IPv4/IPv6（留空禁用）');
		o.placeholder = '例如 119.29.29.29';

		addDnsGroupHeader('_dns_grp_remote', '② 代理上游 DNS 与分流策略', '负责经代理出口解析境外与代理规则域名，防止 DNS 污染与泄漏（与上方直连 DNS 同时生效）。');

		o = s.option(form.ListValue, '_remote_provider', '代理 DNS 服务商');
		o.value('google', 'Google (8.8.8.8)');
		o.value('cloudflare', 'Cloudflare (1.1.1.1)');
		o.value('quad9', 'Quad9 (9.9.9.9)');
		o.value('custom', '自定义 JSON');
		o.cfgvalue = function() {
			return (profile.settings.remoteDns && profile.settings.remoteDns.provider) || 'google';
		};
		o.write = function(section_id, value) {
			profile.settings.remoteDns.provider = value;
		};
		o.remove = function() {};

		o = s.option(form.ListValue, '_remote_protocol', '代理 DNS 加密协议');
		o.value('tls', 'DoT (TLS)');
		o.value('https', 'DoH (HTTPS)');
		o.depends('_remote_provider', 'google');
		o.depends('_remote_provider', 'cloudflare');
		o.depends('_remote_provider', 'quad9');
		o.cfgvalue = function() {
			return (profile.settings.remoteDns && profile.settings.remoteDns.protocol) || 'tls';
		};
		o.write = function(section_id, value) {
			profile.settings.remoteDns.protocol = value;
		};
		o.remove = function() {};

		o = s.option(form.TextValue, '_remote_custom', '自定义代理 DNS JSONC', '仅在服务商选择「自定义 JSON」时生效，默认经 proxy 出口访问');
		o.rows = 8;
		o.depends('_remote_provider', 'custom');
		o.cfgvalue = function() {
			return (profile.settings.remoteDns && profile.settings.remoteDns.custom) || engine.CUSTOM_DNS_TEMPLATE;
		};
		o.write = function(section_id, value) {
			profile.settings.remoteDns.custom = value || '';
		};
		o.remove = function() {};

		o = s.option(form.ListValue, 'non_cn_strategy', 'Non-CN 未知域名 DNS 策略', 'geosite-cn 走直连 DNS、gfwlist 走代理 DNS；其余未知域名可选远端校验（防污染、无泄漏）或并行竞速');
		o.value('remote_verify', '远端校验防污染（推荐：先查代理 DNS，命中 CN IP 或失败再回退直连 DNS）');
		o.value('race', '并行竞速（兼容上游：同时查直连与代理 DNS，国内 IP 优先响应）');
		o.default = 'remote_verify';

		o = s.option(form.Flag, 'allow_proxy_ipv6', '允许代理域名返回 IPv6 记录', '默认关闭（推荐，避免无 IPv6 节点下 TUN 假连通）；仅在代理节点全部支持双栈 IPv6 时开启');
		o.default = '0';
		o.rmempty = false;

		o = s.option(form.Value, '_client_subnet', 'EDNS Client Subnet（可选）', '发送给代理 DNS 的 ECS 网段，留空则禁用');
		o.placeholder = '例如 1.2.3.0/24';
		o.cfgvalue = function() {
			return profile.settings.clientSubnet || '';
		};
		o.write = function(section_id, value) {
			profile.settings.clientSubnet = (value || '').trim();
		};
		o.remove = function() {
			profile.settings.clientSubnet = '';
		};

		addDnsGroupHeader('_dns_grp_local', '③ 本地 DNS 与 dnsmasq 协调（高级）', '控制 dnsmasq 与 sing-box 的本地对接方式；一般保持默认即可。');

		o = s.option(form.Value, 'listen_address', 'sing-box DNS 监听地址');
		o.default = '127.0.0.1';
		o.rmempty = false;

		o = s.option(form.Value, 'listen_port', 'sing-box DNS 监听端口', 'dnsmasq 将外部域名转发至此端口（默认 5335）');
		o.datatype = 'port';
		o.default = '5335';
		o.rmempty = false;

		o = s.option(form.Flag, 'dnsmasq_manage', '自动接管并恢复 dnsmasq 上游', '启动时仅写内存盘 drop-in 接管上游转发并保留 DHCP/本地域名，停止或异常时自动还原');
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Flag, 'hijack', '接管局域网客户端外部 53 端口 DNS', '启用 sing-box 原生 TUN dns_mode: hijack 与 53 端口路由接管');
		o.default = '1';
		o.rmempty = false;

		// ---------------------------------------------------------------
		// 3. 透明代理（TUN + Auto Redirect）
		s = m.section(form.NamedSection, 'tun', 'tun', '透明代理（TUN）');

		o = s.option(form.Flag, 'enabled', '启用 TUN 透明代理', '使用 sing-box 1.14+ 原生 Linux TUN + Auto Redirect（兼容 OpenWrt fw4 / nftables）');
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Value, 'interface_name', 'TUN 接口名称');
		o.default = 'singtun';
		o.rmempty = false;

		o = s.option(form.Value, 'address_v4', 'TUN IPv4 网段', '请确保不与现有 LAN 或 VPN 网段冲突');
		o.default = '172.19.0.1/30';
		o.rmempty = false;

		o = s.option(form.Flag, 'ipv6', '启用 IPv6 接管', '通过 TUN 接管客户端 IPv6 流量（直连 IPv6 行为由下方 IPv6 策略控制）');
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Value, 'address_v6', 'TUN IPv6 网段');
		o.default = 'fdfe:dcba:9876::1/126';
		o.depends('ipv6', '1');

		o = s.option(form.ListValue, 'ipv6_mode', '路由器直连 IPv6 策略', '解决 PPPoE/IPv6 PD 场景下默认网卡无公网 IPv6 地址导致的直连 IPv6 误杀');
		o.value('direct', '直连启用 IPv6（推荐，适配 PPPoE / IPv6 PD）');
		o.value('auto', '自动检测默认网卡公网 IPv6（上游默认）');
		o.value('ipv4_only', '仅 IPv4（无公网 IPv6 宽带，直连清空 AAAA）');
		o.default = 'direct';

		o = s.option(form.Flag, 'auto_route', 'Auto Route', '自动配置系统路由表');
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Flag, 'auto_redirect', 'Auto Redirect', '使用 sing-box 原生 nftables 规则自动重定向并支持内核级 Pre-Match Bypass（需同时开启 Auto Route）');
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Flag, 'strict_route', 'Strict Route', 'OpenWrt 路由器默认关闭，避免与多 WAN、IPTV 或 SO_BINDTODEVICE 本地服务冲突');
		o.default = '0';
		o.rmempty = false;

		o = s.option(form.Value, 'mtu', 'MTU（可选）', '推荐 9000 减少用户态拷贝开销；留空使用 sing-box 核心默认值');
		o.datatype = 'range(576,65535)';
		o.default = '9000';
		o.placeholder = '9000';

		o = s.option(form.Value, 'udp_timeout', 'UDP NAT 超时（可选）', '例如 5m、300s；留空使用 sing-box 默认值（5m）');
		o.placeholder = '例如 5m';

		o = s.option(form.Value, 'route_exclude_address', '绕过 TUN 的网段（可选）', '从 TUN 自动路由中排除的 IPv4/IPv6 CIDR 网段，多个用逗号分隔（例如 192.168.100.0/24, 10.8.0.0/16）');
		o.placeholder = '例如 192.168.100.0/24';
		o.validate = function(section_id, value) {
			var v = String(value || '').trim();
			if (!v) return true;
			var items = v.split(/[\s,]+/).map(function(x) { return x.trim(); }).filter(Boolean);
			for (var i = 0; i < items.length; i++) {
				if (!engine.isValidCidr(items[i], 4) && !engine.isValidCidr(items[i], 6)) {
					return '无效的 CIDR 网段格式：' + items[i];
				}
			}
			return true;
		};

		o = s.option(form.Flag, 'route_exclude_cn', '路由表级绕过中国大陆 IP（高级性能模式）', '将 geoip-cn 写入 route_exclude_address_set，中国大陆 IP 连 pre-match 都不进；注意：开启后热切到 Global 模式时国内 IP 仍直连');
		o.default = '0';
		o.rmempty = false;

		o = s.option(form.Value, 'include_interface', '仅监听指定 LAN 接口（可选）', '限制 TUN 仅接管指定接口流量（如 br-lan），避免误接管访客网或 IPTV VLAN，多个用逗号分隔');
		o.placeholder = '留空接管全部接口（如 br-lan）';

		o = s.option(form.Value, 'default_interface', '绑定出站 WAN 接口（可选）', '多 WAN 环境下显式指定默认出站物理/逻辑接口（如 pppoe-wan），留空使用 auto_detect_interface');
		o.placeholder = '留空自动检测（如 pppoe-wan）';

		// ---------------------------------------------------------------
		// 4. 网关 Bypass 与流量边界
		s = m.section(form.NamedSection, 'routing', 'routing', '网关内核 Bypass 与流量边界');

		o = s.option(form.Flag, 'bypass_cn', '启用内核级 Pre-Match Bypass', '在 Auto Redirect 下为中国大陆、私网、直连列表、黑/白名单设备与非代理端口生成原生 action: bypass，免进 sing-box 用户态并保留 4 模式热切换');
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.ListValue, 'cn_site_ruleset', '国内域名规则集', '控制 Non-CN 与大陆绕过使用的国内站点集合');
		o.value('geosite-cn', 'geosite-cn（含 Apple/Microsoft/国内 CDN，推荐）');
		o.value('geosite-geolocation-cn', 'geosite-geolocation-cn（上游默认，仅中国大陆站点）');
		o.default = 'geosite-cn';

		o = s.option(form.ListValue, 'port_mode', '代理目的端口范围', '仅限制默认分流的代理端口，其他端口直连。设备指定代理与自定义代理规则优先，仍可代理这些端口。');
		o.value('all', '全部端口');
		o.value('common', '仅常用端口（20-25,53,80,443,8080,8443 等）');
		o.value('custom', '自定义端口 / 端口段');
		o.default = 'all';

		o = s.option(form.Value, 'custom_ports', '自定义代理端口', '逗号分隔端口或端口段（例如 80,443,8000-8999）');
		o.placeholder = '例如 80,443,8000-8999';
		o.depends('port_mode', 'custom');

		o = s.option(form.ListValue, 'udp_port_mode', 'UDP 代理端口范围（可选分离）', '默认跟随上方代理端口范围；可单独控制 UDP 端口，例如 TCP 代理常用端口、UDP 全放行或仅常用端口（绕过 BT/P2P 高端口 UDP）');
		o.value('follow', '跟随上方代理端口范围（默认）');
		o.value('all', '全部 UDP 端口');
		o.value('common', '仅常用 UDP 端口');
		o.value('custom', '自定义 UDP 端口 / 端口段');
		o.default = 'follow';

		o = s.option(form.Value, 'custom_udp_ports', '自定义 UDP 代理端口', '逗号分隔端口或端口段（例如 53,443,3478-3481）');
		o.placeholder = '例如 53,443,3478-3481';
		o.depends('udp_port_mode', 'custom');

		o = s.option(form.Flag, 'block_quic', '阻断默认代理的 UDP 443（QUIC）', '拒绝默认分流中走代理的 UDP 443，便于应用回退到 TCP/TLS。直连、设备指定代理和自定义代理规则仍按原规则转发。');
		o.default = '0';
		o.rmempty = false;

		// ---------------------------------------------------------------
		// 5. 局域网 Mixed 代理入站（可选）
		s = m.section(form.NamedSection, 'mixed', 'mixed', '局域网代理入站（Mixed HTTP / SOCKS5）');

		o = s.option(form.Flag, 'enabled', '启用 Mixed 混合代理入站', '提供局域网 HTTP + SOCKS5 代理端口（mixed-in），方便未走透明代理的设备或工具手动接入');
		o.default = '0';
		o.rmempty = false;

		o = s.option(form.Value, 'listen_address', '监听地址');
		o.default = '::';
		o.depends('enabled', '1');

		o = s.option(form.Value, 'listen_port', '监听端口');
		o.datatype = 'port';
		o.default = '5330';
		o.depends('enabled', '1');

		return m.render().then(function(mapEl) {
			// 4. 自定义分域 DNS 解析规则
			var rulesWrap = E('div', { 'class': 'cbi-section', 'style': 'margin-top:16px;' });
			var listWrap = E('div', { 'style': 'margin-top:8px;' });
			var msgBox = E('div', { 'style': 'margin-top:8px;' });

			var notify = function(ok, text) {
				msgBox.innerHTML = '';
				msgBox.appendChild(E('div', {
					'style': 'padding:8px 12px;border-radius:4px;background:' + (ok ? '#f0fdf4' : '#fef2f2') + ';color:' + (ok ? '#166534' : '#991b1b') + ';border:1px solid ' + (ok ? '#86efac' : '#fca5a5') + ';'
				}, text));
			};

			var saveRules = function(msg) {
				return api.saveProfile(loaded.name, profile).then(function(res) {
					if (res && res.ok) notify(true, msg || '自定义 DNS 规则已保存');
					else notify(false, '保存失败：' + ((res && res.error) || '未知错误'));
					renderRules();
				});
			};

			var openRuleModal = function(rule, isNew) {
				var srvSel = E('select', { 'class': 'cbi-input-select' }, [
					E('option', { 'value': 'local', 'selected': rule.server === 'local' ? 'selected' : null }, '直连 DNS (local)'),
					E('option', { 'value': 'remote', 'selected': rule.server === 'remote' ? 'selected' : null }, '代理 DNS (remote)'),
					E('option', { 'value': 'tailnet', 'selected': rule.server === 'tailnet' ? 'selected' : null }, 'Tailscale MagicDNS'),
					E('option', { 'value': 'custom', 'selected': rule.server === 'custom' ? 'selected' : null }, '自定义 DNS 服务器 JSON')
				]);
				var tsSel = E('select', { 'class': 'cbi-input-select' },
					(profile.settings.tailnets || []).map(function(t) {
						return E('option', { 'value': t.id, 'selected': rule.tailnet === t.id ? 'selected' : null }, t.tag);
					})
				);
				var tsRow = E('div', { 'style': 'margin:8px 0;display:' + (rule.server === 'tailnet' ? 'block' : 'none') + ';' }, [
					E('label', { 'style': 'display:block;font-weight:600;margin-bottom:4px;' }, '选择 Tailnet'),
					tsSel
				]);
				var customArea = E('textarea', {
					'style': 'width:100%;height:140px;font-family:monospace;font-size:12px;',
					'spellcheck': 'false'
				}, rule.custom || engine.DNS_RULE_TEMPLATE);
				var customRow = E('div', { 'style': 'margin:8px 0;display:' + (rule.server === 'custom' ? 'block' : 'none') + ';' }, [
					E('label', { 'style': 'display:block;font-weight:600;margin-bottom:4px;' }, '自定义 DNS 服务器 JSONC'),
					customArea
				]);
				srvSel.addEventListener('change', function() {
					tsRow.style.display = srvSel.value === 'tailnet' ? 'block' : 'none';
					customRow.style.display = srvSel.value === 'custom' ? 'block' : 'none';
				});

				var linesArea = E('textarea', {
					'style': 'width:100%;height:130px;font-family:monospace;font-size:12px;',
					'placeholder': '每行一个域名（支持 domain: / domain_suffix: / domain_keyword: / domain_regex:）'
				}, (rule.lines || []).join('\n'));
				var errDiv = E('div', { 'style': 'color:#dc2626;font-size:12px;margin-top:6px;' });

				ui.showModal(isNew ? '新增自定义 DNS 分域规则' : '编辑自定义 DNS 规则', [
					E('div', { 'style': 'margin-bottom:8px;' }, [
						E('label', { 'style': 'display:block;font-weight:600;margin-bottom:4px;' }, '解析服务器'),
						srvSel
					]),
					tsRow,
					customRow,
					E('div', { 'style': 'margin-bottom:8px;' }, [
						E('label', { 'style': 'display:block;font-weight:600;margin-bottom:4px;' }, '匹配域名列表'),
						linesArea,
						errDiv
					]),
					E('div', { 'class': 'right' }, [
						E('button', { 'class': 'btn', 'click': ui.hideModal }, '取消'),
						' ',
						E('button', {
							'class': 'btn cbi-button-action',
							'click': function() {
								var cleanLines = linesArea.value.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
								if (!cleanLines.length) {
									errDiv.textContent = '请至少填写一条匹配域名';
									return;
								}
								var parsed = engine.parseDomainList(linesArea.value);
								if (parsed.invalid.length) {
									errDiv.textContent = '域名格式有误：' + parsed.invalid.map(function(x) { return x.entry + '（' + x.reason + '）'; }).join('、');
									return;
								}
								if (srvSel.value === 'tailnet' && !tsSel.value) {
									errDiv.textContent = '请先前往 Tailscale 页面添加至少一个 Tailnet 网络';
									return;
								}
								if (srvSel.value === 'custom') {
									var cRes = engine.customDnsServer(customArea.value, 'dns-rule-test', null);
									if (cRes.error) {
										errDiv.textContent = '自定义 DNS 服务器有误：' + cRes.error;
										return;
									}
								}
								var draft = Object.assign({}, rule, {
									server: srvSel.value,
									tailnet: srvSel.value === 'tailnet' ? tsSel.value : '',
									custom: customArea.value,
									lines: cleanLines
								});
								if (isNew) {
									profile.settings.dnsRules.push(draft);
								} else {
									var idx = profile.settings.dnsRules.findIndex(function(r) { return r.id === rule.id; });
									if (idx >= 0) profile.settings.dnsRules[idx] = draft;
								}
								ui.hideModal();
								saveRules('自定义 DNS 规则已保存');
							}
						}, '保存')
					])
				]);
			};

			var renderRules = function() {
				var rules = profile.settings.dnsRules || [];
				var rows = [
					E('tr', { 'class': 'tr table-titles' }, [
						E('th', { 'class': 'th' }, '#'),
						E('th', { 'class': 'th' }, '解析服务器'),
						E('th', { 'class': 'th' }, '域名条目'),
						E('th', { 'class': 'th' }, '操作')
					])
				];
				if (!rules.length) {
					rows.push(E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td', 'colspan': '4', 'style': 'text-align:center;opacity:0.7;' }, '暂无自定义 DNS 分域规则（优先级高于默认分流 DNS 策略）。')
					]));
				} else {
					rules.forEach(function(r, idx) {
						var srvLabel = r.server === 'tailnet'
							? ('Tailnet: ' + (((profile.settings.tailnets || []).find(function(t) { return t.id === r.tailnet; }) || {}).tag || '(已删除)'))
							: r.server;
						rows.push(E('tr', { 'class': 'tr' }, [
							E('td', { 'class': 'td' }, String(idx + 1)),
							E('td', { 'class': 'td' }, srvLabel),
							E('td', { 'class': 'td', 'style': 'font-family:monospace;font-size:12px;' }, (r.lines || []).slice(0, 4).join(', ') + ((r.lines || []).length > 4 ? ' ...' : '')),
							E('td', { 'class': 'td' }, [
								E('button', { 'class': 'btn cbi-button-edit', 'click': function() { openRuleModal(r, false); } }, '编辑'),
								' ',
								E('button', {
									'class': 'btn cbi-button-remove',
									'click': function() {
										if (!window.confirm('确定删除这条自定义 DNS 规则吗？')) return;
										profile.settings.dnsRules = profile.settings.dnsRules.filter(function(x) { return x.id !== r.id; });
										saveRules('已删除自定义 DNS 规则');
									}
								}, '删除')
							])
						]));
					});
				}
				listWrap.innerHTML = '';
				listWrap.appendChild(E('table', { 'class': 'table' }, rows));
			};

			renderRules();
			rulesWrap.appendChild(E('h3', {}, '自定义分域 DNS 解析规则'));
			rulesWrap.appendChild(E('div', { 'style': 'margin-bottom:8px;' }, [
				E('button', {
					'class': 'btn cbi-button-add',
					'click': function() { openRuleModal(engine.newDnsRule(), true); }
				}, '新增 DNS 规则')
			]));
			rulesWrap.appendChild(msgBox);
			rulesWrap.appendChild(listWrap);
			mapEl.appendChild(rulesWrap);
			return mapEl;
		});
	},

	_persistAll: function() {
		var self = this;
		if (!this._map) return Promise.resolve();
		return this._map.save().catch(function(err) {
			throw new Error('保存表单设置失败：' + (err.message || String(err)));
		}).then(function() {
			return api.applyUciIfChanged();
		}).then(function() {
			return api.saveProfile(self._loaded.name, self._profile);
		}).then(function(res) {
			if (!res || !res.ok)
				throw new Error('保存配置方案失败：' + ((res && res.error) || 'RPC 未确认保存'));
			return res;
		});
	},

	handleSave: function() {
		return this._persistAll().then(function() {
			ui.addNotification(null, E('p', '基本设置已保存'), 'info');
		});
	},

	handleSaveApply: function() {
		return this._persistAll().then(function() {
			return api.applyWithNotify();
		});
	},

	handleReset: function() {
		uci.unload('singsing');
		window.location.reload();
	}
});
