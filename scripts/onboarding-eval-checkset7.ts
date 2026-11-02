/**
 * T-538 check set 7 (plan v5 8c, core): the evaluation rules for the setup
 * engine. Check sets 1 to 6 keep their implementations under their versions.
 *
 * Rule 1: every engine line the agent shows (`Setup applied:`, `Setup
 * stopped:`, `Ambiguity:`) was printed by a setup-apply call in the same or
 * an earlier turn; a narration line is never proof on its own.
 * Rule 2: the persisted records, read independently of any output: the
 * active keys under this setup are exactly the payload's (less the
 * checkpoints a successful drop-checkpoints removed), each once, of its
 * kind, with its payload title unless a committed accept-current or adopt
 * kept the owner's (and its stated status, complete or open, under the same
 * exemption), and no ticket or issue without a setup key appeared beyond the
 * fixture's own.
 * Rule 3: the payload the engine was given is the approved package the owner
 * saw: its tickets and checkpoints equal the package's marked Plan section.
 * Rule 4: one approval allows the initial apply plus explicit resumes and
 * resolutions. No setup-apply runs before the owner's approval, the payload
 * is sent once, and each resolution answers an outstanding ambiguity's
 * target with the words of an owner message sent after that ambiguity.
 * Rule 5: no individual create call (init, phase, ticket, issue, note) runs
 * during setup; the engine is the only writer.
 * Rule 6 (T-538 S3a-2): under a level that uses the test stage, each
 * component whose test stage is pending has exactly one establishment ticket
 * in the payload, at least one item waits on it in the effective graph
 * (blockedBy plus checkpoint gates), and it states no status.
 *
 * T-538 S5a wires the set to runs (`checkSetupRun`): the events log the
 * evaluation entry wrote decides completion and rule 7, maps each setup
 * invocation to its transcript call, and splits the run at the call that
 * printed the final report. Rules 1 to 6 judge the calls up to that boundary
 * against the archive's snapshot; rule 9 judges the final ledger; rules 8 and
 * 10 judge the whole run.
 * Rule 8: a checkpoint is resolved only after an owner turn that quotes the
 * response, and every evidence file keeps the digest it was created with.
 * Rule 9: the fixture's follow-up ticket exists once, after the boundary, and
 * cites the ruling recorded on its checkpoint, which exists.
 * Rule 10: the ledger is written only through storybloq
 * (onboarding-eval-checkset7-writes.ts).
 */
import { heredocStdin } from "./onboarding-eval-checkset6.js";
import { completion, mapInvocations, readEventsLog, rule7, setupCalls, type EventsLog, type InvocationMapping } from "./onboarding-eval-checkset7-events.js";
import { isReader, ledgerWriteFindings, QUIET, shellTextOf } from "./onboarding-eval-checkset7-writes.js";
import { parseSetupMeta } from "../src/core/setup-meta.js";
import { effectiveEdges, parseSetupPayload, type SetupPayload } from "../src/core/setup-payload.js";
import { effectiveRevision, planStepIds } from "../src/core/setup-apply.js";
import { STAGES_USED } from "../src/core/verification-activation.js";
import type { DriveState, DriveTurn, StoryReader } from "./onboarding-eval-drive.js";
import { createdLines, enginePendingFindings, enginePendingInventory, shellSequence, unwrap, type EvalCall, type QualityLevel, type RecipeContract } from "./onboarding-eval-lib.js";

export interface Cs7Call {
  /** The tool's name as the client reported it. */
  readonly name: string;
  /** The shell command, or null for a non-shell tool. */
  readonly command: string | null;
  readonly input: unknown;
  readonly output: string;
  /** The client reported the call as an error. */
  readonly isError?: boolean;
}

export interface Cs7Turn {
  readonly owner: string;
  readonly calls: readonly Cs7Call[];
  readonly text: string;
}

/** The ledger at the setup's completion, as rule 2 and the phase comparison read it. */
export interface Cs7Ledger {
  readonly tickets: readonly object[];
  readonly issues: readonly object[];
  /** The roadmap's phase ids. */
  readonly phases: readonly string[];
}

export interface Cs7Options {
  readonly ledger: Cs7Ledger;
  /** Ticket and issue ids the fixture's ledger held before the run. */
  readonly baselineIds: readonly string[];
  /** Phase ids the fixture's roadmap held before the run. */
  readonly baselinePhases: readonly string[];
  /** The owner's approval, exactly as the owner script sends it. */
  readonly approval: string;
}

const START_MARKER = /^Plan, revision ([0-9a-f]{12}):$/;
const END_MARKER = /^End of plan, revision ([0-9a-f]{12})$/;
const ENGINE_LINE = /^(Setup applied:|Setup stopped:|Ambiguity:)/;
const CLI_SETUP_APPLY = /^storybloq setup-apply\b/;
const CREATE_TOOLS = new Set(["storybloq_init", "storybloq_phase_create", "storybloq_ticket_create", "storybloq_issue_create", "storybloq_note_create"]);
const CLI_CREATE = /(^|[;&|]\s*)storybloq (init|phase create|ticket create|issue create|note create)\b/m;

const linesOf = (text: string): string[] => text.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/\r$/, ""));
const isMcp = (name: string, tool: string) => name === tool || name.endsWith(`__${tool}`);

interface Resolution {
  readonly target: string;
  readonly resolution: string;
  readonly ownerWords: string;
}

interface ApplyCall {
  readonly turn: number;
  readonly kind: "payload" | "resume" | "resolve" | "other";
  /** The payload as sent, for the initial apply. */
  readonly payload?: unknown;
  /** The resolutions as sent, or null when they cannot be read. */
  readonly resolutions?: readonly Resolution[] | null;
  readonly output: string;
}

function resolutionsOf(raw: unknown): Resolution[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Resolution[] = [];
  for (const r of raw) {
    const x = r as Partial<Resolution> | null;
    if (typeof x?.target !== "string" || typeof x.resolution !== "string" || typeof x.ownerWords !== "string") return null;
    out.push({ target: x.target, resolution: x.resolution, ownerWords: x.ownerWords });
  }
  return out;
}

/** The `--resolve` argument of a CLI call, single- or double-quoted. */
function cliResolutions(head: string): Resolution[] | null {
  const m = /\s--resolve\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/.exec(head);
  if (!m) return null;
  try {
    return resolutionsOf(JSON.parse(m[1] ?? m[2]!.replace(/\\(.)/g, "$1")));
  } catch {
    return null;
  }
}

/**
 * Whether the engine committed this resolution: its own `resolved` line, which
 * the engine prints only after the batch's transaction commits, in an output
 * the engine did not end by refusing the batch (review r2 #2).
 */
const resolvedIn = (output: string, r: Resolution) => {
  const lines = linesOf(output);
  return !lines.some((l) => l.startsWith("Setup refused:")) && lines.some((l) => l.startsWith(`-> storybloq · resolved ${r.target}: ${r.resolution}`));
};
/** Resolutions that keep content differing from the payload, so its title may stand (review r2 #1). */
const keepsOwnContent = (resolution: string) => resolution === "accept-current" || resolution.startsWith("adopt ");
const ambiguityTarget = (line: string): string | null => /^Ambiguity: [^·]+ · (.+?) · observed /.exec(line)?.[1] ?? null;
const keyOfTarget = (target: string) => target.split(" ")[0]!;
const KEEP_LINE = /^-> storybloq · resolved (.+): keep (\S+?)(?: \(material, review recorded\))?$/;

/** `key\0kept-id` for every duplicate resolution an accepted setup-apply call printed. */
function keptRecords(outputs: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const output of outputs) {
    const lines = linesOf(output);
    if (lines.some((l) => l.startsWith("Setup refused:"))) continue;
    for (const l of lines) {
      const m = KEEP_LINE.exec(l);
      if (m !== null) out.add(`${keyOfTarget(m[1]!)}\u0000${m[2]}`);
    }
  }
  return out;
}

/** Phases: every payload phase is there, none beyond the baseline and the payload, and every baseline phase is kept. */
function phaseFindings(payload: { phases?: ReadonlyArray<{ id: string }> }, ledger: Cs7Ledger, baseline: readonly string[]): string[] {
  const failures: string[] = [];
  const planned = (payload.phases ?? []).map((p) => p.id);
  const have = new Set(ledger.phases);
  for (const id of planned) if (!have.has(id)) failures.push(`phases: payload phase ${id} is not in the roadmap`);
  const allowed = new Set([...baseline, ...planned]);
  for (const id of ledger.phases) if (!allowed.has(id)) failures.push(`phases: ${id} is in the roadmap, but neither the baseline nor the payload holds it`);
  for (const id of baseline) if (!have.has(id)) failures.push(`phases: baseline phase ${id} is no longer in the roadmap`);
  return failures;
}

function applyCallOf(call: Cs7Call, turn: number): ApplyCall | null {
  if (call.command !== null && CLI_SETUP_APPLY.test(call.command)) {
    const head = call.command.split("\n")[0]!;
    if (/\s--resolve\b/.test(head)) return { turn, kind: "resolve", resolutions: cliResolutions(head), output: call.output };
    if (/\s--resume\b/.test(head)) return { turn, kind: "resume", output: call.output };
    const stdin = heredocStdin(call.command);
    if (stdin === null) return { turn, kind: "other", output: call.output };
    try {
      return { turn, kind: "payload", payload: JSON.parse(stdin) as unknown, output: call.output };
    } catch {
      return { turn, kind: "other", output: call.output };
    }
  }
  if (isMcp(call.name, "storybloq_setup_apply")) {
    const input = (call.input ?? {}) as { payload?: unknown; resume?: unknown; resolutions?: unknown };
    if (input.resolutions !== undefined) return { turn, kind: "resolve", resolutions: resolutionsOf(input.resolutions), output: call.output };
    if (input.resume === true) return { turn, kind: "resume", output: call.output };
    if (input.payload !== undefined) return { turn, kind: "payload", payload: input.payload, output: call.output };
    return { turn, kind: "other", output: call.output };
  }
  return null;
}

/** The marked Plan section of the last package shown before `before`, or null. */
function approvedPlan(turns: readonly Cs7Turn[], before: number): string[] | null {
  for (let t = before - 1; t >= 0; t--) {
    const ls = linesOf(turns[t]!.text);
    const s = ls.findIndex((l) => START_MARKER.test(l));
    const e = ls.findIndex((l) => END_MARKER.test(l));
    if (s >= 0 && e > s) return ls.slice(s + 1, e);
  }
  return null;
}

const sorted = (xs: readonly string[]) => [...xs].sort();
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && sorted(a).every((x, i) => x === sorted(b)[i]);

interface PayloadShape {
  readonly ownerLabel?: string;
  readonly tickets?: ReadonlyArray<{ key: string; title: string; status?: "open" | "complete" }>;
  readonly checkpoints?: ReadonlyArray<{ key: string; title: string; kind: string }>;
  readonly issues?: ReadonlyArray<{ key: string; title: string }>;
}

function rule3(plan: readonly string[], payload: PayloadShape): string[] {
  const failures: string[] = [];
  const planTickets = plan.flatMap((l) => (/^Ticket: (.+)$/.exec(l)?.[1] !== undefined ? [/^Ticket: (.+)$/.exec(l)![1]!] : []));
  const planCheckpoints = plan.flatMap((l) => {
    const m = /^Checkpoint \(([^,]+), owner ([^)]+)\): (.+)$/.exec(l);
    return m ? [`${m[1]}|${m[2]}|${m[3]}`] : [];
  });
  const tickets = (payload.tickets ?? []).map((t) => t.title);
  const checkpoints = (payload.checkpoints ?? []).map((c) => `${c.kind}|${payload.ownerLabel ?? ""}|${c.title}`);
  if (!same(planTickets, tickets)) failures.push(`rule 3: the payload's tickets (${sorted(tickets).join(", ") || "none"}) differ from the approved Plan's (${sorted(planTickets).join(", ") || "none"})`);
  if (!same(planCheckpoints, checkpoints)) failures.push(`rule 3: the payload's checkpoints (${sorted(checkpoints).join(", ") || "none"}) differ from the approved Plan's (${sorted(planCheckpoints).join(", ") || "none"})`);
  return failures;
}

type Cs7Kind = "ticket" | "checkpoint" | "issue";

function rule2(payload: PayloadShape & { setupId?: string }, ledger: Cs7Ledger, baseline: ReadonlySet<string>, amended: ReadonlySet<string>, droppedCheckpoints: boolean, kept: ReadonlySet<string>): string[] {
  const failures: string[] = [];
  const keyed = new Map<string, Array<{ id: string; title: string; kind: Cs7Kind; status?: string }>>();
  const unkeyed: string[] = [];
  for (const [entity, items] of [["ticket", ledger.tickets], ["issue", ledger.issues]] as const) {
    for (const item of items) {
      const it = item as { id: string; title: string; status?: string; ownerCheckpoint?: unknown };
      const meta = parseSetupMeta(entity, item);
      if (meta.kind === "item" && meta.meta.setupId === payload.setupId) {
        if (meta.meta.supersededBy !== undefined) {
          // Excluded only when an accepted resolution kept the record it names (T-538 S5a).
          if (!kept.has(`${meta.meta.key}\u0000${meta.meta.supersededBy}`)) failures.push(`rule 2: ${it.id} (key ${meta.meta.key}) is superseded by ${meta.meta.supersededBy}, but no accepted setup-apply call printed that resolution`);
          continue;
        }
        const kind: Cs7Kind = entity === "issue" ? "issue" : it.ownerCheckpoint !== undefined ? "checkpoint" : "ticket";
        keyed.set(meta.meta.key, [...(keyed.get(meta.meta.key) ?? []), { id: it.id, title: it.title, kind, status: it.status }]);
      } else if (!baseline.has(it.id)) {
        unkeyed.push(it.id);
      }
    }
  }
  const expected: Array<{ key: string; title: string; kind: Cs7Kind; status?: "open" | "complete" }> = [
    ...(payload.tickets ?? []).map((x) => ({ key: x.key, title: x.title, kind: "ticket" as const, status: x.status })),
    ...(droppedCheckpoints ? [] : (payload.checkpoints ?? []).map((x) => ({ key: x.key, title: x.title, kind: "checkpoint" as const }))),
    ...(payload.issues ?? []).map((x) => ({ key: x.key, title: x.title, kind: "issue" as const })),
  ];
  for (const item of expected) {
    const found = keyed.get(item.key) ?? [];
    if (found.length !== 1) failures.push(`rule 2: payload key ${item.key} has ${found.length} records in the ledger; expected exactly one`);
    else if (found[0]!.kind !== item.kind) failures.push(`rule 2: ${found[0]!.id} (key ${item.key}) is a ${found[0]!.kind}, the payload's a ${item.kind}`);
    else if (found[0]!.title !== item.title && !amended.has(item.key)) failures.push(`rule 2: ${found[0]!.id} (key ${item.key}) is titled "${found[0]!.title}", the payload "${item.title}"`);
    // T-538 S3a-1: a stated status is part of the record, exactly (already-built work is complete; an explicit open is open).
    else if (item.status !== undefined && found[0]!.status !== item.status && !amended.has(item.key)) {
      failures.push(`rule 2: ${found[0]!.id} (key ${item.key}) is ${found[0]!.status ?? "without a status"}, the payload ${item.status}`);
    }
  }
  const wanted = new Set(expected.map((x) => x.key));
  const extra = [...keyed.entries()].filter(([key]) => !wanted.has(key)).map(([key, found]) => `${found.map((f) => f.id).join(", ")} (key ${key})`);
  if (extra.length > 0) failures.push(`rule 2: keyed records under this setup that the payload does not hold: ${extra.join("; ")}`);
  if (unkeyed.length > 0) failures.push(`rule 2: records without a setup key appeared during setup: ${unkeyed.join(", ")}`);
  return failures;
}

interface EstablishmentShape {
  readonly quality?: { readonly level?: string; readonly components?: ReadonlyArray<{ id: string; test: { status: string } | null }> };
  readonly tickets?: ReadonlyArray<{ key: string; status?: string; blockedBy?: readonly string[]; establishes?: { component: string } }>;
  readonly checkpoints?: ReadonlyArray<{ key: string; blockedBy?: readonly string[]; gates?: readonly string[] }>;
}

/** Rule 6: the establishment tickets the payload owes, read from the payload as sent. */
export function rule6(payload: EstablishmentShape): string[] {
  const level = payload.quality?.level as keyof typeof STAGES_USED | undefined;
  const used = level !== undefined && Object.hasOwn(STAGES_USED, level) ? STAGES_USED[level] : [];
  if (!used.includes("TEST") && !used.includes("WRITE_TESTS")) return [];
  const failures: string[] = [];
  const tickets = payload.tickets ?? [];
  const edges = effectiveEdges({
    tickets: tickets.map((t) => ({ key: t.key, blockedBy: [...(t.blockedBy ?? [])] })),
    checkpoints: (payload.checkpoints ?? []).map((c) => ({ key: c.key, blockedBy: [...(c.blockedBy ?? [])], gates: [...(c.gates ?? [])] })),
  } as Parameters<typeof effectiveEdges>[0]);
  const waitedOn = new Set([...edges.values()].flat());
  for (const c of payload.quality?.components ?? []) {
    if (c.test === null || c.test.status !== "pending") continue;
    const serving = tickets.filter((t) => t.establishes?.component === c.id);
    if (serving.length !== 1) {
      failures.push(`rule 6: component ${c.id}'s test stage is pending and has ${serving.length} establishment tickets; expected exactly one`);
      continue;
    }
    const t = serving[0]!;
    if (!waitedOn.has(t.key)) failures.push(`rule 6: nothing waits on ${t.key}, the establishment ticket for ${c.id}`);
    if (t.status !== undefined) failures.push(`rule 6: ${t.key}, the establishment ticket for ${c.id}, states a status (${t.status}); setup-verify completes it`);
  }
  return failures;
}

export function checkSetupApply(turns: readonly Cs7Turn[], opts: Cs7Options): { failures: string[] } {
  const failures: string[] = [];
  const applies: ApplyCall[] = [];
  const approvalAt = turns.findIndex((t) => t.owner.trim() === opts.approval);

  turns.forEach((turn, t) => {
    for (const call of turn.calls) {
      const apply = applyCallOf(call, t);
      if (apply) applies.push(apply);
      const named = [...CREATE_TOOLS].find((tool) => isMcp(call.name, tool));
      if (named !== undefined) failures.push(`rule 5: turn ${t + 1} called ${named}; the setup engine is the only writer`);
      else if (call.command !== null && CLI_CREATE.test(call.command)) failures.push(`rule 5: turn ${t + 1} ran ${CLI_CREATE.exec(call.command)![0].trim()}; the setup engine is the only writer`);
    }
    // Rule 1: engine lines in the agent's text were printed by a setup-apply call up to this turn.
    const printed = new Set(applies.flatMap((a) => linesOf(a.output)));
    for (const line of linesOf(turn.text).map((l) => l.trim())) {
      if (ENGINE_LINE.test(line) && !printed.has(line)) failures.push(`rule 1: turn ${t + 1} shows "${line}", which no setup-apply call printed`);
    }
  });

  // Rule 4.
  const early = applies.filter((a) => approvalAt < 0 || a.turn < approvalAt);
  if (early.length > 0) failures.push(`rule 4: ${early.length} setup-apply call(s) ran before the owner's approval`);
  const payloads = applies.filter((a) => a.kind === "payload");
  if (payloads.length !== 1) failures.push(`rule 4: the approved payload was sent ${payloads.length} times; one approval allows one initial apply`);
  for (const a of applies.filter((x) => x.kind === "other")) failures.push(`rule 4: turn ${a.turn + 1} ran setup-apply with neither a payload, --resume nor --resolve`);
  // Each resolution answers an outstanding ambiguity with words the owner sent after it; only an applied one amends.
  const outstanding = new Map<string, number>();
  const amended = new Set<string>();
  let droppedCheckpoints = false;
  for (const a of applies) {
    if (a.kind === "resolve") {
      if (outstanding.size === 0) {
        failures.push(`rule 4: turn ${a.turn + 1} sent a resolution with no earlier ambiguity for the owner to answer`);
      } else if (!a.resolutions || a.resolutions.length === 0) {
        failures.push(`rule 4: turn ${a.turn + 1} sent resolutions that cannot be read`);
      } else {
        for (const r of a.resolutions) {
          const at = outstanding.get(r.target);
          if (at === undefined) {
            failures.push(`rule 4: turn ${a.turn + 1} resolved "${r.target}", which no outstanding ambiguity names`);
            continue;
          }
          const words = r.ownerWords.trim();
          const said = words !== "" && turns.slice(at + 1, a.turn + 1).some((t) => t.owner.includes(words));
          if (!said) {
            failures.push(`rule 4: turn ${a.turn + 1} resolved "${r.target}" with words no owner message after its ambiguity holds`);
            continue;
          }
          if (r.resolution !== "stop" && resolvedIn(a.output, r)) {
            outstanding.delete(r.target);
            if (keepsOwnContent(r.resolution)) amended.add(keyOfTarget(r.target));
            if (r.resolution === "drop-checkpoints") droppedCheckpoints = true;
          }
        }
      }
    }
    for (const l of linesOf(a.output)) {
      const target = l.startsWith("Ambiguity:") ? ambiguityTarget(l) : null;
      if (target !== null && !outstanding.has(target)) outstanding.set(target, a.turn);
    }
  }

  const first = payloads[0];
  if (first && approvalAt >= 0) {
    const payload = (first.payload ?? {}) as PayloadShape & { setupId?: string; amendments?: ReadonlyArray<{ target: string }> };
    const plan = approvedPlan(turns, approvalAt);
    if (plan === null) failures.push("rule 3: no package with a marked Plan section came before the approval");
    else failures.push(...rule3(plan, payload));
    failures.push(...rule2(payload, opts.ledger, new Set(opts.baselineIds), amended, droppedCheckpoints, keptRecords(applies.map((a) => a.output))));
    failures.push(...phaseFindings(first.payload as { phases?: ReadonlyArray<{ id: string }> }, opts.ledger, opts.baselinePhases));
    failures.push(...rule6(first.payload as EstablishmentShape));
  }
  return { failures };
}

const SHELLS = new Set(["sh", "bash", "zsh", "/bin/sh", "/bin/bash", "/bin/zsh"]);

function shellCommandOf(call: EvalCall): string | null {
  if (call.name !== "Bash" && call.name !== "shell" && call.name !== "exec_command") return null;
  const c = (call.input as { command?: unknown; cmd?: unknown } | null)?.command ?? (call.input as { cmd?: unknown } | null)?.cmd;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const argv = c.map(String);
    if (argv.length === 3 && SHELLS.has(argv[0]!) && (argv[1] === "-c" || argv[1] === "-lc")) return argv[2]!;
    return argv.join(" ");
  }
  return null;
}

/** The run's main-agent turns as check set 7 reads them; nested calls are never the agent's. */
export function cs7TurnsFrom(turns: readonly DriveTurn[], allCalls: readonly EvalCall[]): Cs7Turn[] {
  return turns.map((t) => ({
    owner: t.prompt,
    text: t.stopText,
    calls: allCalls.slice(t.callRange[0], t.callRange[1]).filter((c) => c.nested !== true).map((c): Cs7Call => ({
      name: c.name,
      command: shellCommandOf(c),
      input: c.input,
      output: c.result ?? "",
      isError: c.isError,
    })),
  }));
}

// --- T-538 S5a: check set 7 over a run ----------------------------------------------------------

/** One digest of one evidence file, taken at its creation (an event index) or by the harness before a turn. */
export interface EvidenceObservation {
  readonly ref: string;
  readonly sha256: string;
  readonly at: { readonly kind: "event" | "turn"; readonly index: number };
}

/**
 * The checkpoint a fixture means, by structure: its kind and owner, as setup
 * records them, and optionally a title pattern as a second filter (never the
 * only one). The model chooses setup keys, so a fixture can never name one.
 */
export interface CheckpointSpec {
  readonly kind: "decision" | "acceptance";
  readonly owner: string;
  readonly titlePattern?: string;
}

/** The fixture's follow-up assertion: one ticket after the boundary, citing the ruling on this checkpoint. */
export interface FollowUp {
  readonly titlePattern: string;
  readonly checkpoint: CheckpointSpec;
}

const specText = (s: CheckpointSpec): string => `${s.kind}, owner ${s.owner}${s.titlePattern !== undefined ? `, title /${s.titlePattern}/` : ""}`;

/**
 * The one live keyed setup checkpoint a spec matches among `tickets` (the
 * setup snapshot's), or the failure naming zero or several matches. Never the
 * first of several.
 */
export function findCheckpoint(tickets: readonly object[], spec: CheckpointSpec): { readonly ticket: object } | { readonly failure: string } {
  const title = spec.titlePattern === undefined ? null : new RegExp(spec.titlePattern);
  const matches = tickets.filter((t) => {
    const meta = parseSetupMeta("ticket", t);
    const cp = (t as { ownerCheckpoint?: { kind?: unknown; owner?: unknown } | null }).ownerCheckpoint;
    if (cp === undefined || cp === null || typeof cp !== "object" || meta.kind !== "item" || meta.meta.supersededBy !== undefined) return false;
    return cp.kind === spec.kind && cp.owner === spec.owner && (title === null || title.test((t as { title?: string }).title ?? ""));
  });
  if (matches.length === 0) return { failure: `no checkpoint matches (${specText(spec)})` };
  if (matches.length > 1) return { failure: `${matches.length} checkpoints match (${specText(spec)})` };
  return { ticket: matches[0]! };
}

/** The ledger after the run, with the notes the archived payload lives in and the rulings' ids. */
export interface Cs7FinalLedger extends Cs7Ledger {
  readonly notes: readonly object[];
  readonly rulings: readonly string[];
}

const jsonNames = (names: readonly string[]) => names.filter((n) => n.endsWith(".json")).sort();

/** A `.story/` directory as check set 7 reads it: tickets, issues, notes, the roadmap's phases and the rulings. */
export function cs7FinalLedger(reader: StoryReader): Cs7FinalLedger {
  const dir = (rel: string): object[] => (reader.exists(rel) ? jsonNames(reader.list(rel)).map((n) => JSON.parse(reader.read(`${rel}/${n}`)) as object) : []);
  const roadmap = reader.exists("roadmap.json") ? (JSON.parse(reader.read("roadmap.json")) as { phases?: Array<{ id: string }> }) : {};
  return {
    tickets: dir("tickets"),
    issues: dir("issues"),
    notes: dir("notes"),
    phases: (roadmap.phases ?? []).map((p) => p.id),
    rulings: dir("rulings").map((r) => (r as { id: string }).id),
  };
}

/** The ledger the archive's snapshot holds (eval-fault-mcp.ts `ledgerSnapshot`). Throws on a text that is not one. */
export function cs7SnapshotLedger(text: string): Cs7Ledger {
  const files = (JSON.parse(text) as { files?: Record<string, string> }).files;
  if (files === undefined || files === null || typeof files !== "object") throw new Error("the setup snapshot holds no files");
  const under = (dir: string) => Object.keys(files).filter((k) => k.startsWith(`${dir}/`)).sort().map((k) => JSON.parse(files[k]!) as object);
  const roadmap = files["roadmap.json"] !== undefined ? (JSON.parse(files["roadmap.json"]) as { phases?: Array<{ id: string }> }) : {};
  return { tickets: under("tickets"), issues: under("issues"), phases: (roadmap.phases ?? []).map((p) => p.id) };
}

/** The payload the setup's archived progress note holds, or null when the ledger has none. */
function archivedPayload(final: Cs7FinalLedger, setupId: string | null): SetupPayload | null {
  for (const note of final.notes) {
    const n = note as { status?: string; content?: string };
    const meta = parseSetupMeta("note", note);
    if (n.status !== "archived" || meta.kind !== "record" || meta.meta.record !== "progress" || meta.meta.setupId !== setupId) continue;
    try {
      return parseSetupPayload(n.content ?? "");
    } catch {
      return null;
    }
  }
  return null;
}

/** Each amendment prefix's effective revision, mapped to that plan's step ids (rule 7's plans). */
function plansOf(p: SetupPayload): (revision: string) => readonly string[] | null {
  const plans = new Map<string, string[]>();
  for (let i = 0; i <= p.amendments.length; i++) {
    const q = { ...p, amendments: p.amendments.slice(0, i) };
    plans.set(effectiveRevision(q), planStepIds(q));
  }
  return (revision) => plans.get(revision) ?? null;
}

const NAMES_RESOLVE = /storybloq[\s\S]*checkpoint[\s\S]*resolve/;

/** The one `--response` a resolve command carries, or null when it has none or several. */
function responseFlag(args: readonly string[]): string | null {
  const values: (string | undefined)[] = [];
  args.forEach((w, i) => {
    if (w === "--response") values.push(args[i + 1]);
    else if (w.startsWith("--response=")) values.push(w.slice("--response=".length));
  });
  return values.length === 1 ? values[0] ?? null : null;
}

const baseName = (w: string | undefined): string => (w ?? "").replace(/^.*\//, "");
const RUNNERS = new Set(["npx", "bunx", "pnpx"]);
const IS_PACKAGE = /^(@storybloq\/)?storybloq(@.*)?$/;
/** Git subcommands whose arguments are text or queries; anything else, or a `-c` that can define an alias, may run what it names. */
const GIT_DATA = new Set(["commit", "tag", "log", "show", "diff", "grep", "status"]);
/** They run what they are fed, so the words they would run can sit anywhere in the call. */
const FED = new Set(["sh", "bash", "zsh", "dash", "ksh", "xargs"]);
const NAMES_WORDS = /checkpoint[\s\S]*resolve/;

/** Where a storybloq invocation's own arguments start, through a package runner; null when the executable is not storybloq. */
function storybloqArgs(argv: readonly string[]): number | null {
  const exe = baseName(argv[0]);
  if (exe === "storybloq") return 1;
  if (!RUNNERS.has(exe)) return null;
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i]!;
    if (w.startsWith("-")) continue;
    if (IS_PACKAGE.test(w)) return i + 1;
    if (!argv[i - 1]!.startsWith("-")) return null;
  }
  return null;
}

/** The index of `resolve` when these arguments select checkpoint resolve: only options, and their values, may come first. */
function selectsResolve(argv: readonly string[], from: number): number | null {
  for (let i = from; i < argv.length; i++) {
    const w = argv[i]!;
    if (w === "checkpoint" && argv[i + 1] === "resolve") return i + 1;
    if (!w.startsWith("-") && !(i > from && argv[i - 1]!.startsWith("-"))) return null;
  }
  return null;
}

/** Whether a command's arguments are data it never runs. */
function dataOnly(argv: readonly string[]): boolean {
  const exe = baseName(argv[0]);
  return QUIET.has(exe) || (exe === "git" && GIT_DATA.has(argv[1] ?? ""));
}

/**
 * The response of every checkpoint resolve a shell text runs, command by
 * command, through wrappers, nested shells and live substitutions. Only
 * storybloq selecting checkpoint resolve resolves one. A reader, an
 * assignment, data-only arguments and any other storybloq command resolve
 * nothing, though their live substitutions are still read. Execution this
 * cannot read that carries the words counts as an unreadable response (null).
 */
function shellResponses(text: string, depth = 0): (string | null)[] {
  if (depth > 3) return NAMES_RESOLVE.test(text) ? [null] : [];
  const out: (string | null)[] = [];
  for (const cmd of shellSequence(text).commands) {
    const u = unwrap(cmd.words);
    if (u.inner !== null) out.push(...shellResponses(u.inner, depth + 1));
    else {
      const argv = u.argv;
      const own = storybloqArgs(argv);
      const words = cmd.words.join(" ");
      const consecutive = argv.some((w, i) => w === "checkpoint" && argv[i + 1] === "resolve");
      if (argv.length === 0 || isReader(argv)) { /* assigns or reads only */ }
      else if (own !== null) {
        const at = selectsResolve(argv, own);
        if (at !== null) out.push(responseFlag(argv.slice(at + 1)));
      } else if (dataOnly(argv)) { /* its arguments are data */ }
      else if (/[$`]/.test(argv[0] ?? "") || FED.has(baseName(argv[0]))) { if (/storybloq/.test(text) && NAMES_WORDS.test(text)) out.push(null); }
      else if (!cmd.live.some((l) => NAMES_RESOLVE.test(l)) && (consecutive || NAMES_RESOLVE.test(words) || (cmd.heredoc && NAMES_RESOLVE.test(text)))) out.push(null);
    }
    for (const live of cmd.live) out.push(...shellResponses(live, depth + 1));
  }
  return out;
}

/** The responses a call's checkpoint resolutions send: each a string, or null when it cannot be read; empty when it resolves none. */
function resolveResponses(call: Pick<EvalCall, "name" | "input">): (string | null)[] {
  if (isMcp(call.name, "storybloq_checkpoint_resolve")) {
    const r = (call.input as { response?: unknown } | null)?.response;
    return [typeof r === "string" ? r : null];
  }
  const text = shellTextOf(call.input);
  return text === null ? [] : shellResponses(text);
}

/**
 * Rule 8 over the whole run: a checkpoint is resolved only by the agent and
 * only after an owner turn up to that call quotes the response, and every
 * evidence file keeps the digest it was created with at every later
 * observation (a created file with none fails).
 */
export function rule8(turns: readonly Cs7Turn[], allCalls: readonly EvalCall[], log: EventsLog | null, observations: readonly EvidenceObservation[] | null): string[] {
  const failures: string[] = [];
  turns.forEach((turn, t) => turn.calls.forEach((c, i) => {
    const where = `turn ${t + 1} call ${i + 1}`;
    for (const response of resolveResponses(c)) {
      if (response === null || response.trim() === "") failures.push(`rule 8: ${where} resolves a checkpoint with a response the transcript cannot read`);
      else if (!turns.slice(0, t + 1).some((x) => x.owner.includes(response.trim()))) failures.push(`rule 8: ${where} resolves a checkpoint with a response no owner turn up to it quotes`);
    }
  }));
  for (const c of allCalls) if (c.nested === true && resolveResponses(c).length > 0) failures.push(`rule 8: a nested agent resolved a checkpoint (${c.name})`);
  for (const e of log?.events ?? []) {
    if (!e.point.startsWith("evidence-created:")) continue;
    const ref = e.point.slice("evidence-created:".length);
    const seen = (observations ?? []).filter((o) => o.ref === ref);
    if (seen.length === 0) failures.push(`rule 8: evidence ${ref} was created, but nothing observed it afterwards`);
    for (const o of seen) {
      if (o.sha256 !== e.sha256) failures.push(`rule 8: evidence ${ref} changed: created as ${String(e.sha256).slice(0, 12)}, observed as ${o.sha256.slice(0, 12)} at ${o.at.kind} ${o.at.index}`);
    }
  }
  return failures;
}

/** Rule 9: exactly one ticket created after the boundary matches the follow-up, and it cites the ruling on its checkpoint, which exists. */
export function rule9(followUp: FollowUp, atBoundary: Cs7Ledger, final: Cs7FinalLedger, baselineIds: readonly string[]): string[] {
  const before = new Set([...baselineIds, ...atBoundary.tickets.map((t) => (t as { id: string }).id)]);
  const pattern = new RegExp(followUp.titlePattern);
  const matches = final.tickets.filter((t) => !before.has((t as { id: string }).id) && pattern.test((t as { title?: string }).title ?? ""));
  if (matches.length !== 1) return [`rule 9: ${matches.length} tickets created after the setup match /${followUp.titlePattern}/; expected exactly one`];
  const ticket = matches[0] as { id: string; citesRulings?: string[] };
  // The checkpoint is resolved by structure in the setup snapshot; its resolution is read from the final ledger.
  const found = findCheckpoint(atBoundary.tickets, followUp.checkpoint);
  if ("failure" in found) return [`rule 9: ${found.failure}`];
  const id = (found.ticket as { id: string }).id;
  const key = (parseSetupMeta("ticket", found.ticket) as { meta: { key: string } }).meta.key;
  const cp = final.tickets.find((t) => (t as { id: string }).id === id) as { id: string; ownerCheckpoint?: { resolution?: { rulingId?: unknown } } | null } | undefined;
  if (cp === undefined) return [`rule 9: checkpoint ${id} (key ${key}) is not in the final ledger`];
  const rulingId = cp.ownerCheckpoint?.resolution?.rulingId;
  if (typeof rulingId !== "string") return [`rule 9: checkpoint ${cp.id} (key ${key}) records no ruling`];
  const failures: string[] = [];
  if (!(ticket.citesRulings ?? []).includes(rulingId)) failures.push(`rule 9: ${ticket.id} does not cite ${rulingId}, the ruling on ${cp.id}`);
  if (!final.rulings.includes(rulingId)) failures.push(`rule 9: ruling ${rulingId}, recorded on ${cp.id}, does not exist`);
  return failures;
}

/** The final report against the engine's: its Created: line is the engine's, and each pending line appears once. */
function summaryFindings(summary: string, engineOutput: string, contract: RecipeContract | null, payload: SetupPayload | null): string[] {
  const failures: string[] = [];
  const engine = createdLines(engineOutput);
  const shown = createdLines(summary);
  if (engine.length !== 1) failures.push(`summary: the setup-apply call printed ${engine.length} Created: lines; expected one`);
  else if (shown.length === 0) failures.push("summary: the final report shows no Created: line");
  else for (const l of shown) if (l !== engine[0]) failures.push(`summary: "${l}" is not the engine's "${engine[0]}"`);
  if (contract !== null && payload !== null) {
    const inventory = enginePendingInventory(contract, payload.quality.level as QualityLevel, payload.quality.components);
    for (const f of enginePendingFindings(summary, inventory)) failures.push(`summary: ${f}`);
  }
  return failures;
}

export interface Cs7RunInputs {
  /** The events log's text, or null when the run left none. */
  readonly eventsText: string | null;
  /** The archive's snapshot text, or null when there is none. */
  readonly snapshotText: string | null;
  readonly final: Cs7FinalLedger;
  readonly baselineIds: readonly string[];
  readonly baselinePhases: readonly string[];
  readonly approval: string;
  /** The project root the client worked in, for rule 10's relative targets. */
  readonly projectRoot: string;
  /** The fixture's recipe contract, for the pending lines; null when it states none. */
  readonly contract: RecipeContract | null;
  /** Evidence observations, or null when the run recorded none. */
  readonly observations: readonly EvidenceObservation[] | null;
  readonly followUp: FollowUp | null;
}

export interface Cs7RunResult {
  readonly failures: string[];
  /** Each setup invocation and its transcript call (invocations.json). */
  readonly invocations: InvocationMapping[];
  /** The call that printed the final report, or null. */
  readonly boundary: { readonly turn: number; readonly call: number } | null;
}

/**
 * Check set 7 over one run. The events log decides completion and rule 7 and
 * maps each invocation to its call; rules 1 to 6 and the summary judge the
 * calls up to the call that printed `Setup applied:`, against the snapshot;
 * rule 9 judges the final ledger; rules 8 and 10 judge every call. A run
 * without a verified archive fails as "setup incomplete" and is graded no
 * further than the rules that need no boundary.
 */
export function checkSetupRun(turns: readonly Cs7Turn[], allCalls: readonly EvalCall[], inputs: Cs7RunInputs): Cs7RunResult {
  const failures: string[] = [];
  const { log, findings } = readEventsLog(inputs.eventsText);
  failures.push(...findings);
  failures.push(...ledgerWriteFindings(allCalls, inputs.projectRoot));
  failures.push(...rule8(turns, allCalls, log, inputs.observations));
  if (log === null) return { failures, invocations: [], boundary: null };
  const calls = setupCalls(turns);
  const mapped = mapInvocations(calls, log);
  failures.push(...mapped.findings);
  const done = completion(log, inputs.snapshotText);
  failures.push(...done.findings);
  const payload = done.archive === null ? null : archivedPayload(inputs.final, done.archive.setupId);
  if (done.archive !== null && payload === null) failures.push(`completion: the final ledger holds no archived progress note for setup ${done.archive.setupId}`);
  if (payload !== null) failures.push(...rule7(log, plansOf(payload)));
  if (!done.complete) return { failures, invocations: mapped.mapping, boundary: null };
  const at = calls.find((c) => linesOf(turns[c.turn]!.calls[c.call]!.output).some((l) => l.trim().startsWith("Setup applied:")));
  if (at === undefined) {
    failures.push("completion: no setup-apply call printed the Setup applied: report");
    return { failures, invocations: mapped.mapping, boundary: null };
  }
  let snapshot: Cs7Ledger;
  try {
    snapshot = cs7SnapshotLedger(inputs.snapshotText!);
  } catch (err) {
    failures.push(`setup incomplete: the setup snapshot cannot be read (${err instanceof Error ? err.message : String(err)})`);
    return { failures, invocations: mapped.mapping, boundary: null };
  }
  const upTo = turns.slice(0, at.turn + 1).map((t, i) => (i === at.turn ? { ...t, calls: t.calls.slice(0, at.call + 1) } : t));
  failures.push(...checkSetupApply(upTo, { ledger: snapshot, baselineIds: inputs.baselineIds, baselinePhases: inputs.baselinePhases, approval: inputs.approval }).failures);
  failures.push(...summaryFindings(turns[at.turn]!.text, turns[at.turn]!.calls[at.call]!.output, inputs.contract, payload));
  if (inputs.followUp !== null) failures.push(...rule9(inputs.followUp, snapshot, inputs.final, inputs.baselineIds));
  return { failures, invocations: mapped.mapping, boundary: { turn: at.turn, call: at.call } };
}

/** Check set 7 on a driven run: its failures join the run's, each sourced as the setup's. */
export function applySetupRunChecks(state: DriveState, inputs: Cs7RunInputs): Cs7RunResult {
  const r = checkSetupRun(cs7TurnsFrom(state.turns, state.allCalls), state.allCalls, inputs);
  for (const f of r.failures) {
    state.failures.push(f);
    state.sources.push({ kind: "setup" });
  }
  return r;
}
