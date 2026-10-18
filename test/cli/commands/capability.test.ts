import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  handleCapabilityAdd,
  handleCapabilityUpdate,
  handleCapabilityList,
  handleCapabilityGet,
  handleCapabilityMatch,
  handleCapabilityCheck,
  capabilityCatalog,
} from "../../../src/cli/commands/capability.js";
import { nearestSurfaceNames } from "../../../src/core/capability.js";
import { handleExport } from "../../../src/cli/commands/export.js";
import { handleValidateWithSourceRefs } from "../../../src/cli/commands/validate.js";
import { CliValidationError } from "../../../src/cli/helpers.js";
import { ExitCode, escapeMarkdownInline, escapeMarkdownDocumentStrict } from "../../../src/core/output-formatter.js";
import { initProject } from "../../../src/core/init.js";
import { makeState, makeRoadmap, makePhase } from "../../core/test-factories.js";
import type { CommandContext } from "../../../src/cli/run.js";

/**
 * A seam between the check and the stamp. `handleCapabilityCheck` runs the
 * check, then stamps under the lock; the races the stamp must survive happen
 * in that gap, so the wrapped `checkCapabilities` runs a one-shot hook after
 * the real check returns and before the handler continues.
 */
const hooks = vi.hoisted(() => ({ afterCheck: null as null | ((root: string) => void) }));
vi.mock("../../../src/core/capability.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/capability.js")>();
  return {
    ...actual,
    checkCapabilities: async (...args: Parameters<typeof actual.checkCapabilities>) => {
      const report = await actual.checkCapabilities(...args);
      const hook = hooks.afterCheck;
      hooks.afterCheck = null;
      hook?.(args[0]);
      return report;
    },
  };
});
afterEach(() => {
  hooks.afterCheck = null;
});

/**
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

async function newRepo(files: Record<string, string> = { "src/core/thing.ts": "export const a = 1;\n" }): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "cap-cli-"));
  roots.push(root);
  // The catalog's write path takes the project lock, which loads the project:
  // a bare `.story/` directory is enough to READ a catalog but not to write
  // one, matching every other writer in the CLI.
  await initProject(root, { name: "Cap", type: "npm" });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
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

const BASE = {
  id: "cap-thing",
  name: "The thing",
  summary: "Does the thing to a thing.",
  entryPoints: ["src/core/thing.ts"],
  contract: "Returns the thing, never null.",
};

function stored(root: string) {
  return capabilityCatalog.load(root).doc.capabilities;
}

describe("capability add", () => {
  it("stamps the checkpoint at HEAD, because adding an entry is a claim to have read it", async () => {
    const root = await newRepo();
    const head = git(root, "rev-parse", "HEAD");
    const res = await handleCapabilityAdd(BASE, "md", root);
    expect(res.exitCode ?? ExitCode.OK).toBe(ExitCode.OK);
    expect(stored(root)[0]!.checkedAt.sha).toBe(head);
    expect(stored(root)[0]!.checkedAt.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("refuses outside a git repository rather than writing a checkpoint it cannot mean", async () => {
    const root = mkdtempSync(join(tmpdir(), "cap-nogit-"));
    roots.push(root);
    await initProject(root, { name: "Cap", type: "npm" });
    await expect(handleCapabilityAdd(BASE, "md", root)).rejects.toThrow(CliValidationError);
    await expect(handleCapabilityAdd(BASE, "md", root)).rejects.toThrow(/HEAD/);
  });

  it("refuses a duplicate id instead of replacing the entry", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    const res = await handleCapabilityAdd({ ...BASE, name: "Other" }, "md", root);
    expect(res.exitCode).toBe(ExitCode.USER_ERROR);
    expect(stored(root)).toHaveLength(1);
    expect(stored(root)[0]!.name).toBe("The thing");
  });

  it("maps every surface flag onto the stored entry", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(
      { ...BASE, cli: ["capability add"], mcp: ["storybloq_capability_add"], app: ["Sidebar"], files: ["REVIEW.md"] },
      "md",
      root,
    );
    expect(stored(root)[0]!.surfaces).toEqual({
      cli: ["capability add"],
      mcp: ["storybloq_capability_add"],
      app: ["Sidebar"],
      files: ["REVIEW.md"],
    });
  });

  it("rejects an invalid id through the schema rather than writing it", async () => {
    const root = await newRepo();
    await expect(handleCapabilityAdd({ ...BASE, id: "thing" }, "md", root)).rejects.toThrow(CliValidationError);
    expect(stored(root)).toHaveLength(0);
  });

  it("rejects an entry with no entry points, which could never go stale or be found", async () => {
    const root = await newRepo();
    await expect(handleCapabilityAdd({ ...BASE, entryPoints: [] }, "md", root)).rejects.toThrow(/entry point/);
  });

  it("writes a document with no undefined-valued keys, so the file and memory agree", async () => {
    const root = await newRepo();
    // The IN-MEMORY document, taken from the mutation itself. Comparing the
    // file against a reload would compare two parses of the same bytes: an
    // undefined-valued key vanishes on stringify, so both sides would lack it
    // and agree no matter what the handler built.
    const mutate = vi.spyOn(capabilityCatalog, "mutate");
    await handleCapabilityAdd(BASE, "md", root);
    expect(mutate).toHaveBeenCalledTimes(1);
    const inMemory = (await mutate.mock.results[0]!.value) as unknown;
    mutate.mockRestore();

    const raw = readFileSync(join(root, ".story", "capabilities.json"), "utf-8");
    expect(JSON.parse(raw)).toStrictEqual(inMemory);
    expect(raw).not.toContain("undefined");

    const undefinedPaths: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${path}[${i}]`));
      else if (value !== null && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) {
          if (inner === undefined) undefinedPaths.push(`${path}.${key}`);
          else walk(inner, `${path}.${key}`);
        }
      }
    };
    walk(inMemory, "doc");
    expect(undefinedPaths, "a present-but-undefined key is invisible in the file and unequal in memory").toEqual([]);
  });
});

describe("capability update", () => {
  it("never moves the checkpoint: an edit is not an inspection", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    const before = stored(root)[0]!.checkedAt;
    writeFileSync(join(root, "src", "core", "thing.ts"), "export const a = 2;\n");
    git(root, "commit", "-qam", "change");
    expect(git(root, "rev-parse", "HEAD")).not.toBe(before.sha);

    const res = await handleCapabilityUpdate({ id: "cap-thing", summary: "Rewritten." }, "md", root);
    expect(res.exitCode ?? ExitCode.OK).toBe(ExitCode.OK);
    expect(stored(root)[0]!.checkedAt).toEqual(before);
    expect(stored(root)[0]!.summary).toBe("Rewritten.");
    expect(res.output).toContain("Checkpoint unchanged");
  });

  it("leaves omitted fields alone and REPLACES supplied lists", async () => {
    const root = await newRepo({ "src/core/thing.ts": "a\n", "src/core/other.ts": "b\n" });
    await handleCapabilityAdd({ ...BASE, cli: ["status", "recap"], items: ["T-001"] }, "md", root);
    await handleCapabilityUpdate({ id: "cap-thing", cli: ["handover latest"] }, "md", root);
    const entry = stored(root)[0]!;
    // Replacement rather than a union: merging would make a wrong surface
    // impossible to remove through the CLI.
    expect(entry.surfaces.cli).toEqual(["handover latest"]);
    expect(entry.items).toEqual(["T-001"]);
    expect(entry.name).toBe("The thing");
  });

  it("reports a missing id rather than creating it", async () => {
    const root = await newRepo();
    const res = await handleCapabilityUpdate({ id: "cap-absent", summary: "x" }, "md", root);
    expect(res.exitCode).toBe(ExitCode.USER_ERROR);
    expect(stored(root)).toHaveLength(0);
  });

  it("rejects an invalid status by name", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    await expect(handleCapabilityUpdate({ id: "cap-thing", status: "stale" }, "md", root)).rejects.toThrow(/current, review/);
  });
});

describe("capability list and get: the effective status", () => {
  it("shows review once the entry points have moved, without anything having written the flag", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    expect(stored(root)[0]!.status).toBe("current");
    writeFileSync(join(root, "src", "core", "thing.ts"), "export const a = 2;\n");
    git(root, "commit", "-qam", "change");

    const list = await handleCapabilityList({}, ctxFor(root));
    expect(list.output).toContain("[review]");
    // The STORED flag is untouched: the check is computed, not persisted.
    expect(stored(root)[0]!.status).toBe("current");
  });

  it("filters on the effective status, not the stored flag", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    writeFileSync(join(root, "src", "core", "thing.ts"), "export const a = 2;\n");
    git(root, "commit", "-qam", "change");
    // A filter that matched the stored flag would hide exactly the entry the
    // filter exists to find.
    expect((await handleCapabilityList({ status: "review" }, ctxFor(root))).output).toContain("cap-thing");
    expect((await handleCapabilityList({ status: "current" }, ctxFor(root))).output).toContain("No capability matches");
  });

  it("says so when it skipped the check, rather than printing an unverified status bare", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    writeFileSync(join(root, "src", "core", "thing.ts"), "export const a = 2;\n");
    git(root, "commit", "-qam", "change");
    const res = await handleCapabilityList({ skipCheck: true }, ctxFor(root));
    expect(res.output).toContain("--skip-check");
    expect(res.output).toContain("[current]");
  });

  it("under --skip-check a structural finding still reads review, and the caveat says only freshness was skipped", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    rmSync(join(root, "src", "core", "thing.ts"));
    git(root, "commit", "-qam", "remove the entry point");
    const res = await handleCapabilityList({ skipCheck: true }, ctxFor(root));
    expect(stored(root)[0]!.status).toBe("current");
    expect(res.output).toContain("[review]");
    expect(res.output).toContain("_Freshness was not checked (--skip-check): statuses below include structural findings, not freshness._");
  });

  it("reports an absent inventory as absent, not as empty-and-fine", async () => {
    const root = await newRepo();
    const res = await handleCapabilityList({}, ctxFor(root));
    expect(res.output).toContain("No capability inventory yet");
  });

  it("get reports a missing id with the inventory size, so the reader knows what was searched", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    const res = await handleCapabilityGet("cap-absent", {}, ctxFor(root));
    expect(res.exitCode).toBe(ExitCode.USER_ERROR);
    expect(res.output).toContain("inventory of 1");
  });

  it("get in json carries the effective status beside the stored one", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    writeFileSync(join(root, "src", "core", "thing.ts"), "export const a = 2;\n");
    git(root, "commit", "-qam", "change");
    const res = await handleCapabilityGet("cap-thing", {}, ctxFor(root, "json"));
    const data = JSON.parse(res.output).data;
    expect(data.status).toBe("current");
    expect(data.effectiveStatus).toBe("review");
    expect(data.results).toHaveLength(1);
  });
});

describe("capability match", () => {
  it("refuses a criteria-free call, which would return the inventory and say nothing", async () => {
    const root = await newRepo();
    await expect(handleCapabilityMatch({}, ctxFor(root))).rejects.toThrow(/at least one/);
  });

  it("states the bound on every answer, including the empty one", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    const res = await handleCapabilityMatch({ paths: ["docs/readme.md"] }, ctxFor(root));
    expect(res.output).toContain("0 of 1");
    // "No match" is a statement about the inventory and must never read as a
    // statement about the repository.
    expect(res.output.toLowerCase()).toContain("inventory");
  });

  it("finds an entry by a path underneath its entry point", async () => {
    const root = await newRepo();
    await handleCapabilityAdd({ ...BASE, entryPoints: ["src/core"] }, "md", root);
    const res = await handleCapabilityMatch({ paths: ["src/core/thing.ts"] }, ctxFor(root));
    expect(res.output).toContain("cap-thing");
  });

  // The handler, not core, is where a refused query becomes a caller error.
  // Asserting the error CLASS and code is what tells the two layers apart:
  // core's throw carries the same reason text inside a plain Error.
  it("refuses an absolute path as a caller error and says to pass it repo-relative", async () => {
    const root = await newRepo();
    await handleCapabilityAdd({ ...BASE, entryPoints: ["src/core"] }, "md", root);
    const abs = join(root, "src", "core", "thing.ts");
    const err = await handleCapabilityMatch({ paths: [abs] }, ctxFor(root)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliValidationError);
    expect((err as CliValidationError).code).toBe("invalid_input");
    expect((err as Error).message).toBe(
      `match refused: path ${abs} is absolute: pass it relative to the repository root, the form git prints (src/core/x.ts, not /home/me/project/src/core/x.ts)`,
    );
  });

  // The refusal is printed, so the query in it is escaped as a path in a detail
  // is. JSON.stringify, which it replaced, left C1, bidi and U+2028 raw.
  it("escapes a hostile query in the refusal it prints", async () => {
    const root = await newRepo();
    await handleCapabilityAdd({ ...BASE, entryPoints: ["src/core"] }, "md", root);
    const err = await handleCapabilityMatch({ paths: ["/src/\u009b31m\u202egnp\u2028x.ts"] }, ctxFor(root)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliValidationError);
    const message = (err as Error).message;
    expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u);
    expect(message).toContain("match refused: path /src/\\u009b31m\\u202egnp\\u2028x.ts  (rendered with");
  });

  it("refuses a `..` query that used to match the entry it climbs out of", async () => {
    const root = await newRepo();
    await handleCapabilityAdd({ ...BASE, entryPoints: ["src/core"] }, "md", root);
    const err = await handleCapabilityMatch({ paths: ["src/core/../other/file.ts"] }, ctxFor(root)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliValidationError);
    expect((err as Error).message).toContain("contains a `..` segment");
  });

  it("refuses the WHOLE call when one of several paths is refused, and names only that one", async () => {
    const root = await newRepo();
    await handleCapabilityAdd({ ...BASE, entryPoints: ["src/core"] }, "md", root);
    const err = await handleCapabilityMatch(
      { paths: ["src/core/thing.ts", "src\\core\\thing.ts"], title: "thing" },
      ctxFor(root),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliValidationError);
    expect((err as Error).message).toBe(
      "match refused: path src\\\\core\\\\thing.ts  (rendered with \\uXXXX or \\u{XXXXX} escapes and doubled backslashes; decode them to get the name on disk) uses backslashes: pass it with forward slashes, the form git prints",
    );
  });
});

describe("capability check and stamping", () => {
  it("clears a freshness finding and re-points the checkpoint at HEAD", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    writeFileSync(join(root, "src", "core", "thing.ts"), "export const a = 2;\n");
    git(root, "commit", "-qam", "change");
    const head = git(root, "rev-parse", "HEAD");

    const res = await handleCapabilityCheck({ stamp: ["cap-thing"] }, "md", root, ctxFor(root));
    expect(res.output).toContain("Stamped 1");
    expect(stored(root)[0]!.checkedAt.sha).toBe(head);
    const after = await handleCapabilityList({}, ctxFor(root));
    expect(after.output).toContain("[current]");
  });

  it("clears a manually set review flag, because stamping IS the act of having looked", async () => {
    const root = await newRepo();
    await handleCapabilityAdd({ ...BASE, status: "review" }, "md", root);
    await handleCapabilityCheck({ stampAll: true }, "md", root, ctxFor(root));
    expect(stored(root)[0]!.status).toBe("current");
  });

  it("REFUSES to stamp an entry with a structural finding, which a new sha would hide", async () => {
    const root = await newRepo();
    await handleCapabilityAdd({ ...BASE, entryPoints: ["src/core/thing.ts", "src/core/gone.ts"] }, "md", root);
    const before = stored(root)[0]!.checkedAt.sha;
    git(root, "commit", "-q", "--allow-empty", "-m", "advance");

    const res = await handleCapabilityCheck({ stamp: ["cap-thing"] }, "md", root, ctxFor(root));
    expect(res.output).toContain("Refused to stamp cap-thing");
    expect(res.output).toContain("gone.ts");
    expect(stored(root)[0]!.checkedAt.sha).toBe(before);
  });

  it("reports an unknown id rather than silently stamping the rest", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    const res = await handleCapabilityCheck({ stamp: ["cap-thing", "cap-absent"] }, "md", root, ctxFor(root));
    expect(res.exitCode).toBe(ExitCode.USER_ERROR);
    expect(res.output).toContain("cap-absent");
  });

  it("writes nothing when nothing was asked to be stamped", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    writeFileSync(join(root, "src", "core", "thing.ts"), "export const a = 2;\n");
    git(root, "commit", "-qam", "change");
    const before = readFileSync(join(root, ".story", "capabilities.json"), "utf-8");
    const res = await handleCapabilityCheck({}, "md", root, ctxFor(root));
    expect(res.output).toContain("cap-thing");
    expect(readFileSync(join(root, ".story", "capabilities.json"), "utf-8")).toBe(before);
  });
});

describe("validate carries the inventory's findings", () => {
  it("reports a missing entry point as an ERROR, the same as any other dangling reference", async () => {
    const root = await newRepo();
    await handleCapabilityAdd({ ...BASE, entryPoints: ["src/core/gone.ts"] }, "md", root);
    const res = await handleValidateWithSourceRefs(ctxFor(root));
    expect(res.output).toContain("capability_missing_path");
    expect(res.exitCode).toBe(ExitCode.VALIDATION_ERROR);
  });

  it("reports staleness as a WARNING: a stale entry is still true about some commit", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    writeFileSync(join(root, "src", "core", "thing.ts"), "export const a = 2;\n");
    git(root, "commit", "-qam", "change");
    const res = await handleValidateWithSourceRefs(ctxFor(root));
    expect(res.output).toContain("capability_changed");
    expect(res.exitCode).not.toBe(ExitCode.VALIDATION_ERROR);
  });

  it("reports an unreadable catalog instead of failing the whole command", async () => {
    const root = await newRepo();
    writeFileSync(join(root, ".story", "capabilities.json"), "{ not json");
    const res = await handleValidateWithSourceRefs(ctxFor(root));
    expect(res.output).toContain("capability_catalog_unreadable");
  });

  it("says nothing at all when there is no inventory", async () => {
    const root = await newRepo();
    const res = await handleValidateWithSourceRefs(ctxFor(root));
    expect(res.output).not.toContain("capability_");
  });
});

describe("export --all carries the inventory", () => {
  it("renders the stored status and labels it as stored", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    const stored = JSON.parse(readFileSync(join(root, ".story", "capabilities.json"), "utf-8")) as {
      capabilities: Array<{ status: string; checkedAt: { sha: string } }>;
    };
    expect(stored.capabilities[0]!.status).toBe("current");

    // The entry point moves ON, so a recomputed freshness would now say
    // `capability_changed` against a DIFFERENT head. Without this the fixture
    // stores what a recompute would produce anyway and the assertions below
    // cannot tell the two apart.
    writeFileSync(join(root, "src", "core", "thing.ts"), "export const a = 2;\n");
    git(root, "commit", "-qam", "change");
    expect(git(root, "rev-parse", "HEAD").trim().slice(0, 12)).not.toBe(stored.capabilities[0]!.checkedAt.sha.slice(0, 12));

    const res = handleExport(ctxFor(root), "all", null);
    expect(res.output).toContain("## Capabilities (1)");
    expect(res.output).toContain("cap-thing");
    // An export is handed to somebody else: it must not vary with the working
    // tree it was produced from, so it carries the evidence instead of a
    // freshly computed verdict.
    expect(res.output).toContain("(cap-thing) [current]");
    expect(res.output).toContain(`- Checked at: ${stored.capabilities[0]!.checkedAt.sha.slice(0, 12)}`);
    expect(res.output).not.toContain("capability_changed");
    expect(res.output).toContain("as stored");
    expect(res.output).toContain("storybloq capability check");
  });

  it("splices into the json envelope rather than concatenating onto it", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    const res = handleExport(ctxFor(root, "json"), "all", null);
    const parsed = JSON.parse(res.output);
    expect(parsed.version).toBe(1);
    expect(parsed.data.capabilities).toHaveLength(1);
    expect(parsed.data.project).toBeDefined();
  });

  it("leaves a PHASE export alone: the inventory is project-wide and has no phase", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    const state = makeState({ roadmap: makeRoadmap([makePhase({ id: "p-one", name: "Phase One Rendered" })]) });
    const res = handleExport({ ...ctxFor(root), state }, "phase", "p-one");
    // The phase itself rendered, so the absence below is a statement about a
    // real export rather than about an empty one.
    expect(res.output).toContain("Phase One Rendered");
    expect(res.output).not.toContain("## Capabilities");
    expect(res.output).not.toContain("cap-thing");
  });

  it("notes an unreadable catalog rather than throwing out of the export", async () => {
    const root = await newRepo();
    writeFileSync(join(root, ".story", "capabilities.json"), "{ not json");
    const res = handleExport(ctxFor(root), "all", null);
    expect(res.output).toContain("Not included");
  });
});

function catalogPath(root: string): string {
  return join(root, ".story", "capabilities.json");
}

/** Rewrites the stored catalog by hand, as a concurrent editor would. */
function editCatalog(root: string, edit: (doc: { capabilities: Record<string, unknown>[] }) => void, indent = 2): void {
  const doc = JSON.parse(readFileSync(catalogPath(root), "utf-8"));
  edit(doc);
  writeFileSync(catalogPath(root), JSON.stringify(doc, null, indent));
}

async function staleRepoWith(ids: string[]): Promise<{ root: string; checkedHead: string }> {
  const root = await newRepo();
  // T-529: capability names are unique, so each entry is named for its id.
  for (const id of ids) await handleCapabilityAdd({ ...BASE, id, name: `${BASE.name} ${id}` }, "md", root);
  writeFileSync(join(root, "src", "core", "thing.ts"), "export const a = 2;\n");
  git(root, "commit", "-qam", "change");
  return { root, checkedHead: git(root, "rev-parse", "HEAD") };
}

/**
 * The warning, and the PARTIAL exit the CLI derives from it, describe what
 * still needs review AFTER this command. Computed from the pre-stamp report,
 * they announced review for entries the same output reported stamped.
 */
describe("capability check --stamp: the review warning counts what is left after the stamp", () => {
  it("a full stamp leaves no warning, in markdown or JSON", async () => {
    const { root } = await staleRepoWith(["cap-thing", "cap-other"]);
    const md = await handleCapabilityCheck({ stamp: ["cap-thing", "cap-other"] }, "md", root, ctxFor(root));
    expect(md.output).toContain("Stamped 2 entries");
    expect(md.warnings).toBeUndefined();

    const { root: root2 } = await staleRepoWith(["cap-thing", "cap-other"]);
    const json = await handleCapabilityCheck({ stampAll: true }, "json", root2, ctxFor(root2, "json"));
    expect(JSON.parse(json.output).data.stamped).toEqual(["cap-thing", "cap-other"]);
    expect(json.warnings).toBeUndefined();
  });

  it("a partial stamp still warns, counting only the entry left unstamped", async () => {
    const { root } = await staleRepoWith(["cap-thing", "cap-other"]);
    const md = await handleCapabilityCheck({ stamp: ["cap-thing"] }, "md", root, ctxFor(root));
    expect(md.warnings).toEqual(["1 capability needs review"]);

    const { root: root2 } = await staleRepoWith(["cap-thing", "cap-other"]);
    const json = await handleCapabilityCheck({ stamp: ["cap-thing"] }, "json", root2, ctxFor(root2, "json"));
    expect(JSON.parse(json.output).data.stamped).toEqual(["cap-thing"]);
    expect(json.warnings).toEqual(["one or more capabilities need review"]);
  });

  it("says in the JSON that entries are as checked and `stamped` is the post-state", async () => {
    const { root } = await staleRepoWith(["cap-thing"]);
    const body = JSON.parse((await handleCapabilityCheck({ stampAll: true }, "json", root, ctxFor(root, "json"))).output).data;
    expect(body.entries[0].effectiveStatus).toBe("review");
    expect(body.stamped).toEqual(["cap-thing"]);
    expect(body.statusNote).toBe(
      "entries[].effectiveStatus is the status as checked, before any stamp in this call; `stamped` is the post-state: the entries this call re-pointed at HEAD and marked current",
    );
  });
});

describe("capability check --stamp certifies exactly the HEAD and the entry bytes that were checked", () => {
  it("stamps the HEAD the check ran against, even when a commit lands during the check", async () => {
    const { root, checkedHead } = await staleRepoWith(["cap-thing"]);
    hooks.afterCheck = (r) => git(r, "commit", "-q", "--allow-empty", "-m", "landed mid-check");

    const res = await handleCapabilityCheck({ stamp: ["cap-thing"] }, "json", root, ctxFor(root, "json"));
    const laterHead = git(root, "rev-parse", "HEAD");
    expect(laterHead).not.toBe(checkedHead);
    const body = JSON.parse(res.output).data;
    expect(body.head).toBe(checkedHead);
    expect(body.stampedAt.sha).toBe(checkedHead);
    expect(stored(root)[0]!.checkedAt.sha).toBe(checkedHead);
  });

  it("refuses, per entry, an entry that changed during the check, and still stamps the unchanged one", async () => {
    const { root, checkedHead } = await staleRepoWith(["cap-thing", "cap-two"]);
    const before = stored(root).find((c) => c.id === "cap-two")!.checkedAt.sha;
    // The contract, not the entry points: a comparison over a selected field
    // list would miss exactly this edit.
    hooks.afterCheck = (r) =>
      editCatalog(r, (doc) => {
        doc.capabilities.find((c) => c.id === "cap-two")!.contract = "Edited while the check was running.";
      });

    const res = await handleCapabilityCheck({ stamp: ["cap-thing", "cap-two"] }, "md", root, ctxFor(root));
    expect(res.output).toContain("Stamped 1 entry");
    expect(res.output).toMatch(/Refused to stamp cap-two: it changed or was removed while the check was running.*re-run the check/);
    const after = stored(root);
    expect(after.find((c) => c.id === "cap-thing")!.checkedAt.sha).toBe(checkedHead);
    const two = after.find((c) => c.id === "cap-two")!;
    expect(two.checkedAt.sha).toBe(before);
    expect(two.contract).toBe("Edited while the check was running.");
  });

  it("refuses an entry removed during the check, and does not bring it back", async () => {
    const { root, checkedHead } = await staleRepoWith(["cap-thing", "cap-two"]);
    hooks.afterCheck = (r) =>
      editCatalog(r, (doc) => {
        doc.capabilities = doc.capabilities.filter((c) => c.id !== "cap-two");
      });

    const res = await handleCapabilityCheck({ stamp: ["cap-thing", "cap-two"] }, "json", root, ctxFor(root, "json"));
    const body = JSON.parse(res.output).data;
    expect(body.stamped).toEqual(["cap-thing"]);
    expect(body.refused.map((r: { id: string }) => r.id)).toEqual(["cap-two"]);
    expect(stored(root).map((c) => c.id)).toEqual(["cap-thing"]);
    expect(stored(root)[0]!.checkedAt.sha).toBe(checkedHead);
  });

  it("an entry CURRENT when checked that then raced is refused, and the refusal alone warns", async () => {
    const edit = (r: string) =>
      editCatalog(r, (doc) => {
        doc.capabilities[0]!.contract = "Edited while the check was running.";
      });

    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    hooks.afterCheck = edit;
    const md = await handleCapabilityCheck({ stamp: ["cap-thing"] }, "md", root, ctxFor(root));
    expect(md.output).toMatch(/Refused to stamp cap-thing: it changed or was removed while the check was running/);
    expect(md.warnings).toEqual(["1 requested stamp was refused"]);

    const root2 = await newRepo();
    await handleCapabilityAdd(BASE, "md", root2);
    hooks.afterCheck = edit;
    const json = await handleCapabilityCheck({ stamp: ["cap-thing"] }, "json", root2, ctxFor(root2, "json"));
    const body = JSON.parse(json.output).data;
    expect(body.stamped).toEqual([]);
    expect(body.refused.map((r: { id: string }) => r.id)).toEqual(["cap-thing"]);
    expect(json.warnings).toEqual(["one or more requested stamps were refused"]);
  });

  it("a refused stamp on an entry that also needs review carries both warnings", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    rmSync(join(root, "src", "core", "thing.ts"));
    git(root, "commit", "-qam", "remove the entry point");
    const md = await handleCapabilityCheck({ stamp: ["cap-thing"] }, "md", root, ctxFor(root));
    expect(md.output).toContain("Refused to stamp cap-thing");
    expect(md.warnings).toEqual(["1 capability needs review", "1 requested stamp was refused"]);
  });

  it("writes nothing at all when every requested entry raced", async () => {
    const { root } = await staleRepoWith(["cap-thing"]);
    let written = "";
    hooks.afterCheck = (r) => {
      // Four-space indentation, which the catalog writer never produces: a
      // rewrite of this file would show up even if its content were equal.
      editCatalog(r, (doc) => {
        doc.capabilities[0]!.summary = "Edited while the check was running.";
      }, 4);
      written = readFileSync(catalogPath(r), "utf-8");
    };

    const res = await handleCapabilityCheck({ stamp: ["cap-thing"] }, "json", root, ctxFor(root, "json"));
    const body = JSON.parse(res.output).data;
    expect(body.stamped).toEqual([]);
    expect(body.stampedAt).toBeNull();
    expect(body.refused.map((r: { id: string }) => r.id)).toEqual(["cap-thing"]);
    expect(readFileSync(catalogPath(root), "utf-8")).toBe(written);
  });

  it("refuses the WHOLE command on an unknown id, before any write, even when the rest would stamp", async () => {
    const { root } = await staleRepoWith(["cap-thing"]);
    const bytes = readFileSync(catalogPath(root), "utf-8");
    const res = await handleCapabilityCheck({ stamp: ["cap-thing", "cap-absent"] }, "md", root, ctxFor(root));
    expect(res.exitCode).toBe(ExitCode.USER_ERROR);
    expect(res.output).toContain("cap-absent");
    // cap-thing is stale and stampable at the new HEAD, so an unchanged file
    // proves the refusal came first rather than that there was nothing to do.
    expect(readFileSync(catalogPath(root), "utf-8")).toBe(bytes);
  });
});

describe("capability check lists an entry flagged for review by hand", () => {
  it("shows the flagged entry, explains the flag, and does not announce that everything is current", async () => {
    const root = await newRepo();
    await handleCapabilityAdd({ ...BASE, status: "review" }, "md", root);
    const res = await handleCapabilityCheck({}, "md", root, ctxFor(root));
    expect(res.output).toContain("cap-thing [review]");
    expect(res.output).toContain("flagged for review by hand, with no check finding");
    expect(res.output).not.toContain("Every capability is current");
  });
});

describe("duplicates in the catalog", () => {
  it("refuses to load a catalog with a repeated id rather than letting the later entry mask the broken first", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    editCatalog(root, (doc) => {
      const good = doc.capabilities[0]!;
      doc.capabilities = [{ ...good, entryPoints: ["src/core/gone.ts"] }, good];
    });
    const attempt = handleCapabilityCheck({}, "md", root, ctxFor(root));
    await expect(attempt).rejects.toThrow(/capabilities\.1\.id \(custom\)/);
  });

  it("names a duplicate entry point to the author at WRITE time", async () => {
    const root = await newRepo();
    const attempt = handleCapabilityAdd({ ...BASE, entryPoints: ["./src/core/thing.ts", "src/core/thing.ts"] }, "md", root);
    await expect(attempt).rejects.toThrow(/Duplicate entry point src\/core\/thing\.ts \(first at entryPoints\.0\)/);
    expect(stored(root)).toHaveLength(0);
  });

  it("reports only the location and code at LOAD time, never the path, which came from the file", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    editCatalog(root, (doc) => {
      doc.capabilities[0]!.entryPoints = ["src/SENTINEL-7f3a.ts", "./src/SENTINEL-7f3a.ts"];
    });
    let message = "";
    try {
      capabilityCatalog.load(root);
    } catch (err: unknown) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("capabilities.0.entryPoints.1 (custom)");
    expect(message).not.toContain("SENTINEL");
    expect(message).not.toContain("Duplicate");
  });
});

/**
 * T-523's own sinks (ISS-1281 keeps the ones that predate them). The catalog is
 * committed content, so every string field the schema allows can arrive with
 * terminal escape sequences, and every Markdown sink this surface owns must
 * print it inert.
 */
describe("catalog text reaches every sink inert, and legitimate content survives it", () => {
  // OSC 0 (set the window title) ended by BEL, SGR red, CR, RLO, U+2028 and C1 CSI.
  const H = "\u001b]0;pwned\u0007\u001b[31m\r\u202e\u2028\u009b2J";
  const HOSTILE = {
    id: "cap-hostile",
    name: `name${H}`,
    summary: `summary${H}`,
    entryPoints: [`src/ep${H}.ts`, "src/core/thing.ts"],
    contract: `contract${H}\nsecond line${H}\tcell`,
    example: `example${H}`,
    cli: [`cli${H}`],
    mcp: [`mcp${H}`],
    app: [`app${H}`],
    files: [`files/f${H}.ts`],
    skipCheck: true,
  };
  const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

  async function messageOf(run: () => Promise<{ output: string }>): Promise<string> {
    try {
      return (await run()).output;
    } catch (err: unknown) {
      return (err as Error).message;
    }
  }

  it("prints no control, line-separator or bidi character through any sink, whichever field carries it", async () => {
    const root = await newRepo();
    const ctx = ctxFor(root);
    const outputs: Record<string, string> = {
      add: (await handleCapabilityAdd(HOSTILE, "md", root)).output,
      update: (await handleCapabilityUpdate({ id: "cap-hostile", summary: `updated${H}` }, "md", root)).output,
      show: (await handleCapabilityGet("cap-hostile", {}, ctx)).output,
      showSkip: (await handleCapabilityGet("cap-hostile", { skipCheck: true }, ctx)).output,
      list: (await handleCapabilityList({}, ctx)).output,
      listSkip: (await handleCapabilityList({ skipCheck: true }, ctx)).output,
      matchPath: (await handleCapabilityMatch({ paths: ["src/core/thing.ts"] }, ctx)).output,
      matchTitle: (await handleCapabilityMatch({ title: "name pwned" }, ctx)).output,
      check: (await handleCapabilityCheck({}, "md", root, ctx)).output,
      checkStamp: (await handleCapabilityCheck({ stamp: ["cap-hostile"] }, "md", root, ctx)).output,
      export: handleExport(ctx, "all", null).output,
      echoShow: (await handleCapabilityGet(`cap-echo${H}`, {}, ctx)).output,
      echoStamp: (await handleCapabilityCheck({ stamp: [`cap-echo${H}`] }, "md", root, ctx)).output,
      echoUpdate: await messageOf(() => handleCapabilityUpdate({ id: `cap-echo${H}`, summary: "s" }, "md", root)),
    };
    // EVERY sink gets a row, because the scan below passes on an empty string:
    // a sink that printed nothing, or printed a bare header with the catalog
    // text dropped, would be counted as clean. The key sets must match, so a
    // sink added to the table above cannot land without one.
    const MUST_PRINT: Record<string, readonly string[]> = {
      add: ["Added cap-hostile (name?]0;pwned"],
      update: ["Updated cap-hostile.", "capability check --stamp cap-hostile"],
      show: ["## name?]0;pwned", "updated?]0;pwned"],
      showSkip: ["## name?]0;pwned", "updated?]0;pwned"],
      list: ["# Capabilities (1 of 1)", "- **name?]0;pwned"],
      listSkip: ["_Freshness was not checked (--skip-check)", "- **name?]0;pwned"],
      matchPath: ["searched 1 inventory entries by path", "**name?]0;pwned"],
      matchTitle: ["title words matched: name, pwned", "**name?]0;pwned"],
      check: ["# Capability check (1 entries)", "entry point does not exist: src/ep\\u001b]0;pwned"],
      checkStamp: ["Refused to stamp cap-hostile", "entry point does not exist: src/ep\\u001b]0;pwned"],
      export: ["### name?\\]0;pwned"],
      echoShow: ["Capability cap-echo?]0;pwned"],
      echoStamp: ["Not in the inventory: cap-echo?]0;pwned"],
      echoUpdate: ["Capability cap-echo?]0;pwned"],
    };
    expect(Object.keys(MUST_PRINT).sort(), "every sink needs a non-vacuity row: the scan below passes on an empty string").toEqual(Object.keys(outputs).sort());
    for (const [sink, fragments] of Object.entries(MUST_PRINT)) {
      for (const fragment of fragments) {
        expect({ sink, fragment, printed: outputs[sink]!.includes(fragment) }).toEqual({ sink, fragment, printed: true });
      }
    }
    // Not an empty walk: every catalog FIELD reached a sink that printed it.
    for (const field of ["name?", "contract?", "second line?", "example?", "cli?", "mcp?", "app?", "files/f\\u001b", "src/ep\\u001b"]) {
      expect({ field, shown: outputs.show!.includes(field) }).toEqual({ field, shown: true });
    }
    // The export is a Markdown document, so its escape doubles the backslash of the path's escape text.
    for (const field of ["name?", "updated?", "contract?", "example?", "src/ep\\\\u001b"]) {
      expect({ field, exported: outputs.export!.includes(field) }).toEqual({ field, exported: true });
    }
    const offending = Object.entries(outputs)
      .filter(([, text]) => UNSAFE.test(text))
      .map(([sink]) => sink);
    expect(offending).toEqual([]);
  });

  it("keeps the JSON output raw: it is the machine interface, and a consumer needs the real bytes", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(HOSTILE, "md", root);
    const res = await handleCapabilityGet("cap-hostile", { skipCheck: true }, ctxFor(root, "json"));
    const capability = (JSON.parse(res.output) as { data: typeof HOSTILE }).data;
    expect(capability.name).toBe(HOSTILE.name);
    expect(capability.entryPoints[0]).toBe(HOSTILE.entryPoints[0]);
    expect(capability.contract).toBe(HOSTILE.contract);
  });

  it("renders a long multi-line contract byte for byte apart from Markdown escaping, in show and in the export", async () => {
    const lines = Array.from({ length: 120 }, (_, i) => {
      const lead = i % 3 === 0 ? "- " : i % 3 === 1 ? `${i}. ` : "\t";
      return `${lead}clause ${i}: the thing holds under condition ${i}, and the caller may rely on it.`;
    });
    const contract = lines.join("\n");
    const name = `A long name ${"x".repeat(400)}`;
    // Past both caps the helper defaults to: a label's 300 and prose's 4000.
    expect(contract.length).toBeGreaterThan(4000);
    const root = await newRepo();
    await handleCapabilityAdd({ ...BASE, name, contract, entryPoints: ["src/core/my_thing.ts"] }, "md", root);
    const shown = (await handleCapabilityGet("cap-thing", { skipCheck: true }, ctxFor(root))).output;
    expect(shown).toContain(`## ${name} (cap-thing)`);
    expect(shown).toContain(`- Contract: ${escapeMarkdownInline(contract)}\n`);
    const exported = handleExport(ctxFor(root), "all", null).output;
    expect(exported).toContain(`- Contract: ${escapeMarkdownDocumentStrict(contract)}\n`);
    // Sanitized BEFORE the document escape: escaping first would hand the path
    // to the sanitizer with a backslash in it and print a name not on disk.
    expect(exported).toContain("- Entry points: src/core/my\\_thing.ts\n");
    expect(exported).not.toContain("rendered with");
  });
});


/** Every byte under `.story/`, so a write anywhere in the ledger is visible (term.test.ts's pattern). */
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

/**
 * ISS-1286: `mutate` writes whatever its function returns, so a refusal
 * decided inside the transaction must abort it. The inventory is rewritten as
 * compact JSON first: the catalog writes 2-space JSON, so a refusal that
 * rewrote the file would show up as a byte change even with no content change.
 */
describe("capability refused writes leave the ledger byte-identical (ISS-1286)", () => {
  async function compactInventory(): Promise<string> {
    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    await handleCapabilityAdd({ ...BASE, id: "cap-other", name: "The other thing" }, "md", root);
    editCatalog(root, () => {}, 0);
    expect(readFileSync(catalogPath(root), "utf-8")).not.toContain("\n");
    return root;
  }

  it("update of an unknown id creates no inventory file on a project that has none", async () => {
    const root = await newRepo();
    const before = storyBytes(root);
    const res = await handleCapabilityUpdate({ id: "cap-nope", summary: "x" }, "md", root);
    expect(res.errorCode).toBe("not_found");
    expect(res.exitCode).toBe(ExitCode.USER_ERROR);
    expect(existsSync(catalogPath(root))).toBe(false);
    expect(storyBytes(root)).toEqual(before);
  });

  it("update of an unknown id leaves an existing hand-formatted inventory untouched", async () => {
    const root = await compactInventory();
    const before = storyBytes(root);
    const res = await handleCapabilityUpdate({ id: "cap-nope", summary: "x" }, "md", root);
    expect(res.errorCode).toBe("not_found");
    expect(storyBytes(root)).toEqual(before);
  });

  it("add with a duplicate id leaves the inventory untouched", async () => {
    const root = await compactInventory();
    const before = storyBytes(root);
    const res = await handleCapabilityAdd({ ...BASE, name: "A new name" }, "md", root);
    expect(res.errorCode).toBe("invalid_input");
    expect(res.output).toContain("already exists");
    expect(storyBytes(root)).toEqual(before);
  });

  it("add with a name another entry uses leaves the inventory untouched", async () => {
    const root = await compactInventory();
    const before = storyBytes(root);
    const res = await handleCapabilityAdd({ ...BASE, id: "cap-third" }, "md", root);
    expect(res.errorCode).toBe("invalid_input");
    expect(res.output).toContain("cap-thing");
    expect(storyBytes(root)).toEqual(before);
  });

  it("a real failure inside the transaction still rejects as itself, not as a refusal result", async () => {
    const root = await compactInventory();
    const before = storyBytes(root);
    await expect(handleCapabilityUpdate({ id: "cap-thing", contract: "" }, "md", root)).rejects.toBeInstanceOf(CliValidationError);
    expect(storyBytes(root)).toEqual(before);
  });
});

/**
 * ISS-1301: add and update apply the surface rule `capability check` applies,
 * at write time, so a write never stores a name the next check rejects.
 */
describe("capability add and update refuse an unknown surface (ISS-1301)", () => {
  it("add refuses a bare group name with the check's text and the names it meant, and writes nothing", async () => {
    const root = await newRepo();
    const before = storyBytes(root);
    const res = await handleCapabilityAdd({ ...BASE, cli: ["ruling"] }, "md", root);
    expect(res.errorCode).toBe("invalid_input");
    expect(res.output).toContain("no such CLI command in storybloq reference: ruling");
    expect(res.output).toContain("ruling list");
    expect(res.output).toContain("--skip-check");
    expect(existsSync(catalogPath(root))).toBe(false);
    expect(storyBytes(root)).toEqual(before);
  });

  it("update refuses an unknown MCP name, suggests the storybloq_ form, and leaves the inventory untouched", async () => {
    const root = await newRepo();
    await handleCapabilityAdd(BASE, "md", root);
    editCatalog(root, () => {}, 0);
    const before = storyBytes(root);
    const res = await handleCapabilityUpdate({ id: "cap-thing", mcp: ["ruling_list"] }, "md", root);
    expect(res.errorCode).toBe("invalid_input");
    expect(res.output).toContain("no such MCP tool in storybloq reference: ruling_list");
    expect(res.output).toContain("storybloq_ruling_list");
    expect(storyBytes(root)).toEqual(before);
  });

  it("accepts exact reference names on add and on update", async () => {
    const root = await newRepo();
    const res = await handleCapabilityAdd({ ...BASE, cli: ["ruling list"], mcp: ["storybloq_ruling_list"] }, "md", root);
    expect(res.exitCode ?? ExitCode.OK).toBe(ExitCode.OK);
    const upd = await handleCapabilityUpdate({ id: "cap-thing", cli: ["ruling get"] }, "md", root);
    expect(upd.exitCode ?? ExitCode.OK).toBe(ExitCode.OK);
    expect(stored(root)[0]!.surfaces.cli).toEqual(["ruling get"]);
  });

  it("skipCheck writes the name, and capability check then reports it with the identical text", async () => {
    const root = await newRepo();
    const res = await handleCapabilityAdd({ ...BASE, cli: ["ruling"], skipCheck: true }, "md", root);
    expect(res.exitCode ?? ExitCode.OK).toBe(ExitCode.OK);
    expect(stored(root)[0]!.surfaces.cli).toEqual(["ruling"]);
    const check = await handleCapabilityCheck({}, "md", root, ctxFor(root));
    expect(check.output).toContain("no such CLI command in storybloq reference: ruling");
  });

  it("update of an unrelated field is not blocked by a stale stored surface", async () => {
    const root = await newRepo();
    await handleCapabilityAdd({ ...BASE, cli: ["ruling"], skipCheck: true }, "md", root);
    const res = await handleCapabilityUpdate({ id: "cap-thing", summary: "Rewritten." }, "md", root);
    expect(res.exitCode ?? ExitCode.OK).toBe(ExitCode.OK);
    expect(stored(root)[0]!.summary).toBe("Rewritten.");
    expect(stored(root)[0]!.surfaces.cli).toEqual(["ruling"]);
  });
});

describe("nearestSurfaceNames (ISS-1301)", () => {
  const known = { cliNames: new Set(["ruling list", "ruling get", "status", "ticket list"]), mcpNames: new Set(["storybloq_ruling_list", "storybloq_status"]) };
  it("finds the group for a bare first word, sorted", () => {
    expect(nearestSurfaceNames("cli", "ruling", known)).toEqual(["ruling get", "ruling list"]);
  });
  it("puts the storybloq_ form first for an MCP name", () => {
    expect(nearestSurfaceNames("mcp", "status", known)[0]).toBe("storybloq_status");
  });
  it("is empty when nothing is close", () => {
    expect(nearestSurfaceNames("cli", "zzz", known)).toEqual([]);
  });
});
