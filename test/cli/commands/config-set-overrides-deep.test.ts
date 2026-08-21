import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleConfigSetOverrides } from "../../../src/cli/commands/config-update.js";
import { initProject } from "../../../src/core/init.js";

/**
 * `config set-overrides --deep` (T-469, ISS-1026).
 *
 * These run the real command against a real file, because the whole point of
 * the ticket is what survives ON DISK. An assertion about the returned envelope
 * would pass for a writer that destroyed every sibling key.
 */

let root: string;
let configPath: string;

/**
 * The command runs inside `withProjectLock`, which loads the WHOLE project, so
 * these need a real one rather than a lone config.json. `initProject` writes the
 * canonical config and every sibling file the loader expects; the overrides
 * below are layered onto whatever it produced, so this fixture cannot drift
 * away from the real schema.
 */
let baseConfig: Record<string, unknown>;

const OVERRIDES = {
  recipeOverrides: {
    maxTicketsPerSession: 3,
    branchStrategy: "per-ticket",
    maxParallelAgents: 4,
    lensConfig: { lenses: ["security"], maxLenses: 2, lensTimeout: 900 },
    stages: {
      PLAN_REVIEW: { backends: ["codex"] },
      CODE_REVIEW: { backends: ["lenses"], maxReviewRounds: 6 },
      WRITE_TESTS: { enabled: true },
    },
    reviewEffort: "thorough",
  },
};

async function writeConfig(value: unknown): Promise<void> {
  await writeFile(configPath, JSON.stringify(value, null, 2) + "\n");
}

/**
 * The command REPORTS argument errors as a CommandResult but THROWS
 * ProjectLoaderError for anything discovered inside the project lock -- which is
 * the pre-existing shape (the schema-validation failure does the same), and
 * `register.ts` is what turns it into an error envelope. So a refusal test has
 * to accept either, or it would be asserting a contract this command has never
 * had.
 */
async function refusalMessage(
  options: Parameters<typeof handleConfigSetOverrides>[2],
): Promise<string> {
  try {
    const result = await handleConfigSetOverrides(root, "json", options);
    if (result.errorCode === undefined) {
      throw new Error(`expected a refusal, got success: ${result.output}`);
    }
    return result.output;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("expected a refusal")) throw err;
    return err instanceof Error ? err.message : String(err);
  }
}

async function readOverrides(): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(await readFile(configPath, "utf-8"));
  return parsed.recipeOverrides ?? {};
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "deepmerge-"));
  await initProject(root, { name: "test-project" });
  configPath = join(root, ".story", "config.json");
  const generated = JSON.parse(await readFile(configPath, "utf-8"));
  baseConfig = { ...generated, ...OVERRIDES };
  await writeConfig(baseConfig);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("--deep argument handling", () => {
  it("refuses --deep without --json rather than silently doing nothing", async () => {
    const result = await handleConfigSetOverrides(root, "json", { deep: true });
    expect(result.errorCode).toBe("invalid_input");
    expect(result.output).toContain("--deep requires --json");
  });

  it("leaves the shallow merge exactly as it was when --deep is absent", async () => {
    // The shallow path is the published contract for every existing caller, so
    // it has to keep replacing `stages` wholesale even though that is the very
    // defect --deep exists to fix.
    await handleConfigSetOverrides(root, "json", {
      json: JSON.stringify({ stages: { CODE_REVIEW: { maxReviewRounds: 8 } } }),
    });
    const overrides = await readOverrides();
    expect(overrides.stages).toEqual({ CODE_REVIEW: { maxReviewRounds: 8 } });
  });
});

describe("--deep merge on disk", () => {
  /**
   * THE ISS-1026 REGRESSION, stated as one test.
   *
   * Setting one nested leaf must move that leaf and nothing else. Before this
   * ticket the same write deleted `stages.PLAN_REVIEW` and
   * `stages.CODE_REVIEW.backends` -- the explicit knobs that OUTRANK the
   * review-effort dial -- so a user who set a round cap lost the settings the
   * dial promises never to override.
   */
  it("sets one nested leaf and leaves every other key byte-identical", async () => {
    const before = JSON.parse(await readFile(configPath, "utf-8"));

    const result = await handleConfigSetOverrides(root, "json", {
      deep: true,
      json: JSON.stringify({ stages: { CODE_REVIEW: { maxReviewRounds: 8 } } }),
    });
    expect(result.errorCode).toBeUndefined();

    const after = JSON.parse(await readFile(configPath, "utf-8"));

    // The one intended change.
    expect(after.recipeOverrides.stages.CODE_REVIEW.maxReviewRounds).toBe(8);

    // Everything else, compared as whole trees rather than key by key, so a
    // deletion anywhere shows up.
    before.recipeOverrides.stages.CODE_REVIEW.maxReviewRounds = 8;
    expect(after).toEqual(before);
  });

  it("deletes a nested leaf with null and leaves the empty ancestor standing", async () => {
    await handleConfigSetOverrides(root, "json", {
      deep: true,
      json: JSON.stringify({ stages: { CODE_REVIEW: { maxReviewRounds: null, backends: null } } }),
    });
    const overrides = await readOverrides();
    expect(overrides.stages).toEqual({
      PLAN_REVIEW: { backends: ["codex"] },
      CODE_REVIEW: {},
      WRITE_TESTS: { enabled: true },
    });
  });

  it("replaces an array rather than concatenating, so a lens can be unchecked", async () => {
    await handleConfigSetOverrides(root, "json", {
      deep: true,
      json: JSON.stringify({ lensConfig: { lenses: ["concurrency"] } }),
    });
    const overrides = await readOverrides();
    expect(overrides.lensConfig).toEqual({
      lenses: ["concurrency"],
      maxLenses: 2,
      lensTimeout: 900, // an unmodelled key the app never sends, still here
    });
  });

  it("still prunes an empty recipeOverrides root, the one pre-existing exception", async () => {
    await writeConfig({ ...baseConfig, recipeOverrides: { maxTicketsPerSession: 3 } });
    await handleConfigSetOverrides(root, "json", {
      deep: true,
      json: JSON.stringify({ maxTicketsPerSession: null }),
    });
    const parsed = JSON.parse(await readFile(configPath, "utf-8"));
    expect(parsed.recipeOverrides).toBeUndefined();
  });

  it("creates recipeOverrides when the file has none", async () => {
    const { recipeOverrides, ...withoutOverrides } = baseConfig;
    void recipeOverrides;
    await writeConfig(withoutOverrides);
    await handleConfigSetOverrides(root, "json", {
      deep: true,
      json: JSON.stringify({ stages: { CODE_REVIEW: { maxReviewRounds: 4 } } }),
    });
    expect(await readOverrides()).toEqual({ stages: { CODE_REVIEW: { maxReviewRounds: 4 } } });
  });

  it("refuses a non-object recipeOverrides instead of clobbering it", async () => {
    await writeConfig({ ...baseConfig, recipeOverrides: "not an object" });
    const message = await refusalMessage({
      deep: true,
      json: JSON.stringify({ maxTicketsPerSession: 1 }),
    });
    // Named rather than "something threw". Naming it is also what records WHICH
    // layer refuses: `recipeOverrides` is a strict `z.object` and the loader
    // calls `.parse`, so `withProjectLock` rejects this config before the
    // handler runs at all. The handler's own non-object guard is therefore a
    // backstop rather than the active check -- kept deliberately, because two
    // keys in this very schema (`reviewEffort`, `lensConfig`) were already
    // loosened to `z.unknown()` to stop a typo throwing, and if
    // `recipeOverrides` ever follows them the guard becomes the only thing
    // between a string and `{...("no")}` writing `{"0":"n","1":"o"}` to disk.
    expect(message).toContain("Validation failed for .story/config.json");
    // What actually matters either way: the file is untouched, so whatever the
    // user wrote there is still theirs.
    const parsed = JSON.parse(await readFile(configPath, "utf-8"));
    expect(parsed.recipeOverrides).toBe("not an object");
  });

  it("refuses a prototype-polluting key and writes nothing", async () => {
    const before = await readFile(configPath, "utf-8");
    const message = await refusalMessage({
      deep: true,
      json: '{"stages": {"__proto__": {"polluted": true}}}',
    });
    expect(message).toContain("__proto__");
    expect(await readFile(configPath, "utf-8")).toBe(before);
  });

  it("still validates the merged config against the schema", async () => {
    const before = await readFile(configPath, "utf-8");
    const message = await refusalMessage({
      deep: true,
      json: JSON.stringify({ maxTicketsPerSession: "five" }),
    });
    // Specifically the schema gate, so this cannot be satisfied by the merge
    // refusing for one of its own reasons before the schema ever ran.
    expect(message).toContain("Invalid config after merge");
    expect(await readFile(configPath, "utf-8")).toBe(before);
  });
});

describe("--deep and duplicate keys", () => {
  /**
   * A config with duplicate keys means the two readers of this file disagree:
   * `JSON.parse` keeps the LAST occurrence, the Mac app's `OrderedJSON` reads
   * the FIRST. Merging into it would update one while the other stayed
   * authoritative for the other reader, so the write is refused.
   */
  /**
   * Built by injecting a duplicate into the REAL config text rather than by
   * hand-writing a minimal one, so the file still loads and the only thing
   * under test is the duplicate.
   */
  async function withDuplicate(at: "root" | "overrides" | "stage"): Promise<string> {
    const text = await readFile(configPath, "utf-8");
    switch (at) {
      case "root":
        return text.replace('"version"', '"project": "injected",\n  "version"');
      case "overrides":
        return text.replace('"maxTicketsPerSession": 3', '"maxTicketsPerSession": 1,\n    "maxTicketsPerSession": 3');
      case "stage":
        return text.replace('"maxReviewRounds": 6', '"maxReviewRounds": 1,\n        "maxReviewRounds": 6');
    }
  }

  for (const [label, where, expectedPath] of [
    ["at the root", "root", "project"],
    ["inside recipeOverrides", "overrides", "recipeOverrides.maxTicketsPerSession"],
    ["inside a stage", "stage", "recipeOverrides.stages.CODE_REVIEW.maxReviewRounds"],
  ] as const) {
    it(`refuses a write when config.json has a duplicate ${label}, naming the path`, async () => {
      const text = await withDuplicate(where);
      await writeFile(configPath, text);
      const message = await refusalMessage({
        deep: true,
        json: JSON.stringify({ maxTicketsPerSession: 9 }),
      });
      expect(message).toContain(expectedPath);
      // Byte-identical: a refused write must not "helpfully" normalize the file.
      expect(await readFile(configPath, "utf-8")).toBe(text);
    });
  }

  /**
   * The same refusal when the two keys are spelled differently but decode
   * identically. This is the case a raw-text scanner misses, and it is not
   * exotic: an editor or a generator writing `\u` escapes produces it, and both
   * readers of this file collapse it to one key while disagreeing about which
   * value wins. If this passes only for byte-identical spellings, the check is
   * decoration.
   */
  it("refuses an ESCAPE-EQUIVALENT duplicate in config.json, naming the decoded key", async () => {
    const text = (await readFile(configPath, "utf-8")).replace(
      '"maxTicketsPerSession": 3',
      '"maxTicketsPerSess\\u0069on": 1,\n    "maxTicketsPerSession": 3',
    );
    await writeFile(configPath, text);
    const message = await refusalMessage({
      deep: true,
      json: JSON.stringify({ maxTicketsPerSession: 9 }),
    });
    expect(message).toContain("recipeOverrides.maxTicketsPerSession");
    expect(await readFile(configPath, "utf-8")).toBe(text);
  });

  it("refuses an escaped-solidus duplicate in the delta", async () => {
    const message = await refusalMessage({
      deep: true,
      json: '{"lensConfig": {"a/b": 1, "a\\/b": 2}}',
    });
    expect(message).toContain("--json delta");
    expect(message).toContain("lensConfig.a/b");
  });

  it("refuses an unverifiably deep delta cleanly, instead of crashing the command", async () => {
    // `JSON.parse` accepts this, so it gets past every syntax check and reaches
    // the duplicate scanner. That used to be a `RangeError` escaping to the top
    // level; it must be an ordinary refusal with the file untouched.
    const before = await readFile(configPath, "utf-8");
    const message = await refusalMessage({
      deep: true,
      json: `{"a":${"[".repeat(50_000)}${"]".repeat(50_000)}}`,
    });
    expect(message).toContain("duplicate keys");
    expect(await readFile(configPath, "utf-8")).toBe(before);
  });

  it("refuses a duplicate key in the delta too", async () => {
    const message = await refusalMessage({
      deep: true,
      json: '{"maxTicketsPerSession": 1, "maxTicketsPerSession": 2}',
    });
    expect(message).toContain("--json delta");
  });

  it("removing the duplicate restores saving", async () => {
    await writeFile(configPath, await withDuplicate("overrides"));
    await refusalMessage({ deep: true, json: JSON.stringify({ maxTicketsPerSession: 9 }) });

    await writeConfig({ ...baseConfig, recipeOverrides: { maxTicketsPerSession: 1 } });
    const accepted = await handleConfigSetOverrides(root, "json", {
      deep: true,
      json: JSON.stringify({ maxTicketsPerSession: 9 }),
    });
    expect(accepted.errorCode).toBeUndefined();
    expect((await readOverrides()).maxTicketsPerSession).toBe(9);
  });

  it("does NOT refuse a duplicate-bearing config on the shallow path", async () => {
    // Scoped deliberately. The shallow merge has always tolerated these, and
    // breaking existing callers is not this ticket's job; --deep is where a
    // nested merge makes the ambiguity dangerous.
    await writeFile(configPath, await withDuplicate("overrides"));
    const result = await handleConfigSetOverrides(root, "json", {
      json: JSON.stringify({ maxTicketsPerSession: 9 }),
    });
    expect(result.errorCode).toBeUndefined();
  });
});
