import { readFileSync } from "node:fs";
import * as engine from "../src/adapter/index";
import type { Profile } from "../src/upstream/types";

type Handler = (event: { preventDefault(): void }) => unknown;
type Child = Element | string | number | boolean | null | undefined;
type Attributes = Record<string, string | number | boolean | Handler | null | undefined>;

/** The DOM operations used by the LuCI callbacks under test. */
export class Element {
  private children: Child[] = [];
  private handlers: Record<string, Handler> = {};
  style: Record<string, string> = {};
  value: string;
  checked: boolean;

  constructor(readonly tag: string, readonly attrs: Attributes = {}, children: Child | Child[] = []) {
    this.children = Array.isArray(children) ? children : [children];
    for (const [name, attr] of Object.entries(attrs)) {
      if (typeof attr === "function") this.handlers[name] = attr;
    }
    const options = tag === "select" ? this.elements("option") : [];
    const selected = options.find((option) => option.attrs.selected) ?? options[0];
    this.value = String(attrs.value ?? selected?.value ?? (tag === "textarea" ? this.textContent : ""));
    this.checked = Boolean(attrs.checked);
  }

  get textContent(): string {
    return this.children.map((child) => child instanceof Element ? child.textContent : child ?? "").join("");
  }

  set textContent(value: string) {
    this.children = [value];
  }

  set innerHTML(value: "") {
    if (value !== "") throw new Error("Only clearing innerHTML is supported");
    this.children = [];
  }

  appendChild(child: Element) {
    this.children.push(child);
  }

  elements(tag: string): Element[] {
    const descendants = this.children.flatMap((child) => child instanceof Element ? child.elements(tag) : []);
    return this.tag === tag ? [this, ...descendants] : descendants;
  }

  addEventListener(name: string, handler: Handler) {
    this.handlers[name] = handler;
  }

  dispatch(name: string) {
    if (name === "click" && this.attrs.disabled) throw new Error(`Control is disabled: ${this.textContent}`);
    return this.handlers[name]?.({ preventDefault() {} });
  }
}

function E(tag: string, attrs?: Attributes | Child | Child[], children?: Child | Child[]) {
  if (attrs && typeof attrs === "object" && !Array.isArray(attrs) && !(attrs instanceof Element)) {
    return new Element(tag, attrs, children);
  }
  return new Element(tag, {}, children ?? attrs);
}

export function find(root: Element, tag: string, predicate: (node: Element) => boolean = () => true) {
  const node = root.elements(tag).find(predicate);
  if (!node) throw new Error(`Missing LuCI control: ${tag}`);
  return node;
}

export async function click(root: Element, label: string) {
  const control = root.elements("button").find((node) => node.textContent === label);
  if (!control) throw new Error(`Missing LuCI button: ${label}`);
  await control.dispatch("click");
  // Several LuCI click handlers start an RPC without returning its promise.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

type Reply = Record<string, unknown>;
type UciValues = Record<string, Record<string, string | null>>;
type RpcResult = Reply | number;
type RpcHandler = (params: Reply) => RpcResult | Promise<RpcResult>;

export type ApplyReply = {
  ok: boolean;
  rolled_back?: boolean;
  skipped_start?: boolean;
  output?: string;
  validationErrors?: { message: string }[];
};

type Api = {
  buildCurrentConfig(): Promise<{ profile: Profile; settings: engine.OpenWrtSettings; result: engine.OpenWrtGenerateResult }>;
  generateAndApply(): Promise<ApplyReply>;
  applyWithNotify(): Promise<ApplyReply | undefined>;
  loadActiveProfile(): Promise<{ name: string; profile: Profile }>;
  status(): Promise<Reply>;
  switchActiveProfile(name: string): Promise<void>;
};

type View = {
  load(): Promise<unknown>;
  render(data: unknown): Element | Promise<Element>;
  handleSave(): Promise<unknown>;
  handleSaveApply(): Promise<ApplyReply | undefined>;
};

const resources = new URL("../htdocs/luci-static/resources/", import.meta.url);
const extend = { extend: (definition: unknown) => definition };

function loadModule<T>(name: string, globals: Record<string, unknown>): T {
  const source = readFileSync(new URL(name, resources), "utf8");
  return new Function(...Object.keys(globals), source)(...Object.values(globals)) as T;
}

export function luci(profile: Profile, options: { enabled?: string; dns?: Record<string, string> } = {}) {
  const active = "mvp-test";
  const profiles = new Map([[active, JSON.stringify(profile)]]);
  const calls: { method: string; params: Reply }[] = [];
  const notifications: { message: string; level: string }[] = [];
  const overrides: Record<string, RpcHandler> = {};
  let committed: UciValues = {
    main: { active_profile: active, enabled: options.enabled ?? "1" },
    dns: { local_server: "223.5.5.5", ...options.dns },
  };
  let staged: UciValues = {};
  let pending: UciValues = {};
  let cache: UciValues = {};
  const status = { running: false, tun_up: false, dnsmasq_taken_over: false, lan_ips: ["192.168.21.1"] };
  let access = { mode: "all", clients: [], deviceRules: [] };
  let modal: Element | undefined;

  const ui = {
    showModal: (_title: string, contents: Child[]) => { modal = E("div", {}, contents); },
    hideModal: () => { modal = undefined; },
    addNotification: (title: string | null, content: Element, level: string) => {
      notifications.push({ message: [title, content.textContent].filter(Boolean).join(" "), level });
    },
  };

  function setOption(values: UciValues, section: string, option: string, value: string | null) {
    (values[section] ??= {})[option] = value;
  }

  const uci = {
    load: async () => {
      cache = structuredClone(committed);
      for (const [section, entries] of Object.entries(staged)) {
        Object.assign(cache[section] ??= {}, entries);
      }
    },
    unload: () => { cache = {}; },
    get: (_package: string, section: string, option: string) => cache[section]?.[option],
    set: (_package: string, section: string, option: string, value: string) => {
      setOption(cache, section, option, value);
      setOption(pending, section, option, value);
    },
    unset: (_package: string, section: string, option: string) => {
      setOption(cache, section, option, null);
      setOption(pending, section, option, null);
    },
    save: async () => {
      for (const [section, entries] of Object.entries(pending)) {
        Object.assign(staged[section] ??= {}, entries);
      }
      pending = {};
    },
    changes: async () => Object.keys(staged).length ? { singsing: structuredClone(staged) } : {},
  };

  const handlers: Record<string, RpcHandler> = {
    get_profile({ name }) {
      const raw = profiles.get(String(name));
      if (raw === undefined) return { ok: true, exists: false, profile: null };
      try {
        return { ok: true, exists: true, profile: JSON.parse(raw) };
      } catch {
        return { ok: false, error: "Corrupted profile JSON" };
      }
    },
    save_profile({ name, profile }) {
      profiles.set(String(name), String(profile));
      return { ok: true };
    },
    // The standalone cursor cannot see deltas in the LuCI session's save directory.
    commit_uci: () => ({ ok: true }),
    commit({ config }) {
      if (config !== "singsing") throw new Error("Unexpected package commit");
      for (const [section, entries] of Object.entries(staged)) {
        Object.assign(committed[section] ??= {}, entries);
      }
      staged = {};
      return 0;
    },
    status: () => status,
    get_ruleset_urls: () => ({ urls: {} }),
    get_access_control: () => ({ access_control: access }),
    save_access_control: ({ data }) => {
      access = JSON.parse(String(data));
      return { ok: true };
    },
    get_lan_clients: () => ({ clients: [] }),
    apply_config: () => ({ ok: true }),
    service_action: () => ({ ok: true }),
  };

  const rpc = {
    declare({ object, method, params = [] }: { object: string; method: string; params?: string[] }) {
      return async (...values: unknown[]) => {
        const expectedObject = method === "commit" ? "uci" : "luci.singsing";
        if (object !== expectedObject) throw new Error(`Unexpected RPC object: ${object}`);
        const input = Object.fromEntries(params.map((name, i) => [name, values[i]]));
        calls.push({ method, params: input });
        const handler = overrides[method] ?? handlers[method];
        if (!handler) throw new Error(`Unexpected RPC method: ${method}`);
        return structuredClone(await handler(input));
      };
    },
  };

  type Option = {
    section: string;
    name: string;
    default?: string;
    rmempty?: boolean;
    cfgvalue?(section: string): string;
    formvalue(): string | null | undefined;
    write?(section: string, value: string): void;
    remove?(section: string): void;
    value(): void;
    depends(): void;
  };

  // Map.save models changed fields only. The production callbacks still decide which store gets each field.
  class FormMap {
    private options = new Map<string, Option>();
    private edits = new Map<Option, string>();

    section(_kind: unknown, section: string) {
      const option = (_type: unknown, name: string) => {
        const entry: Option = {
          section, name, value() {}, depends() {},
          formvalue: () => this.edits.get(entry) ?? uci.get("singsing", section, name),
        };
        this.options.set(`${section}.${name}`, entry);
        return entry;
      };
      return { option, tab() {}, taboption: (_tab: string, type: unknown, name: string) => option(type, name) };
    }

    edit(key: string, value: string) {
      const option = this.options.get(key);
      if (!option) throw new Error(`Unknown LuCI form option: ${key}`);
      this.edits.set(option, value);
    }

    value(key: string) {
      const option = this.options.get(key);
      if (!option) throw new Error(`Unknown LuCI form option: ${key}`);
      return (option.cfgvalue?.(option.section) ?? uci.get("singsing", option.section, option.name)) ?? option.default;
    }

    async save() {
      for (const [option, value] of this.edits) {
        if (value === "") {
          if (option.rmempty === false)
            throw new Error(`Missing required field: ${option.name}`);
          if (option.remove) option.remove(option.section);
          else uci.unset("singsing", option.section, option.name);
        } else if (option.write) {
          option.write(option.section, value);
        } else {
          uci.set("singsing", option.section, option.name, value);
        }
      }
      this.edits.clear();
      await uci.save();
    }

    async render() { return E("div"); }
  }

  const window = { SingboxConfgen: engine, confirm: () => true };
  const api = loadModule<Api>("singsing/api.js", { baseclass: extend, rpc, uci, ui, window, E });

  return {
    api, calls, notifications, active, profiles, status,
    committedOption(section: string, option: string) {
      return committed[section]?.[option];
    },
    override(method: string, handler: RpcHandler) { overrides[method] = handler; },
    modal() {
      if (!modal) throw new Error("No open LuCI modal");
      return modal;
    },
    async view(name: "nodes" | "settings" | "routing" | "groups") {
      const view = loadModule<View & { _map?: FormMap }>(`view/singsing/${name}.js`, {
        view: extend, api, form: { Map: FormMap }, uci, ui, window, E,
      });
      const root = await view.render(await view.load());
      return { view, root, form: view._map };
    },
  };
}
