import { blueprintProfile } from "../upstream/defaults";
import { generateConfig } from "../upstream/generate";
import type { Profile } from "../upstream/types";
import { adaptDns } from "./dns";
import { adaptRouting } from "./routing";
import { adaptRuleSets } from "./rulesets";
import { adaptTun } from "./tun";
import type { OpenWrtGenerateResult, OpenWrtSettings } from "./types";
import { validateOpenWrt } from "./validation";

type Json = Record<string, unknown>;

/**
 * First-run blueprint profile for OpenWrt routers:
 * Reuses upstream `blueprintProfile()` while defaulting to `Non-CN` (Mainland China bypass).
 */
export function openWrtBlueprintProfile(): Profile {
  const profile = blueprintProfile();
  profile.settings.defaultMode = "Non-CN";
  return profile;
}

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
 * 1. Mandatory manual direct upstream DNS (`local`, optional bootstrap/backup) + dnsmasq `dns-in` inbound + LAN leak prevention + OpenWrt IPv6 mode.
 * 2. Native Linux TUN (`auto_redirect`, `dns_mode`, `include_interface`, `route_exclude_address_set`, optional `mixed-in`).
 * 3. Native Linux `auto_redirect` pre-match `action: "bypass"` (CN / LAN / direct / access control / port filter), fixed access control precedence, `find_neighbor`, Tailscale Exit Node inbound rules, and optional proxied QUIC reject.
 * 4. Localized rule-sets (`type: "local"` + manifest for OpenWrt backend download/update; no bundled geo files).
 * 5. Flash-friendly `/tmp` cache_file + persistent Tailscale state directories.
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
  adaptRouting(config, settings);
  const ruleSets = adaptRuleSets(config, settings);
  adaptPathsAndRuntime(config, settings);

  return { config, ruleSets, issues };
}
