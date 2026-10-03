import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleTermAdd,
  handleTermUpdate,
  handleTermRemove,
  handleTermList,
  handleTermGet,
  handleTermMatch,
  handleTermCheck,
  capabilityScan,
} from "../../../src/cli/commands/term.js";
import { handleCapabilityAdd } from "../../../src/cli/commands/capability.js";
import { handleRulingCreate } from "../../../src/cli/commands/ruling.js";
import { handleExport } from "../../../src/cli/commands/export.js";
import { handleStatus } from "../../../src/cli/commands/status.js";
import { handleValidateWithSourceRefs } from "../../../src/cli/commands/validate.js";
import { ExitCode } from "../../../src/core/output-formatter.js";
import { initProject } from "../../../src/core/init.js";
import { makeState, makeRoadmap, makePhase } from "../../core/test-factories.js";
import type { CommandContext } from "../../../src/cli/run.js";

/**
 * T-524: the glossary's CLI surface.
 *
 * The one test here that is not about a command's output is the ADVISORY
 * BOUNDARY (G-A): `term match` is read-only in the strongest sense the
 * filesystem can express, and the assertion is a byte-for-byte snapshot of
 * `.story/` around the call rather than "it returned matches". A glossary that
 * quietly rewrote an item on a match would still return matches.
 *
 * Standalone temp clones only (ISS-1220): a linked worktree's fixture git
 * config writes reach the shared `.git/config`, which once left the production
 * checkout bare.
 */
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" }).trim();
}

async function newRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "term-cli-"));
  roots.push(root);
  // The catalog's write path takes the project lock, which loads the project,
  // so a bare `.story/` directory is enough to READ but not to WRITE.
  await initProject(root, { name: "Term", type: "npm" });
  writeFileSync(join(root, "src.ts"), "export const a = 1;\n");
  git(root, "init", "-q");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "T");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

function ctxFor(root: string, format: "md" | "json" = "md"): CommandContext {
  return { state: makeState(), warnings: [], root, handoversDir: join(root, ".story", "handovers"), format };
}

const PEN = {
  id: "term-pen",
  term: "pen",
  definition: "The session model that owns the judgement gates and files the ledger.",
  distinction: "Not the inspector, which reviews, and not hands, which implement.",
};

function glossaryPath(root: string): string {
  return join(root, ".story", "glossary.json");
}

function stored(root: string): { version: number; terms: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(glossaryPath(root), "utf-8"));
}

/** Every byte under `.story/`, so a write anywhere in the ledger is visible. */
function storyBytes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const next = join(rel, entry.name);
      if (entry.isDirectory()) walk(next);
      else out[next] = readFileSync(join(root, next), "utf-8");
    }
  };
  walk(".story");
  return out;
}

describe("term add", () => {
  it("writes the entry and stamps it", async () => {
    const root = await newRepo();
    const res = await handleTermAdd(PEN, "md", root);
    expect(res.exitCode).toBeUndefined();
    const doc = stored(root);
    expect(doc.version).toBe(1);
    expect(doc.terms).toHaveLength(1);
    expect(doc.terms[0]!.term).toBe("pen");
    expect(doc.terms[0]!.distinction).toBe(PEN.distinction);
    expect(typeof doc.terms[0]!.updatedAt).toBe("string");
    expect(new Date(doc.terms[0]!.updatedAt as string).getTime()).not.toBeNaN();
  });

  it("stores entries sorted by id, so a diff shows a change and not an append", async () => {
    const root = await newRepo();
    await handleTermAdd({ id: "term-wave", term: "wave", definition: "A batch of items driven through one pipeline." }, "md", root);
    await handleTermAdd(PEN, "md", root);
    await handleTermAdd({ id: "term-hands", term: "hands", definition: "The tier that implements an enriched spec." }, "md", root);
    expect(stored(root).terms.map((t) => t.id)).toEqual(["term-hands", "term-pen", "term-wave"]);
  });

  it("refuses a word another entry already owns and NAMES that entry", async () => {
    const root = await newRepo();
    await handleTermAdd(PEN, "md", root);
    const before = readFileSync(glossaryPath(root), "utf-8");
    const res = await handleTermAdd({ id: "term-pen-tier", term: "Pen", definition: "The same word, differently cased." }, "md", root);
    expect(res.exitCode).toBe(ExitCode.USER_ERROR);
    expect(res.output).toContain("term-pen");
    // The refusal is the whole point: a second owner must not reach the file.
    expect(readFileSync(glossaryPath(root), "utf-8")).toBe(before);
  });

  it("refuses an ALIAS that collides with another entry's term", async () => {
    const root = await newRepo();
    await handleTermAdd(PEN, "md", root);
    const res = await handleTermAdd(
      { id: "term-hands", term: "hands", definition: "The implementing tier.", aliases: ["pen"] },
      "md",
      root,
    );
    expect(res.exitCode).toBe(ExitCode.USER_ERROR);
    expect(stored(root).terms).toHaveLength(1);
  });
});

describe("term update", () => {
  it("replaces the supplied lists and leaves the omitted fields alone", async () => {
    const root = await newRepo();
    await handleTermAdd({ ...PEN, aliases: ["pen tier", "the pen"] }, "md", root);
    const res = await handleTermUpdate({ id: "term-pen", aliases: ["pen tier"] }, "md", root);
    expect(res.exitCode).toBeUndefined();
    const entry = stored(root).terms[0]!;
    expect(entry.aliases).toEqual(["pen tier"]);
    expect(entry.definition).toBe(PEN.definition);
    expect(entry.distinction).toBe(PEN.distinction);
  });

  it("reports a term that does not exist rather than creating it", async () => {
    const root = await newRepo();
    await handleTermAdd(PEN, "md", root);
    const before = storyBytes(root);
    const res = await handleTermUpdate({ id: "term-ghost", definition: "Nothing." }, "md", root);
    expect(res.exitCode).toBe(ExitCode.USER_ERROR);
    expect(res.output).toContain("term-ghost");
    expect(stored(root).terms.map((t) => t.id)).toEqual(["term-pen"]);
    expect(storyBytes(root)).toEqual(before);
  });

  it("creates no glossary file to report that a term is missing from a project that has none", async () => {
    const root = await newRepo();
    const before = storyBytes(root);
    const res = await handleTermUpdate({ id: "term-ghost", definition: "Nothing." }, "md", root);
    expect(res.errorCode).toBe("not_found");
    expect(existsSync(join(root, ".story", "glossary.json"))).toBe(false);
    expect(storyBytes(root)).toEqual(before);
  });
});

describe("term remove", () => {
  it("refuses while a capability references the term, and says which edits would clear it", async () => {
    const root = await newRepo();
    await handleTermAdd(PEN, "md", root);
    await handleCapabilityAdd(
      {
        id: "cap-orchestrate",
        name: "Orchestrate",
        summary: "Drives a backlog with tiered agents.",
        entryPoints: ["src.ts"],
        contract: "One pen per repo.",
        terms: ["term-pen"],
      },
      "md",
      root,
    );
    const before = storyBytes(root);
    const res = await handleTermRemove("term-pen", "md", root);
    expect(res.exitCode).toBe(ExitCode.USER_ERROR);
    // The edit that would clear it, not just the name of what blocks it.
    expect(res.output).toContain("capability update cap-orchestrate --term");
    // Refused means NOTHING moved: not the term, and not the capability's link
    // to it either, which "the other file is never edited" promises.
    expect(storyBytes(root)).toEqual(before);
  });

  it("creates no glossary file to report that a term is missing from a project that has none", async () => {
    const root = await newRepo();
    const before = storyBytes(root);
    const res = await handleTermRemove("term-ghost", "md", root);
    expect(res.errorCode).toBe("not_found");
    expect(existsSync(join(root, ".story", "glossary.json"))).toBe(false);
    expect(storyBytes(root)).toEqual(before);
  });

  it("removes a term nothing references", async () => {
    const root = await newRepo();
    await handleTermAdd(PEN, "md", root);
    const res = await handleTermRemove("term-pen", "md", root);
    expect(res.exitCode).toBeUndefined();
    expect(stored(root).terms).toHaveLength(0);
  });
});

/**
 * A refusal decided inside the transaction must not reach the file at all.
 * The catalog writes whatever document the transaction returns, so a refusal
 * that RETURNED the unchanged document still rewrote the file in canonical
 * form. The fixture is deliberately NOT in that form: on a canonical file the
 * rewrite is byte-identical and these would pass over the defect.
 */
describe("refused writes", () => {
  async function handFormatted(): Promise<string> {
    const root = await newRepo();
    await handleTermAdd(PEN, "md", root);
    await handleTermAdd({ id: "term-hands", term: "hands", definition: "The tier that implements an enriched spec." }, "md", root);
    // Valid and loadable, and not the layout the catalog writes.
    writeFileSync(glossaryPath(root), JSON.stringify(stored(root)));
    return root;
  }

  it.each([
    ["add, duplicate id", (root: string) => handleTermAdd({ ...PEN, term: "quill" }, "md", root)],
    ["add, a word another entry owns", (root: string) => handleTermAdd({ id: "term-quill", term: "Pen", definition: "The same word." }, "md", root)],
    ["update, missing id", (root: string) => handleTermUpdate({ id: "term-ghost", definition: "Nothing." }, "md", root)],
    ["update, a word another entry owns", (root: string) => handleTermUpdate({ id: "term-hands", aliases: ["pen"] }, "md", root)],
    ["remove, missing id", (root: string) => handleTermRemove("term-ghost", "md", root)],
  ])("leaves a hand-formatted glossary byte-identical: %s", async (_name, call) => {
    const root = await handFormatted();
    const before = storyBytes(root);
    const res = await call(root);
    expect(res.exitCode).toBe(ExitCode.USER_ERROR);
    expect(storyBytes(root)).toEqual(before);
  });

  it("still propagates a real failure inside the transaction instead of reporting it as a refusal", async () => {
    const root = await handFormatted();
    const before = storyBytes(root);
    await expect(handleTermUpdate({ id: "term-pen", definition: "x".repeat(401) }, "md", root)).rejects.toThrow(/one sentence/);
    expect(storyBytes(root)).toEqual(before);
  });
});

describe("term list", () => {
  it("renders every entry with the advisory line and the counts", async () => {
    const root = await newRepo();
    await handleTermAdd(PEN, "md", root);
    await handleTermAdd({ id: "term-hands", term: "hands", definition: "The implementing tier.", core: true }, "md", root);
    const res = await handleTermList({}, ctxFor(root));
    expect(res.output).toContain("# Glossary (2 of 2)");
    expect(res.output).toContain("advisory");
    // Display order is by term, not by the id the file is sorted on.
    expect(res.output.indexOf("**hands**")).toBeLessThan(res.output.indexOf("**pen**"));
    expect(res.output).toContain("[core]");
    expect(res.output).toContain("Not: Not the inspector");
  });

  it("filters to core and to thin, and says so in the count", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(
      { id: "cap-orchestrate", name: "Orchestrate", summary: "Drives a backlog.", entryPoints: ["src.ts"], contract: "One pen." },
      "md",
      root,
    );
    await handleTermAdd({ ...PEN, core: true }, "md", root);
    await handleTermAdd({ id: "term-hands", term: "hands", definition: "The implementing tier." }, "md", root);
    // The one entry that is NOT thin. Without it a thin filter that did
    // nothing would return every entry and pass.
    await handleTermAdd(
      { id: "term-wave", term: "wave", definition: "A batch of items.", distinction: "Not a phase.", capabilities: ["cap-orchestrate"] },
      "md",
      root,
    );
    expect((await handleTermList({}, ctxFor(root))).output).toContain("**wave**");
    expect((await handleTermList({ core: true }, ctxFor(root))).output).toContain("# Glossary (1 of 3)");
    // `pen` carries a distinction but no capability link, so it is thin
    // alongside `hands`: the filter must not be read as a proxy for the core flag.
    const thin = (await handleTermList({ thin: true }, ctxFor(root))).output;
    expect(thin).toContain("# Glossary (2 of 3)");
    expect(thin).toContain("**pen**");
    expect(thin).toContain("**hands**");
    expect(thin).not.toContain("**wave**");
  });

  it("says there is no glossary rather than rendering an empty one", async () => {
    const root = await newRepo();
    const res = await handleTermList({}, ctxFor(root));
    expect(res.output).toContain("No glossary yet");
    expect(res.exitCode).toBeUndefined();
  });

  it("digest returns names only, with the counts a caller needs to know it is bounded", async () => {
    const root = await newRepo();
    await handleTermAdd(PEN, "md", root);
    const res = await handleTermList({ digest: true }, ctxFor(root, "json"));
    const parsed = JSON.parse(res.output);
    expect(parsed.data.names).toEqual(["pen"]);
    expect(parsed.data.total).toBe(1);
    expect(parsed.data.returned).toBe(1);
    expect(parsed.data.omittedCore).toBe(0);
    expect(parsed.data.omittedNonCore).toBe(0);
    // Names only: the definition is what `term get` is for.
    expect(res.output).not.toContain(PEN.definition);
  });
});

describe("term get", () => {
  it("renders one entry, and reports a miss without inventing one", async () => {
    const root = await newRepo();
    await handleTermAdd(PEN, "md", root);
    const hit = await handleTermGet("term-pen", ctxFor(root));
    expect(hit.output).toContain("## pen (term-pen)");
    expect(hit.output).toContain(PEN.definition);

    const miss = await handleTermGet("term-ghost", ctxFor(root));
    expect(miss.exitCode).toBe(ExitCode.USER_ERROR);
    expect(miss.errorCode).toBe("not_found");
  });
});

describe("term match", () => {
  it("matches whole words case-insensitively and leaves `pending` alone", async () => {
    const root = await newRepo();
    await handleTermAdd(PEN, "md", root);
    const hit = await handleTermMatch("The Pen dispatches the work", ctxFor(root));
    expect(hit.output).toContain("**pen**");

    const miss = await handleTermMatch("this ticket is pending review", ctxFor(root));
    expect(miss.output).toContain("No glossary terms matched.");
  });

  it("carries the definition and the distinction, so a brief needs one call", async () => {
    const root = await newRepo();
    await handleTermAdd(PEN, "md", root);
    const res = await handleTermMatch("the pen files it", ctxFor(root, "json"));
    const parsed = JSON.parse(res.output);
    expect(parsed.data.matches).toHaveLength(1);
    expect(parsed.data.matches[0].definition).toBe(PEN.definition);
    expect(parsed.data.matches[0].distinction).toBe(PEN.distinction);
    expect(parsed.data.advisory).toBe(true);
  });

  it("refuses empty text instead of matching everything or nothing", async () => {
    const root = await newRepo();
    await handleTermAdd(PEN, "md", root);
    await expect(handleTermMatch("   ", ctxFor(root))).rejects.toThrow(/needs text to search/);
  });

  /**
   * G-A, the boundary the whole ticket rests on. A match is allowed to change
   * what a reader is TOLD and nothing else, so the assertion is that the ledger
   * is byte-identical across the call -- not that the command "did not write",
   * which no return value can establish.
   */
  it("changes not one byte of the ledger on a match", async () => {
    const root = await newRepo();
    await handleTermAdd(PEN, "md", root);
    const before = storyBytes(root);
    const res = await handleTermMatch("the pen files the ledger and hands implement", ctxFor(root));
    expect(res.output).toContain("**pen**");
    expect(res.exitCode).toBeUndefined();
    expect(storyBytes(root)).toEqual(before);
  });
});

describe("term check", () => {
  it("fails on an unknown capability link and names the term", async () => {
    const root = await newRepo();
    await handleTermAdd({ ...PEN, capabilities: ["cap-nope"] }, "md", root);
    const res = await handleTermCheck(ctxFor(root));
    expect(res.exitCode).toBe(ExitCode.USER_ERROR);
    expect(res.output).toContain("term-pen");
    expect(res.output).toContain("unknown capability: cap-nope");
  });

  it("flags a thin entry as a WARNING and exits clean, because a thin term is still a term", async () => {
    const root = await newRepo();
    await handleTermAdd({ id: "term-wave", term: "wave", definition: "A batch of items." }, "md", root);
    const res = await handleTermCheck(ctxFor(root));
    expect(res.exitCode).toBeUndefined();
    expect(res.output).toContain("thin entry");
    expect(res.output).toContain("no distinction");
    expect(res.output).toContain("no capability link");
  });

  /**
   * R5, capability side, through the real command. `term check` must not turn
   * "I could not read the other catalog" into "that capability does not
   * exist": the id may be perfectly valid and the only broken thing is a file
   * this process failed to parse. It stays a warning, so the command still
   * exits clean and the capability surface reports its own file's state.
   */
  it("reports an unresolved link as UNRESOLVED, not unknown, when capabilities.json cannot be read", async () => {
    const root = await newRepo();
    await handleTermAdd({ ...PEN, capabilities: ["cap-orchestrate"] }, "md", root);
    writeFileSync(join(root, ".story", "capabilities.json"), "{ not json");

    const res = await handleTermCheck(ctxFor(root));

    expect(res.exitCode).toBeUndefined();
    expect(res.output).toContain("could not be read");
    expect(res.output).toContain("cap-orchestrate");
    expect(res.output).not.toContain("unknown capability");
  });

  /**
   * Every other ruling-link test runs against a project with no rulings, so
   * none of them could tell a working index from one that never loaded a
   * ruling at all. This one creates a real ruling through the public path and
   * links it: an index that dropped the scan would call it unknown.
   */
  it("resolves a ruling link to a ruling that exists, and does not call it unknown", async () => {
    const root = await newRepo();
    const created = await handleRulingCreate(
      { text: "Verbatim ruling text.", attribution: "owner-direct", date: "2026-09-21", scopeTags: [], clientTaskId: "term-test" },
      "json",
      root,
    );
    const rulingId = JSON.parse(created.output).data.id as string;
    expect(rulingId).toMatch(/^r-/);
    await handleTermAdd({ ...PEN, rulings: [rulingId] }, "md", root);
    expect(stored(root).terms[0]?.rulings).toEqual([rulingId]);

    const res = await handleTermCheck(ctxFor(root, "json"));
    const parsed = JSON.parse(res.output);

    expect(res.exitCode).toBeUndefined();
    expect(parsed.data.errorIds).toEqual([]);
    expect(parsed.data.incompleteIds).toEqual([]);
    expect(JSON.stringify(parsed.data.entries)).not.toContain("term_unknown_ruling");
  });

  it("says nothing is wrong when both halves are present and the link resolves", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(
      { id: "cap-orchestrate", name: "Orchestrate", summary: "Drives a backlog.", entryPoints: ["src.ts"], contract: "One pen." },
      "md",
      root,
    );
    await handleTermAdd({ ...PEN, capabilities: ["cap-orchestrate"] }, "md", root);
    const res = await handleTermCheck(ctxFor(root));
    expect(res.exitCode).toBeUndefined();
    expect(res.output).toContain("carries both a distinction and a capability link");
  });
});

describe("validate carries the glossary's findings", () => {
  it("fails on a bad capability link and names the term", async () => {
    const root = await newRepo();
    await handleTermAdd({ ...PEN, capabilities: ["cap-nope"] }, "md", root);
    const res = await handleValidateWithSourceRefs(ctxFor(root));
    expect(res.exitCode).toBe(ExitCode.VALIDATION_ERROR);
    expect(res.output).toContain("term_unknown_capability");
    expect(res.output).toContain("term-pen");
  });

  /**
   * The exit code is deliberately NOT asserted here: an unreadable
   * capabilities.json also makes `capabilityFindings` emit its own error, so
   * validate fails for that reason whatever the glossary says. The claim under
   * test is which finding the GLOSSARY contributes, and at what level, so the
   * assertion reads that one finding's level rather than the command's exit.
   */
  it("contributes an unresolved WARNING, not an unknown error, when capabilities.json cannot be read", async () => {
    const root = await newRepo();
    await handleTermAdd({ ...PEN, capabilities: ["cap-orchestrate"] }, "md", root);
    writeFileSync(join(root, ".story", "capabilities.json"), "{ not json");

    const res = await handleValidateWithSourceRefs(ctxFor(root, "json"));
    const findings = JSON.parse(res.output).data.findings as Array<{ level: string; code: string; entity: string | null }>;
    const mine = findings.filter((f) => f.entity === "term-pen");

    expect(mine.map((f) => [f.code, f.level])).toEqual([["term_check_incomplete", "warning"]]);
    expect(findings.some((f) => f.code === "term_unknown_capability")).toBe(false);
  });

  it("reports a thin entry as a warning, not as a failure", async () => {
    const root = await newRepo();
    await handleTermAdd({ id: "term-wave", term: "wave", definition: "A batch of items." }, "md", root);
    const res = await handleValidateWithSourceRefs(ctxFor(root));
    expect(res.output).toContain("term_thin");
    expect(res.exitCode).not.toBe(ExitCode.VALIDATION_ERROR);
  });

  it("reports an unreadable glossary instead of failing the whole command", async () => {
    const root = await newRepo();
    writeFileSync(glossaryPath(root), "{ not json");
    const res = await handleValidateWithSourceRefs(ctxFor(root));
    expect(res.output).toContain("glossary_catalog_unreadable");
  });

  it("says nothing at all when there is no glossary", async () => {
    const root = await newRepo();
    const res = await handleValidateWithSourceRefs(ctxFor(root));
    expect(res.output).not.toContain("term_");
  });
});

describe("status carries the glossary's SIZE and nothing else", () => {
  it("adds the counts to the JSON payload", async () => {
    const root = await newRepo();
    await handleTermAdd({ ...PEN, core: true }, "md", root);
    await handleTermAdd({ id: "term-wave", term: "wave", definition: "A batch of items." }, "md", root);
    const res = await handleStatus(ctxFor(root, "json"));
    const parsed = JSON.parse(res.output);
    expect(parsed.data.glossary).toEqual({ terms: 2, core: 1 });
    // The names are `term list`'s job: status says how big, never what.
    expect(res.output).not.toContain("term-pen");
  });

  it("leaves the markdown rendering and the compact payload alone", async () => {
    const root = await newRepo();
    await handleTermAdd(PEN, "md", root);
    // ISS-1107: the uncommitted-board section may name the glossary file; the
    // rendering above it carries nothing of the glossary.
    const markdown = (await handleStatus(ctxFor(root, "md"))).output.split("\n## Board not committed")[0]!;
    expect(markdown).not.toContain("glossary");
    const compact = JSON.parse((await handleStatus(ctxFor(root, "json"), null, { compact: true })).output);
    expect(compact.data.glossary).toBeUndefined();
    // Compact really did render, so the absence above is about the payload and
    // not about a call that failed.
    expect(compact.data).toBeDefined();
  });

  it("leaves status standing when the glossary cannot be read", async () => {
    const root = await newRepo();
    writeFileSync(glossaryPath(root), "{ not json");
    const res = await handleStatus(ctxFor(root, "json"));
    const parsed = JSON.parse(res.output);
    expect(parsed.data.glossary).toBeUndefined();
    expect(parsed.data.project).toBeDefined();
  });
});

describe("export --all carries the glossary", () => {
  it("renders the section with the advisory line", async () => {
    const root = await newRepo();
    await handleTermAdd(PEN, "md", root);
    const res = handleExport(ctxFor(root), "all", null);
    expect(res.output).toContain("## Glossary (1)");
    expect(res.output).toContain("### pen (term-pen)");
    expect(res.output).toContain("advisory");
    expect(res.output).toContain("- Not: Not the inspector");
  });

  it("splices into the json envelope rather than concatenating onto it", async () => {
    const root = await newRepo();
    await handleTermAdd(PEN, "md", root);
    const parsed = JSON.parse(handleExport(ctxFor(root, "json"), "all", null).output);
    expect(parsed.version).toBe(1);
    expect(parsed.data.glossary).toHaveLength(1);
    expect(parsed.data.project).toBeDefined();
  });

  it("leaves a PHASE export alone: the glossary is project-wide", async () => {
    const root = await newRepo();
    await handleTermAdd(PEN, "md", root);
    const state = makeState({ roadmap: makeRoadmap([makePhase({ id: "p-one", name: "Phase One Rendered" })]) });
    const res = handleExport({ ...ctxFor(root), state }, "phase", "p-one");
    expect(res.output).toContain("Phase One Rendered");
    expect(res.output).not.toContain("## Glossary");
  });

  it("notes an unreadable glossary rather than throwing out of the export", async () => {
    const root = await newRepo();
    writeFileSync(glossaryPath(root), "{ not json");
    const res = handleExport(ctxFor(root), "all", null);
    expect(res.output).toContain("## Glossary");
    expect(res.output).toContain("Not included");
  });
});

/**
 * The helper both `term check` and `validate` build their index from. The two
 * cases are the whole contract: an empty id set means two completely different
 * things, and only this flag tells them apart.
 */
describe("capabilityScan", () => {
  it("reports an ABSENT catalog as complete, because absence is an answer", async () => {
    const root = await newRepo();
    const scan = capabilityScan(root);
    expect([...scan.ids]).toEqual([]);
    expect(scan.incomplete).toBe(false);
  });

  it("reports an UNREADABLE catalog as incomplete rather than as an empty one", async () => {
    const root = await newRepo();
    writeFileSync(join(root, ".story", "capabilities.json"), "{ not json");
    const scan = capabilityScan(root);
    expect([...scan.ids]).toEqual([]);
    expect(scan.incomplete).toBe(true);
  });

  it("reports a populated catalog as complete and carries its ids", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(
      { id: "cap-orchestrate", name: "Orchestrate", summary: "Drives a backlog.", entryPoints: ["src.ts"], contract: "One pen." },
      "md",
      root,
    );
    const scan = capabilityScan(root);
    expect([...scan.ids]).toEqual(["cap-orchestrate"]);
    expect(scan.incomplete).toBe(false);
  });
});
