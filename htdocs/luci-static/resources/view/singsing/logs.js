'use strict';
'require view';
'require poll';
'require singsing.api as api';

return view.extend({
	load: function() {
		return Promise.all([
			api.getLogs(200),
			api.dnsCheck()
		]);
	},

	render: function(data) {
		var logsRes = data[0] || {};
		var dnsRes = data[1] || {};

		var pre = E('pre', {
			'style': 'max-height:520px;overflow:auto;background:#0f172a;color:#e2e8f0;padding:12px;border-radius:6px;font-size:12px;line-height:1.5;white-space:pre-wrap;'
		}, logsRes.logs || '暂无 sing-box 相关日志');

		var diagBox = E('div', {
			'style': 'margin:10px 0;padding:10px 14px;border:1px solid #ddd;border-radius:6px;background:#f8fafc;font-size:13px;'
		});

		var renderDiag = function(d) {
			diagBox.innerHTML = '';
			diagBox.appendChild(E('div', {}, [
				E('strong', {}, 'DNS 诊断摘要：'),
				'直连上游 DNS = ', E('code', {}, d.local_dns || '未填写'),
				' ｜ dns-in 端口 = ', E('code', {}, String(d.listen_port || 5335)),
				'（', d.port_in_use ? '已监听' : '未监听', '）',
				' ｜ dnsmasq = ', d.dnsmasq_taken_over ? '已接管' : '未接管',
				' ｜ 路由器 LAN IP = ', E('code', {}, (d.lan_ips && d.lan_ips.length) ? d.lan_ips.join(', ') : '-')
			]));
		};

		var refresh = function() {
			return Promise.all([api.getLogs(200), api.dnsCheck()]).then(function(r) {
				pre.textContent = (r[0] && r[0].logs) || '暂无 sing-box 相关日志';
				renderDiag(r[1] || {});
			});
		};

		renderDiag(dnsRes);
		poll.add(refresh, 5);

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, '运行日志与 DNS 诊断'),
			diagBox,
			E('div', { 'style': 'margin-bottom:10px;' }, [
				E('button', { 'class': 'btn', 'click': refresh }, '立即刷新')
			]),
			pre
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
