'use strict';
'require view';
'require ui';
'require singsing.api as api';

var BUILTIN_DESCRIPTIONS = {
	'gfwlist': 'GFWList 分流模式内置规则集',
	'geosite-geolocation-cn': 'Non-CN 分流模式国内域名规则集',
	'geoip-cn': 'Non-CN 分流模式与 IPv6 策略国内 IP 规则集'
};

function formatBytes(n) {
	n = parseInt(n, 10) || 0;
	if (n <= 0) return '-';
	if (n < 1024) return n + ' B';
	if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
	return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

function formatTime(ts) {
	if (!ts) return '-';
	return new Date(ts * 1000).toLocaleString();
}

return view.extend({
	load: function() {
		return api.buildCurrentConfig().then(function(ctx) {
			var manifestStr = JSON.stringify(ctx.result.ruleSets, null, 2);
			return api.rulesetStatus(manifestStr).then(function(st) {
				return { ctx: ctx, status: st || { items: [] } };
			});
		});
	},

	render: function(data) {
		var ctx = data.ctx;
		var urlOverrides = Object.assign({}, ctx.urlOverrides || {});
		var items = (data.status && data.status.items) || [];

		// Also compute default (un-overridden) URLs for "恢复默认"
		var defaultUrlMap = {};
		var plainSettings = Object.assign({}, ctx.settings, {
			paths: Object.assign({}, ctx.settings.paths, { ruleSetUrlOverrides: {} })
		});
		if (window.SingboxConfgen) {
			var plainOut = window.SingboxConfgen.generateOpenWrtConfig(ctx.profile, plainSettings);
			(plainOut.ruleSets || []).forEach(function(r) {
				defaultUrlMap[r.tag] = r.url;
			});
		}

		var tableWrap = E('div', { 'class': 'cbi-section', 'style': 'margin-top:12px;' });
		var msgBox = E('div', { 'style': 'margin-top:10px;' });

		var showMsg = function(ok, text) {
			msgBox.innerHTML = '';
			msgBox.appendChild(E('div', {
				'style': 'padding:8px 12px;border-radius:4px;background:' + (ok ? '#f0fdf4' : '#fef2f2') + ';border:1px solid ' + (ok ? '#86efac' : '#fca5a5') + ';white-space:pre-wrap;font-size:13px;'
			}, text));
		};

		var currentManifestJson = function() {
			return JSON.stringify(items.map(function(it) {
				return { tag: it.tag, url: it.url, format: it.format, path: it.path };
			}), null, 2);
		};

		var reloadList = function() {
			return api.buildCurrentConfig().then(function(newCtx) {
				ctx = newCtx;
				urlOverrides = Object.assign({}, newCtx.urlOverrides || {});
				var mStr = JSON.stringify(newCtx.result.ruleSets, null, 2);
				return api.rulesetStatus(mStr).then(function(r) {
					items = (r && r.items) || [];
					renderTable();
				});
			});
		};

		var doUpdate = function(tag) {
			var mStr = currentManifestJson();
			ui.showModal('更新规则集', [E('p', { 'class': 'spinning' }, tag ? ('正在下载更新规则集 ' + tag + '...') : '正在下载更新全部本地规则集...')]);
			return api.rulesetUpdate(tag || '', mStr).then(function(r) {
				ui.hideModal();
				if (r && r.ok) {
					showMsg(true, '规则集更新完成：' + ((r.updated && r.updated.length) ? r.updated.join(', ') : '无变更'));
				} else {
					var failed = (r && r.failed && r.failed.length)
						? ('失败项：' + r.failed.join(', ') + '（已保留旧文件）')
						: ((r && (r.error || r.output)) || '更新失败');
					showMsg(false, failed);
				}
				return reloadList();
			}).catch(function(err) {
				ui.hideModal();
				showMsg(false, '更新异常：' + String(err));
			});
		};

		var uploadLocalFile = function(it) {
			var input = document.createElement('input');
			input.type = 'file';
			input.accept = it.format === 'source' ? '.json' : '.srs';
			input.onchange = function() {
				var file = input.files && input.files[0];
				if (!file) return;
				if (file.size > 16 * 1024 * 1024) {
					showMsg(false, '文件过大（超过 16MB）');
					return;
				}
				ui.showModal('离线上传规则集', [E('p', { 'class': 'spinning' }, '正在上传 ' + file.name + ' 到路由器...')]);
				var reader = new FileReader();
				reader.onload = function() {
					var bytes = new Uint8Array(reader.result);
					var bin = '';
					var chunk = 0x8000;
					for (var i = 0; i < bytes.length; i += chunk) {
						bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
					}
					var b64 = btoa(bin);
					api.rulesetUpload(it.tag, it.format || 'binary', b64).then(function(res) {
						ui.hideModal();
						if (res && res.ok) {
							showMsg(true, '规则集「' + it.tag + '」离线上传成功（' + formatBytes(res.size) + '），保存至 ' + res.path);
							reloadList();
						} else {
							showMsg(false, '上传失败：' + ((res && res.error) || '未知错误'));
						}
					}).catch(function(err) {
						ui.hideModal();
						showMsg(false, '上传异常：' + String(err));
					});
				};
				reader.onerror = function() {
					ui.hideModal();
					showMsg(false, '读取本地文件失败');
				};
				reader.readAsArrayBuffer(file);
			};
			input.click();
		};

		var openEditUrlModal = function(it) {
			var defUrl = defaultUrlMap[it.tag] || it.url;
			var urlInput = E('input', {
				'type': 'text',
				'class': 'cbi-input-text',
				'value': it.url || '',
				'style': 'width:100%;font-family:monospace;font-size:12px;'
			});
			var errDiv = E('div', { 'style': 'color:#dc2626;font-size:12px;margin-top:6px;' });

			ui.showModal('修改规则集在线下载地址：' + it.tag, [
				E('div', { 'style': 'margin-bottom:8px;font-size:12px;color:#555;' }, [
					'默认地址：',
					E('code', { 'style': 'word-break:break-all;' }, defUrl)
				]),
				E('div', { 'style': 'margin-bottom:8px;' }, [
					E('label', { 'style': 'display:block;font-weight:600;margin-bottom:4px;' }, '在线 URL（http:// 或 https://）'),
					urlInput,
					errDiv
				]),
				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn',
						'click': function() {
							urlInput.value = defUrl;
						}
					}, '填入默认地址'),
					' ',
					E('button', { 'class': 'btn', 'click': ui.hideModal }, '取消'),
					' ',
					E('button', {
						'class': 'btn cbi-button-action',
						'click': function() {
							var nextUrl = urlInput.value.trim();
							if (!/^https?:\/\/\S+$/i.test(nextUrl)) {
								errDiv.textContent = '请输入有效的 http:// 或 https:// 下载地址';
								return;
							}
							if (nextUrl === defUrl) {
								delete urlOverrides[it.tag];
							} else {
								urlOverrides[it.tag] = nextUrl;
							}
							it.url = nextUrl;
							var mStr = currentManifestJson();
							api.saveRulesetUrls(JSON.stringify(urlOverrides, null, 2), mStr).then(function(res) {
								ui.hideModal();
								if (res && res.ok) {
									showMsg(true, '规则集「' + it.tag + '」下载地址已保存，点击「更新」即可按新地址拉取');
									renderTable();
								} else {
									showMsg(false, '保存失败：' + ((res && res.error) || '未知错误'));
								}
							});
						}
					}, '保存地址')
				])
			]);
		};

		var renderTable = function() {
			var rows = [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, '规则集 / 用途'),
					E('th', { 'class': 'th' }, '本地状态'),
					E('th', { 'class': 'th' }, '大小 / 更新时间'),
					E('th', { 'class': 'th' }, '在线下载地址'),
					E('th', { 'class': 'th' }, '本地路径'),
					E('th', { 'class': 'th' }, '操作')
				])
			];

			if (!items.length) {
				rows.push(E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td', 'colspan': '6', 'style': 'text-align:center;color:#666;' }, '当前配置未引用任何外部规则集。')
				]));
			} else {
				items.forEach(function(it) {
					var desc = BUILTIN_DESCRIPTIONS[it.tag] || '自定义路由规则引用';
					var isCustom = !!urlOverrides[it.tag];

					rows.push(E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td' }, [
							E('div', {}, [
								E('strong', {}, it.tag),
								isCustom ? E('span', { 'style': 'margin-left:6px;font-size:11px;padding:1px 5px;border-radius:3px;background:#dbeafe;color:#1d4ed8;' }, '自定义源') : ''
							]),
							E('div', { 'style': 'font-size:11px;color:#666;' }, desc)
						]),
						E('td', { 'class': 'td' }, E('span', { 'style': 'color:' + (it.exists ? '#16a34a' : '#dc2626') + ';font-weight:600;' }, it.exists ? '已就绪' : '缺失')),
						E('td', { 'class': 'td', 'style': 'font-size:12px;' }, [
							E('div', {}, formatBytes(it.size)),
							E('div', { 'style': 'color:#666;font-size:11px;' }, formatTime(it.mtime))
						]),
						E('td', { 'class': 'td', 'style': 'font-family:monospace;font-size:11px;max-width:260px;word-break:break-all;' }, it.url || '-'),
						E('td', { 'class': 'td', 'style': 'font-family:monospace;font-size:11px;' }, it.path || '-'),
						E('td', { 'class': 'td', 'style': 'white-space:nowrap;' }, [
							E('button', { 'class': 'btn', 'click': function() { openEditUrlModal(it); } }, '修改 URL'),
							' ',
							E('button', { 'class': 'btn', 'click': function() { uploadLocalFile(it); } }, '离线上传'),
							' ',
							E('button', { 'class': 'btn cbi-button-action', 'click': function() { doUpdate(it.tag); } }, '更新')
						])
					]));
				});
			}

			tableWrap.innerHTML = '';
			tableWrap.appendChild(E('table', { 'class': 'table' }, rows));
		};

		renderTable();

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, '规则集管理'),
			E('div', { 'class': 'cbi-map-descr' }, '此处直接列出所有分流模式（GFWList / Non-CN / 自定义路由）引用的规则集。sing-box 从本地目录读取，支持随时修改在线下载地址并手动更新（首次启动若缺失也会自动下载）。'),
			E('div', { 'style': 'display:flex;gap:8px;' }, [
				E('button', { 'class': 'btn cbi-button-action', 'click': function() { doUpdate(''); } }, '更新全部规则集'),
				E('button', { 'class': 'btn', 'click': reloadList }, '刷新状态')
			]),
			msgBox,
			tableWrap
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
