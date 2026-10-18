import { mountBoard } from "./view.js";
import { mountHistory } from "./history-view.js";
import { mountFederation } from "./federation-view.js";
import { mountNotes } from "./notes-view.js";
import { mountSessions } from "./sessions-view.js";
import type { Call, Result } from "./view-utils.js";
export function mountWorkspace(d: Document, call: Call) {
  const el = (id: string) => d.getElementById(id)!;
  let screen: "board" | "timeline" | "nodes" | "notes" | "sessions" = "board",
    disposed = false;
  const board = mountBoard(d, call, (overview) => {
    if (!disposed && screen === "board")
      el("nav-nodes").hidden = overview.isOrchestrator !== true;
  });
  const history = mountHistory(d, call),
    nodes = mountFederation(d, call),
    notes = mountNotes(d, call),
    sessions = mountSessions(d, call);
  const current = () =>
    screen === "board"
      ? board
      : screen === "timeline"
        ? history
        : screen === "notes"
          ? notes
          : screen === "sessions"
            ? sessions
            : nodes;
  function activate(next: typeof screen) {
    if (
      disposed ||
      (next === "nodes" && el("nav-nodes").hidden) ||
      screen === next
    )
      return;
    screen = next;
    board.setActive(next === "board");
    history.setActive(next === "timeline");
    nodes.setActive(next === "nodes");
    notes.setActive(next === "notes");
    sessions.setActive(next === "sessions");
    for (const name of ["board", "timeline", "nodes", "notes", "sessions"]) {
      el(name + "-screen").hidden = name !== next;
      el("nav-" + name).setAttribute("aria-pressed", String(name === next));
    }
    el("nav-" + next).focus();
    void current().refresh();
  }
  function navigate(next: typeof screen) {
    if (disposed || screen === next) return;
    if (screen === "board") board.guardLeave(() => activate(next));
    else if (screen === "notes") notes.guardLeave(() => activate(next));
    else activate(next);
  }
  for (const name of [
    "board",
    "timeline",
    "nodes",
    "notes",
    "sessions",
  ] as const)
    el("nav-" + name).onclick = () => navigate(name);
  el("refresh").onclick = () => {
    if (!disposed) void current().refresh();
  };
  return {
    receive(r: Result) {
      if (disposed) return;
      if (screen === "board") board.receive(r);
    },
    error() {
      if (!disposed) board.error();
    },
    autoRefresh() {
      if (!disposed) current().autoRefresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      board.dispose();
      history.dispose();
      nodes.dispose();
      notes.dispose();
      sessions.dispose();
    },
  };
}
