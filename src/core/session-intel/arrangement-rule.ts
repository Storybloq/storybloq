/**
 * ISS-1428 (handover lines slice C, plan 6.2): the arrangement handover rule
 * in force for one session, read at notice time.
 *
 * Only the candidates that would otherwise ask (`ask`, `uncovered`,
 * `catch-up`) look it up, and only after the record's own `rule` is absent
 * (that one decides earlier, in `decideFromRecord`). For each
 * `arrangementPresence` entry with lifecycle `active`, at most three, in
 * record order, the arrangement file is read bounded and without following
 * links, and decoded leniently: only `parties[].client`,
 * `parties[].identityAnchor` and `parties[].handoverRule` are looked at. The
 * rule applies when exactly one party has both `client` and `identityAnchor`
 * equal to the record's `ownerIdentity` and that party's
 * `handoverRule.handovers` is `elsewhere`. No match, two matches, a null
 * `ownerIdentity`, or an unreadable or undecodable file is no rule.
 *
 * Never throws, never writes.
 */

import { join } from "node:path";
import { ArrangementIdSchema } from "../../models/types.js";
import { readBoundedNoFollow } from "../../presence/io.js";
import { MAX_RULE_WHERE_BYTES, oneLineOrNull } from "../../presence/session-intel-fields.js";
import type { SessionPresence } from "../../presence/types.js";
import { ARRANGEMENT_MAX_BYTES } from "../arrangement-loader.js";
import type { ArrangementRuleInForce } from "./policy.js";

/** At most this many arrangement files are read per lookup. */
export const MAX_ARRANGEMENT_RULE_READS = 3;

export function arrangementRuleInForce(root: string, record: SessionPresence | null): ArrangementRuleInForce | null {
  try {
    const owner = record?.ownerIdentity ?? null;
    if (!record || !owner) return null;
    let reads = 0;
    for (const entry of record.arrangementPresence) {
      if (entry.lifecycle !== "active") continue;
      if (reads >= MAX_ARRANGEMENT_RULE_READS) break;
      if (!ArrangementIdSchema.safeParse(entry.arrangementId).success) continue;
      reads++;
      const text = readBoundedNoFollow(join(root, ".story", "arrangements", `${entry.arrangementId}.json`), ARRANGEMENT_MAX_BYTES);
      if (text === null) continue;
      const rule = ruleForOwner(text, owner.client, owner.clientTaskId);
      if (rule !== null) return { arrangementId: entry.arrangementId, where: rule.where };
    }
    return null;
  } catch {
    return null;
  }
}

function ruleForOwner(text: string, client: string, anchor: string): { where: string | null } | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const parties = (v as { parties?: unknown }).parties;
  if (!Array.isArray(parties)) return null;
  const matches = parties.filter((p): p is Record<string, unknown> =>
    !!p && typeof p === "object" && !Array.isArray(p) && (p as Record<string, unknown>).client === client && (p as Record<string, unknown>).identityAnchor === anchor);
  if (matches.length !== 1) return null;
  const hr = matches[0]!.handoverRule;
  if (!hr || typeof hr !== "object" || Array.isArray(hr)) return null;
  const r = hr as Record<string, unknown>;
  if (r.handovers !== "elsewhere") return null;
  // A malformed `where` costs only the text: the rule itself still holds.
  return { where: oneLineOrNull(r.where, MAX_RULE_WHERE_BYTES) };
}
