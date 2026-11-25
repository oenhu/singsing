#!/usr/bin/env ucode
'use strict';

// Zero-dependency OpenWrt background subscription updater for luci-app-singsing.
// Runs directly on OpenWrt 24.10 & 25.12 built-in ucode (no QuickJS / Node.js / Python / Lua).

import { readfile, writefile, stat, popen } from 'fs';
import { cursor } from 'uci';

const CONF_DIR = '/etc/singsing';
const PROFILES_DIR = `${CONF_DIR}/profiles`;
const SUBS_FILE = `${CONF_DIR}/subscriptions.json`;
const SB_CONFIG = '/etc/sing-box/config.json';
const TMP_NEW_CONFIG = '/tmp/singsing/config.new.json';
const SERVICE_MGR = '/usr/share/singsing/service-manager.sh';

function toStr(v) {
	return (v == null) ? '' : ('' + v);
}

function shellQuote(s) {
	return "'" + replace(toStr(s), "'", "'\\''") + "'";
}

function runCmd(cmd) {
	let p = popen(cmd + ' 2>&1', 'r');
	if (!p) return { code: 127, output: 'popen failed' };
	let out = p.read('all') || '';
	let rc = p.close();
	return { code: rc, output: out };
}

function uid() {
	let r = runCmd("head -c 6 /dev/urandom | hexdump -ve '1/1 \"%02x\"'");
	if (r.code == 0 && length(trim(r.output)) >= 8)
		return substr(trim(r.output), 0, 8);
	return sprintf('%08x', time() ^ (length(r.output) * 31));
}

function urlDecode(s) {
	if (!s) return '';
	return replace(toStr(s), /%([0-9A-Fa-f]{2})/g, (m, h) => chr(hex(h)));
}

function safeB64Dec(s) {
	if (!s) return null;
	let clean = replace(replace(replace(toStr(s), /\s+/g, ''), /-/g, '+'), /_/g, '/');
	let rem = length(clean) % 4;
	if (rem == 1) return null;
	if (rem == 2) clean += '==';
	else if (rem == 3) clean += '=';
	try {
		return b64dec(clean);
	} catch (e) {
		return null;
	}
}

function parseQuery(qs) {
	let out = {};
	if (!qs) return out;
	for (let pair in split(qs, '&')) {
		if (!pair) continue;
		let i = index(pair, '=');
		let k = lc(replace(urlDecode(i < 0 ? pair : substr(pair, 0, i)), /_/g, '-'));
		let v = i < 0 ? '' : urlDecode(substr(pair, i + 1));
		if (!(k in out)) out[k] = v;
	}
	return out;
}

function parseShareLink(line) {
	let m = match(line, /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^#]*)(?:#(.*))?$/);
	if (!m) return null;
	let scheme = lc(m[1]);
	let rest = m[2];
	let frag = trim(urlDecode(m[3] || ''));

	// VMess base64 JSON format
	if (scheme == 'vmess') {
		let dec = safeB64Dec(rest);
		let v = dec ? json(dec) : null;
		if (type(v) == 'object' && v.add && v.id) {
			let obj = {
				type: 'vmess',
				server: toStr(v.add),
				server_port: int(v.port || 443),
				uuid: toStr(v.id),
				security: v.scy || 'auto',
				alter_id: int(v.aid || 0)
			};
			if (v.tls == 'tls' || v.tls == true) {
				obj.tls = { enabled: true };
				if (v.sni || v.host) obj.tls.server_name = toStr(v.sni || v.host);
			}
			if (v.net == 'ws') {
				obj.transport = { type: 'ws', path: v.path || '/' };
				if (v.host) obj.transport.headers = { Host: toStr(v.host) };
			} else if (v.net == 'grpc') {
				obj.transport = { type: 'grpc', service_name: v.path || '' };
			}
			return { tag: trim(toStr(v.ps || frag || v.add)), object: obj };
		}
		return null;
	}

	let qi = index(rest, '?');
	let body = replace(qi < 0 ? rest : substr(rest, 0, qi), /\/+$/, '');
	let q = qi < 0 ? {} : parseQuery(substr(rest, qi + 1));

	// Shadowsocks SIP002 / legacy base64
	if (scheme == 'ss') {
		let at = rindex(body, '@');
		let user = '', hp = '';
		if (at < 0) {
			let dec = safeB64Dec(body);
			if (!dec) return null;
			at = rindex(dec, '@');
			if (at < 0) return null;
			user = substr(dec, 0, at);
			hp = substr(dec, at + 1);
		} else {
			user = substr(body, 0, at);
			hp = substr(body, at + 1);
			if (index(user, ':') < 0) {
				let decU = safeB64Dec(user);
				if (decU) user = decU;
			}
		}
		let ci = index(user, ':');
		if (ci < 0) return null;
		let hm = match(hp, /^\[([^\]]+)\]:(\d+)$/) || match(hp, /^([^:]+):(\d+)$/);
		if (!hm) return null;
		return {
			tag: frag || `${hm[1]}:${hm[2]}`,
			object: {
				type: 'shadowsocks',
				server: hm[1],
				server_port: int(hm[2]),
				method: urlDecode(substr(user, 0, ci)),
				password: urlDecode(substr(user, ci + 1))
			}
		};
	}

	let at = rindex(body, '@');
	if (at < 0) return null;
	let user = urlDecode(substr(body, 0, at));
	let hp = substr(body, at + 1);
	let hm = match(hp, /^\[([^\]]+)\]:(\d+)$/) || match(hp, /^([^:]+):(\d+)$/);
	if (!hm) return null;
	let host = hm[1], port = int(hm[2]);
	let tag = frag || `${host}:${port}`;

	if (scheme == 'vless') {
		let obj = { type: 'vless', server: host, server_port: port, uuid: user };
		if (q.flow) obj.flow = q.flow;
		let sec = lc(q.security || '');
		if (sec == 'tls' || sec == 'reality') {
			obj.tls = { enabled: true };
			if (q.sni || q.servername) obj.tls.server_name = q.sni || q.servername;
			if (q.fp) obj.tls.utls = { enabled: true, fingerprint: q.fp };
			if (q.alpn) obj.tls.alpn = split(q.alpn, ',');
			if (q.allowinsecure == '1' || q.insecure == '1') obj.tls.insecure = true;
			if (sec == 'reality') {
				obj.tls.reality = { enabled: true, public_key: q.pbk || '' };
				if (q.sid) obj.tls.reality.short_id = q.sid;
			}
		}
		let net = lc(q.type || 'tcp');
		if (net == 'ws') {
			obj.transport = { type: 'ws', path: q.path || '/' };
			if (q.host) obj.transport.headers = { Host: q.host };
		} else if (net == 'grpc') {
			obj.transport = { type: 'grpc', service_name: q.servicename || q.path || '' };
		}
		return { tag, object: obj };
	}

	if (scheme == 'trojan') {
		let obj = { type: 'trojan', server: host, server_port: port, password: user, tls: { enabled: true } };
		if (q.sni || q.peer) obj.tls.server_name = q.sni || q.peer;
		if (q.allowinsecure == '1' || q.insecure == '1') obj.tls.insecure = true;
		if (q.fp) obj.tls.utls = { enabled: true, fingerprint: q.fp };
		if (lc(q.type || '') == 'ws') {
			obj.transport = { type: 'ws', path: q.path || '/' };
			if (q.host) obj.transport.headers = { Host: q.host };
		} else if (lc(q.type || '') == 'grpc') {
			obj.transport = { type: 'grpc', service_name: q.servicename || '' };
		}
		return { tag, object: obj };
	}

	if (scheme == 'hysteria2' || scheme == 'hy2') {
		let obj = { type: 'hysteria2', server: host, server_port: port, password: user, tls: { enabled: true } };
		if (q.sni || q.peer) obj.tls.server_name = q.sni || q.peer;
		if (q.insecure == '1' || q.allowinsecure == '1') obj.tls.insecure = true;
		if (q.obfs == 'salamander' && q['obfs-password']) {
			obj.obfs = { type: 'salamander', password: q['obfs-password'] };
		}
		return { tag, object: obj };
	}

	if (scheme == 'tuic') {
		let ci = index(user, ':');
		let obj = {
			type: 'tuic',
			server: host,
			server_port: port,
			uuid: ci >= 0 ? substr(user, 0, ci) : user,
			password: ci >= 0 ? substr(user, ci + 1) : '',
			congestion_control: q['congestion-control'] || 'bbr',
			tls: { enabled: true }
		};
		if (q.sni) obj.tls.server_name = q.sni;
		if (q.alpn) obj.tls.alpn = split(q.alpn, ',');
		if (q['allow-insecure'] == '1' || q.insecure == '1') obj.tls.insecure = true;
		return { tag, object: obj };
	}

	if (scheme == 'socks' || scheme == 'socks5' || scheme == 'http' || scheme == 'https') {
		let ci = index(user, ':');
		let obj = {
			type: (scheme == 'socks' || scheme == 'socks5') ? 'socks' : 'http',
			server: host,
			server_port: port
		};
		if (length(user) > 0) {
			obj.username = ci >= 0 ? substr(user, 0, ci) : user;
			if (ci >= 0) obj.password = substr(user, ci + 1);
		}
		if (scheme == 'https') obj.tls = { enabled: true };
		return { tag, object: obj };
	}

	return null;
}

function parseSubscriptionText(raw) {
	let text = trim(raw || '');
	if (!text) return [];
	let nodes = [];

	// 1. Try JSON (sing-box config or SIP008)
	if (substr(text, 0, 1) == '{') {
		let parsed = json(text);
		if (type(parsed) == 'object') {
			if (type(parsed.outbounds) == 'array') {
				let skip = { direct: true, block: true, dns: true, selector: true, urltest: true };
				for (let o in parsed.outbounds) {
					if (type(o) == 'object' && o.type && !skip[o.type] && o.tag) {
						let copy = {};
						for (let k, v in o) if (k != 'tag') copy[k] = v;
						push(nodes, { tag: toStr(o.tag), object: copy });
					}
				}
				return nodes;
			}
			if (type(parsed.servers) == 'array') {
				for (let s in parsed.servers) {
					if (type(s) == 'object' && s.server && s.server_port && s.method && s.password) {
						push(nodes, {
							tag: toStr(s.remarks || `${s.server}:${s.server_port}`),
							object: {
								type: 'shadowsocks',
								server: toStr(s.server),
								server_port: int(s.server_port),
								method: toStr(s.method),
								password: toStr(s.password)
							}
						});
					}
				}
				return nodes;
			}
		}
	}

	// 2. Try plain share links or Base64-encoded share links
	let lines = filter(map(split(text, /\r?\n/), (l) => trim(l)), (l) => length(l) > 0);
	if (length(lines) > 0 && !match(lines[0], /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//)) {
		let dec = safeB64Dec(text);
		if (dec) {
			let inner = filter(map(split(dec, /\r?\n/), (l) => trim(l)), (l) => length(l) > 0);
			if (length(inner) > 0 && match(inner[0], /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//))
				lines = inner;
		}
	}

	for (let l in lines) {
		let n = parseShareLink(l);
		if (n) push(nodes, n);
	}
	return nodes;
}

function downloadSub(sub) {
	let ua = sub.userAgent && length(trim(sub.userAgent)) > 0 ? trim(sub.userAgent) : 'sing-box/1.14';
	let cmd = '';
	if (runCmd('command -v curl').code == 0) {
		cmd = `curl -fsSL --connect-timeout 15 --max-time 60 -A ${shellQuote(ua)} ${shellQuote(sub.url)}`;
	} else {
		cmd = `uclient-fetch -q -T 30 -U ${shellQuote(ua)} -O - ${shellQuote(sub.url)}`;
	}
	return runCmd(cmd);
}

function nodeFingerprint(tag, obj) {
	if (type(obj) != 'object') return `raw:${tag}`;
	let cred = toStr(obj.uuid || obj.password || obj.private_key || obj.username || '');
	return `${obj.type || ''}|${obj.server || ''}|${obj.server_port || ''}|${cred}`;
}

function splitKw(raw) {
	return filter(map(split(toStr(raw || ''), /[\n,|]+/), (x) => lc(trim(x))), (x) => length(x) > 0);
}

function freshTag(base, used) {
	if (!used[base]) return base;
	for (let i = 2; i < 9999; i++) {
		let cand = `${base}-${i}`;
		if (!used[cand]) return cand;
	}
	return `${base}-${uid()}`;
}

function mergeIntoProfile(profile, sub, parsedNodes) {
	let inc = splitKw(sub.includeKeywords);
	let exc = splitKw(sub.excludeKeywords);
	let rx = null;
	if (sub.regexFilter && length(trim(sub.regexFilter)) > 0) {
		try { rx = regexp(trim(sub.regexFilter), 'i'); } catch (e) { rx = null; }
	}

	let idByKey = {}, idByTag = {};
	let preserved = [];
	let usedTags = {};

	for (let n in (profile.nodes || [])) {
		if (n.subId == sub.id) {
			let key = n.subKey || n.tag;
			if (!idByKey[key]) idByKey[key] = n.id;
			if (!idByTag[n.tag]) idByTag[n.tag] = n.id;
		} else {
			push(preserved, n);
			usedTags[n.tag] = true;
		}
	}

	let seenKeys = {};
	let prefix = ltrim(sub.renamePrefix || '');
	let mergedSub = [];

	for (let item in parsedNodes) {
		let tLower = lc(item.tag);
		if (length(inc) > 0) {
			let ok = false;
			for (let kw in inc) if (index(tLower, kw) >= 0) { ok = true; break; }
			if (!ok) continue;
		}
		if (length(exc) > 0) {
			let drop = false;
			for (let kw in exc) if (index(tLower, kw) >= 0) { drop = true; break; }
			if (drop) continue;
		}
		if (rx && !match(item.tag, rx)) continue;

		let fp = nodeFingerprint(item.tag, item.object);
		if (sub.deduplicate && seenKeys[fp]) continue;
		seenKeys[fp] = true;

		let tag = prefix ? `${prefix}${item.tag}` : item.tag;
		tag = freshTag(tag, usedTags);
		usedTags[tag] = true;

		let reusedId = idByKey[fp] || idByTag[tag] || idByTag[item.tag];
		push(mergedSub, {
			id: reusedId || uid(),
			tag: tag,
			body: sprintf('%.2J', item.object),
			inGroups: sub.inGroups !== false,
			subId: sub.id,
			subKey: fp
		});
	}

	profile.nodes = [...preserved, ...mergedSub];
	return length(mergedSub);
}

// Incrementally patch outbounds in existing /etc/sing-box/config.json from updated profile
function patchRunningConfig(profile) {
	let raw = readfile(SB_CONFIG);
	if (!raw) return false;
	let cfg = json(raw);
	if (type(cfg) != 'object' || type(cfg.outbounds) != 'array') return false;

	let nodeObjs = [];
	let idToTag = {};
	let groupedTags = [];

	for (let n in (profile.nodes || [])) {
		let body = json(n.body);
		if (type(body) != 'object' || !body.type) continue;
		let obj = { type: body.type, tag: n.tag };
		for (let k, v in body) if (k != 'type' && k != 'tag') obj[k] = v;
		if (!('domain_resolver' in obj)) obj.domain_resolver = 'local';
		push(nodeObjs, obj);
		idToTag[n.id] = n.tag;
		if (n.inGroups !== false) push(groupedTags, n.tag);
	}
	if (length(groupedTags) == 0) return false;

	let viaTailnet = [];
	for (let t in (profile.settings?.tailnets || [])) {
		idToTag[t.id] = t.tag;
		if (t.asProxy) push(viaTailnet, t.tag);
	}

	let groupObjs = [];
	for (let g in (profile.groups || [])) {
		let members = [];
		for (let mid in (g.members || [])) {
			if (idToTag[mid]) push(members, idToTag[mid]);
		}
		if (length(members) == 0) continue;
		idToTag[g.id] = g.tag;
		if (g.type == 'urltest') {
			push(groupObjs, {
				type: 'urltest',
				tag: g.tag,
				outbounds: members,
				url: trim(g.testUrl || '') || 'https://www.gstatic.com/generate_204',
				interval: trim(g.interval || '') || '3m',
				tolerance: g.tolerance != null ? int(g.tolerance) : 50,
				idle_timeout: '30m'
			});
		} else {
			let go = { type: 'selector', tag: g.tag, outbounds: members };
			if (g.defaultMember && idToTag[g.defaultMember]) go.default = idToTag[g.defaultMember];
			push(groupObjs, go);
		}
	}

	let listNodes = profile.settings?.listNodesInProxy !== false;
	let proxyOutbounds = ['auto'];
	for (let g in groupObjs) push(proxyOutbounds, g.tag);
	if (listNodes) for (let t in groupedTags) push(proxyOutbounds, t);
	for (let t in viaTailnet) push(proxyOutbounds, t);

	let proxyDefault = 'auto';
	let defId = profile.settings?.proxyDefault || 'auto';
	if (defId != 'auto' && idToTag[defId]) proxyDefault = idToTag[defId];

	cfg.outbounds = [
		{ type: 'selector', tag: 'proxy', outbounds: proxyOutbounds, default: proxyDefault },
		{
			type: 'urltest',
			tag: 'auto',
			outbounds: groupedTags,
			url: 'https://www.gstatic.com/generate_204',
			interval: '3m',
			tolerance: 50,
			idle_timeout: '30m'
		},
		...groupObjs,
		...nodeObjs,
		{ type: 'direct', tag: 'direct' }
	];

	runCmd(`${SERVICE_MGR} ensure_dirs`);
	return writefile(TMP_NEW_CONFIG, sprintf('%.2J', cfg), 0600);
}

// --- Main CLI ---
let targetId = ARGV[0] || '';
let c = cursor();
c.load('singsing');
let activeName = c.get('singsing', 'main', 'active_profile') || 'default';
let autoApply = c.get('singsing', 'subscription', 'auto_apply') == '1';

let subsRaw = readfile(SUBS_FILE);
let subs = subsRaw ? json(subsRaw) : [];
if (type(subs) != 'array' || length(subs) == 0) {
	print(sprintf('%J\n', { ok: true, updated: [], failed: [], message: '没有已配置的订阅' }));
	exit(0);
}

let profPath = `${PROFILES_DIR}/${activeName}.json`;
let profRaw = readfile(profPath);
let profile = profRaw ? json(profRaw) : null;
if (type(profile) != 'object' || type(profile.nodes) != 'array') {
	print(sprintf('%J\n', { ok: false, error: `无法读取当前配置方案 ${activeName}` }));
	exit(1);
}

let updated = [], failed = [];
for (let sub in subs) {
	if (length(targetId) > 0 && sub.id != targetId) continue;
	if (length(targetId) == 0 && sub.enabled === false) continue;

	let dl = downloadSub(sub);
	if (dl.code != 0 || length(trim(dl.output)) == 0) {
		sub.lastUpdated = time();
		sub.lastStatus = 'error';
		sub.lastError = '下载订阅失败（已保留旧节点）';
		push(failed, { id: sub.id, name: sub.name, error: sub.lastError });
		continue;
	}

	let parsed = parseSubscriptionText(dl.output);
	if (length(parsed) == 0) {
		sub.lastUpdated = time();
		sub.lastStatus = 'error';
		sub.lastError = '未解析到有效节点（已保留旧节点；若为复杂 Clash YAML 请在 LuCI 手动更新）';
		push(failed, { id: sub.id, name: sub.name, error: sub.lastError });
		continue;
	}

	let count = mergeIntoProfile(profile, sub, parsed);
	sub.lastUpdated = time();
	sub.lastStatus = 'ok';
	sub.lastError = '';
	sub.lastCount = count;
	push(updated, { id: sub.id, name: sub.name, count: count });
}

writefile(SUBS_FILE, sprintf('%.2J', subs), 0600);
if (length(updated) > 0) {
	writefile(profPath, sprintf('%.2J', profile), 0600);
}

let applied = false, applyError = '';
if (length(updated) > 0 && autoApply && stat(SB_CONFIG)) {
	if (patchRunningConfig(profile)) {
		let ap = runCmd(`${SERVICE_MGR} apply_config`);
		applied = (ap.code == 0);
		if (!applied) applyError = trim(ap.output);
	}
}

print(sprintf('%J\n', {
	ok: length(failed) == 0,
	updated: updated,
	failed: failed,
	applied: applied,
	apply_error: applyError
}));
exit(length(failed) == 0 ? 0 : 1);
