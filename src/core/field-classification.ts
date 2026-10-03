// onAmbiguous controls how a coupled group with a latestWinsField resolves when the two
// sides' recency values are indistinguishable (equal, both unparseable, or same-day mixed
// precision): "conflict" surfaces it as a coupled conflict (audit metadata must not resolve
// arbitrarily); "release" resolves non-blockingly by clearing the group (advisory claim state
// must never block a merge). Defaults to "conflict".
export type MergeRule =
  | { kind: "identity" }
  | { kind: "commutative" }
  | { kind: "monotonic"; compare: "max" }
  | { kind: "latest-wins"; timestampField: string }
  | { kind: "hard-conflict" }
  | { kind: "coupled"; group: string; members: string[]; latestWinsField?: string; onAmbiguous?: "conflict" | "release"; onDivergence?: "base" | "keep-ours" };

export type EntityType = "ticket" | "issue" | "note" | "lesson" | "arrangement" | "ruling";

const TICKET_RULES: Record<string, MergeRule> = {
  id: { kind: "identity" },
  createdDate: { kind: "identity" },
  createdAt: { kind: "identity" },
  createdBy: { kind: "identity" },

  blockedBy: { kind: "commutative" },
  crossNodeBlockedBy: { kind: "commutative" },
  previousDisplayIds: { kind: "commutative" },
  // T-476: same union-don't-conflict semantics as relatedTickets -- two
  // sessions each citing a different ruling on the same ticket should merge
  // to the union, not conflict.
  citesRulings: { kind: "commutative" },

  title: { kind: "hard-conflict" },
  description: { kind: "hard-conflict" },
  type: { kind: "hard-conflict" },
  phase: { kind: "hard-conflict" },
  order: { kind: "hard-conflict" },
  rank: { kind: "hard-conflict" },
  parentTicket: { kind: "hard-conflict" },
  displayId: { kind: "hard-conflict" },
  assignedTo: { kind: "hard-conflict" },

  // Attribution travels as a unit so the recorded modifier matches the recorded time:
  // the side with the later updatedAt wins lastModifiedBy + updatedAt + updatedDate together.
  lastModifiedBy: { kind: "coupled", group: "attribution", members: ["lastModifiedBy", "updatedAt", "updatedDate"], latestWinsField: "updatedAt", onAmbiguous: "conflict" },
  updatedAt: { kind: "coupled", group: "attribution", members: ["lastModifiedBy", "updatedAt", "updatedDate"], latestWinsField: "updatedAt", onAmbiguous: "conflict" },
  updatedDate: { kind: "coupled", group: "attribution", members: ["lastModifiedBy", "updatedAt", "updatedDate"], latestWinsField: "updatedAt", onAmbiguous: "conflict" },

  claimedBySession: { kind: "coupled", group: "ticket-claim", members: ["claimedBySession", "claim"], latestWinsField: "claim.since", onAmbiguous: "release" },
  claim: { kind: "coupled", group: "ticket-claim", members: ["claimedBySession", "claim"], latestWinsField: "claim.since", onAmbiguous: "release" },

  // T-537: a checkpoint's record and a dependent's evidence travel with the
  // status they justify, so a divergence never merges one without the other.
  status: { kind: "coupled", group: "ticket-status", members: ["status", "completedDate", "lifecycle", "ownerCheckpoint", "checkpointEvidence"] },
  completedDate: { kind: "coupled", group: "ticket-status", members: ["status", "completedDate", "lifecycle", "ownerCheckpoint", "checkpointEvidence"] },
  lifecycle: { kind: "coupled", group: "ticket-status", members: ["status", "completedDate", "lifecycle", "ownerCheckpoint", "checkpointEvidence"] },
  ownerCheckpoint: { kind: "coupled", group: "ticket-status", members: ["status", "completedDate", "lifecycle", "ownerCheckpoint", "checkpointEvidence"] },
  checkpointEvidence: { kind: "coupled", group: "ticket-status", members: ["status", "completedDate", "lifecycle", "ownerCheckpoint", "checkpointEvidence"] },

  // T-475: earmark is a single self-contained discriminated-union field, so
  // it is hard-conflict rather than "coupled" -- "coupled" groups in this
  // codebase always sync >=2 fields together (enforced by
  // field-classification.test.ts's "coupled groups are symmetric" check),
  // and there is nothing else to couple earmark with. hard-conflict already
  // gives the behavior the design calls for: a real divergence always
  // surfaces as a conflict, never resolved arbitrarily.
  earmark: { kind: "hard-conflict" },

  deletedAt: { kind: "hard-conflict" },
  deletedBy: { kind: "hard-conflict" },
};

const ISSUE_RULES: Record<string, MergeRule> = {
  id: { kind: "identity" },
  discoveredDate: { kind: "identity" },
  createdAt: { kind: "identity" },
  createdBy: { kind: "identity" },

  relatedTickets: { kind: "commutative" },
  components: { kind: "commutative" },
  location: { kind: "commutative" },
  sourceRefs: { kind: "commutative" },
  previousDisplayIds: { kind: "commutative" },
  citesRulings: { kind: "commutative" },

  dedupeKey: { kind: "identity" },

  title: { kind: "hard-conflict" },
  severity: { kind: "hard-conflict" },
  impact: { kind: "hard-conflict" },
  resolution: { kind: "hard-conflict" },
  order: { kind: "hard-conflict" },
  phase: { kind: "hard-conflict" },
  rank: { kind: "hard-conflict" },
  displayId: { kind: "hard-conflict" },
  assignedTo: { kind: "hard-conflict" },

  // Attribution travels as a unit (see TICKET_RULES).
  lastModifiedBy: { kind: "coupled", group: "attribution", members: ["lastModifiedBy", "updatedAt", "updatedDate"], latestWinsField: "updatedAt", onAmbiguous: "conflict" },
  updatedAt: { kind: "coupled", group: "attribution", members: ["lastModifiedBy", "updatedAt", "updatedDate"], latestWinsField: "updatedAt", onAmbiguous: "conflict" },
  updatedDate: { kind: "coupled", group: "attribution", members: ["lastModifiedBy", "updatedAt", "updatedDate"], latestWinsField: "updatedAt", onAmbiguous: "conflict" },

  status: { kind: "coupled", group: "issue-status", members: ["status", "resolvedDate", "lifecycle"] },
  resolvedDate: { kind: "coupled", group: "issue-status", members: ["status", "resolvedDate", "lifecycle"] },

  lifecycle: { kind: "coupled", group: "issue-status", members: ["status", "resolvedDate", "lifecycle"] },

  // T-475: see the ticket rule of the same name -- identical treatment.
  earmark: { kind: "hard-conflict" },

  // ISS-1032 (Amendment A5): an epoch is identity, not content -- it exists
  // ONLY to prove which session's resolution is the one standing, mirroring
  // `earmark`'s reasoning immediately above (a single self-contained field
  // with nothing else to couple it to). A divergent `resolutionEpoch` means
  // two sessions each resolved the same issue believing themselves the
  // owner; picking either side silently would hand one of them a false
  // ownership proof, so this must always surface as a real conflict rather
  // than resolve arbitrarily.
  resolutionEpoch: { kind: "hard-conflict" },

  deletedAt: { kind: "hard-conflict" },
  deletedBy: { kind: "hard-conflict" },
};

const NOTE_RULES: Record<string, MergeRule> = {
  id: { kind: "identity" },
  createdDate: { kind: "identity" },
  createdAt: { kind: "identity" },
  createdBy: { kind: "identity" },

  tags: { kind: "commutative" },
  previousDisplayIds: { kind: "commutative" },

  title: { kind: "hard-conflict" },
  content: { kind: "hard-conflict" },
  status: { kind: "hard-conflict" },
  updatedDate: { kind: "monotonic", compare: "max" },
  updatedAt: { kind: "monotonic", compare: "max" },
  displayId: { kind: "hard-conflict" },
  rank: { kind: "hard-conflict" },
  lifecycle: { kind: "hard-conflict" },
  deletedAt: { kind: "hard-conflict" },
  deletedBy: { kind: "hard-conflict" },
};

const LESSON_RULES: Record<string, MergeRule> = {
  id: { kind: "identity" },
  createdDate: { kind: "identity" },
  createdAt: { kind: "identity" },
  createdBy: { kind: "identity" },

  tags: { kind: "commutative" },
  previousDisplayIds: { kind: "commutative" },

  reinforcements: { kind: "monotonic", compare: "max" },

  title: { kind: "hard-conflict" },
  content: { kind: "hard-conflict" },
  context: { kind: "hard-conflict" },
  source: { kind: "hard-conflict" },
  lastValidated: { kind: "hard-conflict" },
  updatedDate: { kind: "monotonic", compare: "max" },
  updatedAt: { kind: "monotonic", compare: "max" },
  supersedes: { kind: "hard-conflict" },
  status: { kind: "hard-conflict" },
  displayId: { kind: "hard-conflict" },
  rank: { kind: "hard-conflict" },
  lifecycle: { kind: "hard-conflict" },
  deletedAt: { kind: "hard-conflict" },
  deletedBy: { kind: "hard-conflict" },
};

// T-478: arrangement duet-coordination fields. Per ruling (b1), any
// invariant-relevant field routes to hard-conflict rather than a silent
// deterministic pick (T-475 merge ruling precedent: routing to resolve IS
// the policy, not an exception to it). No coupled groups exist on this
// schema (no field pairs analogous to ticket's `attribution` or
// `ticket-claim` groups) -- getCoupledGroups("arrangement") correctly
// returns [].
const ARRANGEMENT_RULES: Record<string, MergeRule> = {
  id: { kind: "identity" },
  createdDate: { kind: "identity" },
  createdBy: { kind: "identity" },

  // No lastModifiedBy/updatedDate pair exists on this schema to couple
  // with (unlike ticket/issue) -- standalone monotonic-max, matching
  // note/lesson's treatment of updatedAt.
  updatedAt: { kind: "monotonic", compare: "max" },

  citesRulings: { kind: "commutative" },

  lifecycle: { kind: "hard-conflict" },
  bounds: { kind: "hard-conflict" },
  parties: { kind: "hard-conflict" },
  gates: { kind: "hard-conflict" },
  treeProtocol: { kind: "hard-conflict" },
  reviewBounds: { kind: "hard-conflict" },
  unreachability: { kind: "hard-conflict" },
  currentCoordinationSessionId: { kind: "hard-conflict" },
  communicationReceipts: { kind: "hard-conflict" },
  coordinationCheckpoint: { kind: "hard-conflict" },
  // ISS-1290: the succession audit, like parties: never merged silently.
  rebind: { kind: "hard-conflict" },
};

// T-522 (P-3): a ruling's reviewed payload is ONE unit. Every member of the
// `lifecycle` group travels together: when both sides changed any member and
// the sides differ, the driver keeps OURS as a complete side (`onDivergence:
// "keep-ours"`, never the per-member base fallback, which would mix an
// accepted side's `acceptance` with an edited side's `text`) and records the
// group's conflict entries, so `resolve --use ours|theirs` swaps the WHOLE
// side and `--value` is refused (coupled groups never take a field value).
// A record carrying `_conflicts` is `conflicted` at read time and binds
// nothing until resolved. `narrative` is commentary: latest-wins, and with
// no timestamp on a ruling a tie keeps ours; it never blocks a merge.
const RULING_LIFECYCLE_MEMBERS = ["status", "text", "attribution", "date", "scopeTags", "supersedes", "proposesToSupersede", "proposedFor", "acceptance", "withdrawal"];
const RULING_LIFECYCLE_RULE: MergeRule = { kind: "coupled", group: "lifecycle", members: RULING_LIFECYCLE_MEMBERS, onDivergence: "keep-ours" };
const RULING_RULES: Record<string, MergeRule> = {
  id: { kind: "identity" },
  createdAt: { kind: "identity" },
  recordedBy: { kind: "identity" },
  ...Object.fromEntries(RULING_LIFECYCLE_MEMBERS.map((m) => [m, RULING_LIFECYCLE_RULE])),
  narrative: { kind: "latest-wins", timestampField: "updatedAt" },
};

// T-529: a CAPABILITY entry inside `.story/capabilities.json`. What an entry
// claims to have verified is one unit: the contract, the entry points and
// surfaces it describes, the checkpoint it was read at, the stored status and
// the owed-work note. Merged per member, "contract from branch A, checkedAt
// from branch B" would read as verified while describing a contract nobody
// inspected, so when both sides changed the group and differ the driver keeps
// OURS whole and records ONE conflict for the entry, addressed by its id.
// Every other field of an entry merges field by field. A glossary TERM has no
// group: nothing on a term can read as verified, so every term field,
// `pendingNote` included, merges field by field (T-529 amendment reading).
const CAPABILITY_VERIFICATION_MEMBERS = ["entryPoints", "contract", "surfaces", "checkedAt", "status", "pendingNote"];
const CAPABILITY_VERIFICATION_RULE: MergeRule = { kind: "coupled", group: "verification", members: CAPABILITY_VERIFICATION_MEMBERS, onDivergence: "keep-ours" };
const CAPABILITY_RULES: Record<string, MergeRule> = {
  ...Object.fromEntries(CAPABILITY_VERIFICATION_MEMBERS.map((m) => [m, CAPABILITY_VERIFICATION_RULE])),
};

/** T-529: the catalog entry types. Not ledger entities: they live as elements of one file. */
export type CatalogEntryType = "capability" | "term";

const RULES_BY_TYPE: Record<string, Record<string, MergeRule>> = {
  ticket: TICKET_RULES,
  issue: ISSUE_RULES,
  note: NOTE_RULES,
  lesson: LESSON_RULES,
  arrangement: ARRANGEMENT_RULES,
  ruling: RULING_RULES,
  capability: CAPABILITY_RULES,
  term: {},
};

export function getMergeRules(entityType: EntityType | string): Record<string, MergeRule> {
  return RULES_BY_TYPE[entityType] ?? {};
}

export interface CoupledGroup {
  group: string;
  members: string[];
  latestWinsField?: string;
  onAmbiguous?: "conflict" | "release";
  /** T-522: what the BODY holds when both sides changed the group and differ. Default "base" (per member). */
  onDivergence?: "base" | "keep-ours";
}

export function getCoupledGroups(entityType: EntityType | CatalogEntryType): CoupledGroup[] {
  const rules = getMergeRules(entityType);
  const seen = new Set<string>();
  const groups: CoupledGroup[] = [];
  for (const rule of Object.values(rules)) {
    if (rule.kind === "coupled" && !seen.has(rule.group)) {
      seen.add(rule.group);
      groups.push({ group: rule.group, members: [...rule.members], latestWinsField: rule.latestWinsField, onAmbiguous: rule.onAmbiguous, onDivergence: rule.onDivergence });
    }
  }
  return groups;
}
