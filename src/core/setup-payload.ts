/**
 * T-538 S2: the setup payload (plan v2 4b, v5 3). The whole approved setup
 * package, stored as one fenced block in the progress note so that any later
 * session, by any client, can resume the setup from the ledger alone:
 *
 *     <!-- storybloq-setup-payload v1 -->
 *     ```json
 *     { "version": 1, ... }
 *     ```
 *
 * `parseSetupPayload` refuses before any write, naming the first problem: no
 * marker, JSON that does not parse, a version this CLI does not know, a
 * schema failure, a key that is undefined, duplicated or out of range, a
 * dependency cycle, or a path that leaves the project.
 *
 * The approved package is fixed once written. What the engine adds later
 * (receipts, amendments, pre-images, the frozen finalization block) lives in
 * the same payload so one guarded note write carries both.
 */
import { z } from "zod";
import { isAbsolute, normalize, posix, sep } from "node:path";
import { SETUP_ID_PATTERN } from "./setup-review.js";
import { ESTABLISHABLE_STAGES, SETUP_KEY_PATTERN, TEST_RUNNERS, TEST_WRAPPERS } from "./setup-meta.js";

export const SETUP_PAYLOAD_VERSION = 1;
export const SETUP_PAYLOAD_MARKER = "<!-- storybloq-setup-payload v1 -->";
const MARKER_PATTERN = /<!-- storybloq-setup-payload v(\d+) -->/;

const text = z.string().min(1);
const key = z.string().regex(SETUP_KEY_PATTERN, "is not an item key (K1 to K9999)");
const keys = z.array(key);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "is not a sha256 digest");

const StagePlan = z.object({
  command: text,
  status: z.enum(["established", "pending"]),
  reason: text.optional(),
}).strict();

/** A test stage may name its runner and wrapper; a pending one an establishment ticket serves must. */
const TestStagePlan = StagePlan.extend({
  runner: z.enum(TEST_RUNNERS).optional(),
  wrapper: z.enum(TEST_WRAPPERS).optional(),
}).strict();

const VerifyPlan = z.object({
  startCommand: text,
  readinessUrl: text,
  status: z.enum(["established", "pending"]),
  reason: text.optional(),
}).strict();

const Component = z.object({
  id: text,
  /** Relative to the project root; "." is the root. */
  workdir: text,
  test: TestStagePlan.nullable(),
  build: StagePlan.nullable(),
  verify: VerifyPlan.nullable(),
}).strict();

export const QUALITY_LEVELS = ["minimal", "tests-only", "full"] as const;
export type QualityLevel = (typeof QUALITY_LEVELS)[number];

const Phase = z.object({
  key,
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "is not a phase id"),
  name: text,
  label: text,
  description: z.string(),
}).strict();

const Ticket = z.object({
  key,
  title: text,
  type: z.enum(["task", "feature", "chore"]),
  phase: key,
  description: z.string(),
  blockedBy: keys,
  /** Already-built work is a complete ticket; absent means open (never defaulted here, so a payload without it renders unchanged). */
  status: z.enum(["open", "complete"]).optional(),
  /**
   * T-538 S3a-2: this ticket establishes a component's stage (test; S3b adds
   * build and verify) once its scaffold is built: its lifecycle belongs to
   * `storybloq setup-verify`.
   */
  establishes: z.object({ component: text, stage: z.enum(ESTABLISHABLE_STAGES), scaffold: key }).strict().optional(),
}).strict();

const Checkpoint = z.object({
  key,
  title: text,
  kind: z.enum(["decision", "acceptance"]),
  question: text.optional(),
  criteria: text.optional(),
  evidenceRefs: z.array(text),
  description: z.string(),
  phase: key,
  blockedBy: keys,
  /** The tickets and checkpoints this checkpoint gates: each is blocked by it. */
  gates: keys,
}).strict();

const Issue = z.object({
  key,
  title: text,
  body: z.string(),
  labels: z.array(text),
  source: z.number().int().positive().nullable(),
}).strict();

const Coverage = z.object({
  requirement: text,
  text,
  source: text,
  keys,
  deferral: text.optional(),
}).strict();

const GovernanceFile = z.object({ path: text, content: z.string() }).strict();

/** The entry files a setup may point at its canonical facts from (T-538 S3b): a block the owner adds, never the engine. */
export const POINTER_FILES = ["CLAUDE.md", "AGENTS.md"] as const;
const Pointer = z.object({ path: z.enum(POINTER_FILES), block: z.string() }).strict();

const Receipt = z.object({
  step: text,
  target: text,
  ownedPre: sha256Hex.nullable(),
  ownedPost: sha256Hex,
  edges: z.array(z.tuple([text, text])).optional(),
  revision: sha256Hex.optional(),
  /** A pointer step's outcome: the block was found in the file, or the owner kept the file without it. */
  outcome: z.enum(["applied", "waived"]).optional(),
}).strict();

const Amendment = z.object({
  class: text,
  target: text,
  resolution: text,
  ownerWords: text,
  at: text,
  material: z.boolean(),
  reviewRevision: sha256Hex.optional(),
}).strict();

const PreImage = z.object({ target: text, content: z.string() }).strict();

const Frozen = z.object({
  revision: sha256Hex,
  setupNote: z.string(),
  handover: z.object({ path: text, content: z.string() }).strict(),
  historicalReport: z.string(),
  superseded: z.boolean().optional(),
}).strict();

export const SetupPayloadSchema = z.object({
  version: z.literal(SETUP_PAYLOAD_VERSION),
  setupId: z.string().regex(SETUP_ID_PATTERN, "is not a setup id (SS-<8 hex>)"),
  review: z.object({
    reviewer: text,
    outcome: z.enum(["approved", "round-limit", "skipped"]),
    /** The two review status lines verbatim, or the skip record. */
    lines: z.array(text).min(1).max(2),
  }).strict(),
  ownerLabel: text,
  project: z.object({ name: text, type: text, language: text }).strict(),
  quality: z.object({
    level: z.enum(QUALITY_LEVELS),
    /** Whether VERIFY applies to this project type at all. */
    verifyApplies: z.boolean(),
    components: z.array(Component).min(1),
  }).strict(),
  governance: z.object({
    canonicalFactsPath: text,
    files: z.array(GovernanceFile),
    /** Optional, so a payload from before pointers serializes as it did. */
    pointers: z.array(Pointer).optional(),
  }).strict(),
  git: z.object({ init: z.boolean(), gitignore: z.array(text) }).strict(),
  phases: z.array(Phase),
  tickets: z.array(Ticket),
  checkpoints: z.array(Checkpoint),
  issues: z.array(Issue),
  coverage: z.array(Coverage),
  receipts: z.array(Receipt).default([]),
  amendments: z.array(Amendment).default([]),
  preImages: z.array(PreImage).default([]),
  frozen: Frozen.nullable().default(null),
  /** Frozen blocks an amendment after the freeze superseded, oldest first (plan v5 6a). */
  frozenHistory: z.array(Frozen).default([]),
}).strict();

export type SetupPayload = z.infer<typeof SetupPayloadSchema>;

export class SetupPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupPayloadError";
  }
}

/** A path the payload writes must stay inside the project: relative, no `..`. */
function escapes(path: string): boolean {
  if (isAbsolute(path) || path.includes("\\")) return true;
  const n = normalize(path);
  return n === ".." || n.startsWith(`..${sep}`) || n.startsWith("../");
}

/**
 * Stage 1's test-command grammar: the recipe's test command is plain `cd`
 * steps and test invocations joined by `&&`, so each component's test command
 * must be one simple invocation that cannot move, end or silence the shell
 * for the components after it. It is read as the shell reads it: quotes and
 * escapes decoded, a `#` that starts a word is a comment (which would swallow
 * every later step), and the executable is checked after decoding, so `'cd'`
 * and `c\d` are both `cd`.
 *
 * The executable position is strict rather than a denylist chase: it must be
 * a plain word (no `$`, glob, tilde or brace expansion; `$VAR` stays allowed
 * in the arguments), and never a bash builtin or keyword, since a builtin
 * runs inside the shell and `builtin`/`command` reach every other one.
 */
const PLAIN_EXECUTABLE = /^[A-Za-z0-9._/+-]+$/;

/** The union of `compgen -b` from bash 3.2.57 and 5.3, less the four that cannot move or end the shell. */
const SHELL_BUILTINS: ReadonlySet<string> = new Set([
  ".", ":", "alias", "bg", "bind", "break", "builtin", "caller", "cd", "command", "compgen", "complete",
  "compopt", "continue", "declare", "dirs", "disown", "echo", "enable", "eval", "exec", "exit", "export",
  "fc", "fg", "getopts", "hash", "help", "history", "jobs", "kill", "let", "local", "logout", "mapfile",
  "popd", "printf", "pushd", "pwd", "read", "readarray", "readonly", "return", "set", "shift", "shopt",
  "source", "suspend", "times", "trap", "type", "typeset", "ulimit", "umask", "unalias", "unset", "wait",
]);

/** The union of `compgen -k` from bash 3.2.57 and 5.3. */
const SHELL_KEYWORDS: ReadonlySet<string> = new Set([
  "if", "then", "else", "elif", "fi", "case", "esac", "for", "select", "while", "until", "do", "done",
  "in", "function", "time", "{", "}", "!", "[[", "]]", "coproc",
]);

/** Builtins that only compute an exit status; `[` is not a plain word but is kept with `test`. */
const HARMLESS_BUILTINS: ReadonlySet<string> = new Set(["true", "false", "test", "["]);

const BACKTICK = "`" + "`" + "`";

/** Why `command` is not one simple invocation, as a phrase for the refusal, or null when it is. */
export function testCommandProblem(command: string): string | null {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  const n = command.length;
  let i = 0;
  while (i < n) {
    const c = command[i]!;
    if (c === "\n" || c === "\r") return "a newline";
    if (c === " " || c === "\t") {
      if (inWord) { words.push(word); word = ""; inWord = false; }
      i++;
      continue;
    }
    if (c === "#" && !inWord) return "a comment (`#`)";
    if (c === "\\") {
      const d = command[i + 1];
      if (d === undefined) return "a trailing backslash";
      if (d === "\n" || d === "\r") return "a newline";
      word += d;
      inWord = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return "an unclosed quote";
      const quoted = command.slice(i + 1, close);
      if (/[\n\r]/.test(quoted)) return "a newline";
      word += quoted;
      inWord = true;
      i = close + 1;
      continue;
    }
    if (c === '"') {
      inWord = true;
      i++;
      for (;;) {
        const d = command[i];
        if (d === undefined) return "an unclosed quote";
        if (d === '"') { i++; break; }
        if (d === "\n" || d === "\r") return "a newline";
        if (d === "`") return BACKTICK;
        if (d === "$" && command[i + 1] === "(") return "`$(`";
        if (d === "\\" && i + 1 < n && '"\\$`'.includes(command[i + 1]!)) { word += command[i + 1]; i += 2; continue; }
        word += d;
        i++;
      }
      continue;
    }
    if (c === "$" && command[i + 1] === "(") return "`$(`";
    if (c === "`") return BACKTICK;
    if (c === "&") return command[i + 1] === "&" ? "`&&`" : "`&`";
    if (c === "|") return command[i + 1] === "|" ? "`||`" : "`|`";
    if (";()<>".includes(c)) return `\`${c}\``;
    word += c;
    inWord = true;
    i++;
  }
  if (inWord) words.push(word);
  const executable = words[0];
  if (executable === undefined) return "no command";
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(executable)) return "an environment assignment";
  if (HARMLESS_BUILTINS.has(executable)) return null;
  if (SHELL_KEYWORDS.has(executable)) return `the shell keyword \`${executable}\``;
  if (!PLAIN_EXECUTABLE.test(executable)) return `an executable that is not a plain word (\`${executable}\`)`;
  if (SHELL_BUILTINS.has(executable)) return `the shell builtin \`${executable}\``;
  return null;
}

/** The first reference problem in an otherwise well-formed payload, or null. */
function referenceProblem(p: SetupPayload): string | null {
  const kinds = new Map<string, "phase" | "ticket" | "checkpoint" | "issue">();
  const entries: Array<[string, "phase" | "ticket" | "checkpoint" | "issue"]> = [
    ...p.phases.map((x): [string, "phase"] => [x.key, "phase"]),
    ...p.tickets.map((x): [string, "ticket"] => [x.key, "ticket"]),
    ...p.checkpoints.map((x): [string, "checkpoint"] => [x.key, "checkpoint"]),
    ...p.issues.map((x): [string, "issue"] => [x.key, "issue"]),
  ];
  for (const [k, kind] of entries) {
    if (kinds.has(k)) return `key ${k} is defined twice`;
    kinds.set(k, kind);
  }
  const phaseIds = new Set<string>();
  for (const ph of p.phases) {
    if (phaseIds.has(ph.id)) return `phase id ${ph.id} is defined twice`;
    phaseIds.add(ph.id);
  }
  const workItem = (k: string) => kinds.get(k) === "ticket" || kinds.get(k) === "checkpoint";
  for (const item of [...p.tickets, ...p.checkpoints]) {
    if (kinds.get(item.phase) !== "phase") return `${item.key} names phase ${item.phase}, which is not a phase key`;
    for (const b of item.blockedBy) {
      if (!workItem(b)) return `${item.key} is blocked by ${b}, which is not a ticket or checkpoint key`;
      if (b === item.key) return `${item.key} is blocked by itself`;
    }
  }
  for (const cp of p.checkpoints) {
    if ((cp.kind === "decision") !== (cp.question !== undefined) || (cp.kind === "acceptance") !== (cp.criteria !== undefined)) {
      return `${cp.key} is a ${cp.kind} checkpoint and needs exactly its ${cp.kind === "decision" ? "question" : "criteria"}`;
    }
    for (const g of cp.gates) {
      if (!workItem(g)) return `${cp.key} gates ${g}, which is not a ticket or checkpoint key`;
      if (g === cp.key) return `${cp.key} gates itself`;
    }
  }
  for (const c of p.coverage) {
    for (const k of c.keys) if (!kinds.has(k)) return `coverage for ${c.requirement} names ${k}, which is not defined`;
    if (c.keys.length === 0 && c.deferral === undefined) return `coverage for ${c.requirement} maps to nothing and records no deferral`;
  }
  const componentIds = new Set<string>();
  for (const comp of p.quality.components) {
    if (componentIds.has(comp.id)) return `component id ${comp.id} is defined twice`;
    componentIds.add(comp.id);
    if (escapes(comp.workdir)) return `component ${comp.id} has a workdir outside the project: ${comp.workdir}`;
    for (const stage of [comp.test, comp.build, comp.verify]) {
      if (stage && stage.status === "pending" && stage.reason === undefined) return `component ${comp.id} has a pending stage with no reason`;
    }
    const problem = comp.test ? testCommandProblem(comp.test.command) : null;
    if (problem !== null) {
      return `component ${comp.id}'s test command uses ${problem}, but a component's test command is one invocation run from its workdir. ` +
        "Put a multi-step test behind one script, such as an npm script or a Makefile target, and name that";
    }
  }
  // The recipe has one VERIFY stage: one start command and one readiness URL.
  if (p.quality.components.filter((c) => c.verify !== null).length > 1) return "more than one component has a verify plan; the recipe runs one";
  if (escapes(p.governance.canonicalFactsPath)) return `the canonical facts path leaves the project: ${p.governance.canonicalFactsPath}`;
  const destinations = new Map<string, string>();
  for (const f of p.governance.files) {
    if (escapes(f.path)) return `governance file ${f.path} leaves the project`;
    // RULES.md, ./RULES.md and a/../RULES.md are one file.
    const dest = posix.normalize(f.path);
    const earlier = destinations.get(dest);
    if (earlier !== undefined) return `governance files ${earlier} and ${f.path} are the same file`;
    destinations.set(dest, f.path);
  }
  const pointed = new Set<string>();
  for (const ptr of p.governance.pointers ?? []) {
    if (pointed.has(ptr.path)) return `two pointers name ${ptr.path}; an entry file takes one block`;
    pointed.add(ptr.path);
    if (destinations.has(ptr.path)) return `${ptr.path} is both a governance file and a pointer target`;
    if (ptr.block.trim() === "" || !ptr.block.endsWith("\n")) return `the pointer block for ${ptr.path} must be non-empty and end in a newline`;
  }
  for (const block of [...(p.frozen ? [p.frozen] : []), ...p.frozenHistory]) {
    if (escapes(block.handover.path)) return `the frozen handover path leaves the project: ${block.handover.path}`;
  }
  const edges = effectiveEdges(p);
  // Before the cycle check, so a scaffold that waits on its own establishment is named as that.
  const establishment = establishmentProblem(p, edges);
  if (establishment !== null) return establishment;
  // A cycle in blockedBy (gates included) can never be worked.
  const state = new Map<string, 1 | 2>();
  const visit = (k: string, path: string[]): string | null => {
    if (state.get(k) === 2) return null;
    if (state.get(k) === 1) return [...path.slice(path.indexOf(k)), k].join(" -> ");
    state.set(k, 1);
    for (const next of edges.get(k) ?? []) {
      const cycle = visit(next, [...path, k]);
      if (cycle) return cycle;
    }
    state.set(k, 2);
    return null;
  };
  for (const k of edges.keys()) {
    const cycle = visit(k, []);
    if (cycle) return `the dependencies form a cycle: ${cycle}`;
  }
  // Already-built work (T-538 S3a-1): nothing open holds it back, and no checkpoint gates it.
  const complete = new Set(p.tickets.filter((t) => plannedStatus(t) === "complete").map((t) => t.key));
  for (const cp of p.checkpoints) {
    for (const g of cp.gates) if (complete.has(g)) return `${cp.key} gates ${g}, which is already complete`;
  }
  for (const t of p.tickets) {
    if (!complete.has(t.key)) continue;
    for (const k of prerequisites(p, t.key, edges)) {
      if (!complete.has(k)) return `${t.key} is complete but depends on ${k}, which is not`;
    }
  }
  return null;
}

/**
 * The establishment rules (T-538 S3a-2, S3b), on the effective graph. Each
 * establishment ticket serves one stage of one component, which
 * `establishedStageProblem` allows, and no two tickets serve the same
 * component and stage; it is a task with no explicit status (only
 * setup-verify moves it); it waits on its scaffold and nothing else, so its
 * prerequisites are exactly the scaffold's plus the scaffold; and nothing it
 * waits on waits on an establishment ticket, which would deadlock the two
 * components even with no cycle.
 */
function establishmentProblem(p: SetupPayload, edges: Map<string, string[]>): string | null {
  const establishing = p.tickets.filter((t) => t.establishes !== undefined);
  const establishmentKeys = new Set(establishing.map((t) => t.key));
  const served = new Map<string, string>();
  for (const t of establishing) {
    const e = t.establishes!;
    const comp = p.quality.components.find((c) => c.id === e.component);
    if (!comp) return `${t.key} establishes component ${e.component}, which is not a component`;
    const stageProblem = establishedStageProblem(p, comp, e.stage);
    if (stageProblem !== null) return `${t.key} establishes ${e.component}'s ${e.stage} stage, ${stageProblem}`;
    const servedKey = `${e.component}\u0000${e.stage}`;
    const other = served.get(servedKey);
    if (other !== undefined) return `${other} and ${t.key} both establish ${e.component}'s ${e.stage} stage`;
    served.set(servedKey, t.key);
    if (t.type !== "task") return `${t.key} is an establishment ticket and must be a task`;
    if (t.status !== undefined) return `${t.key} is an establishment ticket and carries no status; storybloq setup-verify completes it`;
    const scaffold = p.tickets.find((x) => x.key === e.scaffold);
    if (!scaffold) return `${t.key}'s scaffold ${e.scaffold} is not a ticket key`;
    if (scaffold.establishes !== undefined) return `${t.key}'s scaffold ${e.scaffold} is itself an establishment ticket`;
    if (plannedStatus(scaffold) === "complete") return `${t.key}'s scaffold ${e.scaffold} is already complete`;
    const direct = [...new Set(edges.get(t.key) ?? [])];
    const extra = direct.filter((k) => k !== e.scaffold);
    if (extra.length > 0) return `${t.key} waits on ${extra.join(", ")}; an establishment ticket waits on its scaffold ${e.scaffold} alone`;
    if (!direct.includes(e.scaffold)) return `${t.key} does not wait on its scaffold ${e.scaffold}`;
    if (prerequisites(p, e.scaffold, edges).has(t.key)) return `${t.key}'s scaffold ${e.scaffold} waits on ${t.key}`;
    for (const k of prerequisites(p, t.key, edges)) {
      if (establishmentKeys.has(k)) return `${t.key} waits on ${k}, which is an establishment ticket`;
    }
  }
  return null;
}

/**
 * Why a component's stage cannot be established, or null. The stage's
 * evidence must be pending; a test stage names its runner and wrapper; BUILD
 * and VERIFY exist only under the full level (the activation table enables
 * them nowhere else, so an establishment could never change a stage); VERIFY
 * only where it applies, with a readiness URL setup-verify can own.
 */
function establishedStageProblem(p: SetupPayload, comp: SetupPayload["quality"]["components"][number], stage: (typeof ESTABLISHABLE_STAGES)[number]): string | null {
  const evidence = stage === "test" ? comp.test : stage === "build" ? comp.build : comp.verify;
  if (evidence === null || evidence.status !== "pending") return "which is not pending";
  if (stage === "test") return comp.test!.runner === undefined || comp.test!.wrapper === undefined ? "which names no runner and wrapper" : null;
  if (p.quality.level !== "full") return `which only the full level runs (this setup is ${p.quality.level})`;
  if (stage === "build") return null;
  if (!p.quality.verifyApplies) return "but VERIFY does not apply to this project";
  return readinessEndpoint(comp.verify!.readinessUrl) === null ? `whose readiness URL ${comp.verify!.readinessUrl} is not http://127.0.0.1:<port>/<path> or http://localhost:<port>/<path>` : null;
}

/**
 * The endpoint of a VERIFY readiness URL setup-verify can own: plain http on
 * 127.0.0.1 with an explicit port, and a path (no query credentials, no
 * fragment). Anything else is null: setup-verify checks listener ownership
 * for that exact endpoint only.
 */
export function readinessEndpoint(url: string): { host: "127.0.0.1"; port: number; path: string } | null {
  // `localhost`, in any case, is read as 127.0.0.1 here and nowhere resolved: no DNS, no hosts file.
  const m = /^http:\/\/(127\.0\.0\.1|[Ll][Oo][Cc][Aa][Ll][Hh][Oo][Ss][Tt]):(\d{1,5})(\/[^\s#]*)?$/.exec(url);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535 || m[2]!.startsWith("0")) return null;
  return { host: "127.0.0.1", port, path: m[3] ?? "/" };
}

/** Whether a payload establishes any stage: only then are the verification record and metadata written. */
export function usesEstablishment(p: Pick<SetupPayload, "tickets">): boolean {
  return p.tickets.some((t) => t.establishes !== undefined);
}

/** A ticket's planned status: an absent status is open. The only place that default applies. */
export function plannedStatus(t: { status?: "open" | "complete" }): "open" | "complete" {
  return t.status ?? "open";
}

/**
 * The payload's dependency graph as execution sees it: each ticket or
 * checkpoint key to the keys it waits on, its blockedBy plus every
 * checkpoint that gates it. Every rule over dependencies reads this, never a
 * literal blockedBy.
 */
export function effectiveEdges(p: Pick<SetupPayload, "tickets" | "checkpoints">): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  const addEdge = (from: string, to: string) => edges.set(from, [...(edges.get(from) ?? []), to]);
  for (const item of [...p.tickets, ...p.checkpoints]) for (const b of item.blockedBy) addEdge(item.key, b);
  for (const cp of p.checkpoints) for (const g of cp.gates) addEdge(g, cp.key);
  return edges;
}

/** Every key `key` waits on, directly or through others, on the effective graph. */
export function prerequisites(p: Pick<SetupPayload, "tickets" | "checkpoints">, key: string, edges = effectiveEdges(p)): Set<string> {
  const seen = new Set<string>();
  const stack = [...(edges.get(key) ?? [])];
  while (stack.length > 0) {
    const k = stack.pop()!;
    if (seen.has(k) || k === key) continue;
    seen.add(k);
    stack.push(...(edges.get(k) ?? []));
  }
  return seen;
}

/** Validates a payload object, refusing with the first problem. */
export function validateSetupPayload(raw: unknown): SetupPayload {
  const version = typeof raw === "object" && raw !== null ? (raw as { version?: unknown }).version : undefined;
  if (version !== SETUP_PAYLOAD_VERSION) {
    throw new SetupPayloadError(`Setup payload version ${JSON.stringify(version)} is not one this CLI reads (only ${SETUP_PAYLOAD_VERSION}); update storybloq.`);
  }
  const parsed = SetupPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new SetupPayloadError(`Setup payload is not valid: ${issue.path.join(".") || "(root)"} ${issue.message}.`);
  }
  const problem = referenceProblem(parsed.data);
  if (problem) throw new SetupPayloadError(`Setup payload is not valid: ${problem}.`);
  return parsed.data;
}

/** Reads the fenced payload out of a progress note's content. */
export function parseSetupPayload(content: string): SetupPayload {
  const marker = MARKER_PATTERN.exec(content);
  if (!marker) throw new SetupPayloadError("This note holds no setup payload (no storybloq-setup-payload marker).");
  if (Number(marker[1]) !== SETUP_PAYLOAD_VERSION) {
    throw new SetupPayloadError(`Setup payload version ${marker[1]} is not one this CLI reads (only ${SETUP_PAYLOAD_VERSION}); update storybloq.`);
  }
  const after = content.slice(marker.index + marker[0].length);
  const fence = /^\s*```json\n([\s\S]*?)\n```/.exec(after);
  if (!fence) throw new SetupPayloadError("The setup payload marker is not followed by a json code fence.");
  let raw: unknown;
  try {
    raw = JSON.parse(fence[1]!);
  } catch (err) {
    throw new SetupPayloadError(`The setup payload is not valid JSON: ${(err as Error).message}`);
  }
  return validateSetupPayload(raw);
}

/** Renders the payload block, the inverse of `parseSetupPayload`. */
export function renderSetupPayload(payload: SetupPayload): string {
  return `${SETUP_PAYLOAD_MARKER}\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
}
