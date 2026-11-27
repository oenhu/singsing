// Public entry point for both Node/Vitest tests and the LuCI browser bundle (`engine-bundle.js`).

export * from "./types";
export * from "./validation";
export { buildDirectDnsServer, adaptDns } from "./dns";
export { adaptTun } from "./tun";
export { adaptRuleSets } from "./rulesets";
export {
  adaptAccessControl,
  buildClientMatch,
  buildPostSniffAccessControlRules,
  hasMacAccessControl,
  parseClientEntries,
  isValidMac,
  normalizeMac,
} from "./access";
export { adaptRouting } from "./routing";
export { generateOpenWrtConfig, openWrtBlueprintProfile } from "./config";

// Re-export upstream core capabilities for LuCI views (without React/DOM dependencies).
export {
  generateConfig,
  validate,
  nodeObject,
  tailnetEndpoint,
  customDnsServer,
  remoteDnsServer,
  parseDomainList,
  parseRuleList,
  parseJsonc,
  stripComments,
  REMOTE_DNS,
  REMOTE_DNS_TYPES,
  BUILT_IN_RULE_TARGETS,
  proxyChoices,
} from "../upstream/generate";

export {
  blueprintProfile,
  defaultSettings,
  newNode,
  newGroup,
  newRule,
  newDnsRule,
  newTailnet,
  freshTag,
  randomSecret,
  CUSTOM_DNS_TEMPLATE,
  DNS_RULE_TEMPLATE,
  TAILSCALE_ENDPOINT_TEMPLATE,
} from "../upstream/defaults";

export { TEMPLATES, NODE_TYPES, ENDPOINT_TYPES } from "../upstream/templates";
export { importConfig, fitImport } from "../upstream/importer";
export { normalizeProfile, normalizeStore } from "../upstream/storage";
export { searchRuleSets, resolveRuleSet, canonicalSource, POPULAR_RULE_SETS } from "../upstream/rule-sets";
export { changedLines } from "../upstream/diff";
