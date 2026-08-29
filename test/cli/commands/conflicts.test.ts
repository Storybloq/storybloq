import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleConflictsList, handleConflictsShow, handleResolve } from "../../../src/cli/commands/conflicts.js";
import { writeTicket as writeTicketLocked } from "../../../src/core/project-loader.js";

type Json = Record<string, unknown>;

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "conflicts-cli-"));
  const story = join(dir, ".story");
  for (const sub of ["tickets", "issues", "notes", "lessons", "handovers"]) {
    mkdirSync(join(story, sub), { recursive: true });
  }
  writeConfig(dir, {});
  writeRoadmap(dir, {});
  return dir;
}

function writeConfig(dir: string, overrides: Json): void {
  writeFileSync(join(dir, ".story", "config.json"), JSON.stringify({
    version: 2, project: "test", type: "npm", language: "ts",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
    ...overrides,
  }, null, 2) + "\n");
}

function writeRoadmap(dir: string, overrides: Json): void {
  writeFileSync(join(dir, ".story", "roadmap.json"), JSON.stringify({
    title: "test", date: "2026-01-01",
    phases: [
      { id: "p1", label: "P1", name: "Alpha", description: "First." },
      { id: "p2", label: "P2", name: "Beta", description: "Second." },
    ],
    blockers: [],
    ...overrides,
  }, null, 2) + "\n");
}

function writeTicketFile(dir: string, id: string, overrides: Json): void {
  writeFileSync(join(dir, ".story", "tickets", `${id}.json`), JSON.stringify({
    id, title: `Ticket ${id}`, description: "", type: "task", status: "open",
    phase: "p1", order: 10, createdDate: "2026-01-01", completedDate: null,
    blockedBy: [], parentTicket: null, ...overrides,
  }, null, 2) + "\n");
}

function writeArrangementFile(dir: string, id: string, overrides: Json): void {
  mkdirSync(join(dir, ".story", "arrangements"), { recursive: true });
  writeFileSync(join(dir, ".story", "arrangements", `${id}.json`), JSON.stringify({
    id,
    lifecycle: "active",
    bounds: ["T-001"],
    parties: [
      { role: "pen", client: "claude", identityAnchor: "pen-session" },
      { role: "worker", client: "claude", identityAnchor: "worker-session" },
    ],
    gates: [],
    unreachability: { onIrreversibleWork: "hold" },
    createdDate: "2026-08-27",
    updatedAt: "2026-08-27T00:00:00.000Z",
    ...overrides,
  }, null, 2) + "\n");
}

const titleConflict = (): Json => ({
  fieldPath: "/title", field: "title", kind: "field", base: "Old", ours: "Ours title", theirs: "Theirs title",
});

describe("ISS-749: config/roadmap conflict targets", () => {
  it("conflicts show accepts config.json and the config alias", async () => {
    const dir = makeProject();
    writeConfig(dir, { _conflicts: [{ fieldPath: "/project", field: "project", kind: "field", base: "a", ours: "b", theirs: "c" }] });
    for (const id of ["config.json", "config"]) {
      const result = await handleConflictsShow(id, dir, "md");
      expect(result.exitCode ?? 0).toBe(0);
      expect(result.output).toContain("/project");
    }
  });

  it("conflicts show accepts roadmap.json and the roadmap alias", async () => {
    const dir = makeProject();
    writeRoadmap(dir, { _conflicts: [{ fieldPath: "/title", field: "title", kind: "field", base: "a", ours: "b", theirs: "c" }] });
    for (const id of ["roadmap.json", "roadmap"]) {
      const result = await handleConflictsShow(id, dir, "md");
      expect(result.exitCode ?? 0).toBe(0);
      expect(result.output).toContain("/title");
    }
  });

  it("resolve config --use ours writes a schema-valid config and lifts the write gate", async () => {
    const dir = makeProject();
    writeConfig(dir, { _conflicts: [{ fieldPath: "/project", field: "project", kind: "field", base: "alpha", ours: "beta", theirs: "gamma" }] });
    const result = await handleResolve("config", dir, { use: "ours" });
    expect(result.exitCode ?? 0).toBe(0);
    const cfg = JSON.parse(readFileSync(join(dir, ".story", "config.json"), "utf-8"));
    expect(cfg.project).toBe("beta");
    expect(cfg._conflicts).toBeUndefined();
    // Gate lifted: a locked write now succeeds.
    writeTicketFile(dir, "T-001", {});
    const ticket = JSON.parse(readFileSync(join(dir, ".story", "tickets", "T-001.json"), "utf-8"));
    ticket.title = "post-resolve";
    await expect(writeTicketLocked(ticket, dir)).resolves.toBeUndefined();
  });

  it("resolve roadmap --field /phases/0/name --use theirs sets the nested value", async () => {
    const dir = makeProject();
    writeRoadmap(dir, { _conflicts: [{ fieldPath: "/phases/0/name", field: "name", kind: "field", base: "Alpha", ours: "AlphaOurs", theirs: "AlphaTheirs" }] });
    const result = await handleResolve("roadmap", dir, { field: "/phases/0/name", use: "theirs" });
    expect(result.exitCode ?? 0).toBe(0);
    const rm = JSON.parse(readFileSync(join(dir, ".story", "roadmap.json"), "utf-8"));
    expect(rm.phases[0].name).toBe("AlphaTheirs");
    expect(rm._conflicts).toBeUndefined();
  });
});

describe("resolve exit codes", () => {
  it("resolve on a missing entity exits 1 (not 0)", async () => {
    const dir = makeProject();
    const result = await handleResolve("nosuch", dir, { use: "ours" });
    expect(result.exitCode).toBe(1);
  });

  it("resolve on a missing entity returns ok:false in JSON", async () => {
    const dir = makeProject();
    const result = await handleResolve("nosuch", dir, { use: "ours", format: "json" });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output).ok).toBe(false);
  });
});

describe("display-ID acceptance", () => {
  const canonical = "t-0123456789abcdef";

  it("conflicts show accepts a display ID", async () => {
    const dir = makeProject();
    writeTicketFile(dir, canonical, { displayId: "T-042", _conflicts: [titleConflict()] });
    const result = await handleConflictsShow("T-042", dir, "md");
    expect(result.exitCode ?? 0).toBe(0);
    expect(result.output).toContain("/title");
  });

  it("resolve accepts a display ID and writes back to the canonical file", async () => {
    const dir = makeProject();
    writeTicketFile(dir, canonical, { displayId: "T-042", _conflicts: [titleConflict()] });
    const result = await handleResolve("T-042", dir, { use: "theirs" });
    expect(result.exitCode ?? 0).toBe(0);
    const ticket = JSON.parse(readFileSync(join(dir, ".story", "tickets", `${canonical}.json`), "utf-8"));
    expect(ticket.title).toBe("Theirs title");
    expect(ticket._conflicts).toBeUndefined();
  });

  it("ambiguous display refs exit 1 listing the candidate canonical ids", async () => {
    const dir = makeProject();
    const other = "t-fedcba9876543210";
    writeTicketFile(dir, canonical, { displayId: "T-042", _conflicts: [titleConflict()] });
    writeTicketFile(dir, other, { displayId: "T-042" });
    const shown = await handleConflictsShow("T-042", dir, "md");
    expect(shown.exitCode).toBe(1);
    expect(shown.output).toContain(canonical);
    expect(shown.output).toContain(other);
    const resolved = await handleResolve("T-042", dir, { use: "ours" });
    expect(resolved.exitCode).toBe(1);
  });

  it("conflicts list prints display IDs for entities", async () => {
    const dir = makeProject();
    writeTicketFile(dir, canonical, { displayId: "T-042", _conflicts: [titleConflict()] });
    const result = await handleConflictsList(dir, "md");
    expect(result.output).toContain("T-042");
  });
});

describe("conflicts list footer and diagnostics", () => {
  it("footer names the config/roadmap resolve commands", async () => {
    const dir = makeProject();
    writeTicketFile(dir, "T-001", { _conflicts: [titleConflict()] });
    const result = await handleConflictsList(dir, "md");
    expect(result.output).toContain("--use ours|theirs");
    expect(result.output).toContain("storybloq resolve config");
    expect(result.output).toContain("storybloq resolve roadmap");
  });

  it("surfaces unloadable files as merge-damage diagnostics", async () => {
    const dir = makeProject();
    writeFileSync(join(dir, ".story", "tickets", "T-BAD.json"), "{ invalid json", "utf-8");
    const result = await handleConflictsList(dir, "md");
    expect(result.output).toContain("failed to load");
    expect(result.output).toContain("T-BAD.json");
  });
});

describe("entity-level conflict rendering", () => {
  it("renders new-format entity-level entries with per-side summaries and a resolve hint", async () => {
    const dir = makeProject();
    const base = { id: "T-001", title: "Original" };
    const tombstone = { id: "T-001", title: "Original", lifecycle: "deleted", deletedAt: "2026-05-26T00:00:00Z", deletedBy: "alice@test.com" };
    const edited = { id: "T-001", title: "Edited title" };
    writeTicketFile(dir, "T-001", {
      _conflicts: [{ fieldPath: "", field: "_entity", kind: "delete-edit", base, ours: tombstone, theirs: edited }],
    });
    const result = await handleConflictsShow("T-001", dir, "md");
    expect(result.output).toContain("(entire entity)");
    expect(result.output).toContain("deleted");
    expect(result.output).toContain("alice@test.com");
    expect(result.output).toContain("--use ours|theirs");
  });

  it("renders legacy placeholder entries with a pre-1.5.0 note", async () => {
    const dir = makeProject();
    writeTicketFile(dir, "T-001", {
      _conflicts: [{ fieldPath: "", field: "_entity", kind: "delete-edit", base: "active", ours: "deleted", theirs: "edited" }],
    });
    const result = await handleConflictsShow("T-001", dir, "md");
    expect(result.output).toContain("pre-1.5.0");
  });

  it("neutralizes ANSI/OSC escape bytes in untrusted legacy string sides (FIX B)", async () => {
    const dir = makeProject();
    // Teammate-authored entity-level entry whose sides are bare strings carrying
    // a screen-clear (ESC [2J) and an OSC title-set (ESC ] 0 ; ... BEL).
    const evil = "\x1b[2J\x1b]0;pwned\x07 OWNED";
    writeTicketFile(dir, "T-001", {
      _conflicts: [{ fieldPath: "", field: "_entity", kind: "delete-edit", base: evil, ours: evil, theirs: evil }],
    });
    const result = await handleConflictsShow("T-001", dir, "md");
    // No raw ESC byte reaches the victim terminal.
    expect(result.output).not.toContain(String.fromCharCode(27));
    // The control bytes survive as their JSON-escaped, inert representation.
    expect(result.output).toContain("\\u001b");
    // Sanity: the readable payload text is still present.
    expect(result.output).toContain("OWNED");
  });

  it("neutralizes escape bytes in untrusted tombstone snapshot fields (FIX B)", async () => {
    const dir = makeProject();
    // Teammate-authored tombstone snapshot whose deletedBy/deletedAt carry
    // control bytes; these reach the tombstone branch via isDeletedSnapshot.
    const evilTombstone = {
      id: "T-001", title: "Original", lifecycle: "deleted",
      deletedBy: "\x1b[2Jpwned\x07", deletedAt: "\x1b]0;pwned\x07 OWNED",
    };
    writeTicketFile(dir, "T-001", {
      _conflicts: [{ fieldPath: "", field: "_entity", kind: "delete-edit", base: { id: "T-001" }, ours: evilTombstone, theirs: { id: "T-001", title: "Edited" } }],
    });
    const result = await handleConflictsShow("T-001", dir, "md");
    expect(result.output).not.toContain(String.fromCharCode(27));
    expect(result.output).toContain("\\u001b");
    // Sanity: the tombstone branch still renders and the readable payload survives.
    expect(result.output).toContain("deleted (tombstone by");
    expect(result.output).toContain("OWNED");
  });
});

describe("T-478: arrangement conflict targets", () => {
  const arrangementFieldConflict = (): Json => ({
    fieldPath: "/lifecycle", field: "lifecycle", kind: "field", base: "active", ours: "suspended", theirs: "closed",
  });

  it("conflicts list includes an arrangement carrying a field-level conflict", async () => {
    const dir = makeProject();
    writeArrangementFile(dir, "a-0123456789abcdef", { _conflicts: [arrangementFieldConflict()] });
    const result = await handleConflictsList(dir, "md");
    expect(result.output).toContain("arrangement");
    expect(result.output).toContain("a-0123456789abcdef");
  });

  it("conflicts show renders a field-level conflict on an arrangement", async () => {
    const dir = makeProject();
    writeArrangementFile(dir, "a-0123456789abcdef", { _conflicts: [arrangementFieldConflict()] });
    const result = await handleConflictsShow("a-0123456789abcdef", dir, "md");
    expect(result.exitCode ?? 0).toBe(0);
    expect(result.output).toContain("/lifecycle");
  });

  it("conflicts show renders an entity-level (whole-record) conflict on an arrangement", async () => {
    const dir = makeProject();
    const base = { id: "a-0123456789abcdef", title: "n/a" };
    const tombstone = { id: "a-0123456789abcdef", lifecycle: "deleted", deletedAt: "2026-08-27T00:00:00Z", deletedBy: "pen@test.com" };
    const edited = { id: "a-0123456789abcdef", lifecycle: "closed" };
    writeArrangementFile(dir, "a-0123456789abcdef", {
      _conflicts: [{ fieldPath: "", field: "_entity", kind: "delete-edit", base, ours: tombstone, theirs: edited }],
    });
    const result = await handleConflictsShow("a-0123456789abcdef", dir, "md");
    expect(result.exitCode ?? 0).toBe(0);
    expect(result.output).toContain("(entire entity)");
    expect(result.output).toContain("pen@test.com");
  });

  it("resolve --use ours on a conflicted arrangement writes back the resolved field and clears _conflicts", async () => {
    const dir = makeProject();
    writeArrangementFile(dir, "a-0123456789abcdef", { _conflicts: [arrangementFieldConflict()] });
    const result = await handleResolve("a-0123456789abcdef", dir, { use: "ours" });
    expect(result.exitCode ?? 0).toBe(0);
    const arrangement = JSON.parse(readFileSync(join(dir, ".story", "arrangements", "a-0123456789abcdef.json"), "utf-8"));
    expect(arrangement.lifecycle).toBe("suspended");
    expect(arrangement._conflicts).toBeUndefined();
  });

  it("conflicts show on an id absent from the scan, with a damaged arrangement present, distinguishes 'scan incomplete' from a flat not-found", async () => {
    const dir = makeProject();
    mkdirSync(join(dir, ".story", "arrangements"), { recursive: true });
    writeFileSync(join(dir, ".story", "arrangements", "a-badbadbadbadbad.json"), "{ invalid json", "utf-8");
    const result = await handleConflictsShow("a-0123456789abcdef", dir, "md");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Arrangement scan was incomplete");
  });

  it("conflicts list surfaces a damaged arrangement as a named diagnostic instead of silently vanishing", async () => {
    const dir = makeProject();
    mkdirSync(join(dir, ".story", "arrangements"), { recursive: true });
    writeFileSync(join(dir, ".story", "arrangements", "a-badbadbadbadbad.json"), "{ invalid json", "utf-8");
    const result = await handleConflictsList(dir, "md");
    expect(result.output).toContain("Arrangement scan incomplete");
  });
});

describe("ISS-768: attacker-crafted conflict fieldPath through the resolve command", () => {
  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>)["polluted"];
  });

  it("resolve config --use theirs on a /__proto__/ entry errors cleanly, file unchanged, no pollution", async () => {
    const dir = makeProject();
    writeConfig(dir, {
      _conflicts: [{ fieldPath: "/__proto__/polluted", field: "polluted", kind: "field", base: null, ours: null, theirs: "owned" }],
    });
    const before = readFileSync(join(dir, ".story", "config.json"), "utf-8");

    let threw = false;
    let exitCode = 0;
    try {
      const result = await handleResolve("config", dir, { use: "theirs" });
      exitCode = result.exitCode ?? 0;
    } catch (err) {
      threw = true;
      expect(String(err)).toMatch(/reserved prototype key/);
    }
    expect(threw || exitCode !== 0).toBe(true);
    expect(readFileSync(join(dir, ".story", "config.json"), "utf-8")).toBe(before);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
