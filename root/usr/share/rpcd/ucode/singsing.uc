'use strict';

import { readfile, writefile, stat, unlink, rename, popen, lsdir, chmod, mkdir, mkdtemp, rmdir } from 'fs';
import { cursor } from 'uci';

const CONF_DIR = '/etc/singsing';
const PROFILES_DIR = `${CONF_DIR}/profiles`;
const MANIFEST_FILE = `${CONF_DIR}/rulesets-manifest.json`;
const RULESET_URLS_FILE = `${CONF_DIR}/ruleset-urls.json`;
const SUBS_FILE = `${CONF_DIR}/subscriptions.json`;
const ACCESS_FILE = `${CONF_DIR}/access-control.json`;
const DNSMASQ_BACKUP = `${CONF_DIR}/dnsmasq-backup.json`;
const SB_CONFIG = `${CONF_DIR}/sing-box.json`;
const SERVICE_MGR = '/usr/share/singsing/service-manager.sh';
const SUB_UPDATER = '/usr/share/singsing/subscription-updater.uc';
const INIT_SCRIPT = '/etc/init.d/singsing';
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

let tmpSeq = 0;

function safeJson(raw) {
	if (type(raw) != 'string') return null;
	let s = trim(raw);
	if (length(s) == 0) return null;
	try {
		return json(s);
	} catch (e) {
		return null;
	}
}

function safeJsonLastLine(raw) {
	let direct = safeJson(raw);
	if (direct != null) return direct;
	if (type(raw) != 'string') return null;
	let lines = split(trim(raw), '\n');
	for (let i = length(lines) - 1; i >= 0; i--) {
		let l = trim(lines[i]);
		if (substr(l, 0, 1) == '{' || substr(l, 0, 1) == '[') {
			let p = safeJson(l);
			if (p != null) return p;
		}
	}
	return null;
}

function writeFileSafe(path, data, mode) {
	let payload = (type(data) == 'string') ? data : ('' + (data ?? ''));
	let tmp = `${path}.tmp.${time()}.${++tmpSeq}`;
	let n = writefile(tmp, payload);
	if (n == null || n != length(payload)) {
		unlink(tmp);
		return false;
	}
	if (mode != null) chmod(tmp, mode);
	if (!rename(tmp, path)) {
		unlink(tmp);
		return false;
	}
	return true;
}

function runCmd(cmd) {
	let p = popen(cmd + ' 2>&1', 'r');
	if (!p) return { code: 127, output: 'Failed to execute command' };
	let out = p.read('all') || '';
	let rc = p.close();
	return { code: rc, output: trim(out) };
}

function shellQuote(s) {
	return "'" + replace('' + (s ?? ''), "'", "'\\''") + "'";
}

function safeProfileName(name) {
	if (type(name) != 'string' || !match(name, /^[a-zA-Z0-9_-]{1,64}$/))
		return null;
	return name;
}

function safeRulesetTag(tag) {
	if (type(tag) != 'string' || index(tag, '..') >= 0)
		return null;
	if (!match(tag, /^[a-zA-Z0-9_!@-][a-zA-Z0-9_!@.-]{0,127}$/))
		return null;
	return tag;
}

function getUci() {
	let c = cursor();
	c.load('singsing');
	return c;
}

function getSingboxBin(c) {
	return c.get('singsing', 'main', 'singbox_bin') || '/usr/bin/sing-box';
}

function getRulesetDir(c) {
	let dir = replace(c.get('singsing', 'main', 'ruleset_dir') || '/etc/sing-box/rule-sets', /\/+$/, '');
	if (substr(dir, 0, 1) != '/' || index(dir, '..') >= 0)
		return '/etc/sing-box/rule-sets';
	return dir;
}

function sanitizeManifest(raw, c) {
	let arr = (type(raw) == 'string') ? safeJson(raw) : raw;
	if (type(arr) != 'array') return null;
	let dir = getRulesetDir(c);
	let out = [];
	for (let r in arr) {
		if (type(r) != 'object') return null;
		let tag = safeRulesetTag(r.tag);
		if (!tag) return null;
		let fmt = (r.format == 'source') ? 'source' : 'binary';
		let url = trim('' + (r.url || ''));
		if (length(url) > 0 && !match(url, /^https?:\/\/[^[:space:]]+$/))
			return null;
		let ext = (fmt == 'source') ? 'json' : 'srs';
		push(out, {
			tag: tag,
			url: url,
			format: fmt,
			path: `${dir}/${tag}.${ext}`
		});
	}
	return out;
}

function getDnsmasqDropinPath() {
	let r = runCmd(`uci -q show "dhcp.@dnsmasq[0]" 2>/dev/null | awk 'NR==1 {split($0, c, /[.=]/); print c[2]}'`);
	let confDir = '/tmp/dnsmasq.d';
	if (r.code == 0 && length(r.output) > 0) {
		let cfgPath = `/tmp/etc/dnsmasq.conf.${r.output}`;
		let raw = readfile(cfgPath);
		if (raw) {
			for (let line in split(raw, '\n')) {
				if (substr(line, 0, 9) == 'conf-dir=') {
					let d = trim(substr(line, 9));
					let comma = index(d, ',');
					if (comma >= 0) d = trim(substr(d, 0, comma));
					if (length(d) > 0) confDir = d;
					break;
				}
			}
		}
	}
	return `${confDir}/dnsmasq-singsing.conf`;
}

function isDnsmasqTakenOver() {
	if (stat(getDnsmasqDropinPath()) != null || stat('/tmp/dnsmasq.d/dnsmasq-singsing.conf') != null || stat(DNSMASQ_BACKUP) != null)
		return true;
	let tmpEntries = lsdir('/tmp') || [];
	for (let e in tmpEntries) {
		if (substr(e, 0, 8) == 'dnsmasq.' && substr(e, length(e) - 2, 2) == '.d') {
			if (stat(`/tmp/${e}/dnsmasq-singsing.conf`) != null)
				return true;
		}
	}
	return false;
}

function getOffloadWarning() {
	let c = cursor();
	let items = [];
	c.load('firewall');
	if (c.get('firewall', '@defaults[0]', 'flow_offloading_hw') == '1')
		push(items, 'firewall 硬件流量卸载');
	else if (c.get('firewall', '@defaults[0]', 'flow_offloading') == '1')
		push(items, 'firewall 软件流量卸载');

	c.load('turboacc');
	let fp = trim('' + (c.get('turboacc', 'config', 'fastpath') || ''));
	if (length(fp) > 0 && fp != 'none' && fp != '0')
		push(items, `TurboACC (${fp})`);

	if (length(items) == 0) return '';
	return `检测到系统已开启流量卸载：${join(' + ', items)}。启用 TUN 透明代理时可能导致部分连接绕过分流或流量统计不准，如遇异常建议在防火墙 / TurboACC 中关闭加速。`;
}

function getLanDev() {
	let u = runCmd(`ubus call network.interface.lan status 2>/dev/null`);
	if (u.code == 0 && length(u.output) > 0) {
		let d = safeJson(u.output);
		let dev = d?.l3_device || d?.device;
		if (type(dev) == 'string' && match(dev, /^[a-zA-Z0-9_.:-]+$/))
			return dev;
	}
	return 'br-lan';
}

function getLanIps() {
	let ips = [];
	let seen = {};
	let addIp = (ip) => {
		let v = trim('' + (ip || ''));
		if (length(v) > 0 && !seen[v]) {
			seen[v] = true;
			push(ips, v);
		}
	};

	let u = runCmd(`ubus call network.interface dump 2>/dev/null`);
	if (u.code == 0 && length(u.output) > 0) {
		let d = safeJson(u.output);
		for (let ifc in (d?.interface || [])) {
			if (ifc.interface == 'loopback') continue;
			for (let k in ['ipv4-address', 'ipv6-address']) {
				for (let a in (ifc[k] || [])) addIp(a?.address);
			}
			for (let pa in (ifc['ipv6-prefix-assignment'] || [])) {
				addIp(pa?.['local-address']?.address);
			}
		}
	}

	if (length(ips) == 0) {
		let dev = getLanDev();
		let res = runCmd(`ip -o addr show ${shellQuote(dev)} 2>/dev/null | awk '{print $4}' | cut -d/ -f1`);
		if (res.code == 0 && res.output) {
			for (let x in split(res.output, '\n')) addIp(x);
		}
	}
	return ips;
}

function getServicePid() {
	let u = runCmd(`ubus call service list '{"name":"singsing"}' 2>/dev/null`);
	if (u.code == 0 && length(u.output) > 0) {
		let parsed = safeJson(u.output);
		let inst = parsed?.['singsing']?.instances?.['singsing'];
		if (inst && inst.running && inst.pid)
			return int(inst.pid);
	}
	return 0;
}

function isPortListening(port) {
	let p = int(port);
	if (p < 1 || p > 65535) return false;
	let ss = runCmd(`ss -Hlntu 2>/dev/null | awk -v p=":${p}" '$5 ~ p "$" {print 1; exit}'`);
	if (ss.code == 0 && ss.output == '1') return true;
	let ns = runCmd(`netstat -lntu 2>/dev/null | awk -v p=":${p}" '$4 ~ p "$" {print 1; exit}'`);
	if (ns.code == 0 && ns.output == '1') return true;
	return false;
}

function parseSemverOk(verStr) {
	let m = match(verStr || '', /(\d+)\.(\d+)\.(\d+)/);
	if (!m) return false;
	let maj = int(m[1]), min = int(m[2]);
	return (maj > 1) || (maj == 1 && min >= 14);
}

function getClashApiConfig() {
	let raw = readfile(SB_CONFIG);
	if (!raw) return null;
	let cfg = safeJson(raw);
	let api = cfg?.experimental?.clash_api;
	if (!api || !api.external_controller) return null;

	let ctrl = trim('' + api.external_controller);
	let hm = match(ctrl, /^\[([^\]]+)\]:([0-9]+)$/) || match(ctrl, /^([^:]*):([0-9]+)$/);
	if (!hm) return null;
	let host = lc(trim(hm[1] || ''));
	let port = int(hm[2]);
	if (port < 1 || port > 65535) return null;

	// Strictly restrict to loopback / wildcard listeners on this router (prevent SSRF & secret leak)
	let connectHost = null;
	if (host == '' || host == '0.0.0.0' || host == '127.0.0.1' || host == 'localhost' || host == '::')
		connectHost = '127.0.0.1';
	else if (host == '::1')
		connectHost = '[::1]';
	else
		return null;

	return {
		controller: `${connectHost}:${port}`,
		secret: '' + (api.secret || '')
	};
}

const methods = {
	status: {
		call: function() {
			let c = getUci();
			let bin = getSingboxBin(c);
			let binStat = stat(bin);
			let version = '';
			if (binStat) {
				let v = runCmd(`${shellQuote(bin)} version 2>/dev/null | head -n 1`);
				if (v.code == 0) version = v.output;
			}

			let pid = getServicePid();
			let running = pid > 0;

			let uptime = 0;
			if (running) {
				let pStat = stat(`/proc/${pid}`);
				if (pStat && pStat.mtime)
					uptime = max(0, time() - pStat.mtime);
			}

			let tunName = c.get('singsing', 'tun', 'interface_name') || 'singtun';
			let tunUp = stat(`/sys/class/net/${tunName}`) != null;

			let configExists = stat(SB_CONFIG) != null;
			let dnsmasqTakenOver = isDnsmasqTakenOver();

			return {
				running: running,
				pid: pid,
				uptime: uptime,
				singbox_bin: bin,
				bin_exists: binStat != null,
				version: version,
				version_supported: parseSemverOk(version),
				config_exists: configExists,
				tun_interface: tunName,
				tun_up: tunUp,
				dnsmasq_taken_over: dnsmasqTakenOver,
				enabled: c.get('singsing', 'main', 'enabled') == '1',
				active_profile: c.get('singsing', 'main', 'active_profile') || 'default',
				local_dns: c.get('singsing', 'dns', 'local_server') || '',
				local_dns_type: c.get('singsing', 'dns', 'local_type') || 'udp',
				listen_port: int(c.get('singsing', 'dns', 'listen_port') || '5335'),
				lan_ips: getLanIps(),
				offload_warning: getOffloadWarning()
			};
		}
	},

	commit_uci: {
		call: function() {
			let c = getUci();
			let ok = c.commit('singsing');
			return { ok: !!ok };
		}
	},

	get_profile: {
		args: { name: 'string' },
		call: function(req) {
			let name = safeProfileName(req.args.name || 'default');
			if (!name) return { ok: false, error: 'Invalid profile name' };
			let path = `${PROFILES_DIR}/${name}.json`;
			let raw = readfile(path);
			if (!raw) return { ok: true, exists: false, profile: null };
			let parsed = safeJson(raw);
			if (type(parsed) != 'object') return { ok: false, error: 'Corrupted profile JSON' };
			return { ok: true, exists: true, profile: parsed };
		}
	},

	save_profile: {
		args: { name: 'string', profile: 'string' },
		call: function(req) {
			let name = safeProfileName(req.args.name || 'default');
			if (!name) return { ok: false, error: 'Invalid profile name' };
			if (type(req.args.profile) != 'string') return { ok: false, error: 'Profile payload must be JSON string' };
			let parsed = safeJson(req.args.profile);
			if (type(parsed) != 'object') return { ok: false, error: 'Invalid JSON payload' };

			runCmd(`${SERVICE_MGR} ensure_dirs`);
			let path = `${PROFILES_DIR}/${name}.json`;
			let ok = writeFileSafe(path, req.args.profile, 0600);
			if (!ok) return { ok: false, error: 'Failed to write profile file' };
			return { ok: true };
		}
	},

	list_profiles: {
		call: function() {
			let entries = lsdir(PROFILES_DIR) || [];
			let names = [];
			for (let f in entries) {
				let m = match(f, /^([a-zA-Z0-9_-]+)\.json$/);
				if (m) push(names, m[1]);
			}
			return { ok: true, profiles: names };
		}
	},

	delete_profile: {
		args: { name: 'string' },
		call: function(req) {
			let name = safeProfileName(req.args.name);
			if (!name || name == 'default') return { ok: false, error: 'Cannot delete default or invalid profile' };
			unlink(`${PROFILES_DIR}/${name}.json`);

			// Clean up subscriptions bound to this deleted profile
			let subsRaw = readfile(SUBS_FILE);
			let subs = subsRaw ? safeJson(subsRaw) : null;
			if (type(subs) == 'array') {
				let kept = filter(subs, (s) => (s?.profile || 'default') != name);
				if (length(kept) != length(subs))
					writeFileSafe(SUBS_FILE, sprintf('%.2J', kept), 0600);
			}
			return { ok: true };
		}
	},

	validate_config: {
		args: { config: 'string' },
		call: function(req) {
			if (type(req.args.config) != 'string') return { ok: false, error: 'Missing config JSON' };
			let cfg = safeJson(req.args.config);
			if (type(cfg) != 'object')
				return { ok: false, output: '无效的 JSON 配置内容' };

			let c = getUci();
			let bin = getSingboxBin(c);
			runCmd(`${SERVICE_MGR} ensure_dirs`);

			let seqId = `${time()}.${++tmpSeq}`;
			let tmpPath = `/tmp/singsing/validate.${seqId}.json`;
			let stubDir = `/tmp/singsing/validate-rs.${seqId}`;
			let missingTags = [];

			// Provide temporary stubs for local rule-sets not yet downloaded so pre-flight syntax check works offline
			if (type(cfg.route?.rule_set) == 'array') {
				let needBinaryStub = false;
				for (let rs in cfg.route.rule_set) {
					if (type(rs) == 'object' && rs.type == 'local' && type(rs.path) == 'string') {
						let st = stat(rs.path);
						if (!st || st.size == 0) {
							push(missingTags, '' + (rs.tag || rs.path));
							if (rs.format != 'source') needBinaryStub = true;
						}
					}
				}
				if (length(missingTags) > 0) {
					mkdir(stubDir, 0700);
					let stubJson = `${stubDir}/stub.json`;
					let stubSrs = `${stubDir}/stub.srs`;
					writefile(stubJson, '{"version":3,"rules":[{"domain_suffix":["example.invalid"]}]}');
					if (needBinaryStub && stat(bin)) {
						runCmd(`${shellQuote(bin)} rule-set compile ${shellQuote(stubJson)} -o ${shellQuote(stubSrs)}`);
					}
					for (let rs in cfg.route.rule_set) {
						if (type(rs) == 'object' && rs.type == 'local' && type(rs.path) == 'string') {
							let st = stat(rs.path);
							if (!st || st.size == 0) {
								rs.path = (rs.format == 'source') ? stubJson : stubSrs;
							}
						}
					}
				}
			}

			let toWrite = length(missingTags) > 0 ? sprintf('%.2J', cfg) : req.args.config;
			if (!writeFileSafe(tmpPath, toWrite, 0600)) {
				if (length(missingTags) > 0) runCmd(`rm -rf ${shellQuote(stubDir)}`);
				return { ok: false, error: 'Failed to write temporary config' };
			}

			let res = runCmd(`${SERVICE_MGR} validate_config ${shellQuote(tmpPath)}`);
			unlink(tmpPath);
			if (length(missingTags) > 0) runCmd(`rm -rf ${shellQuote(stubDir)}`);

			let note = '';
			if (res.code == 0 && length(missingTags) > 0) {
				note = `（提示：本地尚缺 ${length(missingTags)} 个规则集 [${join(', ', missingTags)}]，首次启动或应用时将自动下载）`;
			}
			return {
				ok: res.code == 0,
				missing_rulesets: missingTags,
				output: trim((res.output || '') + (note ? ('\n' + note) : ''))
			};
		}
	},

	apply_config: {
		args: { config: 'string', manifest: 'string' },
		call: function(req) {
			if (type(req.args.config) != 'string' || type(safeJson(req.args.config)) != 'object')
				return { ok: false, error: 'Missing or invalid config JSON' };
			let c = getUci();
			let manifest = null;
			if (type(req.args.manifest) == 'string' && length(trim(req.args.manifest)) > 0) {
				manifest = sanitizeManifest(req.args.manifest, c);
				if (manifest == null)
					return { ok: false, error: 'Invalid rule-sets manifest' };
			}

			let workDir = mkdtemp('/tmp/singsing-apply.XXXXXX');
			if (!workDir)
				return { ok: false, error: 'Failed to create candidate directory' };
			let configPath = `${workDir}/config.json`;
			let manifestPath = `${workDir}/manifest.json`;
			let response;
			try {
				if (!writeFileSafe(configPath, req.args.config, 0600))
					response = { ok: false, error: 'Failed to write candidate config' };
				else if (manifest != null && !writeFileSafe(manifestPath, sprintf('%.2J', manifest), 0600))
					response = { ok: false, error: 'Failed to write candidate rule-set manifest' };
				else {
					let res = runCmd(`${SERVICE_MGR} apply_config ${shellQuote(configPath)} ${shellQuote(manifest != null ? manifestPath : '')}`);
					response = { ok: res.code == 0, rolled_back: res.code == 2, output: res.output };
				}
			} catch (e) {
				response = { ok: false, error: 'Failed to apply candidate config' };
			}
			unlink(configPath);
			unlink(manifestPath);
			rmdir(workDir);
			return response;
		}
	},

	service_action: {
		args: { action: 'string' },
		call: function(req) {
			let act = req.args.action;
			if (act != 'start' && act != 'stop' && act != 'restart')
				return { ok: false, error: 'Unsupported action' };

			let c = getUci();
			if (act == 'start' || act == 'restart') {
				let localDns = trim(c.get('singsing', 'dns', 'local_server') || '');
				if (length(localDns) == 0 || runCmd(`${SERVICE_MGR} check_local_dns ${shellQuote(localDns)}`).code != 0)
					return { ok: false, error: '必须先填写有效的直连上游 DNS IP（不可为空、域名、回环地址或路由器自身 IP）' };
				if (c.get('singsing', 'main', 'enabled') != '1') {
					c.set('singsing', 'main', 'enabled', '1');
					c.commit('singsing');
				}
			} else if (act == 'stop') {
				if (c.get('singsing', 'main', 'enabled') != '0') {
					c.set('singsing', 'main', 'enabled', '0');
					c.commit('singsing');
				}
			}

			let res = runCmd(`${INIT_SCRIPT} ${act}`);
			return { ok: res.code == 0, output: res.output };
		}
	},

	dns_check: {
		call: function() {
			let c = getUci();
			let port = int(c.get('singsing', 'dns', 'listen_port') || '5335');
			let localDns = c.get('singsing', 'dns', 'local_server') || '';
			let lanIps = getLanIps();
			let portBusy = isPortListening(port);

			return {
				local_dns: localDns,
				listen_port: port,
				port_in_use: portBusy,
				lan_ips: lanIps,
				dnsmasq_taken_over: isDnsmasqTakenOver(),
				offload_warning: getOffloadWarning()
			};
		}
	},

	ruleset_status: {
		args: { manifest: '' },
		call: function(req) {
			let c = getUci();
			let arr = null;
			if (type(req.args.manifest) == 'string' && length(trim(req.args.manifest)) > 0) {
				arr = sanitizeManifest(req.args.manifest, c);
			}
			if (type(arr) != 'array') {
				let raw = readfile(MANIFEST_FILE);
				arr = raw ? sanitizeManifest(raw, c) : [];
			}
			if (type(arr) != 'array') arr = [];

			let items = [];
			for (let r in arr) {
				let st = r.path ? stat(r.path) : null;
				push(items, {
					tag: r.tag,
					url: r.url,
					format: r.format || 'binary',
					path: r.path,
					exists: st != null && st.size > 0,
					size: st ? st.size : 0,
					mtime: st ? st.mtime : 0
				});
			}
			return { ok: true, items: items };
		}
	},

	get_ruleset_urls: {
		call: function() {
			let raw = readfile(RULESET_URLS_FILE);
			let parsed = raw ? safeJson(raw) : null;
			return { ok: true, urls: (type(parsed) == 'object') ? parsed : {} };
		}
	},

	save_ruleset_urls: {
		args: { urls: '', manifest: '' },
		call: function(req) {
			let c = getUci();
			let parsed = safeJson(req.args.urls || '{}');
			if (type(parsed) != 'object')
				return { ok: false, error: 'Invalid URLs map' };
			for (let k, v in parsed) {
				if (!safeRulesetTag(k) || type(v) != 'string' || !match(trim(v), /^https?:\/\/[^[:space:]]+$/))
					return { ok: false, error: 'Invalid rule-set tag or URL' };
			}
			runCmd(`${SERVICE_MGR} ensure_dirs`);
			if (!writeFileSafe(RULESET_URLS_FILE, sprintf('%.2J', parsed), 0600))
				return { ok: false, error: 'Failed to save rule-set URLs' };
			if (type(req.args.manifest) == 'string' && length(trim(req.args.manifest)) > 0) {
				let cleanManifest = sanitizeManifest(req.args.manifest, c);
				if (!cleanManifest)
					return { ok: false, error: 'Invalid rule-sets manifest' };
				writeFileSafe(MANIFEST_FILE, sprintf('%.2J', cleanManifest), 0600);
			}
			return { ok: true };
		}
	},

	ruleset_update: {
		args: { tag: '', manifest: '' },
		call: function(req) {
			let c = getUci();
			let tag = trim(req.args.tag || '');
			if (length(tag) > 0 && !safeRulesetTag(tag))
				return { ok: false, error: 'Invalid rule-set tag' };
			runCmd(`${SERVICE_MGR} ensure_dirs`);
			if (type(req.args.manifest) == 'string' && length(trim(req.args.manifest)) > 0) {
				let cleanManifest = sanitizeManifest(req.args.manifest, c);
				if (!cleanManifest)
					return { ok: false, error: 'Invalid rule-sets manifest' };
				writeFileSafe(MANIFEST_FILE, sprintf('%.2J', cleanManifest), 0600);
			}
			let res = runCmd(`${SERVICE_MGR} update_rulesets ${shellQuote(tag)}`);
			let parsed = safeJsonLastLine(res.output);
			if (type(parsed) == 'object') return parsed;
			return { ok: res.code == 0, output: res.output };
		}
	},

	get_logs: {
		args: { lines: 200 },
		call: function(req) {
			let n = int(req.args.lines || 200);
			if (n < 10) n = 10;
			if (n > 2000) n = 2000;
			let res = runCmd(`logread 2>/dev/null | grep -E ' (sing-box|singsing)(\\[|:)' | tail -n ${n}`);
			return { ok: true, logs: res.output };
		}
	},

	clash_api: {
		args: { method: '', path: '', body: '' },
		call: function(req) {
			let api = getClashApiConfig();
			if (!api) return { ok: false, error: 'Clash API 未启用、配置不存在或非本机监听地址' };

			let m = uc(trim(req.args.method || 'GET'));
			if (m != 'GET' && m != 'PUT' && m != 'PATCH' && m != 'DELETE')
				return { ok: false, error: '不支持的 HTTP 方法' };

			let p = trim(req.args.path || '');
			if (index(p, '..') >= 0 || index(p, '#') >= 0 || index(p, '\\') >= 0)
				return { ok: false, error: '非法的 Clash API 路径' };
			if (!match(p, /^\/(configs|proxies|group|connections|version)(\/[^[:space:]?#]*)?(\?[^[:space:]#]*)?$/))
				return { ok: false, error: '不支持的 Clash API 路径' };
			if (m == 'PUT' && match(p, /^\/configs(\/|\?|$)/))
				return { ok: false, error: '禁止通过代理重载外部配置文件' };
			if (m == 'PATCH' && match(p, /^\/configs(\/|\?|$)/)) {
				let patchObj = safeJson(req.args.body || '{}');
				if (type(patchObj) != 'object' || type(patchObj.mode) != 'string')
					return { ok: false, error: 'PATCH /configs 仅允许切换 mode' };
				req.args.body = sprintf('%J', { mode: patchObj.mode });
			}

			let url = `http://${api.controller}${p}`;
			let cmd = `curl -sS --path-as-is --connect-timeout 3 --max-time 8 -w "\\n%{http_code}" -X ${m}`;
			if (length(api.secret) > 0)
				cmd += ` -H ${shellQuote('Authorization: Bearer ' + api.secret)}`;
			if (type(req.args.body) == 'string' && length(req.args.body) > 0)
				cmd += ` -H 'Content-Type: application/json' -d ${shellQuote(req.args.body)}`;
			cmd += ` ${shellQuote(url)}`;

			let res = runCmd(cmd);
			if (res.code != 0)
				return { ok: false, error: res.output || '无法连接到本机 Clash API' };

			let idx = rindex(res.output, '\n');
			let bodyStr = '';
			let statusCode = 0;
			if (idx >= 0) {
				bodyStr = substr(res.output, 0, idx);
				statusCode = int(substr(res.output, idx + 1));
			} else if (match(res.output, /^[0-9]{3}$/)) {
				statusCode = int(res.output);
			}
			let data = length(trim(bodyStr)) > 0 ? safeJson(bodyStr) : null;

			return {
				ok: statusCode >= 200 && statusCode < 300,
				status: statusCode,
				data: data,
				raw: data == null ? bodyStr : ''
			};
		}
	},

	get_subscriptions: {
		call: function() {
			let raw = readfile(SUBS_FILE);
			let parsed = raw ? safeJson(raw) : [];
			return { ok: true, subscriptions: (type(parsed) == 'array') ? parsed : [] };
		}
	},

	save_subscriptions: {
		args: { subscriptions: '' },
		call: function(req) {
			let parsed = safeJson(req.args.subscriptions || '[]');
			if (type(parsed) != 'array')
				return { ok: false, error: 'Invalid subscriptions array' };
			runCmd(`${SERVICE_MGR} ensure_dirs`);
			if (!writeFileSafe(SUBS_FILE, req.args.subscriptions || '[]', 0600))
				return { ok: false, error: 'Failed to save subscriptions.json' };
			runCmd(`${SERVICE_MGR} cron_sync`);
			return { ok: true };
		}
	},

	fetch_subscription: {
		args: { url: '', user_agent: '' },
		call: function(req) {
			let u = trim(req.args.url || '');
			if (!match(u, /^https?:\/\/[^[:space:]]+$/))
				return { ok: false, error: '订阅地址必须以 http:// 或 https:// 开头' };
			let ua = trim(req.args.user_agent || '') || 'sing-box/1.14';
			let cmd = '';
			if (runCmd('command -v curl').code == 0) {
				cmd = `curl -fsSL --proto '=http,https' --proto-redir '=http,https' --max-filesize 8388608 --connect-timeout 8 --max-time 20 -A ${shellQuote(ua)} ${shellQuote(u)}`;
			} else {
				cmd = `uclient-fetch -q -T 15 -U ${shellQuote(ua)} -O - ${shellQuote(u)}`;
			}
			let res = runCmd(cmd);
			if (res.code != 0 || length(trim(res.output)) == 0)
				return { ok: false, error: '下载订阅失败：' + (res.output || '空响应') };
			return { ok: true, content: res.output };
		}
	},

	sync_cron: {
		call: function() {
			let res = runCmd(`${SERVICE_MGR} cron_sync`);
			return { ok: res.code == 0, output: res.output };
		}
	},

	run_subscription_updater: {
		args: { id: '' },
		call: function(req) {
			let id = trim(req.args.id || '');
			if (length(id) > 0 && !match(id, /^[a-zA-Z0-9_-]{1,64}$/))
				return { ok: false, error: 'Invalid subscription id' };
			let res = runCmd(`${SUB_UPDATER} ${shellQuote(id)}`);
			let parsed = safeJsonLastLine(res.output);
			if (type(parsed) == 'object') return parsed;
			return { ok: res.code == 0, error: res.output || '订阅更新器执行失败', output: res.output };
		}
	},

	ruleset_upload: {
		args: { tag: '', format: '', content_b64: '', chunk_index: 0, total_chunks: 1 },
		call: function(req) {
			let tag = safeRulesetTag(trim(req.args.tag || ''));
			if (!tag)
				return { ok: false, error: '无效的规则集标签' };
			if (type(req.args.content_b64) != 'string' || length(req.args.content_b64) == 0)
				return { ok: false, error: '文件内容为空' };

			let chunkIdx = int(req.args.chunk_index ?? 0);
			let totalChunks = int(req.args.total_chunks ?? 1);
			if (chunkIdx < 0 || totalChunks < 1 || chunkIdx >= totalChunks || totalChunks > 64)
				return { ok: false, error: '无效的分片参数' };

			let rawBytes = null;
			try {
				rawBytes = b64dec(req.args.content_b64);
			} catch (e) {
				return { ok: false, error: 'Base64 解码失败' };
			}
			if (rawBytes == null || length(rawBytes) == 0)
				return { ok: false, error: '解码后文件内容为空' };

			let c = getUci();
			let dir = getRulesetDir(c);
			runCmd(`${SERVICE_MGR} ensure_dirs`);
			let fmt = (req.args.format == 'source') ? 'source' : 'binary';
			let ext = (fmt == 'source') ? 'json' : 'srs';
			let dest = `${dir}/${tag}.${ext}`;
			let partPath = `/tmp/singsing/upload.${tag}.${ext}.part`;

			let combined = rawBytes;
			if (chunkIdx > 0) {
				let prev = readfile(partPath);
				if (prev == null)
					return { ok: false, error: '上传分片丢失，请重试' };
				combined = prev + rawBytes;
			}
			if (length(combined) > MAX_UPLOAD_BYTES) {
				unlink(partPath);
				return { ok: false, error: '文件过大（超过 4MB 上限）' };
			}

			if (chunkIdx + 1 < totalChunks) {
				if (!writeFileSafe(partPath, combined, 0600)) {
					unlink(partPath);
					return { ok: false, error: '写入临时分片失败' };
				}
				return { ok: true, partial: true, received: length(combined) };
			}

			unlink(partPath);
			if (fmt == 'source' && type(safeJson(combined)) != 'object')
				return { ok: false, error: 'JSON 规则集格式无效' };

			if (!writeFileSafe(dest, combined, 0644))
				return { ok: false, error: '写入规则集文件失败：' + dest };

			let reloaded = false;
			if (getServicePid() > 0) {
				runCmd(`${SERVICE_MGR} reload_if_running`);
				reloaded = true;
			}

			return { ok: true, path: dest, size: length(combined), reloaded: reloaded };
		}
	},

	connectivity_check: {
		call: function() {
			let targets = [
				{ id: 'baidu', label: '百度（国内直连）', url: 'https://www.baidu.com' },
				{ id: 'cn204', label: '国内 204（直连延迟）', url: 'https://connect.rom.miui.com/generate_204' },
				{ id: 'google', label: 'Google（海外代理）', url: 'https://www.google.com/generate_204' },
				{ id: 'github', label: 'GitHub（海外代理）', url: 'https://github.com' }
			];
			runCmd(`${SERVICE_MGR} ensure_dirs`);
			let prefix = `/tmp/singsing/conn.${time()}.${++tmpSeq}`;
			let subCmds = [];
			for (let i = 0; i < length(targets); i++) {
				let t = targets[i];
				push(subCmds, `(curl -sS -o /dev/null --connect-timeout 2 --max-time 3 -w "%{http_code} %{time_total}" ${shellQuote(t.url)} > "${prefix}.${i}" 2>/dev/null || echo "0 0" > "${prefix}.${i}") &`);
			}
			push(subCmds, 'wait');
			runCmd(join(' ', subCmds));

			let results = [];
			for (let i = 0; i < length(targets); i++) {
				let t = targets[i];
				let out = trim(readfile(`${prefix}.${i}`) || '');
				unlink(`${prefix}.${i}`);
				let parts = split(out, /\s+/);
				let code = int(parts[0] || 0);
				let sec = +(parts[1] || 0);
				let ms = sec > 0 ? int(sec * 1000) : 0;
				let ok = (code >= 200 && code < 400);
				push(results, {
					id: t.id,
					label: t.label,
					url: t.url,
					ok: ok,
					http_code: code,
					ms: ms
				});
			}
			return { ok: true, results: results };
		}
	},

	get_access_control: {
		call: function() {
			let raw = readfile(ACCESS_FILE);
			let parsed = raw ? safeJson(raw) : null;
			if (type(parsed) != 'object') {
				parsed = { mode: 'all', clients: [], deviceRules: [] };
			}
			return { ok: true, access_control: parsed };
		}
	},

	save_access_control: {
		args: { data: '' },
		call: function(req) {
			let parsed = safeJson(req.args.data || '{}');
			if (type(parsed) != 'object')
				return { ok: false, error: 'Invalid access control JSON' };
			runCmd(`${SERVICE_MGR} ensure_dirs`);
			if (!writeFileSafe(ACCESS_FILE, req.args.data || '{}', 0600))
				return { ok: false, error: 'Failed to write access-control.json' };
			return { ok: true };
		}
	},

	get_lan_clients: {
		call: function() {
			let list = [];
			let seen = {};
			let leases = readfile('/tmp/dhcp.leases');
			if (leases) {
				for (let line in split(leases, '\n')) {
					let parts = split(trim(line), /\s+/);
					if (length(parts) >= 4) {
						let mac = lc(parts[1]);
						let ip = parts[2];
						let host = (parts[3] == '*' ? '' : parts[3]);
						if (!seen[ip]) {
							seen[ip] = true;
							push(list, { ip: ip, mac: mac, hostname: host });
						}
					}
				}
			}
			let lanDev = getLanDev();
			let neigh = runCmd(`ip neigh show dev ${shellQuote(lanDev)} 2>/dev/null`);
			if (neigh.code == 0 && length(neigh.output) > 0) {
				for (let line in split(neigh.output, '\n')) {
					let m = match(trim(line), /^(\S+)\s+lladdr\s+([0-9a-fA-F:]{17})/);
					if (m && !seen[m[1]]) {
						seen[m[1]] = true;
						push(list, { ip: m[1], mac: lc(m[2]), hostname: '' });
					}
				}
			} else {
				let arp = readfile('/proc/net/arp');
				if (arp) {
					let idx = 0;
					for (let line in split(arp, '\n')) {
						if (idx++ == 0) continue;
						let parts = split(trim(line), /\s+/);
						if (length(parts) >= 6 && parts[3] != '00:00:00:00:00:00' && !seen[parts[0]]) {
							seen[parts[0]] = true;
							push(list, { ip: parts[0], mac: lc(parts[3]), hostname: '' });
						}
					}
				}
			}
			return { ok: true, clients: list };
		}
	}
};

return { 'luci.singsing': methods };
