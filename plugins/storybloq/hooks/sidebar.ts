import { createDashboardState, type DashboardState, type ScanItem, type CachedRecord } from "./dashboard-state.js";
import { inProgressBoard, compactLineNode, paneText, panePlacement, boardLayout, rowBudget, compactBoard, narrowBoard, boardNode, headerNode, contextNode, footerNode, contextLabel } from "./dashboard-view.js";
export { contextLabel, MOD_VERSION } from "./dashboard-view.js";
import { wroteLedger } from "./ledger-write-detection.js";
import { cellWidth, truncate } from "./terminal-text.js";
import { displaySafe, statusField } from "./stage-label.js";
/**
* T-508: the ledger sidebar Mod. Draws `.story/` beside the transcript.
*
* Read-only by construction: it reads the ledger through `$.fs` and never
* writes it. The write path stays the CLI and the MCP server, as the ticket
* requires, and `claude plugin validate` prints the calls this module makes so
* a `$.fs.write` added here would show up in a list the tests compare.
*
* WHERE THE NUMBERS COME FROM. `sidebar-projection.ts`, which the repo's own
* vitest holds equal to `storybloq status --compact`. Nothing in this file
* counts anything; it reads files, caches what it read, and draws.
*
* WHY THE SCAN IS CHUNKED. The compact numbers come from the whole
* file-per-item ledger, which on a mature project is a couple of thousand
* files, and `.story/status.json` is not a projection of them (it is a session
* flag, four fields). A hook that read them all in one go would sit on the
* client's budget, so the first pass runs in chunks on `$.clock.every` and the
* pane says how many files are left. Afterwards `$.fs.stat` is the only cost
* for a file that has not changed: the cache in `$.store` is keyed by path to
* its mtime and the handful of fields the pane shows, so a later session
* starts warm and a refresh re-reads only what moved.
*
* WHY IT POLLS. Nothing tells a session that another process wrote the
* ledger: a peer session, the Mac app, a git pull and the CLI in a terminal
* all leave this Mod's events silent, so the pane used to sit on the last
* projection until this session next finished a turn (T-517). The client
* exposes no `$.fs.watch`, so the refresh is a poll on the timer that is
* already running: four `$.fs.stat` calls every two seconds, and nothing
* further unless one of those four mtimes moved.
*
* WIDTH AND PLACEMENT (ISS-1247, ISS-1251; the 2.1.277 declarations). Two
* client rules, neither ours to set. WHERE a pane sits is the renderer's: the
* fullscreen (alternate-screen) layout docks it beside the transcript from 110
* columns, the main-screen layout seats it inline above the prompt at any
* width; `e.props.placement` says which on every Pane render. WHETHER it draws
* is judged at each `$.ui.open`: an open answering the person's input (a
* prompt they entered, a command, a press) is placed at any width; one the
* plugin makes on its own waits undrawn below 144 columns (110 once asked).
* The `session.start` open is the plugin's own, so a session started narrow
* shows the one `AbovePrompt` line instead, and the person's first prompt
* re-opens the pane (`prompt.submit`), which the client then places.
*
* LAYOUT FOLLOWS PLACEMENT (ISS-1254). A docked pane is a sidebar: tall and
* never wider than 90 columns, so its three columns always stack one under
* another, whatever its width (the 1.15.4 sidebar the owner asked back after
* 1.15.5 squeezed four frames side by side at 150 columns and drew only the
* narrow board at 132). An inline pane is a strip above the prompt: the three
* columns side by side from BOARD_MIN_COLUMNS up, the narrow board below.
* A client that reports no placement gets the width rule alone, as 1.15.4
* did. Colour follows placement too (ISS-1255): the client paints a docked
* pane's background from its theme, so text there gets a colour for that
* theme; an inline pane sits on the terminal's own background, so its text
* takes the terminal's default foreground, which is the one that matches.
*
* EVENT NAMES AND `$`. Every event name is a string literal at its `on()` call
* and every call is spelled `$.noun.member(...)` inline, because the client
* reads both from this source rather than from a manifest. `client-api.ts` is
* the documentary pin the tests compare that reading against.
*/
import { logoFrame, logoLayout, LOGO_DURATION_MS } from "./storyfield-logo.js";
import { DashboardMotion } from "./dashboard-motion.js";
import type { On } from "./mod.js";
import { extractRecord, projectSidebar, type SidebarIssue, type SidebarRecord, type SidebarTicket, } from "./sidebar-projection.js";
type Options = Readonly<Record<string, string | number | boolean | readonly string[]>>;
/** The pane's id. Also the `requestId` its `ui.render` and `ui.close` carry. */
const PANE_ID = "storybloq";
const PANE_TITLE = "Storybloq";
/**
* The narrowest terminal the client will place a plugin's OWN open into, from
* the API's rule: an unasked open "waits undrawn below 144 columns (110 once
* asked)". The `session.start` open is that kind, so below this a narrow
* start has no pane and the one-line fallback draws instead; the person's
* first prompt re-opens it as an open answering their input, which is placed
* at any width (ISS-1251). 110 was the wrong floor and left 110-143 columns
* with nothing drawn at all (ISS-1235). This is not the dock width: whether
* a placed pane docks or sits inline is the renderer's call (ISS-1247).
*/
const DOCK_COLUMNS = 144;
const BAND_HINT = ", board opens at your next prompt";
const STORE_KEY = "sidebar-ledger-cache-v1";
/** Under the store's 4 MiB, with room for whatever else the plugin keeps. */
const STORE_BUDGET_BYTES = 3000000;
/** Files per tick, and the tick, so no single dispatch sits on the budget. */
const SCAN_CHUNK = 25;
const SCAN_TICK_MS = 25;
/**
* T-517: ticks between idle polls, so eighty of a 25 ms tick is two seconds.
*
* Exported because the Mod's own tests count ticks against it, and a poll
* interval they had to restate as a number would drift from this one.
*/
export const IDLE_POLL_TICKS = 80;
/**
* How many cards a column ever draws, and the line that stands for the rest.
*
* A fixed six, by the owner's ruling, and not a figure derived from
* `props.scroll.bodyRows`. The derived cap is what produced the bug the owner
* hit live: a Done column of 27 was headed 27 correctly, drew 18 rows and
* showed no tail, because the pane clips at `bodyRows` and the tail WAS drawn,
* below the cut, along with the issues and handover lines under it. Six
* bounds every column's body at seven rows whatever the pane reports, so the
* board is the same height on every terminal and nothing is silently cut. It
* was eight until the owner asked for the height back.
*
* The tail is three dots and not "+19 more": the heading already carries the
* true total, so the tail only has to say that the column goes on.
*/
const LEDGER_DIR = ".story";
const TICKETS_DIR = ".story/tickets";
const ISSUES_DIR = ".story/issues";
const HANDOVERS_DIR = ".story/handovers";
const CONFIG_PATH = ".story/config.json";
const ROADMAP_PATH = ".story/roadmap.json";
const STATUS_PATH = ".story/status.json";
/** T-537: the setup hint's action, in the Claude Code profile's command. */
export const SETUP_HINT = "Run /story to set this project up; the pane opens when it finishes.";
/** T-532: tool calls read the context fill at most this often. */
const CONTEXT_REFRESH_MS = 5000;
function forgetEverything(dashboard: DashboardState): void {
  dashboard.cache = {};
  dashboard.cacheLoaded = false;
  dashboard.projection = null;
  dashboard.project = "";
  dashboard.phases = [];
  dashboard.handoverFilenames = [];
  dashboard.queue = [];
  dashboard.idleTicks = 0;
  dashboard.polledMtimes = {};
  dashboard.scanInitializing = false;
  dashboard.scanActive = false;
  dashboard.pendingRefresh = false;
  dashboard.ticking = false;
  dashboard.timerStarted = false;
  dashboard.logoElapsed = 0;
  dashboard.logoStarted = false;
  dashboard.logoFinished = false;
  dashboard.logoTicks = 0;
  dashboard.motion = new DashboardMotion();
  dashboard.bandDrawn = false;
  dashboard.sidebarEnabled = false;
  dashboard.paneOpen = false;
  dashboard.paneDrawn = false;
  dashboard.reopenAsked = false;
  dashboard.themeLight = false;
  dashboard.paneInline = false;
  dashboard.sessionActive = false;
  forgetSession(dashboard);
  dashboard.contextPercent = null;
  dashboard.contextReadAt = null;
  dashboard.warm = false;
  dashboard.uiAvailable = true;
  dashboard.noLedger = false;
  dashboard.saidNoUi = false;
  dashboard.saidNoLedger = false;
  dashboard.saidScanFailed = false;
  dashboard.saidRootUnresolved = false;
  dashboard.initialCwd = null;
  dashboard.ledgerRoot = null;
}
function isTicketRecord(record: SidebarRecord): record is SidebarTicket {
  return record.kind === "ticket";
}
function isIssueRecord(record: SidebarRecord): record is SidebarIssue {
  return record.kind === "issue";
}
/** Rebuilds the projection from whatever the cache holds right now. */
function reproject(dashboard: DashboardState, completedScan = false): void {
  const tickets: SidebarTicket[] = [];
  const issues: SidebarIssue[] = [];
  for (const entry of Object.values(dashboard.cache)) {
    if (isTicketRecord(entry.record))
      tickets.push(entry.record);
    else if (isIssueRecord(entry.record))
      issues.push(entry.record);
  }
  dashboard.projection = projectSidebar({ project: dashboard.project, phases: dashboard.phases, tickets, issues, handoverFilenames: dashboard.handoverFilenames });
  if (completedScan)
    dashboard.motion.observe(dashboard.projection, dashboard.ledgerRoot);
}
/** The one line the narrow fallback draws, and the pane's own summary row. */
function summaryLine(dashboard: DashboardState): string {
  // Until one scan has finished (or a warm cache came out of the store) the
  // numbers are a partial read, and drawing them would be a figure that
  // changes a second later for no reason the reader can see.
  const busy = dashboard.scanActive || dashboard.scanInitializing;
  if (!dashboard.warm || dashboard.projection === null) {
    return busy
      ? `Storybloq: reading the ledger, ${dashboard.queue.length} files left`
      : "Storybloq: no ledger read yet";
  }
  // The phase in hand; failing that, why there is none: a project whose
  // every phase is complete is finished, not phaseless (ISS-1257, the
  // `complete` sample), and only a roadmap with no phases says "no phase".
  const phase = dashboard.projection.currentPhase
    ? dashboard.projection.currentPhase.name
    : dashboard.projection.phases.length > 0
      ? "all phases complete"
      : "no phase";
  const parts = [
    phase,
    `${dashboard.projection.openTickets} open`,
    `${dashboard.projection.inProgressTickets.length} in progress`,
    `${dashboard.projection.blockedTickets} blocked`,
    `${dashboard.projection.openIssues} issues`,
  ];
  if (busy)
    parts.push(`reading ${dashboard.queue.length}`);
  return `Storybloq: ${parts.join(", ")}`;
}
/**
* The band, cut to the terminal. Below the dock width it ends with what width
* the board needs, but only when the whole summary fits beside it. Reserve
* context pressure first so a long phase name cannot push it out of view.
*/
const SHORT_TERMINAL_ROWS = 24;
// The scroll host lays out the plugin tree without a bounded parent height,
// so percentage heights cannot make a flex spacer consume the dock's room.
function dockHeight(event: any): number {
  const rows = event.viewport?.rows;
  const scroll = event.props?.scroll;
  if (typeof scroll?.bodyRows === "number" && scroll.bodyRows > 0
    && scroll.contentRows > scroll.bodyRows) return scroll.bodyRows;
  return Math.max(1, (typeof rows === "number" ? rows : 40) - 6);
}

function shortTerminal(event: any): boolean {
  return typeof event.viewport?.rows === "number"
    && event.viewport.rows > 0 && event.viewport.rows <= SHORT_TERMINAL_ROWS;
}

function bandText(dashboard: DashboardState, columns: number, narrow: boolean): string {
  const context = contextLabel(dashboard.contextPercent, Math.min(columns, 20));
  const room = columns - cellWidth(context) - 2;
  if (room <= 0)
    return context;
  const summary = summaryLine(dashboard);
  const line = `${truncate(summary, room)}  ${context}`;
  const hint = narrow && cellWidth(line) + cellWidth(BAND_HINT) <= columns ? BAND_HINT : "";
  return truncate(`${line}${hint}`, columns);
}
/** config.json, roadmap.json, the handover names and the session flag. */
async function readHeader(dashboard: DashboardState, $: any): Promise<void> {
  try {
    const configText = await $.fs.read(p(dashboard, CONFIG_PATH));
    const parsed = JSON.parse(configText) as {
      project?: unknown;
    };
    dashboard.project = typeof parsed.project === "string" ? parsed.project : "";
  }
  catch {
    dashboard.project = "";
  }
  try {
    const roadmapText = await $.fs.read(p(dashboard, ROADMAP_PATH));
    const parsed = JSON.parse(roadmapText) as {
      phases?: readonly {
        id?: unknown;
        name?: unknown;
        label?: unknown;
      }[];
    };
    const found: {
      id: string;
      name: string;
      label?: string;
    }[] = [];
    for (const phase of parsed.phases ?? []) {
      if (typeof phase.id === "string") {
        found.push({ id: phase.id, name: typeof phase.name === "string" ? phase.name : phase.id, label: typeof phase.label === "string" ? phase.label : undefined });
      }
    }
    dashboard.phases = found;
  }
  catch {
    dashboard.phases = [];
  }
  try {
    const entries = await $.fs.list(p(dashboard, HANDOVERS_DIR));
    dashboard.handoverFilenames = entries
      .filter((entry: {
      kind: string;
    }) => entry.kind === "file")
      .map((entry: {
      name: string;
    }) => entry.name);
  }
  catch {
    dashboard.handoverFilenames = [];
  }
  // status.json is the session flag and, since T-531, the stage the session
  // is in; the ledger numbers do not come from it. Each stage field is kept
  // only when it is a usable string and is independent of the others, and
  // none of them is read before the flag is decided, so a malformed field
  // can neither throw past it nor change it.
  dashboard.sessionActive = false;
  forgetSession(dashboard);
  if (await $.fs.exists(p(dashboard, STATUS_PATH))) {
    try {
      const parsed = JSON.parse(await $.fs.read(p(dashboard, STATUS_PATH))) as {
        sessionActive?: unknown;
        state?: unknown;
        ticket?: unknown;
        claudeStatus?: unknown;
        observedAt?: unknown;
        currentIssue?: unknown;
      };
      dashboard.sessionActive = parsed.sessionActive === true;
      dashboard.sessionState = statusField(parsed.state);
      dashboard.sessionTicket = statusField(parsed.ticket);
      dashboard.sessionClaudeStatus = statusField(parsed.claudeStatus);
      dashboard.sessionObservedAt = statusField(parsed.observedAt);
      // T-532: an ISSUE_FIX session names its issue here, with `ticket` null.
      const issue = parsed.currentIssue;
      if (typeof issue === "object" && issue !== null && !Array.isArray(issue)) {
        const { id, displayId } = issue as { id?: unknown; displayId?: unknown };
        dashboard.sessionIssueId = statusField(id);
        dashboard.sessionIssue = statusField(displayId) ?? dashboard.sessionIssueId;
      }
    }
    catch {
      dashboard.sessionActive = false;
    }
  }
}
/** T-531: the stage fields back to unset. */
function forgetSession(dashboard: DashboardState): void {
  dashboard.sessionState = null;
  dashboard.sessionTicket = null;
  dashboard.sessionClaudeStatus = null;
  dashboard.sessionObservedAt = null;
  dashboard.sessionIssue = null;
  dashboard.sessionIssueId = null;
}
async function loadCache(dashboard: DashboardState, $: any): Promise<void> {
  if (dashboard.cacheLoaded)
    return;
  dashboard.cacheLoaded = true;
  try {
    const stored = await $.store.get(STORE_KEY);
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      dashboard.cache = stored as Record<string, CachedRecord>;
      // ISS-1306: a record cached before titles were made safe is served until
      // its file changes, so its title is cleaned here too.
      for (const entry of Object.values(dashboard.cache)) {
        const record = entry?.record as { title?: unknown } | undefined;
        if (record && typeof record.title === "string") record.title = displaySafe(record.title);
      }
      // A cache from an earlier session is enough to draw real numbers while
      // this session's scan confirms them.
      dashboard.warm = Object.keys(dashboard.cache).length > 0;
    }
  }
  catch {
    dashboard.cache = {};
  }
}
async function saveCache(dashboard: DashboardState, $: any): Promise<void> {
  const text = JSON.stringify(dashboard.cache);
  if (text.length > STORE_BUDGET_BYTES) {
    $.ui.log(`storybloq sidebar: the ledger cache is over ${STORE_BUDGET_BYTES} bytes, so it is not kept between sessions`);
    return;
  }
  try {
    await $.store.set(STORE_KEY, dashboard.cache);
  }
  catch {
    // A store that refuses costs a cold start next session, nothing more.
  }
}
/** One guarded line, once: a failing sidebar must not become a chatty one. */
function noteFailure(dashboard: DashboardState, $: any, what: string): void {
  if (dashboard.saidScanFailed)
    return;
  dashboard.saidScanFailed = true;
  try {
    $.ui.log(`storybloq sidebar: ${what}, so the pane may be behind the ledger until a later turn`);
  }
  catch {
    // A refused log is not worth a second failure.
  }
}
/**
* ONE timer for the module's life, not one per scan.
*
* `$.clock.every` runs until its `cancel()`, and a scan that registered its
* own would leave it running: two scans, two timers, every later tick paying
* for both. The callback returns at once unless a scan is actually draining.
*/
function startTimer(dashboard: DashboardState, $: any): void {
  if (dashboard.timerStarted)
    return;
  try {
    $.clock.every(SCAN_TICK_MS, () => {
      tick(dashboard, $).catch(() => {
        finalizeScan(dashboard, $, "failed");
      });
    });
  }
  catch {
    // A hook beneath may refuse the registration. Marking it started before
    // it returned would mean no later attempt is ever made, and a scan begun
    // with no timer builds a queue that nothing drains.
    noteFailure(dashboard, $, "the scan timer could not be started");
    return;
  }
  dashboard.timerStarted = true;
}
/**
* The one exit from a scan, whichever way it ended.
*
* Releasing the in-flight flags and consuming the pending refresh belong
* together: a failure path that released the flags but left the pending flag
* set would strand the request, because every later tick returns at once with
* no scan active and nothing else reads that flag. Consumed exactly once, so
* a failed scan nobody asked to repeat is not retried on its own.
*/
function finalizeScan(dashboard: DashboardState, $: any, outcome: "done" | "failed"): void {
  dashboard.scanActive = false;
  dashboard.scanInitializing = false;
  dashboard.ticking = false;
  if (outcome === "failed")
    noteFailure(dashboard, $, "a ledger scan did not finish");
  if (!dashboard.pendingRefresh)
    return;
  dashboard.pendingRefresh = false;
  requestScan(dashboard, $);
}
/**
* Asks for a scan, coalescing.
*
* A refresh asked for while one is in flight is REMEMBERED, not dropped: the
* queue the running scan is draining was listed before the write that
* prompted this call, so that write would otherwise never be listed at all.
* Many requests during one scan collapse into the single scan that follows it.
*/
/**
* Joins a pinned root to one of the ledger suffixes with exactly one
* separator.
*
* The trailing-separator trim deliberately refuses to shorten a bare drive
* root: on Windows `C:\` trimmed to `C:` stops being absolute and becomes
* drive-RELATIVE, which would reintroduce the very bug this pins down. `/`
* has the same shape and is left alone for the same reason.
*/
function joinRoot(root: string, suffix: string): string {
  const bareDriveRoot = /^[A-Za-z]:[/\\]$/.test(root);
  const trimmed = root.length > 1 && !bareDriveRoot ? root.replace(/[/\\]+$/, "") : root;
  const separated = trimmed.endsWith("/") || trimmed.endsWith("\\");
  return separated ? `${trimmed}${suffix}` : `${trimmed}/${suffix}`;
}
/**
* A ledger suffix as an absolute path under the pinned root.
*
* Every `$.fs` call that touches the ledger goes through here. The seven
* suffix constants are left exactly as they are, so the ledger-write detector
* further down, which matches command TEXT rather than filesystem paths, is
* untouched by this change.
*/
function p(dashboard: DashboardState, suffix: string): string {
  return dashboard.ledgerRoot === null ? suffix : joinRoot(dashboard.ledgerRoot, suffix);
}
/** The parent of a directory, or the directory itself once it is a root. */
function parentDir(dir: string): string {
  const cut = Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\"));
  if (cut < 0)
    return dir;
  if (cut === 0)
    return dir.slice(0, 1);
  const parent = dir.slice(0, cut);
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}
/** An errno off a rejected `$.fs` call, when the host supplied one. */
function errnoOf(error: unknown): string {
  const code = (error as {
    code?: unknown;
  } | null)?.code;
  return typeof code === "string" ? code : "";
}
/** A missing path, as opposed to one the host refused to answer for. */
function isMissing(error: unknown): boolean {
  return errnoOf(error) === "ENOENT";
}
/** How far up the walk will look before calling the question unanswerable. */
const MAX_ROOT_WALK = 64;
type RootResolution = {
  readonly kind: "pinned";
  readonly root: string;
} | {
  readonly kind: "absent";
} | {
  readonly kind: "unresolved";
  readonly reason: string;
};
/**
* Walks up from `start` for the nearest directory holding a `.story/`.
*
* Three ANSWERS, and keeping them apart is the point. "pinned" is a root.
* "absent" is a clean walk that reached the filesystem root without finding
* one, which is a project that never ran `storybloq init` and is not a
* failure. "unresolved" is the host refusing the question, which is a failure
* and must never be mistaken for the second.
*
* A ledger is `.story/config.json`, the CLI's own rule (`checkRoot` in
* src/core/project-root-shared.ts), not the bare directory (ISS-1256). A
* fresh `storybloq init` writes the config, so it still counts; a `.story/`
* with no config is a miss and the walk goes on past it. The owner's home
* directory holds one such stray (`~/.story/sessions/` from May, nothing
* else), and the bare-directory test pinned every ledgerless project under
* the home directory to it and drew an all-zero board there.
*
* The walk stops when a directory is its own parent, so a filesystem root
* cannot loop, and is bounded anyway: a bound that is never reached costs
* nothing and a walk that never ends costs the session.
*/
async function resolveLedgerRoot(dashboard: DashboardState, $: any, start: string): Promise<RootResolution> {
  // A trailing separator would make the first step ask about `/repo//.story`
  // and the second, after `parentDir` trims it, ask about the same directory
  // again. Same shape as `joinRoot`: a bare drive root keeps its separator,
  // because without it it stops being absolute.
  const bareDriveRoot = /^[A-Za-z]:[/\\]$/.test(start);
  let dir = start.length > 1 && !bareDriveRoot ? start.replace(/[/\\]+$/, "") : start;
  for (let step = 0; step < MAX_ROOT_WALK; step += 1) {
    try {
      if ((await $.fs.exists(joinRoot(dir, CONFIG_PATH))) !== false) {
        return { kind: "pinned", root: dir };
      }
    }
    catch (error) {
      const code = errnoOf(error);
      return { kind: "unresolved", reason: code === "" ? "the client refused the read" : code };
    }
    const parent = parentDir(dir);
    if (parent === dir)
      return { kind: "absent" };
    dir = parent;
  }
  return { kind: "absent" };
}
/**
* Opens the pane and reads the ledger: everything `session.start` does once
* it knows there is something to draw.
*
* Also the recovery path. A project that had no `.story/` when the session
* started gets one the moment someone runs `storybloq init`, and the pane has
* to appear then rather than at the next reload, so `turn.complete` and a
* ledger-writing `tool.call` both come back through here.
*/
async function attach(dashboard: DashboardState, $: any): Promise<void> {
  if (!dashboard.paneOpen) {
    // T-519: the pane's background is the client's. As of the 2.1.273 d.ts,
    // `PaneOpenArgs` is { id, title, focus, closeOnEscape, holdToasts, rows }
    // and the `Pane` props are read-only placement data: nothing names a
    // theme or background. `Box`/`Text` take `backgroundColor`, but that
    // fixes a colour rather than following the terminal, so none is set and
    // the tones below are chosen for the client's own pane background.
    await $.ui.open({ id: PANE_ID, title: PANE_TITLE });
    dashboard.paneOpen = true;
  }
  // The context figures belong to the window, not to the turn: they are
  // readable the moment the Mod loads into a session that has already had a
  // response. Reading them only on `turn.complete` is why the owner's header
  // was blank after a reload, with the fill only appearing a turn later.
  const read = await refreshContext(dashboard, $);
  if (read !== null) {
    dashboard.contextPercent = read.value;
    dashboard.motion.setContext(read.value, true);
  }
  dashboard.themeLight = await readThemeLight(dashboard, $);
  await readHeader(dashboard, $);
  await loadCache(dashboard, $);
  // The idle poll's baseline (T-517). Taken before the timer starts and before
  // the scan below, so the first poll compares against the ledger as it was
  // when this session read it: a write between the two is a change, not a
  // missed one. Taken after the timer, a tick could poll against an empty
  // baseline, find every path "moved" and rescan for nothing.
  dashboard.polledMtimes = await ledgerMtimes(dashboard, $);
  startTimer(dashboard, $);
  requestScan(dashboard, $);
}
/**
* The ledger was missing; is it there now? Attaches if it is.
*
* Nothing is drawn while it is absent, so this is the only way back: every
* refresh the Mod already made asks the question again, and the answer costs
* one `$.fs.exists` on a project that has no ledger to read anyway.
*/
async function attachIfLedgerArrived(dashboard: DashboardState, $: any): Promise<void> {
  // From the ORIGIN, never from the live working directory: the session may
  // have cd-ed anywhere by now, and resolving from there would either miss
  // the project's ledger or attach to an unrelated nested one.
  if (dashboard.initialCwd === null)
    return;
  const resolution = await resolveLedgerRoot(dashboard, $, dashboard.initialCwd);
  if (resolution.kind !== "pinned")
    return;
  dashboard.ledgerRoot = resolution.root;
  dashboard.noLedger = false;
  await attach(dashboard, $);
}
function requestScan(dashboard: DashboardState, $: any): void {
  if (dashboard.scanActive || dashboard.scanInitializing) {
    dashboard.pendingRefresh = true;
    return;
  }
  // The timer may still be missing because an earlier registration was
  // refused. Without it a queue would be built that nothing drains, so try
  // again here and start no scan while it is absent.
  startTimer(dashboard, $);
  if (!dashboard.timerStarted)
    return;
  beginScan(dashboard, $).catch(() => {
    // The scan is detached, so nothing else would hear this.
    finalizeScan(dashboard, $, "failed");
  });
}
/** Lists the ledger and leaves a queue for the ticker to drain. */
async function beginScan(dashboard: DashboardState, $: any): Promise<void> {
  dashboard.scanInitializing = true;
  try {
    const items: ScanItem[] = [];
    // ISS-1239: a directory that is MISSING and one the host refused to read
    // are different facts, and the purge below may only act on the first.
    // `$.fs` rejects with the OS errno, so they are separable.
    let refused = false;
    try {
      for (const entry of await $.fs.list(p(dashboard, TICKETS_DIR))) {
        if (entry.kind === "file" && entry.name.endsWith(".json")) {
          items.push({ path: `${TICKETS_DIR}/${entry.name}`, kind: "ticket" });
        }
      }
    }
    catch (error) {
      // No tickets directory: nothing to read from it.
      if (!isMissing(error))
        refused = true;
    }
    try {
      for (const entry of await $.fs.list(p(dashboard, ISSUES_DIR))) {
        if (entry.kind === "file" && entry.name.endsWith(".json")) {
          items.push({ path: `${ISSUES_DIR}/${entry.name}`, kind: "issue" });
        }
      }
    }
    catch (error) {
      // Same.
      if (!isMissing(error))
        refused = true;
    }
    // A file the ledger no longer has must leave the cache, or a deleted
    // ticket would keep being counted.
    //
    // Skipped on a refusal. Purging then would turn "I could not read this"
    // into "this was deleted" and empty the board on a transient failure,
    // which is this issue's bug wearing a different hat. Keeping a stale
    // record costs a board that is briefly behind; purging costs the board.
    // An empty scan that really is an empty ledger still clears, because that
    // path throws ENOENT and leaves `refused` false.
    if (!refused) {
      const present = new Set(items.map((item) => item.path));
      for (const path of Object.keys(dashboard.cache)) {
        if (!present.has(path))
          delete dashboard.cache[path];
      }
    }
    dashboard.queue = items;
    dashboard.scanActive = true;
    reproject(dashboard);
    $.ui.invalidate("ui.render");
  }
  finally {
    dashboard.scanInitializing = false;
  }
}
/**
* What one turn of the module's single timer does: drain an active scan, and
* once every IDLE_POLL_TICKS look for a write nothing told this session about
* (T-517).
*
* The counter lives here rather than in a second `$.clock.every`, because a
* second timer would be a second dispatch on every 25 ms tick for the life of
* the session, and the poll is a two-second thing.
*/
async function tick(dashboard: DashboardState, $: any): Promise<void> {
  // Share the existing clock. Redraw only during the short, visible intro,
  // at 20 fps. Later effects use this same timer and stop redrawing when idle.
  if (dashboard.logoStarted && !dashboard.logoFinished) {
    if (!dashboard.paneOpen || !dashboard.sidebarEnabled)
      dashboard.logoFinished = true;
    else {
      dashboard.logoElapsed += SCAN_TICK_MS;
      dashboard.logoTicks += 1;
      if (dashboard.logoElapsed >= LOGO_DURATION_MS)
        dashboard.logoFinished = true;
      if (dashboard.logoTicks % 2 === 0 || dashboard.logoFinished)
        $.ui.invalidate("ui.render");
    }
  }
  if (dashboard.motion.advance(SCAN_TICK_MS) && dashboard.sidebarEnabled && ((dashboard.paneOpen && dashboard.paneDrawn) || dashboard.bandDrawn))
    $.ui.invalidate("ui.render");
  await drainChunk(dashboard, $);
  dashboard.idleTicks += 1;
  if (dashboard.idleTicks < IDLE_POLL_TICKS)
    return;
  dashboard.idleTicks = 0;
  try {
    await pollLedger(dashboard, $);
  }
  catch {
    // The timer's catch finalizes the ACTIVE scan as failed, which a poll that
    // could not stat or read the header has no business doing: the scan is
    // unrelated to it. A failed poll costs nothing and runs again in two
    // seconds.
  }
}
/**
* The four directory mtimes the idle poll watches.
*
* Directories and not files: every CLI and MCP write lands by rename or link
* INTO a directory (project-loader's atomicWrite and atomicCreate), so a
* create, a delete and a replace all move the directory's own mtime, and four
* stats stand in for a walk of a couple of thousand files. `.story` itself is
* where roadmap.json, config.json and status.json land. An in-place edit by
* an editor moves no directory, and that case is what the turn-end rescan is
* still for.
*
* A path that cannot be stat-ed reads 0, so one that appears later moves.
*/
const POLLED_PATHS = [LEDGER_DIR, TICKETS_DIR, ISSUES_DIR, HANDOVERS_DIR] as const;
async function ledgerMtimes(dashboard: DashboardState, $: any): Promise<Record<string, number>> {
  const seen: Record<string, number> = {};
  for (const path of POLLED_PATHS) {
    try {
      const stat = await $.fs.stat(p(dashboard, path));
      seen[path] = typeof stat?.mtimeMs === "number" ? stat.mtimeMs : 0;
    }
    catch {
      seen[path] = 0;
    }
  }
  return seen;
}
/**
* Has anything moved since the last look? If so, refresh.
*
* Deliberately NOT gated on `paneOpen`, for the same reason the AbovePrompt
* line is not: below the client's dock width there is no pane and that line
* IS the sidebar, so a poll tied to the pane would leave the only thing drawn
* standing still.
*
* Deliberately NOT skipped while a scan is draining either: the running scan
* took its worklist before this write existed, so it will not see it. Asking
* mid-scan is what `requestScan`'s pending flag is for, and the rescan
* follows the one in flight instead of being dropped.
*
* Never while `noLedger`: a project with no `.story/` draws nothing at all,
* and `turn.complete` and a ledger-writing tool call already carry the one
* question worth asking there (has a ledger arrived?).
*/
async function pollLedger(dashboard: DashboardState, $: any): Promise<void> {
  if (!dashboard.uiAvailable || !dashboard.sidebarEnabled || dashboard.noLedger)
    return;
  const seen = await ledgerMtimes(dashboard, $);
  let moved = false;
  for (const path of POLLED_PATHS) {
    if (dashboard.polledMtimes[path] !== seen[path])
      moved = true;
  }
  // The whole of the idle cost: four stats and this comparison. Dropping it
  // is M-POLL-ALWAYS-RESCANS, which re-reads the ledger every two seconds
  // whether or not anyone wrote it.
  if (!moved)
    return;
  dashboard.polledMtimes = seen;
  // The header files (roadmap, config, status, the handover names) land in
  // `.story` itself, and a scan does not re-read them, so this mirrors what
  // `turn.complete` does. It runs only when something actually moved.
  await readHeader(dashboard, $);
  requestScan(dashboard, $);
}
/**
* One tick: up to SCAN_CHUNK files, each stat-ed and re-read only when its
* mtime moved. The mtime check is the whole of "updates within one prompt";
* serving the cached fields without it is the M-STALE-CACHE mutant.
*/
async function drainChunk(dashboard: DashboardState, $: any): Promise<void> {
  // The idle guard. Without it every tick after the first scan reprojects the
  // whole ledger, serializes it, writes it to the store and invalidates, for
  // as long as the session lasts.
  if (dashboard.ticking || !dashboard.scanActive)
    return;
  dashboard.ticking = true;
  let outcome: "done" | "failed" | null = null;
  try {
    let read = 0;
    while (dashboard.queue.length > 0 && read < SCAN_CHUNK) {
      const item = dashboard.queue.shift()!;
      read += 1;
      try {
        const stat = await $.fs.stat(p(dashboard, item.path));
        const cached = dashboard.cache[item.path];
        if (cached && cached.mtimeMs === stat.mtimeMs)
          continue;
        const record = extractRecord(item.kind, await $.fs.read(p(dashboard, item.path)));
        if (record === null)
          delete dashboard.cache[item.path];
        else
          dashboard.cache[item.path] = { mtimeMs: stat.mtimeMs, record };
      }
      catch (error) {
        // Keep the last valid record on transient failures; retry next scan.
        if (isMissing(error))
          delete dashboard.cache[item.path];
        else
          noteFailure(dashboard, $, "a ledger record could not be read");
      }
    }
    if (dashboard.queue.length === 0) {
      dashboard.warm = true;
      reproject(dashboard, true);
      await saveCache(dashboard, $);
      $.ui.invalidate("ui.render");
      outcome = "done";
    }
  }
  catch {
    // Whatever failed, this scan is over. Which of the two it was changes
    // only the log line: both leave through the same door.
    outcome = "failed";
  }
  if (outcome === null) {
    dashboard.ticking = false;
    return;
  }
  finalizeScan(dashboard, $, outcome);
}
/**
* The context fill from what `$.session.usage()` actually answers.
*
* `SessionContextUsage` carries `window` always, `tokens` and `percent` only
* "from the first API response of the live window": a fresh session or one
* just compacted has neither until its next response. Live, the owner's
* header stayed empty because this read `percent` alone, so the percent is
* computed from `tokens` whenever they exist, the engine's `percent` stands
* in only when they do not, and null (show an unknown reading) when there is no
* reading at all. `compactWindow` is the settings' auto-compact window, or
* null for the model's own.
*/
/** Whether a theme name is a light one: `light`, `light-daltonized`, `light-ansi`. */
function isLightTheme(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("light");
}
/**
* The client's `theme` row, as `$.config.list()` answers it (ISS-1238). A
* refused or unexpected answer keeps the dark default, never the board.
*/
async function readThemeLight(dashboard: DashboardState, $: any): Promise<boolean> {
  try {
    const rows = await $.config.list();
    const row = Array.isArray(rows) ? rows.find((r: any) => r?.key === "theme") : undefined;
    return isLightTheme(row?.value);
  }
  catch {
    return false;
  }
}
/**
* The context fill, or null, and never a rejection.
*
* The fill is telemetry on the header's right, and `$.session.usage` is a call
* a host may not have or may refuse. Unguarded in `session.start` it rejects
* AFTER the pane is opened, which takes the ledger read, the board and
* `next(e)` with it: a missing figure would cost the whole sidebar. One helper
* for all three call sites so the shape cannot drift between them.
*/
async function readContextFill($: any): Promise<number | null> {
  try {
    // Summary is local-only. The session's own threshold survives settings
    // edits and plugin reloads; reading settings here would change history.
    const usage = await $.session.usage({ breakdown: "summary" });
    const threshold = usage?.context?.breakdown?.autoCompactThreshold;
    const tokens = usage?.context?.tokens;
    if (typeof threshold === "number" && Number.isFinite(threshold) && threshold > 0
      && typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0) {
      return Math.min(100, Math.round(tokens / threshold * 100));
    }
    // Native window percent is a different measure. An unavailable or
    // disabled compaction threshold must not masquerade as pressure.
    return null;
  }
  catch {
    return null;
  }
}
/**
* T-532: a context read, and whether it is still the newest one. Every read
* takes the next sequence number and a session start takes one too, so a slow
* read that a later read or a restart has overtaken comes back null and is
* dropped: a tool call's figure from before a compaction must not replace the
* compaction's own.
*/
async function refreshContext(dashboard: DashboardState, $: any): Promise<{ value: number | null } | null> {
  const seq = ++dashboard.contextSeq;
  const value = await readContextFill($);
  return seq === dashboard.contextSeq ? { value } : null;
}
export function registerSidebar(on: On, _options: Options): void {
  const dashboard = createDashboardState();
  forgetEverything(dashboard);
  dashboard.motion = new DashboardMotion(_options["motion"] !== false, _options["changeHighlights"] !== false);
  // The pane. `ui.render` fires once per input value and again on
  // `$.ui.invalidate("ui.render")`, so this hook only draws what the refresh
  // hooks have already computed: it awaits nothing.
  (on("ui.render", ($: any, e: any, next: (e: any) => unknown) => {
    // Nothing is drawn without a ledger, pane or band: there is no pane open
    // to render into, and the band's line would be the empty board in one row.
    if (dashboard.noLedger)
      return next(e);
    if (e.component === "Pane" && e.requestId === PANE_ID) {
      if (!dashboard.paneDrawn) {
        // The band may have drawn on this same pass believing the pane
        // parked (a reload runs `register` fresh, so this flag starts false
        // while the client keeps the pane up). One redraw and it stands down.
        dashboard.paneDrawn = true;
        dashboard.reopenAsked = false;
        $.ui.invalidate("ui.render");
      }
      const elements = $.ui.resolve(e);
      const { Box, Text } = elements;
      const width: number = typeof e.props?.bodyColumns === "number" ? e.props.bodyColumns : 40;
      // The header, then one blank row: the break the owner asked for, so the
      // wordmark does not read as part of the first column heading. A single
      // space and not an empty string, because an empty Text collapses to no
      // row at all in this client and the break simply did not draw.
      if (shortTerminal(e) && panePlacement(e) !== "dock") {
        dashboard.logoFinished = true;
        return compactLineNode(dashboard, elements, width);
      }
      const placement = panePlacement(e);
      dashboard.paneInline = placement === "inline";
      const layout = boardLayout(placement, width);
      const stacked = layout === "stacked";
      // The narrow board is at most five rows and skips the blank rows, so it
      // needs no budget: it is the inline strip on a small window, where
      // every row is paid for.
      const budget = layout === "narrow" ? { body: 0, gaps: false, compact: false } : rowBudget(e, stacked);
      // Use the actual pane window: viewport.rows includes the transcript
      // and prompt and is never the available height of an inline pane.
      const bodyRows = e.props?.scroll?.bodyRows;
      const intro = typeof bodyRows === "number" && bodyRows <= 1 ? null
        : logoLayout(width, typeof bodyRows === "number" ? bodyRows - 1 : undefined, placement);
      if (!shortTerminal(e) && dashboard.motion.enabled && _options["startupLogo"] !== false && !dashboard.logoFinished && intro) {
        dashboard.logoStarted = true;
        const art = logoFrame(intro.columns, dashboard.logoElapsed);
        return Box({ flexDirection: "column", children: [
            headerNode(dashboard, elements),
            ...Array.from({ length: intro.top }, (_, index) => Text({ key: `logo-space-${index}`, children: " " })),
            ...art.map((cells, index) => Text({ key: `storyfield-${index}`, wrap: "truncate", children: [
                Text({ key: "inset", children: " ".repeat(intro.left) }),
                ...cells.map((cell, x) => Text({ key: `dot-${x}`, color: cell.color, children: cell.glyph })),
              ] })),
            contextNode(dashboard, elements, dashboard.contextPercent, width),
          ] });
      }
      if (placement === "dock" && shortTerminal(e)) {
        const body = Math.max(1, Math.min(7, dockHeight(e) - 7));
        return Box({ key: "short-sidebar", height: dockHeight(e), flexDirection: "column", children: [
          headerNode(dashboard, elements),
          Text({ children: " " }),
          inProgressBoard(dashboard, elements, width, body),
          Box({ key: "footer-space", flexGrow: 1 }),
          footerNode(dashboard, elements, dashboard.projection?.issuesBySeverity ?? { critical: 0, high: 0, medium: 0, low: 0 }, dashboard.contextPercent, width),
        ] });
      }
      const rows: unknown[] = [headerNode(dashboard, elements)];
      if (budget.gaps)
        rows.push(paneText(dashboard, Text, { key: "header-gap", children: " " }));
      if (dashboard.projection === null) {
        // Nothing to draw a board from yet: the one line that says why.
        rows.push(paneText(dashboard, Text, { children: truncate(summaryLine(dashboard), width) }));
        rows.push(contextNode(dashboard, elements, dashboard.contextPercent, width));
      }
      else if (layout === "narrow") {
        rows.push(narrowBoard(dashboard, elements, dashboard.projection.board, width));
        rows.push(Box({ key: "footer", flexDirection: "row", justifyContent: "flex-end", children: [contextNode(dashboard, elements, dashboard.contextPercent, width)] }));
      }
      else {
        rows.push(budget.compact
          ? compactBoard(dashboard, elements, dashboard.projection.board, width)
          : boardNode(dashboard, elements, dashboard.projection.board, width, stacked, budget.body));
        if (budget.gaps)
          rows.push(paneText(dashboard, Text, { key: "issues-gap", children: " " }));
        if (placement === "dock") rows.push(Box({ key: "footer-space", flexGrow: 1 }));
        rows.push(footerNode(dashboard, elements, dashboard.projection.issuesBySeverity, dashboard.contextPercent, width));
      }
      return Box({ flexDirection: "column", ...(placement === "dock" ? { height: dockHeight(e) } : {}), children: rows });
    }
    // The narrow fallback: the client leaves a plugin's pane undrawn on a
    // small terminal, so the same numbers go out as one line above the prompt.
    // Gated on the Mod being on, and deliberately NOT on the pane being OPEN:
    // below DOCK_COLUMNS the client draws no pane at all, so this line IS the
    // sidebar, and tying it to `paneOpen` would let a close of something never
    // drawn turn off the only thing that was. It IS tied to the pane having
    // been DRAWN: a pane opened narrow stays parked after a resize (ISS-1235),
    // and a wide terminal with a parked pane still has to show the numbers.
    if (e.component === "AbovePrompt" && dashboard.sidebarEnabled) {
      // Also catches a Mod reloaded during an already-running main turn.
      if (!e.props?.view?.agentId && typeof e.props?.isWorking === "boolean")
        dashboard.motion.setWorking(e.props.isWorking);
      dashboard.bandDrawn = false;
      const columns: number = typeof e.viewport?.columns === "number" ? e.viewport.columns : 0;
      const narrow = columns < DOCK_COLUMNS;
      if (shortTerminal(e)) {
        if (dashboard.paneDrawn) return next(e);
        dashboard.bandDrawn = true;
        const elements = $.ui.resolve(e);
        return compactLineNode(dashboard, elements, columns);
      }
      if (narrow) {
        dashboard.reopenAsked = false;
      }
      else if (dashboard.paneOpen && !dashboard.paneDrawn && !dashboard.reopenAsked) {
        // Wide, open, parked: ask the client to place it again. The width is
        // judged at each open (ISS-1235), so this is what a narrow-then-wide
        // session needs; once per crossing, and never for a pane the person
        // closed (`paneOpen` is false then). A refusal costs nothing: the
        // band below is still drawn on this pass.
        // Not awaited: a render never waits on an open, and the hook is sync.
        dashboard.reopenAsked = true;
        Promise.resolve()
          .then(() => {
          // Re-checked on the microtask: a close or a draw that landed in
          // between makes the ask stale, and a closed pane must stay closed.
          if (!dashboard.paneOpen || dashboard.paneDrawn)
            return;
          return $.ui.open({ id: PANE_ID, title: PANE_TITLE });
        })
          .catch(() => {
          // The band stands in; the next crossing asks again.
        });
      }
      if (columns > 0 && (narrow || !dashboard.paneDrawn)) {
        dashboard.bandDrawn = true;
        const { Text } = $.ui.resolve(e);
        // The hint only while there is no board on screen: a placed pane keeps
        // its seat when the window shrinks (inline, ISS-1247), and the band
        // under it carries the counts the narrow board leaves out (ISS-1252).
        return Text({ dimColor: true, children: bandText(dashboard, columns, narrow && !dashboard.paneDrawn) });
      }
    }
    return next(e);
    // A client without the UI events refuses this registration rather than
    // throwing at the call site; that is the "renders nothing" case, and the
    // scan admits `.catch` here and nothing else.
  }) as {
    catch: (fn: (error: unknown) => void) => void;
  }).catch(() => {
    dashboard.uiAvailable = false;
  });
  on("session.start", async ($: any, e: any, next: (e: any) => unknown) => {
    // T-532: first, before anything can return or wait. A reload fires this
    // again without re-registering: the tool-call throttle starts over, and
    // any context read still in flight from before is overtaken.
    dashboard.contextReadAt = null;
    dashboard.contextSeq += 1;
    if (!dashboard.uiAvailable) {
      if (!dashboard.saidNoUi) {
        dashboard.saidNoUi = true;
        $.ui.log("storybloq sidebar: this client has no UI render events, so the pane is not drawn");
      }
      return next(e);
    }
    // A `-p` run and the SDK draw nowhere: `surface` is null and nobody is at
    // the prompt, so there is no pane to open and no ledger worth reading for
    // a sidebar nobody will see.
    if (e.surface === null || e.isInteractive !== true)
      return next(e);
    // On, whatever happens next: the refresh hooks stay armed so the pane can
    // appear the moment a ledger does.
    dashboard.sidebarEnabled = true;
    dashboard.motion = new DashboardMotion(_options["motion"] !== false, _options["changeHighlights"] !== false);
    // ISS-1239: pin the root for the session, here and nowhere else. A reload
    // fires this event again and re-pins against the new directory, which is
    // wanted; `turn.complete` and `tool.call` must never re-resolve, which is
    // why neither of them touches these three.
    dashboard.ledgerRoot = null;
    // Said-once flags are per SESSION START, not per module load: a reload
    // fires this event again without re-registering, and leaving them set
    // would silently swallow the diagnostic the second time around.
    dashboard.saidNoLedger = false;
    dashboard.saidRootUnresolved = false;
    dashboard.initialCwd = typeof e.cwd === "string" && e.cwd.length > 0 ? e.cwd : null;
    if (dashboard.initialCwd === null) {
      // No absolute origin to address from. Falling back to relative paths
      // here is precisely the defect, so the Mod stays closed and says why
      // rather than drawing a board that empties on the first `cd`.
      dashboard.noLedger = true;
      if (!dashboard.saidNoLedger) {
        dashboard.saidNoLedger = true;
        $.ui.log("storybloq sidebar: this session start carried no working directory, so the pane stays closed");
      }
      return next(e);
    }
    const resolution = await resolveLedgerRoot(dashboard, $, dashboard.initialCwd);
    if (resolution.kind === "absent") {
      // No `.story/` means no pane, by the owner's ruling. A project that
      // never ran `storybloq init` was getting four bordered "none" columns
      // and an all-zero issues line, which is a dashboard reporting on
      // nothing; the Mod hides instead. T-537: it says how to set the
      // project up, once per session and root: a reload from the same root
      // stays quiet, a different root is told once. The command is the
      // Claude Code profile's, since this Mod runs only in Claude Code's
      // hooks runtime. The pane attaches when init finishes, through
      // `attachIfLedgerArrived`.
      dashboard.noLedger = true;
      if (!dashboard.setupHintRoots.has(dashboard.initialCwd)) {
        dashboard.setupHintRoots.add(dashboard.initialCwd);
        $.ui.log(`storybloq sidebar: no .story directory here, so the pane stays closed. ${SETUP_HINT}`);
      }
      return next(e);
    }
    if (resolution.kind === "unresolved") {
      // The host refused the walk, so there is no root to address from. An
      // earlier draft pinned the origin as a guess and carried on; that is
      // wrong, because `attachIfLedgerArrived` only runs while `noLedger` is
      // set, so guessing would lock the session to a possibly-wrong root for
      // good and disable its own recovery. Hiding costs one board until the
      // refusal lifts; the retry loop then re-walks and pins properly. What
      // is never done either way is falling back to relative addressing.
      dashboard.noLedger = true;
      if (!dashboard.saidRootUnresolved) {
        dashboard.saidRootUnresolved = true;
        $.ui.log(`storybloq sidebar: could not resolve the ledger root (${resolution.reason}), so the pane stays closed until it can be read`);
      }
      return next(e);
    }
    dashboard.ledgerRoot = resolution.root;
    dashboard.noLedger = false;
    // `session.start` fires again on a reload, and an open of an open id only
    // retitles it, but asking twice is still asking twice: `attach` asks once.
    await attach(dashboard, $);
    return next(e);
  });
  on("turn.start", ($: any, e: any, next: (e: any) => unknown) => {
    if (dashboard.uiAvailable && dashboard.sidebarEnabled && !dashboard.noLedger) {
      dashboard.motion.setWorking(true, e.turnId);
      $.ui.invalidate("ui.render");
    }
    return next(e);
  });
  // A turn is the unit the acceptance names: a `.story/` write during it shows
  // up by the next prompt.
  on("turn.complete", async ($: any, e: any, next: (e: any) => unknown) => {
    if (!dashboard.uiAvailable || !dashboard.sidebarEnabled)
      return next(e);
    dashboard.motion.finishTurn(e.turnId, e.agentId);
    $.ui.invalidate("ui.render");
    if (dashboard.noLedger) {
      await attachIfLedgerArrived(dashboard, $);
      return next(e);
    }
    const read = await refreshContext(dashboard, $);
    if (read !== null) {
      dashboard.contextPercent = read.value;
      dashboard.motion.setContext(read.value);
    }
    await readHeader(dashboard, $);
    requestScan(dashboard, $);
    return next(e);
  });
  // A ledger write inside a turn has to show up inside that turn: the owner
  // moved a ticket to in progress, waited five seconds and moved it back, and
  // the board sat on the old column the whole time because nothing asked for
  // a rescan until the turn ended. So this runs the call first and then, only
  // for a call that can have written `.story/`, requests a scan; the scan is
  // mtime-keyed, so the cost of one that changed nothing is a stat sweep.
  //
  // Filtered here rather than by an `on()` matcher on the tool name: a
  // matcher prints as `tool.call{tool=/.../}` in the client's scan, and the
  // contract test compares that list against the bare event names pinned in
  // client-api.ts, which is not this Mod's file to change.
  on("tool.call", async ($: any, e: any, next: (e: any) => unknown) => {
    const result = await next(e);
    if (dashboard.uiAvailable && dashboard.sidebarEnabled && wroteLedger(e)) {
      // `storybloq init` is a ledger write like any other, and it is the one
      // that turns a hidden Mod into a drawn one, so the no-ledger case goes
      // through the same filter rather than waiting for the turn to end.
      if (dashboard.noLedger)
        await attachIfLedgerArrived(dashboard, $);
      else
        requestScan(dashboard, $);
    }
    // T-532: the gauge inside a turn. A long turn otherwise sat on the figure
    // from its start: the owner's board read 99% while the client had long
    // since moved. At most one read per CONTEXT_REFRESH_MS of tool calls,
    // stamped before the await so calls running side by side share it, and a
    // redraw only when the figure moved.
    if (dashboard.uiAvailable && dashboard.sidebarEnabled && !dashboard.noLedger) {
      const now = Date.now();
      if (dashboard.contextReadAt === null || now - dashboard.contextReadAt >= CONTEXT_REFRESH_MS) {
        dashboard.contextReadAt = now;
        const read = await refreshContext(dashboard, $);
        if (read !== null && read.value !== dashboard.contextPercent) {
          dashboard.contextPercent = read.value;
          dashboard.motion.setContext(read.value);
          $.ui.invalidate("ui.render");
        }
      }
    }
    return result;
  });
  on("session.compact", async ($: any, e: any, next: (e: any) => unknown) => {
    if (!dashboard.uiAvailable || !dashboard.sidebarEnabled || dashboard.noLedger)
      return next(e);
    const read = await refreshContext(dashboard, $);
    if (read !== null) {
      dashboard.contextPercent = read.value;
      dashboard.motion.setContext(read.value);
    }
    $.ui.invalidate("ui.render");
    return next(e);
  });
  // The person closed the pane: there is no longer one to draw into, and a
  // later `session.start` may open it again. This does not turn the Mod off,
  // which is why it touches `paneOpen` and not `sidebarEnabled`.
  on("ui.close", ($: any, e: any, next: (e: any) => unknown) => {
    if (e.requestId === PANE_ID) {
      dashboard.paneOpen = false;
      dashboard.paneDrawn = false;
      dashboard.reopenAsked = false;
    }
    return next(e);
  });
  // The person switches theme in /config: the pane's text follows on the next
  // draw (ISS-1238). The event fires before the write, so the new value is
  // `e.value`, and any other row is not ours.
  on("config.set", ($: any, e: any, next: (e: any) => unknown) => {
    if (e?.key === "theme" && dashboard.uiAvailable && dashboard.sidebarEnabled) {
      const light = isLightTheme(e.value);
      if (light !== dashboard.themeLight) {
        dashboard.themeLight = light;
        $.ui.invalidate("ui.render");
      }
    }
    return next(e);
  });
  // The person entered a prompt (ISS-1251). An open made here answers their
  // input, which the client places at any width, where the session.start open
  // (the plugin's own) waits undrawn below 144 columns. So a pane that is
  // open but has never drawn is asked for again, once per prompt, and the
  // client seats it (inline on the main screen, docked in fullscreen). A pane
  // the person closed stays closed (`paneOpen` is false then), and a drawn
  // one is left alone. The prompt itself is never touched: `next(e)` runs
  // with `e` as it came, and the open is not awaited, so a refused or failing
  // open cannot delay the turn.
  on("prompt.submit", ($: any, e: any, next: (e: any) => unknown) => {
    if (dashboard.uiAvailable && dashboard.sidebarEnabled && !dashboard.noLedger && dashboard.paneOpen && !dashboard.paneDrawn) {
      Promise.resolve()
        .then(() => $.ui.open({ id: PANE_ID, title: PANE_TITLE }))
        .catch(() => {
        // The band stands in; the next prompt asks again.
      });
    }
    return next(e);
  });
}
