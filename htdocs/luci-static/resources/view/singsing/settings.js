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
			api.loadActiveProfile()
		]);
	},

	render: function(data) {
		var loaded = data[1];
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

		o = s.option(form.ListValue, '_default_mode', '默认分流模式', '保存在当前 Profile 中，保留原项目 4 种完整分流策略');
		o.value('GFWList', 'GFWList（仅 GFWList 与自定义代理走代理）');
		o.value('Non-CN', 'Non-CN（国内域名/IP 直连，其余走代理，保留并行 DNS 竞速）');
		o.value('Global', 'Global（除局域网等必要例外外全部走代理）');
		o.value('Direct', 'Direct（全部普通流量直连）');
		o.cfgvalue = function() {
			return (profile && profile.settings && profile.settings.defaultMode) || 'GFWList';
		};
		o.write = function(section_id, value) {
			profile.settings.defaultMode = value;
		};
		o.remove = function() {};

		o = s.option(form.Flag, 'auto_start', '开机自启', '路由器启动时自动运行 sing-box（需同时开启「启用服务」）');
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Flag, 'auto_rollback', '启动失败自动回滚', '新配置启动或健康检查失败时自动恢复上一次有效配置并保护 dnsmasq');
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.ListValue, 'log_level', '日志级别');
		o.value('debug', 'debug');
		o.value('info', 'info');
		o.value('warn', 'warn');
		o.value('error', 'error');
		o.default = 'info';

		o = s.option(form.Value, 'cache_file', '缓存数据库路径（cache.db）', '默认存放在内存盘 /tmp 以保护路由器闪存；x86 或外置存储可自定义持久化路径');
		o.default = '/tmp/singsing/cache.db';
		o.rmempty = false;

		o = s.option(form.Value, 'ruleset_dir', '本地规则集目录', 'sing-box 从此本地目录读取 .srs / .json 规则集文件');
		o.default = '/etc/sing-box/rule-sets';
		o.rmempty = false;

		o = s.option(form.Value, 'ruleset_download_prefix', '规则集下载加速前缀（可选）', '例如 https://ghfast.top/ ；用于首次无代理时自动下载 GitHub 规则集，留空则直连 GitHub');
		o.placeholder = '留空直连 GitHub';

		o = s.option(form.Value, 'tailscale_state_root', 'Tailscale 状态持久化目录', '必须位于闪存持久化目录，防止重启后丢失 Tailscale 登录凭证');
		o.default = '/etc/sing-box/tailscale';
		o.rmempty = false;

		// ---------------------------------------------------------------
		// 2. DNS 设置（分标签页：直连上游 / 本地协调 / 代理上游）
		s = m.section(form.NamedSection, 'dns', 'dns', 'DNS 设置');
		s.tab('direct', '直连上游 DNS（必填）');
		s.tab('local', '本地 DNS 与 dnsmasq 协调');
		s.tab('remote', '代理上游 DNS');

		o = s.taboption('direct', form.ListValue, 'local_type', 'DNS 协议');
		o.value('udp', 'UDP');
		o.value('tcp', 'TCP');
		o.value('tls', 'DoT (TLS)');
		o.value('https', 'DoH (HTTPS)');
		o.default = 'udp';

		o = s.taboption('direct', form.Value, 'local_server', '上游 DNS 地址（必填）',
			'不使用 WAN 自动 DNS；仅支持 IPv4/IPv6（不可填域名或 127.0.0.1 / 路由器 LAN IP）。参考：阿里 223.5.5.5、DNSPod 119.29.29.29、114 114.114.114.114、Cloudflare 1.1.1.1、Google 8.8.8.8。');
		o.placeholder = '例如 223.5.5.5';
		o.rmempty = false;

		o = s.taboption('direct', form.Value, 'local_port', '上游 DNS 端口', 'UDP / TCP 标准端口为 53，DoT 为 853，DoH 为 443');
		o.datatype = 'port';
		o.default = '53';

		o = s.taboption('direct', form.Value, 'local_server_name', 'TLS Server Name (SNI)', '仅 DoT / DoH 协议需要填写，例如 dns.alidns.com');
		o.depends('local_type', 'tls');
		o.depends('local_type', 'https');

		o = s.taboption('direct', form.Value, 'local_path', 'DoH 路径', '仅 DoH 协议需要填写');
		o.default = '/dns-query';
		o.depends('local_type', 'https');

		o = s.taboption('local', form.Value, 'listen_address', 'sing-box DNS 监听地址');
		o.default = '127.0.0.1';
		o.rmempty = false;

		o = s.taboption('local', form.Value, 'listen_port', 'sing-box DNS 监听端口', 'dnsmasq 将外部域名转发至此端口（默认 5335）');
		o.datatype = 'port';
		o.default = '5335';
		o.rmempty = false;

		o = s.taboption('local', form.Flag, 'dnsmasq_manage', '自动接管并恢复 dnsmasq 上游', '启动时仅写内存盘 drop-in 接管上游转发并保留 DHCP/本地域名，停止或异常时自动还原');
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('local', form.Flag, 'hijack', '接管局域网客户端外部 53 端口 DNS', '启用 sing-box 原生 TUN dns_mode: hijack 与 53 端口路由接管');
		o.default = '1';
		o.rmempty = false;

		o = s.taboption('remote', form.ListValue, '_remote_provider', '代理 DNS 服务商');
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

		o = s.taboption('remote', form.ListValue, '_remote_protocol', '加密协议');
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

		o = s.taboption('remote', form.TextValue, '_remote_custom', '自定义代理 DNS JSONC', '仅在服务商选择「自定义 JSON」时生效，默认经 proxy 出口访问');
		o.rows = 8;
		o.depends('_remote_provider', 'custom');
		o.cfgvalue = function() {
			return (profile.settings.remoteDns && profile.settings.remoteDns.custom) || engine.CUSTOM_DNS_TEMPLATE;
		};
		o.write = function(section_id, value) {
			profile.settings.remoteDns.custom = value || '';
		};
		o.remove = function() {};

		o = s.taboption('remote', form.Value, '_client_subnet', 'EDNS Client Subnet（可选）', '发送给代理 DNS 的 ECS 网段，留空则禁用');
		o.placeholder = '例如 1.2.3.0/24';
		o.rmempty = false;
		o.cfgvalue = function() {
			return profile.settings.clientSubnet || '';
		};
		o.write = function(section_id, value) {
			profile.settings.clientSubnet = (value || '').trim();
		};
		o.remove = function() {
			profile.settings.clientSubnet = '';
		};

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

		o = s.option(form.Flag, 'ipv6', '启用 IPv6 接管', '保留原项目精细化 IPv6 DNS 策略，同时通过 TUN 接管客户端直连 IPv6 流量');
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Value, 'address_v6', 'TUN IPv6 网段');
		o.default = 'fdfe:dcba:9876::1/126';
		o.depends('ipv6', '1');

		o = s.option(form.Flag, 'auto_route', 'Auto Route', '自动配置系统路由表');
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Flag, 'auto_redirect', 'Auto Redirect', '使用 sing-box 原生 nftables 规则自动重定向流量（需同时开启 Auto Route）');
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Flag, 'strict_route', 'Strict Route');
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Value, 'mtu', 'MTU（可选）', '留空使用 sing-box 核心默认值');
		o.datatype = 'range(576,65535)';
		o.placeholder = '留空使用核心默认';

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
		return this._map.save().then(function() {
			return Promise.all([
				api.applyUciIfChanged(),
				api.saveProfile(self._loaded.name, self._profile)
			]);
		}).then(function(res) {
			if (!res[1] || !res[1].ok)
				throw new Error((res[1] && res[1].error) || '保存 Profile 失败');
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
