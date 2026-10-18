/**
 * T-499: the push surfaces. Everything here is best-effort and bounded:
 * a failure or an abandoned budget returns nothing, and the caller's
 * response goes out untouched.
 *
 *   banner       a prefix (MCP md), a sibling key (MCP json), an appended
 *                line (CLI md) or one STDERR line (CLI json) at advisory or
 *                imperative, for the CALLER's own session under the binding
 *                rule: record exists, not ended, live non-null era equal to
 *                the record's. A persistent MCP server across `/clear`
 *                inherits an ended id and therefore pushes nothing.
 *   directive    the guide's imperative line for the autonomous OWNER.
 *   stamp        after a handover is written, the caller's record records
 *                it against the current compaction boundary.
 */

import { isPresenceEnabled } from "../../presence/handler.js";
import type { SessionIntelPresence, SessionIntelSample, TokenPressureState } from "../../presence/session-intel-fields.js";
import { LIFECYCLE_LOCK_BUDGET_MS } from "../presence-enrichment.js";
import { readSessionIntelConfig, type SessionIntelConfig } from "./config.js";
import { claimImperativeEmission, consumeUsageAdvisory, findPresenceRecordAcrossWorktrees, peekPending, readPresenceRecord, reconcileIntel, reconcileUnderLock, resolveCallerBinding, revalidateCandidateIdentity, stampHandover, type CallerBinding, type CandidateIdentity, type HandoverStampObservation, type HandoverStampOutcome } from "./presence-bridge.js";
import { sampleSession } from "./query.js";
import { usageAdvisoryFrom } from "./sampler.js";
import type { UsageAdvisory } from "./types.js";
import { locateTranscript } from "./transcript-locate.js";
import { scanTail } from "./transcript-scan.js";
import { claudeConfigDisplay } from "../claude-config-dir.js";

export const BANNER_SOFT_BUDGET_MS = 150;

/** The banner's payload: the compact sample plus a rendered line. */
export interface TokenPressureBanner {
  readonly state: "advisory" | "imperative" | "compact-needed";
  readonly pct: number | null;
  readonly contextTokens: number | null;
  readonly ceiling: number | null;
  readonly ceilingSource: SessionIntelSample["ceilingSource"];
  readonly ceilingConfidence: SessionIntelSample["ceilingConfidence"];
  readonly sampledAt: string;
  readonly suppressedBy: "handover" | "rate-limit" | null;
  readonly text: string;
  /**
   * ISS-1263: present only on an imperative banner that has not been
   * delivered yet. `deliverBanner` calls it once, immediately before the
   * text is attached, and swaps in `degraded` when the claim is refused.
   * Neither ever reaches output (`bannerJson` drops both).
   */
  readonly claim?: () => boolean;
  readonly degraded?: TokenPressureBanner;
}

export interface BannerOptions {
  readonly explicitTaskId?: string | null;
  readonly cwd?: string;
  readonly now?: number;
  readonly sampledBy?: "mcp-refresh" | "query";
  readonly softBudgetMs?: number;
  /** Test seams. */
  readonly clock?: () => number;
  readonly projectsDir?: string;
  readonly userSettingsPath?: string;
}

const pctText = (p: number | null) => (p === null ? "n/a" : `${Math.round(p * 100)}%`);

/**
 * ISS-1197 commit 2: the one wording every compact-needed surface shares, so
 * the banner, the guide directive and the prompt hook cannot drift into
 * asking for a handover that would not help. Deliberately free of the phrase
 * the imperative surfaces use: an agent that reads both must be able to tell
 * them apart on the words alone.
 */
export const COMPACT_NEEDED_ADVICE =
  "Context is past the point where another handover helps: write no further handovers. A session cannot compact itself; finish the step in flight and keep working, auto-compaction is expected and the session continues through it. If the user wants it sooner, they can run /compact in this session.";

/**
 * ISS-1249: the printed percentage can sit below the configured share, so the
 * line states its basis; that is what stops it reading as a bug. T-533: the
 * sampler reason names the clause that fired (the headroom floor or the
 * share), so it is stated as written. Used by the UserPromptSubmit directive,
 * which holds the live sample; the MCP banner is built from the persisted
 * presence sample, which carries no reason.
 */
export function basisText(reason: string | null | undefined): string {
  if (!reason) return " Basis: the imperative fires at the headroom floor (or the next-turn jump allowance, if larger) or at the imperative share of the expected auto-compact point, whichever comes first.";
  return ` Basis: ${reason}.`;
}

export function renderBannerText(sample: SessionIntelSample, surface: "mcp" | "cli"): string {
  const where = surface === "mcp" ? "storybloq_handover_create" : "storybloq handover create";
  const head = `Context pressure ${sample.state.toUpperCase()}: ${pctText(sample.pct)} of the expected auto-compact point (${sample.contextTokens?.toLocaleString() ?? "n/a"} tokens; source ${sample.ceilingSource}${sample.ceilingConfidence ? `, ${sample.ceilingConfidence} confidence` : ""}).`;
  // ISS-1197 commit 2: past this line another handover buys nothing, so the
  // text must not ask for one. It carries both halves: what the agent should
  // do (keep working through the compaction that is coming) and what only the
  // user can do (bring it forward with /compact).
  if (sample.state === "compact-needed") return `${head} ${COMPACT_NEEDED_ADVICE}`;
  if (sample.state === "imperative") return `${head} Write a handover now via ${where}, then keep working in this same turn. The handover makes compaction safe: do not stop, do not defer the next step to a later turn, and do not ask the user whether to continue. Any auto-compaction that follows is expected and safe: the session continues through it, and one handover covers it.`;
  if (sample.suppressedBy === "rate-limit") return `${head} The imperative line was shown recently and will not repeat for a while: keep working.`;
  return `${head}${sample.suppressedBy === "handover" ? " A recent handover holds this at advisory: keep working." : ""} Plan a handover before the next large step, and keep working.`;
}

/**
 * The usable sample for the CALLER's record, refreshed by one bound tail
 * sample when the stored one is older than `maxSampleAgeMs`. Null on any
 * gate: feature or banner off, presence off, unbound caller, no usable
 * sample, unresolved pending compaction, or the soft budget exceeded.
 */
/**
 * T-501: the ONE acquisition path both pushes share -- binding, refresh and
 * reconciliation under a single deadline. Null on any gate: unbound caller,
 * no usable sample, unresolved pending compaction, or the soft budget
 * exceeded. The pressure gate and the advisory rule are applied by the two
 * callers ON TOP of this, so they can never disagree about which sample they
 * are describing.
 */
export interface CallerSample {
  /** The root the record actually lives under (a worktree, in the ISS-1185 case). */
  readonly root: string;
  readonly sessionId: string;
  readonly era: string | null;
  /**
   * Set only when `root` came from the ISS-1185 worktree walk. Every later
   * WRITE through that root must revalidate it: the checks made during
   * acquisition do not cover a swap that happens afterwards.
   */
  readonly recordRootIdentity: CandidateIdentity | null;
  readonly intel: SessionIntelPresence;
  readonly sample: SessionIntelSample;
  readonly revisionSeen: number;
}

export function acquireCallerSample(
  root: string,
  opts: BannerOptions,
  cfg: SessionIntelConfig,
  budget: { readonly startedAt: number; readonly softMs: number; readonly clock: () => number },
): CallerSample | null {
  const { startedAt, softMs, clock } = budget;
  const now = opts.now ?? startedAt;
  if (!isPresenceEnabled(root)) return null;
  const binding = resolveCallerBinding(root, opts.explicitTaskId, undefined, { deadline: startedAt + softMs, clock });
  if (!binding.bound || !binding.sessionId) return null;
  if (clock() - startedAt > softMs) return null;
  // ISS-1185: the caller's record can live under a worktree the MCP
  // server's own root never sees. `recordRootIdentity` is set only when it
  // came from that fallback walk; re-checked immediately before the
  // record is actually used so a swap after discovery never surfaces
  // content read through since-redirected storage.
  const resolvedRoot = binding.recordRoot ?? root;
  if (binding.recordRootIdentity && !revalidateCandidateIdentity(resolvedRoot, binding.recordRootIdentity)) return null;

  let intel = readPresenceRecord(resolvedRoot, binding.sessionId)?.sessionIntel ?? null;
  let sample = intel?.lastSample ?? null;
  const stale = sample === null || now - Date.parse(sample.sampledAt) > cfg.maxSampleAgeMs;
  if (stale) {
    const r = sampleSession({
      root: resolvedRoot,
      cwd: opts.cwd ?? resolvedRoot,
      sampledBy: opts.sampledBy ?? "mcp-refresh",
      explicitTaskId: binding.sessionId,
      allowGlob: false,
      now,
      projectsDir: opts.projectsDir,
      userSettingsPath: opts.userSettingsPath,
      budget: { startedAt, softMs, clock },
    });
    if (!r.usable || r.presence !== "persisted") return null;
    intel = readPresenceRecord(resolvedRoot, binding.sessionId)?.sessionIntel ?? null;
    sample = intel?.lastSample ?? null;
  }
  if (!intel || !sample) return null;
  if (clock() - startedAt > softMs) return null;
  // Same usability rule as the status projection: the sample must survive
  // reconciliation of the pending set unchanged.
  const rec = reconcileIntel(intel, null, peekPending(resolvedRoot, binding.sessionId, now), cfg, now);
  if (rec.status !== "complete" || rec.intel.lastSample !== sample) return null;
  return { root: resolvedRoot, sessionId: binding.sessionId, era: binding.era, recordRootIdentity: binding.recordRootIdentity, intel, sample, revisionSeen: intel.revision };
}

export function tokenPressureBannerFor(root: string, opts: BannerOptions = {}, surface: "mcp" | "cli" = "mcp"): TokenPressureBanner | null {
  try {
    const clock = opts.clock ?? Date.now;
    const startedAt = clock();
    const softMs = opts.softBudgetMs ?? BANNER_SOFT_BUDGET_MS;
    const cfg = readSessionIntelConfig(root);
    if (!cfg.enabled || !cfg.banner) return null;
    const acquired = acquireCallerSample(root, opts, cfg, { startedAt, softMs, clock });
    if (!acquired) return null;
    return bannerFromSample(acquired.sample, surface, claimFor(acquired, cfg, opts.now ?? startedAt));
  } catch {
    return null;
  }
}

/**
 * ISS-1263: the delivery claim for an acquired imperative sample, bound to
 * the identity of the record it was read from. A write, so a record found by
 * the ISS-1185 worktree walk is revalidated first; any throw is a refusal.
 */
function claimFor(acquired: CallerSample, cfg: SessionIntelConfig, now: number): () => boolean {
  const seen = { revision: acquired.intel.revision, lastBoundaryAt: acquired.intel.lastBoundaryAt, handoverWrittenAt: acquired.intel.handoverWrittenAt };
  return () => {
    try {
      if (acquired.recordRootIdentity && !revalidateCandidateIdentity(acquired.root, acquired.recordRootIdentity)) return false;
      return claimImperativeEmission(acquired.root, acquired.sessionId, seen, now, cfg.handoverRearmIntervalMs);
    } catch {
      return false;
    }
  };
}

/**
 * ISS-1263: resolves a banner for delivery, claiming the imperative line at
 * most once. Call it only once the response is PROVEN to carry the banner,
 * so a response that cannot carry it spends nothing. The result carries no
 * claim, so resolving it again is a no-op.
 */
export function deliverBanner(banner: TokenPressureBanner | null): TokenPressureBanner | null {
  if (!banner || !banner.claim) return banner;
  const { claim, degraded, ...plain } = banner;
  return claim() ? plain : (degraded ?? null);
}

/** The pressure gate on top of an acquired sample: only advisory, imperative and compact-needed are pushed. */
function bannerFromSample(sample: SessionIntelSample, surface: "mcp" | "cli", claim?: () => boolean): TokenPressureBanner | null {
  if (sample.state !== "advisory" && sample.state !== "imperative" && sample.state !== "compact-needed") return null;
  if (sample.state === "imperative" && claim) {
    const plain = bannerFromSample(sample, surface)!;
    const degraded = bannerFromSample({ ...sample, state: "advisory", suppressedBy: "rate-limit" }, surface)!;
    return { ...plain, claim, degraded };
  }
  return {
    state: sample.state,
    pct: sample.pct,
    contextTokens: sample.contextTokens,
    ceiling: sample.ceiling,
    ceilingSource: sample.ceilingSource,
    ceilingConfidence: sample.ceilingConfidence,
    sampledAt: sample.sampledAt,
    suppressedBy: sample.suppressedBy,
    text: renderBannerText(sample, surface),
  };
}

// ---------------------------------------------------------------------------
// Usage-cost advisory (T-501)
// ---------------------------------------------------------------------------

/** Where a source's value was set, as a user can find it. Null names no file. */
function settingsFile(source: "user" | "project" | "local"): string {
  if (source === "user") return claudeConfigDisplay("settings.json");
  return source === "project" ? ".claude/settings.json" : ".claude/settings.local.json";
}

/** Locale-independent thousands grouping: the rendered text is pinned in tests. */
function grouped(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * The advisory's wording, rendered from the payload at push time and never
 * stored. It says only what was observed (a null source names no file, and
 * the model case says the setting was not observed rather than that it is
 * unset), and carries no cost multiplier: we do not know the user's plan.
 */
export function renderUsageAdvisory(advisory: UsageAdvisory): string {
  const max = grouped(advisory.recommendedMax);
  const tail = "It takes effect on the next Claude Code start.";
  if (advisory.kind === "model") {
    return `This session runs a 1M-context model, and Storybloq did not observe an \`autoCompactWindow\` setting, so context can grow toward ${grouped(advisory.nativeWindow)} tokens and usage rises with it on every turn. Set \`autoCompactWindow\` to ${max} or lower in ${settingsFile("user")} (see /story settings). ${tail}`;
  }
  const where = advisory.source === null ? "your Claude Code settings" : settingsFile(advisory.source);
  const setIn = advisory.source === null ? "your Claude Code settings" : "that file";
  return `Your Claude Code auto-compact window is ${grouped(advisory.observed)} tokens, set in ${where}. Larger contexts increase usage on every turn. Set \`autoCompactWindow\` to ${max} or lower in ${setIn} (see /story settings). ${tail}`;
}

/**
 * An advisory that is eligible but NOT yet consumed. `commit()` takes the
 * once-per-session stamp under the record lock and reports whether it got it:
 * nothing may be shown unless it returns true (attach, then stamp, then strip
 * again on failure -- the caller's job, `applyStatusPushesToMcpText` and
 * `cliUsageAdvisoryFor` do it).
 */
export interface UsageAdvisoryPush {
  readonly advisory: UsageAdvisory;
  readonly text: string;
  readonly commit: () => boolean;
}

/**
 * The advisory for the CALLER's own session, decided from the record's stored
 * INPUTS against the CURRENT config -- so raising, lowering or zeroing
 * `recommendedWindowMax` changes the answer with no new sample, and the zero
 * disable is honoured before any stamp is considered.
 *
 * Independent of token pressure: an `ok` session still gets it, because a
 * user at 20 percent of a one-million window is exactly the case the advisory
 * exists for.
 */
export function usageAdvisoryFor(root: string, opts: BannerOptions = {}): UsageAdvisoryPush | null {
  try {
    const clock = opts.clock ?? Date.now;
    const startedAt = clock();
    const softMs = opts.softBudgetMs ?? BANNER_SOFT_BUDGET_MS;
    const cfg = readSessionIntelConfig(root);
    const gate = usageAdvisoryGate(cfg);
    if (!gate) return null;
    const acquired = acquireCallerSample(root, opts, cfg, { startedAt, softMs, clock });
    if (!acquired) return null;
    return usageAdvisoryFrom_(acquired, cfg, { startedAt, softMs, clock }, opts.now ?? startedAt);
  } catch {
    return null;
  }
}

/** Both gates for the advisory that depend on config alone. */
function usageAdvisoryGate(cfg: SessionIntelConfig): boolean {
  if (!cfg.enabled || !cfg.banner) return false;
  // A threshold of 0 disables the advisory outright, checked BEFORE any
  // acquisition or stamp is considered.
  return cfg.recommendedWindowMax !== 0;
}

/**
 * The advisory for an already-acquired sample. Separate from the acquisition
 * so the status surfaces can derive the pressure banner and the advisory from
 * ONE sample under ONE deadline: two acquisitions would double the permitted
 * push overhead and could describe two different samples.
 */
function usageAdvisoryFrom_(
  acquired: CallerSample,
  cfg: SessionIntelConfig,
  budget: { readonly startedAt: number; readonly softMs: number; readonly clock: () => number },
  now: number,
): UsageAdvisoryPush | null {
  // Already shown this era: refused here rather than at the stamp, so the
  // common case costs no lock at all.
  if (acquired.intel.usageAdvisoryShownAt !== null) return null;
  const input = acquired.sample.usageInput;
  if (!input) return null;
  const advisory = usageAdvisoryFrom(input, input.oneMillionFlag, cfg);
  if (!advisory) return null;
  const { startedAt, softMs, clock } = budget;
  // The stamp is a write: a call that has already spent its budget shows
  // nothing rather than pushing the caller's response past it.
  if (clock() - startedAt > softMs) return null;
  return {
    advisory,
    text: renderUsageAdvisory(advisory),
    commit: () => {
      try {
        // Re-checked HERE, not only at construction: the caller attaches the
        // line and (for json) parses and re-serializes its whole response
        // between the two points, so the budget can be spent in between.
        if (clock() - startedAt > softMs) return false;
        // ISS-1185: the record may live under a worktree found by the
        // fallback walk. This is a WRITE through that root, so the identity
        // captured at discovery is revalidated immediately before it -- era
        // and revision prove nothing about the directory.
        if (acquired.recordRootIdentity && !revalidateCandidateIdentity(acquired.root, acquired.recordRootIdentity)) return false;
        return consumeUsageAdvisory(acquired.root, { sessionId: acquired.sessionId, era: acquired.era }, acquired.sample, acquired.revisionSeen, now).stamped;
      } catch {
        // The advisory is optional: a failing stamp must never turn a
        // successful status response into an error.
        return false;
      }
    },
  };
}

/**
 * Both status pushes from ONE acquisition under ONE deadline. This is the
 * only entry point the status surfaces (MCP `storybloq_status`, CLI
 * `storybloq status`) use: the pressure banner and the usage advisory then
 * always describe the same sample, and the two together cost one budget.
 */
export interface StatusPushes {
  readonly banner: TokenPressureBanner | null;
  readonly usage: UsageAdvisoryPush | null;
}

export function statusPushesFor(root: string, opts: BannerOptions = {}, surface: "mcp" | "cli" = "mcp"): StatusPushes {
  const none: StatusPushes = { banner: null, usage: null };
  try {
    const clock = opts.clock ?? Date.now;
    const startedAt = clock();
    const softMs = opts.softBudgetMs ?? BANNER_SOFT_BUDGET_MS;
    const cfg = readSessionIntelConfig(root);
    if (!cfg.enabled || !cfg.banner) return none;
    const acquired = acquireCallerSample(root, opts, cfg, { startedAt, softMs, clock });
    if (!acquired) return none;
    return {
      banner: bannerFromSample(acquired.sample, surface, claimFor(acquired, cfg, opts.now ?? startedAt)),
      usage: usageAdvisoryGate(cfg) ? usageAdvisoryFrom_(acquired, cfg, { startedAt, softMs, clock }, opts.now ?? startedAt) : null,
    };
  } catch {
    return none;
  }
}

/** The JSON sibling shape: the payload plus the rendered message (machine output keeps both). */
export function usageAdvisoryJson(push: UsageAdvisoryPush): Record<string, unknown> {
  return { ...push.advisory, message: push.text };
}

/** The JSON sibling shape (the rendered text is left out of machine output). */
export function bannerJson(b: TokenPressureBanner): Record<string, unknown> {
  const { text: _text, claim: _claim, degraded: _degraded, ...rest } = b;
  return rest;
}

/**
 * Applies a banner to an MCP result. Nothing changes on an error result.
 * md: a prefix block. json: a sibling key `tokenPressure` when the text is
 * a JSON object; any other shape is left untouched.
 */
export function applyBannerToMcpText(text: string, format: "md" | "json", banner: TokenPressureBanner | null, usage: UsageAdvisoryPush | null = null): string {
  if (!banner && !usage) return text;
  if (format === "json") {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return text;
      // ISS-1263: claimed only now, once the response is proven to carry it.
      const delivered = deliverBanner(banner);
      return JSON.stringify({
        ...(parsed as Record<string, unknown>),
        ...(delivered ? { tokenPressure: bannerJson(delivered) } : {}),
        ...(usage ? { usageAdvisory: usageAdvisoryJson(usage) } : {}),
      }, null, 2);
    } catch {
      return text;
    }
  }
  // T-501: its own block, never folded into the pressure line -- a user at 20
  // percent of a one-million window sees no pressure banner at all.
  const blocks = [usage?.text, deliverBanner(banner)?.text, text].filter((b): b is string => b !== undefined && b !== null);
  return blocks.join("\n\n");
}

/** Whether an MCP response can carry a push at all: md always, json only as a top-level object. */
function canCarryPushes(text: string, format: "md" | "json"): boolean {
  if (format !== "json") return true;
  try {
    const parsed: unknown = JSON.parse(text);
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * T-501: the status surface's attach-then-stamp, in one place so the MCP and
 * CLI paths cannot drift. The advisory is attached first, and the stamp is
 * only taken once the response is PROVEN to carry it (an md body always can;
 * a json body only when its top level is an object). If the stamp is refused
 * -- busy lock, era change, stale revision, a stamp another caller just took
 * -- the line is stripped again, so nothing is ever shown unstamped and the
 * next priming call retries.
 */
export function applyStatusPushesToMcpText(
  text: string,
  format: "md" | "json",
  banner: TokenPressureBanner | null,
  usage: UsageAdvisoryPush | null,
): string {
  // ISS-1263: the two renderings below would each claim the imperative line;
  // it is resolved once here, when the response can carry it at all.
  const resolved = canCarryPushes(text, format) ? deliverBanner(banner) : banner;
  const bannerOnly = applyBannerToMcpText(text, format, resolved);
  if (!usage) return bannerOnly;
  const withUsage = applyBannerToMcpText(text, format, resolved, usage);
  if (withUsage === bannerOnly) return bannerOnly; // this response cannot carry it
  return usage.commit() ? withUsage : bannerOnly;
}

/**
 * CLI: md is appended to stdout; json gets ONE line on stderr so the stdout
 * envelope and `--raw` stay parseable. Same attach-then-stamp rule as the MCP
 * surface: the line is built, then the stamp decides whether it is emitted.
 */
export function cliStatusPushesFor(root: string, format: "md" | "json", opts: BannerOptions = {}): { readonly stdout: readonly string[]; readonly stderr: readonly string[] } {
  const { banner, usage } = statusPushesFor(root, { sampledBy: "query", ...opts }, "cli");
  const lines: string[] = [];
  // The advisory goes first when both are present: the banner is about this
  // turn, the advisory about the session's whole cost.
  if (usage && usage.commit()) lines.push(usage.text);
  // ISS-1263: a CLI line is always printed, so the claim is taken here.
  const delivered = deliverBanner(banner);
  if (delivered) lines.push(delivered.text);
  return format === "json"
    ? { stdout: [], stderr: lines.map((l) => `[storybloq] ${l}`) }
    : { stdout: lines, stderr: [] };
}

/** CLI: md is appended to stdout; json gets ONE line on stderr so the stdout envelope and `--raw` stay parseable. */
export function cliBannerFor(root: string, format: "md" | "json", opts: BannerOptions = {}): { readonly stdout: string | null; readonly stderr: string | null } {
  const banner = deliverBanner(tokenPressureBannerFor(root, { sampledBy: "query", ...opts }, "cli"));
  if (!banner) return { stdout: null, stderr: null };
  return format === "json" ? { stdout: null, stderr: `[storybloq] ${banner.text}` } : { stdout: banner.text, stderr: null };
}

// ---------------------------------------------------------------------------
// Guide directive
// ---------------------------------------------------------------------------

/**
 * The autonomous OWNER's imperative directive, from its record only (the
 * guide never scans a transcript). Null unless the owner's usable sample is
 * imperative or compact-needed and `guideDirective` is on. Not a state
 * transition.
 */
export function guideDirectiveFor(root: string, ownerClaudeSessionId: string | null | undefined, now: number = Date.now(), cfg: SessionIntelConfig = readSessionIntelConfig(root)): string | null {
  try {
    if (!ownerClaudeSessionId || !cfg.enabled || !cfg.guideDirective) return null;
    if (!isPresenceEnabled(root)) return null;
    // ISS-1185: symmetric worktree fallback -- find only, never create.
    let resolvedRoot = root;
    let walkedIdentity: CandidateIdentity | null = null;
    let record = readPresenceRecord(root, ownerClaudeSessionId);
    if (!record) {
      const match = findPresenceRecordAcrossWorktrees(root, ownerClaudeSessionId);
      if (match && revalidateCandidateIdentity(match.root, match.identity)) {
        record = match.record;
        resolvedRoot = match.root;
        walkedIdentity = match.identity;
      }
    }
    const intel = record?.sessionIntel ?? null;
    const sample = intel?.lastSample ?? null;
    if (!intel || !sample || (sample.state !== "imperative" && sample.state !== "compact-needed")) return null;
    const rec = reconcileIntel(intel, null, peekPending(resolvedRoot, ownerClaudeSessionId, now), cfg, now);
    if (rec.status !== "complete" || rec.intel.lastSample !== sample) return null;
    const head = `Context pressure ${sample.state} (${pctText(sample.pct)} of ceiling, source ${sample.ceilingSource}${sample.ceilingConfidence ? `, ${sample.ceilingConfidence} confidence` : ""})`;
    // ISS-1197 commit 2: the guide is an autonomous driver, so this is exactly
    // where a handover demand past the compact line would loop forever.
    if (sample.state === "compact-needed") return `${head}: ${COMPACT_NEEDED_ADVICE}`;
    // ISS-1263: the guide delivers the imperative too, so it claims the one
    // line per interval like every other surface; refused means no directive.
    if (walkedIdentity && !revalidateCandidateIdentity(resolvedRoot, walkedIdentity)) return null;
    const seen = { revision: intel.revision, lastBoundaryAt: intel.lastBoundaryAt, handoverWrittenAt: intel.handoverWrittenAt };
    if (!claimImperativeEmission(resolvedRoot, ownerClaudeSessionId, seen, now, cfg.handoverRearmIntervalMs)) return null;
    return `${head}: write a handover now via storybloq_handover_create, then keep working in this same turn. The handover makes compaction safe: do not stop, do not defer the next step to a later turn, and do not ask the user whether to continue. Any auto-compaction that follows is expected and safe: the session continues through it, and one handover covers it.`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Handover stamp
// ---------------------------------------------------------------------------

export type HandoverStampResult =
  | {
      readonly status: "stamped";
      readonly sessionId: string;
      readonly outcome: HandoverStampOutcome;
      readonly root: string;
      /**
       * ISS-1197 commit 2: the state of the sample the stamp saw under its own
       * lock, so the reply can say what the stamp actually achieved. Null when
       * there was no sample, or when the write never reached one.
       */
      readonly pressureState: TokenPressureState | null;
      /** ISS-1263: "unbound-era" when the stamp landed without a proven process era. */
      readonly binding: "bound" | "unbound-era";
    }
  | {
      readonly status: "skipped";
      readonly reason: string;
      /**
       * ISS-1214: WHY the skip happened, decided at the return site that
       * knows. Classifying downstream would mean re-deriving cause from
       * message text, which is how a reply ends up asserting a cause it
       * cannot establish. "config" is a precondition that never applied.
       */
      readonly kind: "config" | "binding" | "outcome" | "error";
    };

/**
 * ISS-1214: the shape a reply needs to say what happened, with the cause
 * already decided. `reason` is display text; `kind` is what may be concluded
 * from it.
 */
export type StampFailureKind = "binding" | "outcome" | "refused" | "error";

/**
 * Binding reasons an ordinary terminal always produces and cannot act on: a
 * CLI run is not a Claude session, so saying the stamp "did not land" there
 * reports the absence of a feature as a failure.
 */
const CLI_SILENT_BINDING_REASONS = new Set([
  "client is not Claude",
  "no caller session id",
  "no project",
]);

/**
 * On MCP the client IS Claude and a session id is expected, so a missing one
 * is a real defect to report -- the field report's silent failure. Only a
 * genuinely absent project stays quiet, since no stamp could ever apply.
 */
const MCP_SILENT_BINDING_REASONS = new Set(["no project"]);

/** Human-readable forms of the enrichment outcomes a stamp can end on. */
const STAMP_OUTCOME_REASONS: Readonly<Record<string, string>> = {
  "skipped-lock-busy": "lock busy",
  "skipped-write-failed": "write failed",
  "skipped-no-directory": "no presence directory",
  "skipped-too-large": "record too large",
  aborted: "aborted",
};

/**
 * ISS-1214: why the stamp did not land, or null when it landed or when it
 * never applied. Classification lives here, beside the shapes, so no display
 * surface has to infer cause from reason text.
 */
export function describeStampFailure(
  result: HandoverStampResult,
  surface: "mcp" | "cli" = "cli",
): { readonly reason: string; readonly kind: StampFailureKind } | null {
  if (result.status === "skipped") {
    if (result.kind === "config") return null;
    const silent = surface === "mcp" ? MCP_SILENT_BINDING_REASONS : CLI_SILENT_BINDING_REASONS;
    if (result.kind === "binding" && silent.has(result.reason)) return null;
    const prefix = result.kind === "error" ? "error" : "skipped";
    return { reason: `${prefix}: ${result.reason}`, kind: result.kind };
  }
  const outcome = result.outcome;
  if (outcome.status === "written") return null;
  if (outcome.status === "refused") return { reason: `refused: ${outcome.reason}`, kind: "refused" };
  return { reason: STAMP_OUTCOME_REASONS[outcome.status] ?? outcome.status, kind: "outcome" };
}

/**
 * ISS-1263: which stamp a binding permits. A bound caller stamps as before.
 * A caller whose era could not be PROVEN (unknown, or unverifiable because
 * the ps probe failed under load) stamps "unbound-era", but only when the
 * record branch passed: a live, non-ended record exists for its session id.
 * Positive evidence still refuses: "process era ended" (the process is
 * proven gone) and "record era differs from the live process era" (a live,
 * different era says the record is another process's). Null means skip.
 */
function stampModeFor(binding: CallerBinding): "bound" | "unbound-era" | null {
  if (binding.bound && binding.era) return "bound";
  if (!binding.sessionId || binding.recordRoot === null) return null;
  return binding.reason === "process era unknown" || binding.reason === "process era unverifiable" ? "unbound-era" : null;
}

/**
 * After a successful `handover create`: reconcile the caller's record (a
 * boundary the tail shows is applied first, so the stamp lands on the
 * CURRENT compaction), then stamp it under the binding rule. Best-effort.
 *
 * ISS-1185: when `root` (the MCP server's own root) has no record for the
 * caller, a worktree fallback finds it -- never creates one. The candidate's
 * identity, captured at discovery, is revalidated THREE times: immediately
 * on resolution (before any read), again immediately before
 * `reconcileUnderLock` (locateTranscript/scanTail between those two points
 * can read a large file, widening the window), and again immediately before
 * `stampHandover`. A root swapped since discovery refuses the stamp rather
 * than reconciling or writing through it.
 */
export function stampHandoverForCaller(root: string, opts: { explicitTaskId?: string | null; cwd?: string; now?: number; projectsDir?: string } = {}): HandoverStampResult {
  try {
    const cfg = readSessionIntelConfig(root);
    if (!cfg.enabled) return { status: "skipped", reason: "sessionIntel disabled", kind: "config" };
    if (!isPresenceEnabled(root)) return { status: "skipped", reason: "presence disabled", kind: "config" };
    const binding = resolveCallerBinding(root, opts.explicitTaskId, undefined, {});
    const mode = stampModeFor(binding);
    if (mode === null || !binding.sessionId) return { status: "skipped", reason: binding.reason, kind: "binding" };
    const now = opts.now ?? Date.now();
    const sessionId = binding.sessionId;
    const resolvedRoot = binding.recordRoot ?? root;
    if (binding.recordRootIdentity && !revalidateCandidateIdentity(resolvedRoot, binding.recordRootIdentity)) {
      return { status: "skipped", reason: "candidate root changed since discovery", kind: "outcome" };
    }
    const record = readPresenceRecord(resolvedRoot, sessionId);
    const located = locateTranscript({ sessionId, cwd: opts.cwd ?? resolvedRoot, hint: record?.sessionIntel?.transcriptPath ?? null, allowGlob: false, projectsDir: opts.projectsDir });
    const tail = located ? scanTail({ path: located.path, sessionId, era: null, revisionSeen: null, epochSince: null }) : null;
    // Re-checked HERE too, immediately before the first write
    // (reconcileUnderLock): locateTranscript/scanTail above can read a
    // large transcript file, widening the window since the check before
    // them. Never rely on that earlier check alone to guard this write.
    if (binding.recordRootIdentity && !revalidateCandidateIdentity(resolvedRoot, binding.recordRootIdentity)) {
      return { status: "skipped", reason: "candidate root changed since discovery", kind: "outcome" };
    }
    reconcileUnderLock({ root: resolvedRoot, sessionId, cfg, tailBoundaries: tail?.boundaries ?? [], transcriptPath: located?.path ?? null, source: "other", now }, LIFECYCLE_LOCK_BUDGET_MS);
    if (binding.recordRootIdentity && !revalidateCandidateIdentity(resolvedRoot, binding.recordRootIdentity)) {
      return { status: "skipped", reason: "candidate root changed since discovery", kind: "outcome" };
    }
    // tokensAtHandover is taken from the record INSIDE the stamp's lock (the
    // null fallback in stampHandover reads lastSample there), so the token
    // count and handoverBoundaryAt always describe the same locked record; a
    // sampler or compaction landing between the reconcile and the stamp
    // cannot pair an old count with a newer boundary.
    const observed: HandoverStampObservation = { state: null };
    const outcome = stampHandover(resolvedRoot, sessionId, mode === "bound" ? binding.era : null, null, now, { out: observed, cfg }, mode);
    return { status: "stamped", sessionId, outcome, root: resolvedRoot, pressureState: observed.state, binding: mode };
  } catch (err) {
    return { status: "skipped", reason: err instanceof Error ? err.message : String(err), kind: "error" };
  }
}
