import type { DashboardState } from "./dashboard-state.js";
import type { SidebarBoardCard, SidebarProjection } from "./sidebar-projection.js";
import { graphemes, cellWidth, truncate } from "./terminal-text.js";
import { stageLabel, stageStale } from "./stage-label.js";
const COLUMN_CARD_CAP = 6;
const COLUMN_TAIL = "...";
const BOARD_COLUMNS = 3;
/** What a column with nothing in it says, rather than drawing a blank frame. */
const EMPTY_COLUMNS = {
  "board-open": { symbol: "◇", title: "Queue clear", short: "Queue clear", hint: "Add your next story." },
  "board-inprogress": { symbol: "○", title: "Ready to begin", short: "Ready to start", hint: "Start a story from Open." },
  "board-done": { symbol: "·", title: "Progress starts here", short: "Room to grow", hint: "Completed work gathers here." },
} as const;
type BoardColumnKey = keyof typeof EMPTY_COLUMNS;
/**
* The rows the pane spends on everything that is not a card: the header, the
* two blank rows around the board and the footer, and per column the heading
* box (text plus its two border rows) and the body box's two border rows.
*/
const CHROME_ROWS = 4;
const GAP_ROWS = 2;
/** Card rows per column below which the blank rows are not worth their cost. */
const GAPS_MIN_BODY = 3;
/** The card's two border rows, its heading row and the rule under it. */
const COLUMN_FRAME_ROWS = 4;
/** Each column is a bordered card, and the border costs a column each side. */
const COLUMN_BORDER = "round";
const BORDER_COLUMNS = 2;
/** The rule under a heading, and the gaps between the three columns. */
const HEADING_RULE = "\u2500";
const COLUMN_GAP = 1;
const GAP_TOTAL = COLUMN_GAP * (BOARD_COLUMNS - 1);
/**
* From this width, In progress is widened and Done narrowed by about a
* twentieth of the pane: at that size there is room to weight the board
* toward the column being worked rather than the one already finished.
*/
const WIDE_COLUMNS = 158;
const WIDE_SHIFT = 0.05;
const MIN_COLUMN_WIDTH = 12;
/**
* The severity buckets in the order the footer names them, with the colour a
* nonzero one carries and the short label it falls back to.
*/
/** What the issues line says when every bucket is empty. */
const NO_ISSUES = "issues: none";
const SEVERITY_ORDER = [
  { key: "critical", long: "critical", short: "crit", tone: "red" },
  { key: "high", long: "high", short: "high", tone: "yellow" },
  { key: "medium", long: "medium", short: "med", tone: null },
  { key: "low", long: "low", short: "low", tone: null },
] as const;
/**
* The colour an issue's id carries on a board row, by severity.
*
* The same two tones the footer already uses for the same two buckets, so one
* red on the board means what a red in the issues line means. Medium and low
* carry none: a column where every row is coloured marks nothing.
*/
const SEVERITY_TONES: Readonly<Record<string, string>> = { critical: "red", high: "yellow" };
/**
* How each column's heading is drawn.
*
* One column is emphasised and it is the one that says what is happening
* now: In progress, bold and cyan. Open is plain, being the resting state and the
* column a reader lands on most; Done recedes, since finished work is
* reference rather than news. Counts use a quieter weight inside each heading.
*/
const COLUMN_STYLES = {
  open: {},
  inProgress: { color: "cyan", bold: true },
  done: { dimColor: true },
} as const;
/**
* Cells kept clear to the right of the pane's own rows.
*
* The engine draws its close mark in the last cell of the pane, and the
* context fill was right-aligned straight into it: live it read "context 7%×",
* with the mark looking like part of our string. `BoxProps` carries
* `marginRight`, so the row simply stops short of the edge. The fill now sits
* at the foot rather than the head, and keeps the clearance there.
*/
const PANE_EDGE_CLEARANCE = 3;
/**
* Narrower than this and three columns are shredded rather than laid out, so
* the pane draws the narrow board instead (ISS-1252): the work in hand and
* the footer, nothing else. A placed pane keeps its seat when the window
* shrinks (inline on the main screen, docked in fullscreen), so this is the
* in-between case: a pane that exists but is too narrow to be a board.
*/
const BOARD_MIN_COLUMNS = 60;
/** Cards the narrow board shows before it says how many more there are. */
const NARROW_BOARD_CARDS = 3;
/** The ledger directory itself, which is what says a project HAS a ledger. */
export function paneText(dashboard: DashboardState, Text: (props: Record<string, unknown>) => unknown, props: Record<string, unknown>): unknown {
  // Inline, the pane is on the terminal's own background and the default
  // foreground is the one that matches it (ISS-1255); only the dock is painted.
  if (dashboard.paneInline)
    return Text(props);
  return Text({ color: dashboard.themeLight ? "black" : "white", ...props });
}
type PanePlacement = "dock" | "inline";
export function panePlacement(e: any): PanePlacement | null {
  const value: unknown = e?.props?.placement;
  return value === "dock" || value === "inline" ? value : null;
}
/**
* The board's shape (ISS-1254): `stacked` is the three framed columns one
* under another, the sidebar; `columns` is the three side by side; `narrow`
* is the In progress strip. Docked, always stacked. Inline, side by side
* from BOARD_MIN_COLUMNS up and the strip below it. No placement reported,
* the width alone decides between stacked and side by side, as 1.15.4 did.
*/
type BoardLayout = "stacked" | "columns" | "narrow";
export function boardLayout(placement: PanePlacement | null, width: number): BoardLayout {
  if (placement === "dock")
    return "stacked";
  if (width >= BOARD_MIN_COLUMNS)
    return "columns";
  return placement === "inline" ? "narrow" : "stacked";
}
/**
* How many card rows each column may draw, and whether the pane can afford
* the blank rows around the board at all.
*
* The pane clips what will not fit, silently, so the budget is counted out
* before anything is drawn:
*
*   header 1, header gap 1, footer gap 1, footer 1   = 4 chrome rows
*   the card's border, above and below              = 2
*   its heading row and the rule under it           = 2
*
* Side by side the three columns are parallel, so one column's four frame rows
* are the board's; stacked they run one after another, so the frames cost
* three times that and the rows left over are shared between them. The blank
* rows go before the cards do, because a board with one card in it still says
* something and a gap says nothing. When even three framed headings will not
* fit, the board falls back to one plain counted row per column, which is the
* smallest thing that is still the board.
*
* What comes back is the rows one BODY may draw, tail included; the board
* decides how many of those are cards once it knows whether anything was left
* out.
*
* WHY `bodyRows` IS NOT THE ROOM. The owner reloaded a 213 column, 61 row
* terminal and got the compact fallback where the build before drew eight
* cards a column. `scroll.bodyRows` is not the height the surface has for us:
* `SiteScroll` is "where a site's window sits over THE TREE A HOOK DREW in
* it", and `ui.scroll` spells the same field "how many rows of the tree the
* window shows at once, AS DRAWN NOW", with `contentRows` beside it and
* "the window's last offset is `contentRows - bodyRows`, none when the tree
* fits". A tree that fits is its own window, so `bodyRows` is the height of
* what we last drew. Reading it as a cap is a ratchet: one short board makes
* the next budget shorter, the compact fallback draws six rows, and the pane
* reports six rows for ever after.
*
* So the field is allowed to PROVE room and never to deny it. The cap comes
* from `viewport.rows`, which is the whole surface and so an honest upper
* bound on the pane ("cells down the whole surface, not the room left for
* this component"), and `bodyRows` only raises that. Above the rows the whole
* board needs neither matters and the layout is the one the owner had before
* any budget existed: the capped cards, a tail, and the blank rows.
*/
export function rowBudget(e: any, stacked: boolean): {
  body: number;
  gaps: boolean;
  compact: boolean;
} {
  const frames = stacked ? COLUMN_FRAME_ROWS * BOARD_COLUMNS : COLUMN_FRAME_ROWS;
  const share = stacked ? BOARD_COLUMNS : 1;
  const whole = CHROME_ROWS + frames + share * (COLUMN_CARD_CAP + 1);
  const drawn: number = typeof e.props?.scroll?.bodyRows === "number" ? e.props.scroll.bodyRows : 0;
  const screen: number = typeof e.viewport?.rows === "number" ? e.viewport.rows : 0;
  const room = Math.max(drawn, screen);
  if (room <= 0 || room >= whole)
    return { body: COLUMN_CARD_CAP + 1, gaps: true, compact: false };
  // With the blank rows first, but only while they are affordable: below
  // GAPS_MIN_BODY rows of cards per column the gaps are costing more than
  // they are worth, and a board with cards in it beats a tidy empty one.
  for (const [gaps, floor] of [[true, GAPS_MIN_BODY], [false, 1]] as const) {
    const chrome = CHROME_ROWS - (gaps ? 0 : GAP_ROWS);
    const left = room - chrome - frames;
    if (left >= share * floor) {
      return { body: Math.min(COLUMN_CARD_CAP + 1, Math.floor(left / share)), gaps, compact: false };
    }
  }
  return { body: 0, gaps: false, compact: true };
}
/**
* A heading that keeps its count when the column is too narrow for both.
*
* The count is the point of the heading, so the label is what gets cut:
* "In progress 100" at fourteen cells is "In progr… 100", never
* "In progress 1…", which would quietly report a different number.
*/
function headingContent(dashboard: DashboardState, elements: any, label: string, count: number, width: number, stage: StageMark | null = null): unknown[] {
  const tail = ` ${count}`;
  const emphasis = dashboard.motion.count(label === "In progress" ? "inProgress" : label === "Done" ? "done" : "open");
  const tag = headingTag(label, count, stage, width);
  return [
    paneText(dashboard, elements.Text, { children: truncate(label, Math.max(1, width - tail.length)) }),
    paneText(dashboard, elements.Text, { dimColor: !emphasis, bold: emphasis, children: tail }),
    ...(tag === "" ? [] : [paneText(dashboard, elements.Text, { ...(stage!.stale ? { dimColor: true } : { color: "cyan" }), children: tag })]),
  ];
}
/**
* T-532: the stage after a heading, " [Code]", for a session no drawn card
* carries. Only whole, after the whole label and count: the tag is what goes
* first, so the count is never cut to make room for it. Empty otherwise.
*/
function headingTag(label: string, count: number, stage: StageMark | null, width: number): string {
  if (stage === null || stage.key !== null)
    return "";
  const tag = ` ${stage.text.trimEnd()}`;
  return cellWidth(label) + cellWidth(` ${count}`) + cellWidth(tag) <= width ? tag : "";
}
/**
* T-531: the stage an autonomous session is in and where it is drawn. `key` is
* the stable key of the drawn card that carries it, or null when no drawn card
* does and the In progress heading carries it instead (T-532); `text` is the
* card's tag with its trailing space; `stale` dims it.
*/
interface StageMark {
  readonly key: string | null;
  readonly text: string;
  readonly stale: boolean;
}
/**
* The session's stage for an In progress column that draws its first `shown`
* cards, or null when no session is active or its state did not parse.
*
* The card is resolved against the whole column first and only then asked
* whether it is drawn: a twin past the cap must still make a drawn card
* ambiguous, and a capped card must not hand its tag to a drawn look-alike.
* Unresolved, ambiguous or cut by the cap, the stage goes to the heading.
*/
function sessionStage(dashboard: DashboardState, cards: readonly SidebarBoardCard[], shown: number, now = Date.now()): StageMark | null {
  const state = dashboard.sessionState;
  if (!dashboard.sessionActive || state === null)
    return null;
  const card = sessionCard(dashboard, cards);
  const stale = stageStale(dashboard.sessionObservedAt, now);
  return {
    key: card !== null && cards.indexOf(card) < shown ? card.key : null,
    text: `[${stageLabel(state)}${stale ? "?" : ""}] `,
    stale,
  };
}
/**
* The one In progress card that is the session's item, or null.
*
* A ticket session matches ticket cards only, by display id (falling back to
* the id), and two that share it match neither: guessing would put the stage
* on work the session is not doing. An ISSUE_FIX session (T-532) carries no
* ticket and matches issue cards only: by its canonical id first, which no
* reconcile can duplicate, and by display id only when no card has that id.
*/
function sessionCard(dashboard: DashboardState, cards: readonly SidebarBoardCard[]): SidebarBoardCard | null {
  const only = (matches: readonly SidebarBoardCard[]): SidebarBoardCard | null => matches.length === 1 ? matches[0]! : null;
  const ticket = dashboard.sessionTicket;
  if (ticket !== null)
    return only(cards.filter((card) => card.kind === "ticket" && card.id === ticket));
  const issueId = dashboard.sessionIssueId;
  const byKey = issueId === null ? null : only(cards.filter((card) => card.kind === "issue" && card.key === `issue:${issueId}`));
  if (byKey !== null)
    return byKey;
  const issue = dashboard.sessionIssue;
  return issue === null ? null : only(cards.filter((card) => card.kind === "issue" && card.id === issue));
}
/**
* IDs lead in muted text; titles carry emphasis and blockers stay visible.
*
* The session's stage tag (T-531) sits after the id, ahead of any marker, and
* only when the whole id, the tag, the marker and two title cells fit: the
* title is what gets cut, and the tag goes whole before the id would be. A card
* without it draws exactly the three runs it always did.
*/
function cardRow(dashboard: DashboardState, elements: any, card: SidebarBoardCard, width: number, done = false, stage: StageMark | null = null): unknown {
  const effect = dashboard.motion.card(card.key);
  const ready = effect.ready && !card.blocked && !done;
  const blocked = card.blocked ? (width >= 32 ? "[Blocked] " : "[!] ") : ready ? (width >= 32 ? "✓ Ready " : "✓ ") : "";
  const tag = stage !== null && stage.key === card.key
    && cellWidth(card.id) + 1 + cellWidth(stage.text) + cellWidth(blocked) + 2 <= width ? stage.text : "";
  const id = truncate(card.id, Math.max(1, width - cellWidth(tag) - cellWidth(blocked) - 3));
  const room = Math.max(1, width - cellWidth(id) - cellWidth(tag) - cellWidth(blocked) - 1);
  const tone = card.kind === "issue" && card.severity !== null ? SEVERITY_TONES[card.severity] : undefined;
  return paneText(dashboard, elements.Text, {
    key: card.key,
    wrap: "truncate",
    children: [
      paneText(dashboard, elements.Text, { dimColor: true, ...(tone ? { color: tone } : {}), children: `${id} ` }),
      ...(tag === "" ? [] : [paneText(dashboard, elements.Text, { ...(stage!.stale ? { dimColor: true } : { color: "cyan" }), children: tag })]),
      paneText(dashboard, elements.Text, { ...(card.blocked ? { color: "yellow" } : { dimColor: effect.fading }), children: blocked }),
      paneText(dashboard, elements.Text, { bold: !done, dimColor: done, children: shimmerTitle(dashboard, elements, truncate(card.title, room), effect.progress) }),
    ],
  });
}
/** Preserve graphemes and cell widths while a narrow highlight crosses the text. */
function shimmerTitle(dashboard: DashboardState, elements: any, title: string, progress: number | null): unknown {
  if (progress === null)
    return title;
  const start = Math.round(progress * (cellWidth(title) + 6)) - 6;
  const runs: {
    text: string;
    highlight: boolean;
  }[] = [];
  let position = 0;
  for (const { cluster, cells } of graphemes(title)) {
    const highlight = position >= start && position < start + 6;
    const last = runs[runs.length - 1];
    if (last?.highlight === highlight)
      last.text += cluster;
    else
      runs.push({ text: cluster, highlight });
    position += cells;
  }
  return runs.map((run, index) => paneText(dashboard, elements.Text, {
    key: `shimmer-${index}`, ...(run.highlight ? { dimColor: false, bold: true, underline: true } : {}), children: run.text,
  }));
}
/**
* The rows of one column's body, every body the same height.
*
* The three bodies draw the same number of rows, so the cards end level
* instead of leaving a ragged edge: a column with fewer cards is padded with
* blanks. Empty columns use that same height for a quiet, centered invitation.
* The tail row is part of that common height, held
* back by the budget, so a capped column can say it was capped without
* standing a row taller than the rest.
*/
function bodyRowsOf(dashboard: DashboardState, elements: any, cards: readonly SidebarBoardCard[], width: number, shown: number, height: number, column: BoardColumnKey, stage: StageMark | null = null): unknown[] {
  const rows: unknown[] = [];
  if (cards.length === 0) {
    return emptyColumnRows(dashboard, elements, column, width, height);
  }
  else {
    for (const card of cards.slice(0, shown))
      rows.push(cardRow(dashboard, elements, card, width, column === "board-done", stage));
    if (cards.length > shown)
      rows.push(paneText(dashboard, elements.Text, { dimColor: true, wrap: "truncate", children: COLUMN_TAIL }));
  }
  while (rows.length < height)
    rows.push(paneText(dashboard, elements.Text, { children: " " }));
  return rows;
}
function emptyColumnRows(dashboard: DashboardState, elements: any, column: BoardColumnKey, width: number, height: number, centered = true): unknown[] {
  const state = EMPTY_COLUMNS[column];
  const title = cellWidth(`${state.symbol} ${state.title}`) <= width ? state.title : state.short;
  const lines = [`${state.symbol} ${title}`];
  if (height >= 3 && cellWidth(state.hint) <= width)
    lines.push(state.hint);
  const top = centered ? Math.floor((height - lines.length) / 2) : 0;
  return Array.from({ length: height }, (_, index) => {
    const line = truncate(lines[index - top] ?? " ", width);
    const inset = centered ? Math.max(0, Math.floor((width - cellWidth(line)) / 2)) : 0;
    return paneText(dashboard, elements.Text, {
      key: `${column}-empty-${index}`, dimColor: true, wrap: "truncate", children: " ".repeat(inset) + line,
    });
  });
}
/**
* One column: a bordered card with its heading at the top, a rule under the
* heading, and the card rows beneath.
*
* One box and not two. The heading is enclosed by the card's own top and side
* borders and the rule below it, which is the divider; two stacked bordered
* boxes drew a double line between heading and body. The rule is a Text of
* box-drawing dashes spanning the inner width, so it meets both side borders;
* it cannot render the ├ and ┤ junctions, since a child of the box cannot
* reach into the border cells the renderer owns.
*
* The count in the heading is the WHOLE column, not the rows drawn, so a
* capped column still tells the truth about the project; the tail says the
* column goes on. Titles are cut to the column's width, not the pane's.
*
* Takes the resolved element table rather than `$`: these are plain
* constructors, and the client's scan is strict about where `$` may travel.
*/
export function inProgressBoard(dashboard: DashboardState, elements: any, width: number, body: number): unknown {
  const cards = dashboard.projection?.board.inProgress ?? [];
  const shown = Math.min(COLUMN_CARD_CAP, Math.max(0, body - (cards.length > body ? 1 : 0)));
  return boardColumn(dashboard, elements, "board-inprogress", "In progress", COLUMN_STYLES.inProgress,
    cards, width, shown, Math.max(1, Math.min(body, cards.length || 2)), sessionStage(dashboard, cards, shown));
}

function boardColumn(dashboard: DashboardState, elements: any, key: BoardColumnKey, heading: string, style: Readonly<Record<string, unknown>>, cards: readonly SidebarBoardCard[], width: number, shown: number, height: number, stage: StageMark | null = null): unknown {
  // The border takes a column on each side, so the text inside has that much
  // less. Getting this wrong wraps every row and the board falls apart.
  const textWidth = Math.max(1, width - BORDER_COLUMNS);
  return elements.Box({
    key,
    flexDirection: "column",
    borderStyle: COLUMN_BORDER,
    width,
    overflow: "hidden",
    children: [
      paneText(dashboard, elements.Text, {
        key: `${key}-heading`,
        ...style,
        wrap: "truncate",
        children: headingContent(dashboard, elements, heading, cards.length, textWidth, stage),
      }),
      paneText(dashboard, elements.Text, { key: `${key}-rule`, dimColor: true, wrap: "truncate", children: HEADING_RULE.repeat(textWidth) }),
      ...bodyRowsOf(dashboard, elements, cards, textWidth, shown, height, key, stage),
    ],
  });
}
/**
* The board reduced to three counted rows, when no frame will fit. No card is
* drawn, so a session's stage rides on the In progress row.
*/
export function compactBoard(dashboard: DashboardState, elements: any, board: SidebarProjection["board"], width: number): unknown {
  const line = (key: string, label: string, style: Readonly<Record<string, unknown>>, cards: readonly SidebarBoardCard[], stage: StageMark | null = null): unknown => paneText(dashboard, elements.Text, { key, ...style, wrap: "truncate", children: headingContent(dashboard, elements, label, cards.length, width, stage) });
  return elements.Box({
    key: "board",
    flexDirection: "column",
    children: [
      line("board-open", "Open", COLUMN_STYLES.open, board.open),
      line("board-inprogress", "In progress", COLUMN_STYLES.inProgress, board.inProgress, sessionStage(dashboard, board.inProgress, 0)),
      line("board-done", "Done", COLUMN_STYLES.done, board.done),
    ],
  });
}
/**
* The narrow board (ISS-1252): below BOARD_MIN_COLUMNS the three framed
* columns stacked into a strip the person had to scroll, past a cut-off Open
* card and an empty In progress frame. Owner: "in that view we can just show
* top 3 in progress and context pressure." So this draws the work in hand
* only: the In progress heading with its count, up to NARROW_BOARD_CARDS
* cards, a tail when more exist. Open and Done keep their counts in
* the band's summary line under the pane. At most five rows, so the client's
* inline block shows it whole, without a budget.
*
* Nothing in progress and the strip shows the Open column the same way
* (ISS-1254): the owner's project had no work in hand and the strip said
* "In progress 0, none", which is a count and not the work; the next thing to
* pick up is what the strip is for then. An active session's stage (T-532)
* still gets a row there, "In progress 0 [Pick]", above Open, which gives up
* a card for it so the strip stays five rows; the Open cards never carry it.
*/
export function narrowBoard(dashboard: DashboardState, elements: any, board: SidebarProjection["board"], width: number): unknown {
  const inProgress = board.inProgress as readonly SidebarBoardCard[];
  const fallback = inProgress.length === 0;
  const cards = fallback ? (board.open as readonly SidebarBoardCard[]) : inProgress;
  const stage = sessionStage(dashboard, inProgress, NARROW_BOARD_CARDS);
  const stageRow = fallback && headingTag("In progress", 0, stage, width) !== "";
  const limit = stageRow ? NARROW_BOARD_CARDS - 1 : NARROW_BOARD_CARDS;
  const rows: unknown[] = [];
  if (stageRow) {
    rows.push(paneText(dashboard, elements.Text, {
      key: "narrow-stage-heading",
      ...COLUMN_STYLES.inProgress,
      wrap: "truncate",
      children: headingContent(dashboard, elements, "In progress", 0, width, stage),
    }));
  }
  rows.push(paneText(dashboard, elements.Text, {
    key: "narrow-heading",
    ...(fallback ? COLUMN_STYLES.open : COLUMN_STYLES.inProgress),
    wrap: "truncate",
    children: headingContent(dashboard, elements, fallback ? "Open" : "In progress", cards.length, width, fallback ? null : stage),
  }));
  if (cards.length === 0) {
    rows.push(...emptyColumnRows(dashboard, elements, fallback ? "board-open" : "board-inprogress", width, 1, false));
  }
  else {
    // The Open fallback is not work in hand, so its cards never carry the stage.
    cards.slice(0, limit).forEach((card, index) => {
      rows.push(elements.Box({ key: `narrow-card-${index}`, children: [cardRow(dashboard, elements, card, width, false, fallback ? null : stage)] }));
    });
    if (cards.length > limit) {
      rows.push(paneText(dashboard, elements.Text, {
        key: "narrow-tail",
        dimColor: true,
        wrap: "truncate",
        children: truncate(`... ${cards.length - limit} more`, width),
      }));
    }
  }
  return elements.Box({ key: "board", flexDirection: "column", children: rows });
}
/**
* The three column widths.
*
* Stacked, every card takes the pane. Side by side, the width less the two
* gaps splits three ways, the leftover cells going to Open; from WIDE_COLUMNS
* up, a twentieth of the pane moves from Done to In progress, so the board
* leans toward the work in hand. The three widths and the gaps always sum to
* the pane's width, whatever the arithmetic above did.
*/
function columnWidths(width: number, stacked: boolean): number[] {
  if (stacked)
    return [width, width, width];
  const base = Math.max(MIN_COLUMN_WIDTH, Math.floor((width - GAP_TOTAL) / BOARD_COLUMNS));
  const widths = [base, base, base];
  widths[0] = (widths[0] ?? base) + Math.max(0, width - GAP_TOTAL - base * BOARD_COLUMNS);
  if (width >= WIDE_COLUMNS) {
    const shift = Math.min(Math.round(width * WIDE_SHIFT), (widths[2] ?? base) - MIN_COLUMN_WIDTH);
    if (shift > 0) {
      widths[1] = (widths[1] ?? base) + shift;
      widths[2] = (widths[2] ?? base) - shift;
    }
  }
  return widths;
}
export function boardNode(dashboard: DashboardState, elements: any, board: SidebarProjection["board"], width: number, stacked: boolean, body: number): unknown {
  const widths = columnWidths(width, stacked);
  // Every body the same height, and that height inside the budget: as many
  // rows as the fullest column can show, one of them given up to the tail
  // when anything was left out, so a capped column says so without standing a
  // row taller than the rest.
  const columns = [board.open, board.inProgress, board.done] as const;
  const longest = Math.max(...columns.map((column) => column.length));
  // Never more than the cap, whatever the budget allows: a body of seven rows
  // is six cards and a tail, not seven cards.
  let shown = Math.min(body, longest, COLUMN_CARD_CAP);
  if (columns.some((column) => column.length > shown))
    shown = Math.max(0, Math.min(shown, body - 1));
  const omitted = columns.some((column) => column.length > shown);
  const height = Math.max(1, Math.min(body, shown + (omitted ? 1 : 0)));
  // Left to right in the order the work moves: what can be
  // picked up, what is being done, what is finished.
  return elements.Box({
    key: "board",
    flexDirection: stacked ? "column" : "row",
    gap: stacked ? 0 : COLUMN_GAP,
    children: [
      boardColumn(dashboard, elements, "board-open", "Open", COLUMN_STYLES.open, board.open, widths[0]!, shown, height),
      boardColumn(dashboard, elements, "board-inprogress", "In progress", COLUMN_STYLES.inProgress, board.inProgress, widths[1]!, shown, height, sessionStage(dashboard, board.inProgress, shown)),
      boardColumn(dashboard, elements, "board-done", "Done", COLUMN_STYLES.done, board.done, widths[2]!, shown, height),
    ],
  });
}
/**
* The header keeps identity and an animated wordmark on one row.
* Context pressure stays in the footer.
*/
/**
* The Mod's own version, drawn in the header (ISS-1266). The Mod cannot
* read package.json through the client, so this is a literal, bumped with
* the two plugin manifests on every release; test/plugin/sidebar-validate
* holds it equal to package.json so a forgotten bump fails before publish.
*/
export const MOD_VERSION = "1.16.0";
function wordmarkNode(dashboard: DashboardState, elements: any): unknown {
  const sweep = dashboard.motion.activity().sweep;
  return paneText(dashboard, elements.Text, { key: "wordmark", bold: true,
            children: sweep === null ? "Storybloq" : [..."Storybloq"].map((letter, index) => {
              // A soft Gaussian crest blends ivory, champagne, and copper without
              // toggling font weight or terminal dimness at band edges.
              const distance = index - (sweep - 3);
              const blend = Math.exp(-(distance * distance) / 8);
              // Darker warm equivalents keep the light theme readable.
              const base = dashboard.themeLight ? [91, 77, 65] : [224, 216, 202];
              const middle = dashboard.themeLight ? [119, 91, 63] : [219, 198, 165];
              const crest = dashboard.themeLight ? [139, 91, 63] : [203, 165, 137];
              const from = blend < 0.75 ? base : middle;
              const to = blend < 0.75 ? middle : crest;
              const mix = blend < 0.75 ? blend / 0.75 : (blend - 0.75) / 0.25;
              const color = "#" + from.map((value, channel) =>
                Math.round(value + (to[channel]! - value) * mix).toString(16).padStart(2, "0")
              ).join("");
              return paneText(dashboard, elements.Text, {
                key: `wordmark-${index}`, bold: true, color, children: letter,
              });
            }),
          });
}

export function compactLineNode(dashboard: DashboardState, elements: any, columns: number): unknown {
  const width = Math.max(1, Math.floor(columns) - PANE_EDGE_CLEARANCE);
  const contextWidth = Math.min(width, 24);
  const context = contextLabel(dashboard.contextPercent, contextWidth);
  const room = width - cellWidth(context) - 3;
  const text = (props: Record<string, unknown>) => paneText(dashboard, elements.Text, props);
  if (room < 12) return contextNode(dashboard, elements, dashboard.contextPercent, width);
  const item = dashboard.projection?.board.inProgress[0];
  const runs: unknown[] = [wordmarkNode(dashboard, elements)];
  let used = 9;
  if (room >= 30) {
    const status = item ? "In progress" : "Ready";
    runs.push(text({ dimColor: true, children: "  │  " }));
    runs.push(text({ color: item ? "cyan" : undefined, children: status }));
    used += 5 + status.length;
    if (item && room - used >= cellWidth(item.id) + 8) {
      runs.push(text({ dimColor: true, children: `  ${item.id}  ` }));
      used += cellWidth(item.id) + 4;
      if (item.blocked && room - used >= 15) {
        runs.push(text({ color: "yellow", children: "[Blocked] " }));
        used += 10;
      }
      const title = truncate(item.title, Math.min(58, room - used));
      runs.push(text({ bold: true, children: title }));
      used += cellWidth(title);
    }
  }
  runs.push(text({ children: " ".repeat(width - used - cellWidth(context)) }));
  runs.push(contextNode(dashboard, elements, dashboard.contextPercent, contextWidth));
  return text({ key: "compact-line", wrap: "truncate", children: runs });
}

export function headerNode(dashboard: DashboardState, elements: any): unknown {
  // "Storybloq (1.15.8) - CPM" (ISS-1266): the wordmark, the version faint,
  // then the project in the wordmark's own weight. The project is the folder
  // the ledger sits in, so two checkouts of one project read apart; the
  // config's `project` name would say "storybloq" for CPM.
  const name = projectFolderName(dashboard);
  return elements.Box({
    key: "header",
    flexDirection: "row",
    alignItems: "center",
    marginRight: PANE_EDGE_CLEARANCE,
    children: [
      paneText(dashboard, elements.Text, {
        wrap: "truncate",
        children: [
          wordmarkNode(dashboard, elements),
          paneText(dashboard, elements.Text, { key: "version", dimColor: true, children: ` (${MOD_VERSION})` }),
          ...(name === "" ? [] : [paneText(dashboard, elements.Text, { key: "project", bold: true, children: ` - ${name}` })]),
        ],
      }),
    ],
  });
}
/** The last segment of the pinned ledger root, or nothing before one is pinned. */
function projectFolderName(dashboard: DashboardState): string {
  if (dashboard.ledgerRoot === null)
    return "";
  const segments = dashboard.ledgerRoot.replace(/[/\\]+$/, "").split(/[/\\]/);
  return segments[segments.length - 1] ?? "";
}
/**
* The foot of the pane: the issues breakdown flush left, the context fill
* right-aligned on the same row.
*
* The four buckets are always all there, so the shape of the line does not
* move about; what changes is the weight. A zero bucket is dim and a nonzero
* one is not, critical reads red and high yellow when they have anything in
* them, and the separators are dim throughout, so the eye lands on the
* severities that exist. The context fill is neutral and gets its width
* first, the issues line taking what is left and going to the short labels
* when the long ones will not fit.
*
* No right margin here: the engine's close mark is a top-right thing, and the
* header is what keeps clear of it.
*/
export function contextLabel(context: number | null, width: number, meterValue = context): string {
  if (width <= 0)
    return "";
  if (context === null || !Number.isFinite(context))
    return truncate(width < 6 ? "--" : width < 14 ? "-- ctx" : "context --", width);
  const value = Math.max(0, Math.min(100, Math.round(context)));
  if (width < 14) {
    const compact = `${value}% ctx`;
    return truncate(cellWidth(compact) <= width ? compact : `${value}%`, width);
  }
  const cells = width >= 48 ? 8 : width >= 32 ? 4 : 0;
  const meterPercent = meterValue !== null && Number.isFinite(meterValue) ? Math.max(0, Math.min(100, meterValue)) : value;
  const filled = Math.round(meterPercent / 100 * cells);
  const meter = cells ? ` [${"━".repeat(filled)}${"·".repeat(cells - filled)}]` : "";
  return `context${meter} ${value}%`;
}
export function contextNode(dashboard: DashboardState, elements: any, context: number | null, width: number): unknown {
  const high = context !== null && Number.isFinite(context) && context >= 80;
  return paneText(dashboard, elements.Text, {
    key: "context", dimColor: !high, bold: high, wrap: "truncate", children: contextLabel(context, width, dashboard.motion.meterValue()),
  });
}
export function footerNode(dashboard: DashboardState, elements: any, bySeverity: Readonly<Record<string, number>>, context: number | null, width: number): unknown {
  const contextText = contextLabel(context, width);
  const room = Math.max(0, width - cellWidth(contextText) - 1);
  const counts = SEVERITY_ORDER.map((severity) => bySeverity[severity.key] ?? 0);
  // A ledger with nothing open says so in a word. Four zeros is four numbers
  // to read before finding out there is nothing to read, and it looks like a
  // pane that failed rather than a project with no open issues. The
  // abbreviated row says the same word, since there is nothing to abbreviate.
  if (counts.every((count) => count === 0)) {
    return elements.Box({
      key: "footer",
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      children: [
        elements.Box({
          key: "issues",
          flexDirection: "row",
          width: Math.min(room, cellWidth(NO_ISSUES)),
          overflow: "hidden",
          children: [paneText(dashboard, elements.Text, { dimColor: true, wrap: "truncate", children: NO_ISSUES })],
        }),
        contextNode(dashboard, elements, context, width),
      ],
    });
  }
  const long = `issues: ${SEVERITY_ORDER.map((s, i) => `${counts[i]} ${s.long}`).join(", ")}`;
  const short = SEVERITY_ORDER.map((s, i) => `${counts[i]} ${s.short}`).join(" ");
  const abbreviated = cellWidth(long) > room;
  const parts: unknown[] = [];
  if (!abbreviated)
    parts.push(paneText(dashboard, elements.Text, { children: "issues: " }));
  SEVERITY_ORDER.forEach((severity, index) => {
    const count = counts[index] ?? 0;
    const props: Record<string, unknown> = {
      children: `${count} ${abbreviated ? severity.short : severity.long}`,
    };
    if (count === 0)
      props["dimColor"] = true;
    else if (severity.tone !== null)
      props["color"] = severity.tone;
    if (index > 0) {
      parts.push(paneText(dashboard, elements.Text, { dimColor: true, children: abbreviated ? " " : ", " }));
    }
    parts.push(paneText(dashboard, elements.Text, props));
  });
  return elements.Box({
    key: "footer",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    children: [
      // ONE Text, not a row of them. The coloured fragments are its children,
      // which keeps each its colour, and the truncation is the parent's: a Box
      // of Texts has no wrap prop to set, so when even the abbreviated buckets
      // outgrew the room the row wrapped and the footer took two rows out of a
      // budget counted for one. The room is the width, so the cut is the
      // context fill's clearance and not the pane's edge.
      elements.Box({
        key: "issues",
        flexDirection: "row",
        width: Math.min(room, cellWidth(abbreviated ? short : long)),
        overflow: "hidden",
        children: [paneText(dashboard, elements.Text, { wrap: "truncate", children: parts })],
      }),
      contextNode(dashboard, elements, context, width),
    ],
  });
}
