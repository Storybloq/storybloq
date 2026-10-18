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
import { SETUP_KEY_PATTERN } from "./setup-meta.js";

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
  test: StagePlan.nullable(),
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

const Receipt = z.object({
  step: text,
  target: text,
  ownedPre: sha256Hex.nullable(),
  ownedPost: sha256Hex,
  edges: z.array(z.tuple([text, text])).optional(),
  revision: sha256Hex.optional(),
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
 * must be one invocation that cannot move the shell or run anything else.
 * The first token that breaks it, named for the refusal, or null.
 */
const TEST_COMMAND_TOKENS: ReadonlyArray<readonly [string, RegExp]> = [
  ["a newline", /[\n\r]/],
  ["&&", /&&/],
  ["||", /\|\|/],
  ["$(", /\$\(/],
  ["`", /`/],
  [";", /;/],
  ["|", /\|/],
  ["&", /&/],
  ["(", /\(/],
  [")", /\)/],
  ["<", /</],
  [">", />/],
  ["cd", /(?:^|\s)cd(?:\s|$)/],
];

export function testCommandToken(command: string): string | null {
  for (const [token, pattern] of TEST_COMMAND_TOKENS) if (pattern.test(command)) return token;
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
  const edges = new Map<string, string[]>();
  const addEdge = (from: string, to: string) => edges.set(from, [...(edges.get(from) ?? []), to]);
  for (const item of [...p.tickets, ...p.checkpoints]) {
    if (kinds.get(item.phase) !== "phase") return `${item.key} names phase ${item.phase}, which is not a phase key`;
    for (const b of item.blockedBy) {
      if (!workItem(b)) return `${item.key} is blocked by ${b}, which is not a ticket or checkpoint key`;
      if (b === item.key) return `${item.key} is blocked by itself`;
      addEdge(item.key, b);
    }
  }
  for (const cp of p.checkpoints) {
    if ((cp.kind === "decision") !== (cp.question !== undefined) || (cp.kind === "acceptance") !== (cp.criteria !== undefined)) {
      return `${cp.key} is a ${cp.kind} checkpoint and needs exactly its ${cp.kind === "decision" ? "question" : "criteria"}`;
    }
    for (const g of cp.gates) {
      if (!workItem(g)) return `${cp.key} gates ${g}, which is not a ticket or checkpoint key`;
      if (g === cp.key) return `${cp.key} gates itself`;
      addEdge(g, cp.key);
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
    const token = comp.test ? testCommandToken(comp.test.command) : null;
    if (token !== null) {
      return `component ${comp.id}'s test command uses ${token === "cd" ? "a cd step" : token === "a newline" ? token : `\`${token}\``}, but a component's test command is one invocation run from its workdir. ` +
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
  if (p.frozen && escapes(p.frozen.handover.path)) return `the frozen handover path leaves the project: ${p.frozen.handover.path}`;
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
  return null;
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
