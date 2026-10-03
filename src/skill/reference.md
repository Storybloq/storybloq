# storybloq Reference

## CLI Commands

### JSON output envelope

`--format json` normally returns `{"version":1,"data":...}` or `{"version":1,"error":{"code":...,"message":...}}`. Partial loads add `warnings` and exit 3. `--raw` emits only `data`, retaining error envelopes but dropping partial-load warnings; the exit code still signals them. Exceptions: `gc`, `conflicts list`, `conflicts show`, `resolve`, and `team reserve` return `{"ok","data"}`; `team init` and `team setup` return bare objects; `session list/show` use their own text/json shapes; Bus commands use their versioned wire format. Those exceptions reject `--raw` during argument validation, before execution. Each command names its shape in `--help`. Use JSON to round-trip description/impact/content: markdown render fences grow when fed back through `update --stdin`; updates strip them and warn (ISS-1192).

Run `storybloq <command>`. Positional arguments appear after the command; ? marks optional flags. Use `<command> --help` for value types and choices, or `storybloq reference --format json` for full usage strings.

- **init** (--name?, --force?, --type?, --language?, --node?, --format?) - Initialize a new .story/ project
- **status** (--format?, --client-task-id?, --compact?) - Project summary: phase statuses, ticket/issue counts, blockers. --compact (T-320): JSON only, ignores --format. Reduces the payload: drops archivedNotes, deprecatedLessons, and issueFlow.semantics; reduces each session record (activeSessions/resumableSessions/expiredLeaseSessions) to sessionId, sourceDir, state, mode, ownerTask, leaseState, leaseExpiresAt, compactPending, dropping ticketId/ticketTitle; reduces bus to enabled, daemonState, deliveryMode, pendingMessages, unacknowledgedCritical, nextActions, dropping participants, wake, hookDelivery, deliveryCapabilities, and every other bus field. sessionDiagnostics, arrangements/arrangementWarnings, and every other top-level field are kept whole.
- **ticket list** (--status?, --phase?, --type?, --format?, --node?) - List tickets with optional filters
- **ticket get <id>** (--format?) - Get ticket details by ID
- **ticket next** (--format?, --count?) - Suggest next ticket(s) to work on
- **ticket blocked** (--format?) - List blocked tickets with their blocking dependencies
- **ticket create** (--title, --type, --phase?, --description?, --stdin?, --parent-ticket?, --blocked-by?, --cites-ruling?, --format?, --node?, --commit?) - Create a new ticket
- **ticket update <id>** (--status?, --title?, --type?, --phase?, --order?, --description?, --stdin?, --parent-ticket?, --node?, --force?, --clear-cites-rulings?, --blocked-by?, --cross-node-blocked-by?, --cites-ruling?, --format?, --commit?) - Update a ticket
- **ticket meta <operation> <id> [path] [value]** (--format?, --commit?) - Get, set, or unset custom passthrough metadata on a ticket
- **ticket delete <id>** (--force?, --hard?, --format?, --commit?) - Delete a ticket
- **checkpoint enable** (--format?, --commit?) - Turn owner checkpoints on (config schemaVersion 4; a team ledger must merge them first)
- **checkpoint create** (--title, --owner, --kind, --question?, --criteria?, --evidence-ref?, --phase?, --description?, --blocked-by?, --parent-ticket?, --actor?, --format?, --commit?) - Create an owner checkpoint ticket. Needs `checkpoint enable` first.
- **checkpoint attach <id>** (--owner, --kind, --question?, --criteria?, --evidence-ref?, --actor?, --format?, --commit?) - Make an open, unclaimed ticket a checkpoint
- **checkpoint resolve <id>** (--generation, --revision, --digest, --actor?, --response, --artifact-ref?, --ruling?, --ruling-scope-tag?, --client-task-id?, --format?, --commit?) - Answer a checkpoint. An acceptance needs artifactRef. Names the reviewed state; a stale one is refused
- **checkpoint change <id>** (--generation, --revision, --digest, --actor?, --kind, --question?, --criteria?, --evidence-ref?, --format?, --commit?) - Change what a checkpoint asks; voids its answer
- **checkpoint reopen <id>** (--generation, --revision, --digest, --actor?, --reason?, --format?, --commit?) - Withdraw a checkpoint's answer; kept in history
- **checkpoint retire <id>** (--generation, --revision, --digest, --actor?, --reason, --format?, --commit?) - Retire a checkpoint, releasing dependents; needs a reason
- **checkpoint resolve-conflict <id>** (--use?, --field?, --value?, --actor?, --format?, --commit?) - Settle a merge conflict on a checkpoint; a selected approval returns to pending (CLI-only)
- **checkpoint list** (--state?, --format?) - Owner checkpoints with the state a change must name (CLI-only)
- **issue list** (--status?, --severity?, --component?, --phase?, --format?) - List issues with optional filters
- **issue get <id>** (--format?) - Get issue details by ID
- **issue create** (--title, --severity, --impact?, --stdin?, --phase?, --dedupe-key?, --created-by?, --components?, --related-tickets?, --location?, --source-ref?, --cites-ruling?, --format?, --commit?) - Create a new issue
- **issue update <id>** (--status?, --title?, --severity?, --impact?, --stdin?, --resolution?, --order?, --phase?, --clear-cites-rulings?, --components?, --related-tickets?, --location?, --source-ref?, --cites-ruling?, --format?, --commit?) - Update an issue
- **issue meta <operation> <id> [path] [value]** (--format?, --commit?) - Get, set, or unset custom passthrough metadata on an issue
- **issue delete <id>** (--hard?, --format?, --commit?) - Delete an issue
- **phase list** (--format?, --node?) - List all phases with derived status
- **phase current** (--format?) - Show current (first non-complete) phase
- **phase tickets** (--phase, --format?) - List tickets in a specific phase
- **phase create** (--id, --name, --label, --description, --summary?, --after?, --at-start?, --node?, --format?, --commit?) - Create a new phase
- **phase rename <id>** (--name?, --label?, --description?, --summary?, --format?, --commit?) - Rename/update phase metadata
- **phase move <id>** (--after?, --at-start?, --format?, --commit?) - Move a phase to a new position
- **phase delete <id>** (--reassign?, --format?, --commit?) - Delete a phase
- **handover list** (--format?) - List handover filenames (newest first)
- **handover latest** (--count?, --brief?, --priming?, --format?) - Content of most recent handover
- **handover get <filename>** (--format?) - Content of a specific handover
- **handover create** (--content?, --stdin?, --slug?, --format?, --commit?) - Create a new handover document
- **handover template** (--override?, --format?) - Scaffold a new handover document (category headings, Carried forward, marker)
- **blocker list** (--format?) - List all roadmap blockers
- **blocker add** (--name, --note?, --format?, --commit?) - Add a new blocker
- **blocker clear** (--name, --note?, --format?, --commit?) - Clear (resolve) a blocker
- **note list** (--status?, --tag?, --format?) - List notes with optional status/tag filters
- **note get <id>** (--format?) - Get a note by ID
- **note create** (--content?, --title?, --stdin?, --tags?, --format?, --commit?) - Create a new note
- **note update <id>** (--content?, --title?, --clear-tags?, --status?, --stdin?, --mode?, --confirm-replace?, --tags?, --format?, --commit?) - Update a note
- **note delete <id>** (--hard?, --format?, --commit?) - Delete a note
- **lesson list** (--status?, --tag?, --source?, --format?) - List lessons with optional status/tag/source filters
- **lesson get <id>** (--format?) - Get a lesson by ID
- **lesson digest** (--format?, --limit?, --select?) - Ranked digest of active lessons. --limit/--select (T-320): one-line-per-lesson form; --select is phase:<id>/component:<name>/item:<id>, falls back to --limit.
- **lesson create** (--title, --content?, --context, --source, --supersedes?, --stdin?, --tags?, --format?, --commit?) - Create a new lesson
- **lesson update <id>** (--title?, --content?, --context?, --clear-tags?, --status?, --stdin?, --tags?, --format?, --commit?) - Update a lesson
- **lesson reinforce <id>** (--format?, --commit?) - Reinforce a lesson: increment count and update lastValidated
- **lesson delete <id>** (--hard?, --format?, --commit?) - Delete a lesson
- **capability list** (--status?, --skip-check?, --format?) - List the capability inventory with each entry's EFFECTIVE status: the stored flag folded together with a freshness check against HEAD. --status filters on the effective status, not the stored one
- **capability get <id>** (--skip-check?, --format?) - Show one capability: contract, entry points, surfaces, the rulings and items behind it, and its findings
- **capability match** (--path?, --title?, --phase?, --format?) - Find capabilities a task may already be covered by, from its paths, title or phase. Bounded to the inventory and says so: no match never means no implementation exists
- **capability add** (--id, --name, --summary, --entry, --contract, --example?, --cli?, --mcp-tool?, --app?, --surface-file?, --ruling?, --item?, --term?, --status?, --format?, --commit?) - Add a capability. Stamps the checkpoint at HEAD, so it records that the entry points were actually read
- **capability update <id>** (--name?, --summary?, --entry?, --contract?, --example?, --cli?, --mcp-tool?, --app?, --surface-file?, --ruling?, --item?, --term?, --status?, --format?, --commit?) - Edit a capability. Supplied list flags replace the stored lists; the checkpoint is never touched, because an edit is not an inspection
- **capability check** (--stamp?, --stamp-all?, --clear-pending?, --format?) - Check every capability against HEAD; --stamp re-records the checkpoint after re-reading an entry. Refused for a structural finding, which a new sha would hide rather than fix
- **capability defer <id>** (--note, --issue?, --format?, --commit?) - Record owed work on a capability as a pending note: it stays current, renders pending first, and a stamp is refused until --clear-pending
- **capability restore <id>** (--from, --expect, --format?, --commit?) - Restore one capability entry to its projection at --from, refused unless it still matches its projection at --expect. Rewrites only that entry, never deletes
- **projection write** (--format?, --commit?) - Regenerate the decisions projection the Mac app reads, with a full freshness check; ruling, capability and term writes and the CLI status refresh it structurally
- **term list** (--core?, --thin?, --digest?, --format?) - List the glossary: what a word means here, and what it is not. Advisory throughout, so nothing here renames, rewrites or refuses on a term
- **term get <id>** (--format?) - Show one term: its definition, the distinction that matters, and the capabilities and rulings behind it
- **term match** (--text, --format?) - Which glossary terms appear in a piece of text. Whole-word and case-insensitive; a match SUGGESTS a term and changes nothing
- **term check** (--format?) - Check every term's capability and ruling links, and flag the thin entries: no distinction, or no capability link
- **term add** (--id, --term, --definition, --distinction?, --alias?, --capability?, --ruling?, --core?, --added-by?, --format?, --commit?) - Add a term. One word belongs to one entry, so a name another entry already owns is refused rather than shared
- **term update <id>** (--term?, --definition?, --distinction?, --alias?, --capability?, --ruling?, --core?, --added-by?, --clear-pending?, --format?, --commit?) - Edit a term. Supplied list flags replace the stored lists
- **term defer <id>** (--note, --format?, --commit?) - Record owed work on a term as a pending note, rendered pending first until term update --clear-pending
- **term restore <id>** (--from, --expect, --format?, --commit?) - Restore one term to its projection at --from, refused unless it still matches its projection at --expect. Rewrites only that term, never deletes
- **ledger restore <path>** (--from, --expect, --format?, --commit?) - Restore one ruling, note or issue file to its bytes at --from, refused unless it still matches its projection at --expect. Never deletes; an accepted ruling is never rewritten
- **brief <id>** (--budget?, --rebase?, --reason?, --by?, --format?, --commit?) - The context brief for a ticket or issue: binding rulings, suggested rulings, capabilities, terms, lessons, and what discovery could not see. Read-only; a suggestion binds nothing. --rebase adopts a session's provisional context manifest after recovery
- **term remove <id>** (--format?, --commit?) - Remove a term. Refused while a capability references it: the other file is never edited to make this possible
- **ruling list** (--scope-tag?, --superseded?, --status?, --format?) - List rulings, optionally filtered by scope tag, superseded state or lifecycle status; --format md renders the Decisions listing
- **ruling get <id>** (--format?) - Get a ruling by ID with its lifecycle, revision digest and chain status
- **ruling create** (--text, --attribution, --date, --scope-tag?, --cites?, --client-task-id?, --context?, --alternatives?, --consequences?, --reconsider-when?, --format?, --commit?) - Record a ruling verbatim; --cites adds its id to each named ticket or issue in the same transaction; narrative flags are recorded beside the text, never inside it
- **ruling supersede <id>** (--with?, --text?, --attribution?, --date?, --scope-tag?, --client-task-id?, --branch?, --context?, --alternatives?, --consequences?, --reconsider-when?, --format?, --commit?) - Supersede a ruling: link an existing one with --with, or record a new superseding ruling; --branch knowingly records a second successor
- **ruling propose** (--text, --attribution, --date, --scope-tag?, --for?, --proposes-to-supersede?, --client-task-id?, --context?, --alternatives?, --consequences?, --reconsider-when?, --format?, --commit?) - Propose a ruling (T-522). A proposal binds nothing until accepted; drafting a replacement revokes nothing. --for names the items that gain the citation at accept
- **ruling accept <id>** (--revision, --attribution, --date, --branch?, --client-task-id?, --format?, --commit?) - Accept a proposed ruling: records a claim of authority and cites it from every --for item in one transaction. --revision is the digest of what was reviewed, not proof of who approved
- **ruling withdraw <id>** (--reason?, --client-task-id?, --format?, --commit?) - Withdraw a proposed ruling; proposed records only, an accepted ruling is superseded instead
- **duet spawn** (--name?, --pen?, --bounds?, --arrangement?, --model?, --dir?, --role?, --permission-mode?, --terminal?, --auto-load?, --pen-task-id?, --print?, --recover?, --format?) - Start a visible duet worker session from the pen (N-131, T-530): mints the worker's task id, creates the arrangement and starts coordination (--arrangement auto, the default for a Claude pen; needs --bounds), writes the role with the handshake facts under .story/spawn/ and opens the window with /story as its first prompt, so the worker sends the nonce to the pen itself. Permission mode defaults to auto, inheriting bypassPermissions only when the pen itself runs in bypass; --model defaults to opus (the hands tier). A --dir with no .story is launched against the pen's board (STORYBLOQ_PROJECT_ROOT). Requirements are conditional: --name and --pen for any launch or --print; --bounds for the automatic arrangement (the default for a Claude pen with a task id); none of them for --recover, which lists interrupted spawns read-only
- **arrangement compact <id>** (--client-task-id?, --format?, --commit?) - Compact a duet arrangement's coordination checkpoint: resolved assignments keep their last event, overflow moves to an archive list. Pen only
- **arrangement rotate <id>** (--client-task-id?, --format?, --commit?) - Close a duet arrangement at capacity and carry its open assignments, verified session and earmarks into a fresh successor. Pen only
- **arrangement rebind <id>** (--role, --to, --client?, --evidence, --client-task-id?, --format?, --commit?) - Owner-authorized succession: a successor with one party replaced carries the checkpoint and earmarks, never the nonce, receipts or session; the original is closed. An attributed claim; liveness is machine-local
- **validate** (--integrity-only?, --format?) - Reference, schema, source-provenance, and loader-independent JSON checks
- **snapshot** (--quiet?, --format?, --commit?) - Save current project state for session diffs
- **recap** (--format?) - Session diff: changes since last snapshot + suggested actions
- **export** (--phase?, --all?, --format?) - Self-contained project document for sharing
- **recommend** (--format?, --count?, --with-actionability?) - Context-aware work suggestions
- **reference** (--format?) - Print CLI command and MCP tool reference
- **selftest** (--format?) - Run integration smoke test: create/update/delete cycle across all entity types
- **health** (--only?, --refresh?, --format?) - Check the tooling around this project: auto-compact window, CLI version, Codex review bridge (launched and answered, not just registered), /story skill, cross-session messaging, duplicate hook rows. --format json is the shared {version, data} envelope with the result under data; --raw unwraps it
- **codex-review <kind>** (--session, --format?) - Run native Codex plan or code review for an autonomous session
- **session intel-start** (--client?) - Capture the auto-compact setting for the current process era (SessionStart hook)
- **session intel-prompt** (--client?) - Sample context pressure and emit additionalContext at imperative pressure (UserPromptSubmit hook)
- **session intel** (--session-id?, --transcript?, --caller-model?, --full?, --client-task-id?, --format?) - Context usage, expected auto-compaction point with provenance, pressure state (ok/advisory/imperative/compact-needed), session facts. Works without .story/. --transcript must be ~/.claude/projects/<project>/<sessionId>.jsonl (a regular file, not a symlink); a refusal names the rule that failed
- **setup** (--client?, --skip-hooks?, --skip-skill?) - Install Storybloq skill, MCP, and hooks for Claude, Codex, or both
- **setup-skill** (--skip-hooks?) - Compatibility alias for `storybloq setup --client claude`
- **update** (--client?) - Install the newest storybloq into the running Node's prefix, re-run setup for your AI clients, and say when to restart (on Windows it prints the two manual steps instead)
- **reconcile** (--dry-run?, --ci?, --rebalance-ranks?, --format?) - Detect and fix duplicate displayIds across all entity types
- **conflicts list** (--format?) - List all items with unresolved merge conflicts
- **conflicts show <id>** (--format?) - Show field-level conflict detail for an item
- **resolve <target>** (--field?, --use?, --value?, --id?, --group?, --invariant?, --rename?, --drop-alias?, --keep?, --format?) - Resolve merge conflicts on a .story/ item
- **merge-driver <ancestor> <ours> <theirs> <pathname>** (--protocol?) | **merge-driver** (--protocol?, --capabilities) - Git merge driver for .story/ JSON files (registered via team setup)
- **team init** (--claim-staleness-hours?, --id-allocator?, --format?) - Enable team mode on this project
- **team setup** (--format?) - Install the git merge driver and .gitattributes for team mode
- **team doctor** (--ci?, --format?) - Run team health checks on the project
- **team reserve <type>** (--count?, --format?) - Reserve display IDs via remote git refs
- **gc** (--apply?, --force?, --retention-days?, --format?) - Remove tombstoned files past retention period
- **repair** (--dry-run?, --canonicalize-refs?) - Fix stale references in .story/ data
- **migrate** (--dry-run?, --format?) - Migrate config schema to the latest version
- **dispatch [ids..]** (--format?, --recommend?, --all?, --count?, --yes?, --dry-run?) - Dispatch work to Agent View background sessions
- **bus init** (--format?) - Low-level initializer: enable the local Storybloq Bus v2 for this project (prefer `storybloq bus setup`). Initializes a fresh v2 runtime only; if a v1 runtime is present it refuses with `upgrade_required` and directs you to `storybloq bus setup`, which resolves this task's identity and runs the guided drain/upgrade.
- **bus setup** (--client?, --task-id?, --surface?, --delivery?, --wake?, --session-name?, --transport-address?, --replace?, --force-archive?, --format?) - Connect this task to the Storybloq Bus in one idempotent, resumable command. Initializes or upgrades the runtime, joins this task's endpoint, and (when hook delivery is enabled) enables this client's guarded on-boundary hooks. With one endpoint it ends with a handoff line inviting the other task to connect. --replace <endpoint-id> retires a proven-offline incumbent and takes its place, redelivering that endpoint's undelivered mail to this successor. --force-archive overrides unread noncritical v1 delivery only during a v1->v2 upgrade; it never bypasses ship-gate blockers (unacknowledged critical messages, parked unresolved critical threads, quarantined threads).
- **bus auto-attach <state>** (--client?, --task-id?, --surface?, --force-archive?, --format?) - Turn per-session Bus auto-attach on or off for this project (opt-in, default off). `on` runs the full `bus setup` bootstrap once (initializing the runtime, joining this task, and installing the global client hooks) and sets the opt-in flag; thereafter every new session auto-attaches at SessionStart with its on-boundary delivery tiers enabled, no command, and a session that finds a proven-dead peer reclaims its slot and inherits its undelivered mail. `off` clears the flag and leaves the runtime and existing endpoints in place.
- **bus join [legacy-role]** (--client?, --task-id?, --surface?, --replace?, --format?) - Deprecated: roles are now per-message, so the legacy role argument is ignored. Use `storybloq bus setup`.
- **bus leave** (--endpoint?, --client?, --task-id?, --format?) - Retire the Bus endpoint owned by this task
- **bus endpoint retire <endpoint-id>** (--force, --reason, --format?) - Force-retire an endpoint with unknown liveness
- **bus send** (--endpoint?, --client?, --task-id?, --thread?, --thread-kind?, --predecessor-thread?, --to?, --kind, --severity?, --body, --idempotency-key, --in-reply-to?, --issue?, --ticket?, --commit?, --ci-run?, --file?, --format?) - Create a Bus thread or send a reply. Routing always targets the sole peer; `--to` is deprecated and ignored.
- **bus poll** (--endpoint?, --client?, --task-id?, --limit?, --wait?, --timeout?, --format?) - Poll unacknowledged messages for the task-bound endpoint. --limit bounds how many messages are returned (applies to the wait drain too). With --wait, block until a message arrives or --timeout elapses (v2 only), then exit: 0 = message delivered, 4 = timed out, 5 = another --wait already owns this endpoint.
- **bus ack <message-id>** (--endpoint?, --client?, --task-id?, --disposition, --reason?, --format?) - Record delivery disposition for one Bus message
- **bus status** (--format?) - Show concise Bus runtime state
- **bus doctor** (--format?) - Validate Bus storage, endpoint, and mailbox integrity
- **bus check** (--ship, --format?) - Run the critical Bus release gate
- **bus export <thread-id>** (--format?) - Explicitly export one Bus transcript
- **node add <name>** (--path, --stack?, --role?, --kind?, --summary?, --depends-on?, --link?, --format?, --commit?) - Add a federation node to an orchestrator project
- **node link [orchestrator]** (--format?, --commit?) - Record which orchestrator this project belongs to (run from the node)
- **node update <name>** (--path?, --stack?, --role?, --kind?, --summary?, --clear-depends-on?, --clear-links?, --depends-on?, --link?, --format?, --commit?) - Update a federation node's metadata
- **node remove <name>** (--force?, --prune?, --format?, --commit?) - Remove a federation node from an orchestrator project
- **arrangement coordinate <id>** (--json, --client-task-id?, --format?, --commit?) - Record a pen-owned duet coordination operation
- **arrangement list** (--lifecycle?, --format?) - List arrangements
- **arrangement get <id>** (--format?) - Get an arrangement
- **arrangement create** (--unreachability-irreversible, --unreachability-reversible?, --bounds?, --party?, --format?, --commit?) - Create a new arrangement
- **arrangement update <id>** (--lifecycle?, --format?, --commit?) - Update an arrangement
- **bus endpoint list** (--format?) - List endpoints with their wake configuration and last wake outcome
- **bus hooks enable** (--client?, --format?) - Opt this project into guarded SessionStart and Stop delivery
- **bus hooks disable** (--client?, --format?) - Disable guarded Bus hook delivery for this project
- **bus redeliver** (--endpoint?, --client?, --task-id?, --predecessor-thread, --refused-entry-hash, --format?) - Redeliver a hop-cap-parked, never-dropped Bus message onto a fresh successor thread
- **bus thread show <thread-id>** (--endpoint?, --client?, --task-id?, --format?) - Show an integrity-verified participant thread
- **bus thread update <thread-id>** (--endpoint?, --client?, --task-id?, --action, --reason?, --resolution?, --commit?, --ci-run?, --format?) - Park, resolve, or reopen a participant thread
- **config set-overrides** (--json?, --clear?, --deep?, --format?, --commit?) - Set or clear recipe overrides in config.json
- **config set-federation** (--allow-node-writes?, --format?, --commit?) - Set federation settings (orchestrator only)
- **earmark get <ref>** (--format?, --node?) - Get the earmark on a ticket or issue
- **earmark reserve <ref>** (--role, --arrangement?, --format?, --node?, --commit?) - Reserve a ticket or issue for a role, pending pickup
- **earmark assign <ref>** (--to, --role, --arrangement?, --format?, --node?, --commit?) - Assign a ticket or issue's earmark directly to a live session (direct placement, or an explicit reserved -> assigned conversion)
- **earmark release <ref>** (--arrangement?, --format?, --node?, --commit?) - Release (clear) a ticket or issue's earmark
- **feedback list** (--category?, --format?) - List community feedback
- **feedback create** (--title, --category?, --body?) - Create new feedback (opens browser)
- **feedback vote <number>** - Vote on feedback (opens browser)
- **gate-ack list** (--arrangement?, --ticket?, --format?) - List gate-acks
- **gate-ack get <id>** (--format?) - Get a gate-ack
- **gate-ack create** (--arrangement, --gate, --ticket, --plan-file?, --from-staged?, --codex-session-id?, --verdict?, --rounds?, --deltas?, --format?, --commit?) - Create a gate-ack
- **gate-ack contest <id>** (--reason, --format?, --commit?) - Mark a gate-ack contested (record + surfaced flag only)
- **landings** (--since?, --limit?, --format?) - Commits that touched tickets/issues, with review coverage (CLI-only; no MCP tool)
- **node list** (--format?) - List configured nodes
- **review-stats** (--fleet?, --open-window?, --close-window?, --contract?, --format?) - Review efficiency metrics over review verdict artifacts
- **session compact-prepare** (--client?) - Prepare session for compaction (PreCompact hook)
- **session resume-prompt** (--codex-hook-json?) - Output resume instruction after compaction (SessionStart hook)
- **session clear-compact [sessionId]** (--force?) - Clear stale compact marker (admin)
- **session stop [sessionId]** - Stop an active session (admin)
- **session list** (--status?, --format?) - List sessions on disk (admin)
- **session show <sessionId>** (--format?, --events?) - Show details of a session (admin)
- **session repair [sessionId]** (--dry-run?, --all?, --yes?) - Supersede orphaned sessions (admin)
- **session delete <sessionId>** (--yes?) - Delete a session directory (admin, destructive)
- **session health [sessionId]** - Derive and display session health state
- **session watch [sessionId]** (--events?, --quiet?) - Stream session health state changes
- **session milestone <kind>** (--gate-name?, --note?, --client-task-id?, --format?) - Report a self-described work milestone for presence display (duet/arrangement sessions)
- **roster start** (--stdin?, --client-task-id?, --agent-id?, --session-id?, --description?, --format?) - Start (or restart) a seat on the roster: a session or one of its subagents. JSON envelope; no_project outside a ledger
- **roster heartbeat** (--stdin?, --client-task-id?, --agent-id?, --generation, --format?) - Refresh a running seat's lastSeenAt; --generation from the start result is required
- **roster end** (--stdin?, --client-task-id?, --agent-id?, --generation, --state, --format?) - End a seat with a terminal state (completed/failed/killed/detached); --generation required
- **roster list** (--all?, --format?) - List seats (Bus endpoints merged): running by default, every seat including terminal ones with --all
- **team config show** (--format?) - Show current team configuration
- **team config set <key> <value>** (--format?) - Set a team configuration value
- **ticket move <id>** (--after?, --before?, --format?, --commit?) - Move a ticket relative to another (fractional rank)
- **ticket unclaim <id>** (--format?, --commit?) - Remove claim from a ticket
- **ticket start <id>** (--force?, --format?, --commit?) - Claim a ticket and set status to inprogress

## MCP Tools

The base tools below are registered in full mode (inside a .story/ project). The storybloq_bus_* tools are always registered in full mode; when the Bus is disabled or uninitialized they return setup guidance pointing at `storybloq bus setup`, with no MCP restart required.

Arguments marked ? are optional in the registered schema; handlers may require combinations depending on the action. Use the client’s tool schema for types and constraints.

- **storybloq_status** (format?, clientTaskId?, compact?) - Project summary; markdown default, JSON includes session ownership/leases. clientTaskId enriches this session's arrangementPresence/ownerIdentity; omit to inherit environment identity. compact always returns reduced JSON: see CLI status for retained/dropped fields.
- **storybloq_roster_get** (format?, all?) - Seat roster: live sessions and subagents (Bus endpoints merged) with live/stale/terminal counts; terminal seats hidden unless all. Read-only; writes are CLI-only.
- **storybloq_phase_list** - All phases with derived status
- **storybloq_phase_current** - First non-complete phase
- **storybloq_phase_tickets** (phaseId, node?) - Leaf tickets for a specific phase
- **storybloq_ticket_list** (status?, phase?, type?, node?) - List leaf tickets with optional filters
- **storybloq_ticket_get** (id, format?, withActionability?, node?) - Get a ticket by ID
- **storybloq_ticket_meta_get** (id, path?) - Get custom passthrough metadata from a ticket
- **storybloq_ticket_next** (count?, node?) - Highest-priority unblocked ticket(s)
- **storybloq_ticket_blocked** (node?) - All blocked tickets with dependencies
- **storybloq_issue_list** (status?, severity?, component?, phase?, node?) - List issues with optional filters
- **storybloq_issue_get** (id, format?, withActionability?, node?) - Get an issue by ID
- **storybloq_issue_meta_get** (id, path?) - Get custom passthrough metadata from an issue
- **storybloq_handover_list** - List handover filenames (newest first)
- **storybloq_handover_latest** (count?, brief?, priming?, format?) - Content of most recent handover
- **storybloq_handover_get** (filename, format?) - Content of a specific handover
- **storybloq_handover_create** (content, slug?, commit?) - Create a handover from markdown content
- **storybloq_blocker_list** - All roadmap blockers with status
- **storybloq_validate** (format?, integrityOnly?) - Reference, schema, source-provenance, and loader-independent JSON checks
- **storybloq_recap** - Session diff: changes since last snapshot
- **storybloq_recommend** (count?, node?) - Context-aware ranked work suggestions
- **storybloq_snapshot** (commit?) - Save current project state snapshot
- **storybloq_export** (phase?, all?) - Self-contained project document
- **storybloq_note_list** (status?, tag?) - List notes
- **storybloq_note_get** (id) - Get note by ID
- **storybloq_note_create** (content, title?, tags?, commit?) - Create note
- **storybloq_note_update** (id, content?, mode?, confirmReplace?, title?, tags?, status?, commit?) - Update note
- **storybloq_ticket_create** (title, type, phase?, description?, blockedBy?, parentTicket?, citesRuling?, node?, commit?) - Create ticket
- **storybloq_ticket_update** (id, status?, title?, type?, order?, description?, phase?, parentTicket?, blockedBy?, crossNodeBlockedBy?, force?, citesRuling?, clearCitesRulings?, node?, commit?) - Update ticket
- **storybloq_ticket_meta_set** (id, path, value?, commit?) - Set custom passthrough metadata on a ticket
- **storybloq_ticket_meta_unset** (id, path, commit?) - Unset custom passthrough metadata from a ticket
- **storybloq_issue_create** (title, severity, impact, components?, relatedTickets?, location?, sourceRefs?, dedupeKey?, createdBy?, phase?, citesRuling?, node?, commit?) - Create issue with optional persisted review provenance and retry deduplication
- **storybloq_issue_update** (id, status?, title?, severity?, impact?, resolution?, components?, relatedTickets?, location?, sourceRefs?, order?, phase?, citesRuling?, clearCitesRulings?, node?, commit?) - Update issue
- **storybloq_issue_meta_set** (id, path, value?, commit?) - Set custom passthrough metadata on an issue
- **storybloq_issue_meta_unset** (id, path, commit?) - Unset custom passthrough metadata from an issue
- **storybloq_phase_create** (id, name, label, description, summary?, after?, atStart?, commit?) - Create phase in roadmap
- **storybloq_lesson_list** (status?, tag?, source?) - List lessons
- **storybloq_lesson_get** (id) - Get lesson by ID
- **storybloq_lesson_digest** (limit?, select?) - Ranked digest of active lessons. limit/select (T-320); see CLI lesson digest.
- **storybloq_lesson_create** (title, content, context, source, tags?, supersedes?, commit?) - Create lesson
- **storybloq_lesson_update** (id, title?, content?, context?, tags?, status?, commit?) - Update lesson
- **storybloq_lesson_reinforce** (id, commit?) - Reinforce lesson: increment count and update lastValidated
- **storybloq_capability_match** (paths?, title?, phaseId?) - Find capabilities a task may already be covered by. Bounded to the inventory: no match never means no implementation exists
- **storybloq_capability_list** (status?, skipCheck?) - List the capability inventory with each entry's effective status (stored flag folded with a freshness check against HEAD)
- **storybloq_capability_get** (id, skipCheck?) - Get one capability: contract, entry points, surfaces, rulings, items and findings
- **storybloq_capability_add** (id, name, summary, entryPoints, contract, example?, cli?, mcp?, app?, files?, rulings?, items?, terms?, status?, commit?) - Add a capability; stamps the checkpoint at HEAD, recording that its entry points were read
- **storybloq_capability_update** (id, name?, summary?, entryPoints?, contract?, example?, cli?, mcp?, app?, files?, rulings?, items?, terms?, status?, commit?) - Edit a capability; supplied lists replace stored ones and the checkpoint is never touched
- **storybloq_capability_check** (stamp?, stampAll?) - Check every capability against HEAD; stamp re-records the checkpoint, refused for a structural or incomplete finding
- **storybloq_projection_write** (commit?) - Regenerate the decisions projection the Mac app reads, with a full freshness check. The status tool never writes it
- **storybloq_context_brief** (id, budget?) - The context brief for a ticket or issue: binding and suggested rulings with reasons, capabilities, terms, lessons, and what discovery could not see. Suggestions bind nothing
- **storybloq_term_match** (text) - Which glossary terms appear in a piece of text. Whole-word, case-insensitive and advisory: a match suggests a term and changes nothing
- **storybloq_term_list** (core?, thin?, digest?) - List the glossary, or its bounded names-only digest (core-first over the cap)
- **storybloq_term_get** (id) - Get one term: definition, distinction, and the capabilities and rulings behind it
- **storybloq_term_add** (id, term, definition, distinction?, aliases?, capabilities?, rulings?, core?, addedBy?, commit?) - Add a glossary term; a name another entry already owns is refused
- **storybloq_term_update** (id, term?, definition?, distinction?, aliases?, capabilities?, rulings?, core?, addedBy?, commit?) - Edit a glossary term; supplied lists replace the stored ones
- **storybloq_ruling_list** (scopeTag?, superseded?, status?) - List rulings, optionally filtered by scope tag, superseded state or lifecycle status
- **storybloq_ruling_get** (id) - Get a ruling by ID
- **storybloq_ruling_create** (text, attribution, date, scopeTags?, cites?, clientTaskId?, context?, alternatives?, consequences?, reconsiderWhen?, commit?) - Record a ruling verbatim; cites adds its id to each named ticket or issue in the same transaction; narrative fields sit beside the text
- **storybloq_ruling_supersede** (id, with?, text?, attribution?, date?, scopeTags?, branch?, clientTaskId?, context?, alternatives?, consequences?, reconsiderWhen?, commit?) - Supersede a ruling: link an existing one with `with`, or record a new superseding ruling; branch knowingly records a second successor
- **storybloq_ruling_propose** (text, attribution, date, scopeTags?, proposesToSupersede?, proposedFor?, clientTaskId?, context?, alternatives?, consequences?, reconsiderWhen?, commit?) - Propose a ruling; binds nothing until accepted, revokes nothing while proposed
- **storybloq_ruling_accept** (id, revision, attribution, date, branch?, clientTaskId?, commit?) - Accept a proposed ruling; the revision is a digest of what was reviewed, not proof of who approved
- **storybloq_ruling_withdraw** (id, reason?, clientTaskId?, commit?) - Withdraw a proposed ruling; proposed records only
- **storybloq_selftest** - Integration smoke test: create/update/delete cycle
- **storybloq_health** (format?, only?, refresh?) - Tooling check: auto-compact window, CLI version, Codex review bridge (launched and answered, not just registered), /story skill, cross-session message delivery. Works without .story/, read-only
- **storybloq_review_lenses_prepare** (stage, diff, changedFiles, ticketDescription?, reviewRound?, priorDeferrals?, sessionId?, target?) - Prepare multi-lens review on @storybloq/lenses: activation, secrets gate, context packaging, cited-ruling delivery, complete lens prompts
- **storybloq_review_lenses_synthesize** (stage?, lensResults, activeLenses, skippedLenses, reviewRound?, reviewId?, diff?, changedFiles?, sessionId?, citedRulingsUndelivered?) - Run the @storybloq/lenses merger pipeline programmatically over raw lens outputs; returns the ReviewVerdict envelope (no merger agent). Echo prepare's citedRulingsUndelivered here; without a sessionId it is the only route a delivery hold has
- **storybloq_review_lenses_judge** (reviewVerdict?, convergenceHistory?) - Deterministic three-value verdict mapping over the synthesize ReviewVerdict plus convergence history (no judge agent). Returns capReasons, coverageOnlyCap and uncoveredCoreLenses; report capReasons with the round or a coverage cap is routed like a findings cap
- **storybloq_autonomous_guide** (sessionId, action, clientTaskId?, takeover?, ownerGoneCandidateTakeover?, ownerGoneCandidateCancel?, mode?, reviewEffort?, ticketId?, targetWork?, report?) - Autonomous session orchestrator -- call at every decision point to drive PICK_TICKET through COMPLETE
- **storybloq_session_guard** (clientTaskId?) - Session ownership verdict: is anything running, and may I write? Reads only .story/sessions/, no ledger load. Also registered in degraded mode
- **storybloq_session_milestone** (kind, gateName?, note?, clientTaskId?) - Self-reported implementing/gate-hold/blocked-external/reviewing milestone on this session's presence, never a computed verdict. gate-hold requires gateName. Lock contention or write failure returns a retryable error.
- **storybloq_session_report** (sessionId) - Structured analysis of an autonomous session (works even if project state is corrupted)
- **storybloq_session_intel** (format?, sessionId?, transcript?, callerModel?, full?, clientTaskId?) - Context usage, expected auto-compaction point with provenance, pressure state (ok/advisory/imperative/compact-needed) and session facts. Works without .story/; sessionId or transcript inspects another session read-only. Also registered in degraded mode
- **storybloq_register_subprocess** (pid, cmd, category, sessionId) - Register a running subprocess so monitors can tell slow builds from hung agents
- **storybloq_unregister_subprocess** (pid, sessionId) - Unregister a subprocess after it completes (idempotent)
- **storybloq_bus_send** (endpointId, clientTaskId, threadId?, threadKind?, predecessorThreadId?, toRole?, messageKind, severity, body, refs?, inReplyTo?, idempotencyKey) - Send a task-bound advisory peer message; routes to the sole peer (toRole is deprecated, optional, and ignored)
- **storybloq_bus_redeliver** (endpointId, clientTaskId, predecessorThreadId, refusedEntryHash) - Redeliver a hop-cap-parked, never-dropped message onto a fresh successor thread; content is always the resolved refused artifact, never caller-supplied
- **storybloq_bus_poll** (endpointId, clientTaskId, limit?) - Poll a task-bound endpoint mailbox with peer-authority envelopes
- **storybloq_bus_ack** (endpointId, clientTaskId, messageId, disposition, reason?) - Record delivery disposition without resolving canonical work
- **storybloq_bus_thread_get** (endpointId, clientTaskId, threadId) - Read a participant thread's verified prefix and folded state
- **storybloq_bus_thread_update** (endpointId, clientTaskId, threadId, action, reason?, resolution?, evidence?) - Park, resolve, or evidence-reopen a participant thread
- **storybloq_node_list** - List configured federation nodes in an orchestrator project
- **storybloq_node_init** (node, type?, language?, force?, commit?) - Initialize .story/ in a federation child node from the orchestrator
- **storybloq_node_add** (name, path, stack?, role?, kind?, summary?, dependsOn?, links?, commit?) - Add a federation node to an orchestrator project's config
- **storybloq_node_update** (name, path?, stack?, role?, kind?, summary?, dependsOn?, clearDependsOn?, links?, clearLinks?, commit?) - Update a federation node's metadata (shallow-merge)
- **storybloq_arrangement_coordinate** (operation, commit?) - Record pen-observed duet coordination state; requires the current session and revision. Receipts are attributed evidence, not authentication.
- **storybloq_arrangement_get** (id, format?) - Get a duet/wave arrangement by ID
- **storybloq_arrangement_create** (bounds, parties, onIrreversibleWork, onReversibleWork?, commit?) - Create a duet/wave charter. identityAnchor must match a client task id (CLAUDE_CODE_SESSION_ID/CODEX_THREAD_ID), never a display name; it is not authentication.
- **storybloq_arrangement_update** (id, lifecycle, commit?) - Update an arrangement's lifecycle (active/suspended/closed)
- **storybloq_arrangement_rebind** (id, role, to, client?, evidence, clientTaskId?, commit?) - Owner-authorized succession into a successor with one party replaced; an attributed claim, not authentication; liveness is machine-local
- **storybloq_gate_ack_get** (id) - Get a duet-mode gate-ack record by ID
- **storybloq_gate_ack_create** (arrangement, gate, ticket, planFile?, fromStaged?, codexSessionId?, verdict?, rounds?, deltas?, commit?) - Pin acceptance of a declared plan-ack or pre-commit-ack gate. Exactly one of planFile/fromStaged is required; ackRole derives from the arrangement gate.
- **storybloq_gate_ack_contest** (id, reason, commit?) - Record a contested acknowledgment and its reason; does not reopen the workflow.
- **storybloq_checkpoint_create** (title, owner, kind, question?, criteria?, evidenceRefs?, phase?, description?, blockedBy?, parentTicket?, actor?, commit?) - Create an owner checkpoint ticket. Needs `checkpoint enable` first.
- **storybloq_checkpoint_attach** (id, owner, kind, question?, criteria?, evidenceRefs?, actor?, commit?) - Make an open, unclaimed ticket a checkpoint
- **storybloq_checkpoint_resolve** (id, generation, revision, digest, actor?, response, artifactRef?, rulingAttribution?, rulingScopeTags?, clientTaskId?, commit?) - Answer a checkpoint. An acceptance needs artifactRef.
- **storybloq_checkpoint_change** (id, generation, revision, digest, actor?, kind, question?, criteria?, evidenceRefs?, commit?) - Change what a checkpoint asks; voids its answer
- **storybloq_checkpoint_reopen** (id, generation, revision, digest, actor?, reason?, commit?) - Withdraw a checkpoint's answer
- **storybloq_checkpoint_retire** (id, generation, revision, digest, actor?, reason, commit?) - Retire a checkpoint, releasing dependents
- **storybloq_earmark_get** (ref, node?) - Get the pick-exclusion earmark (if any) on a ticket or issue
- **storybloq_earmark_reserve** (ref, role, arrangement?, clientTaskId?, node?, commit?) - Reserve an item for a duet role pending pickup. Conflicts with another earmark; arrangement is required only if several active arrangements cover the item.
- **storybloq_earmark_assign** (ref, to, role, arrangement?, clientTaskId?, node?, commit?) - Place or convert an earmark to a live session matching the arrangement role. Reserved-to-assigned conversion requires the reserver or the arrangement pen.
- **storybloq_earmark_release** (ref, arrangement?, clientTaskId?, node?, commit?) - Release an earmark as its reserver or the pen of its authorizing arrangement; no-op when absent.

### MCP Tools (degraded mode)

With no .story/ project on the path, the MCP server starts degraded and registers only:

- **storybloq_session_guard** (clientTaskId?) -- the ownership verdict, available here because the no-project case is exactly where the skill runs its Step 0.5 guard first (T-446)
- **storybloq_session_intel** (format?, sessionId?, transcript?, callerModel?, full?, clientTaskId?) -- context usage and session facts without a project
- **storybloq_health** (format?, only?, refresh?) -- read-only tooling checks without a project
- **storybloq_init** (name, type?, language?) -- bootstrap a .story/ project, then dynamically register the full tool set
- **storybloq_status** (format?) -- returns setup guidance instead of a project summary

Destructive, admin, and git-integration workflows (delete, reconcile, conflicts, resolve, merge-driver, team, gc, repair, config, feedback) are CLI-only in both modes; see the CLI Commands section above.

## Review verdict artifacts

Review JSON lives in `.story/sessions/<sessionId>/telemetry/reviews/<target>-<stage>-r<round>.json`. Generations above the first append `-g<generation>` before `.json`, preserving the `*-code-r*.json` glob. Generation also appears in the payload. Redirects and plan-review rejects restart round numbering; old artifacts may mix pre-generation rounds whose colliding files were silently dropped.

### Joining a round to what produced it

`backendRunIdKind` defines the scope of `backendRunId`; derive join quality from the ids rather than storing a potentially contradictory summary:

| Kind | Scope | Exact join requires |
|---|---|---|
| `codex-session` | Thread spanning turns | `backendTurnId` too |
| `agent-dispatch` | One dispatch/turn | Run id alone |
| `lens-review` | One review invocation | Run id alone |

A turn id without its parent run id joins nothing (`none`), as does a record with neither. Absence is never `exact`. `reviewAttemptId` identifies a round across state, artifact, and event sinks; deduplicate best-effort events by it. `itemAttemptId` identifies one work-item attempt across its rounds.

With `itemAttemptId`, `generation` tracks replans within that attempt: redirects advance it when numbering restarts. Without `itemAttemptId`, there was no work item; generation only prevents filename collisions among unrelated `unknown` targets. Never count those generations as attempts or replans.

### Reading absent values

Fields are optional. Missing means unrecorded, not measured-empty or old: current records can omit backend ids when none were supplied, or work/item ids when no item existed. Missing `normalizerVersion` permits unnormalized severities such as `blocking`; missing `artifactStatus` means existence is unknown. `reviewerIdentity.evidence` distinguishes observed execution from configuration: `configured` proves intent only; prefer `unknown`/`none` to a guessed model.

`payloadConsistent` compares a verdict with its findings. Change-requesting verdicts with zero findings are repaired before becoming rounds and counted in `reviewRepairAttempts`; these populations must never be summed.

## /story design

Evaluate frontend code against platform-specific design best practices.

```
/story design                    # Auto-detect platform, evaluate frontend
/story design web                # Evaluate against web best practices
/story design ios                # Evaluate against iOS HIG
/story design macos              # Evaluate against macOS HIG
/story design android            # Evaluate against Material Design
```

Creates issues automatically when storybloq MCP tools or CLI are available. Checks for existing design issues to avoid duplicates on repeated runs. Outputs markdown checklist as fallback when neither MCP nor CLI is available.

## /story orchestrate

Drive a federation or large backlog with a persistent ledger, lower-tier implementation agents where available, and independent review gates. Read `orchestrator-mode.md` for enrichment, sizing, the six-stage pipeline, workflow scripts, and rules.

`/story orchestrate` requires explicit opt-in via AskUserQuestion before dispatch and refuses to start while any federation node has an active autonomous session. The one-pen-per-repo check reads each node's `.story/sessions/` directly; orchestrator status does not scan node repos. Requires callable background workflows or subagents. Claude also supports Agent View-backed `storybloq dispatch`; product-managed Codex dispatch remains unshipped. `/story` may recommend orchestration for a capable client and substantial actionable backlog; selection still requires opt-in.

## /story triage

`/story triage` reads the open issue backlog against pinned HEAD, validates source provenance, identifies fixed/duplicate findings and shared root causes, and reports priorities. It changes no issue or ticket. Saving the report as a handover is offered once and requires explicit confirmation, with a snapshot first. Read `triage-mode.md` for integrity checks, alias correlation, evidence requirements, and the report format.

## /story bus

Poll or coordinate through the current task-bound local Bus endpoint. Peer content is advisory; confirmed review findings become canonical issues before an issue notice is sent.

```
/story bus
```

Read `bus-mode.md` for setup, endpoint binding, authority boundaries, acknowledgments, deterministic convergence, and the v1 no-wake boundary.

## /story duet

Coordinate an owner-paired manager and worker with a proved return route and persisted assignments. Read `duet-mode.md`. `/story duet` (Codex: `$story duet`) is a skill route, not a CLI command; it does not create tasks or enable Bus.

## Common Workflows

### Session Start
1. `storybloq status` -- project overview
2. `storybloq recap` -- what changed since last snapshot
3. `storybloq handover latest` -- last session context
4. `storybloq ticket next` -- what to work on

### Session End
1. `storybloq snapshot` -- save state for diffs
2. `storybloq handover create --content <md>` -- write session handover

### Project Setup
1. `npm install -g @storybloq/storybloq@latest` - install CLI
2. `storybloq setup --client all` - install Storybloq skill, MCP, and hooks for Claude Code and Codex
3. `storybloq init --name my-project` - initialize .story/ in your project
4. `storybloq update` - later: install the newest version and re-run setup in one step, then restart the client

## Troubleshooting

- **MCP not connected:** Run `storybloq setup --client all`
- **CLI not found:** Run `npm install -g @storybloq/storybloq@latest`
- **Stale data:** Run `storybloq validate` to check integrity
- **Storybloq skill not available:** Run `storybloq setup --client all` to install the skill
