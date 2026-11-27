'use strict';
'require baseclass';
'require rpc';
'require uci';
'require ui';

var callStatus = rpc.declare({
	object: 'luci.singsing',
	method: 'status',
	expect: {}
});

var callCommitUci = rpc.declare({
	object: 'uci',
	method: 'commit',
	params: ['config'],
	reject: true
});

var callGetProfile = rpc.declare({
	object: 'luci.singsing',
	method: 'get_profile',
	params: ['name'],
	expect: {}
});

var callSaveProfile = rpc.declare({
	object: 'luci.singsing',
	method: 'save_profile',
	params: ['name', 'profile'],
	expect: {}
});

var callListProfiles = rpc.declare({
	object: 'luci.singsing',
	method: 'list_profiles',
	expect: {}
});

var callDeleteProfile = rpc.declare({
	object: 'luci.singsing',
	method: 'delete_profile',
	params: ['name'],
	expect: {}
});

var callValidateConfig = rpc.declare({
	object: 'luci.singsing',
	method: 'validate_config',
	params: ['config'],
	expect: {}
});

var callWriteConfig = rpc.declare({
	object: 'luci.singsing',
	method: 'write_config',
	params: ['config', 'manifest'],
	expect: {}
});

var callApplyConfig = rpc.declare({
	object: 'luci.singsing',
	method: 'apply_config',
	params: ['config', 'manifest'],
	expect: {}
});

var callServiceAction = rpc.declare({
	object: 'luci.singsing',
	method: 'service_action',
	params: ['action'],
	expect: {}
});

var callDnsCheck = rpc.declare({
	object: 'luci.singsing',
	method: 'dns_check',
	expect: {}
});

var callRulesetStatus = rpc.declare({
	object: 'luci.singsing',
	method: 'ruleset_status',
	params: ['manifest'],
	expect: {}
});

var callGetRulesetUrls = rpc.declare({
	object: 'luci.singsing',
	method: 'get_ruleset_urls',
	expect: {}
});

var callSaveRulesetUrls = rpc.declare({
	object: 'luci.singsing',
	method: 'save_ruleset_urls',
	params: ['urls', 'manifest'],
	expect: {}
});

var callRulesetUpdate = rpc.declare({
	object: 'luci.singsing',
	method: 'ruleset_update',
	params: ['tag', 'manifest'],
	expect: {}
});

var callRulesetUpload = rpc.declare({
	object: 'luci.singsing',
	method: 'ruleset_upload',
	params: ['tag', 'format', 'content_b64', 'chunk_index', 'total_chunks'],
	expect: {}
});

var callConnectivityCheck = rpc.declare({
	object: 'luci.singsing',
	method: 'connectivity_check',
	expect: {}
});

var callGetAccessControl = rpc.declare({
	object: 'luci.singsing',
	method: 'get_access_control',
	expect: {}
});

var callSaveAccessControl = rpc.declare({
	object: 'luci.singsing',
	method: 'save_access_control',
	params: ['data'],
	expect: {}
});

var callGetLanClients = rpc.declare({
	object: 'luci.singsing',
	method: 'get_lan_clients',
	expect: {}
});

var callGetLogs = rpc.declare({
	object: 'luci.singsing',
	method: 'get_logs',
	params: ['lines'],
	expect: {}
});

var callClashApi = rpc.declare({
	object: 'luci.singsing',
	method: 'clash_api',
	params: ['method', 'path', 'body'],
	expect: {}
});

var enginePromise = null;

function loadEngine() {
	if (window.SingboxConfgen)
		return Promise.resolve(window.SingboxConfgen);
	if (enginePromise)
		return enginePromise;

	enginePromise = new Promise(function(resolve, reject) {
		var script = document.createElement('script');
		script.src = L.resource('singsing/engine-bundle.js');
		script.onload = function() {
			if (window.SingboxConfgen) resolve(window.SingboxConfgen);
			else reject(new Error('SingboxConfgen bundle failed to initialize'));
		};
		script.onerror = function() {
			reject(new Error('Failed to load engine-bundle.js'));
		};
		document.head.appendChild(script);
	});
	return enginePromise;
}

function reloadUciSingsing() {
	uci.unload('singsing');
	return uci.load('singsing');
}

function readOpenWrtSettings(lanIps) {
	return Promise.all([reloadUciSingsing(), loadEngine()]).then(function(results) {
		var engine = results[1];
		var get = function(sec, opt, def) {
			var v = uci.get('singsing', sec, opt);
			return (v !== undefined && v !== null && v !== '') ? v : def;
		};
		var bool = function(sec, opt, def) {
			return get(sec, opt, def ? '1' : '0') === '1';
		};
		var portNum = function(sec, opt, def) {
			var value = String(get(sec, opt, def));
			return /^\d+$/.test(value) ? Number(value) : NaN;
		};
		var splitList = function(raw) {
			if (Array.isArray(raw))
				return raw.map(function(x) { return String(x || '').trim(); }).filter(Boolean);
			if (typeof raw === 'string' && raw.trim())
				return raw.split(/[\s,]+/).map(function(x) { return x.trim(); }).filter(Boolean);
			return [];
		};
		var localType = get('dns', 'local_type', 'udp');
		var mtuRaw = uci.get('singsing', 'tun', 'mtu');
		var mtu = (mtuRaw === undefined || mtuRaw === null)
			? 9000
			: ((String(mtuRaw).trim() && /^\d+$/.test(String(mtuRaw).trim())) ? parseInt(mtuRaw, 10) : null);
		var routeExcludes = splitList(uci.get('singsing', 'tun', 'route_exclude_address'));
		var includeInterfaces = splitList(uci.get('singsing', 'tun', 'include_interface'));

		return {
			dns: {
				localType: localType,
				localServer: get('dns', 'local_server', ''),
				localPort: portNum('dns', 'local_port', engine.defaultPortForDnsType(localType)),
				localServerName: get('dns', 'local_server_name', ''),
				localPath: get('dns', 'local_path', '/dns-query'),
				localBootstrap: get('dns', 'local_bootstrap', ''),
				localBackupServer: get('dns', 'local_backup_server', ''),
				listenAddress: get('dns', 'listen_address', '127.0.0.1'),
				listenPort: portNum('dns', 'listen_port', 5335),
				hijack: bool('dns', 'hijack', true),
				dnsmasqManage: bool('dns', 'dnsmasq_manage', true),
				allowProxyIpv6: bool('dns', 'allow_proxy_ipv6', false)
			},
			tun: {
				enabled: bool('tun', 'enabled', true),
				interfaceName: get('tun', 'interface_name', 'singtun'),
				addressV4: get('tun', 'address_v4', '172.19.0.1/30'),
				addressV6: get('tun', 'address_v6', 'fdfe:dcba:9876::1/126'),
				autoRoute: bool('tun', 'auto_route', true),
				autoRedirect: bool('tun', 'auto_redirect', true),
				strictRoute: bool('tun', 'strict_route', false),
				ipv6: bool('tun', 'ipv6', true),
				ipv6Mode: get('tun', 'ipv6_mode', 'direct'),
				mtu: mtu,
				udpTimeout: get('tun', 'udp_timeout', ''),
				routeExcludeAddress: routeExcludes,
				routeExcludeCn: bool('tun', 'route_exclude_cn', false),
				includeInterface: includeInterfaces,
				defaultInterface: get('tun', 'default_interface', '')
			},
			mixed: {
				enabled: bool('mixed', 'enabled', false),
				listenAddress: get('mixed', 'listen_address', '::'),
				listenPort: portNum('mixed', 'listen_port', 5330)
			},
			routing: {
				bypassCn: bool('routing', 'bypass_cn', true),
				cnSiteRuleset: get('routing', 'cn_site_ruleset', 'geosite-cn'),
				portMode: get('routing', 'port_mode', 'all'),
				customPorts: get('routing', 'custom_ports', ''),
				blockQuic: bool('routing', 'block_quic', false)
			},
			paths: {
				cacheFile: get('main', 'cache_file', '/tmp/singsing/cache.db'),
				ruleSetDir: get('main', 'ruleset_dir', '/etc/sing-box/rule-sets'),
				tailscaleStateRoot: get('main', 'tailscale_state_root', '/etc/sing-box/tailscale')
			},
			logLevel: get('main', 'log_level', 'info'),
			routerLanIps: Array.isArray(lanIps) ? lanIps : []
		};
	});
}

function loadActiveProfile() {
	return Promise.all([loadEngine(), reloadUciSingsing()]).then(function(res) {
		var engine = res[0];
		var name = uci.get('singsing', 'main', 'active_profile') || 'default';
		return callGetProfile(name).then(function(pRes) {
			if (!pRes || pRes.ok !== true)
				throw new Error('读取配置方案「' + name + '」失败：' + ((pRes && pRes.error) || 'RPC 未返回有效结果'));
			if (pRes.exists === false) {
				var fresh = engine.openWrtBlueprintProfile ? engine.openWrtBlueprintProfile() : engine.blueprintProfile();
				return { name: name, profile: fresh, engine: engine };
			}
			try {
				return { name: name, profile: engine.normalizeProfile(pRes.profile), engine: engine };
			} catch (e) {
				throw new Error('配置方案「' + name + '」损坏：' + e.message);
			}
		});
	});
}

function saveActiveProfile(name, profile) {
	return callSaveProfile(name || 'default', JSON.stringify(profile));
}

function buildCurrentConfig() {
	return Promise.all([
		loadActiveProfile(),
		callStatus(),
		callGetRulesetUrls().catch(function() { return { urls: {} }; }),
		callGetAccessControl()
	]).then(function(res) {
		var loaded = res[0];
		var st = res[1] || {};
		var urlOverrides = (res[2] && res[2].urls) || {};
		var acRes = res[3];
		if (!acRes || (acRes.ok !== undefined && acRes.ok !== true) || !acRes.access_control || typeof acRes.access_control !== 'object')
			throw new Error('读取客户端访问控制配置失败：' + ((acRes && acRes.error) || 'RPC 未返回有效结果'));
		var accessControl = acRes.access_control;
		return readOpenWrtSettings(st.lan_ips || []).then(function(settings) {
			settings.paths.ruleSetUrlOverrides = urlOverrides;
			settings.accessControl = accessControl;
			var out = loaded.engine.generateOpenWrtConfig(loaded.profile, settings);
			return {
				profileName: loaded.name,
				profile: loaded.profile,
				settings: settings,
				urlOverrides: urlOverrides,
				accessControl: accessControl,
				result: out
			};
		});
	});
}

function generateAndWrite() {
	return buildCurrentConfig().then(function(ctx) {
		var errors = ctx.result.issues.filter(function(i) { return i.level === 'error'; });
		if (errors.length > 0) {
			return {
				ok: false,
				validationErrors: errors,
				warnings: ctx.result.issues.filter(function(i) { return i.level === 'warning'; })
			};
		}
		return callWriteConfig(
			JSON.stringify(ctx.result.config, null, 2),
			JSON.stringify(ctx.result.ruleSets, null, 2)
		).then(function(writeRes) {
			return Object.assign({}, writeRes, {
				warnings: ctx.result.issues.filter(function(i) { return i.level === 'warning'; })
			});
		});
	});
}

function generateAndApply() {
	return buildCurrentConfig().then(function(ctx) {
		var errors = ctx.result.issues.filter(function(i) { return i.level === 'error'; });
		if (errors.length > 0) {
			return {
				ok: false,
				validationErrors: errors,
				warnings: ctx.result.issues.filter(function(i) { return i.level === 'warning'; })
			};
		}
		return callApplyConfig(
			JSON.stringify(ctx.result.config, null, 2),
			JSON.stringify(ctx.result.ruleSets, null, 2)
		).then(function(applyRes) {
			return Object.assign({}, applyRes, {
				warnings: ctx.result.issues.filter(function(i) { return i.level === 'warning'; })
			});
		});
	});
}

function applyUciIfChanged() {
	return uci.save().then(function() {
		return uci.changes();
	}).then(function(changes) {
		if (!changes || !changes.singsing || !Object.keys(changes.singsing).length)
			return;

		// LuCI stages changes in its RPC session's UCI save directory.
		return callCommitUci('singsing').then(function(code) {
			if (code !== 0)
				throw new Error('UCI 未确认提交');
			return uci.changes();
		}).then(function(pending) {
			if (pending && pending.singsing && Object.keys(pending.singsing).length)
				throw new Error('UCI 仍有未提交的 singsing 设置');
			return reloadUciSingsing();
		}).catch(function(err) {
			throw new Error('提交 UCI 设置失败：' + err.message);
		});
	});
}

function switchActiveProfile(name) {
	return reloadUciSingsing().then(function() {
		uci.set('singsing', 'main', 'active_profile', name);
		return applyUciIfChanged();
	});
}

function clashGetConfigs() {
	return callClashApi('GET', '/configs', '');
}

function clashSetMode(mode) {
	return callClashApi('PATCH', '/configs', JSON.stringify({ mode: mode }));
}

function clashGetProxies() {
	return callClashApi('GET', '/proxies', '');
}

function clashSelectProxy(group, name) {
	return callClashApi('PUT', '/proxies/' + encodeURIComponent(group), JSON.stringify({ name: name }));
}

function clashTestDelay(name, url, timeout) {
	var q = '?timeout=' + encodeURIComponent(String(timeout || 5000)) +
		'&url=' + encodeURIComponent(url || 'https://www.gstatic.com/generate_204');
	return callClashApi('GET', '/proxies/' + encodeURIComponent(name) + '/delay' + q, '');
}

function clashTestGroupDelay(group, url, timeout) {
	var q = '?timeout=' + encodeURIComponent(String(timeout || 5000)) +
		'&url=' + encodeURIComponent(url || 'https://www.gstatic.com/generate_204');
	return callClashApi('GET', '/group/' + encodeURIComponent(group) + '/delay' + q, '');
}

function clashGetConnections() {
	return callClashApi('GET', '/connections', '');
}

function clashCloseConnection(id) {
	return callClashApi('DELETE', '/connections/' + encodeURIComponent(id), '');
}

function clashCloseAllConnections() {
	return callClashApi('DELETE', '/connections', '');
}

function stopDisabledService(st) {
	if (!st || (!st.running && !st.dnsmasq_taken_over)) return Promise.resolve({ ok: true });
	return callServiceAction('stop').catch(function(err) {
		return { ok: false, output: err.message };
	});
}

function applyWithNotify() {
	return Promise.all([reloadUciSingsing(), callStatus()]).then(function(res) {
		var st = res[1] || {};
		var enabled = uci.get('singsing', 'main', 'enabled') === '1';
		if (!enabled) {
			return stopDisabledService(st).then(function(res) {
				if (!res || res.ok !== true) {
					var detail = (res && (res.error || res.output)) || '服务未确认停止';
					ui.addNotification('停止服务失败', E('p', detail), 'danger');
					return { ok: false, output: '停止服务失败：' + detail };
				}
				ui.addNotification(null, E('p', '配置已保存（当前「启用服务」未开启，未下载规则集且未启动 sing-box）'), 'info');
				return { ok: true, skipped_start: true };
			});
		}
		ui.showModal('保存并应用', [E('p', { 'class': 'spinning' }, '正在生成配置、校验并重启 sing-box...')]);
		return generateAndApply().then(function(applyRes) {
			ui.hideModal();
			if (applyRes && applyRes.validationErrors && applyRes.validationErrors.length) {
				var lines = applyRes.validationErrors.map(function(e) { return '• ' + e.message; }).join('\n');
				ui.addNotification('配置校验未通过，已保存但未应用', E('pre', { 'style': 'white-space:pre-wrap;' }, lines), 'danger');
			} else if (applyRes && applyRes.ok) {
				ui.addNotification(null, E('p', '配置已保存并成功应用到 sing-box'), 'info');
			} else if (applyRes && applyRes.rolled_back) {
				ui.addNotification('启动失败已自动回滚', E('pre', { 'style': 'white-space:pre-wrap;' }, applyRes.output || ''), 'warning');
			} else {
				ui.addNotification('应用配置失败', E('pre', { 'style': 'white-space:pre-wrap;' }, (applyRes && (applyRes.error || applyRes.output)) || '未知错误'), 'danger');
			}
			return applyRes;
		}).catch(function(err) {
			ui.hideModal();
			ui.addNotification('应用配置异常', E('p', String(err)), 'danger');
			return { ok: false, output: String(err) };
		});
	});
}

return baseclass.extend({
	status: callStatus,
	commitUci: callCommitUci,
	getProfile: callGetProfile,
	saveProfile: saveActiveProfile,
	listProfiles: callListProfiles,
	deleteProfile: callDeleteProfile,
	switchActiveProfile: switchActiveProfile,
	validateConfig: callValidateConfig,
	writeConfig: callWriteConfig,
	applyConfig: callApplyConfig,
	serviceAction: callServiceAction,
	dnsCheck: callDnsCheck,
	rulesetStatus: callRulesetStatus,
	getRulesetUrls: callGetRulesetUrls,
	saveRulesetUrls: callSaveRulesetUrls,
	rulesetUpdate: callRulesetUpdate,
	rulesetUpload: callRulesetUpload,
	connectivityCheck: callConnectivityCheck,
	getAccessControl: callGetAccessControl,
	saveAccessControl: callSaveAccessControl,
	getLanClients: callGetLanClients,
	getLogs: callGetLogs,
	clashApi: callClashApi,
	clashGetConfigs: clashGetConfigs,
	clashSetMode: clashSetMode,
	clashGetProxies: clashGetProxies,
	clashSelectProxy: clashSelectProxy,
	clashTestDelay: clashTestDelay,
	clashTestGroupDelay: clashTestGroupDelay,
	clashGetConnections: clashGetConnections,
	clashCloseConnection: clashCloseConnection,
	clashCloseAllConnections: clashCloseAllConnections,
	loadEngine: loadEngine,
	readOpenWrtSettings: readOpenWrtSettings,
	loadActiveProfile: loadActiveProfile,
	buildCurrentConfig: buildCurrentConfig,
	generateAndWrite: generateAndWrite,
	generateAndApply: generateAndApply,
	stopDisabledService: stopDisabledService,
	applyWithNotify: applyWithNotify,
	applyUciIfChanged: applyUciIfChanged
});
