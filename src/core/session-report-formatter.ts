import { computeSessionRounds, type SessionRound } from "./review-stats.js";
import { displayIdOf } from "./resolver.js";
/**
 * Session report formatter -- renders 7-section structured analysis.
 * All sections always present; missing data uses "Not available" placeholders.
 */
import { analyzeSessionDiagnostics } from "../autonomous/session-diagnostics.js";
import { effectiveReviewEffort, effortDisclosureLine, isReviewEffort } from "../autonomous/review-effort.js";
import { deriveJoinAvailability } from "../autonomous/review-identity.js";
import type { FullSessionState, EventEntry } from "../autonomous/session-types.js";
import type { OutputFormat } from "../models/types.js";
import { safeJson, MAX_DISPLAY_SERIALIZED_LENGTH } from "./safe-json.js";
import { boundedList, boundedLines } from "./bounded-list.js";
import { MAX_DISPLAY_LENGTH, MAX_PROSE_LENGTH, sanitizeDisplayText } from "./display-text.js";
import { escapeMarkdownDocumentStrict } from "./output-formatter.js";

/**
 * Everything below comes out of a `state.json` or an `events.log` this build did
 * not write (ISS-897).
 *
 * Passing the schema is not the same as being safe to render. `state` is a free
 * string on purpose (T-328) so a newer workflow state does not brick an older
 * reader; ticket ids, titles, reviewer names, verdicts and event types are
 * equally unconstrained. This report is the surface the ownership guard sends an
 * operator to when it cannot determine what is running, so a newline here forges
 * a bullet in the Problems list and an ESC redraws the line it lands on -- in
 * the one document the operator is reading to decide whether to intervene.
 *
 * Sanitize first (control characters, U+2028/9, bidi), then escape as a
 * DOCUMENT. A line-start-only treatment is not enough here, and the reason is
 * the sink rather than the payload: `handleSessionReport` defaults to
 * `format: "md"` and
 * `storybloq_session_report` returns exactly that text to an MCP client, which
 * may render it as Markdown. A ticket title carrying `[look here](https://x)`,
 * a raw `<img>`, or a pair of backticks therefore authors real structure inside
 * the one document an operator is reading to decide whether to intervene.
 *
 * The JSON branch is deliberately NOT run through this: a consumer diffing
 * against the file needs the parsed values unmodified, and `JSON.stringify`
 * already encodes control characters so they cannot break out of the string.
 */
/**
 * How many problem bullets the report may carry (ISS-897). The section exists
 * to be read at a glance; past a couple of dozen the reader needs the log, and
 * the count tells them so.
 */
const MAX_PROBLEM_LINES = 25;

/**
 * The same bound for every other per-record list in this report (ISS-897).
 *
 * `completedTickets` and the review-round arrays come out of the same
 * untrusted `state.json` as the timeline, so bounding two sections of one
 * document and leaving the rest open is not a bound. The COUNT each section
 * leads with stays outside it.
 */
const MAX_SECTION_LINES = 40;

function safe(value: unknown, maxLength = MAX_DISPLAY_LENGTH): string {
  return escapeMarkdownDocumentStrict(sanitizeDisplayText(String(value), maxLength));
}

/**
 * A value rendered INSIDE a code span, which `safe()` is the wrong tool for.
 *
 * `escapeMarkdownInline` does not touch backticks, so a hostile commit hash or
 * branch name closes the span and everything after it becomes ordinary
 * Markdown. It also prepends a backslash to a leading `-`, `#`, `*`, `+` or
 * `1.` -- correct in prose, but a code span renders that backslash literally,
 * so a branch named `-wip` would display as `\-wip`.
 *
 * So: sanitize (control characters, U+2028/9, bidi) but do NOT Markdown-escape,
 * and pick a fence longer than the longest backtick run in the value, which is
 * how CommonMark says to embed backticks.
 *
 * The padding rule is CommonMark's stripping rule read in reverse, and it is
 * narrower than "pad when it starts or ends with a backtick":
 *
 *  - the renderer strips ONE space from each end only when BOTH ends have one
 *    AND the content is not entirely spaces. So a value with ordinary leading or
 *    trailing spaces needs padding too, or it silently loses one at each end.
 *  - an ALL-SPACE value is exempt from that stripping, so padding it ADDS two
 *    visible spaces instead of protecting it.
 *  - an EMPTY value cannot be rendered as a code span at all; padding it just
 *    produces a span containing two spaces. Name the emptiness instead.
 */
function codeSpan(value: unknown): string {
  const text = sanitizeDisplayText(String(value));
  if (text === "") return "`(empty)`";
  let longestRun = 0;
  let run = 0;
  for (const ch of text) {
    run = ch === "`" ? run + 1 : 0;
    if (run > longestRun) longestRun = run;
  }
  const fence = "`".repeat(longestRun + 1);
  const allSpaces = text.trim() === "";
  const boundary = (ch: string) => ch === "`" || ch === " ";
  const pad = !allSpaces && (boundary(text[0]!) || boundary(text[text.length - 1]!)) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

export interface SessionReportData {
  readonly state: FullSessionState;
  readonly events: { events: readonly EventEntry[]; malformedCount: number };
  readonly planContent: string | null;
  readonly gitLog: string[] | null;
}

export function formatSessionReport(
  data: SessionReportData,
  format: OutputFormat,
): string {
  const { state, events, planContent, gitLog } = data;

  if (format === "json") {
    return JSON.stringify({
      ok: true,
      data: {
        summary: buildSummaryData(state),
        ticketProgression: state.completedTickets,
        reviewStats: state.reviews,
        events: events.events.slice(-50),
        malformedEventCount: events.malformedCount,
        contextPressure: state.contextPressure,
        git: {
          branch: state.git.branch,
          initHead: state.git.initHead,
          commits: gitLog,
        },
        problems: buildProblems(state, events),
      },
    }, null, 2);
  }

  const sections: string[] = [];

  // 1. Session Summary
  sections.push(buildSummarySection(state));

  // 2. Ticket Progression
  sections.push(buildTicketSection(state));

  // 3. Review Stats
  sections.push(buildReviewSection(state));

  // 4. Event Timeline
  sections.push(buildEventSection(events));

  // 5. Context Pressure
  sections.push(buildPressureSection(state));

  // 6. Git Summary
  sections.push(buildGitSection(state, gitLog));

  // 7. Problems
  sections.push(buildProblemsSection(state, events));

  return sections.join("\n\n---\n\n");
}

// --- Section builders ---

function buildSummaryData(state: FullSessionState) {
  return {
    sessionId: state.sessionId,
    mode: state.mode ?? "auto",
    recipe: state.recipe,
    status: state.status,
    terminationReason: state.terminationReason,
    startedAt: state.startedAt,
    lastGuideCall: state.lastGuideCall,
    guideCallCount: state.guideCallCount,
    ticketsCompleted: state.completedTickets.length,
  };
}

function buildSummarySection(state: FullSessionState): string {
  const duration = state.startedAt && state.lastGuideCall
    ? formatDuration(state.startedAt, state.lastGuideCall)
    : "unknown";
  return [
    "## Session Summary",
    "",
    `- **ID:** ${safe(state.sessionId)}`,
    `- **Mode:** ${safe(state.mode ?? "auto")}`,
    `- **Recipe:** ${safe(state.recipe)}`,
    `- **Status:** ${safe(state.status)}${state.terminationReason ? ` (${safe(state.terminationReason)})` : ""}`,
    `- **Duration:** ${safe(duration)}`,
    `- **Guide calls:** ${state.guideCallCount}`,
    `- **Tickets completed:** ${state.completedTickets.length}`,
  ].join("\n");
}

function buildTicketSection(state: FullSessionState): string {
  if (state.completedTickets.length === 0) {
    const current = state.ticket;
    if (current) {
      return [
        "## Ticket Progression",
        "",
        `In progress: **${safe(displayIdOf(current))}** -- ${safe(current.title)} (risk: ${safe(current.risk ?? "unknown")})`,
      ].join("\n");
    }
    return "## Ticket Progression\n\nNo tickets completed.";
  }

  const lines = ["## Ticket Progression", ""];
  const ticketLines: string[] = [];
  for (const t of state.completedTickets) {
    const risk = t.realizedRisk
      ? `${safe(t.risk ?? "?")} → ${safe(t.realizedRisk)}`
      : safe(t.risk ?? "unknown");
    const duration = t.startedAt && t.completedAt
      ? formatDuration(t.startedAt, t.completedAt)
      : null;
    const durationPart = duration ? ` | duration: ${duration}` : "";
    ticketLines.push(
      `- **${safe(displayIdOf(t))}:** ${safe(t.title)} | risk: ${risk}${durationPart} | commit: ${codeSpan(t.commitHash ?? "?")}`,
    );
  }
  lines.push(
    ...boundedLines(ticketLines, {
      maxLines: MAX_SECTION_LINES,
      noun: "completed tickets",
      fullSetHint: "The complete list is in `completedTickets` of state.json.",
    }),
  );
  return lines.join("\n");
}


/**
 * T-432: the rounds table.
 *
 * SCOPE IS THIS SESSION and the heading says so. These rows come from the
 * session's own `reviews` arrays -- the P2 population -- not from the verdict
 * artifacts that `storybloq review-stats` reports over, and the two must never
 * be read as the same measurement: a state row carries no `target`, so it can
 * summarise a session and a stage and can never speak for one work item.
 *
 * A ZERO DENOMINATOR PRINTS `-`. A stage with no change-request round has no
 * "rounds naming no finding" rate, and printing `0%` there would read as
 * evidence that this session's reviewers always named their findings.
 */
function roundsTable(
  plan: readonly SessionRound[],
  code: readonly SessionRound[],
): string[] {
  const metrics = [
    ...(plan.length > 0 ? computeSessionRounds({ stage: "plan", rounds: plan }) : []),
    ...(code.length > 0 ? computeSessionRounds({ stage: "code", rounds: code }) : []),
  ];
  if (metrics.length === 0) return [];
  return [
    "",
    "**Rounds (this session only):**",
    "",
    "| Measure | n / d | Rate |",
    "|---|---|---|",
    ...metrics.map((m) =>
      `| ${m.label} | ${m.numerator} / ${m.denominator} | `
      + `${m.value === null ? "-" : `${(m.value * 100).toFixed(0)}%`} |`,
    ),
  ];
}

function buildReviewSection(state: FullSessionState): string {
  const plan = state.reviews.plan;
  const code = state.reviews.code;

  // T-470: computed BEFORE the empty-review return, and appended to it too.
  //
  // A completed ceiling park is EXACTLY this shape: `parkCurrentTicket` clears
  // both review arrays before the HANDOVER transition, so a session that
  // stopped because review would not converge arrives here with nothing in
  // either. Appending the ceiling only after this return meant the one report
  // that most needs the explanation said "No reviews recorded" and dropped it
  // -- the section was unreachable in the only state it was written for.
  const ceiling = ceilingLines(state);

  if (plan.length === 0 && code.length === 0) {
    // T-461: an empty review section has two very different causes, and a
    // reader deciding whether a commit was reviewed needs to be told which.
    // "No reviews recorded" reads as an anomaly; a deliberate `off` is not one,
    // and saying so here is the whole point of the dial being disclosed.
    //
    // A ceiling escalation is a THIRD cause, and the arrays are empty because
    // the park cleared them rather than because nothing ran.
    if (ceiling.length > 0) {
      return ["## Review Stats", "", "The review history was cleared when the item was released.", ...ceiling].join("\n");
    }
    if (effectiveReviewEffort(state, "CODE_REVIEW") === "off") {
      return `## Review Stats\n\n${effortDisclosureLine(state, "CODE_REVIEW")} Reviews were skipped for this work; no review verdict exists.`;
    }
    return "## Review Stats\n\nNo reviews recorded.";
  }

  const lines = ["## Review Stats", ""];

  /**
   * T-488: the round's provenance, with every absent value printed as `-`.
   *
   * A dash is the point of this function. The alternative a report reaches for
   * is a plausible filler -- the session's configured model, the last model
   * seen, a generation guessed from the round number -- and every one of those
   * reads as a FACT to whoever is looking at the report, which is exactly the
   * kind of unrecoverable fiction this ticket exists to stop the record telling.
   *
   * Returns null, rendering nothing at all, for a round with no spine on it.
   * That is not the same evasion: such a record predates these fields entirely,
   * and four dashes would imply the round was measured and came back empty,
   * when in truth it was never measured. Its line renders exactly as it did
   * before this ticket, which is the honest rendering of a legacy record.
   */
  const provenanceLine = (r: {
    reviewAttemptId?: unknown;
    reviewerIdentity?: { model?: unknown; evidence?: unknown } | null;
    backendRunId?: unknown;
    backendRunIdKind?: unknown;
    backendTurnId?: unknown;
    generation?: unknown;
    artifactStatus?: unknown;
  }): string | null => {
    if (typeof r.reviewAttemptId !== "string" || r.reviewAttemptId === "") return null;
    const dash = (v: unknown): string =>
      typeof v === "string" && v !== "" ? safe(v) : typeof v === "number" ? String(v) : "-";
    const join = deriveJoinAvailability({
      ...(typeof r.backendRunId === "string" ? { backendRunId: r.backendRunId } : {}),
      ...(typeof r.backendRunIdKind === "string"
        ? { backendRunIdKind: r.backendRunIdKind as "codex-session" | "agent-dispatch" | "lens-review" }
        : {}),
      ...(typeof r.backendTurnId === "string" ? { backendTurnId: r.backendTurnId } : {}),
    });
    return [
      `      model ${dash(r.reviewerIdentity?.model)}`,
      `evidence ${dash(r.reviewerIdentity?.evidence)}`,
      `join ${join}`,
      `gen ${dash(r.generation)}`,
      // "artifact -" means the value was not recorded and the artifact's
      // existence is UNKNOWN. It never means the artifact is missing, and a
      // reader must not read it as either present or absent. It is also not a
      // date stamp: a round written today omits fields its backend could not
      // supply, so absence never establishes that a record is old.
      `artifact ${dash(r.artifactStatus)}`,
    ].join(", ");
  };

  // The ROUND COUNT stays outside the bound in both blocks: it is the answer
  // this section exists to give, and only the per-round detail is cut.
  const roundLine = (r: {
    round: unknown; verdict: unknown; findingCount: number; criticalCount: number;
    majorCount: number; reviewer: unknown; unresolvedCriticalCount?: number; effort?: unknown;
    // T-488 spine, all optional -- a legacy record carries none of it.
    reviewAttemptId?: unknown;
    reviewerIdentity?: { model?: unknown; evidence?: unknown } | null;
    backendRunId?: unknown; backendRunIdKind?: unknown; backendTurnId?: unknown;
    generation?: unknown; artifactStatus?: unknown;
  }): string => {
    const unresolved = r.unresolvedCriticalCount === undefined ? "" : `, ${r.unresolvedCriticalCount} unresolved critical`;
    // T-461: only levels OTHER than standard are named. Standard is what every
    // pre-dial round ran at and what an unset dial still runs at, so annotating
    // it would add a token to every line of every report to say "nothing
    // changed". A round with no recorded level is a pre-dial record and is left
    // alone for the same reason.
    const effort = isReviewEffort(r.effort) && r.effort !== "standard" ? ` @ ${r.effort}` : "";
    const head = `  - Round ${safe(r.round)}: ${safe(r.verdict)} (${r.findingCount} findings, ${r.criticalCount} critical${unresolved}, ${r.majorCount} major) -- ${safe(r.reviewer)}${effort}`;
    const spine = provenanceLine(r);
    return spine === null ? head : `${head}\n${spine}`;
  };

  if (plan.length > 0) {
    lines.push(`**Plan reviews:** ${plan.length} round(s)`);
    lines.push(
      ...boundedLines(plan.map(roundLine), {
        maxLines: MAX_SECTION_LINES,
        noun: "plan review rounds",
        fullSetHint: "The complete list is in `reviews.plan` of state.json.",
      }),
    );
  }

  if (code.length > 0) {
    lines.push(`**Code reviews:** ${code.length} round(s)`);
    lines.push(
      ...boundedLines(code.map(roundLine), {
        maxLines: MAX_SECTION_LINES,
        noun: "code review rounds",
        fullSetHint: "The complete list is in `reviews.code` of state.json.",
      }),
    );
  }

  const totalFindings = [...plan, ...code].reduce((sum, r) => sum + r.findingCount, 0);
  lines.push("", `**Total findings:** ${totalFindings}`);
  lines.push(...roundsTable(plan, code));

  lines.push(...ceiling);

  return lines.join("\n");
}

/**
 * The round-ceiling escalation, when one ended the session (T-470).
 *
 * It needs its own surfacing because nothing else renders it: the termination
 * reason is generic, and `landingDecision` -- the only comparable record -- is
 * not rendered at all. Without this, the single most consequential fact about
 * the session ("it stopped because review would not converge, and here is what
 * it filed") would be reachable only by reading state.json.
 *
 * Deliberately says what to DO next. A reader arriving at a session that
 * stopped this way needs the item, the round, the issues, and the fact that the
 * working tree still holds uncommitted work -- that last one is why the session
 * ended rather than moving on, and it is not inferable from anything else here.
 */
function ceilingLines(state: FullSessionState): string[] {
  const escalation = state.pendingCeilingEscalation;
  if (!escalation) return [];
  const counter = state.codeReviewRoundCounter;

  // The ESCALATION's work item is canonical, not the session's current one. A
  // recovered or claim-lost session can be holding a different item by the time
  // this renders, and attributing one item's non-convergence to another is a
  // wrong answer rather than a vague one. The display id is borrowed only when
  // the two agree, ON BOTH id AND kind -- a same-id different-kind pairing is
  // not the same item.
  const sameItem = !!escalation.workItemId && (
    escalation.kind === "ticket"
      ? state.ticket?.id === escalation.workItemId
      : state.currentIssue?.id === escalation.workItemId
  );
  const currentDisplayId = escalation.kind === "ticket"
    ? state.ticket?.displayId
    : (state.currentIssue ? displayIdOf(state.currentIssue) : undefined);
  const rawItem = escalation.displayId
    ?? (sameItem ? currentDisplayId : undefined)
    ?? escalation.workItemId
    ?? state.ticket?.displayId
    ?? state.ticket?.id
    ?? "the item";
  // ISS-1049/ISS-1032: kind-aware label, mirroring `issue-fix.ts`'s own
  // `displayIdOf` usage -- a bare id no longer disambiguates ticket from issue.
  const item = rawItem === "the item" ? rawItem : `${escalation.kind === "issue" ? "issue" : "ticket"} ${rawItem}`;

  // THIS escalation's issues only. `filedDeferrals` is session-wide and also
  // holds deferrals filed earlier for unrelated reasons; listing those under a
  // "round ceiling" heading would attribute other work to this stop.
  const mine = new Set(escalation.fingerprints ?? []);
  // BOUNDED, like every other list this formatter renders. Session state is
  // treated as untrusted here, and an unbounded id list would undercut the
  // output-size protection the rest of the file applies.
  const filed = boundedList(
    (state.filedDeferrals ?? [])
      .filter((d) => mine.has(d.fingerprint))
      .map((d) => d.issueId)
      .filter(Boolean)
      .map((id) => safe(id)),
    { noun: "issues" },
  );

  // ISS-1114: BRANCH on what actually fired. An absent `trigger` is the
  // round-ceiling park, because every record written before the field existed
  // was one -- so legacy records render byte-identically to before.
  //
  // The round-ceiling copy below is not merely imprecise for an empty-verdict
  // stop, it is false in every clause: that stop can happen on round 1, the cap
  // is not what was reached, and there are zero findings outstanding by
  // definition of the trigger. A reader arriving at a parked item needs to know
  // that a reviewer stopped answering, not to be sent looking for a round
  // ceiling that never fired.
  const head = escalation.trigger === "empty-verdict"
    ? [
      "",
      "### Review returned no findings to act on",
      "",
      `Code review stopped at round ${safe(escalation.round)} on **${safe(item)}**: the reviewer returned a verdict requesting changes while supplying no findings, and repeated it after the repair instruction was sent ${escalation.repairAttempts ?? 0} time(s).`,
      "",
      // The ambiguity is the point, and it is why the item was parked rather
      // than advanced: a payload with no findings is consistent with a clean
      // review that should have said approve AND with a review that never
      // completed, and nothing in the verdict separates them. Advancing would
      // have picked one of those readings silently.
      // "Parking was REQUESTED" rather than "the item WAS parked": this head
      // renders for an unfinished record too, where the park may not have
      // landed, and the unfinished branch below says exactly that. Claiming the
      // outcome here would contradict it two lines later.
      "A verdict with no findings cannot distinguish a review that had nothing to say from one that did not complete, so parking was requested rather than advancing on this verdict. Nothing was implemented and no round landed on it.",
    ]
    : [
      "",
      "### Round ceiling reached",
      "",
      `Code review stopped at round ${safe(escalation.round)} of a ceiling of ${safe(escalation.ceiling)} (cap ${safe(escalation.maxReviewRounds)} plus grace) on **${safe(item)}**, with ${escalation.unresolvedCritical} unresolved critical and ${escalation.unresolvedMajor} major finding(s) outstanding.`,
      "",
      // Deliberately NOT phrased as "unresolved criticals". `decideCeiling` fires
      // on any round that would continue rather than finalize, and a `reject`
      // verdict continues with zero criticals outstanding -- so this sentence
      // sitting under a report that just said "0 unresolved critical" would name
      // a cause that is not the one that fired.
      "The cap alone does not bound this case: forced landing requires a non-blocking outcome, so unresolved criticals and reject verdicts both continue past the cap without limit. The ceiling is what ends either loop.",
    ];

  // An UNFINISHED escalation makes no lifecycle claims.
  //
  // Filing happens before the park, and the `completed` marker commits with the
  // park transition -- three separate writes, not one. So an unfinished record
  // means either the filing or the park may still be outstanding: the item may
  // still be `inprogress`, and some findings may not have reached the ledger.
  // Saying otherwise would send the next reader looking for issues that do not
  // exist.
  // Whether this stop OWNS any findings. A reject verdict trips the ceiling with
  // none, and every sentence below that mentions filing would then be describing
  // artifacts that do not exist.
  //
  // Scoped to THIS ESCALATION, and the copy says so. An empty record does not
  // mean the round produced no issue work: `deferred` findings are deliberately
  // not the escalation's, and the ordinary deferral path files them. So the
  // wording is "no open findings of its own", never "nothing is owed to the
  // ledger" -- that second claim is not this record's to make.
  const owns = (escalation.fingerprints ?? []).length > 0 || (escalation.findings ?? []).length > 0;

  // codex round-2 finding: issues have no ticket claim and never sit at
  // `inprogress` -- their lifecycle is `resolved`/`open` plus an earmark, and
  // `parkCurrentIssue` REOPENS (or leaves untouched), it never "releases a
  // claim". The unfinished/completed copy below must say so, not borrow the
  // ticket's claim/inprogress language for an issue escalation.
  const isIssue = escalation.kind === "issue";

  if (!escalation.completed) {
    const ledger = !owns
      ? "This ceiling stop had no open findings of its own to file."
      : filed.length > 0
        ? `Some findings were filed (${filed}) and others may not have been.`
        : "The findings may not have reached the ledger yet.";
    const stateNote = isIssue
      ? `${safe(item)} may still show status \`resolved\` from this session's fix, with ownership not yet reverified`
      : `${safe(item)} may still be \`inprogress\``;
    return [
      ...head,
      "",
      `**This stop did not finish.** ${ledger} ${stateNote}, and its work is uncommitted in the working tree. Check the ledger before starting the next session.`,
      ...(counter && counter.workItemId === escalation.workItemId && counter.kind === escalation.kind
        ? ["", `Rounds recorded for this item: ${counter.completedRounds}.`]
        : []),
    ];
  }

  // Deliberately does NOT assert the outcome unconditionally. `parkCurrentTicket`
  // releases the claim and flips status only when this session still owns the
  // stamp; `parkCurrentIssue` reopens to `open` only when it can still prove
  // ownership (status plus, post-Amendment-A5, an exact resolution-epoch
  // match). The not-ours outcome, for either kind, leaves the item exactly as
  // another session left it, and that outcome is not recorded here.
  const outcomeNote = isIssue
    ? "It was reopened to `open` unless the issue was missing or ownership could no longer be proven from its status, earmark, and resolution epoch; in that case it was left untouched"
    : "Its claim was released back to the backlog unless it had already moved to another session";

  return [
    ...head,
    "",
    filed.length > 0
      ? `The outstanding findings were filed as issues: ${filed}.`
      : "This ceiling stop had no open findings of its own to file.",
    "",
    `**The work for ${safe(item)} is still uncommitted in the working tree.** That is why the session ended here rather than moving to the next item. ${outcomeNote}, so check its ledger state, and review the tree before starting the next session${owns ? "; the filed issues carry what review could not get resolved" : "; this ceiling stop filed nothing of its own"}.`,
    ...(counter && counter.workItemId === escalation.workItemId && counter.kind === escalation.kind
      ? ["", `Rounds recorded for this item: ${counter.completedRounds}.`]
      : []),
  ];
}

function buildEventSection(events: { events: readonly EventEntry[]; malformedCount: number }): string {
  if (events.events.length === 0 && events.malformedCount === 0) {
    return "## Event Timeline\n\nNot available.";
  }

  const capped = events.events.slice(-50);
  const omitted = events.events.length - capped.length;
  const lines = ["## Event Timeline", ""];
  if (omitted > 0) {
    lines.push(`*${omitted} earlier events omitted*`, "");
  }
  for (const e of capped) {
    const ts = e.timestamp ? e.timestamp.slice(11, 19) : "??:??:??";
    // BOTH sides. `JSON.stringify` encodes the C0 range, which is what made
    // leaving the value alone look safe -- but it passes U+2028, U+2029 and the
    // bidi controls through literally, at any depth of nesting. Those are line
    // breaks and visual reordering to a renderer, so a schema-valid events.log
    // value could still forge a bullet in this timeline.
    const detail = e.data
      // `safeJson`, not `JSON.stringify`: event data is arbitrary and comes off
      // disk, so the bare call throws on a value too deep to encode -- killing
      // the report the operator is reading -- returns `undefined` for a
      // function or a symbol, which then prints as the word "undefined", and
      // has no bound at all, so one event can bury every other line.
      // Bounded across the KEYS too. One event with a thousand fields is as
      // long as a thousand events, and each value being capped does nothing
      // about that.
      ? boundedList(
          Object.entries(e.data).map(([k, v]) => `${safe(k)}=${safe(safeJson(v, MAX_DISPLAY_SERIALIZED_LENGTH))}`),
          { separator: " ", noun: "fields" },
        )
      : "";
    lines.push(`- ${codeSpan(ts)} [${safe(e.type)}] ${detail}`.trimEnd());
  }
  if (events.malformedCount > 0) {
    lines.push("", `*${events.malformedCount} malformed event line(s) skipped*`);
  }
  return lines.join("\n");
}

function buildPressureSection(state: FullSessionState): string {
  const p = state.contextPressure;
  return [
    "## Context Pressure",
    "",
    `- **Level:** ${safe(p.level)}`,
    `- **Guide calls:** ${p.guideCallCount}`,
    `- **Tickets completed:** ${p.ticketsCompleted}`,
    `- **Compactions:** ${p.compactionCount}`,
    `- **Events log:** ${p.eventsLogBytes} bytes`,
  ].join("\n");
}

function buildGitSection(state: FullSessionState, gitLog: string[] | null): string {
  const lines = [
    "## Git Summary",
    "",
    `- **Branch:** ${safe(state.git.branch ?? "unknown")}`,
    `- **Init HEAD:** ${codeSpan(state.git.initHead ?? "?")}`,
    `- **Expected HEAD:** ${codeSpan(state.git.expectedHead ?? "?")}`,
  ];

  if (gitLog && gitLog.length > 0) {
    lines.push("", "**Commits:**");
    lines.push(
      ...boundedLines(gitLog.map((c) => `- ${safe(c)}`), {
        maxLines: MAX_SECTION_LINES,
        noun: "commits",
        fullSetHint: "The complete list is in `git log`.",
      }),
    );
  } else {
    lines.push("", "Commits: Not available.");
  }

  return lines.join("\n");
}

function buildProblems(
  state: FullSessionState,
  events: { events: readonly EventEntry[]; malformedCount: number },
): string[] {
  const problems: string[] = [];

  if (state.terminationReason && state.terminationReason !== "normal") {
    problems.push(`Abnormal termination: ${state.terminationReason}`);
  }

  if (events.malformedCount > 0) {
    problems.push(`${events.malformedCount} malformed event line(s) in events.log`);
  }

  for (const e of events.events) {
    if (e.type.includes("error") || e.type.includes("exhaustion")) {
      // Bounded and non-throwing, for the same reason the timeline is: this is
      // arbitrary data off disk, in the section that exists to explain what
      // went wrong.
      problems.push(`[${e.type}] ${e.timestamp ?? ""} ${safeJson(e.data, MAX_DISPLAY_SERIALIZED_LENGTH)}`);
    } else if (e.data?.result === "exhaustion") {
      problems.push(`[${e.type}] exhaustion at ${e.timestamp ?? ""}`);
    }
  }

  if (state.deferralsUnfiled) {
    problems.push("Session has unfiled deferrals");
  }

  const diagnostics = analyzeSessionDiagnostics(state, events);
  for (const diagnostic of diagnostics.diagnostics) {
    problems.push(`[${diagnostic.code}] ${diagnostic.message}`);
  }

  return problems;
}

function buildProblemsSection(
  state: FullSessionState,
  events: { events: readonly EventEntry[]; malformedCount: number },
): string {
  const problems = buildProblems(state, events);
  if (problems.length === 0) {
    return "## Problems\n\nNone detected.";
  }
  // A PROSE budget. These are authored sentences, not field values, and the
  // label width cut them before their conclusion -- the same defect the
  // diagnostic reasons had, in the section an operator reads first.
  return [
    "## Problems",
    "",
    // Bounded as a SECTION. Each problem is capped and the number of them is
    // driven by `events.log`, so an error-heavy session could still produce an
    // unbounded report -- in the section written to be read first.
    ...boundedLines(problems.map((p) => `- ${safe(p, MAX_PROSE_LENGTH)}`), {
      maxLines: MAX_PROBLEM_LINES,
      noun: "problems",
      fullSetHint: "The complete set is in `events.log` and in the JSON output.",
    }),
  ].join("\n");
}

/**
 * A table CELL, which needs nothing `safe()` does not already do.
 *
 * `|` ends a cell, so an untrusted title carrying one splits the row and shifts
 * every value after it into the wrong column -- a ticket can relabel its own
 * duration, or push text into a neighbour's cell. `escapeMarkdownDocument`
 * covers the pipe along with everything else, and its ordering is the one this
 * needed independently: it doubles existing backslashes BEFORE escaping
 * anything else, so a value containing `\|` cannot pair its own backslash with
 * the escape and leave the pipe structural.
 *
 * Kept as a named alias rather than inlined because the call sites read as a
 * table and the name is what says so. There is deliberately only ONE escaping
 * behaviour in this file: the compact report and the full report are the same
 * kind of sink, and an earlier split into `safe`/`docSafe` meant a value was
 * document-escaped or not depending on which report happened to render it.
 */
function cell(value: unknown): string {
  return safe(value);
}

// --- Compact report (T-185) ---

export interface CompactReportData {
  readonly state: FullSessionState;
  readonly endedAt?: string;
  readonly remainingWork?: {
    tickets: { id: string; title: string; displayId?: string }[];
    issues: { id: string; title: string; severity: string; displayId?: string }[];
  };
}

export function formatCompactReport(data: CompactReportData): string {
  const { state, remainingWork } = data;
  const endTime = data.endedAt ?? state.lastGuideCall ?? new Date().toISOString();
  const duration = state.startedAt ? formatDuration(state.startedAt, endTime) : "unknown";
  const ticketCount = state.completedTickets.length;
  const issueCount = (state.resolvedIssues ?? []).length;
  const reviewRounds = state.reviews.plan.length + state.reviews.code.length;
  const totalFindings = [...state.reviews.plan, ...state.reviews.code].reduce((s, r) => s + r.findingCount, 0);
  const compactions = state.contextPressure?.compactionCount ?? 0;

  const lines = [
    "## Session Report",
    "",
    `**Duration:** ${duration} | **Tickets:** ${ticketCount} | **Issues:** ${issueCount} | **Reviews:** ${reviewRounds} rounds (${totalFindings} findings) | **Compactions:** ${compactions}`,
  ];

  if (ticketCount > 0) {
    lines.push("", "### Completed", "| Ticket | Title | Duration |", "|--------|-------|----------|");
    for (const t of state.completedTickets) {
      const ticketDuration = t.startedAt && t.completedAt
        ? formatDuration(t.startedAt, t.completedAt)
        : "--";
      // The pipe escape was here already; the rest was not. This table lands in
      // a HANDOVER (T-185), so a newline in a completed ticket's title forges a
      // row in the document the next session reads as the record of what
      // happened -- and the id was not escaped at all, so it could split the row
      // on its own.
      lines.push(`| ${cell(displayIdOf(t))} | ${cell(t.title ?? "")} | ${cell(ticketDuration)} |`);
    }

    // Avg time per ticket
    const timings = state.completedTickets
      .filter(t => t.startedAt && t.completedAt)
      .map(t => new Date(t.completedAt!).getTime() - new Date(t.startedAt!).getTime());
    if (timings.length > 0) {
      const avgMs = timings.reduce((a, b) => a + b, 0) / timings.length;
      const avgMins = Math.round(avgMs / 60000);
      lines.push("", `**Avg time per ticket:** ${avgMins}m`);
    }
  }

  if (remainingWork && (remainingWork.tickets.length > 0 || remainingWork.issues.length > 0)) {
    lines.push("", "### What's Left");
    // Ledger-sourced rather than state.json-sourced, so a lower-trust tier than
    // the table above -- but these are bullets in the same handover, and the
    // same newline forges the same kind of entry.
    lines.push(
      ...boundedLines(
        remainingWork.tickets.map((t) => `- ${safe(displayIdOf(t))}: ${safe(t.title)} (unblocked)`),
        {
          maxLines: MAX_SECTION_LINES,
          noun: "unblocked tickets",
          fullSetHint: "The complete list is in the ledger.",
        },
      ),
    );
    lines.push(
      ...boundedLines(
        remainingWork.issues.map((i) => `- ${safe(displayIdOf(i))}: ${safe(i.title)} (${safe(i.severity)})`),
        {
          maxLines: MAX_SECTION_LINES,
          noun: "open issues",
          fullSetHint: "The complete list is in the ledger.",
        },
      ),
    );
  }

  return lines.join("\n");
}

// --- Helpers ---

function formatDuration(start: string, end: string): string {
  try {
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (isNaN(ms) || ms < 0) return "unknown";
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
  } catch {
    return "unknown";
  }
}
