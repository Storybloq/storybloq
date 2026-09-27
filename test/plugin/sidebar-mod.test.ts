/**
 * ISS-1239: the sidebar Mod must address the ledger from a root pinned at
 * `session.start`, not from the session's live working directory.
 *
 * WHY THIS FILE EXISTS AT ALL. `sidebar-projection.test.ts` covers the pure
 * projection function; nothing drove `sidebar.ts` itself. The bug is not in
 * the counting, it is in the addressing, so it is invisible to a projection
 * test: the numbers are right and the Mod reads the wrong directory. This is
 * the first harness that runs the Mod through a fake `$`.
 *
 * THE FAKE IS THE WHOLE POINT. `FakeFs` resolves a RELATIVE path against a
 * mutable `cwd` and an ABSOLUTE path not at all, which is exactly what the
 * client does and exactly what the bug depends on. Moving `fs.cwd` between
 * two polls is `cd` happening in the session. A Mod that addresses the ledger
 * relatively silently reads an empty directory and clears the board; one that
 * pinned its root does not notice the move at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerSidebar, IDLE_POLL_TICKS, SETUP_HINT, MOD_VERSION, contextLabel } from "../../plugins/storybloq/hooks/sidebar.js";
import { cellWidth } from "../../plugins/storybloq/hooks/terminal-text.js";

const PANE_ID = "storybloq";

type Handler = ($: any, e: any, next: (e: any) => unknown) => unknown;

/** A recorded `$.fs` call: the path exactly as the Mod asked for it. */
interface FsCall {
  readonly op: string;
  readonly path: string;
}

class FakeFs {
  cwd = "/repo";
  readonly files = new Map<string, string>();
  private revisions = new Map<string, number>();
  readonly dirs = new Set<string>();
  readonly calls: FsCall[] = [];
  /** path (as resolved) -> errno to throw instead of answering. */
  readonly failures = new Map<string, string>();

  /**
   * Relative against the CURRENT cwd, absolute not at all: what the client
   * does, and what the bug depends on. `.` and `..` segments are collapsed
   * because a real host resolves them, and a fake that did not would quietly
   * make a relative path look like a miss rather than a hit.
   */
  private resolve(path: string): string {
    const joined = path.startsWith("/") ? path : `${this.cwd}/${path}`;
    const out: string[] = [];
    for (const segment of joined.split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") out.pop();
      else out.push(segment);
    }
    return `/${out.join("/")}`;
  }

  private guard(resolved: string): void {
    const code = this.failures.get(resolved);
    if (code === undefined) return;
    const error = new Error(`${code}: fake refusal at ${resolved}`) as Error & { code: string };
    error.code = code;
    throw error;
  }

  addFile(path: string, content: string): void {
    this.files.set(path, content);
    this.revisions.set(path, (this.revisions.get(path) ?? 0) + 1);
    let dir = path.slice(0, path.lastIndexOf("/"));
    while (dir.length > 0) {
      this.dirs.add(dir);
      dir = dir.slice(0, dir.lastIndexOf("/"));
    }
  }

  addDir(path: string): void {
    this.dirs.add(path);
  }

  async exists(path: string): Promise<boolean> {
    this.calls.push({ op: "exists", path });
    const resolved = this.resolve(path);
    this.guard(resolved);
    return this.files.has(resolved) || this.dirs.has(resolved);
  }

  async read(path: string): Promise<string> {
    this.calls.push({ op: "read", path });
    const resolved = this.resolve(path);
    this.guard(resolved);
    const content = this.files.get(resolved);
    if (content === undefined) {
      const error = new Error(`ENOENT: no such file ${resolved}`) as Error & { code: string };
      error.code = "ENOENT";
      throw error;
    }
    return content;
  }

  async list(path: string): Promise<{ name: string; kind: string }[]> {
    this.calls.push({ op: "list", path });
    const resolved = this.resolve(path);
    this.guard(resolved);
    if (!this.dirs.has(resolved)) {
      const error = new Error(`ENOENT: no such directory ${resolved}`) as Error & { code: string };
      error.code = "ENOENT";
      throw error;
    }
    const prefix = `${resolved}/`;
    const names = new Set<string>();
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix) && !file.slice(prefix.length).includes("/")) {
        names.add(file.slice(prefix.length));
      }
    }
    return [...names].sort().map((name) => ({ name, kind: "file" }));
  }

  async stat(path: string): Promise<{ mtimeMs: number }> {
    this.calls.push({ op: "stat", path });
    const resolved = this.resolve(path);
    this.guard(resolved);
    if (!this.files.has(resolved) && !this.dirs.has(resolved)) {
      const error = new Error(`ENOENT: no such path ${resolved}`) as Error & { code: string };
      error.code = "ENOENT";
      throw error;
    }
    return { mtimeMs: this.revisions.get(resolved) ?? 1 };
  }

  /** Every ledger path the Mod asked for that was not absolute. */
  relativeLedgerCalls(): FsCall[] {
    return this.calls.filter((call) => call.path.includes(".story") && !call.path.startsWith("/"));
  }
}

function ticket(id: string, status: string): string {
  return JSON.stringify({
    id,
    displayId: id,
    title: `Ticket ${id}`,
    type: "task",
    status,
    phase: "p1",
    order: 1,
  });
}

function issue(id: string, severity: string): string {
  return JSON.stringify({ id, displayId: id, title: `Issue ${id}`, severity, status: "open" });
}

/** A ledger at `root` with two tickets and one issue. */
function seedLedger(fs: FakeFs, root: string, marker = "T-001"): void {
  fs.addDir(`${root}/.story`);
  fs.addDir(`${root}/.story/handovers`);
  fs.addFile(`${root}/.story/config.json`, JSON.stringify({ project: `proj-${root}` }));
  fs.addFile(
    `${root}/.story/roadmap.json`,
    JSON.stringify({ phases: [{ id: "p1", name: "Phase One" }] }),
  );
  fs.addFile(`${root}/.story/tickets/${marker}.json`, ticket(marker, "inprogress"));
  fs.addFile(`${root}/.story/tickets/T-002.json`, ticket("T-002", "open"));
  fs.addFile(`${root}/.story/issues/ISS-001.json`, issue("ISS-001", "high"));
}

class Harness {
  readonly fs = new FakeFs();
  readonly handlers = new Map<string, Handler>();
  readonly logs: string[] = [];
  readonly store = new Map<string, unknown>();
  private timers: (() => void)[] = [];
  readonly $: any;

  constructor(startupLogo = false, changeHighlights = true, motion = true) {
    const fs = this.fs;
    this.$ = {
      fs: {
        exists: (p: string) => fs.exists(p),
        read: (p: string) => fs.read(p),
        list: (p: string) => fs.list(p),
        stat: (p: string) => fs.stat(p),
      },
      store: {
        get: async (key: string) => this.store.get(key),
        set: async (key: string, value: unknown) => void this.store.set(key, value),
      },
      ui: {
        open: async () => undefined,
        log: (line: string) => void this.logs.push(line),
        invalidate: () => undefined,
        resolve: () => ({
          Box: (props: any) => ({ node: "Box", ...props }),
          Text: (props: any) => ({ node: "Text", ...props }),
        }),
      },
      clock: {
        every: (_ms: number, cb: () => void) => {
          this.timers.push(cb);
          return () => undefined;
        },
      },
      config: { list: async () => [] },
      settings: { read: async () => ({}) },
      session: { usage: async () => ({}) },
    };

    const on = ((event: string, hook: Handler) => {
      this.handlers.set(event, hook);
      return { catch: () => undefined };
    }) as any;
    registerSidebar(on, { startupLogo, changeHighlights, motion });
  }

  async fire(event: string, payload: Record<string, unknown> = {}): Promise<void> {
    const handler = this.handlers.get(event);
    if (handler === undefined) throw new Error(`no handler for ${event}`);
    await handler(this.$, payload, (e: any) => e);
  }

  async start(cwd: string): Promise<void> {
    this.fs.cwd = cwd;
    await this.fire("session.start", { surface: "terminal", isInteractive: true, cwd });
  }

  /** Drains the chunked scan. */
  async settle(rounds = 40): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      for (const timer of [...this.timers]) timer();
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /** The pane's drawn tree, as a comparable string. */
  render(): string {
    const handler = this.handlers.get("ui.render");
    if (handler === undefined) throw new Error("no ui.render handler");
    const node = handler(
      this.$,
      { component: "Pane", requestId: PANE_ID, props: { bodyColumns: 160 } },
      (e: any) => e,
    );
    return JSON.stringify(node);
  }
}

describe("ISS-1239: the ledger root is pinned at session.start", () => {
  let h: Harness;

  beforeEach(() => {
    h = new Harness();
  });

  it("1. survives a cd: the board is byte-identical after the cwd moves away", async () => {
    seedLedger(h.fs, "/repo");
    h.fs.addDir("/repo/sub");
    await h.start("/repo");
    await h.settle();
    const before = h.render();
    expect(before).toContain("T-001");

    // The bug, exactly: the user runs `cd sub`.
    h.fs.cwd = "/repo/sub";
    await h.settle();
    await h.fire("turn.complete", {});
    await h.settle();

    expect(h.render()).toBe(before);
  });

  it("2. survives a one-shot `cd X && cmd`: a single move between two polls", async () => {
    seedLedger(h.fs, "/repo");
    h.fs.addDir("/repo/sub");
    await h.start("/repo");
    await h.settle();
    const before = h.render();

    // No event between the move and the next poll, which is what a compound
    // command looks like from inside the session. The idle poll is the ONLY
    // thing that runs here, so it has to be allowed to actually fire: it does
    // so once every IDLE_POLL_TICKS, and settling for fewer ticks than that
    // would make this test pass on the broken code by never looking.
    h.fs.cwd = "/repo/sub";
    await h.settle(IDLE_POLL_TICKS + 5);

    expect(h.render()).toBe(before);
  });

  it("3. a nested ledger under the new cwd never wins over the pinned root", async () => {
    seedLedger(h.fs, "/repo", "T-001");
    seedLedger(h.fs, "/repo/sub", "T-999");
    await h.start("/repo");
    await h.settle();

    h.fs.cwd = "/repo/sub";
    await h.settle();
    await h.fire("turn.complete", {});
    await h.settle();

    const drawn = h.render();
    expect(drawn).toContain("T-001");
    expect(drawn).not.toContain("T-999");
  });

  it("4a. a REFUSED tickets directory does not empty the board", async () => {
    seedLedger(h.fs, "/repo");
    await h.start("/repo");
    await h.settle();
    expect(h.render()).toContain("T-001");

    // Not deleted: unreadable. The records are still real.
    h.fs.failures.set("/repo/.story/tickets", "EACCES");
    await h.fire("turn.complete", {});
    await h.settle();

    expect(h.render()).toContain("T-001");
  });

  it.each(["EACCES", "EIO"])("preserves a cached story on %s and refreshes after recovery", async (code) => {
    seedLedger(h.fs, "/repo");
    await h.start("/repo"); await h.settle();
    h.fs.addFile("/repo/.story/tickets/T-001.json", ticket("T-001", "complete"));
    h.fs.failures.set("/repo/.story/tickets/T-001.json", code);
    await h.fire("turn.complete", {}); await h.settle();
    expect(h.render()).toContain("T-001");
    h.fs.failures.delete("/repo/.story/tickets/T-001.json");
    await h.fire("turn.complete", {}); await h.settle();
    expect(JSON.stringify(findUi(JSON.parse(h.render()), "board-done"))).toContain("T-001");
    h.fs.files.delete("/repo/.story/tickets/T-001.json");
    await h.fire("turn.complete", {}); await h.settle();
    expect(h.render()).not.toContain("T-001");
  });

  it("4b. a DELETED tickets directory still clears the board", async () => {
    seedLedger(h.fs, "/repo");
    await h.start("/repo");
    await h.settle();
    expect(h.render()).toContain("T-001");

    // Genuinely gone. Without this the fix would trade a board that wrongly
    // shows zeros for one that wrongly shows phantoms.
    for (const path of [...h.fs.files.keys()]) {
      if (path.startsWith("/repo/.story/tickets/")) h.fs.files.delete(path);
    }
    h.fs.dirs.delete("/repo/.story/tickets");
    await h.fire("turn.complete", {});
    await h.settle();

    expect(h.render()).not.toContain("T-001");
  });

  it("5a. a project with no ledger draws nothing and reports no error", async () => {
    h.fs.addDir("/repo");
    await h.start("/repo");
    await h.settle();

    expect(h.render()).not.toContain("Storybloq");
    expect(h.logs.join("\n")).toContain("no .story directory here");
    // A project that never ran init is not a failure, so it must not be
    // reported as one.
    expect(h.logs.join("\n")).not.toContain("could not resolve");
  });

  it("5b. a REFUSED walk hides the pane and RECOVERS once the refusal lifts", async () => {
    seedLedger(h.fs, "/repo");
    // The host refuses the one question the walk asks (ISS-1256: the config).
    h.fs.failures.set("/repo/.story/config.json", "EACCES");
    await h.start("/repo");
    await h.settle();

    // Hidden, and said so. Pinning a guess here instead would lock the
    // session to a possibly-wrong root for good, because the retry loop below
    // only runs while the Mod is hidden.
    expect(h.render()).not.toContain("Storybloq");
    expect(h.logs.join("\n")).toContain("could not resolve the ledger root");
    expect(h.fs.relativeLedgerCalls()).toEqual([]);

    // The refusal lifts. The retry loop re-walks from the ORIGIN and pins.
    h.fs.failures.delete("/repo/.story/config.json");
    await h.fire("turn.complete", {});
    await h.settle();

    expect(h.render()).toContain("T-001");
  });

  it("5c. the setup hint is once per session and root (T-537), and a reload re-pins and re-arms the purge", async () => {
    // T-537's owner spec: "one actionable setup hint per session/root, quiet
    // during repeated renders, attach when initialization finishes".
    const hints = () => h.logs.filter((line) => line.includes("no .story directory here"));
    h.fs.addDir("/repo");
    h.fs.addDir("/other");
    await h.start("/repo");
    await h.settle();
    expect(hints()).toHaveLength(1);
    expect(hints()[0]).toContain(SETUP_HINT);
    expect(SETUP_HINT).toContain("/story");

    // Repeated renders and turns stay quiet.
    h.render();
    await h.fire("turn.complete", {});
    await h.settle();
    expect(hints()).toHaveLength(1);

    // Same session, reload, same root, still no ledger: quiet.
    await h.start("/repo");
    await h.settle();
    expect(hints()).toHaveLength(1);

    // A different root is told once.
    await h.start("/other");
    await h.settle();
    await h.start("/other");
    await h.settle();
    expect(hints()).toHaveLength(2);

    // Initialization finishes: the pane attaches on the next refresh,
    // without a new session start.
    seedLedger(h.fs, "/other");
    await h.fire("turn.complete", {});
    await h.settle();
    expect(h.render()).toContain("T-001");

    // Now a real ledger and a real reload: it pins, and the purge is armed,
    // so a genuine deletion still clears the board.
    seedLedger(h.fs, "/repo");
    await h.start("/repo");
    await h.settle();
    expect(h.render()).toContain("T-001");

    for (const path of [...h.fs.files.keys()]) {
      if (path.startsWith("/repo/.story/tickets/")) h.fs.files.delete(path);
    }
    h.fs.dirs.delete("/repo/.story/tickets");
    await h.fire("turn.complete", {});
    await h.settle();

    expect(h.render()).not.toContain("T-001");
  });

  it("5d. late attachment resolves from the ORIGIN, not the live cwd", async () => {
    h.fs.addDir("/repo");
    await h.start("/repo");
    await h.settle();
    expect(h.render()).not.toContain("Storybloq");

    // `storybloq init` lands in the project. Meanwhile the session has cd-ed
    // somewhere else entirely, and that somewhere has a ledger of its own.
    seedLedger(h.fs, "/repo", "T-001");
    seedLedger(h.fs, "/elsewhere", "T-999");
    h.fs.cwd = "/elsewhere";
    await h.fire("turn.complete", {});
    await h.settle();

    const drawn = h.render();
    expect(drawn).toContain("T-001");
    expect(drawn).not.toContain("T-999");
  });

  it("6. never asks the client for a relative ledger path", async () => {
    seedLedger(h.fs, "/repo");
    h.fs.addDir("/repo/sub");
    await h.start("/repo");
    await h.settle();
    h.fs.cwd = "/repo/sub";
    await h.fire("turn.complete", {});
    await h.settle();

    expect(h.fs.relativeLedgerCalls()).toEqual([]);
  });
});

/**
 * ISS-1251 / ISS-1252, on the same harness. `plugins/storybloq/hooks/
 * sidebar.test.ts` carries the same cases for `claude plugin test`, but that
 * runner opens no pane at all on 2.1.278 (ISS-1253), so the gate is here.
 */
describe("ISS-1256: a ledger is .story/config.json, the CLI's rule, not a bare .story directory", () => {
  let h: Harness;
  beforeEach(() => {
    h = new Harness();
  });

  it("walks past a bare .story in the start directory and pins the real ledger above it", async () => {
    // A bare .story (like the owner's ~/.story/sessions/) sits where the
    // walk starts; the ledger with a config is one level up. The old rule
    // pinned the bare one and drew an all-zero board.
    // addDir registers the one path, so the bare directory itself is added:
    // that is the path the old rule tested and pinned.
    h.fs.addDir("/home/work/repo/src/.story");
    h.fs.addDir("/home/work/repo/src/.story/sessions");
    seedLedger(h.fs, "/home/work/repo");
    await h.start("/home/work/repo/src");
    await h.settle();
    expect(h.render()).toContain("T-001");
  });

  it("a bare .story with no config is no ledger: nothing drawn, said once, no pane", async () => {
    h.fs.addDir("/home/.story");
    h.fs.addDir("/home/.story/sessions");
    h.fs.addDir("/home/work/plain");
    await h.start("/home/work/plain");
    await h.settle();
    expect(h.render()).not.toContain("Storybloq");
    expect(h.logs.filter((line) => line.includes("no .story directory here"))).toHaveLength(1);
  });
});

describe("ISS-1257: the band names the finished project, not a missing phase", () => {
  let h: Harness;
  beforeEach(() => {
    h = new Harness();
  });

  function band(): string {
    const handler = h.handlers.get("ui.render")!;
    const node = handler(h.$, { component: "AbovePrompt", requestId: "above-prompt", viewport: { columns: 120, rows: 30 }, props: {} }, () => null);
    return JSON.stringify(node);
  }

  it("says all phases complete when every phase is, and no phase only when the roadmap has none", async () => {
    seedLedger(h.fs, "/repo");
    h.fs.addFile("/repo/.story/tickets/T-001.json", ticket("T-001", "complete"));
    h.fs.addFile("/repo/.story/tickets/T-002.json", ticket("T-002", "complete"));
    await h.start("/repo");
    await h.settle();
    expect(band()).toContain("all phases complete");
    expect(band()).not.toContain("no phase");

    const bare = new Harness();
    seedLedger(bare.fs, "/repo");
    bare.fs.addFile("/repo/.story/roadmap.json", JSON.stringify({ phases: [] }));
    await bare.start("/repo");
    await bare.settle();
    const drawn = JSON.stringify(bare.handlers.get("ui.render")!(bare.$, { component: "AbovePrompt", requestId: "above-prompt", viewport: { columns: 120, rows: 30 }, props: {} }, () => null));
    expect(drawn).toContain("no phase");
  });
});

describe("ISS-1266: the header names the project folder after the wordmark", () => {
  let h: Harness;
  beforeEach(() => {
    h = new Harness();
  });

  it("draws 'Storybloq - <folder>' with the folder dim, from the pinned root and not the cwd", async () => {
    seedLedger(h.fs, "/home/work/CPM");
    h.fs.addDir("/home/work/CPM/storybloq");
    await h.start("/home/work/CPM/storybloq");
    await h.settle();
    const drawn = h.render();
    // "Storybloq (x.y.z) - CPM": the version faint, the project in the
    // wordmark's own weight.
    expect(drawn).toContain('"key":"wordmark","bold":true,"children":"Storybloq"');
    expect(drawn).toContain(`"key":"version","dimColor":true,"children":" (${MOD_VERSION})"`);
    expect(drawn).toContain('"key":"project","bold":true,"children":" - CPM"');
  });
});

describe("ISS-1251: the person's prompt re-opens a pane parked by a narrow start", () => {
  let h: Harness;
  let opened: unknown[];
  beforeEach(() => {
    h = new Harness();
    opened = [];
    h.$.ui.open = async (pane: unknown) => void opened.push(pane);
  });

  function abovePrompt(columns: number): string {
    const handler = h.handlers.get("ui.render")!;
    const node = handler(h.$, { component: "AbovePrompt", requestId: "above-prompt", viewport: { columns, rows: 30 }, props: { bodyColumns: columns } }, () => null);
    return JSON.stringify(node ?? "");
  }
  async function prompt(): Promise<unknown> {
    const handler = h.handlers.get("prompt.submit")!;
    const e = { text: "hello", turnId: "t1" };
    const passed = await handler(h.$, e, (x: any) => x);
    await Promise.resolve();
    await Promise.resolve();
    return passed === e;
  }

  it("asks once per prompt while the pane is open and undrawn, and passes the prompt on unchanged", async () => {
    seedLedger(h.fs, "/repo");
    await h.start("/repo");
    await h.settle();
    expect(opened).toHaveLength(1);

    // Narrow: the band draws and says the board opens at the prompt.
    expect(abovePrompt(120)).toContain("board opens at your next prompt");

    expect(await prompt()).toBe(true);
    expect(opened).toHaveLength(2);
    expect(opened[1]).toEqual({ id: "storybloq", title: "Storybloq" });

    // The client placed it: one Pane render marks it drawn, then a prompt asks nothing.
    h.render();
    expect(await prompt()).toBe(true);
    expect(opened).toHaveLength(2);

    // Drawn and narrow (the pane keeps its inline seat when the window
    // shrinks): the band still carries the counts, without the hint.
    const under = abovePrompt(120);
    expect(under).toContain("Storybloq:");
    expect(under).not.toContain("board opens at your next prompt");
  });

  it("never re-opens a pane the person closed", async () => {
    seedLedger(h.fs, "/repo");
    await h.start("/repo");
    await h.settle();
    await h.fire("ui.close", { requestId: PANE_ID, origin: "person" });
    expect(await prompt()).toBe(true);
    expect(opened).toHaveLength(1);
    // The band is still the sidebar at this width.
    expect(abovePrompt(120)).toContain("Storybloq:");
  });

  it("asks nothing in a project with no ledger", async () => {
    await h.start("/nowhere");
    await h.settle();
    expect(opened).toHaveLength(0);
    expect(await prompt()).toBe(true);
    expect(opened).toHaveLength(0);
  });
});

describe("ISS-1252: below 60 body columns the pane draws the narrow board", () => {
  let h: Harness;
  beforeEach(() => {
    h = new Harness();
  });

  function pane(bodyColumns: number): string {
    const handler = h.handlers.get("ui.render")!;
    const node = handler(
      h.$,
      { component: "Pane", requestId: PANE_ID, viewport: { columns: bodyColumns + 4, rows: 40 }, props: { bodyColumns, placement: "inline", scroll: { offset: 0, bodyRows: 20 } } },
      (e: any) => e,
    );
    return JSON.stringify(node);
  }

  it("shows In progress with three cards and a tail, the footer, and nothing of the three columns", async () => {
    seedLedger(h.fs, "/repo");
    for (const id of ["T-003", "T-004", "T-005", "T-006", "T-007"]) {
      h.fs.addFile(`/repo/.story/tickets/${id}.json`, ticket(id, "inprogress"));
    }
    await h.start("/repo");
    await h.settle();
    const drawn = pane(45);
    expect(drawn).toContain('"In progress"');
    expect(drawn).toContain('"children":" 6"');
    expect(drawn).toContain('"narrow-card-0"');
    expect(drawn).toContain('"narrow-card-2"');
    expect(drawn).not.toContain('"narrow-card-3"');
    expect(drawn).toContain('"... 3 more"');
    expect(drawn).toContain('"footer"');
    for (const key of ["board-blocked", "board-open", "board-inprogress", "board-done", "header-gap", "issues-gap"]) {
      expect(drawn, key).not.toContain(`"${key}"`);
    }
    expect(drawn).not.toContain("Blocked");
    expect(drawn).not.toContain("Done");
  });

  it("shows the Open column when nothing is in progress (ISS-1254)", async () => {
    seedLedger(h.fs, "/repo");
    h.fs.addFile("/repo/.story/tickets/T-001.json", ticket("T-001", "open"));
    await h.start("/repo");
    await h.settle();
    const drawn = pane(45);
    expect(drawn).toContain('"Open"');
    expect(drawn).toContain('"children":" 3"');
    expect(drawn).toContain('"narrow-card-0"');
    expect(drawn).not.toContain('"narrow-none"');
    expect(drawn).not.toContain('"narrow-tail"');
  });

  it("keeps the three-column board from 60 body columns up", async () => {
    seedLedger(h.fs, "/repo");
    await h.start("/repo");
    await h.settle();
    expect(pane(60)).toContain('"board-inprogress"');
    expect(pane(60)).not.toContain('"narrow-heading"');
    expect(pane(59)).toContain('"narrow-heading"');
  });
});

describe("ISS-1254: a docked pane stacks the three columns at any width", () => {
  let h: Harness;
  beforeEach(() => {
    h = new Harness();
  });

  function pane(bodyColumns: number, placement?: "dock" | "inline"): any {
    const handler = h.handlers.get("ui.render")!;
    const props: Record<string, unknown> = { bodyColumns, scroll: { offset: 0, bodyRows: 40 } };
    if (placement !== undefined) props["placement"] = placement;
    return handler(
      h.$,
      { component: "Pane", requestId: PANE_ID, viewport: { columns: bodyColumns + 4, rows: 40 }, props },
      (e: any) => e,
    );
  }

  function board(node: any): any {
    if (node === null || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = board(child);
        if (found !== null) return found;
      }
      return null;
    }
    if (node.key === "board") return node;
    return board(node.children ?? null);
  }

  it("docked: the sidebar, three framed columns one under another, at 40, 60 and 156 body columns", async () => {
    seedLedger(h.fs, "/repo");
    await h.start("/repo");
    await h.settle();
    for (const width of [40, 60, 156]) {
      const node = board(pane(width, "dock"));
      expect(node?.flexDirection, String(width)).toBe("column");
      const drawn = JSON.stringify(node);
      expect(drawn).not.toContain('"board-blocked"');
      expect(drawn).toContain('"board-done"');
      expect(drawn).not.toContain('"narrow-heading"');
    }
  });

  it("inline: side by side from 60 body columns, the narrow strip below", async () => {
    seedLedger(h.fs, "/repo");
    await h.start("/repo");
    await h.settle();
    expect(board(pane(156, "inline"))?.flexDirection).toBe("row");
    expect(JSON.stringify(pane(40, "inline"))).toContain('"narrow-heading"');
  });

  it("no placement reported: the width alone decides, stacked below 60 (the 1.15.4 rule)", async () => {
    seedLedger(h.fs, "/repo");
    await h.start("/repo");
    await h.settle();
    expect(board(pane(40))?.flexDirection).toBe("column");
    expect(JSON.stringify(pane(40))).not.toContain('"narrow-heading"');
    expect(board(pane(156))?.flexDirection).toBe("row");
  });
});

describe("ISS-1255: inline text takes the terminal's foreground, docked text the theme's", () => {
  let h: Harness;
  beforeEach(() => {
    h = new Harness();
  });

  function contextColor(placement: "dock" | "inline"): unknown {
    const handler = h.handlers.get("ui.render")!;
    const node = handler(
      h.$,
      { component: "Pane", requestId: PANE_ID, viewport: { columns: 164, rows: 40 }, props: { bodyColumns: 160, placement, scroll: { offset: 0, bodyRows: 40 } } },
      (e: any) => e,
    );
    const find = (n: any): any => {
      if (n === null || typeof n !== "object") return null;
      if (Array.isArray(n)) {
        for (const c of n) {
          const f = find(c);
          if (f !== null) return f;
        }
        return null;
      }
      if (n.key === "context") return n;
      return find(n.children ?? null);
    };
    return find(node)?.color;
  }

  it("forces no colour inline and white in the dock under the dark theme", async () => {
    seedLedger(h.fs, "/repo");
    await h.start("/repo");
    await h.settle();
    expect(contextColor("inline")).toBeUndefined();
    expect(contextColor("dock")).toBe("white");
  });
});


describe("Storyfield startup", () => {
  it("shows once, yields to the board, and never restarts on redraw", async () => {
    const h = new Harness(true);
    seedLedger(h.fs, "/repo");
    await h.start("/repo");
    await h.settle();
    expect(h.render()).toContain("storyfield-0");
    expect(findUi(JSON.parse(h.render()), "context").children).toBe("context --");
    await h.settle(100);
    expect(h.render()).toContain("T-001");
    expect(h.render()).not.toContain("storyfield-0");
    await h.fire("turn.complete", {});
    expect(h.render()).not.toContain("storyfield-0");
  });
  it("opt-out draws the board immediately", async () => {
    const h = new Harness(false);
    seedLedger(h.fs, "/repo");
    await h.start("/repo");
    await h.settle();
    expect(h.render()).toContain("T-001");
    expect(h.render()).not.toContain("storyfield-0");
  });
});

it("resizes the active intro between inline and dock without restarting its clock", async () => {
  const h = new Harness(true);
  seedLedger(h.fs, "/repo");
  await h.start("/repo");
  await h.settle();
  const draw = (bodyColumns: number, bodyRows: number, placement: string) => h.handlers.get("ui.render")!(h.$, {
    component: "Pane", requestId: PANE_ID,
    props: { bodyColumns, placement, scroll: { bodyRows, offset: 0 } },
    viewport: { columns: 160, rows: 43 },
  }, (e: any) => e) as any;
  const inline = draw(156, 10, "inline");
  const dock = draw(40, 30, "dock");
  expect(inline.children.length).toBeLessThanOrEqual(10);
  expect(dock.children.length).toBeGreaterThan(inline.children.length);
  await h.settle(60);
  draw(156, 8, "inline");
  await h.settle(40);
  expect(JSON.stringify(draw(40, 30, "dock"))).not.toContain("storyfield-0");
});

function findUi(node: any, key: string): any {
  if (!node || typeof node !== "object") return undefined;
  if (node.key === key) return node;
  for (const child of Array.isArray(node) ? node : [node.children]) {
    const found = findUi(child, key);
    if (found) return found;
  }
}

describe("dashboard hierarchy and state feedback", () => {
  it("keeps blocked work in progress and marks it, with a quiet leading ID and emphasized title", async () => {
    const h = new Harness();
    seedLedger(h.fs, "/repo");
    const record = JSON.parse(ticket("T-001", "inprogress"));
    record.blockedBy = ["T-002"];
    h.fs.addFile("/repo/.story/tickets/T-001.json", JSON.stringify(record));
    await h.start("/repo"); await h.settle();
    const tree = JSON.parse(h.render());
    expect(findUi(tree, "board-blocked")).toBeUndefined();
    const active = findUi(tree, "board-inprogress");
    const row = findUi(active, "ticket:T-001");
    expect(row.children[2]).toMatchObject({ children: "Ticket T-001", bold: true });
    expect(JSON.stringify(row)).not.toContain('"underline":true');
    expect(row.children[1]).toMatchObject({ children: "[Blocked] ", color: "yellow" });
    expect(row.children[0]).toMatchObject({ children: "T-001 ", dimColor: true });
    expect(findUi(active, "board-inprogress-heading").color).toBe("cyan");
  });

  it("highlights a status change once, then settles without rearranging the board", async () => {
    const h = new Harness(); seedLedger(h.fs, "/repo");
    await h.start("/repo"); await h.settle();
    expect(h.render()).not.toContain('"underline":true');
    h.fs.addFile("/repo/.story/tickets/T-001.json", ticket("T-001", "complete"));
    await h.fire("turn.complete"); await h.settle(8);
    const tree = JSON.parse(h.render());
    const done = findUi(tree, "board-done");
    expect(findUi(done, "ticket:T-001").children[2].dimColor).toBe(true);
    expect(JSON.stringify(findUi(done, "ticket:T-001"))).toContain('"underline":true');
    expect(findUi(done, "board-done-heading").children[1].bold).toBe(true);
    await h.settle(70);
    expect(h.render()).not.toContain('"underline":true');
    await h.fire("turn.complete"); await h.settle(8);
    expect(h.render()).not.toContain('"underline":true');
  });

  it("can disable change highlights", async () => {
    const h = new Harness(false, false); seedLedger(h.fs, "/repo");
    await h.start("/repo"); await h.settle();
    h.fs.addFile("/repo/.story/tickets/T-001.json", ticket("T-001", "complete"));
    await h.fire("turn.complete"); await h.settle(8);
    expect(h.render()).not.toContain('"underline":true');
  });

  it("fits context meters to the available width and keeps numeric usage", () => {
    expect(contextLabel(null, 80)).toBe("context --");
    expect(contextLabel(NaN, 80)).toBe("context --");
    expect(contextLabel(null, 8)).toBe("-- ctx");
    expect(contextLabel(0, 80)).toBe("context [········] 0%");
    expect(contextLabel(100, 80)).toBe("context [━━━━━━━━] 100%");
    expect(contextLabel(50, 40)).toBe("context [━━··] 50%");
    expect(contextLabel(88, 20)).toBe("context 88%");
    expect(contextLabel(88, 10)).toBe("88% ctx");
  });
});

describe("context pressure at every width", () => {
  it("keeps an honest reading in narrow and docked footers, including before usage arrives", async () => {
    const h = new Harness(); seedLedger(h.fs, "/repo");
    await h.start("/repo"); await h.settle();
    const draw = (width: number, placement: string) => h.handlers.get("ui.render")!(h.$, {
      component: "Pane", requestId: PANE_ID,
      props: { bodyColumns: width, placement, scroll: { bodyRows: 30 } }, viewport: { columns: width + 4, rows: 40 },
    }, () => null);
    for (const usage of [null, 0, 88, 100, null]) {
      h.$.session.usage = async () => usage === null ? { context: { window: 200_000 } } : { context: { tokens: usage, breakdown: { autoCompactThreshold: 100 } } };
      await h.fire("turn.complete"); await h.settle();
      for (const placement of ["inline", "dock"]) {
        for (const width of [4, 8, 12, 20, 32, 45, 56, 100, 160]) {
          const tree = draw(width, placement);
          const context = findUi(tree, "context");
          expect(context.children).toContain(usage === null ? "--" : `${usage}%`);
          expect(context.bold).toBe(usage !== null && usage >= 80);
          const issues = findUi(findUi(tree, "footer"), "issues");
          if (placement === "inline" && width < 60) expect(issues).toBeUndefined();
          else expect(issues).toBeDefined();
          expect((issues?.width ?? 0) + context.children.length).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("reserves context in the fallback band even with a long phase name", async () => {
    const h = new Harness(); seedLedger(h.fs, "/repo");
    h.fs.addFile("/repo/.story/roadmap.json", JSON.stringify({ phases: [{ id: "p1", name: "A very long phase title ".repeat(10) }] }));
    await h.start("/repo"); await h.settle();
    for (const usage of [null, 88, 100]) {
      h.$.session.usage = async () => usage === null ? {} : { context: { tokens: usage, breakdown: { autoCompactThreshold: 100 } } };
      await h.fire("turn.complete"); await h.settle();
      for (const width of [4, 8, 20, 45, 80, 120]) {
        const band = h.handlers.get("ui.render")!(h.$, {
          component: "AbovePrompt", viewport: { columns: width, rows: 30 }, props: {},
        }, () => null) as any;
        expect(band.children.length).toBeLessThanOrEqual(width);
        expect(band.children).toContain(usage === null ? "--" : `${usage}%`);
      }
    }
  });
});

describe("live animation hooks", () => {
  it("uses real turn lifecycle, preserves activity across worker completions, and handles reload state", async () => {
    const h = new Harness(); seedLedger(h.fs, "/repo");
    await h.start("/repo"); await h.settle();
    const activity = () => findUi(JSON.parse(h.render()), "wordmark");
    await h.fire("prompt.submit", { text: "not a started turn" });
    expect(activity().children).toBe("Storybloq");
    await h.fire("turn.start", { turnId: "main", text: "build" });
    await h.settle(20);
    expect(activity().children.map((letter: any) => letter.children).join("")).toBe("Storybloq");
    const firstFrame = JSON.stringify(activity());
    await h.settle(6);
    expect(JSON.stringify(activity())).not.toBe(firstFrame);
    expect(activity().children).toHaveLength(9);
    expect(h.render()).not.toContain('"key":"activity"');
    await h.fire("turn.complete", { turnId: "child", agentId: "worker" });
    expect(activity().children.map((letter: any) => letter.children).join("")).toBe("Storybloq");
    await h.fire("turn.complete", { turnId: "main", reason: "aborted" });
    expect(activity().children).toBe("Storybloq");
    const above = (isWorking: boolean) => h.handlers.get("ui.render")!(h.$, {
      component: "AbovePrompt", viewport: { columns: 160 }, props: { isWorking, view: {} },
    }, () => null);
    above(true); await h.settle(20);
    expect(activity().children.map((letter: any) => letter.children).join("")).toBe("Storybloq");
    above(false);
    expect(activity().children).toBe("Storybloq");
  });

  it("shows the actual context percentage immediately while the meter catches up", async () => {
    const h = new Harness(); seedLedger(h.fs, "/repo");
    h.$.session.usage = async () => ({ context: { tokens: 20, breakdown: { autoCompactThreshold: 100 } } });
    await h.start("/repo"); await h.settle();
    h.$.session.usage = async () => ({ context: { tokens: 90, breakdown: { autoCompactThreshold: 100 } } });
    await h.fire("turn.complete");
    const context = () => findUi(JSON.parse(h.render()), "context");
    expect(context()).toMatchObject({ children: "context [━━······] 90%", bold: true });
    await h.settle(28);
    expect(context().children).toBe("context [━━━━━━━·] 90%");
    h.$.session.usage = async () => ({ context: { tokens: 10, breakdown: { autoCompactThreshold: 100 } } });
    await h.fire("session.compact");
    expect(context().children).toBe("context [━━━━━━━·] 10%");
    await h.settle(28);
    expect(context().children).toBe("context [━·······] 10%");
  });

  it("disables startup and ongoing animation with one switch while retaining live state", async () => {
    const h = new Harness(true, true, false); seedLedger(h.fs, "/repo");
    await h.start("/repo"); await h.settle();
    await h.fire("turn.start", { turnId: "main" });
    expect(findUi(JSON.parse(h.render()), "wordmark").children).toBe("Storybloq");
    expect(h.render()).not.toContain("storyfield-0");
    h.fs.addFile("/repo/.story/tickets/T-001.json", ticket("T-001", "complete"));
    await h.fire("turn.complete", { turnId: "main" }); await h.settle(8);
    expect(findUi(JSON.parse(h.render()), "ticket:T-001").children[2].children).toBe("Ticket T-001");
    let invalidations = 0;
    h.$.ui.invalidate = () => { invalidations++; };
    await h.fire("turn.start", { turnId: "next" });
    invalidations = 0;
    const before = h.render(); await h.settle(80);
    expect(h.render()).toBe(before);
    expect(invalidations).toBe(0);
  });
});

it("highlights dependency resolution without moving the blocked story out of its status", async () => {
  const h = new Harness(); seedLedger(h.fs, "/repo");
  const blocked = JSON.parse(ticket("T-001", "inprogress"));
  blocked.blockedBy = ["T-002"];
  h.fs.addFile("/repo/.story/tickets/T-001.json", JSON.stringify(blocked));
  await h.start("/repo"); await h.settle();
  h.fs.addFile("/repo/.story/tickets/T-002.json", ticket("T-002", "complete"));
  await h.fire("turn.complete"); await h.settle(8);
  const active = findUi(JSON.parse(h.render()), "board-inprogress");
  const row = findUi(active, "ticket:T-001");
  expect(JSON.stringify(row.children[2])).toContain('"underline":true');
  expect(row.children[1].children).toBe("✓ Ready ");
  await h.settle(80);
  expect(findUi(JSON.parse(h.render()), "ticket:T-001").children[1].children).toBe("");
});

const roadmapPhases = Array.from({ length: 20 }, (_, index) => ({
  id: `p${index}`, name: `Phase name ${index}`, label: `PHASE ${index}`,
  status: (index === 9 || index === 10 ? "inprogress" : index === 4 || index > 12 ? "notstarted" : "complete") as "inprogress" | "notstarted" | "complete",
  leafCount: 1,
}));

describe("inline phase overview", () => {
  it("keeps the phase strip hidden across pane sizes and placements", async () => {
    const h = new Harness(); seedLedger(h.fs, "/repo");
    h.fs.files.delete("/repo/.story/tickets/T-001.json");
    h.fs.files.delete("/repo/.story/tickets/T-002.json");
    h.fs.addFile("/repo/.story/roadmap.json", JSON.stringify({ phases: roadmapPhases }));
    for (let i = 0; i < 20; i++) {
      h.fs.addFile(`/repo/.story/tickets/phase-${i}.json`, JSON.stringify({
        id: `TP-${i}`, title: `Story ${i}`, phase: `p${i}`, order: i,
        status: roadmapPhases[i]!.status === "complete" ? "complete" : roadmapPhases[i]!.status === "inprogress" ? "inprogress" : "open",
      }));
    }
    await h.start("/repo"); await h.settle();
    const draw = (width: number, rows: number, placement: string) => h.handlers.get("ui.render")!(h.$, {
      component: "Pane", requestId: PANE_ID, props: { bodyColumns: width, placement, scroll: { bodyRows: rows } },
      viewport: { columns: width + 4, rows: 60 },
    }, (e: any) => e);
    const inline = draw(189, 18, "inline");
    const timeline = findUi(inline, "phase-timeline");
    expect(timeline).toBeUndefined();
    expect(findUi(inline, "header")).toBeDefined();
    expect(findUi(draw(189, 18, "dock"), "phase-timeline")).toBeUndefined();
    expect(findUi(draw(189, 18, "dock"), "header")).toBeDefined();
    expect(findUi(draw(90, 18, "inline"), "phase-timeline")).toBeUndefined();
    expect(findUi(draw(90, 18, "inline"), "header")).toBeDefined();
    expect(findUi(draw(189, 10, "inline"), "phase-timeline")).toBeUndefined();
    expect(findUi(draw(189, 18, "inline"), "phase-timeline")).toBeUndefined();
    const height = (node: any): number => {
      if (node.node === "Text") return 1;
      const children = node.children || [];
      return (node.flexDirection === "row" ? Math.max(0, ...children.map(height)) : children.reduce((n: number, child: any) => n + height(child), 0)) + (node.borderStyle ? 2 : 0);
    };
    // Without the timeline, use the normal board budget rather than its last drawn height.
    for (const rows of [13, 14, 15, 18, 30]) expect(height(draw(189, rows, "inline"))).toBe(height(inline));
  });
});

it("isolates registrations and their delayed callbacks", async () => {
  const first = new Harness(); seedLedger(first.fs, "/first", "T-111");
  await first.start("/first"); await first.settle();
  const before = first.render();
  const second = new Harness(); seedLedger(second.fs, "/second", "T-222");
  await second.start("/second"); await second.settle();
  await first.fire("turn.complete"); await first.settle();
  expect(first.render()).toBe(before);
  expect(second.render()).toContain("T-222");
  expect(second.render()).not.toContain("T-111");
});

it("retains the last valid record when stat succeeds but the changed file cannot be read", async () => {
  const h = new Harness(); seedLedger(h.fs, "/repo");
  await h.start("/repo"); await h.settle();
  h.fs.addFile("/repo/.story/tickets/T-001.json", ticket("T-001", "complete"));
  const read = h.$.fs.read;
  h.$.fs.read = async (path: string) => {
    if (path.endsWith("T-001.json")) throw Object.assign(new Error("read refused"), { code: "EIO" });
    return read(path);
  };
  await h.fire("turn.complete"); await h.settle();
  expect(JSON.stringify(findUi(JSON.parse(h.render()), "board-inprogress"))).toContain("T-001");
  h.$.fs.read = read;
  await h.fire("turn.complete"); await h.settle();
  expect(JSON.stringify(findUi(JSON.parse(h.render()), "board-done"))).toContain("T-001");
});

it("uses the running session threshold after settings changes and reload", async () => {
  const h = new Harness(); seedLedger(h.fs, "/repo");
  let setting = 450_000;
  h.$.settings.read = async () => ({ autoCompactWindow: setting });
  h.$.session.usage = async (args: unknown) => {
    expect(args).toEqual({ breakdown: "summary" });
    return { context: { tokens: 384014, window: 1_000_000, percent: 38,
      breakdown: { autoCompactThreshold: 416250 } } };
  };
  await h.start("/repo"); await h.settle();
  expect(findUi(JSON.parse(h.render()), "context").children).toContain("92%");
  setting = 300_000;
  await h.fire("turn.complete"); await h.settle();
  expect(findUi(JSON.parse(h.render()), "context").children).toContain("92%");
  const reloaded = new Harness(); seedLedger(reloaded.fs, "/repo");
  reloaded.$.session.usage = h.$.session.usage;
  reloaded.$.settings.read = h.$.settings.read;
  await reloaded.start("/repo"); await reloaded.settle();
  expect(findUi(JSON.parse(reloaded.render()), "context").children).toContain("92%");
  const fresh = new Harness(); seedLedger(fresh.fs, "/repo");
  fresh.$.session.usage = async () => ({ context: { tokens: 100000, breakdown: { autoCompactThreshold: 277500 } } });
  await fresh.start("/repo"); await fresh.settle();
  expect(findUi(JSON.parse(fresh.render()), "context").children).toContain("36%");
});

it("shows unknown pressure when only native window percent is available", async () => {
  const h = new Harness(); seedLedger(h.fs, "/repo");
  h.$.session.usage = async () => ({ context: { tokens: 384014, percent: 38, window: 1_000_000 } });
  await h.start("/repo"); await h.settle();
  expect(findUi(JSON.parse(h.render()), "context").children).toContain("--");
});

it("collapses short terminals to one line and restores the board on resize", async () => {
  const h = new Harness(); seedLedger(h.fs, "/repo");
  h.$.session.usage = async () => ({ context: { tokens: 42, breakdown: { autoCompactThreshold: 100 } } });
  await h.start("/repo"); await h.settle();
  const render = (rows: number, columns = 100) => h.handlers.get("ui.render")!(h.$, {
    component: "Pane", requestId: PANE_ID, viewport: { rows, columns }, props: { bodyColumns: columns },
  }, () => null);
  const small = render(20) as { key: string; height: number; children: any };
  expect(small.key).toBe("compact-line");
  const content = (node: any): string => typeof node === "string" ? node
    : Array.isArray(node) ? node.map(content).join("") : content(node.children);
  expect(content(small)).toContain("Storybloq  │  In progress  T-001");
  expect(content(small)).toMatch(/42%$/);
  expect(content(small).length).toBe(97);
  expect(findUi(small, "wordmark").bold).toBe(true);
  expect(small.children.some((node: any) => node.color === "cyan")).toBe(true);
  expect(content(render(20, 12))).toContain("42%");
  expect(JSON.stringify(render(40))).toContain("board-inprogress");
});

it("keeps a short dock as an In progress sidebar with a bottom footer", async () => {
  const h = new Harness(); seedLedger(h.fs, "/repo");
  await h.start("/repo"); await h.settle();
  const render = (rows: number) => h.handlers.get("ui.render")!(h.$, {
    component: "Pane", requestId: PANE_ID, viewport: { rows, columns: 160 },
    props: { bodyColumns: 70, placement: "dock", scroll: { bodyRows: rows - 6 } },
  }, () => null);
  const small = render(20) as { key: string; height: number; children: any };
  expect(small.height).toBe(14);
  expect(JSON.stringify(small)).toContain("board-inprogress");
  expect(JSON.stringify(small)).not.toContain("board-open");
  expect(JSON.stringify(small)).not.toContain("board-done");
  expect(findUi(small, "footer-space").flexGrow).toBe(1);
  expect(findUi(small, "footer")).toBeTruthy();
  const tall = render(60) as { height: number; children: any };
  expect(tall.height).toBe(54);
  expect(JSON.stringify(tall)).toContain("board-open");
  expect(findUi(tall, "footer-space").flexGrow).toBe(1);
});

/**
 * T-532: the context gauge moved only at the end of a turn, so a long turn sat
 * on a stale figure. A tool call now refreshes it, at most once per five
 * seconds, and redraws only when the figure changed.
 */
describe("T-532: the context gauge follows tool calls inside a turn", () => {
  const NOW = Date.parse("2026-09-24T12:00:00.000Z");
  const READ = { tool: "Read", file_path: "/repo/src/a.ts" };

  afterEach(() => {
    vi.useRealTimers();
  });

  async function gauge(start = 20) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const h = new Harness(); seedLedger(h.fs, "/repo");
    const usage = { tokens: start, reads: 0 };
    h.$.session.usage = async () => {
      usage.reads += 1;
      return { context: { tokens: usage.tokens, breakdown: { autoCompactThreshold: 100 } } };
    };
    let invalidations = 0;
    h.$.ui.invalidate = () => { invalidations += 1; };
    await h.start("/repo"); await h.settle();
    h.render();
    await h.fire("turn.start", { turnId: "main" });
    return { h, usage, invalidations: () => invalidations };
  }

  const shown = (h: Harness): string => findUi(JSON.parse(h.render()), "context").children;

  it("a tool call inside a turn moves the gauge and redraws once", async () => {
    const { h, usage, invalidations } = await gauge();
    expect(shown(h)).toMatch(/ 20%$/);
    usage.tokens = 90;
    const reads = usage.reads;
    const before = invalidations();
    await h.fire("tool.call", READ);
    expect(usage.reads).toBe(reads + 1);
    expect(invalidations() - before).toBe(1);
    expect(shown(h)).toMatch(/ 90%$/);
  });

  it("reads at most once per five seconds of tool calls", async () => {
    const { h, usage } = await gauge();
    const reads = usage.reads;
    await h.fire("tool.call", READ);
    expect(usage.reads).toBe(reads + 1);
    vi.setSystemTime(NOW + 4_999);
    usage.tokens = 70;
    await h.fire("tool.call", READ);
    expect(usage.reads).toBe(reads + 1);
    expect(shown(h)).toMatch(/ 20%$/);
    vi.setSystemTime(NOW + 5_000);
    await h.fire("tool.call", READ);
    expect(usage.reads).toBe(reads + 2);
    expect(shown(h)).toMatch(/ 70%$/);
  });

  it("concurrent tool calls in one window read once", async () => {
    const { h, usage } = await gauge();
    const reads = usage.reads;
    await Promise.all([h.fire("tool.call", READ), h.fire("tool.call", READ), h.fire("tool.call", READ)]);
    expect(usage.reads).toBe(reads + 1);
  });

  it("an unchanged figure does not redraw", async () => {
    const { h, usage, invalidations } = await gauge();
    const reads = usage.reads;
    const before = invalidations();
    await h.fire("tool.call", READ);
    expect(usage.reads).toBe(reads + 1);
    expect(invalidations()).toBe(before);
  });

  it("turn.complete and session.compact still read inside the tool-call window", async () => {
    const { h, usage } = await gauge();
    await h.fire("tool.call", READ);
    const reads = usage.reads;
    vi.setSystemTime(NOW + 1_000);
    usage.tokens = 55;
    await h.fire("turn.complete", { turnId: "main" });
    expect(usage.reads).toBe(reads + 1);
    expect(shown(h)).toMatch(/ 55%$/);
    usage.tokens = 5;
    await h.fire("session.compact", {});
    expect(usage.reads).toBe(reads + 2);
    expect(shown(h)).toMatch(/ 5%$/);
  });

  it("a ledger-writing tool call still rescans, and the gauge reads with it", async () => {
    const { h, usage } = await gauge();
    usage.tokens = 64;
    h.fs.addFile("/repo/.story/tickets/T-002.json", ticket("T-002", "inprogress"));
    await h.fire("tool.call", { tool: "Write", file_path: "/repo/.story/tickets/T-002.json" });
    await h.settle();
    expect(shown(h)).toMatch(/ 64%$/);
    expect(JSON.stringify(findUi(JSON.parse(h.render()), "board-inprogress"))).toContain("T-002");
  });

  it("does not read the gauge while the Mod is off or has no ledger", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const h = new Harness();
    let reads = 0;
    h.$.session.usage = async () => { reads += 1; return {}; };
    await h.fire("tool.call", READ);
    expect(reads).toBe(0);
    h.fs.addDir("/empty");
    await h.start("/empty"); await h.settle();
    const after = reads;
    await h.fire("tool.call", READ);
    expect(reads).toBe(after);
  });

  /** A usage stub whose next read waits on the test. */
  function deferredUsage(h: Harness) {
    const pending: ((tokens: number) => void)[] = [];
    let live: number | null = null;
    h.$.session.usage = () => {
      if (live !== null) return Promise.resolve({ context: { tokens: live, breakdown: { autoCompactThreshold: 100 } } });
      return new Promise((resolve) => {
        pending.push((tokens) => resolve({ context: { tokens, breakdown: { autoCompactThreshold: 100 } } }));
      });
    };
    return {
      /** Settles the oldest pending read with `tokens`. */
      resolve: (tokens: number) => pending.shift()!(tokens),
      /** From now on reads answer at once with `tokens`. */
      answer: (tokens: number | null) => { live = tokens; },
      pending: () => pending.length,
    };
  }

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  it("a second session.start on the same dashboard resets the throttle", async () => {
    const { h, usage } = await gauge();
    await h.fire("tool.call", READ);
    vi.setSystemTime(NOW + 1_000);
    await h.start("/repo"); await h.settle();
    const reads = usage.reads;
    vi.setSystemTime(NOW + 2_000);
    await h.fire("tool.call", READ);
    expect(usage.reads).toBe(reads + 1);
  });

  it("a tool-call read overtaken by session.compact never restores the older figure", async () => {
    const { h, invalidations } = await gauge();
    const usage = deferredUsage(h);
    const call = h.fire("tool.call", READ);
    await flush();
    expect(usage.pending()).toBe(1);
    usage.answer(5);
    await h.fire("session.compact", {});
    expect(shown(h)).toMatch(/ 5%$/);
    const before = invalidations();
    usage.resolve(99);
    await call;
    expect(shown(h)).toMatch(/ 5%$/);
    expect(invalidations()).toBe(before);
  });

  it("a tool-call read that lands during a restart's root discovery is dropped", async () => {
    const { h, invalidations } = await gauge();
    const usage = deferredUsage(h);
    const call = h.fire("tool.call", READ);
    await flush();
    expect(usage.pending()).toBe(1);
    // Hold the restart inside root discovery.
    const exists = h.$.fs.exists;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    h.$.fs.exists = async (path: string) => { await held; return exists(path); };
    const restart = h.start("/repo");
    await flush();
    const before = invalidations();
    usage.resolve(99);
    await call;
    expect(shown(h)).toMatch(/ 20%$/);
    expect(invalidations()).toBe(before);
    h.$.fs.exists = exists;
    usage.answer(30);
    release();
    await restart; await h.settle();
    expect(shown(h)).toMatch(/ 30%$/);
  });

  it("a tool-call read that lands after a restart into a directory with no ledger is dropped", async () => {
    const { h, invalidations } = await gauge();
    const usage = deferredUsage(h);
    const call = h.fire("tool.call", READ);
    await flush();
    expect(usage.pending()).toBe(1);
    h.fs.addDir("/elsewhere");
    await h.start("/elsewhere"); await h.settle();
    const before = invalidations();
    usage.resolve(99);
    await call;
    expect(invalidations()).toBe(before);
    expect(usage.pending()).toBe(0);
  });

  it("never reads usage while drawing", async () => {
    const { h, usage } = await gauge();
    const reads = usage.reads;
    for (let i = 0; i < 5; i += 1) h.render();
    expect(usage.reads).toBe(reads);
  });
});

/**
 * T-531: a `/story auto` session shows its stage on the In progress card,
 * read from `.story/status.json` alone. T-532: the footer line is gone, the
 * labels are short, an ISSUE_FIX session tags its issue card, and a session
 * whose item no drawn card carries tags the In progress heading instead.
 *
 * The native `claude plugin test` suite (`sidebar.test.ts`) does not pass at
 * 81e42701 (ARCHITECTURE.md: it needs repair before it can gate), so these
 * fixtures live here, in the harness the default vitest run executes. The
 * inactive board is pinned against golden files rendered at 81e42701, before
 * any of this existed, with the Mod's version normalized so a release bump
 * does not break them.
 */
describe("T-531 and T-532: the autonomous stage on the in-progress card or heading", () => {
  const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
  const HEADING = "board-inprogress-heading";

  afterEach(() => {
    vi.useRealTimers();
  });

  function live(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: 1,
      sessionActive: true,
      sessionId: "s-1",
      state: "IMPLEMENT",
      ticket: "T-001",
      ticketTitle: "Ticket T-001",
      claudeStatus: "working",
      observedAt: new Date().toISOString(),
      ...over,
    };
  }

  function without(key: string): Record<string, unknown> {
    const status = live();
    delete status[key];
    return status;
  }

  async function booted(status: unknown, seed?: (h: Harness) => void): Promise<Harness> {
    const h = new Harness();
    seedLedger(h.fs, "/repo");
    seed?.(h);
    if (status !== undefined) {
      h.fs.addFile("/repo/.story/status.json", typeof status === "string" ? status : JSON.stringify(status));
    }
    await h.start("/repo");
    await h.settle();
    return h;
  }

  function draw(h: Harness, width: number, placement: "dock" | "inline" | null, rows = 40): any {
    const props: Record<string, unknown> = { bodyColumns: width, scroll: { offset: 0, bodyRows: 30 } };
    if (placement !== null) props["placement"] = placement;
    return h.handlers.get("ui.render")!(
      h.$,
      { component: "Pane", requestId: PANE_ID, viewport: { columns: width + 4, rows }, props },
      (e: any) => e,
    );
  }

  /** The three counted rows: no viewport rows, and a pane too short for a frame. */
  function drawCompact(h: Harness, width = 156): any {
    return h.handlers.get("ui.render")!(
      h.$,
      { component: "Pane", requestId: PANE_ID, props: { bodyColumns: width, placement: "inline", scroll: { offset: 0, bodyRows: 5 } } },
      (e: any) => e,
    );
  }

  /** The text a node draws, its runs joined. */
  function textOf(node: any): string {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (node && typeof node === "object") return textOf(node.children);
    return "";
  }

  /** Every string a tree draws, leaf by leaf. */
  function leaves(node: any, out: string[] = []): string[] {
    if (typeof node === "string") out.push(node);
    else if (Array.isArray(node)) for (const child of node) leaves(child, out);
    else if (node && typeof node === "object") leaves(node.children, out);
    return out;
  }

  /** Card tags: "[Code] " runs, not the blocked markers. */
  function tagCount(tree: any): number {
    return leaves(tree).filter((text) => /^\[[^\]]*\] $/.test(text) && text !== "[Blocked] " && text !== "[!] ").length;
  }

  /** Heading tags: " [Code]" runs. */
  function headingTags(tree: any): string[] {
    return leaves(tree).filter((text) => /^ \[.*\]$/.test(text));
  }

  /** The run that draws a heading tag inside `node`, if any. */
  function headingRun(node: any): any {
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = headingRun(child);
        if (hit) return hit;
      }
      return undefined;
    }
    if (node && typeof node === "object") {
      if (typeof node.children === "string" && /^ \[.*\]$/.test(node.children)) return node;
      return headingRun(node.children);
    }
    return undefined;
  }

  /** No footer session line of either T-531 form, anywhere. */
  function expectNoFooter(tree: any, where: string): void {
    for (const text of leaves(tree)) {
      expect(text, where).not.toBe("an autonomous session is active");
      expect(text.startsWith("auto:"), where).toBe(false);
    }
  }

  function golden(tree: any): string {
    return JSON.stringify(tree, null, 2).split(MOD_VERSION).join("<MOD_VERSION>") + "\n";
  }

  const LAYOUTS = [[40, "dock", 40], [156, "inline", 40], [40, null, 40], [45, "inline", 40], [40, "dock", 20]] as const;

  it("a live IMPLEMENT on T-001 tags that card, and no layout draws a footer session line", async () => {
    const h = await booted(live());
    for (const [width, placement, rows] of LAYOUTS) {
      const tree = draw(h, width, placement, rows);
      const where = `${placement}@${width}x${rows}`;
      const row = findUi(tree, "ticket:T-001");
      expect(textOf(row), where).toBe("T-001 [Code] Ticket T-001");
      expect(row.children[1], where).toMatchObject({ children: "[Code] ", color: "cyan" });
      expect(row.children[1].dimColor, where).toBeFalsy();
      expect(row.children[0], where).toMatchObject({ children: "T-001 ", dimColor: true });
      expect(tagCount(tree), where).toBe(1);
      expect(headingTags(tree), where).toEqual([]);
      expectNoFooter(tree, where);
      // The Open card is never tagged.
      const open = findUi(tree, "ticket:T-002");
      if (open) expect(textOf(open), where).not.toContain("[Code]");
    }
    expectNoFooter(drawCompact(h), "compact");
  });

  it("labels the other stages through the same table", async () => {
    for (const [state, label] of [["PLAN_REVIEW", "Review"], ["CODE_REVIEW", "Review"], ["WRITE_TESTS", "Tests"], ["FINALIZE", "Commit"], ["COMPACT", "Compacted"]]) {
      const h = await booted(live({ state }));
      const tree = draw(h, 156, "inline");
      expect(textOf(findUi(tree, "ticket:T-001"))).toBe(`T-001 [${label}] Ticket T-001`);
      expectNoFooter(tree, state);
    }
  });

  it("draws the inactive board exactly as 81e42701 did", async () => {
    const h = await booted({ sessionActive: false });
    await expect(golden(draw(h, 40, "dock"))).toMatchFileSnapshot("./__golden__/t531-inactive-dock-40.json");
    await expect(golden(draw(h, 156, "inline"))).toMatchFileSnapshot("./__golden__/t531-inactive-inline-156.json");
    await expect(golden(draw(h, 45, "inline"))).toMatchFileSnapshot("./__golden__/t531-inactive-inline-45.json");
  });

  it("an inactive status with stray session fields draws byte-identically to a bare one", async () => {
    const bare = await booted({ sessionActive: false });
    const stray = await booted({ ...live(), sessionActive: false, currentIssue: { id: "ISS-001", displayId: "ISS-001" } });
    const missing = await booted(undefined);
    // The last case is the short docked sidebar (a 20-row terminal).
    for (const [width, placement, rows] of [[40, "dock", 40], [156, "inline", 40], [45, "inline", 40], [40, "dock", 20]] as const) {
      const expected = JSON.stringify(draw(bare, width, placement, rows));
      expect(JSON.stringify(draw(stray, width, placement, rows))).toBe(expected);
      expect(JSON.stringify(draw(missing, width, placement, rows))).toBe(expected);
    }
    expect(JSON.stringify(drawCompact(stray))).toBe(JSON.stringify(drawCompact(bare)));
  });

  // With no usable state nothing reads `sessionActive`, so whether a malformed
  // state keeps it true is not observable in a draw.
  it("a malformed state gives no tag anywhere", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["missing", without("state")],
      ["number", live({ state: 42 })],
      ["empty", live({ state: "" })],
      ["underscores", live({ state: "___" })],
      ["blank", live({ state: "   " })],
      ["object", live({ state: { name: "IMPLEMENT" } })],
      ["controls only", live({ state: "\u001b\u0007\u009b" })],
    ];
    for (const [name, status] of cases) {
      const h = await booted(status);
      for (const [width, placement] of [[40, "dock"], [45, "inline"]] as const) {
        const tree = draw(h, width, placement);
        expect(textOf(findUi(tree, "ticket:T-001")), name).toBe("T-001 Ticket T-001");
        expect(tagCount(tree), name).toBe(0);
        expect(headingTags(tree), name).toEqual([]);
        expectNoFooter(tree, name);
      }
    }
  });

  it("a valid state with no usable ticket or issue tags the In progress heading", async () => {
    const cases: [string, Record<string, unknown>][] = [
      ["missing", without("ticket")],
      ["null", live({ ticket: null })],
      ["number", live({ ticket: 1 })],
      ["empty", live({ ticket: "" })],
      ["object", live({ ticket: { id: "T-001" } })],
      ["issue not an object", live({ ticket: null, currentIssue: "ISS-001" })],
      ["issue without ids", live({ ticket: null, currentIssue: { title: "x" } })],
    ];
    for (const [name, status] of cases) {
      const h = await booted(status);
      const tree = draw(h, 40, "dock");
      expect(textOf(findUi(tree, "ticket:T-001")), name).toBe("T-001 Ticket T-001");
      expect(tagCount(tree), name).toBe(0);
      expect(textOf(findUi(tree, HEADING)), name).toBe("In progress 1 [Code]");
      expect(headingRun(findUi(tree, HEADING)), name).toMatchObject({ children: " [Code]", color: "cyan" });
    }
  });

  it("unreadable status text draws no session at all, as before", async () => {
    for (const text of ["null", "{not json", "[]", '"IMPLEMENT"', "42"]) {
      const h = await booted(text);
      const tree = draw(h, 40, "dock");
      expect(tagCount(tree), text).toBe(0);
      expect(headingTags(tree), text).toEqual([]);
    }
  });

  it("never draws a control sequence or a line break from status.json", async () => {
    const h = await booted(live({
      state: "EVIL\u001b]0;pwn\u0007_STATE\r\nX",
      ticket: "T-001\u001b[2J\u2028",
      currentIssue: { id: "ISS-001\u001b[2J", displayId: "ISS-001\u0007" },
    }));
    for (const [width, placement] of [[40, "dock"], [156, "inline"], [45, "inline"]] as const) {
      const tree = draw(h, width, placement);
      for (const text of leaves(tree)) expect(text).not.toMatch(UNSAFE);
      // The raw id is what matches, and no card id carries a control
      // character, so the stage goes to the heading, made safe.
      expect(tagCount(tree)).toBe(0);
      expect(headingTags(tree)).toEqual([" [evil ]0;pwn state x]"]);
    }
  });

  it("tags the heading, not a card, when no drawn in-progress card is the session's own", async () => {
    const cases: [string, Record<string, unknown>, ((h: Harness) => void) | undefined][] = [
      ["not on the board", live({ ticket: "T-404" }), undefined],
      ["open, not in progress", live({ ticket: "T-002" }), undefined],
      ["two in-progress cards share the id", live(), (h) => {
        h.fs.addFile("/repo/.story/tickets/t-dup.json", JSON.stringify({
          id: "t-dup", displayId: "T-001", title: "Twin", type: "task", status: "inprogress", phase: "p1", order: 2,
        }));
      }],
      ["a ticket id never tags an issue card", live({ ticket: "ISS-001" }), (h) => {
        h.fs.addFile("/repo/.story/issues/ISS-001.json", JSON.stringify({
          id: "ISS-001", displayId: "ISS-001", title: "Issue ISS-001", severity: "high", status: "inprogress",
        }));
      }],
      ["an issue id never tags a ticket card", live({ ticket: null, state: "ISSUE_FIX", currentIssue: { id: "T-001", displayId: "T-001" } }), undefined],
    ];
    for (const [name, status, seed] of cases) {
      const h = await booted(status, seed);
      const label = status["state"] === "ISSUE_FIX" ? "Fix" : "Code";
      for (const [width, placement] of [[40, "dock"], [156, "inline"]] as const) {
        const tree = draw(h, width, placement);
        const where = `${name} ${placement}@${width}`;
        expect(tagCount(tree), where).toBe(0);
        expect(headingTags(tree), where).toEqual([` [${label}]`]);
        expect(textOf(findUi(tree, HEADING)), where).toMatch(new RegExp(`^In progress \\d+ \\[${label}\\]$`));
        expectNoFooter(tree, where);
      }
      const narrow = draw(h, 45, "inline");
      expect(tagCount(narrow), name).toBe(0);
      expect(textOf(findUi(narrow, "narrow-heading")), name).toMatch(new RegExp(`^In progress \\d+ \\[${label}\\]$`));
    }
  });

  it("an ISSUE_FIX session tags its issue card by display id, falling back to the id", async () => {
    const inProgressIssue = (id: string, displayId?: string) => (h: Harness) => {
      h.fs.addFile(`/repo/.story/issues/${id}.json`, JSON.stringify({
        id, ...(displayId ? { displayId } : {}), title: `Issue ${displayId ?? id}`, severity: "high", status: "inprogress",
      }));
    };
    const cases: [string, Record<string, unknown>, (h: Harness) => void, string, string][] = [
      ["legacy id", { id: "ISS-001", displayId: "ISS-001", title: "t", severity: "high" }, inProgressIssue("ISS-001", "ISS-001"), "issue:ISS-001", "ISS-001"],
      ["hash id by key", { id: "i-abc", displayId: "ISS-009", title: "t", severity: "high" }, inProgressIssue("i-abc", "ISS-009"), "issue:i-abc", "ISS-009"],
      ["no display id", { id: "ISS-001", title: "t", severity: "high" }, inProgressIssue("ISS-001", "ISS-001"), "issue:ISS-001", "ISS-001"],
      ["display id alone matches", { id: "i-gone", displayId: "ISS-009", title: "t", severity: "high" }, inProgressIssue("i-abc", "ISS-009"), "issue:i-abc", "ISS-009"],
    ];
    for (const [name, currentIssue, seed, key, shown] of cases) {
      const h = await booted(live({ ticket: null, state: "ISSUE_FIX", currentIssue }), seed);
      for (const [width, placement] of [[40, "dock"], [156, "inline"], [45, "inline"]] as const) {
        const tree = draw(h, width, placement);
        const where = `${name} ${placement}@${width}`;
        const row = findUi(tree, key);
        expect(textOf(row), where).toBe(`${shown} [Fix] Issue ${shown}`);
        expect(tagCount(tree), where).toBe(1);
        expect(headingTags(tree), where).toEqual([]);
        expect(textOf(findUi(tree, "ticket:T-001")), where).toBe("T-001 Ticket T-001");
      }
    }
  });

  it("an issue's canonical id picks it out of drawn display-id twins", async () => {
    const h = await booted(live({ ticket: null, state: "ISSUE_FIX", currentIssue: { id: "i-two", displayId: "ISS-050" } }), (hh) => {
      hh.fs.addFile("/repo/.story/issues/i-one.json", JSON.stringify({ id: "i-one", displayId: "ISS-050", title: "One", severity: "high", status: "inprogress" }));
      hh.fs.addFile("/repo/.story/issues/i-two.json", JSON.stringify({ id: "i-two", displayId: "ISS-050", title: "Two", severity: "high", status: "inprogress" }));
    });
    const tree = draw(h, 156, "inline");
    expect(textOf(findUi(tree, "issue:i-two"))).toBe("ISS-050 [Fix] Two");
    expect(textOf(findUi(tree, "issue:i-one"))).toBe("ISS-050 One");
    expect(headingTags(tree)).toEqual([]);
    // By display id alone the twins are ambiguous: the heading, not a guess.
    const guess = await booted(live({ ticket: null, state: "ISSUE_FIX", currentIssue: { id: "i-gone", displayId: "ISS-050" } }), (hh) => {
      hh.fs.addFile("/repo/.story/issues/i-one.json", JSON.stringify({ id: "i-one", displayId: "ISS-050", title: "One", severity: "high", status: "inprogress" }));
      hh.fs.addFile("/repo/.story/issues/i-two.json", JSON.stringify({ id: "i-two", displayId: "ISS-050", title: "Two", severity: "high", status: "inprogress" }));
    });
    const guessed = draw(guess, 156, "inline");
    expect(tagCount(guessed)).toBe(0);
    expect(headingTags(guessed)).toEqual([" [Fix]"]);
  });

  it("an issue the status no longer names stops tagging its card", async () => {
    const h = await booted(live({ ticket: null, state: "ISSUE_FIX", currentIssue: { id: "ISS-001", displayId: "ISS-001" } }), (hh) => {
      hh.fs.addFile("/repo/.story/issues/ISS-001.json", JSON.stringify({ id: "ISS-001", displayId: "ISS-001", title: "Issue ISS-001", severity: "high", status: "inprogress" }));
    });
    expect(textOf(findUi(draw(h, 156, "inline"), "issue:ISS-001"))).toBe("ISS-001 [Fix] Issue ISS-001");
    h.fs.addFile("/repo/.story/status.json", JSON.stringify(live({ ticket: null, state: "PICK_TICKET" })));
    await h.fire("turn.complete", {}); await h.settle();
    const tree = draw(h, 156, "inline");
    expect(textOf(findUi(tree, "issue:ISS-001"))).toBe("ISS-001 Issue ISS-001");
    expect(headingTags(tree)).toEqual([" [Pick]"]);
  });

  it("resolves the session's card against the whole column before asking whether it is drawn", async () => {
    const filler = (h: Harness, count: number) => {
      for (let i = 2; i < 2 + count; i += 1) {
        h.fs.addFile(`/repo/.story/tickets/T-10${i}.json`, JSON.stringify({
          id: `T-10${i}`, displayId: `T-10${i}`, title: `Filler ${i}`, type: "task", status: "inprogress", phase: "p1", order: i,
        }));
      }
    };
    // A duplicate display id straddling the cap: T-001 is drawn, its twin is not.
    const straddle = await booted(live(), (h) => {
      filler(h, 6);
      h.fs.addFile("/repo/.story/tickets/t-dup.json", JSON.stringify({
        id: "t-dup", displayId: "T-001", title: "Twin", type: "task", status: "inprogress", phase: "p1", order: 99,
      }));
    });
    let tree = draw(straddle, 156, "inline");
    expect(findUi(tree, "ticket:t-dup")).toBeUndefined();
    expect(textOf(findUi(tree, "ticket:T-001"))).toBe("T-001 Ticket T-001");
    expect(tagCount(tree)).toBe(0);
    expect(headingTags(tree)).toEqual([" [Code]"]);
    // A capped canonical issue with a drawn display-id twin: the twin is not it.
    const capped = await booted(live({ ticket: null, state: "ISSUE_FIX", currentIssue: { id: "i-cap", displayId: "ISS-050" } }), (h) => {
      filler(h, 4);
      h.fs.addFile("/repo/.story/issues/i-twin.json", JSON.stringify({ id: "i-twin", displayId: "ISS-050", title: "Twin", severity: "critical", status: "inprogress" }));
      h.fs.addFile("/repo/.story/issues/i-cap.json", JSON.stringify({ id: "i-cap", displayId: "ISS-050", title: "Capped", severity: "low", status: "inprogress" }));
    });
    tree = draw(capped, 156, "inline");
    expect(findUi(tree, "issue:i-twin")).toBeDefined();
    expect(findUi(tree, "issue:i-cap")).toBeUndefined();
    expect(tagCount(tree)).toBe(0);
    expect(headingTags(tree)).toEqual([" [Fix]"]);
    // One card leaves the column, the capped issue is drawn, and it carries the tag itself.
    capped.fs.addFile("/repo/.story/tickets/T-102.json", JSON.stringify({
      id: "T-102", displayId: "T-102", title: "Filler 2", type: "task", status: "open", phase: "p1", order: 2,
    }));
    await capped.fire("turn.complete", {}); await capped.settle();
    tree = draw(capped, 156, "inline");
    expect(textOf(findUi(tree, "issue:i-cap"))).toBe("ISS-050 [Fix] Capped");
    expect(textOf(findUi(tree, "issue:i-twin"))).toBe("ISS-050 Twin");
    expect(tagCount(tree)).toBe(1);
    expect(headingTags(tree)).toEqual([]);
  });

  it("the heading tag drops before the count is cut", async () => {
    const h = await booted(live({ ticket: "T-404" }));
    // "In progress 1 [Code]" is twenty cells.
    expect(textOf(findUi(draw(h, 20, "inline"), "narrow-heading"))).toBe("In progress 1 [Code]");
    for (const width of [19, 16, 12]) {
      const tree = draw(h, width, "inline");
      const text = textOf(findUi(tree, "narrow-heading"));
      expect(text, String(width)).not.toContain("[Code]");
      expect(text.endsWith(" 1"), String(width)).toBe(true);
      expect(headingTags(tree), String(width)).toEqual([]);
    }
    // Framed: the column's text width is two cells less than the column.
    const dock = draw(h, 22, "dock");
    expect(textOf(findUi(dock, HEADING))).toBe("In progress 1 [Code]");
    expect(headingTags(draw(h, 21, "dock"))).toEqual([]);
  });

  it("the three counted rows carry the stage on the In progress row", async () => {
    const h = await booted(live());
    const tree = drawCompact(h);
    expect(findUi(tree, "board-open")).toBeDefined();
    expect(textOf(findUi(tree, "board-inprogress"))).toBe("In progress 1 [Code]");
    expect(textOf(findUi(tree, "board-open"))).not.toContain("[");
    expect(textOf(findUi(tree, "board-done"))).not.toContain("[");
    expectNoFooter(tree, "compact");
  });

  it("marks a status older than the presence TTL as uncertain, dimmed with a question mark", async () => {
    const now = Date.parse("2026-09-23T12:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const stale = await booted(live({ observedAt: new Date(now - 12 * 60 * 60 * 1000 - 60_000).toISOString() }));
    for (const [width, placement] of [[40, "dock"], [156, "inline"], [45, "inline"]] as const) {
      const tree = draw(stale, width, placement);
      const row = findUi(tree, "ticket:T-001");
      expect(textOf(row)).toBe("T-001 [Code?] Ticket T-001");
      expect(row.children[1]).toMatchObject({ children: "[Code?] ", dimColor: true });
      expect(row.children[1].color).not.toBe("cyan");
    }
    const fresh = await booted(live({ observedAt: new Date(now - 60 * 60 * 1000).toISOString() }));
    expect(textOf(findUi(draw(fresh, 40, "dock"), "ticket:T-001"))).toBe("T-001 [Code] Ticket T-001");
    // Only the state parsed, stale: the heading says so the same way.
    const alone = await booted({ ...without("ticket"), observedAt: new Date(now - 13 * 60 * 60 * 1000).toISOString() });
    const heading = findUi(draw(alone, 40, "dock"), HEADING);
    expect(textOf(heading)).toBe("In progress 1 [Code?]");
    const run = headingRun(heading);
    expect(run).toMatchObject({ children: " [Code?]", dimColor: true });
    expect(run.color).not.toBe("cyan");
  });

  it("the narrow strip truncates the title, never the id or the tag", async () => {
    const long = "Native canvas, document objects, and local saving";
    const h = await booted(live(), (hh) => {
      hh.fs.addFile("/repo/.story/tickets/T-001.json", JSON.stringify({
        id: "T-001", displayId: "T-001", title: long, type: "task", status: "inprogress", phase: "p1", order: 1,
      }));
    });
    const tree = draw(h, 45, "inline");
    expect(findUi(tree, "narrow-heading")).toBeDefined();
    const text = textOf(findUi(tree, "ticket:T-001"));
    expect(text.startsWith("T-001 [Code] Native canvas")).toBe(true);
    expect(text.endsWith("…")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(45);
    expectNoFooter(tree, "narrow");
  });

  it("drops the card tag before the id when the two do not fit", async () => {
    const h = await booted(live());
    // 15 cells hold "T-001 [Code] " and the two title cells the row keeps.
    const fits = textOf(findUi(draw(h, 15, "inline"), "ticket:T-001"));
    expect(fits.startsWith("T-001 [Code] ")).toBe(true);
    for (const width of [14, 12, 9]) {
      const tree = draw(h, width, "inline");
      const text = textOf(findUi(tree, "ticket:T-001"));
      expect(text.startsWith("T-001 "), String(width)).toBe(true);
      expect(text, String(width)).not.toContain("[Code");
      expect(tagCount(tree), String(width)).toBe(0);
      // A matched card that cannot hold its tag does not send it to the heading.
      expect(headingTags(tree), String(width)).toEqual([]);
    }
  });

  it("keeps the tag beside a blocked marker when both fit", async () => {
    const h = await booted(live(), (hh) => {
      hh.fs.addFile("/repo/.story/tickets/T-001.json", JSON.stringify({
        id: "T-001", displayId: "T-001", title: "Ticket T-001", type: "task", status: "inprogress", phase: "p1", order: 1, blockedBy: ["T-002"],
      }));
    });
    const row = findUi(draw(h, 156, "inline"), "ticket:T-001");
    expect(textOf(row)).toBe("T-001 [Code] [Blocked] Ticket T-001");
    expect(row.children[2]).toMatchObject({ children: "[Blocked] ", color: "yellow" });
    // Docked at 40 the column holds 38 cells.
    expect(textOf(findUi(draw(h, 40, "dock"), "ticket:T-001"))).toBe("T-001 [Code] [Blocked] Ticket T-001");
    // The marker counts: 19 cells hold "T-001 [Code] [!] " and two title
    // cells, 18 do not, and the tag goes before the id is shortened.
    const fits = textOf(findUi(draw(h, 19, "inline"), "ticket:T-001"));
    expect(fits.startsWith("T-001 [Code] [!] ")).toBe(true);
    const tight = draw(h, 18, "inline");
    const text = textOf(findUi(tight, "ticket:T-001"));
    expect(text.startsWith("T-001 [!] ")).toBe(true);
    expect(text).not.toContain("[Code");
    expect(tagCount(tight)).toBe(0);
  });

  it("the narrow Open fallback gains an In progress row for an active stage, within five rows", async () => {
    const openOnly = (hh: Harness) => { hh.fs.addFile("/repo/.story/tickets/T-001.json", ticket("T-001", "open")); };
    const h = await booted(live({ state: "PICK_TICKET", ticket: null }), openOnly);
    const tree = draw(h, 45, "inline");
    const board = findUi(tree, "board");
    expect(textOf(findUi(tree, "narrow-stage-heading"))).toBe("In progress 0 [Pick]");
    expect(textOf(findUi(tree, "narrow-heading"))).toMatch(/^Open 3$/);
    expect(board.children.map((row: any) => row.key)).toEqual(["narrow-stage-heading", "narrow-heading", "narrow-card-0", "narrow-card-1", "narrow-tail"]);
    expect(textOf(findUi(tree, "narrow-tail"))).toBe("... 1 more");
    // The Open cards never carry the stage, even the session's own ticket.
    const same = await booted(live(), openOnly);
    const sameTree = draw(same, 45, "inline");
    expect(textOf(findUi(sameTree, "ticket:T-001"))).toBe("T-001 Ticket T-001");
    expect(tagCount(sameTree)).toBe(0);
    expect(headingTags(sameTree)).toEqual([" [Code]"]);
    // Too narrow for the tag, and inactive: exactly today's fallback.
    const inactive = await booted({ sessionActive: false }, openOnly);
    for (const width of [45, 19]) {
      expect(JSON.stringify(draw(inactive, width, "inline")), String(width)).not.toContain("narrow-stage-heading");
    }
    expect(JSON.stringify(draw(h, 19, "inline"))).toBe(JSON.stringify(draw(inactive, 19, "inline")));
  });

  it("the short docked sidebar tags the card too", async () => {
    const h = await booted(live());
    const tree = draw(h, 40, "dock", 20);
    expect(findUi(tree, "short-sidebar")).toBeDefined();
    expect(textOf(findUi(tree, "ticket:T-001"))).toBe("T-001 [Code] Ticket T-001");
    expectNoFooter(tree, "short dock");
  });
});

describe("ISS-1306: ledger titles are drawn display-safe", () => {
  const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
  const TITLES: Record<string, [string, string]> = {
    "T-001": ["Red \u001b[31malert\u001b[0m", "Red  [31malert [0m"],
    "T-002": ["abc\u202edcba", "abc dcba"],
    "ISS-001": ["nul\u0000byte", "nul byte"],
  };

  function leaves(node: any, out: string[] = []): string[] {
    if (typeof node === "string") out.push(node);
    else if (Array.isArray(node)) for (const child of node) leaves(child, out);
    else if (node && typeof node === "object") leaves(node.children, out);
    return out;
  }

  function textOf(node: any): string {
    return leaves(node).join("");
  }

  function draw(h: Harness, width: number, placement: "dock" | "inline"): any {
    return h.handlers.get("ui.render")!(
      h.$,
      { component: "Pane", requestId: PANE_ID, viewport: { columns: width + 4, rows: 40 }, props: { bodyColumns: width, placement, scroll: { offset: 0, bodyRows: 30 } } },
      (e: any) => e,
    );
  }

  function seedUnsafe(fs: FakeFs): void {
    seedLedger(fs, "/repo");
    const t1 = JSON.parse(ticket("T-001", "inprogress"));
    t1.title = TITLES["T-001"]![0];
    fs.addFile("/repo/.story/tickets/T-001.json", JSON.stringify(t1));
    const t2 = JSON.parse(ticket("T-002", "open"));
    t2.title = TITLES["T-002"]![0];
    fs.addFile("/repo/.story/tickets/T-002.json", JSON.stringify(t2));
    const i1 = JSON.parse(issue("ISS-001", "high"));
    i1.title = TITLES["ISS-001"]![0];
    fs.addFile("/repo/.story/issues/ISS-001.json", JSON.stringify(i1));
  }

  it("draws no raw control, line-break or bidi code point, and every row fits its width", async () => {
    const h = new Harness();
    seedUnsafe(h.fs);
    await h.start("/repo");
    await h.settle();
    for (const [width, placement] of [[40, "dock"], [156, "inline"], [45, "inline"]] as const) {
      const tree = draw(h, width, placement);
      const where = `${placement}@${width}`;
      for (const text of leaves(tree)) expect(text, where).not.toMatch(UNSAFE);
      const row = findUi(tree, "ticket:T-001");
      expect(row, where).toBeTruthy();
      expect(textOf(row), where).toContain(TITLES["T-001"]![1].slice(0, 8));
      expect(cellWidth(textOf(row)), where).toBeLessThanOrEqual(width);
      const heading = findUi(tree, "board-inprogress-heading") ?? findUi(tree, "narrow-heading");
      expect(textOf(heading), where).toMatch(/^In progress 1$/);
    }
    const wide = draw(h, 156, "inline");
    expect(textOf(findUi(wide, "ticket:T-001"))).toContain(TITLES["T-001"]![1]);
    expect(textOf(findUi(wide, "ticket:T-002"))).toContain(TITLES["T-002"]![1]);
    expect(textOf(findUi(wide, "issue:ISS-001"))).toContain(TITLES["ISS-001"]![1]);
  });

  it("cleans a title cached by an earlier version, without re-reading the file", async () => {
    const h = new Harness();
    seedLedger(h.fs, "/repo");
    const mtimeMs = (await h.fs.stat("/repo/.story/tickets/T-001.json")).mtimeMs;
    h.store.set("sidebar-ledger-cache-v1", {
      ".story/tickets/T-001.json": {
        mtimeMs,
        record: {
          kind: "ticket", id: "T-001", displayId: "T-001", previousDisplayIds: [], title: "Cached\u001b[2Jtitle\u202e",
          status: "inprogress", phase: "p1", parentTicket: null, blockedBy: [], lifecycle: null, order: 1,
        },
      },
    });
    await h.start("/repo");
    await h.settle();
    const tree = draw(h, 156, "inline");
    expect(textOf(findUi(tree, "ticket:T-001"))).toContain("Cached [2Jtitle");
    for (const text of leaves(tree)) expect(text).not.toMatch(UNSAFE);
  });
});
