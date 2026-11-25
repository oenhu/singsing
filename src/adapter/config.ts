import { generateConfig } from "../upstream/generate";
import type { Profile } from "../upstream/types";
import { adaptAccessControl } from "./access";
import { adaptDns } from "./dns";
import { adaptRuleSets } from "./rulesets";
import { adaptTun } from "./tun";
import type { OpenWrtGenerateResult, OpenWrtSettings } from "./types";
import { validateOpenWrt } from "./validation";

type Json = Record<string, unknown>;

function adaptPathsAndRuntime(config: Json, settings: OpenWrtSettings): void {
  // Log level
  const log = (config.log as Json) ?? {};
  log.level = settings.logLevel;
  log.timestamp = true;
  config.log = log;

  // Cache file path (defaults to /tmp/singsing/cache.db to protect router flash)
  const experimental = (config.experimental as Json) ?? {};
  const cacheFile = (experimental.cache_file as Json) ?? { enabled: true };
  cacheFile.enabled = true;
  cacheFile.path = settings.paths.cacheFile.trim();
  experimental.cache_file = cacheFile;
  config.experimental = experimental;

  // Normalize relative Tailscale state_directory paths under persistent root
  const tsRoot = settings.paths.tailscaleStateRoot.trim().replace(/\/+$/, "");
  if (Array.isArray(config.endpoints)) {
    for (const ep of config.endpoints as Json[]) {
      if (ep.type !== "tailscale") continue;
      const dir = typeof ep.state_directory === "string" ? ep.state_directory.trim() : "tailscale";
      if (!dir.startsWith("/")) {
        ep.state_directory = `${tsRoot}/${dir.replace(/^\/+/, "") || String(ep.tag ?? "tailscale")}`;
      }
    }
  }
}

/**
 * Generate an OpenWrt-ready sing-box 1.14+ configuration from an upstream Profile + OpenWrtSettings.
 *
 * Preserves all upstream DNS/IPv6/routing/protocol logic while adapting:
 * 1. Mandatory manual direct upstream DNS (`local`) + dnsmasq `dns-in` inbound + LAN leak prevention.
 * 2. Native Linux TUN (`auto_redirect`, `dns_mode`).
 * 3. Localized rule-sets (`type: "local"` + manifest for OpenWrt backend download/update).
 * 4. Flash-friendly `/tmp` cache_file + persistent Tailscale state directories.
 */
export function generateOpenWrtConfig(profile: Profile, settings: OpenWrtSettings): OpenWrtGenerateResult {
  const issues = validateOpenWrt(profile, settings);

  // Force platform="linux" on a shallow copy so upstream emits Linux-appropriate defaults
  // without mutating the user's saved Profile.
  const linuxProfile: Profile = {
    ...profile,
    settings: {
      ...profile.settings,
      platform: "linux",
    },
  };

  const config = generateConfig(linuxProfile);

  adaptDns(config, settings);
  adaptTun(config, settings);
  adaptAccessControl(config, settings);
  const ruleSets = adaptRuleSets(config, settings);
  adaptPathsAndRuntime(config, settings);

  return { config, ruleSets, issues };
}
