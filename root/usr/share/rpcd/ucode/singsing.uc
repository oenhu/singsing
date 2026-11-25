'use strict';

import { readfile, writefile, stat, unlink, popen, lsdir } from 'fs';
import { cursor } from 'uci';

const CONF_DIR = '/etc/singsing';
const PROFILES_DIR = `${CONF_DIR}/profiles`;
const MANIFEST_FILE = `${CONF_DIR}/rulesets-manifest.json`;
const RULESET_URLS_FILE = `${CONF_DIR}/ruleset-urls.json`;
const SUBS_FILE = `${CONF_DIR}/subscriptions.json`;
const ACCESS_FILE = `${CONF_DIR}/access-control.json`;
const DNSMASQ_BACKUP = `${CONF_DIR}/dnsmasq-backup.json`;
const SB_CONFIG = '/etc/sing-box/config.json';
const TMP_NEW_CONFIG = '/tmp/singsing/config.new.json';
const SERVICE_MGR = '/usr/share/singsing/service-manager.sh';
const SUB_UPDATER = '/usr/share/singsing/subscription-updater.uc';
const INIT_SCRIPT = '/etc/init.d/singsing';

function runCmd(cmd) {
	let p = popen(cmd + ' 2>&1', 'r');
	if (!p) return { code: 127, output: 'Failed to execute command' };
	let out = p.read('all') || '';
	let rc = p.close();
	return { code: rc, output: trim(out) };
}

function safeProfileName(name) {
	if (type(name) != 'string' || !match(name, /^[a-zA-Z0-9_-]{1,64}$/))
		return null;
	return name;
}

function getUci() {
	let c = cursor();
	c.load('singsing');
	return c;
}

function getSingboxBin(c) {
	return c.get('singsing', 'main', 'singbox_bin') || '/usr/bin/sing-box';
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
					if (length(d) > 0) confDir = d;
					break;
				}
			}
		}
	}
	return `${confDir}/dnsmasq-singsing.conf`;
}

function isDnsmasqTakenOver() {
	return stat(getDnsmasqDropinPath()) != null || stat(DNSMASQ_BACKUP) != null;
}

function getLanIps() {
	let res = runCmd("ip -o addr show br-lan 2>/dev/null | awk '{print $4}' | cut -d/ -f1");
	if (res.code != 0 || !res.output) return [];
	return filter(split(res.output, '\n'), (x) => length(trim(x)) > 0);
}

function getServicePid() {
	// Native procd query via ubus (works on both OpenWrt 24.10 and 25.12 without pgrep)
	let u = runCmd(`ubus call service list '{"name":"singsing"}' 2>/dev/null`);
	if (u.code == 0 && length(u.output) > 0) {
		let parsed = json(u.output);
		let inst = parsed?.['singsing']?.instances?.['singsing'];
		if (inst && inst.running && inst.pid)
			return int(inst.pid);
	}
	return 0;
}

function isPortListening(port) {
	let ss = runCmd(`ss -lntu 2>/dev/null | grep -E ":${port}[[:space:]]"`);
	if (ss.code == 0 && length(ss.output) > 0) return true;
	let ns = runCmd(`netstat -lntu 2>/dev/null | grep -E ":${port}[[:space:]]"`);
	if (ns.code == 0 && length(ns.output) > 0) return true;
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
	let cfg = json(raw);
	let api = cfg?.experimental?.clash_api;
	if (!api || !api.external_controller) return null;
	return {
		controller: trim(api.external_controller),
		secret: api.secret || ''
	};
}

function shellQuote(s) {
	return "'" + replace('' + (s ?? ''), "'", "'\\''") + "'";
}

const methods = {
	status: {
		call: function() {
			let c = getUci();
			let bin = getSingboxBin(c);
			let binStat = stat(bin);
			let version = '';
			if (binStat) {
				let v = runCmd(`"${bin}" version 2>/dev/null | head -n 1`);
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
				lan_ips: getLanIps()
			};
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
			let parsed = json(raw);
			if (!parsed) return { ok: false, error: 'Corrupted profile JSON' };
			return { ok: true, exists: true, profile: parsed };
		}
	},

	save_profile: {
		args: { name: 'string', profile: 'string' },
		call: function(req) {
			let name = safeProfileName(req.args.name || 'default');
			if (!name) return { ok: false, error: 'Invalid profile name' };
			if (type(req.args.profile) != 'string') return { ok: false, error: 'Profile payload must be JSON string' };
			let parsed = json(req.args.profile);
			if (!parsed) return { ok: false, error: 'Invalid JSON payload' };

			runCmd(`${SERVICE_MGR} ensure_dirs`);
			let path = `${PROFILES_DIR}/${name}.json`;
			let ok = writefile(path, req.args.profile, 0600);
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
			return { ok: true };
		}
	},

	validate_config: {
		args: { config: 'string' },
		call: function(req) {
			if (type(req.args.config) != 'string') return { ok: false, error: 'Missing config JSON' };
			runCmd(`${SERVICE_MGR} ensure_dirs`);
			let tmpPath = '/tmp/singsing/validate.tmp.json';
			if (!writefile(tmpPath, req.args.config, 0600))
				return { ok: false, error: 'Failed to write temporary config' };
			let res = runCmd(`${SERVICE_MGR} validate_config "${tmpPath}"`);
			unlink(tmpPath);
			return { ok: res.code == 0, output: res.output };
		}
	},

	apply_config: {
		args: { config: 'string', manifest: 'string' },
		call: function(req) {
			if (type(req.args.config) != 'string') return { ok: false, error: 'Missing config JSON' };
			runCmd(`${SERVICE_MGR} ensure_dirs`);

			if (type(req.args.manifest) == 'string' && length(req.args.manifest) > 0) {
				if (!writefile(MANIFEST_FILE, req.args.manifest, 0644))
					return { ok: false, error: 'Failed to write rule-sets manifest' };
			}

			if (!writefile(TMP_NEW_CONFIG, req.args.config, 0600))
				return { ok: false, error: 'Failed to write candidate config' };

			let res = runCmd(`${SERVICE_MGR} apply_config`);
			return {
				ok: res.code == 0,
				rolled_back: res.code == 2,
				output: res.output
			};
		}
	},

	service_action: {
		args: { action: 'string' },
		call: function(req) {
			let act = req.args.action;
			if (act != 'start' && act != 'stop' && act != 'restart')
				return { ok: false, error: 'Unsupported action' };

			if (act == 'start' || act == 'restart') {
				let c = getUci();
				let localDns = c.get('singsing', 'dns', 'local_server') || '';
				if (length(trim(localDns)) == 0)
					return { ok: false, error: '必须先填写直连上游 DNS 地址后才能启动服务' };
				c.set('singsing', 'main', 'enabled', '1');
				c.commit('singsing');
			} else if (act == 'stop') {
				let c = getUci();
				c.set('singsing', 'main', 'enabled', '0');
				c.commit('singsing');
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
				dnsmasq_taken_over: isDnsmasqTakenOver()
			};
		}
	},

	ruleset_status: {
		args: { manifest: '' },
		call: function(req) {
			let arr = null;
			if (type(req.args.manifest) == 'string' && length(trim(req.args.manifest)) > 0) {
				arr = json(req.args.manifest);
			}
			if (type(arr) != 'array') {
				let raw = readfile(MANIFEST_FILE);
				arr = raw ? json(raw) : [];
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
			let parsed = raw ? json(raw) : null;
			return { ok: true, urls: (type(parsed) == 'object') ? parsed : {} };
		}
	},

	save_ruleset_urls: {
		args: { urls: '', manifest: '' },
		call: function(req) {
			let parsed = json(req.args.urls || '{}');
			if (type(parsed) != 'object')
				return { ok: false, error: 'Invalid URLs map' };
			runCmd(`${SERVICE_MGR} ensure_dirs`);
			if (!writefile(RULESET_URLS_FILE, req.args.urls || '{}', 0644))
				return { ok: false, error: 'Failed to save rule-set URLs' };
			if (type(req.args.manifest) == 'string' && length(trim(req.args.manifest)) > 0) {
				writefile(MANIFEST_FILE, req.args.manifest, 0644);
			}
			return { ok: true };
		}
	},

	ruleset_update: {
		args: { tag: '', manifest: '' },
		call: function(req) {
			let tag = req.args.tag || '';
			if (length(tag) > 0 && !match(tag, /^[a-zA-Z0-9_!@.-]+$/))
				return { ok: false, error: 'Invalid rule-set tag' };
			runCmd(`${SERVICE_MGR} ensure_dirs`);
			if (type(req.args.manifest) == 'string' && length(trim(req.args.manifest)) > 0) {
				writefile(MANIFEST_FILE, req.args.manifest, 0644);
			}
			let res = runCmd(`${SERVICE_MGR} update_rulesets "${tag}"`);
			let parsed = json(res.output);
			if (parsed) return parsed;
			return { ok: res.code == 0, output: res.output };
		}
	},

	get_logs: {
		args: { lines: 200 },
		call: function(req) {
			let n = int(req.args.lines || 200);
			if (n < 10) n = 10;
			if (n > 2000) n = 2000;
			let res = runCmd(`logread -e "sing-box|singsing" 2>/dev/null | tail -n ${n}`);
			return { ok: true, logs: res.output };
		}
	},

	clash_api: {
		args: { method: '', path: '', body: '' },
		call: function(req) {
			let api = getClashApiConfig();
			if (!api) return { ok: false, error: 'Clash API 未启用或配置不存在' };

			let m = uc(trim(req.args.method || 'GET'));
			if (m != 'GET' && m != 'PUT' && m != 'PATCH' && m != 'DELETE')
				return { ok: false, error: '不支持的 HTTP 方法' };

			let p = trim(req.args.path || '');
			if (!match(p, /^\/(configs|proxies|connections|version)(\/[^[:space:]]*)?(\?[^[:space:]]*)?$/))
				return { ok: false, error: '不支持的 Clash API 路径' };

			let url = `http://${api.controller}${p}`;
			let cmd = `curl -sS --connect-timeout 3 --max-time 8 -w "\\n%{http_code}" -X ${m}`;
			if (length(api.secret) > 0)
				cmd += ` -H ${shellQuote('Authorization: Bearer ' + api.secret)}`;
			if (type(req.args.body) == 'string' && length(req.args.body) > 0)
				cmd += ` -H 'Content-Type: application/json' -d ${shellQuote(req.args.body)}`;
			cmd += ` ${shellQuote(url)}`;

			let res = runCmd(cmd);
			if (res.code != 0)
				return { ok: false, error: res.output || '无法连接到本机 Clash API' };

			let idx = rindex(res.output, '\n');
			let bodyStr = idx >= 0 ? substr(res.output, 0, idx) : '';
			let statusCode = idx >= 0 ? int(substr(res.output, idx + 1)) : 0;
			let data = length(trim(bodyStr)) > 0 ? json(bodyStr) : null;

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
			let parsed = raw ? json(raw) : [];
			return { ok: true, subscriptions: (type(parsed) == 'array') ? parsed : [] };
		}
	},

	save_subscriptions: {
		args: { subscriptions: '' },
		call: function(req) {
			let parsed = json(req.args.subscriptions || '[]');
			if (type(parsed) != 'array')
				return { ok: false, error: 'Invalid subscriptions array' };
			runCmd(`${SERVICE_MGR} ensure_dirs`);
			if (!writefile(SUBS_FILE, req.args.subscriptions || '[]', 0600))
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
				cmd = `curl -fsSL --connect-timeout 15 --max-time 60 -A ${shellQuote(ua)} ${shellQuote(u)}`;
			} else {
				cmd = `uclient-fetch -q -T 30 -U ${shellQuote(ua)} -O - ${shellQuote(u)}`;
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
			let parsed = json(res.output);
			if (parsed) return parsed;
			return { ok: res.code == 0, output: res.output };
		}
	},

	ruleset_upload: {
		args: { tag: '', format: '', content_b64: '' },
		call: function(req) {
			let tag = trim(req.args.tag || '');
			if (!match(tag, /^[a-zA-Z0-9_!@.-]{1,128}$/))
				return { ok: false, error: '无效的规则集标签' };
			if (type(req.args.content_b64) != 'string' || length(req.args.content_b64) == 0)
				return { ok: false, error: '文件内容为空' };

			let rawBytes = null;
			try {
				rawBytes = b64dec(req.args.content_b64);
			} catch (e) {
				return { ok: false, error: 'Base64 解码失败' };
			}
			if (!rawBytes || length(rawBytes) == 0)
				return { ok: false, error: '解码后文件内容为空' };

			let fmt = (req.args.format == 'source') ? 'source' : 'binary';
			if (fmt == 'source' && json(rawBytes) == null)
				return { ok: false, error: 'JSON 规则集格式无效' };

			let c = getUci();
			let dir = replace(c.get('singsing', 'main', 'ruleset_dir') || '/etc/sing-box/rule-sets', /\/+$/, '');
			runCmd(`${SERVICE_MGR} ensure_dirs`);
			let ext = (fmt == 'source') ? 'json' : 'srs';
			let dest = `${dir}/${tag}.${ext}`;
			if (!writefile(dest, rawBytes, 0644))
				return { ok: false, error: '写入规则集文件失败：' + dest };

			return { ok: true, path: dest, size: length(rawBytes) };
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
			let results = [];
			for (let t in targets) {
				let res = runCmd(`curl -sS -o /dev/null --connect-timeout 2 --max-time 3 -w "%{http_code} %{time_total}" ${shellQuote(t.url)}`);
				let code = 0, ms = 0, ok = false;
				if (res.code == 0) {
					let parts = split(trim(res.output), /\s+/);
					code = int(parts[0] || 0);
					let sec = +(parts[1] || 0);
					ms = sec > 0 ? int(sec * 1000) : 0;
					ok = (code >= 200 && code < 400);
				}
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
			let parsed = raw ? json(raw) : null;
			if (type(parsed) != 'object') {
				parsed = { mode: 'all', clients: [], deviceRules: [] };
			}
			return { ok: true, access_control: parsed };
		}
	},

	save_access_control: {
		args: { data: '' },
		call: function(req) {
			let parsed = json(req.args.data || '{}');
			if (type(parsed) != 'object')
				return { ok: false, error: 'Invalid access control JSON' };
			runCmd(`${SERVICE_MGR} ensure_dirs`);
			if (!writefile(ACCESS_FILE, req.args.data || '{}', 0644))
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
			let neigh = runCmd("ip neigh show dev br-lan 2>/dev/null");
			if (neigh.code == 0 && length(neigh.output) > 0) {
				for (let line in split(neigh.output, '\n')) {
					let m = match(trim(line), /^(\S+)\s+lladdr\s+([0-9a-fA-F:]{17})/);
					if (m && !seen[m[1]]) {
						seen[m[1]] = true;
						push(list, { ip: m[1], mac: lc(m[2]), hostname: '' });
					}
				}
			}
			return { ok: true, clients: list };
		}
	}
};

return { 'luci.singsing': methods };
