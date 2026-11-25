'use strict';
'require view';
'require ui';
'require uci';
'require poll';
'require singsing.api as api';

function formatUptime(sec) {
	sec = parseInt(sec, 10) || 0;
	if (sec <= 0) return '-';
	var d = Math.floor(sec / 86400);
	var h = Math.floor((sec % 86400) / 3600);
	var m = Math.floor((sec % 3600) / 60);
	var s = sec % 60;
	var parts = [];
	if (d > 0) parts.push(d + '天');
	if (h > 0) parts.push(h + '小时');
	if (m > 0) parts.push(m + '分');
	parts.push(s + '秒');
	return parts.join(' ');
}

function formatBytes(n) {
	n = Number(n) || 0;
	if (n < 1024) return n.toFixed(0) + ' B';
	if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
	if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MB';
	return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function statCard(label, value, color) {
	return E('div', {
		'style': 'flex:1 1 175px;padding:12px 14px;border:1px solid var(--border-color-medium, rgba(127,127,127,0.25));border-radius:6px;background:var(--background-color-high, rgba(127,127,127,0.05));'
	}, [
		E('div', { 'style': 'font-size:12px;opacity:0.75;margin-bottom:4px;' }, label),
		E('div', { 'style': 'font-size:14px;font-weight:600;' + (color ? ('color:' + color + ';') : '') + 'word-break:break-all;' }, value || '-')
	]);
}

function delayBadge(ms) {
	if (ms === null || ms === undefined) return '';
	if (ms <= 0) return E('span', { 'style': 'margin-left:6px;font-size:11px;color:#dc2626;' }, '超时');
	var c = ms < 150 ? '#16a34a' : (ms < 400 ? '#d97706' : '#dc2626');
	return E('span', { 'style': 'margin-left:6px;font-size:11px;font-weight:600;color:' + c + ';' }, ms + 'ms');
}

return view.extend({
	load: function() {
		return Promise.all([
			api.status(),
			api.loadActiveProfile()
		]);
	},

	render: function(data) {
		var st = data[0] || {};
		var loaded = data[1] || {};
		var profile = loaded.profile;

		var prevTraffic = { ts: 0, up: 0, down: 0 };
		var liveStats = { mode: null, upSpeed: 0, downSpeed: 0, upTotal: 0, downTotal: 0, connCount: 0, proxies: null };
		var delays = {};
		var refreshing = false;

		var gridContainer = E('div', { 'id': 'sb-status-grid' });
		var msgBox = E('div', { 'id': 'sb-action-msg', 'style': 'margin-top:12px;' });
		var connCheckBox = E('div', { 'id': 'sb-conn-check', 'style': 'margin-top:12px;' });
		var clashPanel = E('div', { 'id': 'sb-clash-panel', 'style': 'margin-top:16px;' });

		var showMsg = function(type, title, detail) {
			var fg = type === 'error' ? '#991b1b' : (type === 'warning' ? '#92400e' : '#166534');
			var bg = type === 'error' ? '#fef2f2' : (type === 'warning' ? '#fffbeb' : '#f0fdf4');
			var border = type === 'error' ? '#fca5a5' : (type === 'warning' ? '#fcd34d' : '#86efac');
			msgBox.innerHTML = '';
			msgBox.appendChild(E('div', {
				'style': 'padding:10px 14px;border-radius:6px;background:' + bg + ';color:' + fg + ';border:1px solid ' + border + ';'
			}, [
				E('div', { 'style': 'font-weight:600;margin-bottom:4px;' }, title),
				detail ? E('pre', { 'style': 'margin:0;white-space:pre-wrap;font-size:12px;color:inherit;background:transparent;' }, detail) : ''
			]));
		};

		var renderStatusGrid = function(curSt) {
			var mode = liveStats.mode || (profile && profile.settings && profile.settings.defaultMode) || 'GFWList';
			var rdns = (profile && profile.settings && profile.settings.remoteDns) || { provider: 'google', protocol: 'tls' };
			var remoteLabel = (rdns.provider || 'google').toUpperCase() + ' (' + (rdns.protocol || 'tls').toUpperCase() + ')';
			var directDns = curSt.local_dns ? (curSt.local_dns + ' (' + (curSt.local_dns_type || 'udp').toUpperCase() + ')') : '未填写（必填）';
			var proxyNow = (liveStats.proxies && liveStats.proxies.proxy && liveStats.proxies.proxy.now) || '-';

			gridContainer.innerHTML = '';
			gridContainer.appendChild(E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:10px;margin:12px 0;' }, [
				statCard('运行状态', curSt.running ? ('运行中 (PID ' + curSt.pid + ')') : '已停止', curSt.running ? '#16a34a' : '#dc2626'),
				statCard('运行时长', curSt.running ? formatUptime(curSt.uptime) : '-'),
				statCard('核心版本', curSt.bin_exists ? (curSt.version || curSt.singbox_bin) + (curSt.version_supported === false ? '（需 1.14+）' : '') : ('未找到: ' + curSt.singbox_bin), (curSt.bin_exists && curSt.version_supported !== false) ? null : '#dc2626'),
				statCard('当前分流模式', mode),
				statCard('当前 proxy 出口', curSt.running ? proxyNow : '-'),
				statCard('实时速率 / 连接', curSt.running ? ('↑ ' + formatBytes(liveStats.upSpeed) + '/s  ↓ ' + formatBytes(liveStats.downSpeed) + '/s (' + liveStats.connCount + ' 连接)') : '-'),
				statCard('透明代理', curSt.tun_up ? ('TUN 已就绪 (' + curSt.tun_interface + ')') : ('未启动 (' + curSt.tun_interface + ')'), curSt.tun_up ? '#16a34a' : null),
				statCard('直连上游 DNS', directDns, curSt.local_dns ? null : '#dc2626'),
				statCard('代理上游 DNS', remoteLabel),
				statCard('dnsmasq 接管', curSt.dnsmasq_taken_over ? ('已接管 (127.0.0.1#' + curSt.listen_port + ')') : '未接管', curSt.dnsmasq_taken_over ? '#16a34a' : null)
			]));
			if (curSt.offload_warning) {
				gridContainer.appendChild(E('div', {
					'style': 'margin:6px 0 10px 0;padding:8px 12px;border-radius:6px;background:#fffbeb;color:#92400e;border:1px solid #fcd34d;font-size:12px;'
				}, '提示：' + curSt.offload_warning));
			}
		};

		var renderClashPanel = function(curSt) {
			clashPanel.innerHTML = '';
			if (!curSt.running || !liveStats.proxies) {
				if (curSt.running) {
					clashPanel.appendChild(E('div', { 'style': 'font-size:12px;opacity:0.75;' }, 'Clash API 未响应（请确认已在 Profile 中开启 127.0.0.1:9090）。'));
				}
				return;
			}

			var modes = ['GFWList', 'Non-CN', 'Global', 'Direct'];
			var modeBtns = modes.map(function(m) {
				var active = (liveStats.mode || '').toLowerCase() === m.toLowerCase();
				return E('button', {
					'class': active ? 'btn cbi-button-action' : 'btn',
					'click': function() {
						api.clashSetMode(m).then(function(r) {
							if (r && r.ok) {
								liveStats.mode = m;
								showMsg('success', '已动态切换分流模式为 ' + m + '（无需重启核心）');
								renderStatusGrid(curSt);
								renderClashPanel(curSt);
							} else {
								showMsg('error', '切换模式失败', (r && r.error) || '');
							}
						});
					}
				}, m);
			});

			modeBtns.push(E('button', {
				'class': 'btn',
				'style': 'margin-left:8px;',
				'click': function() {
					if (!liveStats.mode) return;
					var canonical = modes.find(function(m) { return m.toLowerCase() === String(liveStats.mode).toLowerCase(); }) || 'GFWList';
					profile.settings.defaultMode = canonical;
					api.saveProfile(loaded.name, profile).then(function(r) {
						if (r && r.ok) showMsg('success', '已将当前模式「' + canonical + '」保存为默认设置');
						else showMsg('error', '保存失败', (r && r.error) || '');
					});
				}
			}, '保存当前模式为默认'));

			var selectors = Object.values(liveStats.proxies).filter(function(p) {
				return p && (p.type === 'Selector' || p.type === 'selector') && Array.isArray(p.all);
			}).sort(function(a, b) {
				if (a.name === 'proxy') return -1;
				if (b.name === 'proxy') return 1;
				return a.name.localeCompare(b.name);
			});

			var groupCards = selectors.map(function(grp) {
				var memberBtns = grp.all.map(function(memberName) {
					var isNow = grp.now === memberName;
					return E('button', {
						'class': isNow ? 'btn cbi-button-action' : 'btn',
						'style': 'margin:3px;',
						'click': function() {
							api.clashSelectProxy(grp.name, memberName).then(function(r) {
								if (r && r.ok) {
									grp.now = memberName;
									showMsg('success', '代理组「' + grp.name + '」已切换至：' + memberName);
									renderStatusGrid(curSt);
									renderClashPanel(curSt);
								} else {
									showMsg('error', '切换节点失败', (r && r.error) || '');
								}
							});
						}
					}, [memberName, delayBadge(delays[memberName])]);
				});

				return E('div', {
					'style': 'margin-top:10px;padding:10px 12px;border:1px solid var(--border-color-medium, rgba(127,127,127,0.25));border-radius:6px;background:var(--background-color-high, rgba(127,127,127,0.05));'
				}, [
					E('div', { 'style': 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:6px;' }, [
						E('div', {}, [
							E('strong', {}, grp.name),
							' ',
							E('span', { 'style': 'font-size:12px;color:#16a34a;' }, '当前：' + (grp.now || '-'))
						]),
						E('div', { 'style': 'display:flex;gap:6px;' }, [
							E('button', {
								'class': 'btn',
								'style': 'font-size:12px;',
								'click': function() {
									showMsg('success', '正在并发测速代理组「' + grp.name + '」...');
									api.clashTestGroupDelay(grp.name, 'https://www.gstatic.com/generate_204', 5000).then(function(res) {
										var delayMap = (res && res.ok && res.data && typeof res.data === 'object') ? res.data : {};
										grp.all.forEach(function(m) {
											delays[m] = (typeof delayMap[m] === 'number' && delayMap[m] > 0) ? delayMap[m] : 0;
										});
										showMsg('success', '代理组「' + grp.name + '」测速完成');
										renderClashPanel(curSt);
									}).catch(function(err) {
										showMsg('error', '测速失败', String(err));
									});
								}
							}, '测速'),
							grp.name === 'proxy' ? E('button', {
								'class': 'btn',
								'style': 'font-size:12px;',
								'click': function() {
									var target = grp.now;
									if (target === 'auto') {
										profile.settings.proxyDefault = 'auto';
									} else {
										var g = (profile.groups || []).find(function(x) { return x.tag === target; });
										var n = (profile.nodes || []).find(function(x) { return x.tag === target; });
										var t = (profile.settings.tailnets || []).find(function(x) { return x.tag === target; });
										var found = g || n || t;
										if (!found) {
											showMsg('error', '保存失败', '在当前配置方案中未找到出口「' + target + '」');
											return;
										}
										profile.settings.proxyDefault = found.id;
									}
									api.saveProfile(loaded.name, profile).then(function(r) {
										if (r && r.ok) showMsg('success', '已将「' + target + '」保存为默认 proxy 出口');
										else showMsg('error', '保存失败', (r && r.error) || '');
									});
								}
							}, '保存为默认') : ''
						])
					]),
					E('div', { 'style': 'display:flex;flex-wrap:wrap;' }, memberBtns)
				]);
			});

			clashPanel.appendChild(E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, 'Clash API 运行控制（动态切换与测速）'),
				E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:8px;' }, [
					E('span', { 'style': 'font-weight:600;margin-right:4px;' }, '分流模式：')
				].concat(modeBtns)),
				E('div', {}, groupCards)
			]));
		};

		var refreshAll = function(force) {
			if (refreshing && !force) return Promise.resolve();
			refreshing = true;
			return api.status().then(function(newSt) {
				st = newSt || {};
				if (!st.running) {
					liveStats.proxies = null;
					liveStats.mode = null;
					liveStats.upSpeed = 0;
					liveStats.downSpeed = 0;
					liveStats.connCount = 0;
					renderStatusGrid(st);
					renderClashPanel(st);
					return;
				}
				return Promise.all([
					api.clashGetConfigs().catch(function() { return null; }),
					api.clashGetProxies().catch(function() { return null; }),
					api.clashGetConnections().catch(function() { return null; })
				]).then(function(r) {
					if (r[0] && r[0].ok && r[0].data && r[0].data.mode)
						liveStats.mode = r[0].data.mode;
					if (r[1] && r[1].ok && r[1].data && r[1].data.proxies)
						liveStats.proxies = r[1].data.proxies;
					if (r[2] && r[2].ok && r[2].data) {
						var now = Date.now();
						var up = Number(r[2].data.uploadTotal) || 0;
						var down = Number(r[2].data.downloadTotal) || 0;
						if (prevTraffic.ts > 0 && now > prevTraffic.ts) {
							var dt = (now - prevTraffic.ts) / 1000;
							liveStats.upSpeed = Math.max(0, (up - prevTraffic.up) / dt);
							liveStats.downSpeed = Math.max(0, (down - prevTraffic.down) / dt);
						}
						prevTraffic = { ts: now, up: up, down: down };
						liveStats.upTotal = up;
						liveStats.downTotal = down;
						liveStats.connCount = Array.isArray(r[2].data.connections) ? r[2].data.connections.length : 0;
					}
					renderStatusGrid(st);
					renderClashPanel(st);
				});
			}).finally(function() {
				refreshing = false;
			});
		};

		var runService = function(action, label) {
			ui.showModal(label, [E('p', { 'class': 'spinning' }, '正在执行 ' + label + '...')]);
			return api.serviceAction(action).then(function(res) {
				uci.unload('singsing');
				ui.hideModal();
				if (res && res.ok) showMsg('success', label + '成功', res.output || '');
				else showMsg('error', label + '失败', (res && (res.error || res.output)) || '未知错误');
				return refreshAll(true);
			}).catch(function(err) {
				ui.hideModal();
				showMsg('error', label + '异常', String(err));
			});
		};

		var runGenerateAndApply = function() {
			return api.status().then(function(curSt) {
				if (!curSt || !curSt.enabled) {
					var stopTask = (curSt && (curSt.running || curSt.dnsmasq_taken_over))
						? api.serviceAction('stop').catch(function() { return null; })
						: Promise.resolve();
					return stopTask.then(function() {
						showMsg('warning', '当前「启用服务」处于关闭状态，未下载规则集且未启动 sing-box', '如需启动服务，请前往「基本设置」开启「启用服务」后保存并应用。');
						return refreshAll(true);
					});
				}
				ui.showModal('生成并应用配置', [E('p', { 'class': 'spinning' }, '正在校验、补全本地规则集并重启 sing-box...')]);
				return api.generateAndApply().then(function(res) {
					ui.hideModal();
					if (res && res.validationErrors && res.validationErrors.length) {
						var lines = res.validationErrors.map(function(e) { return '• ' + e.message; }).join('\n');
						showMsg('error', '配置校验未通过，已拒绝应用', lines);
					} else if (res && res.ok) {
						var warnText = (res.warnings && res.warnings.length)
							? ('警告：\n' + res.warnings.map(function(w) { return '• ' + w.message; }).join('\n'))
							: '';
						showMsg('success', '配置已生成、校验通过并成功启动', warnText);
					} else if (res && res.rolled_back) {
						showMsg('warning', '新配置启动失败，已自动回滚至上一次有效配置', res.output || '');
					} else {
						showMsg('error', '应用配置失败', (res && (res.error || res.output)) || '未知错误');
					}
					return refreshAll(true);
				}).catch(function(err) {
					ui.hideModal();
					showMsg('error', '生成或应用异常', String(err));
				});
			});
		};

		var showPreview = function() {
			api.buildCurrentConfig().then(function(ctx) {
				var jsonText = JSON.stringify(ctx.result.config, null, 2);
				var issuesText = ctx.result.issues.length
					? ctx.result.issues.map(function(i) { return '[' + i.level + '] ' + i.message; }).join('\n')
					: '无校验错误或警告';
				ui.showModal('生成的 sing-box 配置预览', [
					E('p', { 'style': 'font-size:12px;opacity:0.8;' }, '规则集已全部本地化（共 ' + ctx.result.ruleSets.length + ' 个本地规则集）'),
					E('pre', { 'style': 'max-height:120px;overflow:auto;padding:8px;font-size:12px;border:1px solid var(--border-color-medium, rgba(127,127,127,0.25));border-radius:4px;' }, issuesText),
					E('pre', { 'style': 'max-height:420px;overflow:auto;background:#1e293b;color:#e2e8f0;padding:10px;font-size:12px;border-radius:4px;' }, jsonText),
					E('div', { 'class': 'right' }, [
						E('button', { 'class': 'btn', 'click': ui.hideModal }, '关闭')
					])
				]);
			});
		};

		var runConnectivityCheck = function() {
			connCheckBox.innerHTML = '';
			connCheckBox.appendChild(E('div', { 'class': 'cbi-section' }, [
				E('p', { 'class': 'spinning' }, '正在从路由器并发检测国内外分流连通性...')
			]));
			api.connectivityCheck().then(function(res) {
				var list = (res && Array.isArray(res.results)) ? res.results : [];
				connCheckBox.innerHTML = '';
				connCheckBox.appendChild(E('div', { 'class': 'cbi-section' }, [
					E('h3', {}, '分流连通性检测结果（路由器本机发起）'),
					E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:10px;margin-top:8px;' }, list.map(function(item) {
						return statCard(
							item.label,
							item.ok ? ('正常 (' + item.ms + ' ms, HTTP ' + item.http_code + ')') : ('不可达 (HTTP ' + (item.http_code || 0) + ')'),
							item.ok ? '#16a34a' : '#dc2626'
						);
					}))
				]));
			}).catch(function(err) {
				connCheckBox.innerHTML = '';
				showMsg('error', '连通性检测异常', String(err));
			});
		};

		renderStatusGrid(st);
		poll.add(refreshAll, 5);

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, 'Sing-Box 运行概览'),
			E('div', { 'class': 'cbi-map-descr' }, '基于 riverscn/singbox-confgen 的 OpenWrt 原生管理插件：手动指定直连上游 DNS，TUN + Auto Redirect 透明代理，规则集本地化与 Clash API 实时控制。'),
			gridContainer,
			E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;' }, [
				E('button', { 'class': 'btn cbi-button-action', 'click': runGenerateAndApply }, '生成并应用'),
				E('button', { 'class': 'btn cbi-button-apply', 'click': function() { runService('start', '启动服务'); } }, '启动'),
				E('button', { 'class': 'btn cbi-button-reset', 'click': function() { runService('stop', '停止服务'); } }, '停止'),
				E('button', { 'class': 'btn cbi-button-neutral', 'click': function() { runService('restart', '重启服务'); } }, '重启'),
				E('button', { 'class': 'btn', 'click': showPreview }, '预览配置 JSON'),
				E('button', { 'class': 'btn', 'click': runConnectivityCheck }, '分流连通性检测')
			]),
			msgBox,
			connCheckBox,
			clashPanel
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
