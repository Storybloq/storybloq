# Storybloq local board: integration in progress

## Packaged local MCP runtime

The canonical board source lives inside the CLI's public projection boundary at `board-app/`. The workspace's `integrations/chatgpt` path is a compatibility symlink for existing private demo scripts. There is one source and one set of canonical writers.

Build the CLI from its package root with Node 22 or newer: `npm ci && npm run build`. No nested dependency installation is needed for this package build. `npm pack --ignore-scripts` includes the ready board HTML, local server, embedded fonts/logo, and bundled vendor notices. Customer runtime remains Node 20 or newer. UI libraries are build dependencies with their own correctly bundled Zod versions; they do not impose a Node 22 installation requirement on CLI users.

Install the locally built tarball with `npm install -g /path/to/storybloq-storybloq-1.16.0.tgz`. This build has not been published. For an explicit Codex MCP registration, use `codex mcp add storybloq-board -- storybloq --board-mcp`, then restart the host. The host must launch the server from each task's project directory. The server does not need an API key, tunnel, root override, Storybloq account, or Mac app. Ask to open Storybloq to invoke `storybloq_board`.

This registration is a developer verification workflow while plugin installation and UI capability checks are unfinished. It does not establish automatic UI opening or ChatGPT Work support. The package-level probe is `npm run test:board-package`; it may target an isolated installed artifact through `STORYBLOQ_TEST_PACKAGE_ROOT`.

## Local project capability proof

The built server also supports `node dist/server.js --local`. This is a development entrypoint, not the finished installation package. Launch it from the task's project directory; do not set a server working directory to the plugin installation folder. It captures that directory once, discovers within the validated Git repository/worktree boundary, and otherwise checks only the launch directory. Both project-root overrides and inherited external-node approvals are ignored in this mode.

With no ledger, Open Storybloq offers the existing skill's setup workflow. It does not initialize files itself. Open it again after setup: the server validates the complete ledger, advertises the normal board tools, and asks for one more Open to render the board. Incomplete ledgers and symbolic ledger entries cannot route a task to an ancestor project. Once bound, the server retains that project for its lifetime.

Codex CLI 0.153.4's app-server has been exercised with two simultaneous synthetic tasks: each server inherited the correct working directory, returned its own board, served the HTML resource, and saved a ticket through the canonical writer. Independent disk reads verified the intended edit and unchanged bytes in the other project. This proves runtime routing and resource delivery; it does not prove desktop rendering or automatic panel opening. ChatGPT Work has not been verified separately. The packaged local runtime has been tested separately; plugin installation and updates remain unfinished, and the Mac app is optional for the intended customer workflow.

A private MCP App backed by one local `.story` project. Its board follows the Mac app: mixed Open, In Progress and Complete columns, rich description/tag cards, parchment surfaces, serif headings and copper accents from Fabric 1.7.6. The phase rail shows completed, current and other active phases. The board shows all phases by default. Select a phase or Unphased to filter, and select that same button again to show all work. Search covers ID, title, description, type, phase name and issue components. Completion and issue-severity summaries cover the whole project. OpenAI extension metadata advertises global and conversation entrypoints. Actual availability depends on the host.

Each column starts with six cards and has independent scrolling and paging. Details open in an adjacent inspector on wide screens and below the board on narrow screens; Close or Escape returns to the selected card. The board refreshes every 30 seconds while visible, skips refresh while loading or reading details, and supports manual Refresh. Changes in a visible card's status or blocker state receive a brief highlight, respecting reduced-motion preferences. Host theme controls light and dark styling.

Typography uses Inter for body text, controls, identifiers and dates, with Fraunces for editorial headings. The original themed name-and-logo lockups and Latin font subsets are embedded into the resource with their license notices. Other characters use system font fallbacks. Production and fixture preview use the same validated local asset pack; see [asset provenance](assets/README.md). The font tokens are private to the app so host font variables do not replace its typography.

The board matches the Mac's mixed sorting: phase order, item order and canonical ID for Open/In Progress; most recent completion/resolution date first for Complete. Canonical `ProjectState` owns lifecycle, leaf tickets, completion counts, phase status and blockers. Owner checkpoints remain dependencies and count toward ticket completion, but are excluded from work cards. The first in-progress phase is current, even when an earlier phase has not started. The existing list tool is retained for compatibility; the overview tool is app-only. Phase filtering uses fixed-length opaque keys derived from the full phase ID, so long IDs remain selectable without exposing oversized identities. Full-body search stays server-local and is removed at the public page boundary.

Mac parity is tracked under T-542: board/phases (T-543), handover timeline and federation (T-544), ticket/issue editing (T-545), note viewing/editing (T-546), and running session information (T-547). All five areas are implemented locally and exercised in the connected private ChatGPT host with synthetic data on October 2, 2026. Global and conversation entrypoints, canonical ticket/issue/note saves, timeline, session records, all three federation previews and manual refresh after a local file edit passed. Sessions evidence uses simulated records, not running agent processes. T-540 remains in progress: dark host theme, actual 320px host layout, private access restrictions and the rebuilt ISS-1355 conflict comparison still need host verification. See `.story/reviews/T-540-host-run-20261002.json` and its follow-up receipt.

This integration is not published. It can be built inside a projected CLI source checkout because it imports canonical Storybloq schemas, `ProjectState` and update handlers. Additive trusted validation hooks let those same handlers enforce the plugin's revision and size limits inside their existing lock; default CLI callers retain their behavior. The generated private writer declarations come from actual handler signatures before build and typecheck. Runtime saves execute the canonical implementations.

Select a ticket or issue and choose Edit to load complete editable values. Save submits only changed fields; Cancel discards the local draft. Refresh retains drafts. Leaving an edited item asks whether to keep or discard changes. A conflict preserves inputs and offers a separate current-value comparison and explicit reload. A successful save keeps its inspector open even if the card leaves the current filter. Completed ordinary tickets have a separate confirmed Reopen action; claimed tickets and owner checkpoints cannot use it.

Notes follows the Mac's grid and most-recently-updated order. Search covers the visible ID, title, full content and tags. Active, Archived and All filters keep the same notes available across sessions. Selecting a note opens an inert Markdown preview; Edit loads complete bounded title, content, tags and status fields. Preview draft and Edit draft preserve unsaved text. Save submits only changed fields through the canonical note handler; Cancel writes nothing. Conflicts keep the draft alongside separate current values and an explicit reload choice. An acknowledged archive leaves the Active list and focuses its stable filter. Existing notes are supported; creation and deletion are outside this parity increment.

Long notes remain readable through revision-bound preview pages. The first validated page appears while the rest loads; Edit becomes available after a complete consistent preview. One bounded selected-note snapshot avoids repeated ledger parsing, with ledger file/directory stamps and the fixed root rechecked for later pages. Changes invalidate it and require a fresh guarded read; metadata walks still scale with ledger size. If a note changes between pages, the preview asks for a reload instead of combining different revisions. A content field beyond the editor limit is disabled and explained, while title, tags and status can still be changed without resubmitting the shortened content. The canonical full body and unknown fields remain in the file.

Sessions is a read-only view of existing autonomous status and interactive presence records. It shows current work, stage/substage, recorded duration, queue completion, health/review/context alerts, completed work and recorded subprocesses. Secondary timestamps, branch, session identity and token estimate provenance appear under Session details. Interactive cards show recent tool targets, recorded roles, supervision and self-reported milestones. Activity and progress calculations have shared fixture tests against the Mac models. Event records decay with time and do not establish process liveness; long-running tools, stopped processes and idle processes can have indistinguishable records. Guide context pressure and token-pressure buckets stay distinct, and a missing percentage is never estimated.

Sessions refreshes only while visible using the workspace's existing timer. Reads never overlap, a pending page click is retained, and departed-screen responses cannot overwrite a newer view. Refresh preserves open disclosures and usable keyboard focus; meaningful status/activity changes are announced once. A failed read retains visibly stale data. Missing, inactive, malformed and unsupported autonomous records have separate states, while valid interactive siblings remain available.

Timeline presents handovers newest first on the Mac app's centered vertical spine, with alternating date summaries and Unknown date last. Select a day to open its handover list in the inspector; a day with one handover opens its Markdown preview directly. Back to day preserves list paging. On narrow screens, labels share one column beside the spine and the inspector moves below it. Timeline has no phase filters or phase milestones. Summaries use bounded filename metadata; only selecting a handover loads its body.

Nodes appears for orchestrator projects. A scrollable dependency map uses fixed-size project cards, solid copper build arrows and dashed blue runtime links. Select a card to highlight its connections and follow a related project from the detail panel. Build cycles share a layer; long links route around cards. Dense graphs can reuse routing lanes, with full relationships available in the inspector. Known project information remains visible if active work cannot load. Progress and last handover information are explicitly cached; missing, invalid, stale, future and unreachable states remain visible. Refresh rereads the existing cache without scanning nodes or rewriting it. Select a node to see relationships and a paged preview of canonical active leaf tickets.

Local node previews may read configured children inside the startup project. External previews require `STORYBLOQ_APPROVED_NODE_ROOTS`, a JSON array of exact absolute project roots set by the local owner before starting the server. Root directories must be real directories. Both their declared and canonical macOS spellings are accepted; different aliases and symlink children are rejected. Graph loading never reads other project ledgers. This startup setting expands the data available to every trusted client of this private server.

## Local build and verification

Use Node 22 or newer. From `integrations/chatgpt`:

```sh
npm ci
npm run build
npm test
STORYBLOQ_PROJECT_ROOT=/absolute/path/to/project npm start
```

The final command starts a stdio MCP server. It waits for MCP messages; it does not start an HTTP website. On the shared development Mac, run dependency installs, builds and tests through the repository's `box run` lease, using an absolute Node path if the lease environment selects an older Node.

The fixture-only visual harness (`npm run preview`) also saves its bundled page to `dist/preview.html`. Run `node test/preview.mjs --build-only` under the build lease to create that page without keeping a server alive. The saved page contains in-memory demonstration data and edits; it does not connect to or write a project ledger, and is excluded from the MCP resource. Rebuild it after changing UI or fixture source.

To inspect an existing fixture build, `node test/preview.mjs --serve-built` starts the localhost-only preview without bundling. It serves only that saved page at `/` and rejects other paths.

## Connect to ChatGPT developer mode

Use [OpenAI's Secure MCP Tunnel setup](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). The tunnel supports stdio, so no inbound listener or hosted relay is required for this private prototype.

1. Build this package locally. Choose a project whose ticket, issue and note contents may be shared and edited in the target ChatGPT workspace. Every trusted client with access to that tunnel can read and edit the configured project; this server has no per-user authorization layer.
2. Obtain `tunnel-client` from the download link in [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels). Create a tunnel and associate it only with the intended Platform organization and ChatGPT workspace. Creating it requires Tunnels Read + Manage; running it requires Read + Use. ChatGPT developer-mode access is separate.
3. Set `CONTROL_PLANE_API_KEY` locally through your normal secret mechanism. Never paste the key into the repository or chat. Export `STORYBLOQ_PROJECT_ROOT` in the environment inherited by the tunnel's stdio child.
4. Configure the profile, substituting your real tunnel ID and absolute Node/server paths:

```sh
tunnel-client init --sample sample_mcp_stdio_local \
  --profile storybloq-board \
  --tunnel-id YOUR_TUNNEL_ID \
  --mcp-command "/absolute/path/to/node /absolute/path/to/integrations/chatgpt/dist/server.js"
tunnel-client doctor --profile storybloq-board --explain
tunnel-client run --profile storybloq-board
```

5. In [ChatGPT Plugins](https://chatgpt.com/plugins), use the plus button to create a developer-mode app. Choose **Tunnel** under Connection, then select the tunnel. Ask to open the Storybloq board. Verify the sidebar/conversation entrypoints, refresh, filters, keyboard navigation, and host light/dark theme.

The adapter does not need the API key; the tunnel client does. Stopping the tunnel client stops remote access. These instructions are based on the official documentation checked September 29, 2026. A successful local test does not establish successful installation in ChatGPT.

## Data and safety boundary

The server reads config, roadmap, tickets, issues, notes, handover metadata and selected bodies, plus existing federation cache, autonomous status, bounded session telemetry and interactive presence from its startup-configured project. On-demand node previews use configured local children or exact startup-approved external roots. Save and Reopen tools update only the selected ticket, issue or note through canonical locked handlers. Tools cannot choose an arbitrary path, run commands or create/delete items. Model-visible output contains the project name and counts; board rows, note pages, session information, details and editor results are carried in tool `_meta` for the UI. UI-only visibility is a host routing hint, not authorization: any trusted MCP client can call the read and write tools.

Sessions shares allowlisted work/status metadata, branch names, tool targets, roles, milestones and recorded subprocess IDs. It excludes raw logs, transcripts, owner identities, pending instructions and session intelligence. These allowlisted fields may still contain sensitive project text. Sessions does not launch, cancel or resume work, scan processes, recover journals or write runtime files.

The board shares IDs, titles, status, phase, severity, type/component tags, descriptions and issue resolution text. Notes shares titles, content, tags, status and dates. Treat those fields as potentially sensitive; field allowlisting is not secret redaction. Project text renders with text nodes, never HTML. No third-party resources or network requests are used by the UI.

The normal loader can recover transaction journals, so reads use a separate nonmutating filesystem reader with shared schemas and shared domain derivations. It rejects pending transactions, malformed items, unresolved item conflicts, duplicate canonical IDs, symbolic ledger directories/files, oversized files and detected concurrent changes. An explicit Save uses the normal canonical handler, including its transaction recovery and claim/checkpoint policies. The full-record revision and bounded source read are rechecked inside its existing lock; final serialized bytes are validated before persistence. Unknown fields and unchanged oversized bodies remain intact. The trusted local OS user remains outside this boundary. Filesystem checks do not provide a sandbox against a hostile local process that owns the files.

Editing limits: title 2,000 characters, body/impact/resolution 48,000 characters, local references 200 entries of at most 80 characters, cross-node references 200 entries of at most 256 characters. Fields already beyond these limits are disabled individually with an explanation; smaller fields remain editable without resubmitting the oversized value. Ordinary Save cannot force ticket reopening, clear another session's claim or resolve an owner checkpoint. A failed or uncertain save retains the draft and requires a reload before retrying safely.

Notes uses the same title/content limits, with up to 200 tags of 64 characters each. Lists contain at most 24 cards, 240-character content previews and six tags with an accurate remaining-tag count. Full preview pages contain at most 16,000 UTF-16 code units without splitting a surrogate pair. Later pages require the original revision. Notes contributes to the same 1 MiB file and 32 MiB aggregate ledger limits, including final canonical formatting before writes. Missing notes directories are empty; malformed, conflicted, ambiguous or unsafe note records require local repair.

Runtime limits: 256 KiB status, 16 KiB per presence record, 128-byte telemetry markers, 2 MiB aggregate input, 2,000 presence directory entries, 100 read candidates and 20 outgoing rows. Oversized source files and unsafe filesystem boundaries fail with a controlled error. Optional display text/lists are bounded with explicit shortening notices; malformed or future-version presence siblings are counted. Fixed-root, directory, file and absent-marker identities are checked around each read.

Limits: 10,000 directory entries, 1 MiB per file, 32 MiB input total, 200 phases, 20 cards per overview column (six by default), 100 rows per legacy list page, 320-character card previews, eight tags per card, 12,000 characters per board detail description, 48,000 per handover preview, 200 nodes and 2,000 relations. Timeline date and child pages have at most 50 entries; active node previews have at most 50 tickets. Clipped text has an ellipsis; clipped details are marked. Reads are best-effort snapshots; normal edits can require a refresh. Offset pagination can shift when another agent changes the ledger, and offsets clamp when a page shrinks. Errors retain the old board with a stale-data notice and disable stale row actions. Duplicate phase identities are rejected; if a phase disappears, select that same phase button again to clear the filter.

## Distribution verdict

The local stdio route and packaged runtime work without a hosted backend. Local plugin installation, UI availability, updates and public directory eligibility are separate host capabilities that still need verification. The earlier private demo tunnel is not the customer installation workflow. No public endpoint, plugin submission, account integration or credentials are created by this package.

The proposed customer connection design is tracked by T-563 in `.story/plans/chatgpt-public-connection.json`. This deferred alternative proposed linking a connector identity, pairing a Mac and approving individual projects, without an OpenAI API key or manual tunnel. This optional hosted transport would process requested project data while the local files remain canonical. Account linking, pairing, public routing and per-customer authorization are not implemented. Hosting, identity ownership and retention decisions remain open. ISS-1356 separately tracks incorrect overwrite annotations on the private edit tools; public deployment must not carry those annotations forward.

References: [MCP extension SDK](https://github.com/openai/mcp-extensions/tree/main/typescript), [plugin extensions](https://developers.openai.com/plugins/build/extensions), [public submission](https://developers.openai.com/plugins/deploy/submission).
