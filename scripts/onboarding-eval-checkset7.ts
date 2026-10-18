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
 * (blockedBy plus checkpoint gates), and it states no status. Not yet wired
 * to runs (S5a).
 */
import { heredocStdin } from "./onboarding-eval-checkset6.js";
import { parseSetupMeta } from "../src/core/setup-meta.js";
import { effectiveEdges } from "../src/core/setup-payload.js";
import { STAGES_USED } from "../src/core/verification-activation.js";
import type { DriveTurn } from "./onboarding-eval-drive.js";
import type { EvalCall } from "./onboarding-eval-lib.js";

export interface Cs7Call {
  /** The tool's name as the client reported it. */
  readonly name: string;
  /** The shell command, or null for a non-shell tool. */
  readonly command: string | null;
  readonly input: unknown;
  readonly output: string;
}

export interface Cs7Turn {
  readonly owner: string;
  readonly calls: readonly Cs7Call[];
  readonly text: string;
}

/** The ledger after the run, as rule 2 reads it. */
export interface Cs7Ledger {
  readonly tickets: readonly object[];
  readonly issues: readonly object[];
}

export interface Cs7Options {
  readonly ledger: Cs7Ledger;
  /** Ticket and issue ids the fixture's ledger held before the run. */
  readonly baselineIds: readonly string[];
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

function rule2(payload: PayloadShape & { setupId?: string }, ledger: Cs7Ledger, baseline: ReadonlySet<string>, amended: ReadonlySet<string>, droppedCheckpoints: boolean): string[] {
  const failures: string[] = [];
  const keyed = new Map<string, Array<{ id: string; title: string; kind: Cs7Kind; status?: string }>>();
  const unkeyed: string[] = [];
  for (const [entity, items] of [["ticket", ledger.tickets], ["issue", ledger.issues]] as const) {
    for (const item of items) {
      const it = item as { id: string; title: string; status?: string; ownerCheckpoint?: unknown };
      const meta = parseSetupMeta(entity, item);
      if (meta.kind === "item" && meta.meta.setupId === payload.setupId) {
        if (meta.meta.supersededBy !== undefined) continue;
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
    failures.push(...rule2(payload, opts.ledger, new Set(opts.baselineIds), amended, droppedCheckpoints));
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
    })),
  }));
}
