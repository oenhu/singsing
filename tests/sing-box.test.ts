import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";
import { blueprintProfile, defaultOpenWrtSettings, generateOpenWrtConfig, newDnsRule, newNode, newRule } from "../src/adapter/index";
import { serviceApplyFixture } from "./service-apply-harness";

const binary = process.env.SINGSING_SING_BOX ? resolve(process.env.SINGSING_SING_BOX) : "sing-box";
let validateSchema: ValidateFunction | undefined;

function run(...args: string[]) {
  return execFileSync(binary, args, {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"],
  });
}

function generatedConfig(dir: string, mode: "GFWList" | "Direct" = "Direct") {
  const p = blueprintProfile();
  const node = newNode({
    tag: "mvp-vless",
    body: JSON.stringify({
      type: "vless", server: "proxy.example", server_port: 443, uuid: "025792b0-4e8e-4b76-a999-4f4ac68be9c1",
    }),
  });
  p.nodes = [node];
  p.settings.clashController = "";
  p.settings.clashSecret = "";
  p.settings.defaultMode = mode;
  p.settings.proxyDefault = node.id;
  p.settings.dnsRules = [newDnsRule({ server: "remote", lines: ["domain:split.example"] })];
  p.settings.rules = [
    newRule({ outbound: "reject", lines: ["domain:blocked.example", "203.0.113.5", "198.51.100.0/24"] }),
    newRule({ outbound: "proxy", lines: ["domain:proxy.example"] }),
    newRule({ outbound: "direct", lines: ["domain:direct.example"], ruleSets: [{ source: "geosite-netflix", content: "domain" }] }),
  ];
  const settings = defaultOpenWrtSettings();
  settings.dns.localServer = "223.5.5.5";
  settings.dns.localType = "tls";
  settings.dns.localPort = 853;
  settings.dns.localServerName = "dns.alidns.com";
  settings.paths.cacheFile = join(dir, "cache.db");
  settings.paths.ruleSetDir = dir;
  const generated = generateOpenWrtConfig(p, settings);
  expect(generated.issues.filter(({ level }) => level === "error")).toEqual([]);
  return generated;
}

function writeLocalRuleSets(dir: string, manifest: ReturnType<typeof generatedConfig>["ruleSets"]) {
  for (const entry of manifest) {
    const file = join(dir, entry.tag + ".fixture.json");
    const rules = entry.tag.startsWith("geoip-") ? [{ ip_cidr: ["192.0.2.0/24"] }] : [{ domain: ["fixture.example"] }];
    writeFileSync(file, JSON.stringify({ version: 3, rules }));
    if (entry.format === "binary") run("rule-set", "compile", file, "-o", entry.path);
    else writeFileSync(entry.path, readFileSync(file));
  }
}

function writeCheckedJSON(file: string, value: unknown) {
  writeFileSync(file, JSON.stringify(value, null, 2));
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  validateSchema ??= new Ajv2020({ strict: false, allErrors: true }).compile(JSON.parse(run("schema")));
  expect(validateSchema(parsed), JSON.stringify(validateSchema.errors)).toBe(true);
}

describe.skipIf(process.env.SINGSING_VERIFY_CORE !== "1")("sing-box 1.14.4 binary", () => {
  it("runs the pinned core version", () => {
    expect(run("version").split("\n")[0]).toBe("sing-box version 1.14.4");
  });

  it.each(["Direct", "GFWList"] as const)("checks generated JSON, Schema and the real core in %s mode", (mode) => {
    const f = serviceApplyFixture();
    try {
      const { config, ruleSets } = generatedConfig(f.dir, mode);
      writeLocalRuleSets(f.dir, ruleSets);
      writeCheckedJSON(f.config, config);
      expect(() => run("check", "-c", f.config)).not.toThrow();
    } finally {
      f.dispose();
    }
  });

  it("fails a schema-valid candidate with an absent rule set without replacing working files", () => {
    const f = serviceApplyFixture();
    try {
      const { config, ruleSets } = generatedConfig(f.dir);
      writeLocalRuleSets(f.dir, ruleSets);
      writeCheckedJSON(f.config, config);
      run("check", "-c", f.config);
      writeFileSync(f.lastGood, readFileSync(f.config));
      writeFileSync(f.manifest, JSON.stringify(ruleSets));
      writeFileSync(f.running, "5335");
      const oldDNS = "no-resolv\nserver=127.0.0.1#5335\n";
      writeFileSync(f.dropIn, oldDNS);

      // A non-existent file is legal under the Schema. Only the actual core can reject it.
      const invalid = structuredClone(config) as { route: { rule_set: { tag: string; path?: string }[] } };
      const entry = invalid.route.rule_set.find(({ tag }) => tag === "gfwlist");
      expect(entry?.path).toBeDefined();
      entry!.path = join(f.dir, "intentionally-missing.srs");
      writeCheckedJSON(f.candidate, invalid);
      writeFileSync(f.candidateManifest, "[]");
      const files = [f.config, f.lastGood, f.manifest, f.dropIn, f.running];
      const before = files.map((file) => readFileSync(file));
      const result = f.apply({ MOCK_BOX: binary });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toMatch(/Config check failed:[\s\S]*intentionally-missing\.srs/);
      expect(files.map((file) => readFileSync(file))).toEqual(before);
    } finally {
      f.dispose();
    }
  });
});
