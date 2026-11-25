import { freshTag } from "../upstream/defaults";
import { nodeObject } from "../upstream/generate";
import type { Profile, ProxyNode } from "../upstream/types";

export interface SubscriptionItem {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  userAgent: string;
  downloadMode: "direct" | "proxy";
  includeKeywords: string;
  excludeKeywords: string;
  regexFilter: string;
  renamePrefix: string;
  deduplicate: boolean;
  inGroups: boolean;
  lastUpdated?: number;
  lastStatus?: "ok" | "error";
  lastError?: string;
  lastCount?: number;
}

/** ProxyNode with optional subscription provenance metadata (ignored by upstream generator). */
export interface ManagedProxyNode extends ProxyNode {
  subId?: string;
  subKey?: string;
}

function splitKeywords(raw: string): string[] {
  return String(raw || "")
    .split(/[\n,|]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

/** Stable fingerprint for a node (protocol + server + port + credential) to keep IDs across updates. */
export function nodeFingerprint(node: ProxyNode): string {
  const parsed = nodeObject(node);
  const o = parsed.object as Record<string, unknown> | undefined;
  if (!o) return `raw:${node.tag}`;
  const cred = String(o.uuid ?? o.password ?? o.private_key ?? o.username ?? "");
  return `${String(o.type ?? "")}|${String(o.server ?? "")}|${String(o.server_port ?? "")}|${cred}`;
}

/**
 * Filter, rename, deduplicate, and merge newly parsed subscription nodes into `profile.nodes`
 * while preserving existing `node.id` values (so ProxyGroups & RouteRules never break) and
 * leaving manual nodes and other subscriptions untouched.
 */
export function mergeSubscriptionNodes(
  profile: Profile,
  sub: SubscriptionItem,
  incoming: ProxyNode[],
): { nodes: ManagedProxyNode[]; added: number; kept: number; total: number } {
  const includes = splitKeywords(sub.includeKeywords);
  const excludes = splitKeywords(sub.excludeKeywords);
  let regex: RegExp | null = null;
  if (sub.regexFilter && sub.regexFilter.trim()) {
    try {
      regex = new RegExp(sub.regexFilter.trim(), "i");
    } catch {
      regex = null;
    }
  }

  // Existing nodes from THIS subscription indexed by fingerprint and by tag
  const existingSubNodes = (profile.nodes as ManagedProxyNode[]).filter((n) => n.subId === sub.id);
  const idByKey = new Map<string, string>();
  const idByTag = new Map<string, string>();
  for (const n of existingSubNodes) {
    const key = n.subKey || nodeFingerprint(n);
    if (!idByKey.has(key)) idByKey.set(key, n.id);
    if (!idByTag.has(n.tag)) idByTag.set(n.tag, n.id);
  }

  // Keep all manual nodes and nodes belonging to other subscriptions
  const preserved = (profile.nodes as ManagedProxyNode[]).filter((n) => n.subId !== sub.id);
  const usedTags = [
    "proxy",
    "auto",
    "direct",
    "local",
    "remote",
    "tun-in",
    "dns-in",
    ...preserved.map((n) => n.tag),
    ...(profile.groups ?? []).map((g) => g.tag),
    ...(profile.settings?.tailnets ?? []).map((t) => t.tag),
  ];
  const seenKeys = new Set<string>();
  const prefix = (sub.renamePrefix || "").trimStart();

  const mergedSub: ManagedProxyNode[] = [];
  let kept = 0;
  let added = 0;

  for (const rawNode of incoming) {
    const tagLower = rawNode.tag.toLowerCase();
    if (includes.length > 0 && !includes.some((kw) => tagLower.includes(kw))) continue;
    if (excludes.length > 0 && excludes.some((kw) => tagLower.includes(kw))) continue;
    if (regex && !regex.test(rawNode.tag)) continue;

    const fp = nodeFingerprint(rawNode);
    if (sub.deduplicate && seenKeys.has(fp)) continue;
    seenKeys.add(fp);

    let tag = prefix ? `${prefix}${rawNode.tag}` : rawNode.tag;
    if (usedTags.includes(tag)) {
      tag = freshTag(tag, usedTags);
    }
    usedTags.push(tag);

    const reusedId = idByKey.get(fp) ?? idByTag.get(tag) ?? idByTag.get(rawNode.tag);
    if (reusedId) kept++;
    else added++;

    mergedSub.push({
      id: reusedId ?? rawNode.id,
      tag,
      body: rawNode.body,
      inGroups: sub.inGroups,
      subId: sub.id,
      subKey: fp,
    });
  }

  return {
    nodes: [...preserved, ...mergedSub],
    added,
    kept,
    total: mergedSub.length,
  };
}
