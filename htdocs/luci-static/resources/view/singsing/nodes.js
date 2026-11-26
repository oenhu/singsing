'use strict';
'require view';
'require ui';
'require singsing.api as api';

var RESERVED_TAGS = ['proxy', 'auto', 'direct', 'local', 'remote', 'tun-in', 'dns-in'];

return view.extend({
	load: function() {
		return api.loadActiveProfile();
	},

	render: function(loaded) {
		var profile = loaded.profile;
		var engine = loaded.engine;
		var profileName = loaded.name;
		var searchQuery = '';
		var allUsedTags = function() {
			return RESERVED_TAGS
				.concat(profile.nodes.map(function(x) { return x.tag; }))
				.concat((profile.groups || []).map(function(g) { return g.tag; }))
				.concat((profile.settings.tailnets || []).map(function(t) { return t.tag; }));
		};

		this._saveFn = function() {
			return api.saveProfile(profileName, profile).then(function(res) {
				if (res && res.ok) {
					ui.addNotification(null, E('p', '节点配置已保存'), 'info');
					return res;
				}
				var msg = (res && res.error) || '未知错误';
				ui.addNotification('保存失败', E('p', msg), 'danger');
				return Promise.reject(new Error(msg));
			});
		};

		var titleEl = E('h2', {}, '节点管理（共 ' + profile.nodes.length + ' 个）');
		var tableWrap = E('div', { 'class': 'cbi-section', 'style': 'margin-top:12px;' });
		var statusBar = E('div', { 'style': 'margin-top:10px;' });

		var notify = function(type, text) {
			var fg = type === 'error' ? '#991b1b' : '#166534';
			var bg = type === 'error' ? '#fef2f2' : '#f0fdf4';
			var bd = type === 'error' ? '#fca5a5' : '#86efac';
			statusBar.innerHTML = '';
			statusBar.appendChild(E('div', {
				'style': 'padding:8px 12px;border-radius:4px;background:' + bg + ';color:' + fg + ';border:1px solid ' + bd + ';white-space:pre-wrap;font-size:13px;'
			}, text));
		};

		var persist = function(msg) {
			return api.saveProfile(profileName, profile).then(function(res) {
				if (res && res.ok) notify('success', msg || '节点配置已保存到路由器（请点击底部「保存并应用」或前往「运行概览」使其生效）');
				else notify('error', '保存失败：' + ((res && res.error) || '未知错误'));
				renderTable();
			});
		};

		var detourUsers = function(node) {
			return profile.nodes.filter(function(other) {
				if (other.id === node.id) return false;
				var parsed = engine.nodeObject(other);
				return parsed.object && parsed.object.detour === node.tag;
			});
		};

		var openEditModal = function(node, isNew) {
			var tagInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': node.tag, 'style': 'width:100%;' });
			var inGroupsChk = E('input', { 'type': 'checkbox', 'checked': node.inGroups ? 'checked' : null });
			var bodyArea = E('textarea', {
				'style': 'width:100%;height:260px;font-family:monospace;font-size:12px;',
				'spellcheck': 'false'
			}, node.body);
			var errDiv = E('div', { 'style': 'color:#dc2626;font-size:12px;margin-top:6px;' });

			ui.showModal(isNew ? '新增节点' : ('编辑节点：' + node.tag), [
				E('div', { 'style': 'margin-bottom:8px;' }, [
					E('label', { 'style': 'display:block;font-weight:600;margin-bottom:4px;' }, '节点标签 (tag)'),
					tagInput
				]),
				E('div', { 'style': 'margin-bottom:8px;' }, [
					E('label', {}, [inGroupsChk, ' 加入默认代理组（proxy / auto）'])
				]),
				E('div', { 'style': 'margin-bottom:8px;' }, [
					E('label', { 'style': 'display:block;font-weight:600;margin-bottom:4px;' }, '节点 JSONC 配置（支持注释）'),
					bodyArea,
					errDiv
				]),
				E('div', { 'class': 'right' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, '取消'),
					' ',
					E('button', {
						'class': 'btn cbi-button-action',
						'click': function() {
							var draft = Object.assign({}, node, {
								tag: tagInput.value.trim(),
								inGroups: !!inGroupsChk.checked,
								body: bodyArea.value
							});
							if (!draft.tag) {
								errDiv.textContent = '节点标签不能为空';
								return;
							}
							if (RESERVED_TAGS.indexOf(draft.tag) >= 0) {
								errDiv.textContent = '标签「' + draft.tag + '」为系统保留名称，请换一个';
								return;
							}
							var dup = profile.nodes.some(function(x) { return x.id !== node.id && x.tag === draft.tag; }) ||
								(profile.groups || []).some(function(g) { return g.tag === draft.tag; }) ||
								(profile.settings.tailnets || []).some(function(t) { return t.tag === draft.tag; });
							if (dup) {
								errDiv.textContent = '标签「' + draft.tag + '」已被其他节点、代理组或 Tailnet 使用';
								return;
							}
							var check = engine.nodeObject(draft);
							if (check.error) {
								errDiv.textContent = check.error;
								return;
							}
							if (isNew) {
								profile.nodes.push(draft);
							} else {
								var idx = profile.nodes.findIndex(function(n) { return n.id === node.id; });
								if (idx >= 0) {
									if (draft.tag !== node.tag) {
										detourUsers(node).forEach(function(other) {
											var body = engine.parseJsonc(other.body);
											body.detour = draft.tag;
											other.body = JSON.stringify(body, null, 2);
										});
									}
									profile.nodes[idx] = draft;
								}
							}
							ui.hideModal();
							persist('节点「' + draft.tag + '」已保存');
						}
					}, '保存节点')
				])
			]);
		};

		var openImportModal = function() {
			var area = E('textarea', {
				'style': 'width:100%;height:220px;font-family:monospace;font-size:12px;',
				'placeholder': '粘贴 sing-box JSON、Clash/Mihomo YAML、Base64 订阅内容、SIP008 或分享链接（每行一条）...'
			});
			var errDiv = E('div', { 'style': 'color:#dc2626;font-size:12px;margin-top:6px;' });

			ui.showModal('批量导入节点', [
				E('p', { 'style': 'font-size:12px;opacity:0.8;' }, '复用上游解析器，支持 sing-box JSON / Clash YAML / Mihomo YAML / Base64 / SIP008 / VLESS / VMess / Trojan / SS / Hysteria2 等分享链接。无法转换的字段将明确给出提示。'),
				area,
				errDiv,
				E('div', { 'class': 'right', 'style': 'margin-top:10px;' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, '取消'),
					' ',
					E('button', {
						'class': 'btn cbi-button-action',
						'click': function() {
							var raw = area.value.trim();
							if (!raw) {
								errDiv.textContent = '请粘贴要导入的内容';
								return;
							}
							var rawRes, fitted;
							try {
								rawRes = engine.importConfig(raw);
								fitted = engine.fitImport(rawRes);
							} catch (e) {
								errDiv.textContent = (e && e.message) ? e.message : String(e);
								return;
							}
							if (!fitted.nodes || !fitted.nodes.length) {
								errDiv.textContent = '未识别到可导入的节点';
								return;
							}
							var used = RESERVED_TAGS
								.concat(profile.nodes.map(function(n) { return n.tag; }))
								.concat((profile.groups || []).map(function(g) { return g.tag; }))
								.concat((profile.settings.tailnets || []).map(function(t) { return t.tag; }));
							var renames = {};
							fitted.nodes.forEach(function(n) {
								var orig = n.tag;
								if (used.indexOf(n.tag) >= 0) {
									n.tag = engine.freshTag(n.tag, used);
									renames[orig] = n.tag;
								}
								used.push(n.tag);
							});
							fitted.nodes.forEach(function(n) {
								try {
									var o = JSON.parse(n.body);
									if (typeof o.detour === 'string' && renames[o.detour]) {
										o.detour = renames[o.detour];
										n.body = JSON.stringify(o, null, 2);
									}
								} catch (e) {}
								profile.nodes.push(n);
							});
							ui.hideModal();
							var allNotes = (rawRes.notes || []).concat(
								(fitted.renamed || []).map(function(r) { return '标签重命名：' + r; })
							);
							var warnMsg = allNotes.length
								? ('\n转换提示：\n• ' + allNotes.join('\n• '))
								: '';
							persist('成功导入 ' + fitted.nodes.length + ' 个节点' + warnMsg);
						}
					}, '解析并导入')
				])
			]);
		};

		var moveNode = function(idx, delta) {
			var target = idx + delta;
			if (target < 0 || target >= profile.nodes.length) return;
			var tmp = profile.nodes[idx];
			profile.nodes[idx] = profile.nodes[target];
			profile.nodes[target] = tmp;
			persist('已更新节点顺序');
		};

		var renderTable = function() {
			titleEl.textContent = '节点管理（共 ' + profile.nodes.length + ' 个）';
			var q = searchQuery.trim().toLowerCase();
			var rows = [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, '标签'),
					E('th', { 'class': 'th' }, '协议'),
					E('th', { 'class': 'th' }, '服务器'),
					E('th', { 'class': 'th' }, '加入默认组'),
					E('th', { 'class': 'th' }, '操作')
				])
			];

			var filtered = profile.nodes.map(function(n, idx) {
				var parsed = engine.nodeObject(n);
				var proto = (parsed.object && parsed.object.type) || '配置错误';
				var srv = (parsed.object && (parsed.object.server || parsed.object.address || '-')) || '-';
				return { node: n, idx: idx, proto: proto, srv: String(srv) };
			}).filter(function(item) {
				if (!q) return true;
				return item.node.tag.toLowerCase().indexOf(q) >= 0 ||
					item.proto.toLowerCase().indexOf(q) >= 0 ||
					item.srv.toLowerCase().indexOf(q) >= 0;
			});

			if (!filtered.length) {
				rows.push(E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td', 'colspan': '5', 'style': 'text-align:center;opacity:0.7;' },
						profile.nodes.length ? '没有匹配筛选条件的节点。' : '暂无节点，请点击上方按钮从模板新建或批量导入。')
				]));
			} else {
				filtered.forEach(function(item) {
					var n = item.node;
					var idx = item.idx;
					var toggleChk = E('input', {
						'type': 'checkbox',
						'checked': n.inGroups ? 'checked' : null,
						'change': function() {
							n.inGroups = !!toggleChk.checked;
							persist('已更新节点「' + n.tag + '」默认组设置');
						}
					});

					rows.push(E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td' }, E('strong', {}, n.tag)),
						E('td', { 'class': 'td' }, item.proto),
						E('td', { 'class': 'td' }, item.srv),
						E('td', { 'class': 'td' }, toggleChk),
						E('td', { 'class': 'td', 'style': 'white-space:nowrap;' }, [
							E('button', { 'class': 'btn', 'disabled': idx === 0 ? 'disabled' : null, 'click': function() { moveNode(idx, -1); } }, '↑'),
							' ',
							E('button', { 'class': 'btn', 'disabled': idx === profile.nodes.length - 1 ? 'disabled' : null, 'click': function() { moveNode(idx, 1); } }, '↓'),
							' ',
							E('button', { 'class': 'btn cbi-button-edit', 'click': function() { openEditModal(n, false); } }, '编辑'),
							' ',
							E('button', {
								'class': 'btn',
								'click': function() {
									var used = allUsedTags();
									var copy = engine.newNode({
										tag: engine.freshTag(n.tag, used),
										body: n.body,
										inGroups: n.inGroups
									});
									profile.nodes.splice(idx + 1, 0, copy);
									persist('已复制节点为「' + copy.tag + '」');
								}
							}, '复制'),
							' ',
							E('button', {
								'class': 'btn cbi-button-remove',
								'click': function() {
									var users = detourUsers(n);
									if (users.length) {
										notify('error', '节点仍被 detour 引用：' + users.map(function(user) { return user.tag; }).join('、') + '。请先修改这些节点。');
										return;
									}
									if (!window.confirm('确定删除节点「' + n.tag + '」吗？')) return;
									profile.nodes = profile.nodes.filter(function(x) { return x.id !== n.id; });
									persist('已删除节点「' + n.tag + '」');
								}
							}, '删除')
						])
					]));
				});
			}

			tableWrap.innerHTML = '';
			tableWrap.appendChild(E('table', { 'class': 'table' }, rows));
		};

		var tplSelect = E('select', { 'class': 'cbi-input-select' },
			engine.TEMPLATES.map(function(t) {
				return E('option', { 'value': t.id }, t.label + ' (' + t.id + ')');
			})
		);

		var searchInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'placeholder': '搜索节点标签 / 协议 / 地址...',
			'style': 'min-width:200px;',
			'input': function() {
				searchQuery = searchInput.value;
				renderTable();
			}
		});

		renderTable();

		return E('div', { 'class': 'cbi-map' }, [
			titleEl,
			E('div', { 'class': 'cbi-map-descr' }, '完整保留上游 20+ 协议模板与多格式批量导入。支持搜索、排序、复制、编辑 JSONC 及一键切换是否加入默认代理组。'),
			E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;' }, [
				tplSelect,
				E('button', {
					'class': 'btn cbi-button-add',
					'click': function() {
						var tpl = engine.TEMPLATES.find(function(t) { return t.id === tplSelect.value; }) || engine.TEMPLATES[0];
						var used = allUsedTags();
						var node = engine.newNode({
							tag: engine.freshTag(tpl.tagPrefix, used),
							body: tpl.body
						});
						openEditModal(node, true);
					}
				}, '按模板新建节点'),
				E('button', { 'class': 'btn cbi-button-action', 'click': openImportModal }, '批量导入（Clash / 分享链接 / JSON）'),
				searchInput
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
