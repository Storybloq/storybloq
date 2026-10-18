/**
 * ISS-958 section 6: the state-write policy registry.
 *
 * Every catch a state-write error can reach, every promise handler on a state
 * writer, and every place a writer escapes as a value is listed here with the
 * policy it implements. test/autonomous/state-write-enforcement.test.ts scans
 * src and fails on any reachable site that is missing (unregistered) and on
 * any key here that no longer matches a site (stale), so a new path into a
 * state write cannot land without a decision about what happens when that
 * write is published but not durable.
 *
 * Policies: P propagate, A adopt `err.published`, R rethrow, K keep,
 * T truthful translate, TC complete the tail then rethrow, TR record against
 * the published state then refuse truthfully, OC own the creation, B boundary.
 *
 * Keys: `file#enclosingFunction#catch|promise|edge#ordinal`, file relative to
 * the package root. Data only: nothing in production reads this module.
 */

/** Catches and promise handlers a state-write error can reach -> policy. */
export const STATE_WRITE_CATCHES: Readonly<Record<string, string>> = {
  // Plan 1a D1 / 1b.
  "src/autonomous/session.ts#createSession#catch#1": "OC",
  "src/autonomous/session.ts#writeSessionWithEvent#catch#2": "R", // exception (i)
  "src/autonomous/candidate-recovery.ts#commitCandidateTakeoverLocked#catch#1": "K", // exception (ii)
  "src/autonomous/candidate-recovery.ts#commitCandidateTakeoverLocked#catch#2": "P",
  "src/autonomous/candidate-recovery.ts#commitCandidateCancelLocked#catch#1": "T", // exception (iii)
  "src/autonomous/candidate-recovery.ts#commitCandidateCancelLocked#catch#3": "T", // exception (iii)
  "src/autonomous/guide.ts#recoverPendingMutation#catch#2": "A",
  "src/autonomous/guide.ts#trySupersedeFinishedOrphan#catch#1": "TC",
  "src/autonomous/guide.ts#handleStartAfterNormalization#catch#2": "TC", // 1c: superseded dead slot, shutdown marker
  "src/autonomous/guide.ts#handleStartAfterNormalization#catch#11": "P",
  "src/autonomous/guide.ts#publishResume#catch#1": "K", // exception (iv): sidecarPublished
  "src/autonomous/guide.ts#handleResume#catch#4": "K", // exception (iv)
  "src/autonomous/guide.ts#handlePreCompact#catch#1": "P",
  "src/autonomous/guide.ts#handleAutonomousGuide#promise#1": "B", // the `await current` chain link
  "src/autonomous/guide.ts#handleAutonomousGuide#catch#3": "B", // guideError at the MCP boundary
  "src/autonomous/plan-context.ts#withPlanContext#catch#1": "A",
  "src/autonomous/plan-context.ts#runGoverningGate#catch#1": "A",
  "src/autonomous/stages/handover.ts#HandoverStage.report#catch#4": "TC", // 1c: completeTail
  "src/autonomous/stages/types.ts#StageContext.writeState#catch#1": "A", // D15
  "src/autonomous/stages/types.ts#StageContext.finalizeSession#catch#1": "TC",
  "src/autonomous/retired-limit-park.ts#strip#catch#1": "TR",
  "src/autonomous/retired-limit-park.ts#publish#catch#1": "TR",
  "src/autonomous/retired-limit-park.ts#normalizeRetiredLimitParkLocked#catch#1": "TR",
  "src/autonomous/retired-limit-park.ts#normalizeRetiredParksBestEffort#catch#3": "P",
  "src/cli/commands/session-compact.ts#handleSessionCompactPrepare#catch#4": "A", // T/A: continue to the resume marker
  "src/cli/commands/session-compact.ts#handleSessionCompactPrepare#catch#6": "B",
  "src/cli/commands/session-compact.ts#handleSessionResumePrompt#catch#5": "A",
  "src/cli/commands/session-compact.ts#handleSessionResumePrompt#catch#7": "B", // hook exits 0
  "src/cli/commands/session-compact.ts#handleSessionClearCompact#catch#1": "TC", // D8
  "src/cli/commands/session-compact.ts#handleSessionStop#catch#2": "TC", // D9
  "src/cli/commands/brief.ts#handleBriefRebase#catch#1": "P",
  "src/cli/limit-retirement-entry.ts#retireLimitAutoResumeBestEffort#catch#1": "B",
  "src/core/limit-retirement.ts#runLimitRetirement#catch#2": "P",
  "src/cli/register.ts#registerSessionCommand#catch#1": "B",
  // The catalog-write boundary the brief rebase runs under: reports the error and sets the exit code.
  "src/cli/register.ts#runCatalogWrite#catch#1": "B",
  "src/cli/register.ts#registerSessionCommand#catch#7": "B",
  "src/cli/register.ts#registerSessionCommand#catch#8": "B",
  "src/cli/register.ts#registerSessionCommand#catch#11": "B",
  // Registration-time catches: tools are registered, no state is written here.
  // T-538: the init/setup swap to the full surface (moved out of the init handler).
  "src/mcp/index.ts#swapToFullSurface#catch#2": "B",
  "src/mcp/index.ts#<module>#promise#1": "B", // main().catch, process exit
  // The --local-cli entry: reports the error on stderr and sets exit code 2.
  "src/cli/index.ts#<module>#catch#1": "B",
};

/** Value escapes of a writer -> the sink slot it feeds (`file#Container.member`). */
export const STATE_WRITE_EDGES: Readonly<Record<string, string>> = {
  // Addendum 2 R-c: the write-ahead callback, called directly and synchronously in the callee.
  "src/autonomous/stages/pick-ticket.ts#PickTicketStage.branchFromMain#edge#1": "src/autonomous/branch-affinity.ts#performNewBranchFromMain(persistAttemptSync)",
  // Injected test seam; production supplies the default closure beside it.
  "src/autonomous/candidate-recovery.ts#commitCandidateTakeoverLocked#edge#1": "src/autonomous/candidate-recovery.ts#CandidateTakeoverDeps.writeState",
  "src/autonomous/candidate-recovery.ts#commitCandidateCancelLocked#edge#1": "src/autonomous/candidate-recovery.ts#CandidateCancelDeps.apply",
  "src/autonomous/stages/code-review.ts#CodeReviewStage.report#edge#1": "src/autonomous/lens-harness/verification-log.ts#<anon>.writeState",
  "src/autonomous/stages/plan-review.ts#PlanReviewStage.report#edge#1": "src/autonomous/lens-harness/verification-log.ts#<anon>.writeState",
  "src/cli/limit-retirement-entry.ts#retireLimitAutoResumeBestEffort#edge#1": "src/core/limit-retirement.ts#RetirementDeps.normalizeSessions",
  // The per-workspace guide chain; settled at the registered `await current` boundary.
  "src/autonomous/guide.ts#handleAutonomousGuide#edge#1": "Promise.then(onfulfilled)",
  // Addendum 3 R-j1: a writer edge to the local slot `apply`; it keeps contract-callee classification,
  // so both calls through it get the caller check, completion and the writer-site catch policy.
  "src/autonomous/candidate-recovery.ts#commitCandidateCancelLocked#edge#2": "src/autonomous/candidate-recovery.ts#commitCandidateCancelLocked(local const apply)",
  // Command handlers and builders handed to yargs; yargs awaits the handler's promise.
  "src/cli/register.ts#registerSetupCommand#edge#1": "yargs.command(handler)",
  "src/cli/register.ts#registerSetupSkillCommand#edge#1": "yargs.command(handler)",
  "src/cli/register.ts#registerSessionCommand#edge#1": "yargs.command(builder)",
  "src/cli/register.ts#registerSessionCommand#edge#2": "yargs.command(handler)",
  "src/cli/register.ts#registerSessionCommand#edge#3": "yargs.command(handler)",
  "src/cli/register.ts#registerSessionCommand#edge#4": "yargs.command(handler)",
  "src/cli/register.ts#registerSessionCommand#edge#5": "yargs.command(handler)",
  "src/cli/register.ts#registerSessionCommand#edge#6": "yargs.command(handler)",
  "src/cli/register.ts#registerBriefCommand#edge#1": "yargs.command(handler)",
  // Followed into the callee: its catches are scanned as reached.
  "src/cli/register.ts#registerBriefCommand#edge#2": "src/cli/register.ts#runCatalogWrite(run)",
  // Not followed: a param slot here would make every runBoardWrite caller in the CLI a writer path. The
  // chain runs fn once inside AsyncLocalStorage.run and is awaited under runCatalogWrite's catch.
  "src/cli/register.ts#runCatalogWrite#edge#1": "runBoardWrite -> runWithBoardWriteContext -> AsyncLocalStorage.run(callback)",
  // Handlers that call runCatalogWrite: every closure given as `run` is a writer under the slot (over-approximation, fail closed).
  "src/cli/register.ts#registerCapabilityCommand#edge#1": "yargs.command(builder)",
  "src/cli/register.ts#registerCapabilityCommand#edge#2": "yargs.command(handler)",
  "src/cli/register.ts#registerCapabilityCommand#edge#3": "yargs.command(handler)",
  "src/cli/register.ts#registerCapabilityCommand#edge#4": "yargs.command(handler)",
  "src/cli/register.ts#registerTermCommand#edge#1": "yargs.command(builder)",
  "src/cli/register.ts#registerTermCommand#edge#2": "yargs.command(handler)",
  "src/cli/register.ts#registerTermCommand#edge#3": "yargs.command(handler)",
  "src/cli/register.ts#registerTermCommand#edge#4": "yargs.command(handler)",
  "src/cli/register.ts#registerTermCommand#edge#5": "yargs.command(handler)",
  "src/cli/register.ts#registerTermCommand#edge#6": "yargs.command(handler)",
  "src/cli/register.ts#registerLedgerCommand#edge#1": "yargs.command(builder)",
  "src/cli/register.ts#registerLedgerCommand#edge#2": "yargs.command(handler)",
  // The --local-cli dispatch closure; runLocalProjectCommand awaits it with no catch around the call.
  "src/cli/index.ts#<module>#edge#1": "src/cli/local-profile.ts#runLocalProjectCommand(dispatch)",
  // MCP tool callbacks; the SDK awaits the returned promise.
  "src/mcp/index.ts#registerDegradedTools#edge#1": "McpServer.registerTool(callback)",
  // T-538: the swap after a setup-apply call; the setup_apply tool callback awaits it.
  "src/mcp/index.ts#registerDegradedTools#edge#2": "src/mcp/tools.ts#registerSetupApplyTool(afterRun)",
  "src/mcp/tools.ts#registerSetupApplyTool#edge#1": "McpServer.registerTool(callback)",
  // afterRun is awaited inside that callback, so it reaches the same SDK await.
  "src/mcp/tools.ts#registerSetupApplyTool#edge#2": "McpServer.registerTool(callback)",
  "src/mcp/tools.ts#registerAllTools#edge#1": "McpServer.registerTool(callback)",
  "src/mcp/tools.ts#registerAllTools#edge#2": "src/mcp/tools.ts#runGuideCallInOrder(task)",
  // The followed slot handed on to the guide queue's promise handlers.
  "src/mcp/tools.ts#runGuideCallInOrder#edge#1": "Promise.then(onfulfilled)",
  "src/mcp/tools.ts#runGuideCallInOrder#edge#2": "Promise.then(onrejected)",
};

/** `file#fn` whose direct writeSessionSync calls hold the session lock by contract. */
export const LOCK_HELD_BY_CONTRACT: readonly string[] = [
  // Plan v4 rule 6: the Locked park primitive, StageContext, writeSessionWithEvent, D6.
  "src/autonomous/retired-limit-park.ts#normalizeRetiredLimitParkLocked",
  "src/autonomous/candidate-recovery.ts#commitCandidateTakeoverLocked",
  "src/autonomous/stages/types.ts#StageContext.writeState",
  "src/autonomous/session.ts#writeSessionWithEvent",
  "src/autonomous/session.ts#clearInterruption",
  // Declared deviation from rule 6: plan 1a gives each a caller's lock.
  "src/autonomous/session.ts#createSession", // D1, guide lock
  "src/autonomous/session.ts#markCompactionObserved", // D3, session-compact.ts resume-prompt lock
  "src/autonomous/session.ts#prepareForCompact", // D4/D5, compact-prepare lock or guide lock
  "src/autonomous/guide-effects.ts#writeSessionAndRefresh", // D16, caller's lock
  // Addendum 3 R-i: same shape as the takeover commit; holders candidate-recovery.ts withSessionLock and guide handleCandidateCancel.
  "src/autonomous/candidate-recovery.ts#commitCandidateCancelLocked",
];

/**
 * Calls (and awaits, and promise handlers) a catch can reach whose callee the
 * scan cannot resolve to a concrete declaration, each with the reason it cannot
 * carry a state write. `file#enclosingFunction#callee#ordinal` -> reason.
 */
export const STATE_WRITE_UNRESOLVED: Readonly<Record<string, string>> = {
  // The release function returned by a lockfile acquisition: third-party code, no state write.
  "src/autonomous/session.ts#withSessionLock#release#1": "proper-lockfile release returned by lockfile.lock; it removes the lock directory and never writes session state",
  "src/autonomous/telemetry-writer.ts#withTelemLock#release#1": "proper-lockfile release for the telemetry lock; it never writes session state",
  "src/autonomous/lens-harness/coverage-memory.ts#withCoverageLock#release#1": "proper-lockfile release for the coverage-memory lock; it never writes session state",
  "src/cli/commands/projection.ts#writeDecisionsProjection#release#1": "proper-lockfile release for the projection lock; it never writes session state",
  "src/cli/commands/migrate.ts#handleMigrate#release#1": "proper-lockfile release for the migration lock; it never writes session state",
  // Untyped receivers: values from parsed config or a third-party SDK object.
  "src/autonomous/lens-harness/prepare.ts#loadLensActivationConfig#lc.lenses.every#1": "Array.prototype.every on parsed JSON config; the predicate is a local pure check",
  "src/channel/inbox-watcher.ts#processEventFile#server.server.sendNotification#1": "MCP SDK Server.sendNotification on an untyped server handle; it sends a JSON-RPC notification and never writes session state",
  "src/channel/inbox-watcher.ts#processEventFile#server.server.sendNotification#2": "the same MCP SDK notification call on the second event branch",
  // Outside src.
  "src/bus/auto-attach-spawn.ts#spawnAutoAttachBestEffort#spawnFn#1": "node:child_process spawn (or its test stub); it starts a detached process and never writes session state",
};

/**
 * `file#fn` that call a LOCK_HELD_BY_CONTRACT function outside a lexical
 * withSessionLock callback and hold the lock because their caller does: the
 * guide actions run under guide.ts handleGuideInner's lock.
 */
export const LOCK_HELD_VIA_CALLER: Readonly<Record<string, string>> = {
  // `file#fn` -> a lock-holding caller. Every call site is checked; this names one.
  "src/autonomous/guide.ts#handleGuideInner": "src/autonomous/guide.ts#handleAutonomousGuide", // the withSessionLock callback
  "src/autonomous/guide.ts#handleStart": "src/autonomous/guide.ts#handleGuideInner",
  "src/autonomous/guide.ts#handleReport": "src/autonomous/guide.ts#handleGuideInner",
  "src/autonomous/guide.ts#handleResume": "src/autonomous/guide.ts#handleGuideInner",
  "src/autonomous/guide.ts#handlePreCompact": "src/autonomous/guide.ts#handleGuideInner",
  "src/autonomous/guide.ts#handleCancel": "src/autonomous/guide.ts#handleGuideInner",
  "src/autonomous/retired-limit-park.ts#normalizeProjectParksLocked": "src/autonomous/guide.ts#handleStart",
  "src/autonomous/guide.ts#handleCandidateCancel": "src/autonomous/guide.ts#handleCancel",
  "src/autonomous/guide.ts#handleStartAfterNormalization": "src/autonomous/guide.ts#handleStart",
  "src/autonomous/guide.ts#terminalizeCompletedSession": "src/autonomous/guide.ts#handleStartAfterNormalization", // also claimPreflightBlock
  "src/autonomous/guide.ts#claimPreflightBlock": "src/autonomous/guide.ts#handleReport", // also handleResume
  "src/autonomous/guide.ts#recoverPendingMutation": "src/autonomous/guide.ts#handleReport", // also handleStartAfterNormalization, handleResume, handleCancel
  "src/autonomous/guide.ts#adoptExpiredLease": "src/autonomous/guide.ts#handleReport", // also handlePreCompact
  "src/autonomous/guide.ts#abandonBlockedCompletion": "src/autonomous/guide.ts#handleCancel",
  "src/autonomous/guide.ts#drainPendingDeferrals": "src/autonomous/guide.ts#handleReport", // also handleResume
  "src/autonomous/guide.ts#trySupersedeFinishedOrphan": "src/autonomous/guide.ts#handleStartAfterNormalization",
  "src/autonomous/guide.ts#handleCandidateTakeoverResume": "src/autonomous/guide.ts#handleResume",
  "src/autonomous/guide.ts#runPipelineStage": "src/autonomous/guide.ts#handleReport", // constructs the StageContext
  "src/autonomous/cancellation-core.ts#applyCancellationTransition": "src/autonomous/guide.ts#handleCancel",
};

/** `file#fn#new#ordinal` of every StageContext construction; each runs under the lock. */
export const CONTEXT_CONSTRUCTIONS: readonly string[] = [
  "src/autonomous/guide.ts#handleStartAfterNormalization#new#1",
  "src/autonomous/guide.ts#handleStartAfterNormalization#new#2",
  "src/autonomous/guide.ts#runPipelineStage#new#1",
  "src/autonomous/guide.ts#handleResume#new#1",
  "src/autonomous/guide.ts#handleResume#new#2",
  "src/autonomous/guide.ts#handleResume#new#3",
  "src/autonomous/guide.ts#handleResume#new#4",
  "src/autonomous/guide.ts#handleResume#new#5",
];

/**
 * Awaited-callback primitives: their callback runs in the call site's lock
 * region. The scan verifies each along its whole delegation chain
 * (withProjectLock -> withProjectLockInternal -> withLock -> AsyncLocalStorage.run).
 */
export const AWAITED_CALLBACK_PRIMITIVES: readonly string[] = [
  "src/core/project-loader.ts#withProjectLock",
  // T-486 U4: the issue-sweep lock awaits its handler inside withProjectLockInternal.
  "src/core/project-loader.ts#withProjectLockForIssueSweep",
];

/** Injected awaited-callback slots, each with why only tests supply it. */
export const INJECTED_CALLBACK_SLOTS: Readonly<Record<string, string>> = {
  "src/autonomous/candidate-recovery.ts#CandidateTakeoverDeps.withProjectLock":
    "test seam: production leaves it unset and the verified default closure takes the project lock",
};

/** Context-carrying parameters: treated as the StageContext inside their function. */
export const CONTEXT_PARAMS: readonly string[] = [
  "src/autonomous/review-identity.ts#prepareReviewRound(host)",
  "src/autonomous/review-identity.ts#writeRoundArtifact(host)", // addendum 3 R-g
];

/**
 * Not-followed src-receiver sinks, edge key -> the chain the scan verifies on src:
 * no try with a catch encloses the slot's use in any hop, and each hop awaits or
 * returns the call that uses or forwards it, ending at a library callee.
 */
export const UNFOLLOWED_SINK_CHAINS: Readonly<Record<string, readonly { readonly fn: string; readonly param: string }[]>> = {
  "src/cli/register.ts#runCatalogWrite#edge#1": [
    { fn: "src/cli/run.ts#runBoardWrite", param: "fn" },
    { fn: "src/core/board-write-recorder.ts#runWithBoardWriteContext", param: "fn" },
  ],
};

/** Addendum 3 R-j1: injected test-seam slots; the scan asserts no src object literal supplies one. */
export const TEST_SEAM_SLOTS: Readonly<Record<string, string>> = {
  "src/autonomous/candidate-recovery.ts#CandidateCancelDeps.apply":
    "test seam: production leaves it unset and the local apply takes applyCancellationTransition",
  "src/autonomous/candidate-recovery.ts#CandidateTakeoverDeps.writeState":
    "test seam: production leaves it unset and the local writeState takes the synchronous durable writeSessionAndRefresh",
};

/** Lock-entry primitives: the scan verifies each awaits its callback once and releases in a finally. */
export const LOCK_ENTRIES: readonly string[] = [
  "src/autonomous/session.ts#withSessionLock",
];

/** Non-throwing loggers a contained catch may call. */
export const SINK_ALLOWLIST: readonly string[] = [
  "process.stderr.write",
  "console.error",
];

/** Result helpers a contained catch may return; their return types must be non-thenable. */
export const RESULT_ALLOWLIST: readonly string[] = [
  // Populated from the scan of src at the S6 head.
];

/**
 * Exported test seams. Code inside their initializers is not a writer path,
 * and the scan refuses any src reference to them, so production can never
 * reach a writer through one.
 */
export const TEST_ONLY_EXPORTS: readonly string[] = [
  // ISS-958 S2: lets tests drive recoverPendingMutation's adopt branch directly.
  "src/autonomous/guide.ts#__recoveryTesting",
];
