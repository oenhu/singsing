import { describe, expect, it } from "vitest";
import { blueprintProfile, newDnsRule, newGroup, newNode, newRule } from "../src/adapter/index";
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
  ip_cidr?: string[];
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
