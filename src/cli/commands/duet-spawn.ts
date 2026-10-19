import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  spawnWorker, prepareSpawnDir, writeSpawnJournal, readSpawnJournal, mintWorkerTaskId, resolveWorkerDir, resolvePermissionMode,
  permissionModeReason, buildWorkerCommand, defaultWorkerRole, validateWorkerName, detectPenPermissionMode, osLauncher, PERMISSION_MODES, shellQuote,
  handshakeSection, ledgerParagraph, SPAWN_STAGES, resolveWorkerModel, workerModelReason, launchProjectRoot, launchEnvPrefix,
  type Launcher, type PenModeDetector, type SpawnHandshake, type SpawnStage, type SpawnWorkerResult,
} from "../../core/duet-spawn.js";
import { ExitCode } from "../../core/output-formatter.js";
import { loadArrangementsSafe } from "../../core/arrangement-loader.js";
import { coordinateDuet, readDuetCoordination, type DuetView } from "../../core/duet-coordination.js";
import { loadProject } from "../../core/project-loader.js";
import { currentClientTaskId, currentStorybloqClient, type StorybloqClient } from "../../autonomous/client-profile.js";
import { handleArrangementCreate } from "./arrangement.js";
import { CliValidationError } from "../helpers.js";
import type { CommandResult } from "../types.js";
import type { OutputFormat } from "../../models/types.js";
import type { DuetOperation } from "../../models/duet.js";
import type { Arrangement } from "../../models/arrangement.js";
import { isAbsolute } from "node:path";
import { readFileSync, realpathSync } from "node:fs";

/**
 * `storybloq duet spawn` (N-131, T-530): the pen starts a visible worker session
 * that handshakes by itself. One call mints the worker's identity, creates the
 * arrangement, starts coordination, writes the role with the handshake facts,
 * and opens the window with `/story` as its first prompt. The pen records the
 * receipt only after it OBSERVES the worker's nonce echo; nothing here proves
 * the return route.
 */
export interface DuetSpawnArgs {
  readonly name?: string;
  readonly pen?: string;
  readonly model?: string;
  readonly dir?: string;
  readonly role?: string;
  readonly permissionMode?: string;
  readonly terminal?: string;
  readonly print?: boolean;
  readonly arrangement?: "auto" | "none";
  readonly bounds?: readonly string[];
  readonly autoLoad?: boolean;
  readonly penTaskId?: string;
  readonly recover?: boolean;
}

export interface DuetSpawnDeps {
  readonly launcher?: Launcher;
  readonly detect?: PenModeDetector;
  /** The pen's client; default: the environment's. Automatic handshakes need a Claude pen (D5). */
  readonly client?: StorybloqClient;
  readonly coordinate?: (root: string, op: DuetOperation) => Promise<DuetView>;
  readonly createArrangement?: typeof handleArrangementCreate;
  readonly journal?: (path: string, entry: Record<string, unknown>) => void;
}

interface ArrangementDecision {
  readonly mode: "auto" | "none";
  readonly reason: string | null;
}

export interface SpawnResultView extends SpawnWorkerResult {
  readonly journalPath: string;
  readonly arrangement:
    | { mode: "auto"; id: string; coordinationSessionId: string; bounds: readonly string[] }
    | { mode: "none"; reason: string };
}

const CLOSE = (id: string) => `close it with \`storybloq arrangement update ${id} --lifecycle closed\``;

function refuse(message: string): never {
  throw new CliValidationError("invalid_input", message);
}

/** Every deterministic check, before any ledger write (plan D4). */
async function validate(args: DuetSpawnArgs, root: string, penTaskId: string | null, client: StorybloqClient): Promise<{ decision: ArrangementDecision; workerDir: string; workerProjectRoot: string | null }> {
  const name = args.name ?? "";
  const pen = args.pen ?? "";
  try {
    validateWorkerName(name);
    validateWorkerName(pen);
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error));
  }
  if (name === pen) refuse("The worker name must differ from the pen name.");
  if (args.permissionMode !== undefined && args.permissionMode !== "" && !(PERMISSION_MODES as readonly string[]).includes(args.permissionMode)) {
    refuse(`Unknown permission mode "${args.permissionMode}"; one of ${PERMISSION_MODES.join(", ")}.`);
  }
  if (args.role) {
    const customPath = isAbsolute(args.role) ? args.role : resolve(root, args.role);
    try { readFileSync(customPath, "utf-8"); } catch (error) { refuse(`Role file ${customPath} cannot be read: ${(error as NodeJS.ErrnoException).code ?? String(error)}`); }
  }
  let resolved: { workerDir: string; workerProjectRoot: string | null };
  try { resolved = resolveWorkerDir(root, args.dir); } catch (error) { refuse(error instanceof Error ? error.message : String(error)); }

  // Mode (plan step 2): a Claude pen with a task id gets `auto`, and missing
  // bounds is a refusal, never a quiet fallback to the manual flow.
  let decision: ArrangementDecision;
  const blocker = penTaskId === null
    ? "no pen task id (CLAUDE_CODE_SESSION_ID / CODEX_THREAD_ID unset); pass --pen-task-id <id>"
    : client !== "claude"
      ? "automatic handshake needs a Claude pen (native-return over SendMessage); codex pens handshake manually"
      : null;
  if (args.arrangement === "none") decision = { mode: "none", reason: "requested with --arrangement none" };
  else if (blocker !== null) {
    if (args.arrangement === "auto") refuse(`--arrangement auto is not possible: ${blocker}`);
    decision = { mode: "none", reason: blocker };
  } else decision = { mode: "auto", reason: null };

  if (decision.mode === "auto") {
    const bounds = args.bounds ?? [];
    if (bounds.length === 0) refuse("--bounds is required for the automatic handshake; pass --arrangement none for a manual one");
    // ISS-1305: a --dir with no ledger is no refusal; the launch points the
    // worker's /story at this board (resolveWorkerDir already refused a pen
    // whose own project does not resolve).
    const { state } = await loadProject(root);
    for (const ref of bounds) {
      if (ref.includes(":")) continue; // node-qualified refs resolve inside arrangement create
      const known = state.tickets.some((t) => t.id === ref || t.displayId === ref) || state.issues.some((i) => i.id === ref || i.displayId === ref);
      if (!known) refuse(`--bounds ${ref}: no ticket or issue with that id on this board`);
    }
  }
  return { decision, workerDir: resolved.workerDir, workerProjectRoot: resolved.workerProjectRoot };
}

export async function handleDuetSpawn(args: DuetSpawnArgs, format: OutputFormat, root: string, deps: DuetSpawnDeps = {}): Promise<CommandResult> {
  if (args.recover) return recover(root, format);
  const client = deps.client ?? currentStorybloqClient();
  const penTaskId = currentClientTaskId(args.penTaskId ?? null);
  const v = await validate(args, root, penTaskId, client);
  const name = args.name!;
  const pen = args.pen!;
  const autoLoad = args.autoLoad ?? true;
  const detect = deps.detect ?? detectPenPermissionMode;
  const launcher = deps.launcher ?? osLauncher;
  const journalWrite = deps.journal ?? writeSpawnJournal;
  const bounds = [...(args.bounds ?? [])];

  if (args.print) return renderPrint(args, root, v, name, pen, autoLoad, penTaskId, detect, bounds, format);

  // From here on every side effect is announced in the journal first.
  const spawnDir = prepareSpawnDir(root, name);
  const journalPath = join(spawnDir, `${name}.json`);
  const workerTaskId = mintWorkerTaskId();
  const proposedCoordinationSessionId = randomUUID();
  const base: Record<string, unknown> = { name, pen, workerTaskId, penTaskId, penClient: client, workerDir: v.workerDir, bounds, arrangementMode: v.decision.mode, proposedCoordinationSessionId: v.decision.mode === "auto" ? proposedCoordinationSessionId : null, arrangementId: null, createdAt: new Date().toISOString() };
  let last: SpawnStage | null = null;
  const journal = (stage: SpawnStage, extra: Record<string, unknown> = {}) => {
    Object.assign(base, extra, { stage });
    journalWrite(journalPath, { ...base });
    last = stage;
  };

  let handshake: SpawnHandshake | undefined;
  let arrangementId: string | null = null;
  try {
    journal("intent");
    if (v.decision.mode === "auto") {
      const created = await (deps.createArrangement ?? handleArrangementCreate)({
        bounds,
        parties: [
          { role: "pen", client: "claude", identityAnchor: penTaskId! },
          // ISS-1303: the model the worker actually runs, the default included.
          { role: "worker", client: "claude", identityAnchor: workerTaskId, modelTier: resolveWorkerModel(args.model).model },
        ],
        onIrreversibleWork: "hold",
      }, "json", root);
      arrangementId = (JSON.parse(created.output) as { data: { id: string } }).data.id;
      base.arrangementId = arrangementId;
      journal("created", { arrangementId });
      journal("start-attempted");
      const view = await (deps.coordinate ?? coordinateDuet)(root, {
        action: "start", id: arrangementId, expectedRevision: 0, expectedSessionId: null, newSessionId: proposedCoordinationSessionId, mode: "native-return", clientTaskId: penTaskId!,
      });
      if (!view.state) throw new Error("coordination start returned no runtime");
      journal("started");
      handshake = { penTaskId: penTaskId!, penClient: "claude", arrangementId, coordinationSessionId: proposedCoordinationSessionId, nonce: view.state.nonce };
    }
    const result = spawnWorker(root, {
      name, pen, model: args.model, dir: args.dir, role: args.role, terminal: args.terminal, permissionMode: args.permissionMode,
      workerTaskId, autoLoad, ...(handshake ? { handshake } : {}), penProjectRoot: root, workerDir: v.workerDir, workerProjectRoot: v.workerProjectRoot, spawnDir, journal,
    }, launcher, detect);
    const view: SpawnResultView = {
      ...result,
      journalPath,
      arrangement: handshake
        ? { mode: "auto", id: handshake.arrangementId, coordinationSessionId: handshake.coordinationSessionId, bounds }
        : { mode: "none", reason: v.decision.reason ?? "" },
    };
    return { output: render(view, format), exitCode: ExitCode.OK };
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    const journalEntry = readSpawnJournal(journalPath) ?? { ...base, stage: last ?? "intent" };
    const rec = reconcileSpawnJournal(root, journalEntry);
    throw new Error(`duet spawn failed (${cause}). ${rec.recommendation} Worker task id ${workerTaskId}; journal ${journalPath}; \`storybloq duet spawn --recover\` lists it.`);
  }
}

/** Reconciled state of one spawn journal: two independent axes and their join (plan D4). */
export interface SpawnReconciliation {
  readonly name: string | null;
  readonly workerTaskId: string | null;
  readonly stage: string | null;
  readonly launch: "not-launched" | "unknown" | "launched" | "manual";
  readonly coordination: "no-arrangement" | "closed" | "unresolved" | "not-started" | "started-no-receipt" | "receipt" | "superseded" | "none-requested";
  readonly arrangementId: string | null;
  readonly cleanup: boolean;
  readonly recommendation: string;
}

export function reconcileSpawnJournal(root: string, journal: Record<string, unknown>): SpawnReconciliation {
  const name = typeof journal.name === "string" ? journal.name : null;
  const workerTaskId = typeof journal.workerTaskId === "string" ? journal.workerTaskId : null;
  const rawStage = typeof journal.stage === "string" ? journal.stage : null;
  const stage = rawStage !== null && (SPAWN_STAGES as readonly string[]).includes(rawStage) ? rawStage : null;
  const proposed = typeof journal.proposedCoordinationSessionId === "string" ? journal.proposedCoordinationSessionId : null;
  const requested = journal.arrangementMode === "auto";

  // LAUNCH axis: the journal alone. A launcher that ran may have opened the
  // window whatever happened next, and a journal whose stage is missing or
  // unrecognised proves nothing either way (byte-review F2): both are UNKNOWN,
  // and UNKNOWN never offers cleanup.
  const launch: SpawnReconciliation["launch"] = stage === "launched" ? "launched" : stage === "launch-manual" ? "manual" : stage === "launch-attempted" || stage === null ? "unknown" : "not-launched";
  const launchText = launch === "launched" ? "launched; await the echo"
    : launch === "manual" ? "no OS launcher: the printed command was left for the pen to run by hand, and whether that happened is UNVERIFIED"
    : launch === "unknown" ? (stage === null ? `journal stage ${rawStage === null ? "missing" : `"${rawStage}"`} is not recognised: launch outcome UNKNOWN` : "launch outcome UNKNOWN (the OS may have opened the window)")
    : "not launched by this spawn";

  // COORDINATION axis: the ledger, never the stage.
  let coordination: SpawnReconciliation["coordination"];
  let arrangementId: string | null = null;
  let coordText: string;
  if (!requested) {
    coordination = "none-requested";
    coordText = "no arrangement was requested";
  } else {
    const scan = loadArrangementsSafe(root);
    const match = workerTaskId === null ? undefined : scan.arrangements.find((a) => a.parties.some((p) => p.role === "worker" && p.identityAnchor === workerTaskId));
    if (!match) {
      if (scan.warnings.length > 0) { coordination = "unresolved"; coordText = `arrangements could not be read (${scan.warnings[0]}); inspect before any cleanup`; }
      else { coordination = "no-arrangement"; coordText = "no arrangement bears this worker id: nothing to clean up"; }
    } else {
      arrangementId = match.id;
      coordText = describeCoordination(root, match, proposed);
      coordination = classify(root, match, proposed);
    }
  }

  // A manual launch is never cleanup-eligible: the journal proves the OS
  // launcher did nothing, not that the pen did not paste the command
  // afterwards (byte-review round 2).
  const cleanup = launch === "not-launched" && (coordination === "not-started" || coordination === "started-no-receipt");
  let recommendation: string;
  if (cleanup) recommendation = `arrangement ${arrangementId} ${coordText}, worker ${workerTaskId ?? "?"} ${launchText}: ${CLOSE(arrangementId!)} or run the printed command by hand.`;
  else if (launch === "manual") recommendation = `${launchText}; ${arrangementId ? `arrangement ${arrangementId} ${coordText}; ` : ""}check \`storybloq roster list\` for claude:${workerTaskId ?? "?"} and wait for the nonce echo before closing the arrangement.`;
  else if (launch === "unknown") recommendation = `${launchText}; ${arrangementId ? `arrangement ${arrangementId} ${coordText}; ` : ""}check \`storybloq roster list\` for claude:${workerTaskId ?? "?"} and wait for the nonce echo before closing the arrangement or spawning again.`;
  else if (launch === "launched") {
    // ISS-1294: the echo is awaited only while the handshake is open. A
    // launched worker holds the nonce, so an unreadable runtime is uncertain,
    // not settled; every other state has no echo coming for this journal.
    const head = coordination === "not-started" || coordination === "started-no-receipt" ? launchText
      : coordination === "receipt" ? "launched; handshake complete"
      : coordination === "unresolved" ? "launched; handshake status unknown, an echo may still arrive"
      : coordination === "superseded" ? "launched; the spawn challenge is superseded"
      : "launched";
    const tail = coordination === "closed" ? "; this journal is historical and can be deleted" : "";
    recommendation = `${head}; ${arrangementId ? `arrangement ${arrangementId} ${coordText}` : coordText}${tail}.`;
  }
  else if (coordination === "no-arrangement" || coordination === "none-requested") recommendation = `${launchText}; ${coordText}.`;
  else recommendation = `${launchText}; arrangement ${arrangementId} ${coordText}; inspect before acting.`;
  return { name, workerTaskId, stage, launch, coordination, arrangementId, cleanup, recommendation };
}

function classify(root: string, a: Arrangement, proposed: string | null): SpawnReconciliation["coordination"] {
  if (a.lifecycle !== "active" || a.continuedBy) return "closed";
  const view = readDuetCoordination(root, a);
  if (view.route.status === "recovery-required" || view.route.status === "conflicted") return "unresolved";
  if (!a.currentCoordinationSessionId) return "not-started";
  if (a.currentCoordinationSessionId !== proposed) return "superseded";
  return view.route.status === "current" ? "receipt" : "started-no-receipt";
}

function describeCoordination(root: string, a: Arrangement, proposed: string | null): string {
  switch (classify(root, a, proposed)) {
    case "closed": return `is ${a.continuedBy ? `continued by ${a.continuedBy}` : a.lifecycle}; nothing to close`;
    case "unresolved": return `has a runtime that cannot be read: UNRESOLVED, inspect \`storybloq arrangement get ${a.id}\` before any cleanup`;
    case "not-started": return "created, coordination not started";
    case "superseded": return `coordination was rotated or recovered after this spawn (now ${a.currentCoordinationSessionId}): SUPERSEDED, this journal is historical, do not close on its account`;
    case "receipt": return `coordination ${a.currentCoordinationSessionId} started, receipt recorded`;
    default: return `coordination ${a.currentCoordinationSessionId} started, no receipt yet`;
  }
}

function listJournals(root: string): Array<{ path: string; entry: Record<string, unknown> | null }> {
  const spawnRoot = join(root, ".story", "spawn");
  if (!existsSync(spawnRoot)) return [];
  const out: Array<{ path: string; entry: Record<string, unknown> | null }> = [];
  for (const d of readdirSync(spawnRoot, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    for (const f of readdirSync(join(spawnRoot, d.name))) {
      if (!f.endsWith(".json")) continue;
      const path = join(spawnRoot, d.name, f);
      out.push({ path, entry: readSpawnJournal(path) });
    }
  }
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

function recover(root: string, format: OutputFormat): CommandResult {
  const journals = listJournals(root);
  const candidates = journals.map(({ path, entry }) => {
    if (entry === null) return { path, name: null, workerTaskId: null, stage: null, launch: "unknown" as const, coordination: "unresolved" as const, arrangementId: null, cleanup: false, recommendation: "journal unreadable: UNRESOLVED, inspect the directory before acting." };
    return { path, ...reconcileSpawnJournal(root, entry) };
  });
  if (format === "json") return { output: JSON.stringify({ version: 1, data: { candidates } }, null, 2), exitCode: ExitCode.OK };
  if (candidates.length === 0) return { output: "No spawn journals under .story/spawn/.", exitCode: ExitCode.OK };
  const lines = ["# Spawn journals (read-only; a journal short of `launched` is a recovery candidate, never proof the worker is absent)", ""];
  for (const c of candidates) {
    lines.push(`- ${c.name ?? "?"} (${c.workerTaskId ?? "?"}, stage ${c.stage ?? "?"}): ${c.recommendation} [${c.path}]`);
  }
  return { output: lines.join("\n"), exitCode: ExitCode.OK };
}

function receiptCommand(name: string, h: SpawnHandshake, workerTaskId: string): string {
  const op = {
    action: "receipt", id: h.arrangementId, expectedRevision: 1, expectedSessionId: h.coordinationSessionId, clientTaskId: h.penTaskId,
    receipt: { id: `rcpt-${name}-1`, nonce: h.nonce, direction: "worker-to-manager", source: { client: "claude", id: workerTaskId }, destination: { client: "claude", id: h.penTaskId }, mode: "native-return", senderTool: "<from the echo line>", collectionTool: null, observedAt: "<fill at observation>" },
  };
  return `storybloq arrangement coordinate ${h.arrangementId} --json '${JSON.stringify(op)}'`;
}

function render(r: SpawnResultView, format: OutputFormat): string {
  if (format === "json") return JSON.stringify({ version: 1, data: r }, null, 2);
  const lines = [
    r.launch === "opened" ? `Opened worker "${r.name}" in a new terminal window (${r.launcher}).` : `Worker "${r.name}" is ready to start. Paste this in a terminal:`,
    "",
    "    " + r.command,
    "",
    `Worker task id: ${r.workerTaskId}`,
    `Model: ${r.model} (${r.modelReason})`,
    `Permission mode: ${r.permissionMode} (${r.permissionModeReason})`,
    `Role: ${r.rolePath}`,
    `Script: ${r.scriptPath}`,
    `Journal: ${r.journalPath}`,
  ];
  if (r.workerProjectRoot === null) lines.push(`Worker ledger: the pen's board at ${realpathOrSelf(r.penProjectRoot)}; ${r.workerDir} carries no ledger`);
  else if (r.workerProjectRoot !== realpathOrSelf(r.penProjectRoot)) lines.push(`Worker ledger: ${r.workerProjectRoot}`);
  if (r.arrangement.mode === "auto" && r.handshake) {
    lines.push(`Arrangement: ${r.arrangement.id}, coordination ${r.arrangement.coordinationSessionId}, nonce issued; bounds ${r.arrangement.bounds.join(", ")}`);
    lines.push("", r.autoLoad
      ? `The worker loads /story on its own and sends the nonce to you by name. When the nonce echo arrives from ${r.name}, record the receipt:`
      : `--no-auto-load: type /story in the worker window first; the role then tells it to send the nonce to you by name. When the nonce echo arrives from ${r.name}, record the receipt:`,
      "", "    " + receiptCommand(r.name, r.handshake, r.workerTaskId), "", "Fill observedAt with the time you saw the echo and senderTool with the tool the worker named. Then dispatch.");
  } else {
    lines.push(`Arrangement: none (${r.arrangement.mode === "none" ? r.arrangement.reason : ""})`);
    lines.push("", `Once the session is up${r.autoLoad ? "" : ", type /story in it"}, then handshake by name from the pen (${penFromCommand(r)}): project, both identities, coordination session id, nonce.`);
  }
  return lines.join("\n");
}

function penFromCommand(r: SpawnResultView): string {
  const m = /for pen (\S+)\./.exec(readFileSync(r.scriptPath, "utf-8"));
  return m?.[1] ?? "the pen";
}

function realpathOrSelf(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

function renderPrint(args: DuetSpawnArgs, root: string, v: Awaited<ReturnType<typeof validate>>, name: string, pen: string, autoLoad: boolean, penTaskId: string | null, detect: PenModeDetector, bounds: string[], format: OutputFormat): CommandResult {
  const { mode, source } = resolvePermissionMode(args.permissionMode, detect);
  const { model, source: modelSource } = resolveWorkerModel(args.model);
  const auto = v.decision.mode === "auto";
  const placeholderHandshake: SpawnHandshake | undefined = auto ? { penTaskId: penTaskId!, penClient: "claude", arrangementId: "<created at launch>", coordinationSessionId: "<started at launch>", nonce: "<nonce issued at launch>" } : undefined;
  const rolePath = `<${name}-role.md, written at launch>`;
  const command = `cd ${shellQuote(v.workerDir)} && ${launchEnvPrefix(launchProjectRoot(root, v.workerProjectRoot))}claude -n ${shellQuote(name)} --session-id '<minted at launch>' --model ${shellQuote(model)} --permission-mode ${shellQuote(mode)} --append-system-prompt-file '${rolePath}'${autoLoad ? " '/story'" : ""}`;
  const ctx = { workerDir: v.workerDir, penProjectRoot: root, workerProjectRoot: v.workerProjectRoot, workerTaskId: "<minted at launch>", ...(placeholderHandshake ? { handshake: placeholderHandshake } : {}) };
  let role: string;
  if (args.role) {
    const custom = readFileSync(isAbsolute(args.role) ? args.role : resolve(root, args.role), "utf-8").replace(/\s+$/, "");
    role = placeholderHandshake ? `${custom}\n\n## Ledger\n\n${ledgerParagraph(ctx)}\n\n${handshakeSection(pen, name, "<minted at launch>", placeholderHandshake)}` : custom;
  } else {
    role = defaultWorkerRole(pen, name, ctx);
  }
  const data = {
    name, workerTaskId: "<minted at launch>", command, model, modelSource, modelReason: workerModelReason(modelSource), permissionMode: mode, permissionModeSource: source, permissionModeReason: permissionModeReason(source), autoLoad, launch: "printed" as const, launcher: null,
    arrangement: auto ? { mode: "auto" as const, status: "skipped (--print)", bounds } : { mode: "none" as const, reason: v.decision.reason ?? "" },
    workerDir: v.workerDir, workerProjectRoot: v.workerProjectRoot, role,
  };
  if (format === "json") return { output: JSON.stringify({ version: 1, data }, null, 2), exitCode: ExitCode.OK };
  const lines = [
    `Dry run for worker "${name}": no arrangement created, no files written.`,
    "",
    "    " + command,
    "",
    `Model: ${model} (${workerModelReason(modelSource)})`,
    `Permission mode: ${mode} (${permissionModeReason(source)})`,
    auto ? `Arrangement: auto (skipped in --print). Bounds: ${bounds.join(", ")}` : `Arrangement: none (${v.decision.reason})`,
    "",
    "Role the worker would receive:",
    "",
    ...role.split("\n").map((l) => "    " + l),
  ];
  return { output: lines.join("\n"), exitCode: ExitCode.OK };
}

// buildWorkerCommand is re-exported for parity tests that compare the printed command with the real one.
export { buildWorkerCommand };
