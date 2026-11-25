'use strict';
'require view';
'require ui';
'require uci';
'require singsing.api as api';

function formatTime(ts) {
	if (!ts) return '-';
	return new Date(ts * 1000).toLocaleString();
}

function genId() {
	return 'sub-' + Math.random().toString(36).slice(2, 10);
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('singsing'),
			api.getSubscriptions().catch(function() { return { subscriptions: [] }; }),
			api.loadActiveProfile()
		]);
	},

	render: function(data) {
		var subs = (data[1] && Array.isArray(data[1].subscriptions)) ? data[1].subscriptions : [];
		var loaded = data[2];
		var profile = loaded.profile;
		var engine = loaded.engine;

		var statusBar = E('div', { 'style': 'margin-top:10px;' });
		var tableWrap = E('div', { 'class': 'cbi-section', 'style': 'margin-top:12px;' });

		var notify = function(ok, text) {
			statusBar.innerHTML = '';
			statusBar.appendChild(E('div', {
				'style': 'padding:8px 12px;border-radius:4px;background:' + (ok ? '#f0fdf4' : '#fef2f2') + ';border:1px solid ' + (ok ? '#86efac' : '#fca5a5') + ';white-space:pre-wrap;font-size:13px;'
			}, text));
		};

		var persistSubs = function(msg) {
			return api.saveSubscriptions(JSON.stringify(subs, null, 2)).then(function(res) {
				if (res && res.ok) notify(true, msg || '订阅列表已保存');
				else notify(false, '保存失败：' + ((res && res.error) || '未知错误'));
				renderTable();
			});
		};

		var updateOneInBrowser = function(sub) {
			ui.showModal('更新订阅：' + sub.name, [E('p', { 'class': 'spinning' }, '正在拉取订阅并解析节点（保留稳定节点 ID）...')]);
			return api.fetchSubscription(sub.url, sub.userAgent || 'sing-box/1.14').then(function(res) {
				if (!res || !res.ok || !res.content) {
					sub.lastUpdated = Math.floor(Date.now() / 1000);
					sub.lastStatus = 'error';
					sub.lastError = (res && res.error) || '下载失败（已保留旧节点）';
					return api.saveSubscriptions(JSON.stringify(subs, null, 2)).then(function() {
						ui.hideModal();
						notify(false, '订阅「' + sub.name + '」更新失败：' + sub.lastError);
						renderTable();
					});
				}

				var imported = engine.importConfig(res.content);
				if (imported.error || !imported.nodes || !imported.nodes.length) {
					sub.lastUpdated = Math.floor(Date.now() / 1000);
					sub.lastStatus = 'error';
					sub.lastError = imported.error || '未解析到有效节点（已保留旧节点）';
					return api.saveSubscriptions(JSON.stringify(subs, null, 2)).then(function() {
						ui.hideModal();
						notify(false, '订阅「' + sub.name + '」解析失败：' + sub.lastError);
						renderTable();
					});
				}

				var merged = engine.mergeSubscriptionNodes(profile, sub, imported.nodes);
				if (merged.total === 0) {
					sub.lastUpdated = Math.floor(Date.now() / 1000);
					sub.lastStatus = 'error';
					sub.lastError = '过滤后剩余 0 个节点，已保留旧节点防止清空';
					return api.saveSubscriptions(JSON.stringify(subs, null, 2)).then(function() {
						ui.hideModal();
						notify(false, '订阅「' + sub.name + '」：' + sub.lastError);
						renderTable();
					});
				}

				profile.nodes = merged.nodes;
				sub.lastUpdated = Math.floor(Date.now() / 1000);
				sub.lastStatus = 'ok';
				sub.lastError = '';
				sub.lastCount = merged.total;

				return Promise.all([
					api.saveProfile(loaded.name, profile),
					api.saveSubscriptions(JSON.stringify(subs, null, 2))
				]).then(function() {
					ui.hideModal();
					var warns = (imported.warnings && imported.warnings.length)
						? ('\n转换提示：\n• ' + imported.warnings.slice(0, 5).join('\n• '))
						: '';
					notify(true, '订阅「' + sub.name + '」更新成功：共 ' + merged.total + ' 个节点（保留原 ID ' + merged.kept + ' 个，新增 ' + merged.added + ' 个）' + warns);
					renderTable();
				});
			}).catch(function(err) {
				ui.hideModal();
				notify(false, '更新异常：' + String(err));
			});
		};

		var openSubModal = function(sub, isNew) {
			var field = function(label, el, desc) {
				return E('div', { 'style': 'margin-bottom:8px;' }, [
					E('label', { 'style': 'display:block;font-weight:600;margin-bottom:3px;font-size:13px;' }, label),
					el,
					desc ? E('div', { 'style': 'font-size:11px;color:#666;margin-top:2px;' }, desc) : ''
				]);
			};

			var nameInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': sub.name || '', 'placeholder': '例如 机场A', 'style': 'width:100%;' });
			var urlInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': sub.url || '', 'placeholder': 'https://...', 'style': 'width:100%;' });
			var uaInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': sub.userAgent || 'sing-box/1.14', 'style': 'width:100%;' });
			var incInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': sub.includeKeywords || '', 'placeholder': '可选，多个关键词用逗号分隔（如 香港,日本,新加坡）', 'style': 'width:100%;' });
			var excInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': sub.excludeKeywords || '', 'placeholder': '可选，多个关键词用逗号分隔（如 剩余流量,过期,官网）', 'style': 'width:100%;' });
			var rxInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': sub.regexFilter || '', 'placeholder': '可选，仅保留匹配此正则的节点名', 'style': 'width:100%;' });
			var prefixInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'value': sub.renamePrefix || '', 'placeholder': '可选，节点名前缀（如 [机场A] ）', 'style': 'width:100%;' });

			var enabledChk = E('input', { 'type': 'checkbox', 'checked': sub.enabled !== false ? 'checked' : null });
			var dedupChk = E('input', { 'type': 'checkbox', 'checked': sub.deduplicate !== false ? 'checked' : null });
			var inGroupsChk = E('input', { 'type': 'checkbox', 'checked': sub.inGroups !== false ? 'checked' : null });
			var errDiv = E('div', { 'style': 'color:#dc2626;font-size:12px;margin-top:6px;' });

			ui.showModal(isNew ? '新增订阅' : ('编辑订阅：' + sub.name), [
				E('div', { 'style': 'max-height:70vh;overflow:auto;padding-right:4px;' }, [
					field('订阅名称', nameInput),
					field('订阅地址 (URL)', urlInput),
					field('User-Agent', uaInput, '默认 sing-box/1.14，可按服务商要求改为 clash.meta 等'),
					field('包含关键词（可选）', incInput),
					field('排除关键词（可选）', excInput),
					field('正则筛选（可选）', rxInput),
					field('节点重命名前缀（可选）', prefixInput),
					E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;' }, [
						E('label', {}, [enabledChk, ' 参与定时自动更新']),
						E('label', {}, [dedupChk, ' 节点去重']),
						E('label', {}, [inGroupsChk, ' 自动加入默认代理组'])
					])
				]),
				errDiv,
				E('div', { 'class': 'right', 'style': 'margin-top:10px;' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, '取消'),
					' ',
					E('button', {
						'class': 'btn cbi-button-action',
						'click': function() {
							var name = nameInput.value.trim();
							var url = urlInput.value.trim();
							if (!name) { errDiv.textContent = '订阅名称不能为空'; return; }
							if (!/^https?:\/\/\S+$/i.test(url)) { errDiv.textContent = '请输入有效的 http:// 或 https:// 订阅地址'; return; }
							var draft = Object.assign({}, sub, {
								id: sub.id || genId(),
								name: name,
								url: url,
								userAgent: uaInput.value.trim() || 'sing-box/1.14',
								downloadMode: 'direct',
								includeKeywords: incInput.value.trim(),
								excludeKeywords: excInput.value.trim(),
								regexFilter: rxInput.value.trim(),
								renamePrefix: prefixInput.value,
								enabled: !!enabledChk.checked,
								deduplicate: !!dedupChk.checked,
								inGroups: !!inGroupsChk.checked
							});
							if (isNew) {
								subs.push(draft);
							} else {
								var idx = subs.findIndex(function(x) { return x.id === sub.id; });
								if (idx >= 0) subs[idx] = draft;
							}
							ui.hideModal();
							persistSubs('订阅「' + draft.name + '」已保存');
						}
					}, '保存订阅')
				])
			]);
		};

		var renderTable = function() {
			var rows = [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, '订阅名称'),
					E('th', { 'class': 'th' }, '定时更新'),
					E('th', { 'class': 'th' }, '节点数'),
					E('th', { 'class': 'th' }, '上次更新 / 状态'),
					E('th', { 'class': 'th' }, '操作')
				])
			];

			if (!subs.length) {
				rows.push(E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td', 'colspan': '5', 'style': 'text-align:center;color:#666;' }, '暂无订阅，点击「新增订阅」添加。支持 sing-box / Clash / Mihomo / Base64 / SIP008 / 分享链接。')
				]));
			} else {
				subs.forEach(function(sub) {
					var stColor = sub.lastStatus === 'ok' ? '#16a34a' : (sub.lastStatus === 'error' ? '#dc2626' : '#666');
					var stText = sub.lastStatus === 'ok' ? '成功' : (sub.lastStatus === 'error' ? ('失败：' + (sub.lastError || '')) : '未更新');
					rows.push(E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td' }, [
							E('strong', {}, sub.name),
							E('div', { 'style': 'font-size:11px;color:#666;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' }, sub.url)
						]),
						E('td', { 'class': 'td' }, sub.enabled !== false ? '开启' : '关闭'),
						E('td', { 'class': 'td' }, sub.lastCount != null ? String(sub.lastCount) : '-'),
						E('td', { 'class': 'td', 'style': 'font-size:12px;' }, [
							E('div', {}, formatTime(sub.lastUpdated)),
							E('div', { 'style': 'color:' + stColor + ';' }, stText)
						]),
						E('td', { 'class': 'td', 'style': 'white-space:nowrap;' }, [
							E('button', { 'class': 'btn cbi-button-action', 'click': function() { updateOneInBrowser(sub); } }, '立即更新'),
							' ',
							E('button', { 'class': 'btn cbi-button-edit', 'click': function() { openSubModal(sub, false); } }, '编辑'),
							' ',
							E('button', {
								'class': 'btn cbi-button-remove',
								'click': function() {
									subs = subs.filter(function(x) { return x.id !== sub.id; });
									profile.nodes = profile.nodes.filter(function(n) { return n.subId !== sub.id; });
									Promise.all([
										api.saveProfile(loaded.name, profile),
										api.saveSubscriptions(JSON.stringify(subs, null, 2))
									]).then(function() {
										notify(true, '已删除订阅「' + sub.name + '」及其关联节点');
										renderTable();
									});
								}
							}, '删除')
						])
					]));
				});
			}

			tableWrap.innerHTML = '';
			tableWrap.appendChild(E('table', { 'class': 'table' }, rows));
		};

		// Global Cron Schedule Box (zero external deps: native OpenWrt cron + ucode)
		var autoUpdChk = E('input', { 'type': 'checkbox', 'checked': uci.get('singsing', 'subscription', 'auto_update') === '1' ? 'checked' : null });
		var autoApplyChk = E('input', { 'type': 'checkbox', 'checked': uci.get('singsing', 'subscription', 'auto_apply') !== '0' ? 'checked' : null });
		var curInterval = uci.get('singsing', 'subscription', 'update_interval') || '86400';
		var intervalSel = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { 'value': '21600', 'selected': curInterval === '21600' ? 'selected' : null }, '每 6 小时'),
			E('option', { 'value': '43200', 'selected': curInterval === '43200' ? 'selected' : null }, '每 12 小时'),
			E('option', { 'value': '86400', 'selected': curInterval === '86400' ? 'selected' : null }, '每天（24 小时）'),
			E('option', { 'value': '259200', 'selected': curInterval === '259200' ? 'selected' : null }, '每 3 天'),
			E('option', { 'value': '604800', 'selected': curInterval === '604800' ? 'selected' : null }, '每周')
		]);

		var saveCron = function() {
			uci.set('singsing', 'subscription', 'auto_update', autoUpdChk.checked ? '1' : '0');
			uci.set('singsing', 'subscription', 'update_interval', intervalSel.value);
			uci.set('singsing', 'subscription', 'auto_apply', autoApplyChk.checked ? '1' : '0');
			uci.save().then(function() {
				return uci.apply();
			}).then(function() {
				return api.syncCron();
			}).then(function(r) {
				if (r && r.ok) notify(true, '定时自动更新设置已保存并同步到系统 cron');
				else notify(false, '同步 cron 失败：' + ((r && r.output) || '未知错误'));
			});
		};

		var runBackendNow = function() {
			ui.showModal('后台更新全部订阅', [E('p', { 'class': 'spinning' }, '正在调用路由器原生 ucode 后台更新器...')]);
			api.runSubUpdater('').then(function(res) {
				ui.hideModal();
				if (res && res.ok) {
					notify(true, '后台更新完成：成功 ' + (res.updated ? res.updated.length : 0) + ' 个' + (res.applied ? '，已校验并热应用配置' : ''));
				} else {
					notify(false, '后台更新存在失败项：' + JSON.stringify(res));
				}
				return api.getSubscriptions().then(function(r) {
					if (r && Array.isArray(r.subscriptions)) subs = r.subscriptions;
					renderTable();
				});
			}).catch(function(err) {
				ui.hideModal();
				notify(false, '执行异常：' + String(err));
			});
		};

		renderTable();

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, '订阅管理'),
			E('div', { 'class': 'cbi-map-descr' }, '零外部依赖设计：LuCI 手动更新使用完整上游解析器；后台定时自动更新使用 OpenWrt 原生 ucode + cron，支持关键词/正则过滤、重命名、去重、稳定节点 ID 保持与失败保护。'),

			E('div', { 'class': 'cbi-section', 'style': 'margin-top:12px;' }, [
				E('h3', {}, '后台定时自动更新（原生 Cron + ucode）'),
				E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:14px;align-items:center;' }, [
					E('label', {}, [autoUpdChk, ' 启用定时自动更新']),
					E('div', {}, [E('label', { 'style': 'margin-right:6px;' }, '周期：'), intervalSel]),
					E('label', {}, [autoApplyChk, ' 更新后自动校验并应用配置']),
					E('button', { 'class': 'btn cbi-button-action', 'click': saveCron }, '保存定时设置'),
					E('button', { 'class': 'btn', 'click': runBackendNow }, '立即执行后台更新')
				])
			]),

			E('div', { 'style': 'display:flex;gap:8px;margin-top:12px;' }, [
				E('button', {
					'class': 'btn cbi-button-add',
					'click': function() { openSubModal({ id: genId(), enabled: true, deduplicate: true, inGroups: true, userAgent: 'sing-box/1.14' }, true); }
				}, '新增订阅')
			]),
			statusBar,
			tableWrap
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
