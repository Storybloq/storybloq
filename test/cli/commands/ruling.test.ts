import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleRulingList,
  handleRulingGet,
  handleRulingCreate,
  handleRulingSupersede,
} from "../../../src/cli/commands/ruling.js";
import { CliValidationError } from "../../../src/cli/helpers.js";
import { initProject } from "../../../src/core/init.js";
import { makeState } from "../../core/test-factories.js";
import type { CommandContext } from "../../../src/cli/types.js";

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    state: makeState(),
    warnings: [],
    root: "/tmp/test",
    handoversDir: "/tmp/test/.story/handovers",
    format: "md",
    ...overrides,
  };
}

const tmpDirs: string[] = [];
afterEach(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

async function newProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ruling-cli-"));
  tmpDirs.push(dir);
  await initProject(dir, { name: "test" });
  return dir;
}

const BASE_CREATE_ARGS = {
  text: "Verbatim ruling text.",
  attribution: "owner-direct",
  date: "2026-08-27",
  scopeTags: [],
  clientTaskId: "test-session-1",
};

describe("handleRulingCreate", () => {
  it("creates a ruling with a canonical r- id and the caller's identity as recordedBy", async () => {
    const dir = await newProject();
    const result = await handleRulingCreate(BASE_CREATE_ARGS, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.id).toMatch(/^r-[0-9a-hjkmnp-tv-z]{16}$/);
    expect(parsed.data.text).toBe("Verbatim ruling text.");
    expect(parsed.data.recordedBy).toEqual({ client: "claude", id: "test-session-1" });
    expect(parsed.data.supersedes).toBeNull();
  });

  it("does not trim or alter the verbatim text", async () => {
    const dir = await newProject();
    const result = await handleRulingCreate(
      { ...BASE_CREATE_ARGS, text: "  spaced text with a `backtick`  " },
      "json",
      dir,
    );
    const parsed = JSON.parse(result.output);
    expect(parsed.data.text).toBe("  spaced text with a `backtick`  ");
  });

  it("rejects an unknown attribution value", async () => {
    const dir = await newProject();
    await expect(
      handleRulingCreate({ ...BASE_CREATE_ARGS, attribution: "owner-implied" }, "json", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("throws when no caller identity can be resolved", async () => {
    const dir = await newProject();
    const { clientTaskId: _drop, ...withoutIdentity } = BASE_CREATE_ARGS;
    const savedSessionId = process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    try {
      await expect(handleRulingCreate(withoutIdentity, "json", dir)).rejects.toThrow(CliValidationError);
    } finally {
      // Restore rather than leave deleted -- other tests in this file (and
      // any run after it in the same process) rely on ambient identity
      // resolution and must not silently start failing from this leak.
      if (savedSessionId !== undefined) process.env.CLAUDE_CODE_SESSION_ID = savedSessionId;
    }
  });

  it("accepts explicit scopeTags", async () => {
    const dir = await newProject();
    const result = await handleRulingCreate({ ...BASE_CREATE_ARGS, scopeTags: ["duet-mode", "N-108"] }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.scopeTags).toEqual(["duet-mode", "N-108"]);
  });
});

describe("handleRulingGet / handleRulingList", () => {
  it("returns not_found for a nonexistent ruling", async () => {
    const dir = await newProject();
    const ctx = makeCtx({ root: dir });
    const result = handleRulingGet("r-0000000000000099", ctx);
    expect(result.errorCode).toBe("not_found");
  });

  it("lists created rulings and filters by scopeTag", async () => {
    const dir = await newProject();
    await handleRulingCreate({ ...BASE_CREATE_ARGS, scopeTags: ["alpha"] }, "json", dir);
    await handleRulingCreate({ ...BASE_CREATE_ARGS, text: "second", scopeTags: ["beta"] }, "json", dir);
    const ctx = makeCtx({ root: dir, format: "json" });
    const all = JSON.parse(handleRulingList({}, ctx).output);
    expect(all.data).toHaveLength(2);
    const filtered = JSON.parse(handleRulingList({ scopeTag: "alpha" }, ctx).output);
    expect(filtered.data).toHaveLength(1);
    expect(filtered.data[0].scopeTags).toEqual(["alpha"]);
  });

  it("filters superseded vs current", async () => {
    const dir = await newProject();
    const created = await handleRulingCreate(BASE_CREATE_ARGS, "json", dir);
    const oldId = JSON.parse(created.output).data.id;
    await handleRulingSupersede(oldId, { text: "new text", attribution: "owner-direct", date: "2026-08-28", clientTaskId: "test-session-1" }, "json", dir);
    const ctx = makeCtx({ root: dir, format: "json" });
    const supersededOnly = JSON.parse(handleRulingList({ superseded: true }, ctx).output);
    expect(supersededOnly.data).toHaveLength(1);
    expect(supersededOnly.data[0].id).toBe(oldId);
    const currentOnly = JSON.parse(handleRulingList({ superseded: false }, ctx).output);
    expect(currentOnly.data).toHaveLength(1);
    expect(currentOnly.data[0].id).not.toBe(oldId);
  });

  it("codex round-2 finding 1/6: excludes a ruling from the superseded/current filter rather than falsely reporting it as current when the ledger has an unreadable file", async () => {
    const dir = await newProject();
    const created = await handleRulingCreate(BASE_CREATE_ARGS, "json", dir);
    const readableId = JSON.parse(created.output).data.id;
    // Simulate an unreadable ruling elsewhere in the ledger (e.g. a hidden
    // successor this readable ruling's true chain state depends on knowing
    // about). Nothing links it to readableId by id -- the taint is global,
    // exactly like resolveCitation's own unavailableIds handling.
    await mkdir(join(dir, ".story", "rulings"), { recursive: true });
    await writeFile(join(dir, ".story", "rulings", "r-9999999999999999.json"), "{not json");

    const ctx = makeCtx({ root: dir, format: "json" });
    const currentOnly = JSON.parse(handleRulingList({ superseded: false }, ctx).output);
    // Before the fix, a naive successorsByTarget lookup would have included
    // readableId here (nothing loaded claims to supersede it) even though
    // the unreadable file could hide the true successor.
    expect(currentOnly.data.map((r: { id: string }) => r.id)).not.toContain(readableId);
    const listResult = handleRulingList({ superseded: false }, ctx);
    expect(listResult.warnings?.some((w) => /unverif|unreadable/i.test(w))).toBe(true);
  });

  it("codex round-3 finding 1/5/6: excludes from the filter AND refuses supersede when the unreadable file's id cannot even be recovered from its filename", async () => {
    const dir = await newProject();
    const created = await handleRulingCreate(BASE_CREATE_ARGS, "json", dir);
    const readableId = JSON.parse(created.output).data.id;
    // Distinct from the round-2 regression above: this file's NAME is not
    // itself canonical-id-shaped, so `unavailableIds` cannot name it at all
    // (recoverIdFromFilename finds nothing) -- only hasUnrecoverableEntries
    // can carry the taint here.
    await mkdir(join(dir, ".story", "rulings"), { recursive: true });
    await writeFile(join(dir, ".story", "rulings", "copy-of-ruling.json"), "{not json");

    const ctx = makeCtx({ root: dir, format: "json" });
    const currentOnly = JSON.parse(handleRulingList({ superseded: false }, ctx).output);
    expect(currentOnly.data.map((r: { id: string }) => r.id)).not.toContain(readableId);
    const listResult = handleRulingList({ superseded: false }, ctx);
    expect(listResult.warnings?.some((w) => /unverif|unreadable/i.test(w))).toBe(true);

    await expect(
      handleRulingSupersede(
        readableId,
        { text: "new text", attribution: "owner-direct", date: "2026-08-28", clientTaskId: "test-session-1" },
        "json",
        dir,
      ),
    ).rejects.toThrow(CliValidationError);
  });

  it("get on a superseded ruling reports its chain status as superseded", async () => {
    const dir = await newProject();
    const created = await handleRulingCreate(BASE_CREATE_ARGS, "json", dir);
    const oldId = JSON.parse(created.output).data.id;
    const superseding = await handleRulingSupersede(
      oldId,
      { text: "new text", attribution: "owner-direct", date: "2026-08-28", clientTaskId: "test-session-1" },
      "json",
      dir,
    );
    const newId = JSON.parse(superseding.output).data.id;
    const ctx = makeCtx({ root: dir, format: "json" });
    const result = JSON.parse(handleRulingGet(oldId, ctx).output);
    expect(result.data.chainStatus.status).toBe("resolved");
    expect(result.data.chainStatus.stale).toBe(true);
    expect(result.data.chainStatus.current.id).toBe(newId);
  });
});

describe("handleRulingSupersede", () => {
  it("create-and-supersede: creates a new ruling whose supersedes points at the old one", async () => {
    const dir = await newProject();
    const created = await handleRulingCreate(BASE_CREATE_ARGS, "json", dir);
    const oldId = JSON.parse(created.output).data.id;
    const result = await handleRulingSupersede(
      oldId,
      { text: "the new ruling", attribution: "manager-delegated", date: "2026-08-28", clientTaskId: "test-session-1" },
      "json",
      dir,
    );
    const parsed = JSON.parse(result.output);
    expect(parsed.data.supersedes).toBe(oldId);
    expect(parsed.data.noop).toBe(false);
  });

  it("--with: links an existing ruling with a null supersedes to the old one (one-time write)", async () => {
    const dir = await newProject();
    const oldId = JSON.parse((await handleRulingCreate(BASE_CREATE_ARGS, "json", dir)).output).data.id;
    const newId = JSON.parse((await handleRulingCreate({ ...BASE_CREATE_ARGS, text: "b" }, "json", dir)).output).data.id;
    const result = await handleRulingSupersede(oldId, { withId: newId, clientTaskId: "test-session-1" }, "json", dir);
    const parsed = JSON.parse(result.output);
    expect(parsed.data.id).toBe(newId);
    expect(parsed.data.supersedes).toBe(oldId);
    expect(parsed.data.noop).toBe(false);
  });

  it("--with is idempotent when new.supersedes already equals old (no-op, no write)", async () => {
    const dir = await newProject();
    const oldId = JSON.parse((await handleRulingCreate(BASE_CREATE_ARGS, "json", dir)).output).data.id;
    const newId = JSON.parse((await handleRulingCreate({ ...BASE_CREATE_ARGS, text: "b" }, "json", dir)).output).data.id;
    await handleRulingSupersede(oldId, { withId: newId, clientTaskId: "test-session-1" }, "json", dir);
    const retry = await handleRulingSupersede(oldId, { withId: newId, clientTaskId: "test-session-1" }, "json", dir);
    const parsed = JSON.parse(retry.output);
    expect(parsed.data.noop).toBe(true);
  });

  it("--with refuses to repoint a successor that already supersedes something else (never a silent chain repoint)", async () => {
    const dir = await newProject();
    const a = JSON.parse((await handleRulingCreate(BASE_CREATE_ARGS, "json", dir)).output).data.id;
    const b = JSON.parse((await handleRulingCreate({ ...BASE_CREATE_ARGS, text: "b" }, "json", dir)).output).data.id;
    const c = JSON.parse((await handleRulingCreate({ ...BASE_CREATE_ARGS, text: "c" }, "json", dir)).output).data.id;
    await handleRulingSupersede(a, { withId: b, clientTaskId: "test-session-1" }, "json", dir);
    await expect(
      handleRulingSupersede(c, { withId: b, clientTaskId: "test-session-1" }, "json", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("refuses a self-link", async () => {
    const dir = await newProject();
    const a = JSON.parse((await handleRulingCreate(BASE_CREATE_ARGS, "json", dir)).output).data.id;
    await expect(
      handleRulingSupersede(a, { withId: a, clientTaskId: "test-session-1" }, "json", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("refuses withId combined with create-only fields (text/attribution/date/scopeTags), rather than silently discarding them", async () => {
    const dir = await newProject();
    const a = JSON.parse((await handleRulingCreate(BASE_CREATE_ARGS, "json", dir)).output).data.id;
    const b = JSON.parse((await handleRulingCreate({ ...BASE_CREATE_ARGS, text: "b" }, "json", dir)).output).data.id;
    await expect(
      handleRulingSupersede(a, { withId: b, scopeTags: ["should-not-be-silently-dropped"], clientTaskId: "test-session-1" }, "json", dir),
    ).rejects.toThrow(CliValidationError);
    await expect(
      handleRulingSupersede(a, { withId: b, text: "unexpected", clientTaskId: "test-session-1" }, "json", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("refuses a branch (two rulings both superseding the same target)", async () => {
    const dir = await newProject();
    const a = JSON.parse((await handleRulingCreate(BASE_CREATE_ARGS, "json", dir)).output).data.id;
    const b = JSON.parse((await handleRulingCreate({ ...BASE_CREATE_ARGS, text: "b" }, "json", dir)).output).data.id;
    const c = JSON.parse((await handleRulingCreate({ ...BASE_CREATE_ARGS, text: "c" }, "json", dir)).output).data.id;
    await handleRulingSupersede(a, { withId: b, clientTaskId: "test-session-1" }, "json", dir);
    await expect(
      handleRulingSupersede(a, { withId: c, clientTaskId: "test-session-1" }, "json", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("refuses when the old ruling does not exist", async () => {
    const dir = await newProject();
    const b = JSON.parse((await handleRulingCreate(BASE_CREATE_ARGS, "json", dir)).output).data.id;
    await expect(
      handleRulingSupersede("r-0000000000000099", { withId: b, clientTaskId: "test-session-1" }, "json", dir),
    ).rejects.toThrow(CliValidationError);
  });

  it("ruling #3: fails closed (refuses) when any ruling in the project is unreadable", async () => {
    const dir = await newProject();
    const a = JSON.parse((await handleRulingCreate(BASE_CREATE_ARGS, "json", dir)).output).data.id;
    // A completely unrelated broken ruling file elsewhere in the project.
    await mkdir(join(dir, ".story", "rulings"), { recursive: true });
    await writeFile(join(dir, ".story", "rulings", "r-zzzzzzzzzzzzzzzz.json"), "{not json", "utf8");
    await expect(
      handleRulingSupersede(
        a,
        { text: "new", attribution: "owner-direct", date: "2026-08-28", clientTaskId: "test-session-1" },
        "json",
        dir,
      ),
    ).rejects.toThrow(/unverifiable/);
  });

  it("requires either --with or the full text/attribution/date triple", async () => {
    const dir = await newProject();
    const a = JSON.parse((await handleRulingCreate(BASE_CREATE_ARGS, "json", dir)).output).data.id;
    await expect(
      handleRulingSupersede(a, { clientTaskId: "test-session-1" }, "json", dir),
    ).rejects.toThrow(CliValidationError);
  });
});
