'use strict';
'require view';
'require ui';
'require singsing.api as api';

function parseLinesOrCsv(text) {
	return String(text || '')
		.split(/[\n,]+/)
		.map(function(x) { return x.trim(); })
		.filter(Boolean);
}

function parseEndpointSafe(engine, raw) {
	try {
		var o = engine.parseJsonc(raw || '{}');
		if (o && typeof o === 'object' && !Array.isArray(o)) return o;
	} catch (e) {
		// ignore malformed json
	}
	return {};
}

return view.extend({
	load: function() {
		return api.loadActiveProfile();
	},

	render: function(loaded) {
		var profile = loaded.profile;
		var engine = loaded.engine;
		var profileName = loaded.name;
		this._saveFn = function() {
			return api.saveProfile(profileName, profile).then(function(res) {
				if (res && res.ok) {
					ui.addNotification(null, E('p', 'Tailscale 配置已保存'), 'info');
					return res;
				}
				var msg = (res && res.error) || '未知错误';
				ui.addNotification('保存失败', E('p', msg), 'danger');
				return Promise.reject(new Error(msg));
			});
		};

		var statusBar = E('div', { 'style': 'margin-top:10px;' });
		var tableWrap = E('div', { 'class': 'cbi-section', 'style': 'margin-top:12px;' });

		var notify = function(ok, text) {
			statusBar.innerHTML = '';
			statusBar.appendChild(E('div', {
				'style': 'padding:8px 12px;border-radius:4px;background:' + (ok ? '#f0fdf4' : '#fef2f2') + ';color:' + (ok ? '#166534' : '#991b1b') + ';border:1px solid ' + (ok ? '#86efac' : '#fca5a5') + ';white-space:pre-wrap;font-size:13px;'
			}, text));
		};

		var persist = function(msg) {
			return api.saveProfile(profileName, profile).then(function(res) {
				var issues = engine.validate(profile).filter(function(i) { return i.section === 'tailscale'; });
				if (res && res.ok) {
					var warn = issues.length ? ('\n校验提示：\n• ' + issues.map(function(i) { return i.message; }).join('\n• ')) : '';
					notify(true, (msg || 'Tailscale 配置已保存') + warn);
				} else {
					notify(false, '保存失败：' + ((res && res.error) || '未知错误'));
				}
				renderTable();
			});
		};

		var openTailnetModal = function(ts, isNew) {
			var ep = parseEndpointSafe(engine, ts.endpoint);
			var hasCustomServer = !!(ep.control_url && String(ep.control_url).trim());

			var field = function(label, el, desc) {
				return E('div', { 'style': 'margin-bottom:10px;' }, [
					E('label', { 'style': 'display:block;font-weight:600;margin-bottom:3px;font-size:13px;' }, label),
					el,
					desc ? E('div', { 'style': 'font-size:11px;opacity:0.75;margin-top:2px;' }, desc) : ''
				]);
			};

			// Basic fields
			var tagInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': ts.tag || 'ts', 'style': 'width:100%;' });
			var hostnameInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': ep.hostname || 'openwrt-router', 'placeholder': '例如 openwrt-router', 'style': 'width:100%;' });
			var stateDirInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': ep.state_directory || (ts.tag ? ('tailscale-' + ts.tag) : 'tailscale'), 'placeholder': '例如 tailscale-home', 'style': 'width:100%;' });

			// Server mode: Official Tailscale vs Custom Control Server (Headscale)
			var serverModeSel = E('select', { 'class': 'cbi-input-select', 'style': 'width:100%;' }, [
				E('option', { 'value': 'official', 'selected': !hasCustomServer ? 'selected' : null }, 'Tailscale 官方服务器（controlplane.tailscale.com）'),
				E('option', { 'value': 'custom', 'selected': hasCustomServer ? 'selected' : null }, '自定义控制服务器（Headscale / 自建协调服务器）')
			]);
			var controlUrlInput = E('input', {
				'type': 'text',
				'class': 'cbi-input-text',
				'value': ep.control_url || '',
				'placeholder': '例如 https://headscale.example.com',
				'style': 'width:100%;'
			});
			var controlUrlWrap = E('div', { 'style': 'display:' + (hasCustomServer ? 'block' : 'none') + ';' }, [
				field('自定义控制服务器地址 (control_url)', controlUrlInput, '填写完整的 https:// 或 http:// 地址，例如自建 Headscale 域名')
			]);
			serverModeSel.addEventListener('change', function() {
				controlUrlWrap.style.display = serverModeSel.value === 'custom' ? 'block' : 'none';
			});

			var authKeyInput = E('input', {
				'type': 'password',
				'class': 'cbi-input-text',
				'value': ep.auth_key || '',
				'placeholder': '可选：tskey-auth-... 或 Headscale Pre-Auth Key（留空则在日志中查看登录链接）',
				'style': 'width:100%;'
			});

			// Routing & Exit Node
			var acceptRoutesChk = E('input', { 'type': 'checkbox', 'checked': ep.accept_routes !== false ? 'checked' : null });
			var advertiseExitChk = E('input', { 'type': 'checkbox', 'checked': ep.advertise_exit_node ? 'checked' : null });
			var allowLanChk = E('input', { 'type': 'checkbox', 'checked': ep.exit_node_allow_lan_access ? 'checked' : null });
			var ephemeralChk = E('input', { 'type': 'checkbox', 'checked': ep.ephemeral ? 'checked' : null });

			var magicChk = E('input', { 'type': 'checkbox', 'checked': ts.magicDns ? 'checked' : null });
			var defResChk = E('input', { 'type': 'checkbox', 'checked': ts.acceptDefaultResolvers ? 'checked' : null });
			var asProxyChk = E('input', { 'type': 'checkbox', 'checked': ts.asProxy ? 'checked' : null });

			var exitNodeInput = E('input', {
				'type': 'text',
				'class': 'cbi-input-text',
				'value': ts.exitNode || '',
				'placeholder': '可选：出口节点名称或 Tailscale IP（如 office-gw 或 100.64.0.1）',
				'style': 'width:100%;'
			});

			var advRoutesInput = E('input', {
				'type': 'text',
				'class': 'cbi-input-text',
				'value': Array.isArray(ep.advertise_routes) ? ep.advertise_routes.join(', ') : '',
				'placeholder': '可选：向 Tailnet 通告的本地网段，多个用逗号分隔（如 192.168.6.0/24）',
				'style': 'width:100%;'
			});

			var advTagsInput = E('input', {
				'type': 'text',
				'class': 'cbi-input-text',
				'value': Array.isArray(ep.advertise_tags) ? ep.advertise_tags.join(', ') : (ep.advertise_tags || ''),
				'placeholder': '可选：ACL 标签，多个用逗号分隔（如 tag:router）',
				'style': 'width:100%;'
			});

			var extraRoutesArea = E('textarea', {
				'style': 'width:100%;height:75px;font-family:monospace;font-size:12px;',
				'placeholder': '可选：额外通过此 Tailnet 访问的域名或 IP/CIDR（每行一条）'
			}, (ts.routes || []).join('\n'));

			var errDiv = E('div', { 'style': 'color:#dc2626;font-size:12px;margin-top:6px;' });

			ui.showModal(isNew ? '新增 Tailscale 网络' : ('编辑 Tailnet：' + ts.tag), [
				E('div', { 'style': 'max-height:70vh;overflow:auto;padding-right:4px;' }, [
					E('div', { 'style': 'display:grid;grid-template-columns:1fr 1fr;gap:10px;' }, [
						field('端点标签 (tag)', tagInput, '唯一标识，例如 home / work / headscale'),
						field('设备名称 (hostname)', hostnameInput, '在控制面板中显示的设备名')
					]),
					field('控制服务器类型', serverModeSel),
					controlUrlWrap,
					field('预授权密钥 (auth_key，可选)', authKeyInput, '填写后可自动登录无需手动点链接；留空则首次启动后在「运行日志」查看授权 URL'),
					field('状态目录名 (state_directory)', stateDirInput, '每个 Tailnet 需独立目录，相对路径将自动持久化保存到配置的 Tailscale 状态根目录下'),
					E('div', { 'style': 'margin:10px 0;padding:8px 10px;background:var(--background-color-high, rgba(127,127,127,0.05));border:1px solid var(--border-color-medium, rgba(127,127,127,0.25));border-radius:4px;' }, [
						E('div', { 'style': 'font-weight:600;font-size:13px;margin-bottom:6px;' }, 'DNS 与路由开关'),
						E('div', { 'style': 'display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:13px;' }, [
							E('label', {}, [magicChk, ' 启用 MagicDNS / Split DNS']),
							E('label', {}, [defResChk, ' 使用 Tailnet 默认 DNS']),
							E('label', {}, [acceptRoutesChk, ' 接收子网路由 (accept_routes)']),
							E('label', {}, [asProxyChk, ' 加入 proxy 代理选择器']),
							E('label', {}, [advertiseExitChk, ' 本机作为出口节点通告']),
							E('label', {}, [allowLanChk, ' 出口节点允许访问局域网']),
							E('label', {}, [ephemeralChk, ' 临时节点模式 (ephemeral)'])
						])
					]),
					field('使用出口节点 (exit_node，可选)', exitNodeInput),
					field('通告本地子网路由 (advertise_routes，可选)', advRoutesInput),
					field('节点 ACL 标签 (advertise_tags，可选)', advTagsInput),
					field('额外分流到该 Tailnet 的域名 / IP（可选）', extraRoutesArea)
				]),
				errDiv,
				E('div', { 'class': 'right', 'style': 'margin-top:10px;' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, '取消'),
					' ',
					E('button', {
						'class': 'btn cbi-button-action',
						'click': function() {
							var tag = tagInput.value.trim();
							if (!tag) {
								errDiv.textContent = '端点标签不能为空';
								return;
							}
							if (['proxy', 'auto', 'direct', 'local', 'remote', 'tun-in', 'dns-in'].indexOf(tag) >= 0) {
								errDiv.textContent = '标签「' + tag + '」为系统保留名称，请换一个';
								return;
							}
							var dup = (profile.settings.tailnets || []).some(function(x) { return x.id !== ts.id && x.tag === tag; }) ||
								(profile.nodes || []).some(function(n) { return n.tag === tag; }) ||
								(profile.groups || []).some(function(g) { return g.tag === tag; });
							if (dup) {
								errDiv.textContent = '标签「' + tag + '」已被其他 Tailnet、节点或代理组使用';
								return;
							}
							var controlUrl = serverModeSel.value === 'custom' ? controlUrlInput.value.trim() : '';
							if (serverModeSel.value === 'custom' && !/^https?:\/\/\S+$/i.test(controlUrl)) {
								errDiv.textContent = '自定义控制服务器地址必须以 http:// 或 https:// 开头';
								return;
							}
							var rCheck = engine.parseRuleList(extraRoutesArea.value);
							if (rCheck.invalid.length) {
								errDiv.textContent = '额外路由格式有误：' + rCheck.invalid.map(function(x) { return x.entry + '（' + x.reason + '）'; }).join('、');
								return;
							}
							var stateDirVal = stateDirInput.value.trim() || ('tailscale-' + tag);
							if (stateDirVal.split('/').indexOf('..') >= 0) {
								errDiv.textContent = '状态目录名不能包含上级目录 ..';
								return;
							}
							if (advertiseExitChk.checked && exitNodeInput.value.trim()) {
								errDiv.textContent = '不能同时设置使用出口节点（exit_node）和本机作为出口节点通告（advertise_exit_node）';
								return;
							}
							var advRoutes = parseLinesOrCsv(advRoutesInput.value);
							var badAdv = advRoutes.filter(function(r) {
								return !engine.isValidCidr(r, 4) && !engine.isValidCidr(r, 6);
							});
							if (badAdv.length) {
								errDiv.textContent = '通告本地子网路由必须是有效的 CIDR 网段（如 192.168.6.0/24）：' + badAdv.join('、');
								return;
							}

							// Preserve any extra custom fields from existing endpoint JSON while updating form fields
							var nextEp = Object.assign({}, ep);
							delete nextEp.type;
							delete nextEp.tag;
							delete nextEp.exit_node;

							nextEp.state_directory = stateDirVal;
							var host = hostnameInput.value.trim();
							if (host) nextEp.hostname = host; else delete nextEp.hostname;

							if (controlUrl) nextEp.control_url = controlUrl; else delete nextEp.control_url;

							var authKey = authKeyInput.value.trim();
							if (authKey) nextEp.auth_key = authKey; else delete nextEp.auth_key;

							nextEp.accept_routes = !!acceptRoutesChk.checked;
							if (advertiseExitChk.checked) nextEp.advertise_exit_node = true; else delete nextEp.advertise_exit_node;
							if (allowLanChk.checked) nextEp.exit_node_allow_lan_access = true; else delete nextEp.exit_node_allow_lan_access;
							if (ephemeralChk.checked) nextEp.ephemeral = true; else delete nextEp.ephemeral;

							if (advRoutes.length) nextEp.advertise_routes = advRoutes; else delete nextEp.advertise_routes;

							var advTags = parseLinesOrCsv(advTagsInput.value);
							if (advTags.length) nextEp.advertise_tags = advTags; else delete nextEp.advertise_tags;

							var draft = Object.assign({}, ts, {
								tag: tag,
								magicDns: !!magicChk.checked,
								acceptDefaultResolvers: !!defResChk.checked,
								asProxy: !!asProxyChk.checked,
								exitNode: exitNodeInput.value.trim(),
								endpoint: JSON.stringify(nextEp, null, 2),
								routes: extraRoutesArea.value.split('\n').map(function(l) { return l.trim(); }).filter(Boolean)
							});

							if (isNew) {
								profile.settings.tailnets.push(draft);
							} else {
								var idx = profile.settings.tailnets.findIndex(function(t) { return t.id === ts.id; });
								if (idx >= 0) profile.settings.tailnets[idx] = draft;
							}
							ui.hideModal();
							persist('Tailnet「' + draft.tag + '」已保存');
						}
					}, '保存 Tailnet')
				])
			]);
		};

		var renderTable = function() {
			var list = profile.settings.tailnets || [];
			var rows = [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, '标签'),
					E('th', { 'class': 'th' }, '控制服务器'),
					E('th', { 'class': 'th' }, '设备名'),
					E('th', { 'class': 'th' }, 'MagicDNS'),
					E('th', { 'class': 'th' }, '出口节点'),
					E('th', { 'class': 'th' }, '状态目录'),
					E('th', { 'class': 'th' }, '操作')
				])
			];

			if (!list.length) {
				rows.push(E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td', 'colspan': '7', 'style': 'text-align:center;opacity:0.7;' }, '暂未配置 Tailscale 网络。支持官方 Tailscale 与自建 Headscale 控制服务器，无需手动编写 JSON。')
				]));
			} else {
				list.forEach(function(t) {
					var ep = parseEndpointSafe(engine, t.endpoint);
					rows.push(E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td' }, E('strong', {}, t.tag)),
						E('td', { 'class': 'td', 'style': 'font-size:12px;' }, ep.control_url ? ep.control_url : '官方 Tailscale'),
						E('td', { 'class': 'td' }, ep.hostname || '-'),
						E('td', { 'class': 'td' }, t.magicDns ? '开启' : '关闭'),
						E('td', { 'class': 'td' }, t.exitNode || '-'),
						E('td', { 'class': 'td', 'style': 'font-family:monospace;font-size:12px;' }, String(ep.state_directory || 'tailscale')),
						E('td', { 'class': 'td', 'style': 'white-space:nowrap;' }, [
							E('button', { 'class': 'btn cbi-button-edit', 'click': function() { openTailnetModal(t, false); } }, '编辑'),
							' ',
							E('button', {
								'class': 'btn cbi-button-remove',
								'click': function() {
									if (!window.confirm('确定删除 Tailnet「' + t.tag + '」吗？')) return;
									profile.settings.tailnets = profile.settings.tailnets.filter(function(x) { return x.id !== t.id; });
									persist('已删除 Tailnet「' + t.tag + '」');
								}
							}, '删除')
						])
					]));
				});
			}

			tableWrap.innerHTML = '';
			tableWrap.appendChild(E('table', { 'class': 'table' }, rows));
		};

		renderTable();

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, 'Tailscale 多网络端点'),
			E('div', { 'class': 'cbi-map-descr' }, '图形化配置多 Tailnet、自建 Headscale 控制服务器（control_url）、预授权密钥（auth_key）、MagicDNS、子网路由与出口节点。使用 sing-box 内置端点，无需安装系统级 Tailscale 客户端。'),
			E('div', {}, [
				E('button', {
					'class': 'btn cbi-button-add',
					'click': function() {
						var used = ['proxy', 'auto', 'direct', 'local', 'remote', 'tun-in', 'dns-in']
							.concat((profile.settings.tailnets || []).map(function(t) { return t.tag; }))
							.concat((profile.nodes || []).map(function(n) { return n.tag; }))
							.concat((profile.groups || []).map(function(g) { return g.tag; }));
						var tag = engine.freshTag('ts', used);
						openTailnetModal(engine.newTailnet({
							tag: tag,
							endpoint: JSON.stringify({
								state_directory: 'tailscale-' + tag,
								hostname: 'openwrt-router',
								accept_routes: true
							}, null, 2)
						}), true);
					}
				}, '新增 Tailnet')
			]),
			statusBar,
			tableWrap
		]);
	},

	handleSave: function() {
		return this._saveFn ? this._saveFn() : Promise.resolve();
	},

	handleSaveApply: function() {
		return this.handleSave().then(function() { return api.applyWithNotify(); });
	},

	handleReset: function() {
		window.location.reload();
	}
});
