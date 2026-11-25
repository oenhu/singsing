'use strict';
'require view';
'require poll';
'require singsing.api as api';

function formatBytes(n) {
	n = Number(n) || 0;
	if (n < 1024) return n.toFixed(0) + ' B';
	if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
	if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + ' MB';
	return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

return view.extend({
	load: function() {
		return api.clashGetConnections().catch(function() { return { ok: false }; });
	},

	render: function(initial) {
		var paused = false;
		var query = '';
		var latest = initial;

		var summaryBox = E('div', { 'style': 'margin:10px 0;font-size:13px;' });
		var tableWrap = E('div', { 'class': 'cbi-section', 'style': 'margin-top:10px;' });

		var renderData = function(res) {
			latest = res;
			if (!res || !res.ok || !res.data) {
				summaryBox.textContent = '当前未连接到 Clash API（请确认 sing-box 正在运行且已开启 Clash API）。';
				tableWrap.innerHTML = '';
				return;
			}
			var conns = Array.isArray(res.data.connections) ? res.data.connections : [];
			var q = query.trim().toLowerCase();
			var filtered = conns.filter(function(c) {
				if (!q) return true;
				var m = c.metadata || {};
				var hay = [m.host, m.destinationIP, m.sourceIP, m.network, c.rule, (c.chains || []).join('>')].join(' ').toLowerCase();
				return hay.indexOf(q) >= 0;
			});

			summaryBox.innerHTML = '';
			summaryBox.appendChild(E('div', {}, [
				E('strong', {}, '活跃连接数：'), String(filtered.length) + ' / ' + String(conns.length),
				' ｜ ', E('strong', {}, '累计上传：'), formatBytes(res.data.uploadTotal),
				' ｜ ', E('strong', {}, '累计下载：'), formatBytes(res.data.downloadTotal)
			]));

			var rows = [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, '目标地址'),
					E('th', { 'class': 'th' }, '源设备'),
					E('th', { 'class': 'th' }, '协议'),
					E('th', { 'class': 'th' }, '代理链'),
					E('th', { 'class': 'th' }, '命中规则'),
					E('th', { 'class': 'th' }, '上传 / 下载'),
					E('th', { 'class': 'th' }, '操作')
				])
			];

			if (!filtered.length) {
				rows.push(E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td', 'colspan': '7', 'style': 'text-align:center;color:#666;' }, '暂无活跃连接')
				]));
			} else {
				filtered.slice(0, 200).forEach(function(c) {
					var m = c.metadata || {};
					var target = (m.host || m.destinationIP || '-') + (m.destinationPort ? (':' + m.destinationPort) : '');
					var src = (m.sourceIP || '-') + (m.sourcePort ? (':' + m.sourcePort) : '');
					var chains = Array.isArray(c.chains) ? c.chains.slice().reverse().join(' → ') : '-';

					rows.push(E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td', 'style': 'font-family:monospace;font-size:12px;' }, target),
						E('td', { 'class': 'td', 'style': 'font-family:monospace;font-size:12px;' }, src),
						E('td', { 'class': 'td' }, (m.network || '').toUpperCase()),
						E('td', { 'class': 'td', 'style': 'font-size:12px;' }, chains),
						E('td', { 'class': 'td', 'style': 'font-size:12px;' }, c.rule || '-'),
						E('td', { 'class': 'td', 'style': 'font-size:12px;white-space:nowrap;' }, formatBytes(c.upload) + ' / ' + formatBytes(c.download)),
						E('td', { 'class': 'td' }, [
							E('button', {
								'class': 'btn cbi-button-remove',
								'style': 'font-size:11px;',
								'click': function() {
									api.clashCloseConnection(c.id).then(refresh);
								}
							}, '断开')
						])
					]));
				});
			}

			tableWrap.innerHTML = '';
			tableWrap.appendChild(E('table', { 'class': 'table' }, rows));
		};

		var refresh = function() {
			if (paused) return Promise.resolve();
			return api.clashGetConnections().then(renderData).catch(function() { renderData({ ok: false }); });
		};

		var searchInput = E('input', {
			'type': 'text',
			'class': 'cbi-input-text',
			'placeholder': '搜索目标域名 / IP / 源设备 / 出口...',
			'style': 'min-width:240px;',
			'input': function() {
				query = searchInput.value;
				renderData(latest);
			}
		});

		var pauseBtn = E('button', {
			'class': 'btn',
			'click': function() {
				paused = !paused;
				pauseBtn.textContent = paused ? '恢复自动刷新' : '暂停自动刷新';
			}
		}, '暂停自动刷新');

		renderData(initial);
		poll.add(refresh, 3);

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, '实时连接管理'),
			E('div', { 'class': 'cbi-map-descr' }, '通过本机 Clash API 实时查看和断开 sing-box 活跃连接（自动每 3 秒刷新，最多显示前 200 条）。'),
			E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;' }, [
				searchInput,
				pauseBtn,
				E('button', { 'class': 'btn', 'click': function() { paused = false; pauseBtn.textContent = '暂停自动刷新'; refresh(); } }, '立即刷新'),
				E('button', {
					'class': 'btn cbi-button-reset',
					'click': function() {
						api.clashCloseAllConnections().then(refresh);
					}
				}, '断开全部连接')
			]),
			summaryBox,
			tableWrap
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
