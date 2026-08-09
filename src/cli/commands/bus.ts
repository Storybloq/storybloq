import type { Argv } from "yargs";
import {
  acknowledgeBusMessage,
  assertEndpointCaller,
  assessBusRuntime,
  busConfigRevertNote,
  busDoctor,
  busSummary,
  BUS_EVIDENCE_GITIGNORE_ENTRY,
  checkBusShip,
  classifyBusRuntime,
  countUndeliveredMessages,
  detectClientSurface,
  endpointLiveness,
  materializeSuccessorMailbox,
  evaluateV1Drain,
  exportBusThread,
  findEndpointForTask,
  findV1EndpointForTask,
  getBusThread,
  hopsRemainingFor,
  initializeBus,
  joinEndpoint,
  leaveEndpoint,
  listEndpoints,
  listV1Endpoints,
  pollBus,
  pollV1,
  redeliverBusMessage,
  refreshEndpointForSessionStart,
  retireEndpoint,
  runtimeLostError,
  describeDeliveryTiers,
  sendBusMessage,
  setBusHookPolicy,
  updateBusThread,
  updateV1Thread,
  v1EndpointLiveness,
  v1PathsFrom,
  waitForBusMessage,
  WaiterActiveError,
  WAIT_DEFAULT_TIMEOUT_SECONDS,
  WAIT_TIMEOUT_MAX_SECONDS,
  WAIT_TIMEOUT_MIN_SECONDS,
  type BusClient,
  type BusDeliveryCapabilities,
  type BusDoctorResult,
  type BusEndpoint,
  type BusHookPolicy,
  type BusMessageKind,
  type BusMessageRefs,
  type BusRuntimeProtocol,
  type BusSeverity,
  type BusSummary,
  type BusSurface,
  type BusThreadKind,
  type FoldedBusThread,
  type V1PollResult,
} from "../../bus/index.js";
import { BusError } from "../../bus/errors.js";
import { assertBusEnabled } from "../../bus/config.js";
import { attemptAutoAttach } from "../../bus/auto-attach.js";
import {
  clearAutoAttachOutcomes,
  listAutoAttachOutcomes,
  STATUS_FRESHNESS_MS,
  type AutoAttachOutcome,
} from "../../bus/auto-attach-outcome.js";
import { resolveBusPaths } from "../../bus/paths.js";
import { loadProject } from "../../core/project-loader.js";
import {
  currentStorybloqClient,
  normalizeClientTaskId,
  type StorybloqClient,
} from "../../autonomous/client-profile.js";
import { discoverProjectRoot } from "../../core/project-root-discovery.js";
import { ExitCode } from "../../core/output-formatter.js";
import { writeOutput } from "../run.js";
import { arrayOptions } from "../array-options.js";

type BusFormat = "md" | "json";

interface IdentityArgs {
  readonly endpoint?: string;
  readonly client?: StorybloqClient;
  readonly taskId?: string;
}

function formatData<T>(data: T, format: BusFormat, markdown: (value: T) => string): string {
  return format === "json"
    ? JSON.stringify({ version: 1, data }, null, 2)
    : markdown(data);
}

function formatFailure(err: unknown, format: BusFormat): string {
  const code = err instanceof BusError ? err.code : "io_error";
  const message = err instanceof Error ? err.message : String(err);
  return format === "json"
    ? JSON.stringify({ version: 1, error: { code, message } }, null, 2)
    : `Error [${code}]: ${message}`;
}

async function runBus<T>(
  format: BusFormat,
  action: (root: string) => Promise<T>,
  markdown: (value: T) => string,
  unhealthy?: (value: T) => boolean,
): Promise<void> {
  const root = discoverProjectRoot();
  if (!root) {
    writeOutput(formatFailure(new BusError("not_found", "No .story/ project found."), format));
    process.exitCode = ExitCode.USER_ERROR;
    return;
  }
  try {
    const result = await action(root);
    writeOutput(formatData(result, format, markdown));
    process.exitCode = unhealthy?.(result) ? ExitCode.VALIDATION_ERROR : ExitCode.OK;
  } catch (err) {
    writeOutput(formatFailure(err, format));
    // T-428: runtime_lost is a validation-class failure (like corrupt): the
    // runtime was deleted from this checkout, not a plain user/usage error.
    process.exitCode = err instanceof BusError && (err.code === "corrupt" || err.code === "runtime_lost")
      ? ExitCode.VALIDATION_ERROR
      : ExitCode.USER_ERROR;
  }
}

// T-427 rendezvous long-poll runner. Kept separate from runBus because it owns its
// own exit-code vocabulary (TIMEOUT=4, WAITER_ACTIVE=5, signals 130/143) that runBus
// -- which only knows OK/USER/VALIDATION -- would flatten. A timeout is a SUCCESS
// envelope (an empty poll) distinguished purely by the exit code, so a background
// `bus poll --wait` consumer can tell "nothing arrived" from "a message arrived"
// without parsing prose.
async function runBusWait(format: BusFormat, timeoutSeconds: number, limit: number, args: IdentityArgs): Promise<void> {
  const root = discoverProjectRoot();
  if (!root) {
    writeOutput(formatFailure(new BusError("not_found", "No .story/ project found."), format));
    process.exitCode = ExitCode.USER_ERROR;
    return;
  }
  // Validate --timeout BEFORE resolving identity or creating a waiter: a bad bound is
  // a usage error, not a wait that then fails.
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < WAIT_TIMEOUT_MIN_SECONDS || timeoutSeconds > WAIT_TIMEOUT_MAX_SECONDS) {
    writeOutput(formatFailure(
      new BusError("invalid_input", `--timeout must be an integer between ${WAIT_TIMEOUT_MIN_SECONDS} and ${WAIT_TIMEOUT_MAX_SECONDS} seconds.`),
      format,
    ));
    process.exitCode = ExitCode.USER_ERROR;
    return;
  }
  let owned: Awaited<ReturnType<typeof resolveOwnedEndpoint>>;
  try {
    owned = await resolveOwnedEndpoint(root, args);
  } catch (err) {
    writeOutput(formatFailure(err, format));
    process.exitCode = err instanceof BusError && (err.code === "corrupt" || err.code === "runtime_lost")
      ? ExitCode.VALIDATION_ERROR
      : ExitCode.USER_ERROR;
    return;
  }
  if (owned.protocol === "v1") {
    writeOutput(formatFailure(
      new BusError("invalid_input", "`bus poll --wait` requires a v2 Bus runtime. Run `storybloq bus setup` to migrate, then retry."),
      format,
    ));
    process.exitCode = ExitCode.USER_ERROR;
    return;
  }
  let outcome;
  try {
    outcome = await waitForBusMessage({
      root,
      endpointId: owned.endpointId,
      clientTaskId: owned.taskId,
      timeoutMs: timeoutSeconds * 1000,
      limit,
    });
  } catch (err) {
    if (err instanceof WaiterActiveError) {
      writeOutput(formatFailure(new BusError("conflict", err.message), format));
      process.exitCode = ExitCode.WAITER_ACTIVE;
      return;
    }
    writeOutput(formatFailure(err, format));
    process.exitCode = err instanceof BusError && (err.code === "corrupt" || err.code === "runtime_lost")
      ? ExitCode.VALIDATION_ERROR
      : ExitCode.USER_ERROR;
    return;
  }
  switch (outcome.kind) {
    case "message":
      writeOutput(formatData(outcome.result, format, renderPoll));
      process.exitCode = ExitCode.OK;
      return;
    case "timeout":
      // SUCCESS-shaped empty envelope carrying the final authoritative poll's REAL
      // endpointId/cursor (not a fabricated 0); the exit code (4) is the timeout signal.
      writeOutput(formatData(outcome.result, format, renderPoll));
      process.exitCode = ExitCode.TIMEOUT;
      return;
    case "error":
      writeOutput(formatFailure(outcome.err, format));
      process.exitCode = outcome.errorClass === "validation" ? ExitCode.VALIDATION_ERROR : ExitCode.USER_ERROR;
      return;
    case "signal":
      process.exitCode = outcome.code;
      return;
  }
}

function resolveClient(explicit?: StorybloqClient): BusClient {
  return explicit ?? currentStorybloqClient();
}

function resolveTaskId(client: BusClient, explicit?: string): string {
  const ambient = client === "codex" ? process.env.CODEX_THREAD_ID : process.env.CLAUDE_CODE_SESSION_ID;
  const taskId = normalizeClientTaskId(explicit ?? ambient);
  if (!taskId) {
    throw new BusError(
      "invalid_input",
      `A valid ${client === "codex" ? "Codex task" : "Claude session"} id is required. Pass --task-id explicitly.`,
    );
  }
  return taskId;
}

// Resolves the task-owned endpoint id. On a v1 runtime the endpoint registry is
// read through legacy-v1.ts (v2 parsing would reject the v1 records), so the
// D5 legacy-drain commands (poll/ack/thread park-resolve) can resolve identity.
async function resolveOwnedEndpoint(root: string, args: IdentityArgs): Promise<{ endpointId: string; taskId: string; protocol: BusRuntimeProtocol }> {
  // Bus must be enabled before touching any runtime. classifyBusRuntime below
  // does not assert this, so on a disabled project with residual v1 (or v2) files
  // the endpoint-scoped drain ops (poll, ack, thread update) could otherwise still
  // resolve identity and mutate. Fail closed with `bus_disabled` first.
  assertBusEnabled((await loadProject(root)).state.config);
  const client = resolveClient(args.client);
  const taskId = resolveTaskId(client, args.taskId);
  const protocol = await classifyBusRuntime(root);
  if (protocol === "v1") {
    const endpointId = args.endpoint ?? await findV1EndpointForTask(root, client, taskId);
    if (!endpointId) {
      throw new BusError("not_found", "This task has no Bus endpoint. Run `storybloq bus setup` first.");
    }
    return { endpointId, taskId, protocol };
  }
  // T-428: the SECOND op chokepoint. Classify loss/evidence BEFORE endpoint
  // lookup so a deleted runtime surfaces `runtime_lost`, not a confusing endpoint
  // `not_found` (which reads as "you never joined" rather than "your runtime was
  // deleted"). Runs after the v1 branch so a v1 runtime is never assessed as v2.
  const assessment = await assessBusRuntime(root);
  if (assessment.kind === "lost") throw runtimeLostError(assessment);
  if (assessment.kind === "evidence_corrupt") {
    throw new BusError("corrupt", `Bus deletion-evidence is unreadable (${assessment.detail}). Run \`storybloq bus doctor\`.`);
  }
  if (args.endpoint) {
    const endpoint = await assertEndpointCaller(root, args.endpoint, taskId);
    return { endpointId: endpoint.endpointId, taskId, protocol };
  }
  const endpoint = await findEndpointForTask(root, client, taskId);
  if (!endpoint) {
    throw new BusError("not_found", "This task has no Bus endpoint. Run `storybloq bus setup` first.");
  }
  return { endpointId: endpoint.endpointId, taskId, protocol };
}

function identityOptions<T>(y: Argv<T>): Argv {
  return y
    .option("endpoint", { type: "string", describe: "Endpoint id; inferred from the current task when omitted" })
    .option("client", { type: "string", choices: ["claude", "codex"] as const, describe: "Client profile" })
    .option("task-id", { type: "string", describe: "Validated client task id" });
}

function formatOption<T>(y: Argv<T>): Argv {
  return y.option("format", {
    type: "string",
    choices: ["md", "json"] as const,
    default: "md",
    describe: "Output format",
  });
}

function formatValue(raw: unknown): BusFormat {
  return raw === "json" ? "json" : "md";
}

function identityFrom(argv: Record<string, unknown>): IdentityArgs {
  return {
    endpoint: argv.endpoint as string | undefined,
    client: argv.client as StorybloqClient | undefined,
    taskId: argv["task-id"] as string | undefined,
  };
}

function refsFrom(argv: Record<string, unknown>): BusMessageRefs {
  const files = argv.file as string[] | undefined;
  return {
    ...(argv.issue ? { issue: argv.issue as string } : {}),
    ...(argv.ticket ? { ticket: argv.ticket as string } : {}),
    ...(argv.commit ? { commit: argv.commit as string } : {}),
    ...(argv["ci-run"] ? { ciRun: argv["ci-run"] as string } : {}),
    ...(files?.length ? { files } : {}),
  };
}

function serializedThread(folded: FoldedBusThread) {
  return {
    thread: folded.thread,
    entries: folded.entries,
    validThroughSeq: folded.validThroughSeq,
    lastHash: folded.lastHash,
    state: folded.state,
    hopCount: folded.hopCount,
    hopsRemaining: hopsRemainingFor(folded),
    acknowledgments: Object.fromEntries(folded.acknowledgments),
    seenEvidence: [...folded.seenEvidence].sort(),
    integrity: folded.integrity,
    finding: folded.finding ?? null,
    refusals: folded.refusals,
  };
}

function renderPoll(result: Awaited<ReturnType<typeof pollBus>>): string {
  if (result.messages.length === 0) return "No pending Bus messages.";
  return result.messages.map((envelope) => [
    `[${envelope.mailboxSeq}] ${envelope.sender.role ?? "peer"} ${envelope.message.severity} ${envelope.message.kind}`,
    `Thread: ${envelope.threadId} | Message: ${envelope.message.messageId}`,
    envelope.message.body,
  ].join("\n")).join("\n\n");
}

function renderV1Poll(result: V1PollResult): string {
  if (result.messages.length === 0) return "No pending Bus messages.";
  return result.messages.map((envelope) => [
    `[${envelope.mailboxSeq}] ${envelope.sender.role} ${envelope.message.severity} ${envelope.message.kind}`,
    `Thread: ${envelope.threadId} | Message: ${envelope.message.messageId}`,
    envelope.message.body,
  ].join("\n")).join("\n\n");
}

function clientLabel(surface: BusSurface): string {
  return surface === "claude_cli" ? "Claude Code" : surface === "codex_cli" ? "Codex CLI" : "Codex Desktop";
}

function joinLabels(labels: string[]): string {
  if (labels.length === 0) return "no clients";
  if (labels.length === 1) return labels[0]!;
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

// T-427: honest delivery label driven by the VERIFIED per-tier capabilities, not
// the policy-only `deliveryMode` enum. Never emits "live" (the word oversells a
// notify-on-boundary channel as real-time push); `describeDeliveryTiers` is the
// single source of tier wording, shared with the core status formatter.
function deliveryLabel(caps: BusDeliveryCapabilities): string {
  return `delivery: ${describeDeliveryTiers(caps)}`;
}

function renderReadiness(setupState: BusSummary["setupState"]): string {
  switch (setupState) {
    case "ready": return "Bus ready.";
    case "waiting_for_peer": return "setup waiting for a peer.";
    case "disconnected": return "no endpoints connected. Run `storybloq bus setup`.";
    case "invalid": return "setup invalid; run `storybloq bus doctor`.";
    case "runtime_lost": return "the Bus runtime is absent or no longer matches this checkout's deletion-evidence; run `storybloq bus setup` to re-establish it.";
    case "disabled": return "the Bus is disabled. Run `storybloq bus setup`.";
    default: return "the Bus is not set up. Run `storybloq bus setup`.";
  }
}

// D7: doctor Markdown must omit raw endpoint UUIDs (JSON retains them). Relabels
// ONLY the known endpoint ids to a short stable `endpoint-<first8>` tag so a
// finding stays legible without leaking the full identifier. Thread, message,
// and every other UUID are the exact identifiers a user needs to inspect or
// repair, so they are left intact (a broad UUID regex would destroy them).
function redactEndpointUuids(text: string, endpointIds: ReadonlySet<string>): string {
  let redacted = text;
  for (const endpointId of endpointIds) {
    redacted = redacted.split(endpointId).join(`endpoint-${endpointId.slice(0, 8)}`);
  }
  return redacted;
}

// D7: build the known-endpoint UUID set the Markdown redaction relabels. The
// source depends on the runtime: a v2 runtime enumerates the v2 endpoint
// registry; a v1 runtime reads the LEGACY registry (v2 parsing rejects v1
// records, returning an empty set that would leak v1 endpoint UUIDs into
// Markdown). For v1 we also extract any well-formed UUID from the endpoint-record
// findings themselves, so a malformed record whose id never parsed into the
// registry is still redacted. Thread/message UUIDs are deliberately left intact
// (only `endpoint:`-prefixed findings are scanned). Every registry read is
// guarded; any failure falls back to an empty set so doctor always renders.
const ENDPOINT_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Anchored, non-global variant for testing a single directory name (a global
// regex would carry lastIndex state across .test calls).
const ENDPOINT_UUID_EXACT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function doctorEndpointRedactionSet(root: string, result: BusDoctorResult): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  try {
    // The parsed registry gives the well-formed endpoint ids (v1 or v2). A
    // MALFORMED endpoint record is dropped from that parse but still surfaces its
    // UUID filename inside an `endpoint:`-prefixed doctor finding, so both
    // protocols also extract those finding UUIDs; otherwise a malformed record's
    // endpoint UUID would leak unredacted in the Markdown.
    if (await classifyBusRuntime(root) === "v1") {
      try {
        const paths = await resolveBusPaths(root, false);
        const { endpoints } = await listV1Endpoints(v1PathsFrom(paths.busRoot));
        for (const endpoint of endpoints) ids.add(endpoint.endpointId);
      } catch {
        // Registry unreadable; finding-extracted UUIDs below still get redacted.
      }
    } else {
      try {
        const { endpoints } = await listEndpoints(root);
        for (const endpoint of endpoints) ids.add(endpoint.endpointId);
      } catch {
        // Registry unreadable; finding-extracted UUIDs below still get redacted.
      }
      // An orphaned mailbox or idempotency directory keeps a retired endpoint's
      // UUID on disk after its registry record is gone, and a `receipt ...`/mailbox
      // finding referencing it is not `endpoint:`-prefixed, so its UUID would leak
      // unredacted. Add every UUID-named mailbox/idempotency directory name too.
      try {
        const { readdir } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const paths = await resolveBusPaths(root, false);
        for (const sub of ["mailboxes", "idempotency"]) {
          const entries = await readdir(join(paths.busRoot, sub), { withFileTypes: true }).catch(() => []);
          for (const entry of entries) {
            // Match on the UUID name regardless of file type: a symlink or regular
            // file named with an orphaned endpoint UUID is exactly the corrupt layout
            // doctor reports, and that finding is not `endpoint:`-prefixed, so its
            // UUID would otherwise leak. The name is the redaction hint.
            if (ENDPOINT_UUID_EXACT.test(entry.name)) ids.add(entry.name);
          }
        }
      } catch {
        // Runtime layout unreadable; registry + finding UUIDs above still redacted.
      }
    }
    for (const finding of result.findings) {
      if (!/^endpoint:/i.test(finding)) continue;
      // Add the literal matched text (not lowercased) so the exact-string
      // redaction split matches the UUID as it appears in the finding. Only
      // endpoint-prefixed findings are scanned, so thread/message UUIDs survive.
      for (const match of finding.matchAll(ENDPOINT_UUID)) ids.add(match[0]);
    }
    return ids;
  } catch {
    return ids;
  }
}

function renderDoctorMarkdown(result: BusDoctorResult, endpointIds: ReadonlySet<string>): string {
  // D7: readiness is always rendered, separately from integrity.
  const readiness = renderReadiness(result.summary.setupState);
  // ISS-1002 follow-up: notices render regardless of `healthy` -- they are
  // non-gating BY DESIGN (see BusDoctorResult.notices), which means the
  // early "healthy" return below must not skip them, or the signal is
  // dropped as silently as the gating it was built to replace.
  const notices = result.notices.length > 0
    ? `\nNotice(s):\n${result.notices.map((notice) => `- ${redactEndpointUuids(notice, endpointIds)}`).join("\n")}`
    : "";
  if (result.healthy) return `Storage healthy; ${readiness}${notices}`;
  const findings = `Storage has ${result.findings.length} finding(s):\n${result.findings.map((finding) => `- ${redactEndpointUuids(finding, endpointIds)}`).join("\n")}`;
  return `${findings}\nReadiness: ${readiness}${notices}`;
}

// FIX: `busDoctor` throws `bus_disabled` on a disabled project, which would
// otherwise surface as a bare error. Render a coherent disabled readiness result
// instead, matching how `bus status` guides a disabled project.
interface DisabledDoctorResult {
  readonly enabled: false;
  readonly healthy: false;
  readonly readiness: string;
  // T-428: set when features.bus is off but deletion-evidence names an instance
  // this checkout stood up (a likely config revert).
  readonly configRevert?: string;
}

function disabledDoctorResult(configRevert?: string | null): DisabledDoctorResult {
  return {
    enabled: false,
    healthy: false,
    readiness: renderReadiness("disabled"),
    ...(configRevert ? { configRevert } : {}),
  };
}

function renderDoctorDisabledMarkdown(result: DisabledDoctorResult): string {
  const lines = [`Bus: disabled. Run \`storybloq bus setup\` to enable.`];
  if (result.configRevert) lines.push(result.configRevert);
  lines.push(`Readiness: ${result.readiness}`);
  return lines.join("\n");
}

// D7: action-oriented Markdown; no endpoint UUIDs (JSON keeps them).
// T-430: map a degraded/failed auto-attach outcome's bounded reason to a concrete recovery
// instruction. `race_lost` is benign (another session won) and is never surfaced.
function autoAttachInstruction(outcome: AutoAttachOutcome): string | null {
  switch (outcome.reason) {
    case "materialization_failed":
      return "auto-attach: inherited mail not yet surfaced; run `storybloq bus poll`";
    case "succession_chain_corrupt":
    case "registry_corrupt":
      return "auto-attach: run `storybloq bus doctor` to inspect a Bus data problem";
    case "endpoint_inactive":
      return "auto-attach: the endpoint was retired before its mail surfaced; run `storybloq bus doctor`";
    case "delivery_policy_failed":
      return "auto-attach: on-boundary delivery did not converge; re-run `storybloq bus auto-attach on`";
    case "tool_hook_failed":
      return "auto-attach: the on-tool hook did not install (Stop delivery still active); re-run `storybloq bus auto-attach on`";
    case "capacity_full":
      return "auto-attach: the Bus is full; `storybloq bus setup --replace <endpoint-id>` to take over a proven-dead peer";
    case "runtime_absent":
    case "runtime_incompatible":
      return "auto-attach: run `storybloq bus auto-attach on` to (re-)bootstrap the Bus";
    case "internal_failure":
      return "auto-attach failed; run `storybloq bus doctor`";
    case "race_lost":
      return null;
    default:
      return null;
  }
}

// Read-only: surface recent shortfall auto-attach attempts for `bus status`. NEVER mutates
// (no GC here -- that is a write path). Endpoint-bound records show only while their endpoint
// is still active; no-endpoint records (skipped_full / delivery-independent failed) show
// within a freshness window so capacity/setup guidance is not lost when there is no endpoint
// to hang it on. Fully defensive: any error yields no advisories.
const ADVISORY_KINDS = new Set(["degraded", "failed", "skipped_full"]);
async function collectAutoAttachAdvisories(root: string, nowMs: number): Promise<string[]> {
  try {
    let activeIds = new Set<string>();
    try {
      const { endpoints } = await listEndpoints(root);
      activeIds = new Set(endpoints.filter((endpoint) => !endpoint.retiredAt).map((endpoint) => endpoint.endpointId));
    } catch {
      // no runtime / corrupt registry: endpoint-bound records simply will not match.
    }
    const advisories: string[] = [];
    for (const { outcome } of await listAutoAttachOutcomes(root)) {
      if (!ADVISORY_KINDS.has(outcome.kind)) continue;
      const instruction = autoAttachInstruction(outcome);
      if (!instruction) continue;
      if (outcome.endpointId) {
        if (activeIds.has(outcome.endpointId)) advisories.push(instruction);
      } else {
        const ageMs = nowMs - Date.parse(outcome.at);
        if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= STATUS_FRESHNESS_MS) advisories.push(instruction);
      }
    }
    return advisories;
  } catch {
    return [];
  }
}

function renderStatusMarkdown(summary: BusSummary): string {
  if (summary.setupState === "disabled") {
    // T-428: surface the config-revert diagnostic (carried in nextActions) rather
    // than the generic disabled line when this checkout has evidence of an instance.
    const revert = summary.nextActions.find((action) => action.includes("config.features.bus"));
    return revert ? `Bus: disabled. ${revert}` : "Bus: not set up. Run `storybloq bus setup` to participate.";
  }
  if (summary.setupState === "not_initialized") {
    return "Bus: not set up. Run `storybloq bus setup` to participate.";
  }
  if (summary.setupState === "runtime_lost") {
    return "Bus: runtime lost; the `.story/bus/` runtime is absent or no longer matches this checkout's deletion-evidence. Run `storybloq bus setup` to re-establish it.";
  }
  if (summary.setupState === "invalid") {
    return "Bus: invalid; run `storybloq bus doctor`.";
  }
  const state = summary.setupState === "ready" ? "ready"
    : summary.setupState === "waiting_for_peer" ? "waiting for peer"
    : "disconnected";
  const connected = summary.participants.length > 0
    ? `${joinLabels(summary.participants.map((participant) => clientLabel(participant.surface)))} connected`
    : "no clients connected";
  return `Bus: ${state}; ${connected}; ${deliveryLabel(summary.deliveryCapabilities)}.`;
}

// ISS-871: canonical UUID shape for the pre-mutation --replace preflight (joinEndpoint
// under lock remains the authority; this only fails fast before any mutation).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface BusSetupArgs {
  readonly client?: StorybloqClient;
  readonly taskId?: string;
  readonly surface?: BusSurface;
  readonly delivery: "live" | "poll";
  readonly forceArchive: boolean;
  // ISS-871: endpoint id of a proven-offline incumbent to replace with this task's endpoint.
  readonly replace?: string;
}

// D5: exact per-message record of what a --force-archive upgrade archived. The
// structured fields are parsed from the v1 drain's unreadNoncritical line; the
// raw line is retained so a format change degrades to a precise fallback rather
// than a silent drop.
interface ArchivedUnreadEntry {
  readonly raw: string;
  readonly role?: string;
  readonly severity?: string;
  readonly messageId?: string;
  readonly threadId?: string;
}

function parseArchivedUnread(raw: string): ArchivedUnreadEntry {
  const match = /^(?<role>\S+) mailbox: unread (?<severity>\S+) message (?<messageId>.+?) in thread (?<threadId>\S+)$/.exec(raw);
  if (!match || !match.groups) return { raw };
  return {
    raw,
    role: match.groups.role,
    severity: match.groups.severity,
    messageId: match.groups.messageId,
    threadId: match.groups.threadId,
  };
}

function formatArchivedUnread(entry: ArchivedUnreadEntry): string {
  if (entry.messageId && entry.threadId) {
    const parts = [`message ${entry.messageId}`, `thread ${entry.threadId}`];
    if (entry.role) parts.push(`recipient ${entry.role}`);
    if (entry.severity) parts.push(`severity ${entry.severity}`);
    return parts.join(", ");
  }
  return entry.raw;
}

interface BusSetupResult {
  readonly setupState: BusSummary["setupState"];
  readonly deliveryMode: BusSummary["deliveryMode"];
  readonly deliveryCapabilities: BusSummary["deliveryCapabilities"];
  readonly endpoints: number;
  readonly endpointId: string;
  readonly surface: BusSurface;
  readonly migrated: boolean;
  readonly archivedUnread: ArchivedUnreadEntry[];
  readonly trackedChanges: string[];
  readonly completedSteps: string[];
  readonly remainingSteps: string[];
  readonly handoff: string | null;
  readonly nextActions: string[];
  // ISS-871/ISS-872: succession outcome. `replaced` is derived from the returned
  // endpoint's predecessor link, so an idempotent same-task rerun still reports it;
  // `newlyReplaced` is true only when THIS invocation performed the retire+create.
  // `materialized` reflects solely whether eager materialization completed.
  // `undeliveredMessages` counts canonically-deliverable inherited mail from the
  // SUCCESSOR's mailbox and is meaningful only after a successful materialization. It is
  // `null` (unknown) in EITHER of two cases: (a) materialization did not complete, so the
  // inherited mail still sits on the predecessor and a zero would falsely read as "no mail";
  // or (b) the post-mutation count read failed AFTER a successful materialization, so the
  // mail IS surfaced and only the count is unknown.
  readonly replaced: { readonly endpointId: string; readonly undeliveredMessages: number | null; readonly materialized: boolean } | null;
  readonly newlyReplaced: boolean;
}

async function enableHooksForClient(root: string, client: BusClient): Promise<void> {
  const setup = await import("./setup-skill.js");
  // GLOBAL client-hook install (mutates ~/.claude / ~/.codex). Bootstrap-only: the
  // SessionStart auto-attach child never runs this, only convergeProjectDelivery.
  if (client === "claude") {
    const migrated = await setup.enableClaudeBusHooks();
    if (migrated.skipped) {
      throw new BusError("io_error", "Claude hooks could not be upgraded. Run `storybloq setup --client claude` first.");
    }
  } else {
    const refreshed = await setup.refreshExistingCodexHooks();
    const counts = await setup.countCodexStorybloqHooks();
    if (refreshed.skipped || counts.PreCompact === 0 || counts.SessionStart === 0 || counts.Stop === 0) {
      throw new BusError("io_error", "Codex hooks are incomplete. Run `storybloq setup --client codex`, review `/hooks`, then retry.");
    }
  }
  // PROJECT-LOCAL delivery convergence (Stop policy + Claude-only on-tool hook), shared with
  // the auto-attach child. Preserve setup's existing semantics: re-raise on Stop-policy
  // failure; keep the on-tool hook best-effort (warn to stderr, T-427).
  const { convergeProjectDelivery } = await import("../../bus/delivery.js");
  const converged = await convergeProjectDelivery(root, client);
  if (!converged.policy.ok) {
    throw new BusError("io_error", converged.policy.error ?? "Failed to set Bus hook delivery policy");
  }
  if (converged.toolHook.applicable && !converged.toolHook.ok) {
    process.stderr.write(`Storybloq Bus on-tool hook not installed: ${converged.toolHook.error}\n`);
  }
}

// The disabled policy fields stay at the TOP level (matching the enable path's response
// shape, so `data.claude`/`data.codex` structured consumers do not break); the optional
// removal warning is added additively. Non-null `removalWarning` means the policy was
// disabled (delivery IS off / the hook is inert) but the best-effort on-tool hook FILE
// could not be removed, so the caller surfaces a remaining cleanup step.
type DisableHooksResult = BusHookPolicy & { readonly removalWarning: string | null };

// T-427: turning delivery OFF for a client clears its hook policy AND removes the
// project-local on-tool hook (Claude only). Used by `bus hooks disable` and
// `bus setup --delivery poll`. Policy is disabled FIRST: the policy is what gates the
// hook handler (isBusHookDeliveryEnabled) and the on-tool capability label
// (endpointToolActive), so once it is false a residual hook is inert. If the best-effort
// on-tool removal then fails, the leftover file is harmless (policy-gated inert), but it
// is returned as a `removalWarning` so callers can report a resumable cleanup step rather
// than claiming the disable fully completed. The removal matches by subcommand, so it
// clears a hook even after a Node switch changed the bin.
async function disableHooksForClient(root: string, clients: readonly BusClient[]): Promise<DisableHooksResult> {
  const policy = await setBusHookPolicy(root, clients, false);
  let removalWarning: string | null = null;
  if (clients.includes("claude")) {
    try {
      const { removeProjectBusToolHook } = await import("../../core/project-settings.js");
      await removeProjectBusToolHook(root);
    } catch (err) {
      removalWarning = `on-tool hook file not removed (policy is disabled, so it is inert): ${err instanceof Error ? err.message : String(err)}. Remove .claude/settings.local.json's storybloq hook-bus-tool entry manually if desired.`;
      process.stderr.write(`Storybloq Bus ${removalWarning}\n`);
    }
  }
  return { ...policy, removalWarning };
}

// D4 preflight: evaluate the D5 drain gate read-only over a v1 runtime so a
// blocked upgrade never flips features.bus or writes runtime state before it
// fails. Mirrors the authoritative gate in initializeBus (which re-checks under
// locks); this pass is advisory and performs no persistent mutation.
async function preflightV1Drain(root: string, callerTaskId: string, forceArchive: boolean): Promise<void> {
  const paths = await resolveBusPaths(root, false);
  const v1 = v1PathsFrom(paths.busRoot);
  const { endpoints, findings } = await listV1Endpoints(v1);
  if (findings.length > 0) {
    throw new BusError(
      "corrupt",
      `The v1 Bus runtime has corrupt endpoint records that must be resolved before upgrade:\n${findings.map((finding) => `- ${finding}`).join("\n")}`,
    );
  }
  for (const endpoint of endpoints) {
    if (endpoint.retiredAt) continue;
    if (endpoint.clientTaskId === callerTaskId) continue;
    const liveness = await v1EndpointLiveness(endpoint);
    if (liveness !== "offline") {
      throw new BusError(
        "conflict",
        `Cannot upgrade: endpoint ${endpoint.endpointId} is ${liveness}. Every peer must be positively offline before upgrade.`,
      );
    }
  }
  const drain = await evaluateV1Drain(v1);
  if (drain.shipBlockers.length > 0) {
    throw new BusError(
      "conflict",
      `Cannot upgrade: the v1 ship gate is blocked and requires canonical resolution first:\n${drain.shipBlockers.map((blocker) => `- ${blocker}`).join("\n")}`,
    );
  }
  if (drain.unreadNoncritical.length > 0 && !forceArchive) {
    throw new BusError(
      "conflict",
      `Cannot upgrade: unread noncritical Bus mail remains. Ack it, or pass --force-archive to archive it read-only:\n${drain.unreadNoncritical.map((entry) => `- ${entry}`).join("\n")}`,
    );
  }
  // Zero-mutation early-refusal gate only; the exact force-archived mail is
  // reported from initializeBus's commit-time result, not from this pre-lock
  // snapshot (a concurrent ack or migrator could change it between reads).
}

// D4 preflight: verify live delivery can enable this client's hooks without
// mutating anything. Both clients need their base hooks already installed: Codex
// trust is user-controlled via /hooks, and Claude Bus enablement only UPGRADES
// existing SessionStart/Stop hooks (it does not create missing base hooks during
// Bus setup), so both branches require the binary to resolve AND the base hooks to
// be present. Fails before any runtime/hook-policy write.
async function preflightLiveHooks(client: BusClient): Promise<void> {
  const setup = await import("./setup-skill.js");
  const bin = setup.resolveStorybloqBin();
  if (!bin) {
    throw new BusError(
      "io_error",
      `Storybloq binary could not be resolved. Run \`storybloq setup --client ${client}\` first.`,
    );
  }
  if (client === "codex") {
    const counts = await setup.countCodexStorybloqHooks();
    if (counts.PreCompact === 0 || counts.SessionStart === 0 || counts.Stop === 0) {
      throw new BusError(
        "io_error",
        "Codex base hooks are incomplete. Run `storybloq setup --client codex`, review `/hooks`, then retry (or rerun with `--delivery poll`).",
      );
    }
  }
  if (client === "claude") {
    // enableClaudeBusHooks only upgrades hooks that already exist; if the base
    // SessionStart/Stop hooks are absent or the settings file is malformed it
    // would skip and fail AFTER Bus state has mutated. Gate it read-only here.
    const base = await setup.claudeBaseHooksPresent();
    if (!base.ok) {
      throw new BusError(
        "io_error",
        `Claude base hooks are not ready${base.reason ? ` (${base.reason})` : ""}. Run \`storybloq setup --client claude\` first, then retry (or rerun with \`--delivery poll\`).`,
      );
    }
  }
}

// Reads whether features.bus is already enabled, so setup only reports
// .story/config.json as changed when it actually flips (FIX: no-op rerun).
async function busFeatureEnabledBefore(root: string): Promise<boolean> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  try {
    const raw = await readFile(join(root, ".story", "config.json"), "utf-8");
    const config = JSON.parse(raw) as { features?: { bus?: unknown } };
    return config.features?.bus === true;
  } catch {
    return false;
  }
}

// Reads whether both Bus gitignore entries already exist, so setup only reports
// .story/.gitignore as changed when it actually adds one.
async function busGitignoreCompleteBefore(root: string): Promise<boolean> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  try {
    const raw = await readFile(join(root, ".story", ".gitignore"), "utf-8");
    const lines = new Set(raw.split("\n").map((line) => line.trim()));
    return lines.has("bus/") && lines.has("bus-migration/") && lines.has(BUS_EVIDENCE_GITIGNORE_ENTRY);
  } catch {
    return false;
  }
}

// D4: guided setup. Idempotent and resumable; every step is individually
// idempotent, and rerunning converges from any partial state.
// T-430: persist the per-project auto-attach opt-in flag under a project lock (structural
// merge-safe, matching how team-setup mutates config.bus/config.team).
async function setBusAutoAttachFlag(root: string, enabled: boolean): Promise<void> {
  const { withProjectLock, writeConfigUnlocked } = await import("../../core/project-loader.js");
  await withProjectLock(root, { strict: false }, async ({ state }) => {
    const config = { ...state.config, bus: { ...(state.config.bus ?? {}), autoAttach: enabled } };
    await writeConfigUnlocked(config, root);
  });
}

// T-430: auto-attach may be armed ONLY when `bus auto-attach on`'s bootstrap produced a
// genuinely USABLE runtime AND installed the global delivery hooks (the "enable-hooks" step
// completed). Usable is an ALLOWLIST -- only `ready` or `waiting_for_peer` -- not "anything but
// invalid": disabled / not_initialized / runtime_lost (e.g. the runtime deleted between hook
// install and the final summary) are all unusable even if enable-hooks was recorded. The child
// never installs the global hooks, so without them every future session would attach with no
// Stop-delivery trigger.
function autoAttachEnableSucceeded(result: BusSetupResult): boolean {
  const usable = result.setupState === "ready" || result.setupState === "waiting_for_peer";
  return usable && result.completedSteps.includes("enable-hooks");
}

// User-facing guidance for a failed `bus auto-attach on`, distinguishing the two failure modes
// so the user is sent to the RIGHT repair: an unusable final runtime state points at
// runtime repair; a usable state that simply never completed enable-hooks points at hook install.
function autoAttachEnableFailureAdvice(result: BusSetupResult): string {
  const usable = result.setupState === "ready" || result.setupState === "waiting_for_peer";
  if (!usable) {
    return `Auto-attach NOT enabled: setup ended in \`${result.setupState}\`. Run \`storybloq bus setup\` (or \`storybloq bus doctor\`) to repair the runtime, then rerun \`storybloq bus auto-attach on\`.`;
  }
  return "Auto-attach NOT enabled: global delivery hooks did not install. Run `storybloq setup --client all`, then rerun `storybloq bus auto-attach on`.";
}

// T-430: the `bus auto-attach on` enable orchestration, extracted so it is unit-testable with an
// injected setup function (the real path installs GLOBAL client hooks, which tests must not
// touch). FAIL-CLOSED: revoke any prior arming BEFORE running setup so a setup THROW (e.g. the
// preflight detecting missing global hooks) or a failed final enable write cannot leave a
// previously-true flag armed; re-arm ONLY on a proven-usable result.
export async function enableBusAutoAttach(
  root: string,
  args: BusSetupArgs,
  setup: (root: string, args: BusSetupArgs) => Promise<BusSetupResult> = runBusSetup,
): Promise<BusSetupResult> {
  await setBusAutoAttachFlag(root, false);
  await clearAutoAttachOutcomes(root);
  const setupResult = await setup(root, args);
  if (autoAttachEnableSucceeded(setupResult)) {
    await setBusAutoAttachFlag(root, true);
  }
  return setupResult;
}

async function runBusSetup(root: string, args: BusSetupArgs): Promise<BusSetupResult> {
  const completedSteps: string[] = [];
  const remainingSteps: string[] = [];
  const trackedChanges: string[] = [];

  // 1. Full preflight, zero persistent mutation. Identity, surface match, the
  // v1 drain gate, and live-delivery hook readiness are all validated here so
  // ANY failure exits before any config/runtime/hook-policy/ledger change.
  const client = resolveClient(args.client);
  const taskId = resolveTaskId(client, args.taskId);
  // An explicit surface inherently incompatible with the client is invalid_input
  // regardless of process ancestry; check it BEFORE the ancestry-mismatch conflict so
  // the preflight fails closed deterministically (mirrors joinEndpoint's ordering).
  if (args.surface && ((client === "claude" && args.surface !== "claude_cli") ||
      (client === "codex" && args.surface === "claude_cli"))) {
    throw new BusError("invalid_input", `Surface ${args.surface} is not valid for the ${client} client`);
  }
  const detectedSurface = await detectClientSurface(client).catch(() => null);
  if (args.surface && detectedSurface && args.surface !== detectedSurface) {
    throw new BusError("conflict", `Requested ${args.surface} does not match the detected ${detectedSurface} client process`);
  }
  const surface = args.surface ?? detectedSurface ?? undefined;
  // A surface that neither --surface nor ancestry detection could resolve (a Codex
  // session whose process was not found) must fail the preflight HERE: joinEndpoint
  // rejects an undetermined surface, and letting it fall through would mutate
  // features.bus, .story/.gitignore, and the runtime before that rejection,
  // violating the zero-mutation preflight contract.
  if (!surface) {
    throw new BusError("invalid_input", "Cannot determine the client surface safely; pass --surface explicitly");
  }

  const runtimeKind = await classifyBusRuntime(root);
  if (runtimeKind === "v1") {
    await preflightV1Drain(root, taskId, args.forceArchive);
  }
  if (args.delivery === "live") {
    await preflightLiveHooks(client);
  }
  // ISS-871: `--replace` targets an existing v2 incumbent. On any non-v2 runtime
  // (fresh checkout, or a v1 runtime being upgraded) there is nothing to replace, so
  // fail HERE, before initializeBus, to keep the zero-mutation contract intact.
  if (args.replace && runtimeKind !== "v2") {
    throw new BusError(
      "not_found",
      "Cannot --replace: this checkout has no active v2 Bus endpoint to replace. Run `storybloq bus setup` without --replace to connect.",
    );
  }
  // v2 capacity/joinability preflight. initializeBus mutates features.bus,
  // .story/.gitignore, and the runtime BEFORE joinEndpoint runs, so a capacity
  // rejection there would leave those mutated in violation of the zero-mutation
  // preflight contract. Replicate joinEndpoint's registry + two-endpoint rule here
  // so a full runtime with no endpoint owned by this task fails BEFORE any mutation.
  // A same-task rejoin is still allowed (joinEndpoint returns the existing endpoint).
  if (runtimeKind === "v2") {
    const listed = await listEndpoints(root);
    if (listed.findings.length > 0) {
      throw new BusError("corrupt", `Endpoint registry is corrupt: ${listed.findings[0]}`);
    }
    const sameTask = listed.endpoints.find((endpoint) =>
      !endpoint.retiredAt && endpoint.client === client && endpoint.clientTaskId === taskId,
    );
    // ISS-871: validate --replace in joinEndpoint's exact order (uuid -> active
    // incumbent -> proven offline). UX-only: joinEndpoint under lock stays the
    // authority. Skip ALL replace validation when a same-task endpoint already
    // exists -- a rerun after a fully-successful replace hits joinEndpoint's same-task
    // early return (which ignores --replace), so the rerun stays idempotent.
    if (args.replace && !sameTask) {
      if (!UUID_PATTERN.test(args.replace)) {
        throw new BusError("invalid_input", "Invalid endpoint id for --replace");
      }
      const incumbent = listed.endpoints.find(
        (endpoint) => !endpoint.retiredAt && endpoint.endpointId === args.replace,
      );
      if (!incumbent) {
        throw new BusError(
          "not_found",
          "No active endpoint matches the --replace id. If it was already replaced, rerun `storybloq bus setup` without --replace.",
        );
      }
      const liveness = await endpointLiveness(incumbent);
      if (liveness !== "offline") {
        throw new BusError(
          "conflict",
          `Endpoint ${incumbent.endpointId} is ${liveness}. Replacement requires positive offline proof.`,
        );
      }
    }
    const active = listed.endpoints.filter((endpoint) => !endpoint.retiredAt);
    // The replace target is about to be retired, so it never counts toward capacity.
    const activeAfterReplace = active.filter((endpoint) => endpoint.endpointId !== args.replace);
    if (!sameTask && activeAfterReplace.length >= 2) {
      throw new BusError(
        "conflict",
        "The Bus already has two active endpoints. Run `storybloq bus setup --replace <endpoint-id>` with a proven-offline incumbent to take its place.",
      );
    }
  }

  // 2. Initialize or upgrade (idempotent; drains + archives a v1 runtime).
  const configWasEnabled = await busFeatureEnabledBefore(root);
  const gitignoreWasComplete = await busGitignoreCompleteBefore(root);
  const init = await initializeBus(root, { callerTaskId: taskId, forceArchive: args.forceArchive });
  completedSteps.push("initialize");
  if (!configWasEnabled) trackedChanges.push(".story/config.json");
  if (!gitignoreWasComplete) trackedChanges.push(".story/.gitignore");

  // Report the exact mail this invocation force-archived, sourced from the
  // commit-time InitializeBusResult rather than a pre-lock preflight snapshot.
  // initializeBus captures this list under the migration and v1 operation locks,
  // so it reflects what was actually archived (empty unless this call both
  // migrated a v1 runtime and force-archived unread mail).
  const archivedUnread = init.archivedUnread.map(parseArchivedUnread);

  // Join this task's endpoint or refresh the existing one. Always route through
  // joinEndpoint first: its relaxed join resolver HEALS a missing
  // mailboxes/<id>/pending directory (a crash state the strict session-start
  // refresh path rejects with `corrupt`), and a same-task rejoin returns the
  // existing endpoint. Setup is the primary resumable recovery command, so it
  // must be able to repair that layout. Refresh the session-start fields
  // afterward only when the endpoint already existed.
  const joined = await joinEndpoint(root, { client, clientTaskId: taskId, surface, replace: args.replace });
  let endpoint: BusEndpoint;
  if (joined.existing) {
    endpoint = await refreshEndpointForSessionStart(root, joined.endpoint.endpointId, taskId);
    completedSteps.push("refresh-endpoint");
  } else {
    endpoint = joined.endpoint;
    completedSteps.push("join-endpoint");
  }

  // ISS-871/ISS-872: succession outcome + eager materialization. `replaced` is derived
  // from the returned endpoint's predecessor link (so an idempotent same-task rerun still
  // reports it); `newlyReplaced` is true only when THIS call performed the retire+create.
  let replaced: BusSetupResult["replaced"] = null;
  let newlyReplaced = false;
  if (args.replace && joined.endpoint.predecessorEndpointId === args.replace) {
    newlyReplaced = !joined.existing;
    if (newlyReplaced) completedSteps.push("replace-endpoint");
    // Surface the inherited mail into the successor's PHYSICAL mailbox now, so the live
    // hooks fire without an explicit poll. ALWAYS run, regardless of any count: a peer can
    // send to the still-active incumbent between the preflight and joinEndpoint's retire,
    // so a stale pre-mutation zero must never be authority to skip delivery work (an
    // arrived-during-replacement message would otherwise sit only in the retired mailbox,
    // invisible to the successor's live hooks until an explicit poll). Materialization is a
    // no-op when there is genuinely nothing to inherit. Best-effort: on a thrown I/O failure
    // setup still succeeds and a degraded step tells the user to poll (the next poll
    // materializes idempotently, so mail is deferred, never lost). A NON-thrown
    // succession-chain finding is surfaced as a doctor step; an `endpoint_inactive` result
    // (a concurrent retire/replace) is NOT reported as a completed materialization.
    let materialized = false;
    try {
      const result = await materializeSuccessorMailbox(root, joined.endpoint);
      const chainFinding = result.findings.find((finding) => finding.includes("succession chain"));
      if (chainFinding) {
        remainingSteps.push(`run \`storybloq bus doctor\` to inspect a succession-chain problem blocking inherited mail (${chainFinding})`);
      } else if (result.status === "endpoint_inactive") {
        remainingSteps.push("run `storybloq bus doctor`: the endpoint was retired or replaced before its inherited mail could be surfaced");
      } else {
        completedSteps.push("materialize-succession");
        materialized = true;
      }
    } catch (err) {
      remainingSteps.push(`run \`storybloq bus poll\` to surface the previous endpoint's undelivered mail (materialization deferred: ${err instanceof Error ? err.message : String(err)})`);
    }
    // Count ONLY once materialization completed, reading the SUCCESSOR's mailbox: the sweep
    // moved the inherited pointers off the retired predecessor and onto the successor, and
    // the count is chain-aware, so this reflects any mail that arrived at the still-active
    // incumbent during the replacement window rather than a pre-mutation snapshot. When
    // materialization did NOT complete, the inherited mail still sits on the predecessor, so
    // counting the empty successor would misreport zero -- leave the count unknown (null) and
    // let the "not yet surfaced" wording drive the user to the remaining step. joinEndpoint
    // has already mutated irreversibly, so a transient count-read error must NEVER throw
    // here (that would abort setup as a plain error and drop the resumable report); catch it,
    // leave the count unknown, and add a doctor step.
    let undeliveredMessages: number | null = null;
    if (materialized) {
      try {
        undeliveredMessages = await countUndeliveredMessages(root, joined.endpoint.endpointId);
      } catch (err) {
        remainingSteps.push(`run \`storybloq bus doctor\` to confirm the inherited mail count (count read failed: ${err instanceof Error ? err.message : String(err)})`);
      }
    }
    replaced = { endpointId: args.replace, undeliveredMessages, materialized };
  }

  // Enable hooks for THIS client when live; when poll, actively turn delivery OFF
  // (clear the hook policy and remove the project-local on-tool hook) so switching a
  // project to poll converges from any prior live state.
  if (args.delivery === "live") {
    try {
      await enableHooksForClient(root, client);
      completedSteps.push("enable-hooks");
    } catch (err) {
      remainingSteps.push(`enable-hooks: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    try {
      const disabled = await disableHooksForClient(root, [client]);
      completedSteps.push("poll-delivery (hooks disabled)");
      // The policy is disabled (delivery IS off), but if the inert on-tool hook FILE
      // could not be removed, surface it as a remaining cleanup step instead of implying
      // a fully clean poll conversion.
      if (disabled.removalWarning) remainingSteps.push(`remove-on-tool-hook: ${disabled.removalWarning}`);
    } catch (err) {
      remainingSteps.push(`disable-hooks: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const summary = await busSummary(root);
  const handoff = summary.setupState === "waiting_for_peer"
    ? 'Bus is waiting for its peer. In the other task, say "Connect this task to Storybloq Bus."'
    : null;
  return {
    setupState: summary.setupState,
    deliveryMode: summary.deliveryMode,
    deliveryCapabilities: summary.deliveryCapabilities,
    endpoints: summary.endpoints,
    endpointId: endpoint.endpointId,
    surface: endpoint.surface,
    migrated: init.migrated,
    archivedUnread,
    trackedChanges: [...new Set(trackedChanges)],
    completedSteps,
    remainingSteps,
    handoff,
    nextActions: [...summary.nextActions],
    replaced,
    newlyReplaced,
  };
}

function renderSetupMarkdown(result: BusSetupResult): string {
  const lines = [
    `Setup: ${result.setupState}; ${deliveryLabel(result.deliveryCapabilities)}.`,
  ];
  if (result.migrated) {
    lines.push("Upgraded and archived the previous v1 runtime.");
    if (result.archivedUnread.length > 0) {
      lines.push(`Force-archived ${result.archivedUnread.length} unread noncritical message(s):`);
      for (const entry of result.archivedUnread) {
        lines.push(`- ${formatArchivedUnread(entry)}`);
      }
    }
  }
  if (result.replaced) {
    const verb = result.newlyReplaced ? "Replaced" : "Already replaced";
    const mail = result.replaced.undeliveredMessages;
    // Order matters: only claim "no deliverable mail" after a SUCCESSFUL materialization
    // (mail === 0 with the mail actually surfaced). When materialization did not complete
    // the successor is empty/partial, so the "not yet surfaced" wording must win over a
    // misleading zero. A null count after a successful materialization means the follow-up
    // count read failed -- surface a doctor step, never a false zero.
    const tail = !result.replaced.materialized
      ? "Inherited mail is not yet surfaced; complete the remaining step(s) below."
      : mail === 0
        ? "It had no deliverable mail."
        : mail === null
          ? "Its inherited mail is surfaced; run `storybloq bus doctor` to confirm the count."
          : `${mail} undelivered message(s) from it will surface on your next poll.`;
    lines.push(`${verb} proven-offline endpoint ${result.replaced.endpointId}. ${tail}`);
  }
  if (result.trackedChanges.length > 0) {
    lines.push(`Tracked changes: ${result.trackedChanges.join(", ")}. Review and commit them; setup never auto-commits.`);
  }
  if (result.remainingSteps.length > 0) {
    lines.push(`Remaining steps:\n${result.remainingSteps.map((step) => `- ${step}`).join("\n")}`);
    lines.push("Rerun `storybloq bus setup` to resume.");
  }
  if (result.handoff) lines.push(result.handoff);
  return lines.join("\n");
}

export function registerBusCommand(yargs: Argv): Argv {
  return yargs.command(
    "bus",
    "Local agent-to-agent coordination",
    (y) => y
      .command(
        "init",
        "Enable the Storybloq Bus for this project",
        (y2) => formatOption(y2),
        async (argv) => {
          const format = formatValue(argv.format);
          await runBus(format, async (root) => {
            // bus init is the low-level v2 initializer only. A v1 upgrade needs the
            // caller's identity to exempt its own endpoint from the drain offline
            // proof and runs a guided preflight/join, which is `bus setup`'s job; a
            // second identity-less migration path here would block on the caller's
            // own active endpoint. Refuse and redirect (mirrors the send/join freeze).
            if (await classifyBusRuntime(root) === "v1") {
              throw new BusError("upgrade_required", "This checkout has a v1 Bus runtime. Run `storybloq bus setup` to drain and upgrade it.");
            }
            return initializeBus(root);
          }, (result) => `Storybloq Bus is enabled. Instance: ${result.instanceId}.`);
        },
      )
      .command(
        "setup",
        "Connect this task to the Storybloq Bus (idempotent, resumable)",
        (y2) => formatOption(y2
          .option("client", { type: "string", choices: ["claude", "codex"] as const })
          .option("task-id", { type: "string", describe: "Validated client task id" })
          .option("surface", {
            type: "string",
            choices: ["claude_cli", "codex_cli", "codex_desktop"] as const,
            describe: "Client surface when process ancestry cannot determine it",
          })
          .option("delivery", { type: "string", choices: ["live", "poll"] as const, default: "live" })
          .option("replace", {
            type: "string",
            describe: "Endpoint id of a proven-offline incumbent to replace with this task's endpoint",
          })
          .option("force-archive", {
            type: "boolean",
            default: false,
            describe: "Archive unread noncritical v1 mail read-only during upgrade (never bypasses ship-gate blockers)",
          })),
        async (argv) => {
          const format = formatValue(argv.format);
          await runBus(format, (root) => runBusSetup(root, {
            client: argv.client as StorybloqClient | undefined,
            taskId: argv["task-id"] as string | undefined,
            surface: argv.surface as BusSurface | undefined,
            delivery: (argv.delivery as "live" | "poll" | undefined) ?? "live",
            replace: argv.replace as string | undefined,
            forceArchive: argv["force-archive"] === true,
          }), renderSetupMarkdown, (result) => result.setupState === "invalid");
        },
      )
      .command(
        "auto-attach <state>",
        "Turn per-session Bus auto-attach on or off for this project",
        (y2) => formatOption(y2
          .positional("state", { type: "string", choices: ["on", "off"] as const, demandOption: true })
          .option("client", { type: "string", choices: ["claude", "codex"] as const })
          .option("task-id", { type: "string", describe: "Validated client task id" })
          .option("surface", {
            type: "string",
            choices: ["claude_cli", "codex_cli", "codex_desktop"] as const,
            describe: "Client surface when process ancestry cannot determine it",
          })
          .option("force-archive", {
            type: "boolean",
            default: false,
            describe: "Archive unread noncritical v1 mail read-only during upgrade (never bypasses ship-gate blockers)",
          })),
        async (argv) => {
          const format = formatValue(argv.format);
          const enable = argv.state === "on";
          if (enable) {
            // `on` runs the full, proven bus setup (bootstrap + this session's endpoint +
            // GLOBAL client hooks) then persists the opt-in flag, so a single command makes
            // every future session auto-attach.
            await runBus(format, (root) => enableBusAutoAttach(root, {
              client: argv.client as StorybloqClient | undefined,
              taskId: argv["task-id"] as string | undefined,
              surface: argv.surface as BusSurface | undefined,
              delivery: "live",
              replace: undefined,
              forceArchive: argv["force-archive"] === true,
            }),
            (result) => autoAttachEnableSucceeded(result)
              ? `Auto-attach is ON. ${renderSetupMarkdown(result)}`
              : `${autoAttachEnableFailureAdvice(result)} ${renderSetupMarkdown(result)}`,
            (result) => !autoAttachEnableSucceeded(result));
          } else {
            // `off` clears the flag and sweeps this project's now-moot outcome records; it
            // leaves the runtime and this task's endpoint in place.
            await runBus(format, async (root) => {
              await setBusAutoAttachFlag(root, false);
              await clearAutoAttachOutcomes(root);
              return { autoAttach: false as const };
            }, () => "Auto-attach is OFF. Existing endpoints remain; new sessions will not auto-attach.");
          }
        },
      )
      .command(
        // Internal, hidden: the detached child spawned by the SessionStart / retry hooks.
        // Always exits 0 (best-effort); never prints to stdout (stdio is ignored by the parent).
        "__session-attach",
        false,
        (y2) => y2
          .option("client", { type: "string", choices: ["claude", "codex"] as const, demandOption: true })
          .option("task-id", { type: "string", demandOption: true })
          .option("surface", {
            type: "string",
            choices: ["claude_cli", "codex_cli", "codex_desktop"] as const,
            demandOption: true,
          })
          .option("root", { type: "string", demandOption: true }),
        async (argv) => {
          try {
            await attemptAutoAttach({
              root: argv.root as string,
              client: argv.client as BusClient,
              clientTaskId: argv["task-id"] as string,
              surface: argv.surface as BusSurface,
            });
          } catch {
            // Best-effort child: swallow everything and exit 0 so a failure never surfaces.
          }
        },
      )
      .command(
        "join [legacy-role]",
        "Deprecated: connect this task to the Bus (use `storybloq bus setup`)",
        (y2) => formatOption(y2
          .positional("legacy-role", { type: "string", choices: ["implementer", "reviewer"] as const })
          .option("client", { type: "string", choices: ["claude", "codex"] as const })
          .option("task-id", { type: "string", describe: "Validated client task id" })
          .option("surface", {
            type: "string",
            choices: ["claude_cli", "codex_cli", "codex_desktop"] as const,
            describe: "Client surface when process ancestry cannot determine it",
          })
          .option("replace", { type: "string", describe: "Endpoint id of a proven-offline incumbent to replace" })),
        async (argv) => {
          const format = formatValue(argv.format);
          const legacyRole = argv["legacy-role"] as string | undefined;
          const deprecation = legacyRole
            ? `Roles are now per-message; the '${legacyRole}' argument is ignored. Use \`storybloq bus setup\`.`
            : "The `join` subcommand is deprecated; use `storybloq bus setup`.";
          await runBus(format, async (root) => {
            const client = resolveClient(argv.client as StorybloqClient | undefined);
            const joined = await joinEndpoint(root, {
              client,
              clientTaskId: resolveTaskId(client, argv["task-id"] as string | undefined),
              surface: argv.surface as BusSurface | undefined,
              replace: argv.replace as string | undefined,
            });
            // ISS-872: eager materialization so a replace via the deprecated path still
            // surfaces the incumbent's inherited mail to the live hooks. Best-effort, but
            // never silent: a thrown failure or a succession-chain finding is reported so
            // the user knows to run `storybloq bus poll` / `bus doctor`.
            let materializeNote: string | null = null;
            if (joined.endpoint.predecessorEndpointId) {
              try {
                const materialized = await materializeSuccessorMailbox(root, joined.endpoint);
                const chainFinding = materialized.findings.find((finding) => finding.includes("succession chain"));
                if (chainFinding) materializeNote = `Inherited mail is blocked by a succession-chain problem (${chainFinding}); run \`storybloq bus doctor\`.`;
                else if (materialized.status === "endpoint_inactive") materializeNote = "The endpoint was retired or replaced before its inherited mail could be surfaced; run `storybloq bus doctor`.";
              } catch (err) {
                materializeNote = `Inherited mail was not surfaced eagerly (${err instanceof Error ? err.message : String(err)}); run \`storybloq bus poll\`.`;
              }
            }
            return { ...joined, deprecation, materializeNote };
          }, ({ endpoint, existing, materializeNote }) =>
            `${deprecation}\n${existing ? "Using" : "Joined"} endpoint ${endpoint.endpointId} (${endpoint.surface}).${materializeNote ? `\n${materializeNote}` : ""}`);
        },
      )
      .command(
        "leave",
        "Retire the endpoint owned by this task",
        (y2) => formatOption(identityOptions(y2)),
        async (argv) => {
          const format = formatValue(argv.format);
          await runBus(format, async (root) => {
            const owned = await resolveOwnedEndpoint(root, identityFrom(argv as Record<string, unknown>));
            return leaveEndpoint(root, owned.endpointId, owned.taskId);
          }, (endpoint) => `Left endpoint ${endpoint.endpointId}.`);
        },
      )
      .command(
        "endpoint",
        "Endpoint administration",
        (y2) => y2.command(
          "retire <endpoint-id>",
          "Force-retire an irrecoverably unknown endpoint",
          (y3) => formatOption(y3
            .positional("endpoint-id", { type: "string", demandOption: true })
            .option("force", { type: "boolean", default: false, demandOption: true })
            .option("reason", { type: "string", demandOption: true })),
          async (argv) => {
            const format = formatValue(argv.format);
            if (argv.force !== true) {
              writeOutput(formatFailure(new BusError("invalid_input", "Endpoint retirement requires --force."), format));
              process.exitCode = ExitCode.USER_ERROR;
              return;
            }
            await runBus(format, (root) => retireEndpoint(
              root,
              argv["endpoint-id"] as string,
              argv.reason as string,
            ), (endpoint) => `Retired endpoint ${endpoint.endpointId}: ${endpoint.retiredReason}`);
          },
        ).demandCommand(1, "Specify: retire"),
        () => {},
      )
      .command(
        "hooks",
        "Enable or disable guarded on-boundary Bus delivery",
        (y2) => y2
          .command(
            "enable",
            "Opt this project into guarded SessionStart and Stop delivery",
            (y3) => formatOption(y3.option("client", {
              type: "string",
              choices: ["claude", "codex", "all"] as const,
              default: currentStorybloqClient(),
            })),
            async (argv) => {
              const format = formatValue(argv.format);
              await runBus(format, async (root) => {
                const selected = argv.client as "claude" | "codex" | "all";
                const clients: BusClient[] = selected === "all" ? ["claude", "codex"] : [selected];
                const setup = await import("./setup-skill.js");
                if (clients.includes("claude")) {
                  const migrated = await setup.enableClaudeBusHooks();
                  if (migrated.skipped) {
                    throw new BusError("io_error", "Claude hooks could not be upgraded. Run `storybloq setup --client claude` first.");
                  }
                }
                if (clients.includes("codex")) {
                  const refreshed = await setup.refreshExistingCodexHooks();
                  const counts = await setup.countCodexStorybloqHooks();
                  if (refreshed.skipped || counts.PreCompact === 0 || counts.SessionStart === 0 || counts.Stop === 0) {
                    throw new BusError("io_error", "Codex hooks are incomplete. Run `storybloq setup --client codex`, review `/hooks`, then retry.");
                  }
                }
                return setBusHookPolicy(root, clients, true);
              }, (policy) => `Bus hook delivery enabled. Claude: ${policy.claude ? "on" : "off"}; Codex: ${policy.codex ? "on" : "off"}.`);
            },
          )
          .command(
            "disable",
            "Disable guarded Bus hook delivery for this project",
            (y3) => formatOption(y3.option("client", {
              type: "string",
              choices: ["claude", "codex", "all"] as const,
              default: currentStorybloqClient(),
            })),
            async (argv) => {
              const format = formatValue(argv.format);
              await runBus(format, (root) => {
                const selected = argv.client as "claude" | "codex" | "all";
                const clients: BusClient[] = selected === "all" ? ["claude", "codex"] : [selected];
                return disableHooksForClient(root, clients);
              }, (result) => `Bus hook delivery disabled. Claude: ${result.claude ? "on" : "off"}; Codex: ${result.codex ? "on" : "off"}.${result.removalWarning ? ` Remaining: ${result.removalWarning}` : ""}`);
            },
          )
          .demandCommand(1, "Specify: enable or disable"),
        () => {},
      )
      .command(
        "send",
        "Send a Bus message or reply",
        (y2) => formatOption(arrayOptions(identityOptions(y2)
          .option("thread", { type: "string", describe: "Existing thread id for a reply" })
          .option("thread-kind", { type: "string", choices: ["issue_notice", "question", "coordination", "patch_request"] as const })
          .option("predecessor-thread", { type: "string", describe: "Resolved predecessor thread id" })
          .option("to", { type: "string", choices: ["implementer", "reviewer"] as const, describe: "Deprecated and ignored: routing is always to the sole peer" })
          .option("kind", { type: "string", choices: ["issue_notice", "question", "reply", "status", "patch_request", "claim", "release"] as const, demandOption: true })
          .option("severity", { type: "string", choices: ["critical", "high", "medium", "low", "info"] as const, default: "info" })
          .option("body", { type: "string", demandOption: true })
          .option("idempotency-key", { type: "string", demandOption: true })
          .option("in-reply-to", { type: "string" })
          .option("issue", { type: "string" })
          .option("ticket", { type: "string" })
          .option("commit", { type: "string" })
          .option("ci-run", { type: "string" }),
          {
            // A Bus file ref is a path, where a comma is legal, and blanks must
            // still reach the Bus schema rather than vanishing here.
            file: {
              comma: "literal",
              empty: "preserve",
              trim: "never",
              describe: "File path referenced by this message",
            },
          })),
        async (argv) => {
          const format = formatValue(argv.format);
          const legacyTo = argv.to as string | undefined;
          // Structured deprecation: routing is always to the sole peer, so a
          // legacy `--to` role is accepted (choices reject unknown values) but
          // carries no routing effect. Unknown values are rejected by yargs.
          const deprecation = legacyTo
            ? `Routing is always to the sole peer; the '--to ${legacyTo}' role is deprecated and ignored.`
            : null;
          await runBus(format, async (root) => {
            const values = argv as Record<string, unknown>;
            const owned = await resolveOwnedEndpoint(root, identityFrom(values));
            const sent = await sendBusMessage(root, {
              endpointId: owned.endpointId,
              clientTaskId: owned.taskId,
              threadId: values.thread as string | undefined,
              threadKind: values["thread-kind"] as BusThreadKind | undefined,
              predecessorThreadId: values["predecessor-thread"] as string | undefined,
              messageKind: values.kind as BusMessageKind,
              severity: values.severity as BusSeverity,
              body: values.body as string,
              refs: refsFrom(values),
              inReplyTo: values["in-reply-to"] as string | undefined,
              idempotencyKey: values["idempotency-key"] as string,
            });
            return deprecation ? { ...sent, deprecation } : sent;
          }, (result) => {
            const summary = result.parked
              ? `Thread ${result.threadId} parked at hop ${result.hopCount}.${result.nextAction ? ` Redeliver with: storybloq bus redeliver --predecessor-thread ${result.nextAction.predecessorThreadId} --refused-entry-hash ${result.nextAction.refusedEntryHash}` : ""}`
              : `${result.replayed ? "Replayed" : "Sent"} message ${result.messageId} in thread ${result.threadId}.`;
            return deprecation ? `${deprecation}\n${summary}` : summary;
          });
        },
      )
      .command(
        "redeliver",
        "Redeliver a hop-cap-parked, never-dropped Bus message onto a fresh successor thread",
        (y2) => formatOption(identityOptions(y2)
          .option("predecessor-thread", { type: "string", demandOption: true, describe: "The hop-capped thread whose park entry is being redelivered" })
          .option("refused-entry-hash", { type: "string", demandOption: true, describe: "entryHash of the hop-cap automatic park entry on the predecessor thread" })),
        async (argv) => {
          const format = formatValue(argv.format);
          await runBus(format, async (root) => {
            const values = argv as Record<string, unknown>;
            const owned = await resolveOwnedEndpoint(root, identityFrom(values));
            return redeliverBusMessage(root, {
              endpointId: owned.endpointId,
              clientTaskId: owned.taskId,
              predecessorThreadId: values["predecessor-thread"] as string,
              refusedEntryHash: values["refused-entry-hash"] as string,
            });
          }, (result) => {
            const via = result.replaySource === "marker"
              ? " (answered from an existing redeliver marker; no new message sent)"
              : result.replaySource === "receipt"
                ? " (replayed from your own existing receipt)"
                : "";
            return `Redelivered onto thread ${result.threadId} as message ${result.messageId}${via}.`;
          });
        },
      )
      .command(
        "poll",
        "Read unacknowledged messages addressed to this role",
        (y2) => formatOption(identityOptions(y2)
          .option("limit", { type: "number", default: 20 })
          .option("wait", {
            type: "boolean",
            default: false,
            describe: "Block until a message arrives or --timeout elapses, then exit (v2 only). Exit 0 = message, 4 = timeout, 5 = another waiter already owns this endpoint.",
          })
          .option("timeout", {
            type: "number",
            default: WAIT_DEFAULT_TIMEOUT_SECONDS,
            describe: "Max seconds to block when --wait is set (integer 1-3600)",
          })),
        async (argv) => {
          const format = formatValue(argv.format);
          if (argv.wait) {
            await runBusWait(format, argv.timeout as number, argv.limit as number, identityFrom(argv as Record<string, unknown>));
            return;
          }
          await runBus(format, async (root) => {
            const owned = await resolveOwnedEndpoint(root, identityFrom(argv as Record<string, unknown>));
            const input = { endpointId: owned.endpointId, clientTaskId: owned.taskId, limit: argv.limit as number };
            // D5 legacy-drain: a v1 runtime polls through legacy-v1.ts.
            return owned.protocol === "v1" ? pollV1(root, input) : pollBus(root, input);
          }, (result) => "legacy" in result ? renderV1Poll(result) : renderPoll(result));
        },
      )
      .command(
        "ack <message-id>",
        "Acknowledge one addressed message",
        (y2) => formatOption(identityOptions(y2)
          .positional("message-id", { type: "string", demandOption: true })
          .option("disposition", { type: "string", choices: ["accepted", "rejected", "deferred"] as const, demandOption: true })
          .option("reason", { type: "string" })),
        async (argv) => {
          const format = formatValue(argv.format);
          await runBus(format, async (root) => {
            const owned = await resolveOwnedEndpoint(root, identityFrom(argv as Record<string, unknown>));
            return acknowledgeBusMessage(root, {
              endpointId: owned.endpointId,
              clientTaskId: owned.taskId,
              messageId: argv["message-id"] as string,
              disposition: argv.disposition as "accepted" | "rejected" | "deferred",
              reason: argv.reason as string | undefined,
            });
          }, (result) => `${result.replayed ? "Already acknowledged" : "Acknowledged"} in thread ${result.threadId}.`);
        },
      )
      .command(
        "thread",
        "Read or update a Bus thread",
        (y2) => y2
          .command(
            "show <thread-id>",
            "Show an integrity-verified participant thread",
            (y3) => formatOption(identityOptions(y3).positional("thread-id", { type: "string", demandOption: true })),
            async (argv) => {
              const format = formatValue(argv.format);
              await runBus(format, async (root) => {
                const owned = await resolveOwnedEndpoint(root, identityFrom(argv as Record<string, unknown>));
                return serializedThread(await getBusThread(root, {
                  endpointId: owned.endpointId,
                  clientTaskId: owned.taskId,
                  threadId: argv["thread-id"] as string,
                }));
              }, (thread) => [
                `Thread ${thread.thread.threadId}: ${thread.thread.kind}`,
                `State: ${thread.state} | Integrity: ${thread.integrity} | Hops: ${thread.hopCount}`,
                `Entries: ${thread.validThroughSeq}`,
              ].join("\n"));
            },
          )
          .command(
            "update <thread-id>",
            "Park, resolve, or reopen a participant thread",
            (y3) => formatOption(identityOptions(y3)
              .positional("thread-id", { type: "string", demandOption: true })
              .option("action", { type: "string", choices: ["park", "resolve", "reopen"] as const, demandOption: true })
              .option("reason", { type: "string" })
              .option("resolution", { type: "string" })
              .option("commit", { type: "string" })
              .option("ci-run", { type: "string" })),
            async (argv) => {
              const format = formatValue(argv.format);
              await runBus(format, async (root) => {
                const owned = await resolveOwnedEndpoint(root, identityFrom(argv as Record<string, unknown>));
                const evidence = argv.commit || argv["ci-run"]
                  ? { ...(argv.commit ? { commit: argv.commit as string } : {}), ...(argv["ci-run"] ? { ciRun: argv["ci-run"] as string } : {}) }
                  : undefined;
                const update = {
                  endpointId: owned.endpointId,
                  clientTaskId: owned.taskId,
                  threadId: argv["thread-id"] as string,
                  action: argv.action as "park" | "resolve" | "reopen",
                  reason: argv.reason as string | undefined,
                  resolution: argv.resolution as string | undefined,
                  evidence,
                };
                // D5 legacy-drain: a v1 runtime parks or resolves through legacy-v1.ts (no reopen).
                return owned.protocol === "v1"
                  ? await updateV1Thread(root, update)
                  : serializedThread(await updateBusThread(root, update));
              }, (thread) => "legacy" in thread
                ? `Thread ${thread.threadId} is ${thread.state}.`
                : `Thread ${thread.thread.threadId} is ${thread.state}.`);
            },
          )
          .demandCommand(1, "Specify: show or update"),
        () => {},
      )
      .command(
        "status",
        "Show concise Bus state",
        (y2) => formatOption(y2),
        async (argv) => {
          const format = formatValue(argv.format);
          await runBus(format, async (root) => {
            const summary = await busSummary(root);
            // Additive field: existing BusSummary JSON keys stay at the top level unchanged.
            const autoAttachAdvisories = await collectAutoAttachAdvisories(root, Date.now());
            return { ...summary, autoAttachAdvisories };
          }, (value) => {
            const base = renderStatusMarkdown(value);
            return value.autoAttachAdvisories.length > 0
              ? `${base}\n${value.autoAttachAdvisories.map((advisory) => `- ${advisory}`).join("\n")}`
              : base;
          });
        },
      )
      .command(
        "doctor",
        "Validate Bus storage, endpoint, and mailbox integrity",
        (y2) => formatOption(y2),
        async (argv) => {
          const format = formatValue(argv.format);
          const root = discoverProjectRoot();
          if (!root) {
            writeOutput(formatFailure(new BusError("not_found", "No .story/ project found."), format));
            process.exitCode = ExitCode.USER_ERROR;
            return;
          }
          try {
            const result = await busDoctor(root);
            // Build the set of known endpoint UUIDs so redaction relabels ONLY
            // those, leaving thread/message ids intact. Sourced per runtime (v2
            // registry, or the legacy v1 registry plus finding-extracted UUIDs)
            // so a v1 runtime's endpoint UUIDs are redacted rather than leaked.
            const endpointIds = await doctorEndpointRedactionSet(root, result);
            writeOutput(formatData(result, format, (value) => renderDoctorMarkdown(value, endpointIds)));
            process.exitCode = result.healthy ? ExitCode.OK : ExitCode.VALIDATION_ERROR;
          } catch (err) {
            // A disabled project still deserves readiness guidance, not a bare error.
            if (err instanceof BusError && err.code === "bus_disabled") {
              // T-428: surface the config-revert diagnostic when this checkout
              // carries evidence of an instance it stood up but the feature is off.
              const note = await busConfigRevertNote(root).catch(() => null);
              writeOutput(formatData(disabledDoctorResult(note), format, renderDoctorDisabledMarkdown));
              process.exitCode = ExitCode.OK;
              return;
            }
            writeOutput(formatFailure(err, format));
            process.exitCode = err instanceof BusError && err.code === "corrupt"
              ? ExitCode.VALIDATION_ERROR
              : ExitCode.USER_ERROR;
          }
        },
      )
      .command(
        "check",
        "Run Bus release gates",
        (y2) => formatOption(y2.option("ship", { type: "boolean", default: false, demandOption: true })),
        async (argv) => {
          const format = formatValue(argv.format);
          if (argv.ship !== true) {
            writeOutput(formatFailure(new BusError("invalid_input", "Only `storybloq bus check --ship` is supported."), format));
            process.exitCode = ExitCode.USER_ERROR;
            return;
          }
          await runBus(format, async (root) => {
            // Gate on features.bus BEFORE classifying the runtime so both the v1 and
            // v2 ship-gate paths share the disabled contract: a disabled project with
            // residual v1 files must return `bus_disabled`, not a ship result. The v2
            // checkBusShip path already asserts this internally; the v1 branch did not.
            assertBusEnabled((await loadProject(root)).state.config);
            // A v1 runtime has no v2 ship gate, but the legacy-drain surface retains
            // the authoritative ship-gate evaluation so release-gating (and autonomous
            // FINALIZE) can see and clear v1 blockers BEFORE upgrading. Return the same
            // {clear, blockers} shape derived from evaluateV1Drain's shipBlockers rather
            // than refusing; corrupt v1 records still fail closed (evaluateV1Drain throws
            // corrupt on unreadable/quarantined-registry state).
            if (await classifyBusRuntime(root) === "v1") {
              const paths = await resolveBusPaths(root, false);
              const drain = await evaluateV1Drain(v1PathsFrom(paths.busRoot));
              return { clear: drain.shipBlockers.length === 0, blockers: drain.shipBlockers };
            }
            return checkBusShip(root);
          }, (result) => result.clear
            ? "Bus ship gate is clear."
            : `Bus ship gate blocked:\n${result.blockers.map((blocker) => `- ${blocker}`).join("\n")}`,
          (result) => !result.clear);
        },
      )
      .command(
        "export <thread-id>",
        "Explicitly export one Bus transcript",
        (y2) => y2
          .positional("thread-id", { type: "string", demandOption: true })
          .option("format", { type: "string", choices: ["md", "json"] as const, default: "md" }),
        async (argv) => {
          const format = formatValue(argv.format);
          await runBus(format, async (root) => {
            const value = await exportBusThread(root, argv["thread-id"] as string, format);
            return format === "json" ? JSON.parse(value) as unknown : value;
          }, (value) => typeof value === "string" ? value : JSON.stringify(value, null, 2));
        },
      )
      .demandCommand(1, "Specify a Bus subcommand")
      .strict(),
    () => {},
  );
}
