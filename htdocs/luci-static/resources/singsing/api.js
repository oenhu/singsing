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
	object: 'luci.singsing',
	method: 'commit_uci',
	expect: {}
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

var callGetSubscriptions = rpc.declare({
	object: 'luci.singsing',
	method: 'get_subscriptions',
	expect: {}
});

var callSaveSubscriptions = rpc.declare({
	object: 'luci.singsing',
	method: 'save_subscriptions',
	params: ['subscriptions'],
	expect: {}
});

var callFetchSubscription = rpc.declare({
	object: 'luci.singsing',
	method: 'fetch_subscription',
	params: ['url', 'user_agent'],
	expect: {}
});

var callSyncCron = rpc.declare({
	object: 'luci.singsing',
	method: 'sync_cron',
	expect: {}
});

var callRunSubUpdater = rpc.declare({
	object: 'luci.singsing',
	method: 'run_subscription_updater',
	params: ['id'],
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
	return reloadUciSingsing().then(function() {
		var get = function(sec, opt, def) {
			var v = uci.get('singsing', sec, opt);
			return (v !== undefined && v !== null && v !== '') ? v : def;
		};
		var bool = function(sec, opt, def) {
			return get(sec, opt, def ? '1' : '0') === '1';
		};
		var num = function(sec, opt, def) {
			var v = parseInt(get(sec, opt, String(def)), 10);
			return isNaN(v) ? def : v;
		};
		var mtuRaw = uci.get('singsing', 'tun', 'mtu');
		var mtu = (mtuRaw && /^\d+$/.test(String(mtuRaw).trim())) ? parseInt(mtuRaw, 10) : null;

		return {
			dns: {
				localType: get('dns', 'local_type', 'udp'),
				localServer: get('dns', 'local_server', ''),
				localPort: num('dns', 'local_port', 53),
				localServerName: get('dns', 'local_server_name', ''),
				localPath: get('dns', 'local_path', '/dns-query'),
				listenAddress: get('dns', 'listen_address', '127.0.0.1'),
				listenPort: num('dns', 'listen_port', 5335),
				hijack: bool('dns', 'hijack', true),
				dnsmasqManage: bool('dns', 'dnsmasq_manage', true)
			},
			tun: {
				enabled: bool('tun', 'enabled', true),
				interfaceName: get('tun', 'interface_name', 'singtun'),
				addressV4: get('tun', 'address_v4', '172.19.0.1/30'),
				addressV6: get('tun', 'address_v6', 'fdfe:dcba:9876::1/126'),
				autoRoute: bool('tun', 'auto_route', true),
				autoRedirect: bool('tun', 'auto_redirect', true),
				strictRoute: bool('tun', 'strict_route', true),
				ipv6: bool('tun', 'ipv6', true),
				mtu: mtu,
				routeExcludeAddress: []
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
			if (pRes && pRes.exists && pRes.profile) {
				try {
					return { name: name, profile: engine.normalizeProfile(pRes.profile), engine: engine };
				} catch (e) {
					return { name: name, profile: engine.blueprintProfile(), engine: engine, corruptedError: String(e) };
				}
			}
			return { name: name, profile: engine.blueprintProfile(), engine: engine };
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
		callGetAccessControl().catch(function() { return { access_control: { mode: 'all', clients: [], deviceRules: [] } }; })
	]).then(function(res) {
		var loaded = res[0];
		var st = res[1] || {};
		var urlOverrides = (res[2] && res[2].urls) || {};
		var accessControl = (res[3] && res[3].access_control) || { mode: 'all', clients: [], deviceRules: [] };
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
		if (changes && changes.singsing && Object.keys(changes.singsing).length > 0) {
			return callCommitUci().then(function() {
				return reloadUciSingsing();
			});
		}
		return Promise.resolve();
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

function applyWithNotify() {
	return Promise.all([reloadUciSingsing(), callStatus()]).then(function(res) {
		var st = res[1] || {};
		var enabled = uci.get('singsing', 'main', 'enabled') === '1';
		if (!enabled) {
			var stopPromise = (st.running || st.dnsmasq_taken_over)
				? callServiceAction('stop').catch(function() { return null; })
				: Promise.resolve();
			return stopPromise.then(function() {
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
	getSubscriptions: callGetSubscriptions,
	saveSubscriptions: callSaveSubscriptions,
	fetchSubscription: callFetchSubscription,
	syncCron: callSyncCron,
	runSubUpdater: callRunSubUpdater,
	loadEngine: loadEngine,
	readOpenWrtSettings: readOpenWrtSettings,
	loadActiveProfile: loadActiveProfile,
	buildCurrentConfig: buildCurrentConfig,
	generateAndApply: generateAndApply,
	applyWithNotify: applyWithNotify,
	applyUciIfChanged: applyUciIfChanged
});
