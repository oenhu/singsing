'use strict';
'require view';
'require ui';
'require singsing.api as api';

return view.extend({
	load: function() {
		return Promise.all([
			api.listProfiles(),
			api.loadActiveProfile(),
			api.buildCurrentConfig()
		]);
	},

	render: function(data) {
		var listRes = data[0] || {};
		var loaded = data[1];
		var built = data[2];
		var engine = loaded.engine;
		var activeName = loaded.name;
		var profiles = (listRes.profiles && listRes.profiles.length) ? listRes.profiles : [activeName];
		if (profiles.indexOf(activeName) < 0) profiles.unshift(activeName);

		var statusBar = E('div', { 'style': 'margin-top:10px;' });
		var listWrap = E('div', { 'class': 'cbi-section', 'style': 'margin-top:12px;' });
		var jsonPre = E('pre', {
			'style': 'max-height:420px;overflow:auto;background:#0f172a;color:#e2e8f0;padding:12px;border-radius:6px;font-size:12px;margin-top:8px;'
		}, JSON.stringify(built.result.config, null, 2));

		var notify = function(ok, text) {
			statusBar.innerHTML = '';
			statusBar.appendChild(E('div', {
				'style': 'padding:8px 12px;border-radius:4px;background:' + (ok ? '#f0fdf4' : '#fef2f2') + ';color:' + (ok ? '#166534' : '#991b1b') + ';border:1px solid ' + (ok ? '#86efac' : '#fca5a5') + ';white-space:pre-wrap;font-size:13px;'
			}, text));
		};

		var reloadPage = function() {
			window.location.reload();
		};

		var createProfileModal = function(cloneFromCurrent) {
			var nameInput = E('input', { 'type': 'text', 'class': 'cbi-input-text', 'placeholder': '仅支持字母、数字、-、_（例如 work）', 'style': 'width:100%;' });
			var errDiv = E('div', { 'style': 'color:#dc2626;font-size:12px;margin-top:6px;' });
			ui.showModal(cloneFromCurrent ? '复制当前配置方案' : '新建空白配置方案', [
				E('div', {}, [
					E('label', { 'style': 'display:block;font-weight:600;margin-bottom:4px;' }, '配置方案名称'),
					nameInput,
					errDiv
				]),
				E('div', { 'class': 'right', 'style': 'margin-top:10px;' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, '取消'),
					' ',
					E('button', {
						'class': 'btn cbi-button-action',
						'click': function() {
							var name = nameInput.value.trim();
							if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
								errDiv.textContent = '名称仅支持 1-64 位字母、数字、-、_';
								return;
							}
							if (profiles.indexOf(name) >= 0) {
								errDiv.textContent = '配置方案「' + name + '」已存在，请使用其他名称';
								return;
							}
							var payload = cloneFromCurrent ? loaded.profile : engine.blueprintProfile();
							api.saveProfile(name, payload).then(function(res) {
								if (res && res.ok) {
									ui.hideModal();
									reloadPage();
								} else {
									errDiv.textContent = (res && res.error) || '创建失败';
								}
							});
						}
					}, '创建')
				])
			]);
		};

		var openImportProfileModal = function() {
			var area = E('textarea', {
				'style': 'width:100%;height:240px;font-family:monospace;font-size:12px;',
				'placeholder': '粘贴 singsing 导出的 Profile JSON（兼容上游 v1 / v2 格式）...'
			});
			var errDiv = E('div', { 'style': 'color:#dc2626;font-size:12px;margin-top:6px;' });
			ui.showModal('导入 Profile JSON（覆盖当前方案：' + activeName + '）', [
				area,
				errDiv,
				E('div', { 'class': 'right', 'style': 'margin-top:10px;' }, [
					E('button', { 'class': 'btn', 'click': ui.hideModal }, '取消'),
					' ',
					E('button', {
						'class': 'btn cbi-button-action',
						'click': function() {
							try {
								var raw = JSON.parse(area.value);
								var normalized = engine.normalizeProfile(raw);
								if (!window.confirm('确定用导入内容覆盖当前方案「' + activeName + '」吗？')) return;
								api.saveProfile(activeName, normalized).then(function(res) {
									if (res && res.ok) {
										ui.hideModal();
										reloadPage();
									} else {
										errDiv.textContent = (res && res.error) || '保存失败';
									}
								});
							} catch (e) {
								errDiv.textContent = 'JSON 解析失败：' + e.message;
							}
						}
					}, '导入并保存')
				])
			]);
		};

		var exportProfile = function() {
			var blob = new Blob([JSON.stringify(loaded.profile, null, 2)], { type: 'application/json' });
			var url = URL.createObjectURL(blob);
			var a = document.createElement('a');
			a.href = url;
			a.download = 'singbox-profile-' + activeName + '.json';
			a.click();
			setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
		};

		var validateOnRouter = function() {
			ui.showModal('核心配置校验', [E('p', { 'class': 'spinning' }, '正在调用路由器 sing-box check 校验...')]);
			api.validateConfig(JSON.stringify(built.result.config, null, 2)).then(function(res) {
				ui.hideModal();
				if (res && res.ok) notify(true, 'sing-box check 校验通过！' + (res.output ? ('\n' + res.output) : ''));
				else notify(false, 'sing-box check 未通过：\n' + ((res && (res.output || res.error)) || '未知错误'));
			});
		};

		var rows = [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, '方案名称'),
				E('th', { 'class': 'th' }, '状态'),
				E('th', { 'class': 'th' }, '操作')
			])
		];
		profiles.forEach(function(name) {
			var isActive = name === activeName;
			rows.push(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, E('strong', {}, name)),
				E('td', { 'class': 'td' }, isActive ? E('span', { 'style': 'color:#16a34a;font-weight:600;' }, '当前启用') : '备用'),
				E('td', { 'class': 'td' }, [
					!isActive ? E('button', {
						'class': 'btn cbi-button-action',
						'click': function() {
							api.switchActiveProfile(name).then(reloadPage);
						}
					}, '切换启用') : '',
					' ',
					(!isActive && name !== 'default') ? E('button', {
						'class': 'btn cbi-button-remove',
						'click': function() {
							if (!window.confirm('确定删除配置方案「' + name + '」及其绑定的订阅吗？')) return;
							api.deleteProfile(name).then(reloadPage);
						}
					}, '删除') : ''
				])
			]));
		});
		this._saveFn = function() {
			return api.saveProfile(activeName, loaded.profile).then(function(res) {
				if (res && res.ok) {
					ui.addNotification(null, E('p', '当前配置方案「' + activeName + '」已保存'), 'info');
					return res;
				}
				var msg = (res && res.error) || '未知错误';
				ui.addNotification('保存失败', E('p', msg), 'danger');
				return Promise.reject(new Error(msg));
			});
		};

		listWrap.appendChild(E('table', { 'class': 'table' }, rows));

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, '配置方案管理'),
			E('div', { 'class': 'cbi-map-descr' }, '管理多个独立的 Profile JSON 配置方案（与上游 singsing 格式完全互通），支持导入/导出、生成预览与路由器端 sing-box check 校验。'),
			E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:8px;' }, [
				E('button', { 'class': 'btn cbi-button-add', 'click': function() { createProfileModal(false); } }, '新建方案'),
				E('button', { 'class': 'btn', 'click': function() { createProfileModal(true); } }, '复制当前方案'),
				E('button', { 'class': 'btn', 'click': openImportProfileModal }, '导入 Profile JSON'),
				E('button', { 'class': 'btn', 'click': exportProfile }, '导出当前 Profile JSON'),
				E('button', { 'class': 'btn cbi-button-action', 'click': validateOnRouter }, '运行 sing-box check 校验')
			]),
			statusBar,
			listWrap,
			E('div', { 'class': 'cbi-section', 'style': 'margin-top:16px;' }, [
				E('h3', {}, '当前方案生成的 OpenWrt sing-box 配置预览（' + activeName + '）'),
				jsonPre
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
