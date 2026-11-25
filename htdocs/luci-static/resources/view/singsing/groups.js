'use strict';
'require view';
'require ui';
'require singsing.api as api';

return view.extend({
	load: function() {
		return api.loadActiveProfile();
	},

	render: function(loaded) {
		var profile = loaded.profile;
		var engine = loaded.engine;
		var profileName = loaded.name;

		var statusBar = E('div', { 'style': 'margin-top:10px;' });
		var proxyBox = E('div', { 'class': 'cbi-section', 'style': 'margin-top:12px;' });
		var tableWrap = E('div', { 'class': 'cbi-section', 'style': 'margin-top:12px;' });

		var notify = function(ok, text) {
			statusBar.innerHTML = '';
			statusBar.appendChild(E('div', {
				'style': 'padding:8px 12px;border-radius:4px;background:' + (ok ? '#f0fdf4' : '#fef2f2') + ';border:1px solid ' + (ok ? '#86efac' : '#fca5a5') + ';white-space:pre-wrap;font-size:13px;'
			}, text));
		};

		var persist = function(msg) {
			return api.saveProfile(profileName, profile).then(function(res) {
				var issues = engine.validate(profile).filter(function(i) { return i.section === 'groups'; });
				if (res && res.ok) {
					var warn = issues.length ? ('\n校验提示：\n• ' + issues.map(function(i) { return i.message; }).join('\n• ')) : '';
					notify(true, (msg || '代理组配置已保存') + warn);
				} else {
					notify(false, '保存失败：' + ((res && res.error) || '未知错误'));
				}
				renderProxySettings();
				renderTable();
			});
		};

		var allCandidates = function(excludeGroupId) {
			var list = [];
			(profile.nodes || []).forEach(function(n) {
				list.push({ id: n.id, label: '[节点] ' + n.tag, tag: n.tag });
			});
			(profile.settings.tailnets || []).forEach(function(t) {
				list.push({ id: t.id, label: '[Tailnet] ' + t.tag, tag: t.tag });
			});
			(profile.groups || []).forEach(function(g) {
				if (g.id !== excludeGroupId) {
					list.push({ id: g.id, label: '[代理组] ' + g.tag, tag: g.tag });
				}
			});
			return list;
		};

		var memberTagById = function(id) {
			var c = allCandidates(null).find(function(x) { return x.id === id; });
			return c ? c.tag : '(已删除)';
		};

		var openGroupModal = function(group, isNew) {
			var tagInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': group.tag, 'style': 'width:100%;' });
			var typeSel = E('select', { 'class': 'cbi-input-select' }, [
				E('option', { 'value': 'selector', 'selected': group.type === 'selector' ? 'selected' : null }, '手动选择 (selector)'),
				E('option', { 'value': 'urltest', 'selected': group.type === 'urltest' ? 'selected' : null }, '自动测速 (urltest)')
			]);

			var selectedIds = (group.members || []).slice();
			var candidates = allCandidates(group.id);
			var filterInput = E('input', {
				'type': 'text',
				'class': 'cbi-input-text',
				'placeholder': '按关键字快速筛选并勾选成员（如 香港 / JP / 节点名）...',
				'style': 'width:100%;margin-bottom:6px;'
			});
			var membersBox = E('div', {
				'style': 'max-height:180px;overflow:auto;border:1px solid #ddd;border-radius:4px;padding:8px;background:#fafafa;'
			});

			var defSel = E('select', { 'class': 'cbi-input-select' });
			var refreshDefaultOptions = function() {
				defSel.innerHTML = '';
				defSel.appendChild(E('option', { 'value': '' }, '（默认第一项）'));
				selectedIds.forEach(function(id) {
					defSel.appendChild(E('option', {
						'value': id,
						'selected': group.defaultMember === id ? 'selected' : null
					}, memberTagById(id)));
				});
			};

			var renderMemberCheckboxes = function() {
				var kw = filterInput.value.trim().toLowerCase();
				membersBox.innerHTML = '';
				candidates.forEach(function(c) {
					if (kw && c.label.toLowerCase().indexOf(kw) < 0) return;
					var chk = E('input', {
						'type': 'checkbox',
						'checked': selectedIds.indexOf(c.id) >= 0 ? 'checked' : null,
						'change': function() {
							if (chk.checked) {
								if (selectedIds.indexOf(c.id) < 0) selectedIds.push(c.id);
							} else {
								selectedIds = selectedIds.filter(function(x) { return x !== c.id; });
							}
							refreshDefaultOptions();
						}
					});
					membersBox.appendChild(E('div', { 'style': 'margin-bottom:4px;' }, [
						E('label', {}, [chk, ' ', c.label])
					]));
				});
			};

			filterInput.addEventListener('input', renderMemberCheckboxes);
			renderMemberCheckboxes();
			refreshDefaultOptions();

			var testUrlInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': group.testUrl || '', 'placeholder': '默认 https://www.gstatic.com/generate_204', 'style': 'width:100%;' });
			var intervalInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': group.interval || '', 'placeholder': '默认 3m（例如 30s、5m）', 'style': 'width:100%;' });
			var tolInput = E('input', { 'type': 'number', 'class': 'cbi-input-text', 'value': group.tolerance !== null && group.tolerance !== undefined ? String(group.tolerance) : '', 'placeholder': '默认 50（毫秒）', 'style': 'width:100%;' });

			var selectorRow = E('div', { 'style': 'margin:8px 0;display:' + (group.type === 'selector' ? 'block' : 'none') + ';' }, [
				E('label', { 'style': 'display:block;font-weight:600;margin-bottom:4px;' }, '默认选中成员'),
				defSel
			]);
			var urltestBox = E('div', { 'style': 'margin:8px 0;display:' + (group.type === 'urltest' ? 'block' : 'none') + ';' }, [
				E('div', { 'style': 'margin-bottom:6px;' }, [E('label', { 'style': 'display:block;font-weight:600;' }, '测速 URL'), testUrlInput]),
				E('div', { 'style': 'margin-bottom:6px;' }, [E('label', { 'style': 'display:block;font-weight:600;' }, '测速间隔'), intervalInput]),
				E('div', {}, [E('label', { 'style': 'display:block;font-weight:600;' }, '延迟容差 (ms)'), tolInput])
			]);

			typeSel.addEventListener('change', function() {
				selectorRow.style.display = typeSel.value === 'selector' ? 'block' : 'none';
				urltestBox.style.display = typeSel.value === 'urltest' ? 'block' : 'none';
			});

			var errDiv = E('div', { 'style': 'color:#dc2626;font-size:12px;margin-top:6px;' });

			ui.showModal(isNew ? '新增代理组' : ('编辑代理组：' + group.tag), [
				E('div', { 'style': 'margin-bottom:8px;' }, [
					E('label', { 'style': 'display:block;font-weight:600;margin-bottom:4px;' }, '代理组名称 (tag)'),
					tagInput
				]),
				E('div', { 'style': 'margin-bottom:8px;' }, [
					E('label', { 'style': 'display:block;font-weight:600;margin-bottom:4px;' }, '代理组类型'),
					typeSel
				]),
				E('div', { 'style': 'margin-bottom:8px;' }, [
					E('label', { 'style': 'display:block;font-weight:600;margin-bottom:4px;' }, '成员（支持节点、Tailnet 与嵌套代理组）'),
					filterInput,
					E('div', { 'style': 'margin-bottom:6px;display:flex;gap:6px;' }, [
						E('button', {
							'class': 'btn',
							'click': function() {
								var kw = filterInput.value.trim().toLowerCase();
								candidates.forEach(function(c) {
									if ((!kw || c.label.toLowerCase().indexOf(kw) >= 0) && selectedIds.indexOf(c.id) < 0)
										selectedIds.push(c.id);
								});
								renderMemberCheckboxes();
								refreshDefaultOptions();
							}
						}, '全选当前筛选'),
						E('button', {
							'class': 'btn',
							'click': function() {
								selectedIds = [];
								renderMemberCheckboxes();
								refreshDefaultOptions();
							}
						}, '清空')
					]),
					membersBox
				]),
				selectorRow,
				urltestBox,
				errDiv,
				E('div', { 'class': 'right', 'style': 'margin-top:10px;' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, '取消'),
					' ',
					E('button', {
						'class': 'btn cbi-button-action',
						'click': function() {
							var tag = tagInput.value.trim();
							if (!tag) {
								errDiv.textContent = '代理组名称不能为空';
								return;
							}
							var tolVal = tolInput.value.trim() === '' ? null : parseInt(tolInput.value.trim(), 10);
							var draft = Object.assign({}, group, {
								tag: tag,
								type: typeSel.value,
								members: selectedIds,
								defaultMember: typeSel.value === 'selector' ? defSel.value : '',
								testUrl: testUrlInput.value.trim(),
								interval: intervalInput.value.trim(),
								tolerance: isNaN(tolVal) ? null : tolVal
							});
							if (isNew) {
								profile.groups.push(draft);
							} else {
								var idx = profile.groups.findIndex(function(g) { return g.id === group.id; });
								if (idx >= 0) profile.groups[idx] = draft;
							}
							ui.hideModal();
							persist('代理组「' + draft.tag + '」已保存');
						}
					}, '保存代理组')
				])
			]);
		};

		var renderProxySettings = function() {
			var choices = engine.proxyChoices(profile);
			var defSel = E('select', { 'class': 'cbi-input-select' }, [
				E('option', { 'value': 'auto', 'selected': profile.settings.proxyDefault === 'auto' ? 'selected' : null }, 'auto（自动测速最快节点）')
			].concat(choices.map(function(c) {
				return E('option', {
					'value': c.id,
					'selected': profile.settings.proxyDefault === c.id ? 'selected' : null
				}, '[' + c.kind + '] ' + c.tag);
			})));

			var listNodesChk = E('input', {
				'type': 'checkbox',
				'checked': profile.settings.listNodesInProxy ? 'checked' : null
			});

			proxyBox.innerHTML = '';
			proxyBox.appendChild(E('h3', {}, '统一 proxy 出口设置'));
			proxyBox.appendChild(E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:14px;align-items:center;' }, [
				E('div', {}, [E('label', { 'style': 'margin-right:6px;font-weight:600;' }, '默认出口：'), defSel]),
				E('label', {}, [listNodesChk, ' 在 proxy 选择器中逐个列出节点']),
				E('button', {
					'class': 'btn cbi-button-action',
					'click': function() {
						profile.settings.proxyDefault = defSel.value;
						profile.settings.listNodesInProxy = !!listNodesChk.checked;
						persist('已更新默认 proxy 出口设置');
					}
				}, '保存出口设置')
			]));
		};

		var renderTable = function() {
			var groups = profile.groups || [];
			var rows = [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, '名称'),
					E('th', { 'class': 'th' }, '类型'),
					E('th', { 'class': 'th' }, '成员数量'),
					E('th', { 'class': 'th' }, '成员预览'),
					E('th', { 'class': 'th' }, '操作')
				])
			];

			if (!groups.length) {
				rows.push(E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td', 'colspan': '5', 'style': 'text-align:center;color:#666;' }, '暂无自定义代理组（默认已内置 proxy 手动选择器与 auto 自动测速组）。')
				]));
			} else {
				groups.forEach(function(g) {
					var names = (g.members || []).map(memberTagById);
					rows.push(E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td' }, E('strong', {}, g.tag)),
						E('td', { 'class': 'td' }, g.type === 'urltest' ? '自动测速 (urltest)' : '手动选择 (selector)'),
						E('td', { 'class': 'td' }, String(names.length)),
						E('td', { 'class': 'td', 'style': 'font-size:12px;' }, names.slice(0, 5).join(', ') + (names.length > 5 ? ' ...' : '')),
						E('td', { 'class': 'td' }, [
							E('button', { 'class': 'btn cbi-button-edit', 'click': function() { openGroupModal(g, false); } }, '编辑'),
							' ',
							E('button', {
								'class': 'btn cbi-button-remove',
								'click': function() {
									profile.groups = profile.groups.filter(function(x) { return x.id !== g.id; });
									persist('已删除代理组「' + g.tag + '」');
								}
							}, '删除')
						])
					]));
				});
			}

			tableWrap.innerHTML = '';
			tableWrap.appendChild(E('table', { 'class': 'table' }, rows));
		};

		renderProxySettings();
		renderTable();

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, '代理组管理'),
			E('div', { 'class': 'cbi-map-descr' }, '完整保留上游 Selector、URLTest 及嵌套代理组能力，统一由 proxy 出口承接普通代理流量与代理 DNS。'),
			E('div', {}, [
				E('button', {
					'class': 'btn cbi-button-add',
					'click': function() {
						var used = (profile.groups || []).map(function(g) { return g.tag; });
						openGroupModal(engine.newGroup({ tag: engine.freshTag('group', used) }), true);
					}
				}, '新增代理组')
			]),
			statusBar,
			proxyBox,
			tableWrap
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
