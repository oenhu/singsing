import { describe, expect, it } from "vitest";
import { blueprintProfile, newDnsRule, newGroup, newNode, newRule, newTailnet } from "../src/adapter/index";
import { walk } from "./dnswalk";
import { click, Element, find, luci } from "./luci-harness";

const nodeBody = JSON.stringify({
  type: "vless",
  server: "proxy.example",
  server_port: 443,
  uuid: "025792b0-4e8e-4b76-a999-4f4ac68be9c1",
});

function profile() {
  const p = blueprintProfile();
  p.nodes = [newNode({ id: "existing-node", tag: "existing", body: nodeBody })];
  p.settings.clashController = "";
  return p;
}

type Harness = ReturnType<typeof luci>;
type Rule = {
  action?: string;
  outbound?: string;
  clash_mode?: string;
  domain?: string[];
  inbound?: string;
  ip_cidr?: string[];
  ip_is_private?: boolean;
  rule_set?: string | string[];
};

function applied(h: Harness) {
  const sent = h.calls.filter(({ method }) => method === "apply_config").at(-1);
  expect(sent).toBeDefined();
  return {
    config: JSON.parse(String(sent?.params.config)),
    manifest: JSON.parse(String(sent?.params.manifest)),
  };
}

function row(root: Element, value: string) {
  return find(root, "tr", (tr) => tr.elements("td").some((cell) => cell.textContent === value));
}

async function enterNode(h: Harness, tag: string, body: string) {
  const modal = h.modal();
  find(modal, "input", (el) => el.attrs.type === "text").value = tag;
  find(modal, "textarea").value = body;
  await click(modal, "保存节点");
}

async function addRoute(h: Harness, root: Element, outbound: string, lines: string, ruleSet?: string) {
  await click(root, "新增路由规则");
  const modal = h.modal();
  const target = find(modal, "select");
  expect(target.elements("option").map((option) => option.value)).toContain(outbound);
  target.value = outbound;
  find(modal, "textarea").value = lines;
  if (ruleSet) {
    find(modal, "input", (el) => String(el.attrs.placeholder).includes("规则集 URL")).value = ruleSet;
    await click(modal, "添加");
  }
  await click(modal, "保存规则");
}

function accessMode(root: Element) {
  return find(root, "select", (select) => select.elements("option").some((option) => option.value === "blocklist"));
}

describe("LuCI client access control", () => {
  it("saves discovered LAN devices and ordered outbound rules, reloads them, and generates native rules", async () => {
    const p = profile();
    p.settings.rules = [newRule({ outbound: "proxy", lines: ["domain:ordinary.example"] })];
    p.groups = [newGroup({ id: "group", tag: "office-group", members: ["existing-node"] })];
    const h = luci(p);
    h.override("get_lan_clients", () => ({ clients: [
      { ip: "192.168.21.50", mac: "02:00:00:00:00:50", hostname: "office" },
    ] }));

    const { root } = await h.view("routing");
    accessMode(root).value = "blocklist";
    const clients = find(root, "textarea", (input) => String(input.attrs.placeholder).includes("每行一个 IPv4"));
    clients.value = "2001:db8:21::/64";
    const device = find(root, "select", (select) => select.elements("option").some((option) => option.value === "192.168.21.50"));
    device.value = "192.168.21.50";
    await click(root, "添加 MAC");
    device.value = "192.168.21.50";
    await click(root, "添加 IP");
    await click(root, "保存访问控制");

    for (const [name, target, entries] of [
      ["Office selector", "office-group", "192.168.21.50\n2001:db8:21::50"],
      ["Office node", "existing", "192.168.21.50"],
    ]) {
      await click(root, "新增设备指定出口");
      const modal = h.modal();
      find(modal, "input", (input) => input.attrs.type === "text").value = name;
      const option = find(modal, "select");
      expect(option.elements("option").map((item) => item.value)).toContain(target);
      option.value = target;
      find(modal, "textarea").value = entries;
      await click(modal, "保存");
    }

    const reloaded = await h.view("routing");
    expect(accessMode(reloaded.root).value).toBe("blocklist");
    expect(find(reloaded.root, "textarea", (input) => String(input.attrs.placeholder).includes("每行一个 IPv4")).value)
      .toBe("2001:db8:21::/64\n02:00:00:00:00:50\n192.168.21.50");
    expect(row(reloaded.root, "Office selector").textContent).toContain("office-group");
    expect(row(reloaded.root, "Office node").textContent).toContain("existing");
    expect(h.calls.some(({ method }) => method === "apply_config")).toBe(false);

    const preview = (await h.api.buildCurrentConfig()).result.config;
    expect(await reloaded.view.handleSaveApply()).toMatchObject({ ok: true });
    const { config } = applied(h);
    expect(config).toEqual(preview);
    const rules: Rule[] = config.route.rules;
    const sniffIdx = rules.findIndex((rule) => rule.action === "sniff");
    expect(sniffIdx).toBeGreaterThan(0);
    const postSniff = rules.slice(sniffIdx);
    const explicit = postSniff.findIndex((rule) => rule.domain?.includes("ordinary.example"));
    const privateDirect = postSniff.findIndex((rule) => rule.ip_is_private && rule.outbound === "direct");
    const customDirect = postSniff.findIndex((rule) => JSON.stringify(rule).includes("custom-direct-domains"));
    expect(rules[0]).toEqual({ inbound: "dns-in", action: "hijack-dns" });
    expect(config.route.find_neighbor).toBe(true);
    expect(privateDirect).toBeGreaterThan(0);
    expect(explicit).toBeGreaterThan(privateDirect);
    expect(postSniff.slice(privateDirect + 1, customDirect)).toEqual([
      { source_ip_cidr: ["192.168.21.50/32", "2001:db8:21::50/128"], action: "route", outbound: "office-group" },
      { source_ip_cidr: ["192.168.21.50/32"], action: "route", outbound: "existing" },
      {
        type: "logical", mode: "or", action: "route", outbound: "direct",
        rules: [
          { source_ip_cidr: ["2001:db8:21::/64", "192.168.21.50/32"] },
          { source_mac_address: ["02:00:00:00:00:50"] },
        ],
      },
    ]);
    // Pre-match rules also emit kernel bypass for the blocklist before sniff
    const preMatch = rules.slice(1, sniffIdx);
    expect(preMatch.some((r) => r.action === "bypass" && JSON.stringify(r).includes("02:00:00:00:00:50"))).toBe(true);
  });

  it("reports an invalid device selector before saving or applying it", async () => {
    const h = luci(profile());
    await click((await h.view("routing")).root, "新增设备指定出口");
    const modal = h.modal();
    find(modal, "textarea").value = "2001:db8::/129";
    await click(modal, "保存");
    expect(h.modal().textContent).toContain("地址格式无效");
    expect(h.calls.some(({ method }) => method === "save_access_control" || method === "apply_config")).toBe(false);
  });

  it("fails explicitly instead of falling back to all mode when get_access_control fails", async () => {
    const h = luci(profile());
    h.override("get_access_control", async () => { throw new Error("access control store unreadable"); });
    await expect(h.api.buildCurrentConfig()).rejects.toThrow(/access control store unreadable/);
    expect(h.calls.some(({ method }) => method === "apply_config")).toBe(false);
  });

  it("ignores an unused stale client list when mode is all across both save and apply", async () => {
    const h = luci(profile());
    const page = await h.view("routing");
    accessMode(page.root).value = "all";
    find(page.root, "textarea", (input) => String(input.attrs.placeholder).includes("每行一个 IPv4")).value = "not-a-valid-client";
    await click(page.root, "保存访问控制");
    expect(h.calls.some(({ method }) => method === "save_access_control")).toBe(true);

    const applyRes = await page.view.handleSaveApply();
    expect(applyRes).toMatchObject({ ok: true });
    expect(h.calls.some(({ method }) => method === "apply_config")).toBe(true);
  });
});

describe("LuCI configuration round trips", () => {
  it("adds, edits and deletes a node across page reloads and maps ID references to the saved tag", async () => {
    const h = luci(profile());
    const initial = await h.view("nodes");
    await click(initial.root, "按模板新建节点");
    await enterNode(h, "new-node", nodeBody);

    const added = await h.view("nodes");
    expect(added.view).not.toBe(initial.view);
    expect(row(added.root, "new-node").textContent).toContain("proxy.example");
    const id = (await h.api.loadActiveProfile()).profile.nodes.find((n) => n.tag === "new-node")!.id;
    const routing = await h.view("routing");
    await addRoute(h, routing.root, id, "domain:proxy-target.example");
    const groups = await h.view("groups");
    find(groups.root, "select", (el) => el.elements("option").some((option) => option.value === id)).value = id;
    await click(groups.root, "保存出口设置");

    // Reload before editing, since the profile also changed on the groups and routing pages.
    const current = await h.view("nodes");
    await click(row(current.root, "new-node"), "编辑");
    const edited = nodeBody.replace("proxy.example", "edited-proxy.example");
    await enterNode(h, "renamed-node", edited);

    const renamed = await h.view("nodes");
    expect(row(renamed.root, "renamed-node").textContent).toContain("edited-proxy.example");
    const saved = (await h.api.loadActiveProfile()).profile;
    expect(saved.nodes.find((n) => n.tag === "renamed-node")).toMatchObject({ id, body: edited });
    expect(saved.settings.rules[0].outbound).toBe(id);
    expect(saved.settings.proxyDefault).toBe(id);
    expect(await renamed.view.handleSaveApply()).toMatchObject({ ok: true });
    const { config } = applied(h);
    expect(config.outbounds).toContainEqual(expect.objectContaining({ tag: "renamed-node", server: "edited-proxy.example" }));
    expect(config.outbounds).toContainEqual(expect.objectContaining({ tag: "proxy", default: "renamed-node" }));
    expect(config.route.rules).toContainEqual(expect.objectContaining({
      domain: ["proxy-target.example"], action: "route", outbound: "renamed-node",
    }));

    await click(row(renamed.root, "renamed-node"), "删除");
    const removed = await h.view("nodes");
    expect(removed.root.textContent).not.toContain("renamed-node");
    expect((await h.api.loadActiveProfile()).profile.nodes.map((n) => n.id)).not.toContain(id);
    expect(await removed.view.handleSaveApply()).toMatchObject({ ok: true });
    const afterDelete = applied(h).config;
    expect(afterDelete.outbounds).toContainEqual(expect.objectContaining({ tag: "proxy", default: "auto" }));
    expect(afterDelete.route.rules).not.toContainEqual(expect.objectContaining({ outbound: "renamed-node" }));
  });

  it.each([
    { tag: "dns-in", body: nodeBody, error: /系统保留/ },
    { tag: "existing", body: nodeBody, error: /已被其他节点/ },
    { tag: "new-node", body: "{ invalid", error: /JSON/ },
  ])("does not send an invalid node ($tag) to the save RPC", async ({ tag, body, error }) => {
    const h = luci(profile());
    await click((await h.view("nodes")).root, "按模板新建节点");
    await enterNode(h, tag, body);
    expect(h.modal().textContent).toMatch(error);
    expect(h.calls.some(({ method }) => method === "save_profile")).toBe(false);
  });

  it("saves direct DNS, remote DNS, split DNS and hijack settings together and reads them before generating", async () => {
    const h = luci(profile());
    const initial = await h.view("settings");
    await click(initial.root, "新增 DNS 规则");
    const modal = h.modal();
    find(modal, "select").value = "remote";
    find(modal, "textarea", (el) => String(el.attrs.placeholder).includes("每行一个域名")).value = "domain:split.example";
    await click(modal, "保存");
    initial.form!.edit("dns.local_type", "https");
    initial.form!.edit("dns.local_server", "9.9.9.9");
    initial.form!.edit("dns.local_port", "8443");
    initial.form!.edit("dns.local_server_name", "dns.quad9.net");
    initial.form!.edit("dns.local_path", "/mvp-query");
    initial.form!.edit("dns.hijack", "0");
    initial.form!.edit("dns._remote_provider", "cloudflare");
    initial.form!.edit("dns._remote_protocol", "https");
    await initial.view.handleSave();
    expect(h.calls.some(({ method }) => method === "apply_config")).toBe(false);

    const reopened = await h.view("settings");
    expect(reopened.view).not.toBe(initial.view);
    expect(reopened.form!.value("dns.local_server")).toBe("9.9.9.9");
    expect(reopened.form!.value("dns.local_port")).toBe("8443");
    expect(reopened.form!.value("dns._remote_provider")).toBe("cloudflare");
    expect(reopened.form!.value("dns._remote_protocol")).toBe("https");
    expect(row(reopened.root, "domain:split.example").textContent).toContain("remote");
    expect(await reopened.view.handleSaveApply()).toMatchObject({ ok: true });
    const methods = h.calls.map(({ method }) => method);
    expect(methods.indexOf("commit")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("commit")).toBeLessThan(methods.indexOf("apply_config"));
    const { config } = applied(h);
    expect(config.dns.servers).toContainEqual(expect.objectContaining({
      tag: "local", type: "https", server: "9.9.9.9", server_port: 8443, path: "/mvp-query",
      tls: { enabled: true, server_name: "dns.quad9.net" },
    }));
    expect(config.dns.servers).toContainEqual(expect.objectContaining({
      tag: "remote", type: "https", server: "1.1.1.1", server_port: 443, detour: "proxy",
    }));
    expect(walk(config.dns.rules, { domain: "split.example", mode: "GFWList", qtype: "A" }).final).toBe("route:remote");
    expect(config.inbounds).toContainEqual(expect.objectContaining({ tag: "tun-in", dns_mode: "disabled" }));
    expect(config.route.rules.filter((r: Rule) => r.action === "hijack-dns")).toEqual([
      { inbound: "dns-in", action: "hijack-dns" },
    ]);
  });

  it("persists route order, direct and proxy lists, and sends matching rule-set paths and manifest", async () => {
    const h = luci(profile());
    const initial = await h.view("routing");
    await addRoute(h, initial.root, "proxy", "domain:overlap.example", "geosite-netflix");
    await addRoute(h, initial.root, "direct", "domain:overlap.example\n203.0.113.7");
    await click(row(initial.root, "direct（直连）"), "↑");
    find(initial.root, "textarea", (el) => String(el.attrs.placeholder).includes("Global 模式外始终直连")).value = "domain:always-direct.example";
    find(initial.root, "textarea", (el) => String(el.attrs.placeholder).includes("始终走代理出口")).value = "domain:always-proxy.example";
    await initial.view.handleSave();

    const reopened = await h.view("routing");
    expect(reopened.view).not.toBe(initial.view);
    expect(row(reopened.root, "direct（直连）").elements("td")[0].textContent).toBe("1");
    expect(reopened.root.elements("textarea").map((el) => el.value)).toEqual(expect.arrayContaining([
      "domain:always-direct.example", "domain:always-proxy.example",
    ]));
    expect(await reopened.view.handleSaveApply()).toMatchObject({ ok: true });
    const { config, manifest } = applied(h);
    expect(config.route.final).toBe("proxy");
    expect(config.route.rules.filter((r: Rule) => r.domain?.includes("overlap.example")).map((r: Rule) => r.outbound))
      .toEqual(["direct", "proxy"]);
    const entry = manifest.find((r: { tag: string }) => r.tag === "geosite-netflix");
    expect(entry).toMatchObject({ format: "binary", path: "/etc/sing-box/rule-sets/geosite-netflix.srs" });
    expect(config.route.rule_set).toContainEqual(expect.objectContaining({ type: "local", tag: entry.tag, path: entry.path }));
    expect(config.route.rules).toContainEqual(expect.objectContaining({ rule_set: entry.tag, action: "route", outbound: "proxy" }));
  });

  it("prevents applying when a profile save fails and exposes the failed step", async () => {
    const h = luci(profile());
    h.override("save_profile", () => ({ ok: false, error: "profile store write failed" }));
    const { view } = await h.view("nodes");
    await expect(view.handleSaveApply()).rejects.toThrow("profile store write failed");
    expect(h.notifications).toContainEqual({ message: "保存失败 profile store write failed", level: "danger" });
    expect(h.calls.some(({ method }) => method === "apply_config")).toBe(false);
  });

  it("propagates a rejected read and does not apply a configuration", async () => {
    const h = luci(profile());
    h.override("get_profile", async () => { throw new Error("profile read request failed"); });
    await expect(h.view("nodes")).rejects.toThrow("profile read request failed");
    expect(h.calls.some(({ method }) => method === "apply_config")).toBe(false);
  });

  it("keeps the first-run template available for a genuinely missing profile", async () => {
    const h = luci(profile());
    h.profiles.delete(h.active);
    const page = await h.view("nodes");
    expect(page.root.textContent).toContain("节点管理（共 2 个）");
    expect(h.calls.map(({ method }) => method)).not.toContain("save_profile");
  });

  it("saves setting changes without applying when service is disabled", async () => {
    const h = luci(profile(), { enabled: "0" });
    const { view, form } = await h.view("settings");
    form!.edit("dns.local_server", "9.9.9.9");
    expect(await view.handleSaveApply()).toMatchObject({ ok: true, skipped_start: true });
    expect((await h.view("settings")).form!.value("dns.local_server")).toBe("9.9.9.9");
    expect(h.calls.map(({ method }) => method)).not.toContain("apply_config");
  });

  it("does not send an adapter-invalid or loopback DNS configuration to apply_config", async () => {
    const h = luci(profile(), { dns: { local_server: "192.168.21.1" } });
    const result = await (await h.view("settings")).view.handleSaveApply();
    expect(result).toMatchObject({ ok: false });
    expect(result?.validationErrors?.map((issue) => issue.message).join(" ")).toMatch(/路由器自身地址/);
    expect(h.calls.map(({ method }) => method)).not.toContain("apply_config");
  });

  it("preserves the backend check failure and does not report application success", async () => {
    const h = luci(profile());
    h.override("apply_config", () => ({ ok: false, rolled_back: false, output: "sing-box check: rejected candidate" }));
    const reply = await (await h.view("nodes")).view.handleSaveApply();
    expect(reply).toMatchObject({ ok: false, output: "sing-box check: rejected candidate" });
    expect(h.notifications).toContainEqual({
      message: "应用配置失败 sing-box check: rejected candidate", level: "danger",
    });
    expect(h.notifications.some(({ message }) => message.includes("成功应用"))).toBe(false);
    expect(h.calls.map(({ method }) => method)).not.toContain("service_action");
  });

  it("distinguishes a backend rollback from success and reads the restored service state", async () => {
    const h = luci(profile());
    h.override("apply_config", () => {
      Object.assign(h.status, { running: true, tun_up: true, dnsmasq_taken_over: true });
      return { ok: false, rolled_back: true, output: "restored last configuration" };
    });
    const result = await (await h.view("nodes")).view.handleSaveApply();
    expect(result).toMatchObject({ ok: false, rolled_back: true });
    expect(h.notifications).toContainEqual({ message: "启动失败已自动回滚 restored last configuration", level: "warning" });
    expect(await h.api.status()).toMatchObject({ running: true, tun_up: true, dnsmasq_taken_over: true });
  });
});

describe("MVP regression cases", () => {
  it.each(["", "192.0.2.0/24"])("saves with optional ECS blank (previously %j)", async (previous) => {
    const initial = profile();
    initial.settings.clientSubnet = previous;
    const h = luci(initial);
    const { view, form } = await h.view("settings");
    form!.edit("dns._client_subnet", "");
    form!.edit("dns.local_server", "9.9.9.9");
    await view.handleSave();
    expect(h.committedOption("dns", "local_server")).toBe("9.9.9.9");
    expect((await h.api.loadActiveProfile()).profile.settings.clientSubnet).toBe("");
  });

  it("persists the active profile outside the LuCI session", async () => {
    const h = luci(profile());
    h.profiles.set("alternate", JSON.stringify(profile()));
    await h.api.switchActiveProfile("alternate");
    expect(h.committedOption("main", "active_profile")).toBe("alternate");
    expect(await h.api.loadActiveProfile()).toMatchObject({ name: "alternate" });
  });

  it.each([
    ["native commit rejects", (): never => { throw new Error("UCI write failed"); }],
    ["native commit returns an error code", (): number => 10],
    ["native commit leaves pending changes", (): number => 0],
  ] as const)("does not continue Save & Apply when %s", async (_scenario, result) => {
    const h = luci(profile());
    h.override("commit", result);
    const { view, form } = await h.view("settings");
    form!.edit("dns.local_server", "9.9.9.9");
    await expect(view.handleSaveApply()).rejects.toThrow(/UCI|提交/);
    expect(h.calls.map(({ method }) => method)).not.toContain("apply_config");
    expect(h.calls.map(({ method }) => method)).not.toContain("save_profile");
    expect(h.notifications.some(({ message }) => message.includes("成功应用"))).toBe(false);
  });

  it.each(["", "{ truncated", "{\"version\":2}"])("surfaces a corrupt stored profile without substituting a template: %s", async (raw) => {
    const h = luci(profile());
    h.profiles.set(h.active, raw);
    await expect(h.view("nodes").then(() => "page accepted a damaged profile")).rejects.toThrow(/Profile|配置方案|损坏|Corrupted/i);
    expect(h.calls.map(({ method }) => method)).not.toContain("apply_config");
    expect(h.profiles.get(h.active)).toBe(raw);
  });

  it("reports a failed stop when saving a disabled configuration", async () => {
    const h = luci(profile(), { enabled: "0" });
    h.status.running = true;
    h.status.dnsmasq_taken_over = true;
    h.override("service_action", () => ({ ok: false, output: "stop hook failed" }));
    const result = await (await h.view("settings")).view.handleSaveApply();
    expect(h.calls).toContainEqual({ method: "service_action", params: { action: "stop" } });
    expect(result).toMatchObject({ ok: false });
    expect(h.notifications).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/停止.*stop hook failed/) }));
    expect(h.calls.map(({ method }) => method)).not.toContain("apply_config");
  });

  it.each([
    { previous: "missing port", port: null },
    { previous: "old UDP default", port: "53" },
  ])("uses 853 when switching to DoT from $previous", async ({ port }) => {
    const dns: Record<string, string> = { local_type: "udp" };
    if (port !== null) dns.local_port = port;
    const h = luci(profile(), { dns });
    const { view, form } = await h.view("settings");
    form!.edit("dns.local_type", "tls");
    form!.edit("dns.local_server_name", "dns.alidns.com");
    await view.handleSave();
    await (await h.view("settings")).view.handleSaveApply();
    expect(applied(h).config.dns.servers).toContainEqual(expect.objectContaining({
      tag: "local", type: "tls", server_port: 853,
    }));
  });

  it.each(["local_port", "listen_port"])("rejects a malformed DNS port read from UCI: %s", async (field) => {
    const h = luci(profile(), { dns: { [field]: field === "listen_port" ? "5335oops" : "53oops" } });
    const result = await (await h.view("settings")).view.handleSaveApply();
    expect(result).toMatchObject({ ok: false });
    expect(result?.validationErrors?.map((issue) => issue.message).join(" ")).toMatch(/端口/);
    expect(h.calls.map(({ method }) => method)).not.toContain("apply_config");
  });

  it("protects local DNS names before explicit local and remote DNS routing rules", async () => {
    const p = profile();
    p.settings.dnsRules = [
      newDnsRule({ server: "remote", lines: ["domain:nas.lan", "domain:printer.home.arpa", "domain:split.example"] }),
      newDnsRule({ server: "local", lines: ["domain:router.lan", "."] }),
    ];
    const h = luci(p);
    await (await h.view("settings")).view.handleSaveApply();
    const { config } = applied(h);
    function resolve(domain: string) {
      return walk(config.dns.rules, { domain, mode: "GFWList", qtype: "A", publicV6Iface: true }).final;
    }
    expect(resolve("split.example")).toBe("route:remote");
    for (const domain of ["nas.lan", "printer.home.arpa", "router.lan", "nas"]) {
      expect(resolve(domain), domain).toBe("predefined:NXDOMAIN");
    }
  });

  it("updates a tag-based node detour when a referenced node is renamed", async () => {
    const p = profile();
    p.nodes.push(newNode({ id: "detoured-node", tag: "detoured", body: JSON.stringify({
      ...JSON.parse(nodeBody), detour: "existing",
    }) }));
    p.groups.push(newGroup({ id: "node-group", tag: "chosen-group", members: ["existing-node"], defaultMember: "existing-node" }));
    const h = luci(p);
    await click(row((await h.view("nodes")).root, "existing"), "编辑");
    await enterNode(h, "renamed-node", nodeBody);
    const reopened = await h.view("nodes");
    expect(await reopened.view.handleSaveApply()).toMatchObject({ ok: true });
    expect(applied(h).config.outbounds).toEqual(expect.arrayContaining([
      expect.objectContaining({ tag: "detoured", detour: "renamed-node" }),
      expect.objectContaining({ tag: "chosen-group", outbounds: ["renamed-node"], default: "renamed-node" }),
    ]));
  });

  it("does not delete a node still needed by another node's detour", async () => {
    const p = profile();
    p.nodes.push(newNode({ tag: "detoured", body: JSON.stringify({ ...JSON.parse(nodeBody), detour: "existing" }) }));
    const h = luci(p);
    const page = await h.view("nodes");
    await click(row(page.root, "existing"), "删除");
    expect((await h.api.loadActiveProfile()).profile.nodes.map((n) => n.tag)).toContain("existing");
    expect(page.root.textContent).toMatch(/detoured.*detour|detour.*detoured/);
  });

  it("places explicit proxy rules before the Direct mode fallback", async () => {
    const p = profile();
    p.settings.defaultMode = "Direct";
    const h = luci(p);
    await addRoute(h, (await h.view("routing")).root, "proxy", "domain:proxy-first.example");
    await (await h.view("routing")).view.handleSaveApply();
    const { config } = applied(h);
    const rules: Rule[] = config.route.rules;
    const explicit = rules.findIndex((r) => r.domain?.includes("proxy-first.example") && r.outbound === "proxy");
    const fallback = rules.findIndex((r) => r.clash_mode === "Direct" && r.outbound === "direct");
    expect(explicit).toBeGreaterThanOrEqual(0);
    expect(fallback).toBeGreaterThan(explicit);
    expect(walk(config.dns.rules, {
      domain: "proxy-first.example", mode: "Direct", qtype: "A", ruleDomain: true,
    }).final).toBe("route:remote");
  });

  it("round trips Reject in the route editor and emits native ordered actions", async () => {
    const h = luci(profile());
    const { root } = await h.view("routing");
    await addRoute(h, root, "proxy", "domain:overlap.example");
    await addRoute(h, root, "direct", "domain:overlap.example");
    await addRoute(h, root, "reject", "domain:overlap.example\n203.0.113.7\n198.51.100.32/27");
    const restored = await h.view("routing");
    expect((await h.api.loadActiveProfile()).profile.settings.rules.map((r) => r.outbound)).toEqual(["proxy", "direct", "reject"]);
    expect(await restored.view.handleSaveApply()).toMatchObject({ ok: true });
    const { config } = applied(h);
    const matching = config.route.rules.filter((r: Rule) => r.domain?.includes("overlap.example"));
    expect(matching.map((r: Rule) => [r.action, r.outbound])).toEqual([
      ["route", "proxy"], ["route", "direct"], ["reject", undefined],
    ]);
    expect(matching[2].ip_cidr).toEqual(["203.0.113.7/32", "198.51.100.32/27"]);
    expect(config.outbounds).not.toContainEqual(expect.objectContaining({ tag: "reject" }));
  });
});

function tailnetModalControls(modal: Element) {
  const checkbox = (labelText: string) =>
    find(modal, "label", (el) => el.textContent.includes(labelText)).elements("input")[0];
  return {
    tag: modal.elements("input").filter((el) => el.attrs.type === "text")[0],
    hostname: find(modal, "input", (el) => String(el.attrs.placeholder).includes("openwrt-router")),
    stateDir: find(modal, "input", (el) => String(el.attrs.placeholder).includes("tailscale-home")),
    serverMode: find(modal, "select"),
    controlUrl: find(modal, "input", (el) => String(el.attrs.placeholder).includes("headscale.example.com")),
    authKey: find(modal, "input", (el) => el.attrs.type === "password"),
    magicDns: checkbox("启用 MagicDNS"),
    acceptDefaultResolvers: checkbox("使用 Tailnet 默认 DNS"),
    acceptRoutes: checkbox("接收子网路由"),
    asProxy: checkbox("加入 proxy 代理选择器"),
    advertiseExitNode: checkbox("本机作为出口节点通告"),
    allowLanAccess: checkbox("出口节点允许访问局域网"),
    ephemeral: checkbox("临时节点模式"),
    exitNode: find(modal, "input", (el) => String(el.attrs.placeholder).includes("出口节点名称")),
    advertiseRoutes: find(modal, "input", (el) => String(el.attrs.placeholder).includes("向 Tailnet 通告的本地网段")),
    advertiseTags: find(modal, "input", (el) => String(el.attrs.placeholder).includes("ACL 标签")),
    extraRoutes: find(modal, "textarea"),
  };
}

describe("LuCI Tailscale configuration", () => {
  it("round trips official and Headscale Tailnets, preserves imported native fields, and integrates with DNS, routes, and proxy groups", async () => {
    const p = profile();
    p.settings.tailnets = [
      newTailnet({
        id: "ts-official-id",
        tag: "official-ts",
        magicDns: false,
        acceptDefaultResolvers: false,
        asProxy: false,
        exitNode: "",
        routes: [],
        endpoint: JSON.stringify({
          state_directory: "tailscale-official",
          hostname: "imported-router",
          accept_routes: true,
          exit_node: "stale-json-exit",
          listen_port: 41641,
          udp_timeout: "5m",
        }),
      }),
    ];
    const h = luci(p);

    // Switch imported official Tailnet to Headscale and verify reload preserves extra native fields.
    const initial = await h.view("tailscale");
    await click(row(initial.root, "official-ts"), "编辑");
    let fields = tailnetModalControls(h.modal());
    expect(fields.serverMode.value).toBe("official");
    fields.serverMode.value = "custom";
    fields.serverMode.dispatch("change");
    fields.controlUrl.value = "https://headscale.example.test";
    await click(h.modal(), "保存 Tailnet");

    const asHeadscale = await h.view("tailscale");
    expect(row(asHeadscale.root, "official-ts").textContent).toContain("https://headscale.example.test");

    // Switch back to Official Tailscale with full routing/exit-node/proxy fields and synthetic auth_key.
    await click(row(asHeadscale.root, "official-ts"), "编辑");
    fields = tailnetModalControls(h.modal());
    expect(fields.serverMode.value).toBe("custom");
    fields.serverMode.value = "official";
    fields.serverMode.dispatch("change");
    fields.hostname.value = "router-official";
    fields.stateDir.value = "tailscale-official";
    fields.authKey.value = "tskey-auth-synthetic-official-01";
    fields.magicDns.checked = true;
    fields.acceptDefaultResolvers.checked = true;
    fields.acceptRoutes.checked = true;
    fields.asProxy.checked = true;
    fields.advertiseExitNode.checked = false;
    fields.allowLanAccess.checked = true;
    fields.ephemeral.checked = false;
    fields.exitNode.value = "office-gw";
    fields.advertiseRoutes.value = "192.168.21.0/24, 2001:db8:21::/64";
    fields.advertiseTags.value = "tag:router, tag:openwrt";
    fields.extraRoutes.value = "corp.internal\n10.42.0.0/16";
    await click(h.modal(), "保存 Tailnet");

    // Add a second Tailnet targeting Headscale with a distinct state_directory, advertise_exit_node, and accept_routes disabled.
    await click(asHeadscale.root, "新增 Tailnet");
    fields = tailnetModalControls(h.modal());
    fields.tag.value = "hs-lab";
    fields.hostname.value = "router-hs";
    fields.stateDir.value = "tailscale-hs-lab";
    fields.serverMode.value = "custom";
    fields.serverMode.dispatch("change");
    fields.controlUrl.value = "https://headscale.example.test";
    fields.authKey.value = "tskey-auth-synthetic-headscale-02";
    fields.magicDns.checked = true;
    fields.acceptDefaultResolvers.checked = false;
    fields.acceptRoutes.checked = false;
    fields.asProxy.checked = false;
    fields.advertiseExitNode.checked = true;
    fields.ephemeral.checked = true;
    fields.extraRoutes.value = "10.99.0.0/16";
    await click(h.modal(), "保存 Tailnet");

    const reloaded = await h.view("tailscale");
    expect(row(reloaded.root, "official-ts").textContent).toContain("官方 Tailscale");
    expect(row(reloaded.root, "official-ts").textContent).toContain("office-gw");
    expect(row(reloaded.root, "official-ts").textContent).toContain("tailscale-official");
    expect(row(reloaded.root, "hs-lab").textContent).toContain("https://headscale.example.test");
    expect(row(reloaded.root, "hs-lab").textContent).toContain("tailscale-hs-lab");

    const savedTailnets = (await h.api.loadActiveProfile()).profile.settings.tailnets;
    const savedOfficialEp = JSON.parse(savedTailnets.find((t) => t.tag === "official-ts")!.endpoint);
    expect(savedOfficialEp).toMatchObject({
      state_directory: "tailscale-official",
      hostname: "router-official",
      auth_key: "tskey-auth-synthetic-official-01",
      accept_routes: true,
      advertise_routes: ["192.168.21.0/24", "2001:db8:21::/64"],
      advertise_tags: ["tag:router", "tag:openwrt"],
      exit_node_allow_lan_access: true,
      listen_port: 41641,
      udp_timeout: "5m",
    });
    expect(savedOfficialEp.advertise_exit_node).toBeUndefined();
    expect(savedOfficialEp.control_url).toBeUndefined();
    expect(savedOfficialEp.exit_node).toBeUndefined();

    // Add official-ts to a custom proxy group and set it as default in proxy selector.
    const groupsPage = await h.view("groups");
    await click(groupsPage.root, "新增代理组");
    const groupModal = h.modal();
    find(groupModal, "input", (el) => el.attrs.type === "text").value = "ts-group";
    const tsMemberChk = find(groupModal, "label", (el) => el.textContent.includes("[Tailnet] official-ts")).elements("input")[0];
    tsMemberChk.checked = true;
    tsMemberChk.dispatch("change");
    await click(groupModal, "保存代理组");

    const groupsReloaded = await h.view("groups");
    const proxyDefaultSel = find(groupsReloaded.root, "select", (el) =>
      el.elements("option").some((opt) => opt.value === "ts-official-id"));
    expect(proxyDefaultSel.elements("option").map((opt) => opt.textContent)).not.toContain("[tailnet] hs-lab");
    proxyDefaultSel.value = "ts-official-id";
    await click(groupsReloaded.root, "保存出口设置");

    // Add a custom DNS rule routed to official-ts MagicDNS.
    const settingsPage = await h.view("settings");
    await click(settingsPage.root, "新增 DNS 规则");
    const dnsModal = h.modal();
    const [srvSel, tsSel] = dnsModal.elements("select");
    srvSel.value = "tailnet";
    srvSel.dispatch("change");
    tsSel.value = "ts-official-id";
    find(dnsModal, "textarea", (el) => String(el.attrs.placeholder).includes("每行一个域名")).value = "domain:intranet.example";
    await click(dnsModal, "保存");

    const finalTailscale = await h.view("tailscale");
    const preview = (await h.api.buildCurrentConfig()).result.config;
    expect(await finalTailscale.view.handleSaveApply()).toMatchObject({ ok: true });
    const { config } = applied(h);
    expect(config).toEqual(preview);

    expect(config.endpoints).toEqual([
      expect.objectContaining({
        type: "tailscale",
        tag: "official-ts",
        state_directory: "/etc/sing-box/tailscale/tailscale-official",
        hostname: "router-official",
        auth_key: "tskey-auth-synthetic-official-01",
        accept_routes: true,
        advertise_routes: ["192.168.21.0/24", "2001:db8:21::/64"],
        advertise_tags: ["tag:router", "tag:openwrt"],
        exit_node_allow_lan_access: true,
        exit_node: "office-gw",
        listen_port: 41641,
        udp_timeout: "5m",
      }),
      expect.objectContaining({
        type: "tailscale",
        tag: "hs-lab",
        control_url: "https://headscale.example.test",
        state_directory: "/etc/sing-box/tailscale/tailscale-hs-lab",
        hostname: "router-hs",
        auth_key: "tskey-auth-synthetic-headscale-02",
        accept_routes: false,
        advertise_exit_node: true,
        ephemeral: true,
      }),
    ]);
    expect(config.endpoints[0].control_url).toBeUndefined();
    expect(config.endpoints[1].exit_node).toBeUndefined();

    expect(config.dns.servers).toEqual(expect.arrayContaining([
      {
        type: "tailscale",
        tag: "official-ts-dns",
        endpoint: "official-ts",
        accept_default_resolvers: true,
        accept_search_domain: true,
      },
      {
        type: "tailscale",
        tag: "hs-lab-dns",
        endpoint: "hs-lab",
        accept_search_domain: true,
      },
    ]));
    expect(config.dns.rules).toEqual(expect.arrayContaining([
      { preferred_by: "official-ts-dns", action: "route", server: "official-ts-dns" },
      { preferred_by: "hs-lab-dns", action: "route", server: "hs-lab-dns" },
    ]));
    expect(walk(config.dns.rules, { domain: "intranet.example", mode: "GFWList", qtype: "A" }).final).toBe("route:official-ts-dns");

    expect(config.route.rules).toEqual(expect.arrayContaining([
      { preferred_by: "official-ts", action: "route", outbound: "official-ts" },
      { preferred_by: "hs-lab", action: "route", outbound: "hs-lab" },
      { domain_suffix: ["corp.internal"], ip_cidr: ["10.42.0.0/16"], action: "route", outbound: "official-ts" },
      { ip_cidr: ["10.99.0.0/16"], action: "route", outbound: "hs-lab" },
    ]));

    const proxyOut = config.outbounds.find((o: { tag: string }) => o.tag === "proxy");
    expect(proxyOut.outbounds).toEqual(expect.arrayContaining(["ts-group", "official-ts"]));
    expect(proxyOut.outbounds).not.toContain("hs-lab");
    expect(proxyOut.default).toBe("official-ts");
    expect(config.outbounds).toContainEqual(expect.objectContaining({
      type: "selector",
      tag: "ts-group",
      outbounds: ["official-ts"],
    }));
  });

  it.each([
    {
      name: "invalid advertise_routes IPv4 without prefix",
      setup: (f: ReturnType<typeof tailnetModalControls>) => { f.advertiseRoutes.value = "192.168.6.1"; },
      error: /CIDR/,
    },
    {
      name: "invalid advertise_routes IPv6 prefix",
      setup: (f: ReturnType<typeof tailnetModalControls>) => { f.advertiseRoutes.value = "2001:db8::/129"; },
      error: /CIDR/,
    },
    {
      name: "invalid custom control_url scheme",
      setup: (f: ReturnType<typeof tailnetModalControls>) => {
        f.serverMode.value = "custom";
        f.serverMode.dispatch("change");
        f.controlUrl.value = "headscale.example.test";
      },
      error: /http:\/\/ 或 https:\/\//,
    },
    {
      name: "state_directory parent traversal",
      setup: (f: ReturnType<typeof tailnetModalControls>) => { f.stateDir.value = "../outside"; },
      error: /\.\./,
    },
    {
      name: "invalid extra route URL",
      setup: (f: ReturnType<typeof tailnetModalControls>) => { f.extraRoutes.value = "https://bad.example/path"; },
      error: /额外路由/,
    },
    {
      name: "reserved tag dns-in",
      setup: (f: ReturnType<typeof tailnetModalControls>) => { f.tag.value = "dns-in"; },
      error: /系统保留/,
    },
    {
      name: "duplicate tag against existing node",
      setup: (f: ReturnType<typeof tailnetModalControls>) => { f.tag.value = "existing"; },
      error: /已被其他/,
    },
  ])("rejects $name in modal before saving", async ({ setup, error }) => {
    const h = luci(profile());
    const { root } = await h.view("tailscale");
    await click(root, "新增 Tailnet");
    setup(tailnetModalControls(h.modal()));
    await click(h.modal(), "保存 Tailnet");
    expect(h.modal().textContent).toMatch(error);
    expect(h.calls.some(({ method }) => method === "save_profile" || method === "apply_config")).toBe(false);
  });

  it("blocks applying when two Tailnets have duplicate or post-normalization colliding state directories", async () => {
    const p = profile();
    p.settings.tailnets = [
      newTailnet({
        id: "ts-a",
        tag: "ts-a",
        endpoint: JSON.stringify({ state_directory: "tailscale-shared", hostname: "r-a", accept_routes: true }),
      }),
    ];
    const h = luci(p);
    const page = await h.view("tailscale");

    // 1. Identical raw state_directory
    await click(page.root, "新增 Tailnet");
    let fields = tailnetModalControls(h.modal());
    fields.tag.value = "ts-b";
    fields.stateDir.value = "tailscale-shared";
    await click(h.modal(), "保存 Tailnet");
    expect(page.root.textContent).toMatch(/state_directory.*重复/);

    const rawCollision = await page.view.handleSaveApply();
    expect(rawCollision).toMatchObject({ ok: false });
    expect(rawCollision?.validationErrors?.map((e) => e.message).join(" ")).toMatch(/state_directory.*重复/);
    expect(h.calls.some(({ method }) => method === "apply_config")).toBe(false);

    // 2. Relative vs absolute path colliding after normalization under tailscale_state_root
    await click(row(page.root, "ts-b"), "编辑");
    fields = tailnetModalControls(h.modal());
    fields.stateDir.value = "/etc/sing-box/tailscale/tailscale-shared";
    await click(h.modal(), "保存 Tailnet");

    const normCollision = await page.view.handleSaveApply();
    expect(normCollision).toMatchObject({ ok: false });
    expect(normCollision?.validationErrors?.map((e) => e.message).join(" ")).toMatch(/状态目录解析后.*冲突/);
    expect(h.calls.some(({ method }) => method === "apply_config")).toBe(false);
  });

  it("validates Tailnet references across DNS rules, <tag>-dns collisions, node detour, and device rules", async () => {
    // 1. Settings view rejects adding a tailnet DNS rule when no Tailnet exists.
    const emptyH = luci(profile());
    const emptySettings = await emptyH.view("settings");
    await click(emptySettings.root, "新增 DNS 规则");
    const [emptySrv] = emptyH.modal().elements("select");
    emptySrv.value = "tailnet";
    emptySrv.dispatch("change");
    find(emptyH.modal(), "textarea", (el) => String(el.attrs.placeholder).includes("每行一个域名")).value = "domain:corp.example";
    await click(emptyH.modal(), "保存");
    expect(emptyH.modal().textContent).toContain("添加至少一个 Tailnet");
    expect(emptyH.calls.some(({ method }) => method === "save_profile")).toBe(false);

    // 2. Colliding generated <tag>-dns name blocks apply_config.
    const pCollision = profile();
    pCollision.nodes.push(newNode({ id: "n-dns", tag: "home-dns", body: nodeBody }));
    pCollision.settings.tailnets = [
      newTailnet({
        id: "ts-home",
        tag: "home",
        magicDns: true,
        endpoint: JSON.stringify({ state_directory: "tailscale-home", hostname: "router", accept_routes: true }),
      }),
    ];
    const hCollision = luci(pCollision);
    const colRes = await (await hCollision.view("tailscale")).view.handleSaveApply();
    expect(colRes).toMatchObject({ ok: false });
    expect(colRes?.validationErrors?.map((e) => e.message).join(" ")).toMatch(/标签重复：home-dns/);
    expect(hCollision.calls.some(({ method }) => method === "apply_config")).toBe(false);

    // 3. Deleting a Tailnet still referenced by node detour and device rule blocks apply_config;
    //    dangling DNS rule warns and is omitted cleanly once hard errors are cleared.
    const pRef = profile();
    pRef.nodes.push(newNode({
      id: "detour-node",
      tag: "via-ts",
      body: JSON.stringify({ ...JSON.parse(nodeBody), detour: "office" }),
    }));
    pRef.settings.tailnets = [
      newTailnet({
        id: "ts-office",
        tag: "office",
        magicDns: true,
        acceptDefaultResolvers: true,
        endpoint: JSON.stringify({ state_directory: "tailscale-office", hostname: "router", accept_routes: true }),
      }),
    ];
    pRef.settings.dnsRules = [
      newDnsRule({ server: "tailnet", tailnet: "ts-office", lines: ["domain:intranet.example"] }),
    ];
    const hRef = luci(pRef);
    hRef.override("get_access_control", () => ({
      access_control: {
        mode: "all",
        clients: [],
        deviceRules: [
          { id: "dr-ts", name: "Workstation", clients: ["192.168.21.55"], outbound: "office", enabled: true },
        ],
      },
    }));

    // Valid before deletion
    const beforeDelete = await hRef.api.buildCurrentConfig();
    expect(beforeDelete.result.issues.filter((i) => i.level === "error")).toEqual([]);

    // Delete the Tailnet via UI
    const tsPage = await hRef.view("tailscale");
    await click(row(tsPage.root, "office"), "删除");
    const afterDelete = await tsPage.view.handleSaveApply();
    expect(afterDelete).toMatchObject({ ok: false });
    const errText = afterDelete?.validationErrors?.map((e) => e.message).join(" ") ?? "";
    expect(errText).toContain("detour 指向的「office」不存在");
    expect(errText).toContain("指定的出口「office」不存在");
    expect(hRef.calls.some(({ method }) => method === "apply_config")).toBe(false);

    // Once detour and device rule references are removed, dangling DNS rule only warns and config applies cleanly.
    const cleaned = (await hRef.api.loadActiveProfile()).profile;
    cleaned.nodes = cleaned.nodes.filter((n) => n.id !== "detour-node");
    hRef.profiles.set(hRef.active, JSON.stringify(cleaned));
    hRef.override("get_access_control", () => ({ access_control: { mode: "all", clients: [], deviceRules: [] } }));
    const builtAfterClean = await hRef.api.buildCurrentConfig();
    expect(builtAfterClean.result.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(builtAfterClean.result.issues.some((i) => i.level === "warning" && i.detail.includes("选择的 tailnet 已删除"))).toBe(true);
    const cleanedDns = builtAfterClean.result.config.dns as { servers: Record<string, unknown>[] };
    expect(cleanedDns.servers).not.toContainEqual(expect.objectContaining({ tag: "office-dns" }));
  });

  it("blocks setting both exit_node and advertise_exit_node in the Tailscale modal and during apply", async () => {
    const h = luci(profile());
    const page = await h.view("tailscale");
    await click(page.root, "新增 Tailnet");
    const modal = h.modal();
    const advExitLabel = find(modal, "label", (el) => el.textContent.includes("本机作为出口节点通告"));
    find(advExitLabel, "input").checked = true;
    find(modal, "input", (el) => String(el.attrs.placeholder).includes("出口节点名称")).value = "office-gw";
    await click(modal, "保存 Tailnet");
    expect(h.modal().textContent).toContain("exit_node");
    expect(h.modal().textContent).toContain("advertise_exit_node");
    expect(h.calls.some(({ method }) => method === "save_profile")).toBe(false);
  });
});

describe("LuCI overview generate-before-enable flow", () => {
  it("generates and writes config while disabled without starting sing-box, then enables and starts directly via the toggle", async () => {
    const h = luci(profile(), { enabled: "0", configExists: false });
    const { root } = await h.view("overview");

    const enableChk = find(root, "input", (el) => el.attrs.type === "checkbox");
    expect(enableChk.checked).toBe(false);
    expect(root.textContent).toContain("已停止（未生成配置）");
    expect(root.elements("button").map((b) => b.textContent)).toContain("生成配置");

    await click(root, "生成配置");
    expect(h.calls.some(({ method }) => method === "write_config")).toBe(true);
    expect(h.calls.some(({ method }) => method === "apply_config")).toBe(false);
    expect(h.calls.some(({ method }) => method === "service_action")).toBe(false);
    expect(h.committedOption("main", "enabled")).toBe("0");
    expect(h.status.config_exists).toBe(true);
    expect(root.textContent).toContain("已停止（配置已生成）");
    expect(root.textContent).toContain("配置已生成并通过核心校验");

    // Toggle "启用服务" ON -> config already exists, so it starts directly via service_action("start").
    enableChk.checked = true;
    await enableChk.dispatch("change");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(h.calls).toContainEqual({ method: "service_action", params: { action: "start" } });
    expect(h.calls.some(({ method }) => method === "apply_config")).toBe(false);
    expect(h.committedOption("main", "enabled")).toBe("1");
    expect(root.elements("button").map((b) => b.textContent)).toContain("生成并应用");

    // Toggle "启用服务" OFF -> stops cleanly.
    enableChk.checked = false;
    await enableChk.dispatch("change");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.calls).toContainEqual({ method: "service_action", params: { action: "stop" } });
    expect(h.committedOption("main", "enabled")).toBe("0");
    expect(root.elements("button").map((b) => b.textContent)).toContain("生成配置");
  });

  it("auto-generates and enables when clicking Start before config exists, and reverts enabled on apply failure", async () => {
    const h = luci(profile(), { enabled: "0", configExists: false });
    h.override("apply_config", () => ({ ok: false, output: "mock startup failure" }));
    const { root } = await h.view("overview");

    await click(root, "启动");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(h.calls.some(({ method }) => method === "apply_config")).toBe(true);
    expect(h.committedOption("main", "enabled")).toBe("0");
    expect(root.textContent).toContain("启用并启动失败");
    expect(root.textContent).toContain("mock startup failure");

    // Now let apply_config succeed and click Start again.
    h.override("apply_config", () => {
      h.status.config_exists = true;
      h.status.running = true;
      return { ok: true };
    });
    await click(root, "启动");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(h.committedOption("main", "enabled")).toBe("1");
    expect(root.textContent).toContain("配置已自动生成、校验通过并成功启动");
  });

  it("uses apply_config when generating from Overview while service is already enabled", async () => {
    const h = luci(profile(), { enabled: "1", configExists: true });
    const { root } = await h.view("overview");

    expect(root.elements("button").map((b) => b.textContent)).toContain("生成并应用");
    await click(root, "生成并应用");

    expect(h.calls.some(({ method }) => method === "apply_config")).toBe(true);
    expect(h.calls.some(({ method }) => method === "write_config")).toBe(false);
  });
});

describe("LuCI OpenWrt gateway settings round trip (P0/P1/P2)", () => {
  it("saves and applies bypass, port filter, QUIC block, IPv6 mode, mixed-in, interface binding, and backup DNS", async () => {
    const h = luci(profile());
    const initial = await h.view("settings");
    initial.form!.edit("main.boot_delay", "20");
    initial.form!.edit("dns.local_backup_server", "119.29.29.29");
    initial.form!.edit("dns.non_cn_strategy", "race");
    initial.form!.edit("tun.ipv6_mode", "ipv4_only");
    initial.form!.edit("tun.include_interface", "br-lan");
    initial.form!.edit("tun.default_interface", "pppoe-wan");
    initial.form!.edit("tun.route_exclude_cn", "1");
    initial.form!.edit("routing.port_mode", "common");
    initial.form!.edit("routing.udp_port_mode", "custom");
    initial.form!.edit("routing.custom_udp_ports", "443,3478-3481");
    initial.form!.edit("routing.block_quic", "1");
    initial.form!.edit("mixed.enabled", "1");
    initial.form!.edit("mixed.listen_port", "5331");
    await initial.view.handleSaveApply();

    const { config } = applied(h);
    expect(h.committedOption("main", "boot_delay")).toBe("20");
    expect(config.dns.servers).toContainEqual(expect.objectContaining({ tag: "local-backup", server: "119.29.29.29" }));
    expect(config.dns.rules.some((r: Record<string, unknown>) => r.tag === "local-answer")).toBe(true);
    expect(config.route.default_domain_resolver).toEqual({ server: "local", strategy: "ipv4_only" });
    expect(config.inbounds).toContainEqual(expect.objectContaining({
      tag: "tun-in",
      include_interface: ["br-lan"],
      route_exclude_address_set: ["geoip-cn"],
      strict_route: false,
    }));
    expect(config.inbounds).toContainEqual(expect.objectContaining({
      tag: "mixed-in",
      listen_port: 5331,
    }));
    expect(config.route.default_interface).toBe("pppoe-wan");
    expect(config.route.auto_detect_interface).toBeUndefined();
    expect(config.route.rules.some((r: Rule) => r.action === "bypass")).toBe(true);
    expect(JSON.stringify(config.route.rules)).toContain("3478:3481");
    expect(config.route.rules.some((r: Rule) => r.action === "reject" && JSON.stringify(r).includes('"udp"') && JSON.stringify(r).includes("443"))).toBe(true);
  });
});
