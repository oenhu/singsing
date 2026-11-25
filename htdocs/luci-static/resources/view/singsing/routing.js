'use strict';
'require view';
'require ui';
'require singsing.api as api';

return view.extend({
	load: function() {
		return Promise.all([
			api.loadActiveProfile(),
			api.getAccessControl().catch(function() { return { access_control: { mode: 'all', clients: [], deviceRules: [] } }; }),
			api.getLanClients().catch(function() { return { clients: [] }; })
		]);
	},

	render: function(data) {
		var loaded = data[0];
		var ac = (data[1] && data[1].access_control) || { mode: 'all', clients: [], deviceRules: [] };
		if (!Array.isArray(ac.clients)) ac.clients = [];
		if (!Array.isArray(ac.deviceRules)) ac.deviceRules = [];
		var lanClients = (data[2] && Array.isArray(data[2].clients)) ? data[2].clients : [];

		var profile = loaded.profile;
		var engine = loaded.engine;
		var profileName = loaded.name;

		var statusBar = E('div', { 'style': 'margin-top:10px;' });
		var rulesTableWrap = E('div', { 'style': 'margin-top:10px;' });

		var notify = function(ok, text) {
			statusBar.innerHTML = '';
			statusBar.appendChild(E('div', {
				'style': 'padding:8px 12px;border-radius:4px;background:' + (ok ? '#f0fdf4' : '#fef2f2') + ';color:' + (ok ? '#166534' : '#991b1b') + ';border:1px solid ' + (ok ? '#86efac' : '#fca5a5') + ';white-space:pre-wrap;font-size:13px;'
			}, text));
		};

		var persist = function(msg) {
			return api.saveProfile(profileName, profile).then(function(res) {
				if (res && res.ok) notify(true, msg || '路由分流配置已保存（请前往「运行概览」点击「生成并应用」）');
				else notify(false, '保存失败：' + ((res && res.error) || '未知错误'));
				renderRulesTable();
			});
		};

		var outboundTargets = function() {
			var list = engine.BUILT_IN_RULE_TARGETS.map(function(t) {
				return { id: t.id, label: t.tag + '（' + t.kind + '）' };
			});
			(profile.groups || []).forEach(function(g) {
				list.push({ id: g.id, label: '[代理组] ' + g.tag });
			});
			(profile.nodes || []).forEach(function(n) {
				list.push({ id: n.id, label: '[节点] ' + n.tag });
			});
			return list;
		};

		var targetLabel = function(id) {
			var found = outboundTargets().find(function(x) { return x.id === id; });
			return found ? found.label : (id || '(未选择)');
		};

		var openRuleModal = function(rule, isNew) {
			var outSel = E('select', { 'class': 'cbi-input-select' },
				[E('option', { 'value': '' }, '-- 请选择出口 --')].concat(
					outboundTargets().map(function(t) {
						return E('option', { 'value': t.id, 'selected': rule.outbound === t.id ? 'selected' : null }, t.label);
					})
				)
			);

			var linesArea = E('textarea', {
				'style': 'width:100%;height:120px;font-family:monospace;font-size:12px;',
				'placeholder': '每行一条域名或 IP/CIDR（如 openai.com、domain:example.com、ip_cidr:1.2.3.0/24）'
			}, (rule.lines || []).join('\n'));

			var sets = (rule.ruleSets || []).map(function(x) { return Object.assign({}, x); });
			var setsListEl = E('div', { 'style': 'margin:6px 0;' });
			var rsInput = E('input', {
				'type': 'text',
				'class': 'cbi-input-text',
				'placeholder': '输入 geosite-openai / geoip-us / 规则集 URL...',
				'style': 'flex:1;'
			});
			var rsContentSel = E('select', { 'class': 'cbi-input-select' }, [
				E('option', { 'value': 'domain' }, '域名规则集'),
				E('option', { 'value': 'ip' }, 'IP 规则集')
			]);
			var suggestEl = E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;' });

			var renderSets = function() {
				setsListEl.innerHTML = '';
				if (!sets.length) {
					setsListEl.appendChild(E('span', { 'style': 'font-size:12px;opacity:0.7;' }, '未添加规则集'));
					return;
				}
				sets.forEach(function(ref, idx) {
					setsListEl.appendChild(E('span', {
						'style': 'display:inline-flex;align-items:center;gap:4px;padding:3px 8px;margin:2px 4px 2px 0;background:#eef2ff;color:#1e3a8a;border:1px solid #c7d2fe;border-radius:4px;font-size:12px;'
					}, [
						ref.source + ' (' + ref.content + ')',
						E('a', {
							'href': '#',
							'style': 'color:#dc2626;font-weight:bold;text-decoration:none;',
							'click': function(ev) {
								ev.preventDefault();
								sets.splice(idx, 1);
								renderSets();
							}
						}, '×')
					]));
				});
			};

			var addSet = function(src, content) {
				var canonical = engine.canonicalSource(src);
				if (!canonical) return;
				if (!sets.some(function(x) { return engine.canonicalSource(x.source) === canonical; })) {
					sets.push({
						source: canonical,
						content: canonical.indexOf('geoip-') === 0 ? 'ip' : (canonical.indexOf('geosite-') === 0 ? 'domain' : (content || 'domain'))
					});
					renderSets();
				}
			};

			var renderSuggestions = function() {
				var q = rsInput.value.trim();
				var items = q ? engine.searchRuleSets(q, 8) : engine.POPULAR_RULE_SETS.map(function(s) { return { source: s }; });
				suggestEl.innerHTML = '';
				items.forEach(function(s) {
					suggestEl.appendChild(E('button', {
						'class': 'btn',
						'style': 'font-size:11px;padding:2px 6px;',
						'click': function(ev) {
							ev.preventDefault();
							addSet(s.source, s.kind === 'geoip' ? 'ip' : 'domain');
							rsInput.value = '';
							renderSuggestions();
						}
					}, s.source + (s.label ? (' (' + s.label + ')') : '')));
				});
			};

			rsInput.addEventListener('input', renderSuggestions);
			renderSets();
			renderSuggestions();

			var errDiv = E('div', { 'style': 'color:#dc2626;font-size:12px;margin-top:6px;' });

			ui.showModal(isNew ? '新增自定义路由规则' : '编辑路由规则', [
				E('div', { 'style': 'margin-bottom:8px;' }, [
					E('label', { 'style': 'display:block;font-weight:600;margin-bottom:4px;' }, '流量出口'),
					outSel
				]),
				E('div', { 'style': 'margin-bottom:8px;' }, [
					E('label', { 'style': 'display:block;font-weight:600;margin-bottom:4px;' }, '域名与 IP / CIDR 列表'),
					linesArea
				]),
				E('div', { 'style': 'margin-bottom:8px;' }, [
					E('label', { 'style': 'display:block;font-weight:600;margin-bottom:4px;' }, '关联规则集（将自动本地化到路由器规则集目录）'),
					setsListEl,
					E('div', { 'style': 'display:flex;gap:6px;margin-top:6px;' }, [
						rsInput,
						rsContentSel,
						E('button', {
							'class': 'btn',
							'click': function(ev) {
								ev.preventDefault();
								addSet(rsInput.value, rsContentSel.value);
								rsInput.value = '';
								renderSuggestions();
							}
						}, '添加')
					]),
					suggestEl
				]),
				errDiv,
				E('div', { 'class': 'right', 'style': 'margin-top:10px;' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, '取消'),
					' ',
					E('button', {
						'class': 'btn cbi-button-action',
						'click': function() {
							if (!outSel.value) {
								errDiv.textContent = '请选择流量出口';
								return;
							}
							var cleanLines = linesArea.value.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
							if (!cleanLines.length && !sets.length) {
								errDiv.textContent = '请至少填写一条域名/IP 或添加一个关联规则集';
								return;
							}
							var parsed = engine.parseRuleList(linesArea.value);
							if (parsed.invalid.length) {
								errDiv.textContent = '域名或 IP 格式有误：' + parsed.invalid.map(function(x) { return x.entry + '（' + x.reason + '）'; }).join('、');
								return;
							}
							var draft = Object.assign({}, rule, {
								outbound: outSel.value,
								lines: cleanLines,
								ruleSets: sets
							});
							if (isNew) {
								profile.settings.rules.push(draft);
							} else {
								var idx = profile.settings.rules.findIndex(function(r) { return r.id === rule.id; });
								if (idx >= 0) profile.settings.rules[idx] = draft;
							}
							ui.hideModal();
							persist('自定义路由规则已保存');
						}
					}, '保存规则')
				])
			]);
		};

		var moveRule = function(idx, delta) {
			var rules = profile.settings.rules;
			var target = idx + delta;
			if (target < 0 || target >= rules.length) return;
			var tmp = rules[idx];
			rules[idx] = rules[target];
			rules[target] = tmp;
			persist('已调整路由规则顺序');
		};

		var renderRulesTable = function() {
			var rules = profile.settings.rules || [];
			var rows = [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, '#'),
					E('th', { 'class': 'th' }, '出口'),
					E('th', { 'class': 'th' }, '域名 / IP 条目'),
					E('th', { 'class': 'th' }, '规则集'),
					E('th', { 'class': 'th' }, '操作')
				])
			];
			if (!rules.length) {
				rows.push(E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td', 'colspan': '5', 'style': 'text-align:center;opacity:0.7;' }, '暂无自定义路由规则（按顺序匹配，优先级高于默认代理列表与分流模式）。')
				]));
			} else {
				rules.forEach(function(r, idx) {
					rows.push(E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td' }, String(idx + 1)),
						E('td', { 'class': 'td' }, E('strong', {}, targetLabel(r.outbound))),
						E('td', { 'class': 'td', 'style': 'font-family:monospace;font-size:12px;' }, (r.lines || []).slice(0, 3).join(', ') + ((r.lines || []).length > 3 ? ' ...' : '')),
						E('td', { 'class': 'td', 'style': 'font-size:12px;' }, (r.ruleSets || []).map(function(x) { return x.source; }).join(', ') || '-'),
						E('td', { 'class': 'td', 'style': 'white-space:nowrap;' }, [
							E('button', { 'class': 'btn', 'disabled': idx === 0 ? 'disabled' : null, 'click': function() { moveRule(idx, -1); } }, '↑'),
							' ',
							E('button', { 'class': 'btn', 'disabled': idx === rules.length - 1 ? 'disabled' : null, 'click': function() { moveRule(idx, 1); } }, '↓'),
							' ',
							E('button', { 'class': 'btn cbi-button-edit', 'click': function() { openRuleModal(r, false); } }, '编辑'),
							' ',
							E('button', {
								'class': 'btn cbi-button-remove',
								'click': function() {
									if (!window.confirm('确定删除这条自定义路由规则吗？')) return;
									profile.settings.rules = profile.settings.rules.filter(function(x) { return x.id !== r.id; });
									persist('已删除路由规则');
								}
							}, '删除')
						])
					]));
				});
			}
			rulesTableWrap.innerHTML = '';
			rulesTableWrap.appendChild(E('table', { 'class': 'table' }, rows));
		};

		var directArea = E('textarea', {
			'style': 'width:100%;height:110px;font-family:monospace;font-size:12px;',
			'placeholder': '每行一条，Global 模式外始终直连（支持域名后缀、domain:、domain_keyword:、domain_regex:、IP/CIDR）'
		}, (profile.settings.directDomains || []).join('\n'));

		var proxyArea = E('textarea', {
			'style': 'width:100%;height:110px;font-family:monospace;font-size:12px;',
			'placeholder': '每行一条，始终走代理出口（Direct 模式外生效）'
		}, (profile.settings.proxyRules || []).join('\n'));

		var steamChk = E('input', { 'type': 'checkbox', 'checked': profile.settings.steam ? 'checked' : null });
		var icloudChk = E('input', { 'type': 'checkbox', 'checked': profile.settings.blockIcloudQuic ? 'checked' : null });

		// ---------------------------------------------------------------
		// 客户端访问控制（局域网设备分流）
		var acModeSel = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': 'all', 'selected': ac.mode === 'all' ? 'selected' : null }, '所有局域网设备按规则代理（默认）'),
			E('option', { 'value': 'allowlist', 'selected': ac.mode === 'allowlist' ? 'selected' : null }, '仅指定设备代理（白名单，其余直连）'),
			E('option', { 'value': 'blocklist', 'selected': ac.mode === 'blocklist' ? 'selected' : null }, '指定设备不代理（黑名单，强制直连）')
		]);
		var acClientsArea = E('textarea', {
			'style': 'width:100%;height:85px;font-family:monospace;font-size:12px;',
			'placeholder': '每行一个 IPv4、IPv6、CIDR 网段或 MAC 地址（例如 192.168.6.50 或 aa:bb:cc:dd:ee:ff）'
		}, (ac.clients || []).join('\n'));
		var acClientsWrap = E('div', { 'style': 'margin-top:8px;display:' + (ac.mode === 'all' ? 'none' : 'block') + ';' }, [
			E('label', { 'style': 'display:block;font-weight:600;margin-bottom:4px;' }, '设备 IP / 网段 / MAC 列表'),
			acClientsArea
		]);
		acModeSel.addEventListener('change', function() {
			acClientsWrap.style.display = acModeSel.value === 'all' ? 'none' : 'block';
		});

		var makeDevicePicker = function(targetTextarea) {
			if (!lanClients.length) return '';
			var sel = E('select', { 'class': 'cbi-input-select', 'style': 'max-width:340px;' },
				[E('option', { 'value': '' }, '-- 从在线局域网设备快速添加 --')].concat(
					lanClients.map(function(c) {
						var label = (c.hostname ? (c.hostname + ' - ') : '') + c.ip + (c.mac ? (' (' + c.mac + ')') : '');
						return E('option', { 'value': c.ip }, label);
					})
				)
			);
			return E('div', { 'style': 'display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap;' }, [
				sel,
				E('button', {
					'class': 'btn',
					'click': function(ev) {
						ev.preventDefault();
						var v = sel.value;
						if (!v) return;
						var cur = targetTextarea.value.split('\n').map(function(x) { return x.trim(); }).filter(Boolean);
						if (cur.indexOf(v) < 0) cur.push(v);
						targetTextarea.value = cur.join('\n');
						sel.value = '';
					}
				}, '添加 IP'),
				E('button', {
					'class': 'btn',
					'click': function(ev) {
						ev.preventDefault();
						var item = lanClients.find(function(c) { return c.ip === sel.value; });
						if (!item || !item.mac) return;
						var cur = targetTextarea.value.split('\n').map(function(x) { return x.trim(); }).filter(Boolean);
						if (cur.indexOf(item.mac) < 0) cur.push(item.mac);
						targetTextarea.value = cur.join('\n');
						sel.value = '';
					}
				}, '添加 MAC')
			]);
		};
		acClientsWrap.appendChild(makeDevicePicker(acClientsArea));

		var devTableWrap = E('div', { 'style': 'margin-top:10px;' });

		var persistAccess = function(msg) {
			return api.saveAccessControl(JSON.stringify(ac, null, 2)).then(function(res) {
				if (res && res.ok) notify(true, msg || '客户端访问控制已保存（请前往「运行概览」点击「生成并应用」）');
				else notify(false, '保存失败：' + ((res && res.error) || '未知错误'));
				renderDeviceRules();
			});
		};

		var outboundTagChoices = function() {
			var tags = ['direct', 'proxy', 'auto'];
			(profile.groups || []).forEach(function(g) { if (tags.indexOf(g.tag) < 0) tags.push(g.tag); });
			(profile.nodes || []).forEach(function(n) { if (tags.indexOf(n.tag) < 0) tags.push(n.tag); });
			(profile.settings.tailnets || []).forEach(function(t) { if (tags.indexOf(t.tag) < 0) tags.push(t.tag); });
			return tags;
		};

		var openDeviceRuleModal = function(dr, isNew) {
			var nameInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': dr.name || '', 'placeholder': '例如 Apple TV 走香港组', 'style': 'width:100%;' });
			var outSel = E('select', { 'class': 'cbi-input-select', 'style': 'width:100%;' },
				outboundTagChoices().map(function(tag) {
					return E('option', { 'value': tag, 'selected': dr.outbound === tag ? 'selected' : null }, tag);
				})
			);
			var clientsArea = E('textarea', {
				'style': 'width:100%;height:95px;font-family:monospace;font-size:12px;',
				'placeholder': '每行一个 IPv4、IPv6、CIDR 或 MAC 地址'
			}, (dr.clients || []).join('\n'));
			var enabledChk = E('input', { 'type': 'checkbox', 'checked': dr.enabled !== false ? 'checked' : null });
			var errDiv = E('div', { 'style': 'color:#dc2626;font-size:12px;margin-top:6px;' });

			ui.showModal(isNew ? '新增设备指定出口规则' : ('编辑设备规则：' + dr.name), [
				E('div', { 'style': 'margin-bottom:8px;' }, [
					E('label', { 'style': 'display:block;font-weight:600;margin-bottom:4px;' }, '规则名称'),
					nameInput
				]),
				E('div', { 'style': 'margin-bottom:8px;' }, [
					E('label', { 'style': 'display:block;font-weight:600;margin-bottom:4px;' }, '指定出口 (outbound tag)'),
					outSel
				]),
				E('div', { 'style': 'margin-bottom:8px;' }, [
					E('label', { 'style': 'display:block;font-weight:600;margin-bottom:4px;' }, '匹配设备（IP / 网段 / MAC）'),
					clientsArea,
					makeDevicePicker(clientsArea)
				]),
				E('div', { 'style': 'margin-bottom:8px;' }, [
					E('label', {}, [enabledChk, ' 启用此规则'])
				]),
				errDiv,
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, '取消'),
					' ',
					E('button', {
						'class': 'btn cbi-button-action',
						'click': function() {
							var lines = clientsArea.value.split('\n').map(function(x) { return x.trim(); }).filter(Boolean);
							var parsed = engine.parseClientEntries(lines);
							if (parsed.invalid.length) {
								errDiv.textContent = '地址格式无效：' + parsed.invalid.join('、');
								return;
							}
							if (!parsed.cidrs.length && !parsed.macs.length) {
								errDiv.textContent = '请至少填写一个设备 IP、网段或 MAC';
								return;
							}
							var draft = {
								id: dr.id || ('dev-' + Math.random().toString(36).slice(2, 10)),
								name: nameInput.value.trim() || outSel.value,
								outbound: outSel.value,
								clients: lines,
								enabled: !!enabledChk.checked
							};
							if (isNew) {
								ac.deviceRules.push(draft);
							} else {
								var idx = ac.deviceRules.findIndex(function(x) { return x.id === dr.id; });
								if (idx >= 0) ac.deviceRules[idx] = draft;
							}
							ui.hideModal();
							persistAccess('设备出口规则「' + draft.name + '」已保存');
						}
					}, '保存')
				])
			]);
		};

		var renderDeviceRules = function() {
			var rows = [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, '规则名称'),
					E('th', { 'class': 'th' }, '设备（IP / MAC）'),
					E('th', { 'class': 'th' }, '指定出口'),
					E('th', { 'class': 'th' }, '状态'),
					E('th', { 'class': 'th' }, '操作')
				])
			];
			if (!ac.deviceRules.length) {
				rows.push(E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td', 'colspan': '5', 'style': 'text-align:center;opacity:0.7;' }, '暂无设备独立出口规则（可为特定设备如 Apple TV / 游戏机指定专属代理组或直连）。')
				]));
			} else {
				ac.deviceRules.forEach(function(dr) {
					rows.push(E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td' }, E('strong', {}, dr.name || '-')),
						E('td', { 'class': 'td', 'style': 'font-family:monospace;font-size:12px;' }, (dr.clients || []).join(', ')),
						E('td', { 'class': 'td' }, E('code', {}, dr.outbound)),
						E('td', { 'class': 'td' }, dr.enabled !== false ? '启用' : '停用'),
						E('td', { 'class': 'td', 'style': 'white-space:nowrap;' }, [
							E('button', { 'class': 'btn cbi-button-edit', 'click': function() { openDeviceRuleModal(dr, false); } }, '编辑'),
							' ',
							E('button', {
								'class': 'btn cbi-button-remove',
								'click': function() {
									if (!window.confirm('确定删除设备规则「' + (dr.name || dr.outbound) + '」吗？')) return;
									ac.deviceRules = ac.deviceRules.filter(function(x) { return x.id !== dr.id; });
									persistAccess('已删除设备规则');
								}
							}, '删除')
						])
					]));
				});
			}
			devTableWrap.innerHTML = '';
			devTableWrap.appendChild(E('table', { 'class': 'table' }, rows));
		};

		this._saveFn = function() {
			var dCheck = engine.parseRuleList(directArea.value);
			var pCheck = engine.parseRuleList(proxyArea.value);
			var acLines = acClientsArea.value.split('\n').map(function(x) { return x.trim(); }).filter(Boolean);
			var acParsed = engine.parseClientEntries(acLines);
			if (dCheck.invalid.length) {
				notify(false, '直连列表格式有误：' + dCheck.invalid.map(function(x) { return x.entry + '（' + x.reason + '）'; }).join('、'));
				return Promise.reject(new Error('invalid direct list'));
			}
			if (pCheck.invalid.length) {
				notify(false, '代理列表格式有误：' + pCheck.invalid.map(function(x) { return x.entry + '（' + x.reason + '）'; }).join('、'));
				return Promise.reject(new Error('invalid proxy list'));
			}
			if (acModeSel.value !== 'all' && acParsed.invalid.length) {
				notify(false, '设备列表格式无效：' + acParsed.invalid.join('、'));
				return Promise.reject(new Error('invalid access control list'));
			}
			profile.settings.directDomains = directArea.value.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
			profile.settings.proxyRules = proxyArea.value.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
			profile.settings.steam = !!steamChk.checked;
			profile.settings.blockIcloudQuic = !!icloudChk.checked;
			ac.mode = acModeSel.value;
			ac.clients = acLines;
			return Promise.all([
				api.saveProfile(profileName, profile),
				api.saveAccessControl(JSON.stringify(ac, null, 2))
			]).then(function(r) {
				if (!r[0] || !r[0].ok) {
					var e1 = (r[0] && r[0].error) || '保存路由规则失败';
					notify(false, e1);
					return Promise.reject(new Error(e1));
				}
				if (!r[1] || !r[1].ok) {
					var e2 = (r[1] && r[1].error) || '保存客户端访问控制失败';
					notify(false, e2);
					return Promise.reject(new Error(e2));
				}
				ui.addNotification(null, E('p', '路由分流与客户端访问控制已保存'), 'info');
				return r;
			});
		};

		renderRulesTable();
		renderDeviceRules();

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, '路由分流与客户端访问控制'),
			E('div', { 'class': 'cbi-map-descr' }, '完整保留上游直连列表、代理列表、有序自定义规则（支持 SagerNet GeoSite / GeoIP 搜索与自定义规则集 URL），并支持基于 sing-box 原生 source_ip_cidr / source_mac_address 的局域网设备分流控制。'),
			statusBar,

			E('div', { 'class': 'cbi-section', 'style': 'margin-top:12px;' }, [
				E('h3', {}, '客户端访问控制（局域网设备代理范围与指定出口）'),
				E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:10px;align-items:center;' }, [
					E('label', { 'style': 'font-weight:600;' }, '代理范围：'),
					acModeSel,
					E('button', {
						'class': 'btn cbi-button-action',
						'click': function() {
							var lines = acClientsArea.value.split('\n').map(function(x) { return x.trim(); }).filter(Boolean);
							var parsed = engine.parseClientEntries(lines);
							if (acModeSel.value !== 'all' && parsed.invalid.length) {
								notify(false, '设备列表格式无效：' + parsed.invalid.join('、'));
								return;
							}
							ac.mode = acModeSel.value;
							ac.clients = lines;
							persistAccess('客户端访问控制模式已保存');
						}
					}, '保存访问控制'),
					E('button', {
						'class': 'btn cbi-button-add',
						'click': function() { openDeviceRuleModal({ enabled: true, outbound: 'proxy', clients: [] }, true); }
					}, '新增设备指定出口')
				]),
				acClientsWrap,
				devTableWrap
			]),

			E('div', { 'class': 'cbi-section', 'style': 'margin-top:12px;' }, [
				E('h3', {}, '自定义直连与代理列表'),
				E('div', { 'style': 'display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;' }, [
					E('div', {}, [
						E('label', { 'style': 'display:block;font-weight:600;margin-bottom:4px;' }, '自定义直连域名 / IP'),
						directArea
					]),
					E('div', {}, [
						E('label', { 'style': 'display:block;font-weight:600;margin-bottom:4px;' }, '自定义代理域名 / IP'),
						proxyArea
					])
				]),
				E('div', { 'style': 'margin-top:10px;display:flex;flex-wrap:wrap;gap:16px;align-items:center;' }, [
					E('label', {}, [steamChk, ' Steam 下载直连（Non-CN 模式下保持 steamcontent.com 直连）']),
					E('label', {}, [icloudChk, ' 禁止 iCloud 使用 QUIC（UDP 443 回退 TCP）']),
					E('button', {
						'class': 'btn cbi-button-action',
						'click': function() {
							var dCheck = engine.parseRuleList(directArea.value);
							var pCheck = engine.parseRuleList(proxyArea.value);
							if (dCheck.invalid.length) {
								notify(false, '直连列表格式有误：' + dCheck.invalid.map(function(x) { return x.entry + '（' + x.reason + '）'; }).join('、'));
								return;
							}
							if (pCheck.invalid.length) {
								notify(false, '代理列表格式有误：' + pCheck.invalid.map(function(x) { return x.entry + '（' + x.reason + '）'; }).join('、'));
								return;
							}
							profile.settings.directDomains = directArea.value.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
							profile.settings.proxyRules = proxyArea.value.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
							profile.settings.steam = !!steamChk.checked;
							profile.settings.blockIcloudQuic = !!icloudChk.checked;
							persist('直连/代理列表与开关已保存');
						}
					}, '保存列表与开关')
				])
			]),

			E('div', { 'class': 'cbi-section', 'style': 'margin-top:16px;' }, [
				E('h3', {}, '有序自定义路由规则（指定节点 / 代理组 / 规则集）'),
				E('div', {}, [
					E('button', {
						'class': 'btn cbi-button-add',
						'click': function() { openRuleModal(engine.newRule(), true); }
					}, '新增路由规则')
				]),
				rulesTableWrap
			])
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
