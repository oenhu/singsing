#!/usr/bin/env ucode
'use strict';

// Zero-dependency OpenWrt background subscription updater for luci-app-singsing.
// Runs directly on OpenWrt 24.10 & 25.12 built-in ucode (no QuickJS / Node.js / Python / Lua).

import { readfile, writefile, stat, unlink, rename, popen, chmod } from 'fs';
import { cursor } from 'uci';

const CONF_DIR = '/etc/singsing';
const PROFILES_DIR = `${CONF_DIR}/profiles`;
const SUBS_FILE = `${CONF_DIR}/subscriptions.json`;
const SB_CONFIG = `${CONF_DIR}/sing-box.json`;
const TMP_NEW_CONFIG = '/tmp/singsing/config.new.json';
const SUB_LOCK = '/tmp/singsing/sub-updater.lock';
const SERVICE_MGR = '/usr/share/singsing/service-manager.sh';

const ENDPOINT_TYPES = { wireguard: true, openconnect: true, 'openvpn-client': true };
const RESERVED_TAGS = { proxy: true, auto: true, direct: true, local: true, remote: true, 'tun-in': true, 'dns-in': true };

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

function safeProfileName(name) {
	let s = trim(toStr(name || 'default'));
	if (!match(s, /^[a-zA-Z0-9_-]{1,64}$/)) return 'default';
	return s;
}

function urlDecode(s) {
	if (!s) return '';
	return replace(toStr(s), /%([0-9A-Fa-f]{2})/g, (m, h) => chr(hex(h)));
}

function safeB64Dec(s) {
	if (!s) return null;
	let clean = replace(replace(replace(toStr(s), /\s+/g, ''), /-/g, '+'), /_/g, '/');
	clean = replace(clean, /=+$/, '');
	if (length(clean) == 0 || !match(clean, /^[A-Za-z0-9+/]+$/)) return null;
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

function csvList(s) {
	if (!s) return [];
	return filter(map(split(toStr(s), ','), (x) => trim(x)), (x) => length(x) > 0);
}

function flagTrue(v) {
	let s = lc(trim(toStr(v)));
	return s == '1' || s == 'true' || s == 'yes';
}

function parseHostPort(hp, defaultPort) {
	let host = '', portSpec = '';
	let m6 = match(hp, /^\[([^\]]+)\](:(.*))?$/);
	if (m6) {
		host = urlDecode(m6[1]);
		portSpec = trim(m6[3] || '');
	} else {
		let ci = rindex(hp, ':');
		if (ci >= 0) {
			host = urlDecode(substr(hp, 0, ci));
			portSpec = trim(substr(hp, ci + 1));
		} else {
			host = urlDecode(hp);
		}
	}
	if (length(host) == 0) return null;
	let portNum = 0;
	if (match(portSpec, /^[0-9]+$/)) {
		portNum = int(portSpec);
	} else if (length(portSpec) > 0) {
		let firstNum = match(portSpec, /^([0-9]+)/);
		portNum = firstNum ? int(firstNum[1]) : (defaultPort || 0);
	} else if (defaultPort) {
		portNum = defaultPort;
	}
	if (portNum < 1 || portNum > 65535) return null;
	return { host: host, port: portNum, portSpec: portSpec };
}

function parsePortHopList(spec) {
	if (!spec) return null;
	let out = [];
	for (let part in csvList(spec)) {
		let m = match(part, /^([0-9]+)-([0-9]+)$/);
		if (m) push(out, `${m[1]}:${m[2]}`);
		else if (match(part, /^[0-9]+$/)) push(out, `${part}:${part}`);
	}
	return length(out) > 0 ? out : null;
}

function buildV2Transport(net, host, path, serviceName, headerType, edStr) {
	let n = lc(trim(toStr(net || 'tcp')));
	if (n == '' || n == 'tcp') {
		if (lc(toStr(headerType)) == 'http') {
			let t = { type: 'http', path: path || '/' };
			let hl = csvList(host);
			if (length(hl) > 0) t.host = hl;
			return t;
		}
		return null;
	}
	if (n == 'ws') {
		let p = toStr(path || '/');
		let ed = int(edStr || 0);
		let edm = match(p, /([?&])ed=([0-9]+)&?/);
		if (edm) {
			ed = int(edm[2]);
			p = replace(replace(p, /([?&])ed=[0-9]+&?/, '$1'), /[?&]$/, '');
			if (length(p) == 0) p = '/';
		}
		let t = { type: 'ws', path: p };
		if (host && length(trim(toStr(host))) > 0)
			t.headers = { Host: trim(toStr(host)) };
		if (ed > 0) {
			t.max_early_data = ed;
			t.early_data_header_name = 'Sec-WebSocket-Protocol';
		}
		return t;
	}
	if (n == 'httpupgrade') {
		let t = { type: 'httpupgrade' };
		if (path && length(toStr(path)) > 0) t.path = toStr(path);
		let hl = csvList(host);
		if (length(hl) > 0) t.host = hl[0];
		return t;
	}
	if (n == 'h2' || n == 'http') {
		let t = { type: 'http' };
		if (path && length(toStr(path)) > 0) t.path = toStr(path);
		let hl = csvList(host);
		if (length(hl) > 0) t.host = hl;
		return t;
	}
	if (n == 'grpc') {
		let sn = toStr(serviceName ?? path ?? '');
		let t = { type: 'grpc' };
		if (length(sn) > 0) t.service_name = sn;
		return t;
	}
	return null;
}

function parseShareLink(line) {
	// Standard POSIX ERE capturing group
	let m = match(line, /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^#]*)(#(.*))?$/);
	if (!m) return null;
	let scheme = lc(m[1]);
	let rest = m[2];
	let frag = trim(urlDecode(m[4] || ''));

	// VMess v2rayN base64 JSON format (falls through to URI format if not base64 JSON)
	if (scheme == 'vmess') {
		let qi0 = index(rest, '?');
		let b64Part = replace(qi0 < 0 ? rest : substr(rest, 0, qi0), /\/+$/, '');
		let dec = safeB64Dec(urlDecode(b64Part));
		let v = dec ? safeJson(dec) : null;
		if (type(v) == 'object' && v.add && v.id) {
			let net = lc(trim(toStr(v.net || 'tcp')));
			let hostHdr = trim(toStr(v.host || ''));
			let pathStr = trim(toStr(v.path || ''));
			if (toStr(v.v) == '1' && index(hostHdr, ';') >= 0 && length(pathStr) == 0) {
				let sp = split(hostHdr, ';');
				hostHdr = sp[0] || '';
				pathStr = sp[1] || '';
			}
			let obj = {
				type: 'vmess',
				server: trim(toStr(v.add)),
				server_port: int(v.port || 443),
				uuid: trim(toStr(v.id)),
				security: (v.scy && v.scy != 'auto') ? toStr(v.scy) : 'auto',
				alter_id: int(v.aid || 0)
			};
			if (lc(toStr(v.tls)) == 'tls' || v.tls === true || net == 'h2') {
				obj.tls = { enabled: true };
				let sni = trim(toStr(v.sni || ''));
				if (length(sni) == 0 && length(hostHdr) > 0) sni = csvList(hostHdr)[0] || '';
				if (length(sni) > 0) obj.tls.server_name = sni;
				if (v.fp) obj.tls.utls = { enabled: true, fingerprint: lc(toStr(v.fp)) };
				let alpn = csvList(v.alpn);
				if (length(alpn) > 0) obj.tls.alpn = alpn;
				if (flagTrue(v.allowInsecure ?? v.skipCertVerify)) obj.tls.insecure = true;
			}
			let tr = buildV2Transport(net, hostHdr, pathStr, pathStr, v.type, '');
			if (tr) obj.transport = tr;
			return { tag: frag || trim(toStr(v.ps || v.add)), object: obj };
		}
		if (index(rest, '@') < 0) return null;
	}

	let qi = index(rest, '?');
	let body = replace(qi < 0 ? rest : substr(rest, 0, qi), /\/+$/, '');
	let q = qi < 0 ? {} : parseQuery(substr(rest, qi + 1));

	// Shadowsocks SIP002 (including URL-encoded %3D base64 userinfo) & legacy base64
	if (scheme == 'ss') {
		let at = rindex(body, '@');
		let method = '', password = '', hp = '';
		if (at < 0) {
			let dec = safeB64Dec(urlDecode(body));
			if (!dec) return null;
			at = rindex(dec, '@');
			if (at < 0) return null;
			let userinfo = substr(dec, 0, at);
			hp = substr(dec, at + 1);
			let ci = index(userinfo, ':');
			if (ci < 0) return null;
			method = substr(userinfo, 0, ci);
			password = substr(userinfo, ci + 1);
		} else {
			let rawUser = urlDecode(substr(body, 0, at));
			hp = substr(body, at + 1);
			let ci = index(rawUser, ':');
			if (ci >= 0) {
				method = substr(rawUser, 0, ci);
				password = substr(rawUser, ci + 1);
			} else {
				let decU = safeB64Dec(rawUser);
				if (!decU) return null;
				ci = index(decU, ':');
				if (ci < 0) return null;
				method = substr(decU, 0, ci);
				password = substr(decU, ci + 1);
			}
		}
		let parsedHp = parseHostPort(hp, 0);
		if (!parsedHp) return null;
		let ssObj = {
			type: 'shadowsocks',
			server: parsedHp.host,
			server_port: parsedHp.port,
			method: method,
			password: password
		};
		if (flagTrue(q.uot || q['udp-over-tcp'])) ssObj.udp_over_tcp = { enabled: true, version: 1 };
		return {
			tag: frag || `${parsedHp.host}:${parsedHp.port}`,
			object: ssObj
		};
	}

	let at = rindex(body, '@');
	if (at < 0) return null;
	let rawUser = substr(body, 0, at);
	let user = urlDecode(rawUser);
	let hpStr = substr(body, at + 1);

	let defPort = 0;
	if (scheme == 'vless' || scheme == 'trojan' || scheme == 'vmess' || scheme == 'hysteria2' || scheme == 'hy2' || scheme == 'hysteria' || scheme == 'hy' || scheme == 'anytls' || scheme == 'https')
		defPort = 443;
	else if (scheme == 'socks' || scheme == 'socks5' || scheme == 'socks5h')
		defPort = 1080;
	else if (scheme == 'http')
		defPort = 80;

	let parsedHp = parseHostPort(hpStr, defPort);
	if (!parsedHp) return null;
	let host = parsedHp.host, port = parsedHp.port;
	let tag = frag || `${host}:${port}`;

	if (scheme == 'vless' || scheme == 'trojan' || scheme == 'vmess') {
		let obj = { type: scheme, server: host, server_port: port };
		if (scheme == 'trojan') obj.password = user;
		else obj.uuid = user;
		if (scheme == 'vmess') {
			obj.security = q.encryption || 'auto';
			obj.alter_id = 0;
		}
		if (scheme == 'vless' && q.flow) obj.flow = q.flow;
		if (q.packetencoding) obj.packet_encoding = q.packetencoding;

		let sec = lc(q.security || (scheme == 'trojan' ? 'tls' : 'none'));
		let net = lc(q.type || 'tcp');
		if (sec == 'tls' || sec == 'reality' || sec == 'xtls' || net == 'h2') {
			obj.tls = { enabled: true };
			let sni = q.sni || q.servername || q.peer;
			if (sni) obj.tls.server_name = sni;
			let fp = lc(q.fp || q.fingerprint || '');
			if (fp) obj.tls.utls = { enabled: true, fingerprint: fp };
			else if (sec == 'reality') obj.tls.utls = { enabled: true };
			let alpn = csvList(q.alpn);
			if (length(alpn) > 0) obj.tls.alpn = alpn;
			if (flagTrue(q.allowinsecure || q.insecure || q['allow-insecure'] || q['skip-cert-verify']))
				obj.tls.insecure = true;
			let pbk = q.pbk || q['public-key'];
			if (sec == 'reality' || pbk) {
				obj.tls.reality = { enabled: true, public_key: pbk || '' };
				let sid = q.sid || q['short-id'];
				if (sid) obj.tls.reality.short_id = sid;
			}
		}
		let tr = buildV2Transport(net, q.host, q.path, q.servicename, q.headertype, q.ed);
		if (tr) obj.transport = tr;
		return { tag, object: obj };
	}

	if (scheme == 'hysteria2' || scheme == 'hy2') {
		let obj = { type: 'hysteria2', server: host, server_port: port, password: user, tls: { enabled: true } };
		let hopSpec = (index(parsedHp.portSpec, '-') >= 0 || index(parsedHp.portSpec, ',') >= 0) ? parsedHp.portSpec : q.mport;
		let hopPorts = parsePortHopList(hopSpec);
		if (hopPorts) obj.server_ports = hopPorts;
		if (q.sni || q.peer) obj.tls.server_name = q.sni || q.peer;
		if (flagTrue(q.insecure || q.allowinsecure)) obj.tls.insecure = true;
		let alpn = csvList(q.alpn);
		if (length(alpn) > 0) obj.tls.alpn = alpn;
		if (q.obfs && q.obfs != 'none') {
			obj.obfs = { type: q.obfs };
			if (q['obfs-password']) obj.obfs.password = q['obfs-password'];
		}
		let upMbps = int(q.up || q.upmbps || 0);
		let downMbps = int(q.down || q.downmbps || 0);
		if (upMbps > 0) obj.up_mbps = upMbps;
		if (downMbps > 0) obj.down_mbps = downMbps;
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
			congestion_control: q['congestion-control'] || q['congestion-controller'] || 'bbr',
			tls: { enabled: true, alpn: ['h3'] }
		};
		if (q['udp-relay-mode']) obj.udp_relay_mode = q['udp-relay-mode'];
		if (q.sni) obj.tls.server_name = q.sni;
		let alpn = csvList(q.alpn);
		if (length(alpn) > 0) obj.tls.alpn = alpn;
		if (flagTrue(q['allow-insecure'] || q.insecure || q.allowinsecure)) obj.tls.insecure = true;
		return { tag, object: obj };
	}

	if (scheme == 'anytls') {
		let obj = { type: 'anytls', server: host, server_port: port, password: user, tls: { enabled: true } };
		if (q.sni || q.peer) obj.tls.server_name = q.sni || q.peer;
		if (q.fp) obj.tls.utls = { enabled: true, fingerprint: lc(q.fp) };
		let alpn = csvList(q.alpn);
		if (length(alpn) > 0) obj.tls.alpn = alpn;
		if (flagTrue(q.insecure || q.allowinsecure)) obj.tls.insecure = true;
		return { tag, object: obj };
	}

	if (scheme == 'wireguard' || scheme == 'wg') {
		let addrs = csvList(q.address || q.ip || '10.0.0.2/32');
		let normAddrs = map(addrs, (a) => index(a, '/') >= 0 ? a : (index(a, ':') >= 0 ? `${a}/128` : `${a}/32`));
		let peer = {
			address: host,
			port: port,
			public_key: q.publickey || q['public-key'] || '',
			allowed_ips: ['0.0.0.0/0', '::/0']
		};
		if (q.presharedkey || q['pre-shared-key']) peer.pre_shared_key = q.presharedkey || q['pre-shared-key'];
		let obj = {
			type: 'wireguard',
			address: normAddrs,
			private_key: user,
			peers: [peer]
		};
		let mtu = int(q.mtu || 0);
		if (mtu > 0) obj.mtu = mtu;
		return { tag, object: obj };
	}

	if (scheme == 'socks' || scheme == 'socks5' || scheme == 'socks5h' || scheme == 'http' || scheme == 'https') {
		let credStr = user;
		if (length(credStr) > 0 && index(credStr, ':') < 0) {
			let decC = safeB64Dec(rawUser);
			if (decC && index(decC, ':') >= 0) credStr = decC;
		}
		let ci = index(credStr, ':');
		let obj = {
			type: (scheme == 'http' || scheme == 'https') ? 'http' : 'socks',
			server: host,
			server_port: port
		};
		if (obj.type == 'socks') obj.version = '5';
		if (length(credStr) > 0) {
			obj.username = ci >= 0 ? substr(credStr, 0, ci) : credStr;
			if (ci >= 0) obj.password = substr(credStr, ci + 1);
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
		let parsed = safeJson(text);
		if (type(parsed) == 'object') {
			if (type(parsed.outbounds) == 'array' || type(parsed.endpoints) == 'array') {
				let skip = { direct: true, block: true, dns: true, selector: true, urltest: true };
				for (let o in (parsed.outbounds || [])) {
					if (type(o) == 'object' && o.type && !skip[o.type] && o.tag) {
						let copy = {};
						for (let k, v in o) if (k != 'tag') copy[k] = v;
						push(nodes, { tag: toStr(o.tag), object: copy });
					}
				}
				for (let ep in (parsed.endpoints || [])) {
					if (type(ep) == 'object' && ENDPOINT_TYPES[ep.type] && ep.tag) {
						let copy = {};
						for (let k, v in ep) if (k != 'tag') copy[k] = v;
						push(nodes, { tag: toStr(ep.tag), object: copy });
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

	// 2. Try plain share links or Base64-encoded share links / JSON
	let lines = filter(map(split(text, /\r?\n/), (l) => trim(l)), (l) => length(l) > 0);
	if (length(lines) > 0 && !match(lines[0], /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//)) {
		let dec = safeB64Dec(text);
		if (dec) {
			if (substr(trim(dec), 0, 1) == '{') {
				let jsonNodes = parseSubscriptionText(dec);
				if (length(jsonNodes) > 0) return jsonNodes;
			}
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
	let u = trim(toStr(sub.url || ''));
	if (!match(u, /^https?:\/\/[^[:space:]]+$/))
		return { code: 1, output: 'Invalid URL' };
	let ua = sub.userAgent && length(trim(sub.userAgent)) > 0 ? trim(sub.userAgent) : 'sing-box/1.14';
	let cmd = '';
	if (runCmd('command -v curl').code == 0) {
		cmd = `curl -fsSL --proto '=http,https' --proto-redir '=http,https' --max-filesize 8388608 --connect-timeout 10 --max-time 25 -A ${shellQuote(ua)} ${shellQuote(u)}`;
	} else {
		cmd = `uclient-fetch -q -T 20 -U ${shellQuote(ua)} -O - ${shellQuote(u)}`;
	}
	return runCmd(cmd);
}

function nodeFingerprint(tag, obj) {
	if (type(obj) != 'object') return `raw:${tag}`;
	let srv = toStr(obj.server || obj.peers?.[0]?.address || '');
	let prt = toStr(obj.server_port || obj.peers?.[0]?.port || '');
	let cred = toStr(obj.uuid || obj.password || obj.private_key || obj.username || '');
	return `${obj.type || ''}|${srv}|${prt}|${cred}`;
}

function splitKw(raw) {
	return filter(map(split(toStr(raw || ''), /[\n,|]+/), (x) => lc(trim(x))), (x) => length(x) > 0);
}

function freshTag(base, used) {
	if (!used[base]) return base;
	for (let i = 1; i < 9999; i++) {
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
	for (let k, v in RESERVED_TAGS) if (v) usedTags[k] = true;
	for (let g in (profile.groups || [])) if (g.tag) usedTags[g.tag] = true;
	for (let t in (profile.settings?.tailnets || [])) if (t.tag) usedTags[t.tag] = true;

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

	// Never wipe existing subscription nodes if filtering produced 0 nodes
	if (length(mergedSub) == 0) return 0;

	profile.nodes = [...preserved, ...mergedSub];
	return length(mergedSub);
}

// Incrementally patch outbounds & endpoints in existing /etc/singsing/sing-box.json from updated profile
function patchRunningConfig(profile) {
	let raw = readfile(SB_CONFIG);
	if (!raw) return false;
	let cfg = safeJson(raw);
	if (type(cfg) != 'object' || type(cfg.outbounds) != 'array') return false;

	let nodeObjs = [];
	let nodeEndpoints = [];
	let idToTag = {};
	let groupedTags = [];

	for (let n in (profile.nodes || [])) {
		let body = safeJson(n.body);
		if (type(body) != 'object' || !body.type) continue;
		let obj = { type: body.type, tag: n.tag };
		for (let k, v in body) if (k != 'type' && k != 'tag') obj[k] = v;
		if (!('domain_resolver' in obj)) obj.domain_resolver = 'local';
		if (ENDPOINT_TYPES[body.type]) {
			push(nodeEndpoints, obj);
		} else {
			push(nodeObjs, obj);
		}
		idToTag[n.id] = n.tag;
		if (n.inGroups !== false) push(groupedTags, n.tag);
	}
	if (length(groupedTags) == 0) return false;

	let viaTailnet = [];
	for (let t in (profile.settings?.tailnets || [])) {
		idToTag[t.id] = t.tag;
		if (t.asProxy) push(viaTailnet, t.tag);
	}

	// Fixed-point resolution for nested groups (matches upstream usableGroups)
	let usable = {};
	for (let changed = true; changed; ) {
		changed = false;
		for (let g in (profile.groups || [])) {
			if (usable[g.id]) continue;
			for (let mid in (g.members || [])) {
				if (mid != g.id && (idToTag[mid] || usable[mid])) {
					usable[g.id] = true;
					idToTag[g.id] = g.tag;
					changed = true;
					break;
				}
			}
		}
	}

	let groupObjs = [];
	for (let g in (profile.groups || [])) {
		if (!usable[g.id]) continue;
		let members = [];
		for (let mid in (g.members || [])) {
			if (mid != g.id && idToTag[mid]) push(members, idToTag[mid]);
		}
		if (length(members) == 0) continue;
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
			if (g.defaultMember && index(g.members || [], g.defaultMember) >= 0 && idToTag[g.defaultMember])
				go.default = idToTag[g.defaultMember];
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
	if (defId != 'auto' && idToTag[defId] && index(proxyOutbounds, idToTag[defId]) >= 0) {
		proxyDefault = idToTag[defId];
	}

	// Preserve existing Tailscale endpoints while updating node endpoints
	let existingTsEndpoints = [];
	for (let ep in (cfg.endpoints || [])) {
		if (type(ep) == 'object' && ep.type == 'tailscale')
			push(existingTsEndpoints, ep);
	}
	let allEndpoints = [...existingTsEndpoints, ...nodeEndpoints];
	if (length(allEndpoints) > 0)
		cfg.endpoints = allEndpoints;
	else
		delete cfg.endpoints;

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
	return writeFileSafe(TMP_NEW_CONFIG, sprintf('%.2J', cfg), 0600);
}

// --- Main CLI ---
runCmd(`${SERVICE_MGR} ensure_dirs`);
if (stat(SUB_LOCK)) {
	let st = stat(SUB_LOCK);
	if (st && (time() - st.mtime) < 180) {
		print(sprintf('%J\n', { ok: false, updated: [], failed: [], error: '另一个订阅更新任务正在运行中' }));
		exit(1);
	}
}
writefile(SUB_LOCK, '' + time());

let exitCode = 0;
try {
	let targetId = ARGV[0] || '';
	let c = cursor();
	c.load('singsing');
	let activeName = safeProfileName(c.get('singsing', 'main', 'active_profile') || 'default');
	let autoApply = c.get('singsing', 'subscription', 'auto_apply') == '1';
	let serviceEnabled = c.get('singsing', 'main', 'enabled') == '1';

	let subsRaw = readfile(SUBS_FILE);
	let subs = subsRaw ? safeJson(subsRaw) : [];
	if (type(subs) != 'array' || length(subs) == 0) {
		unlink(SUB_LOCK);
		print(sprintf('%J\n', { ok: true, updated: [], failed: [], message: '没有已配置的订阅' }));
		exit(0);
	}

	let profileCache = {};
	let dirtyProfiles = {};
	let loadProf = (pName) => {
		if (pName in profileCache) return profileCache[pName];
		let raw = readfile(`${PROFILES_DIR}/${pName}.json`);
		let p = raw ? safeJson(raw) : null;
		if (type(p) != 'object' || type(p.nodes) != 'array') p = null;
		profileCache[pName] = p;
		return p;
	};

	let updated = [], failed = [];
	for (let sub in subs) {
		if (type(sub) != 'object') continue;
		if (length(targetId) > 0 && sub.id != targetId) continue;
		let subProfName = safeProfileName(sub.profile || 'default');
		// When running all subscriptions manually/cron without a specific id, run enabled ones
		if (length(targetId) == 0 && sub.enabled === false) continue;

		let profile = loadProf(subProfName);
		if (!profile) {
			sub.lastUpdated = time();
			sub.lastStatus = 'error';
			sub.lastError = `目标配置方案 ${subProfName} 不存在或损坏`;
			push(failed, { id: sub.id, name: sub.name, error: sub.lastError });
			continue;
		}

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
			sub.lastError = '未解析到有效节点（已保留旧节点；后台仅支持 sing-box JSON / SIP008 / Base64 分享链接，Clash YAML 请在页面点「立即更新」）';
			push(failed, { id: sub.id, name: sub.name, error: sub.lastError });
			continue;
		}

		let count = mergeIntoProfile(profile, sub, parsed);
		if (count == 0) {
			sub.lastUpdated = time();
			sub.lastStatus = 'error';
			sub.lastError = '过滤后剩余 0 个节点（已保留旧节点防止清空）';
			push(failed, { id: sub.id, name: sub.name, error: sub.lastError });
			continue;
		}

		dirtyProfiles[subProfName] = true;
		sub.lastUpdated = time();
		sub.lastStatus = 'ok';
		sub.lastError = '';
		sub.lastCount = count;
		push(updated, { id: sub.id, name: sub.name, profile: subProfName, count: count });
	}

	writeFileSafe(SUBS_FILE, sprintf('%.2J', subs), 0600);
	for (let pName, isDirty in dirtyProfiles) {
		if (isDirty && profileCache[pName]) {
			writeFileSafe(`${PROFILES_DIR}/${pName}.json`, sprintf('%.2J', profileCache[pName]), 0600);
		}
	}

	let applied = false, applyError = '';
	if (dirtyProfiles[activeName] && autoApply && serviceEnabled && stat(SB_CONFIG) && profileCache[activeName]) {
		if (patchRunningConfig(profileCache[activeName])) {
			let ap = runCmd(`${SERVICE_MGR} apply_config`);
			applied = (ap.code == 0);
			if (!applied) applyError = trim(ap.output);
		}
	}

	unlink(SUB_LOCK);
	exitCode = length(failed) == 0 ? 0 : 1;
	print(sprintf('%J\n', {
		ok: length(failed) == 0,
		updated: updated,
		failed: failed,
		applied: applied,
		apply_error: applyError
	}));
} catch (err) {
	unlink(SUB_LOCK);
	print(sprintf('%J\n', {
		ok: false,
		updated: [],
		failed: [],
		error: '订阅更新器内部异常：' + err
	}));
	exit(1);
}

exit(exitCode);
