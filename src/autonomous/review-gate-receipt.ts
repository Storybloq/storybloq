/**
 * ISS-1282: a codex-bridge review is a gate result only when its own receipt
 * proves it.
 *
 * The verdict alone cannot: a model-name pin can fail over to the provider
 * default, `observed` can come back null, and an oversize diff can be reviewed
 * in chunks on a smaller model, and every one of those still says `approve`.
 * What the bridge returns beside each call's verdict (`models[]`, the session
 * id), what the reviewer is asked to print first (`REVIEWED: <path> (~N
 * changed lines)`), and the commits each call reviewed are checked here
 * instead of trusted: every call must be gate-grade on its own, and together
 * the reviewed ranges must carry the item from its baseline to the working
 * tree.
 *
 * Pure apart from the injected probe: every filesystem and git read goes
 * through it, and every probe failure becomes a refusal, never a throw.
 *
 * What this checks is ATTESTED, not authenticated (`RECEIPT_ATTESTATION`):
 * the diff, the commits and the digests are recomputed here, but the models,
 * the session id and the plan digest a receipt carries are whatever the
 * reporting agent wrote, and nothing here can tell a replayed one from a real
 * one. Verifying them needs a record the bridge itself issues.
 */

/** The caveat every surface that describes the receipt carries, verbatim. */
export const RECEIPT_ATTESTATION =
  "A receipt is ATTESTED, not authenticated: its models, sessionId and planSha256 are a CLAIM asserted by the reporting agent, not a record the bridge issued.";

export type GateAssessment<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

/** One tolerance for every count comparison, applied to the count the tool computed, never the reported one. */
export function tol(n: number): number {
  return Math.max(3, Math.ceil(0.1 * n));
}

/** Rule (b): the bridge reviews anything larger on a weaker model (L-108, bridge ISS-045). */
export const MAX_RANGE_LINES = 300;

// ---------------------------------------------------------------------------
// Rules (a) and (d): the bridge's own model receipt
// ---------------------------------------------------------------------------

export interface ObservedReviewer {
  readonly provider: "codex" | "gemini";
  readonly model: string;
}

export interface BridgeModelsVerdict {
  readonly observed: readonly ObservedReviewer[];
  /** Present only when a Gemini entry passed under the owner's ruling. */
  readonly disclosure?: "gemini-under-owner-ruling";
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export function assessBridgeModels(
  models: unknown,
  opts: { readonly geminiRulingAccepted: boolean },
): GateAssessment<BridgeModelsVerdict> {
  if (!Array.isArray(models) || models.length === 0) {
    return { ok: false, reason: "no bridge model receipt: pass this call's result models[] verbatim" };
  }
  if (!models.every((m) => typeof m === "object" && m !== null && !Array.isArray(m))) {
    return { ok: false, reason: "models must be the bridge's models[] array of objects" };
  }
  const entries = (models as Record<string, unknown>[]).filter((m) => m.role === undefined || m.role === "review");
  if (entries.length === 0) return { ok: false, reason: "models has no review entry" };

  const observed: ObservedReviewer[] = [];
  let disclosure: BridgeModelsVerdict["disclosure"];
  for (const m of entries) {
    const model = str(m.observed);
    if (model === null) return { ok: false, reason: `observed is null (evidence ${String(m.evidence)}): nothing saw which model ran` };
    if (m.evidence !== "runtime_session_record") return { ok: false, reason: `evidence ${String(m.evidence)} is not runtime_session_record` };
    if (m.selection !== "requested") return { ok: false, reason: `selection ${String(m.selection)}: the request was not honoured` };
    if (m.requested !== "max") return { ok: false, reason: `requested ${String(m.requested)}: request tier max, never a model name` };
    if (m.provider === "codex") {
      observed.push({ provider: "codex", model });
    } else if (m.provider === "gemini" && opts.geminiRulingAccepted) {
      observed.push({ provider: "gemini", model });
      disclosure = "gemini-under-owner-ruling";
    } else if (m.provider === "gemini") {
      return { ok: false, reason: `observed Gemini (${model}) with no accepted owner ruling at recipeOverrides.reviewGate.geminiRuling` };
    } else {
      return { ok: false, reason: `provider ${String(m.provider)} is not a gate reviewer` };
    }
  }
  return { ok: true, value: disclosure ? { observed, disclosure } : { observed } };
}

// ---------------------------------------------------------------------------
// Rules (b) and (c): what each call actually saw
// ---------------------------------------------------------------------------

/** `added`/`deleted` are null for a binary file (numstat prints `-`). */
export interface NumstatEntry {
  readonly path: string;
  readonly added: number | null;
  readonly deleted: number | null;
}

/** Parse `git diff --numstat -z --no-renames` output. Returns null on anything malformed. */
export function parseNumstatZ(out: string): NumstatEntry[] | null {
  const entries: NumstatEntry[] = [];
  for (const rec of out.split("\0")) {
    if (rec === "" || rec === "\n") continue;
    const m = /^\n?(-|\d+)\t(-|\d+)\t(.+)$/s.exec(rec);
    if (!m) return null;
    entries.push({ path: m[3]!, added: m[1] === "-" ? null : Number(m[1]), deleted: m[2] === "-" ? null : Number(m[2]) });
  }
  return entries;
}

/** Lockfiles are machine-written: required by path, exempt from line coverage and the range cap. */
export const GENERATED_BASENAMES: ReadonlySet<string> = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "Package.resolved",
  "Cargo.lock", "Gemfile.lock", "poetry.lock", "go.sum",
]);

const lineCounted = (e: NumstatEntry): boolean =>
  e.added !== null && e.deleted !== null && !GENERATED_BASENAMES.has(e.path.slice(e.path.lastIndexOf("/") + 1));
const lines = (e: NumstatEntry): number => (lineCounted(e) ? e.added! + e.deleted! : 0);

export interface ReceiptProbe {
  isDir(path: string): boolean;
  inWorkTree(cwd: string): Promise<boolean>;
  /**
   * `git diff --numstat -z --no-renames <base> <head>` output, with a count for
   * every path git calls binary only because an attribute says so: a `-\t-`
   * entry is kept only for content that is binary on its own. May throw.
   */
  numstat(cwd: string, base: string, head: string): Promise<string>;
  /**
   * The tree entry `path` has at commit `rev` in `cwd`, as `<mode> <object id>`,
   * or null when `rev` has no such path. The mode is part of the identity: an
   * executable bit or a file turned symlink is a change like any other. May throw.
   */
  entryAt(cwd: string, rev: string, path: string): Promise<string | null>;
  /**
   * The entry the working-tree `path` under `root` would get, in the same form,
   * or null when it is absent. A submodule is its checked-out commit, and one
   * with uncommitted content throws: no reviewed commit holds that content. May throw.
   */
  workEntry(root: string, path: string): Promise<string | null>;
}

export const RANGE_TOKEN = "[range]";
const CODE_RECEIPT = /^REVIEWED: (.+?) \(~(\d+) changed lines\)$/;
const REF = /^[A-Za-z0-9_][A-Za-z0-9._/~^+-]{0,255}$/;

const firstLine = (e: unknown): string =>
  (e instanceof Error ? e.message : typeof e === "string" ? e : "unknown error").split("\n")[0]!.slice(0, 200);

/** What a gate-grade bridge review observed, across every call that contributed to it. */
export interface GateEvidence extends BridgeModelsVerdict {
  readonly calls: number;
  /** The bridge session each call ran in, in receipt order. */
  readonly sessions: readonly string[];
}

/** Rule (a) per call: each receipt carries the models[] and session of the call that produced it. */
function assessCall(r: Record<string, unknown>, at: string, opts: { readonly geminiRulingAccepted: boolean }): GateAssessment<{ verdict: BridgeModelsVerdict; session: string }> {
  const session = r.sessionId;
  if (typeof session !== "string" || session.trim().length === 0) {
    return { ok: false, reason: `${at}.sessionId is missing: pass the bridge session id this call returned` };
  }
  const models = assessBridgeModels(r.models, opts);
  if (!models.ok) return { ok: false, reason: `${at}.models: ${models.reason}` };
  return { ok: true, value: { verdict: models.value, session } };
}

function mergeEvidence(calls: readonly { verdict: BridgeModelsVerdict; session: string }[]): GateEvidence {
  const observed: ObservedReviewer[] = [];
  for (const c of calls) {
    for (const o of c.verdict.observed) {
      if (!observed.some((x) => x.provider === o.provider && x.model === o.model)) observed.push(o);
    }
  }
  const disclosed = calls.some((c) => c.verdict.disclosure !== undefined);
  const sessions = calls.map((c) => c.session);
  return disclosed
    ? { observed, disclosure: "gemini-under-owner-ruling", calls: calls.length, sessions }
    : { observed, calls: calls.length, sessions };
}

/** One reviewed call's view of one path: the commits it started and ended at. */
interface PathStep {
  readonly at: string;
  readonly cwd: string;
  readonly base: string;
  readonly head: string;
}

/**
 * The item's own diff: `entries` against `baseline`, the commit the session
 * recorded as the item's diff base. Every review must start from it. An entry
 * is binary (null counts) only when the baseline or the working-tree content
 * is binary by content; that is the only binary exemption a range may claim.
 */
export interface ItemDiff {
  readonly baseline: string;
  readonly entries: readonly NumstatEntry[];
}

/**
 * Rules (b) and (c). Counts prove the reviewer saw the piece it was sent;
 * content proves the pieces are the item. For every changed path, the calls
 * that reviewed it, in receipt order, must form one chain of tree entries
 * (mode and object id): the first starts at the baseline's entry, each next
 * one starts at the entry the one before it ended at, and the last ends at the
 * working tree's entry. A gap is an
 * unreviewed change; a repeat breaks the chain, so duplicated or overlapping
 * chunks are refused, and a review on an unrelated base cannot start it.
 */
export async function assessCodeReceipts(
  receipts: unknown,
  item: ItemDiff,
  probe: ReceiptProbe,
  root: string,
  opts: { readonly geminiRulingAccepted: boolean },
): Promise<GateAssessment<GateEvidence>> {
  if (!Array.isArray(receipts) || receipts.length === 0) {
    return { ok: false, reason: "no reviewReceipts: pass one { cwd, base, head, receipt, models, sessionId } per bridge call" };
  }
  const calls: { verdict: BridgeModelsVerdict; session: string }[] = [];
  const steps = new Map<string, PathStep[]>();
  for (const [i, r] of receipts.entries()) {
    const at = `reviewReceipts[${i}]`;
    if (typeof r !== "object" || r === null || Array.isArray(r)) return { ok: false, reason: `${at} is not an object` };
    const rec = r as Record<string, unknown>;
    const { cwd, base, head, receipt } = rec;
    if (typeof receipt !== "string") return { ok: false, reason: `${at}.receipt is missing` };
    const parsed = CODE_RECEIPT.exec(receipt.trim());
    if (!parsed) return { ok: false, reason: `${at}.receipt does not read "REVIEWED: <path or ${RANGE_TOKEN}> (~N changed lines)"` };
    const call = assessCall(rec, at, opts);
    if (!call.ok) return call;
    calls.push(call.value);
    if (typeof cwd !== "string" || !cwd.startsWith("/")) return { ok: false, reason: `${at}.cwd must be the absolute path the bridge call ran in` };
    if (typeof base !== "string" || typeof head !== "string" || !REF.test(base) || !REF.test(head)) {
      return { ok: false, reason: `${at}.base/head must be plain git refs` };
    }
    let range: NumstatEntry[] | null;
    try {
      if (!probe.isDir(cwd) || !(await probe.inWorkTree(cwd))) return { ok: false, reason: `${at}.cwd ${cwd} is not a git work tree` };
      range = parseNumstatZ(await probe.numstat(cwd, base, head));
    } catch (e) {
      return { ok: false, reason: `git diff failed in ${cwd}: ${firstLine(e)}` };
    }
    if (range === null) return { ok: false, reason: `git diff in ${cwd} returned unparseable numstat` };
    if (range.length === 0) return { ok: false, reason: `${at} range ${base}..${head} changes nothing` };
    // The binary exemption is the item's to grant, from its own endpoints (the
    // baseline and the working tree): a text change routed through a binary
    // intermediate commit would otherwise pass as chunks of ~0 lines.
    const binaryItem = new Set(item.entries.filter((e) => e.added === null).map((e) => e.path));
    const hidden = range.find((e) => e.added === null && !binaryItem.has(e.path));
    if (hidden) {
      return { ok: false, reason: `${at} range ${base}..${head} counts ${hidden.path} as binary, but the item's own diff of it is text: review it in ranges that hold it as text` };
    }

    const rangeLines = range.reduce((n, e) => n + lines(e), 0);
    if (rangeLines > MAX_RANGE_LINES) {
      return { ok: false, reason: `${at} range ${base}..${head} is ${rangeLines} changed lines; split it to at most ${MAX_RANGE_LINES}` };
    }
    const named = parsed[1]!;
    const n = Number(parsed[2]);
    if (named !== RANGE_TOKEN) {
      // A single-path receipt is a review of that path alone, so its range may change nothing else.
      if (!range.some((e) => e.path === named)) return { ok: false, reason: `${at} receipt names ${named}, which ${base}..${head} does not change` };
      const others = range.filter((e) => e.path !== named).map((e) => e.path);
      if (others.length > 0) {
        return { ok: false, reason: `${at} receipt names only ${named} but ${base}..${head} also changes ${others.slice(0, 3).join(", ")}: use ${RANGE_TOKEN} or a range of that file alone` };
      }
    }
    if (Math.abs(n - rangeLines) > tol(rangeLines)) {
      return { ok: false, reason: `${at} receipt says ~${n} changed lines but ${base}..${head} has ${rangeLines}: the reviewer did not see this piece` };
    }
    for (const e of range) {
      // Once per call: a type change can list one path twice in one range.
      const chain = steps.get(e.path) ?? [];
      if (chain[chain.length - 1]?.at !== at) steps.set(e.path, [...chain, { at, cwd, base, head }]);
    }
  }

  const missing = item.entries.filter((e) => !steps.has(e.path)).map((e) => e.path);
  if (missing.length > 0) return { ok: false, reason: `not reviewed: ${missing.join(", ")}` };

  for (const e of item.entries) {
    try {
      let entry = await probe.entryAt(root, item.baseline, e.path);
      const chain = steps.get(e.path)!;
      for (const [k, s] of chain.entries()) {
        if ((await probe.entryAt(s.cwd, s.base, e.path)) !== entry) {
          return {
            ok: false,
            reason: k === 0
              ? `unrelated base: ${s.at} reviews ${e.path} from ${s.base}, which does not hold it as the item baseline ${item.baseline} does`
              : `broken review chain for ${e.path}: ${s.at} does not start where the previous review of it ended (a duplicated, overlapping or missing chunk)`,
          };
        }
        entry = await probe.entryAt(s.cwd, s.head, e.path);
      }
      if ((await probe.workEntry(root, e.path)) !== entry) {
        return { ok: false, reason: `stale review: the last review of ${e.path} does not end where the working tree is` };
      }
    } catch (e2) {
      return { ok: false, reason: `could not compare ${e.path} with the reviewed commits: ${firstLine(e2)}` };
    }
  }
  return { ok: true, value: mergeEvidence(calls) };
}

// ---------------------------------------------------------------------------
// Plan receipt: ties the model receipt to the plan the guide holds
// ---------------------------------------------------------------------------

const PLAN_RECEIPT = /^REVIEWED: plan\.md \(~(\d+) lines\)$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * `planSha256` is the digest of the exact text sent to `review_plan`; it must
 * be the digest of the plan the guide holds now, so a receipt cannot be reused
 * for a different plan that happens to have the same length.
 */
export function assessPlanReceipt(
  receipts: unknown,
  plan: { readonly text: string; readonly sha256: string },
  opts: { readonly geminiRulingAccepted: boolean },
): GateAssessment<GateEvidence> {
  const rec = typeof receipts === "object" && receipts !== null && !Array.isArray(receipts) ? (receipts as Record<string, unknown>) : null;
  const r = rec?.receipt;
  if (rec === null || typeof r !== "string") return { ok: false, reason: "no plan receipt: pass reviewReceipts { receipt, planSha256, models, sessionId } with the summary's first line" };
  const m = PLAN_RECEIPT.exec(r.trim());
  if (!m) return { ok: false, reason: 'plan receipt does not read "REVIEWED: plan.md (~N lines)"' };
  const call = assessCall(rec, "reviewReceipts", opts);
  if (!call.ok) return call;
  const digest = rec.planSha256;
  if (typeof digest !== "string" || !SHA256.test(digest)) {
    return { ok: false, reason: "reviewReceipts.planSha256 must be the lowercase sha256 of the exact plan text sent to review_plan" };
  }
  if (digest !== plan.sha256) {
    return { ok: false, reason: "plan receipt digest does not match plan.md: the reviewer did not see this plan" };
  }
  const actual = plan.text.length === 0 ? 0 : plan.text.replace(/\n$/, "").split("\n").length;
  const n = Number(m[1]);
  if (Math.abs(n - actual) > tol(actual)) {
    return { ok: false, reason: `plan receipt says ~${n} lines but plan.md has ${actual}: the reviewer did not see this plan` };
  }
  return { ok: true, value: mergeEvidence([call.value]) };
}
