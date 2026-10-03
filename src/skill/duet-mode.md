# Duet mode

Use for an owner-paired manager (pen) and worker, after the entry skill's ownership guard. Keep existing task roles and authorization; pairing does not authorize new tasks, project writes, spending, or release gates. Use client task IDs, including the client, as identity anchors (ISS-1117).

## Pair and prove the return route

1. Read the arrangement and verify its project, bounds, both task IDs, and your role. Names alone cannot select a worker. The pen owns coordination writes; the worker reports to the pen. Live seats on this machine are read with `storybloq_roster_get` (MCP) or `storybloq roster list` (CLI), never from a checked-in contacts file: the roster is machine-local and gitignored, and a committed contacts list is wrong for everyone who pulls it.
2. Each participant discovers its own exact callable sender and completion tools. Record identifiers, not a namespace or a description mentioning messaging. Classify native task messaging as **available**, **absent** after complete discovery, or **unknown** if discovery is incomplete. Receiving a message proves no outbound capability.
3. On manager entry, resume, or compaction recovery, read ledger obligations and runtime assignments, then rotate the coordination session. Preserve assignment IDs, dispatch sessions, cursors, pending questions, and processed reports. Collect outstanding results before fresh dispatch. Missing historical runtime requires the recovery procedure below; it never means no work exists.
4. Send the worker the project, both identities, coordination session ID, server-returned nonce, and required return route. A sender-capable worker replies to the manager directly; otherwise the manager collects the worker's matching final response. Observe the matching worker return before appending a receipt and announcing readiness. A local acknowledgment or accepted outgoing send alone is insufficient.

| Worker return capability | Reply mode | Required completion backstop |
| --- | --- | --- |
| Exact sender callable and matching return observed | `native-return` | Client-specific turn-end collection below |
| No sender, manager can collect worker output | `manager-collected` | Client-specific turn-end collection below |
| Neither route proved | Unverified | Report the missing capability; do not dispatch |

Persist coordination with `storybloq_arrangement_coordinate` using the wrapper `{ "operation": <operation> }`, or `storybloq arrangement coordinate <id> --json <operation>` using the direct operation object. Actions are `start`, `recover`, `receipt`, `assign`, and `update`. Read current state through arrangement get before mutations; supply request-scoped `clientTaskId`, `expectedRevision`, and `expectedSessionId`. Start uses a fresh `newSessionId` and returns the nonce to echo. Use the operation schema for fields rather than inventing flags. Receipt retries retain the original payload, including `observedAt`; the server derives the recorder. Receipts record attributed observation, not authentication.

Runtime assignments live in `.story/duet-sessions/<arrangementId>/state.json`, outside autonomous sessions. The tracked arrangement's `coordinationCheckpoint` preserves assignments, obligations, and report identities across machines; harness cursors remain local (ISS-1075). When runtime is missing or corrupt, arrangement get exposes that checkpoint. Reconcile it with task history and the handover, then use `recover` with the checkpoint's revision as `expectedRevision`, the current session as `expectedSessionId`, a fresh `newSessionId`, and `recoveryEvidence` describing the reconciliation. Restore completion collection and prove a fresh nonce return before dispatch. If no usable checkpoint exists, report recovery required. Do not edit runtime JSON to bypass recovery or identity errors. A new task identity requires owner-authorized rebinding through `storybloq arrangement rebind` (or `storybloq_arrangement_rebind`), never implicit succession or hand-edited parties.

## Spawning a worker (N-131, T-530)

One call from the pen opens a worker that handshakes by itself: `storybloq duet spawn --name <worker> --pen <this session's name> --model <id> --bounds T-123`. `--model` pins the worker's model; omitted, the worker runs opus (the hands tier), never the client default, and the output's `Model:` line says which and why. It mints the worker's client task id, creates the arrangement (pen = this session's task id, worker = the minted id, `onIrreversibleWork: hold`), starts coordination to obtain the nonce, writes a role carrying the arrangement id, coordination session, nonce and both identities under the git-ignored `.story/spawn/`, and hands a launch script to the OS launcher, which opens the user's default terminal with `claude --session-id <minted id> ... '/story'`. The worker loads `/story` on its own and sends `nonce <n>, worker <name> <id8>, sender <its exact sender tool>` to the pen by name. The pen records the receipt only after it OBSERVES that echo (a local send is never proof); the command prints the prefilled `arrangement coordinate ... receipt` to run at that moment. Then dispatch as below.

Automatic is the default for a Claude pen whose task id resolves (`CLAUDE_CODE_SESSION_ID`, or `--pen-task-id`); `--bounds` is then required and a spawn without it is refused, never quietly downgraded. Only two conditions fall back to the manual flow, each named in the output: no pen task id, or a codex pen. `--arrangement none` asks for the manual flow (type nothing: `/story` still auto-loads unless `--no-auto-load`; then handshake as below). `--dir <path>` starts the worker in another checkout, the normal federation case: the role tells the worker which ledger its `/story` loads, that the arrangement lives on the pen's board and cannot be read from the node, and that the bounds are coverage, not its task list. A `--dir` with no `.story` above it (a scratch worktree) works too: the launch sets `STORYBLOQ_PROJECT_ROOT` to the pen's board and the role names both; spawn refuses only when the pen's own project cannot be resolved. `--permission-mode <mode>` sets the worker's mode; omitted, the worker gets `auto`, rising to `bypassPermissions` only when the pen itself is detected running in bypass (read from the pen's own `claude` argv in the process tree). `--role <file>` supplies your own text; the handshake section is appended in a copy beside the script, the original untouched. `--print` prints the command and the role it would write and creates nothing. `--terminal <app>` picks the macOS app. Every spawn mints a fresh identity; there is no respawn under an old one (succession is ISS-1290).

Interrupted spawns: every side effect is announced first in a journal under `.story/spawn/<name>.XXXXXX/<name>.json`, and `storybloq duet spawn --recover` lists each journal with two independent readings, launch (from the journal: not launched, UNKNOWN once the launcher was invoked, launched) and coordination (from the ledger: not started, started without receipt, receipt recorded, SUPERSEDED after a later rotation, UNRESOLVED when the runtime cannot be read, closed). A journal short of `launched` is a recovery candidate, never proof the worker is absent: a worker still loading `/story` has no receipt yet. The close command is offered only when the worker was not launched and the arrangement has no receipt.

Spawning is still a subagent under the owner's rules: propose the name, model and role, and get the owner's yes before running it.

## Dispatch and collect

Before dispatch, persist an assignment with its ID, scope, allowed actions, acceptance criteria, manager return address, reply mode, and next gate. Carry its ID in every question and result. Arm the completion backstop for each dispatch. Every worker turn ends with a deliverable, a question, or the literal **"turn ending, continue needed"**. Workers with a sender deliver questions and results directly to the manager, then leave the same assignment ID in their final output. Give each result an immutable `reportId`, shared unchanged by its native message and final-output copies; reviews refer to that same report ID.

**Seats on branches (ISS-1190).** If the worker creates items on its own branch/worktree, set `idAllocator: git-refs` before the first such dispatch (`storybloq team init && ...config set idAllocator git-refs`) -- local allocation mints the same next id on divergent branches. Name the allocator in the dispatch.

**Bridge review gate (ISS-1282).** A commissioned codex-bridge round follows the receipt rules in autonomous-mode.md (Bridge review gate); the guide refuses a round that breaks them.

The manager persists collection cursors and report identities, processes direct and collected copies once, and reviews evidence before resolving an assignment. A worker turn ending without a report triggers collection or a status demand; it does not resolve the assignment. Keep pending questions and owed/owing/resource-hold notes in the ledger. Carry unresolved work through interruptions without redispatching it under a new ID.

While the manager is active, 60 minutes without meaningful worker activity calls for one status demand per silent interval. Polling is not worker activity. This procedure has no watchdog or timed recovery promise while the manager is idle.

### Liveness obligations (ISS-1137)

A Claude Code session does not resume itself across a turn boundary: a turn that ends with a stated intention ("continuing with scope 2") ends, and nothing wakes it. Both sides therefore carry a numbered obligation.

- **Worker, 30 minutes.** Never end a turn with an intention. A turn ends with the deliverable, a question for the manager, or the literal words "turn ending, continue needed" plus the current scope, so the manager's continue lands on a known state. Any stop longer than 30 minutes owes a message even when its whole content is "blocked on X" or "context exhausted". A dirty shared tree with no message is a duet failure, not a pause.
- **Manager, 60 minutes and every dispatch.** The manager arms the harness's idle notification (`notify_when_idle: true` on Claude Code cross-session messaging) on every dispatch and on every reply while work is open, so the worker's next idle transition wakes the manager. On that notice, if the expected package or question has not arrived, the manager sends a continue. An idle notice is not a report. Sixty silent minutes while the manager is active is a status demand, as above.

Cadence ruling: handover before auto-compaction, after a major item completes, and after a batch of issues or one big issue resolves; the pushed line is advice, not one handover per message; never stop at a percentage; one continue after a handover is allowed; no status demands to a worker above 90 percent.

Every dispatch prompt states the worker obligation verbatim so the rule travels with the work rather than living only in this file.

## Capacity

An arrangement file is capped at 65,536 bytes, and what fills it is the coordination checkpoint's assignments, not receipts: each event stores its own full input payload alongside the assignment's, so roughly 12 to 14 assignments reach the wall on their own.

Compaction runs automatically on every coordination write. A `resolved` assignment keeps its identity, timing, dispatch session and its LAST event; `assigned`, `needs-attention` and `needs-review` assignments keep everything, byte for byte. Once the projected file passes 80 percent of the cap, resolved records beyond the newest five move into a `compactedAssignments` archive carrying their id and resolution time. An archived id can never be reused for new work.

Compaction leaves the runtime file untouched but permanently reduces the RECOVERY checkpoint: once the runtime is gone, `recover` rebuilds from the reduced record, and a resolved assignment's scope, acceptance criteria and earlier events are lost. Preserve what a later reader needs (evidence paths, decisions) outside the checkpoint before compacting.

`arrangement get` and `earmark get` both report `capacity` (`bytes`, `max`, `pct`, `checkpointBytes`), so the wall is visible before it refuses a write.

Compact and rotate are CLI only and pen-authorized:

- `storybloq arrangement compact <id>` compacts the checkpoint explicitly. It refuses on unresolved conflicts, an unreadable runtime, or a readable runtime that diverges from the checkpoint; a changed checkpoint moves its CAS revision, so a pen holding the older one gets the ordinary stale-revision refusal.
- `storybloq arrangement rotate <id>` is the escape hatch when compaction can no longer shrink the file. It requires a verified return route, then makes a successor with the same parties, bounds and gates, carrying the open assignments, verified session and earmarks, and closes the original with `continuedBy`. The closed file keeps the history and refuses coordination and lifecycle changes. No node-qualified bounds.
- `storybloq arrangement rebind` replaces one party in a successor and closes the original with `continuedBy`. It carries the checkpoint and earmarks, never the nonce, receipts or session. The new pen runs `start` (seeded from the checkpoint) and proves the return route. While the pen's seat is live or the roster read is inconclusive, only the pen may rebind; otherwise anyone may, with `--evidence`. Liveness is machine-local.

A refused write names both commands and the exact byte counts.

## Codex

For separately created desktop tasks, discover the callable equivalents of `send_message_to_thread`, `wait_threads`, `read_thread`, and task listing in each task independently. Common full identifiers include `mcp__codex_app__send_message_to_thread` and `mcp__codex_app__wait_threads`; invoke only identifiers actually present. Exact discovery may use a deferred-tool search or the runtime's callable inventory, such as `ALL_TOOLS`. Never infer availability from another task's inventory.

The manager uses bounded `wait_threads` completion waits in **both** reply modes, retaining `afterCursor` across timeouts. A zero-timeout snapshot is observation, not armed supervision. Continue waiting while an assignment remains open; neither a timeout nor a worker's direct message discharges result review. Process incoming questions, then re-arm collection. Do not deliberately end the manager turn with open work and no active completion backstop. On interruption, record the continuation and collect it on re-entry before dispatching more work.

Discover separately whether the current harness exposes an independently armed worker-turn-end notification. Native delivery that can start a manager turn does not prove such a notification exists. Record only the observed inventory; do not generalize absence to all Codex installations.

## Claude Code

Discover the actual native sender and the harness's worker-turn-end notification. Use the observed, re-armed notification as the completion backstop on every dispatch, separately from the worker's obligation to send. An idle manager is supervised only when that independent notification is actually armed. If it is unavailable, use a demonstrated completion-collection mechanism or keep the pair unverified. Do not infer re-arming or idle wake merely from a successful direct message.

## Transport boundaries

Native sibling tasks, harness-spawned subagents, and Storybloq Bus endpoints are separate transports. An arrangement records roles; it does not establish a channel. Subagent completion delivery applies only to the harness's actual child-agent relationship. Bus requires its own bound endpoint and proof; read `bus-mode.md` only when that transport is selected. Missing native tools never call for Computer Use, private IPC, or configuration workarounds.

Source: ISS-1155. Installation inventory and footprint checks: ISS-1144, ISS-1146. Keep installed skills and REVIEW.md unchanged during any active measurement freeze.
