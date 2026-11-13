import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeConfig } from "../../src/core/merge-driver.js";
import { withProjectLock, writeConfig } from "../../src/core/project-loader.js";
import { BOARD_IDENTITY_RESOLVE_HINT } from "../../src/core/resolve-doc.js";
import { initProject } from "../../src/core/init.js";
import {
  BOARD_ID_REGEX, assertBoardsInitialised, boardRegistry, canonicalRef, checkBoardIdLanded,
  duplicateBoardIds, resolveAlias, resolveBoardRef,
} from "../../src/core/board-id.js";
import { handleBoardIdAdopt, handleBoardIdInit } from "../../src/cli/commands/board-id.js";
import { handleResolve } from "../../src/cli/commands/conflicts.js";
import { handleValidate } from "../../src/cli/commands/validate.js";
import { handleTeamDoctor } from "../../src/cli/commands/team-doctor.js";
import { loadProject } from "../../src/core/project-loader.js";
import { cleanupTempDirs, git, headFiles, isolateGit, makeFederation, makeProjectRepo, tempDir } from "../mcp/board-git-fixtures.js";
import { receipt } from "./receipt-fixture.js";

/** C-v4.1 section 2 (ISS-1433): durable board identity. Tests 2.5. */

let restoreGit: () => void;
beforeAll(() => { restoreGit = isolateGit(); });
afterAll(() => restoreGit());
afterEach(() => cleanupTempDirs());

const ID1 = "b-0123456789abcdef";
const ID2 = "b-fedcba9876543210";
const cfg = (extra: Record<string, unknown> = {}) => ({
  version: 2, project: "p", type: "npm", language: "ts",
  features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true }, ...extra,
});
const readConfig = (root: string) => JSON.parse(readFileSync(join(root, ".story", "config.json"), "utf-8")) as Record<string, unknown>;
const writeConfigRaw = (root: string, c: Record<string, unknown>) => writeFileSync(join(root, ".story", "config.json"), JSON.stringify(c, null, 2) + "\n");
const conflictsOf = (c: Record<string, unknown>) => (c._conflicts as Record<string, unknown>[] | undefined) ?? [];

describe("2.2 mergeConfig: a boardId difference never settles silently", () => {
  it.each([
    ["divergent init", cfg(), cfg({ boardId: ID1 }), cfg({ boardId: ID2 }), { base: null, ours: ID1, theirs: ID2 }, ID1],
    ["one-sided replacement (theirs)", cfg({ boardId: ID1 }), cfg({ boardId: ID1 }), cfg({ boardId: ID2 }), { base: ID1, ours: ID1, theirs: ID2 }, ID1],
    ["one-sided replacement (ours)", cfg({ boardId: ID1 }), cfg({ boardId: ID2 }), cfg({ boardId: ID1 }), { base: ID1, ours: ID2, theirs: ID1 }, ID1],
    ["one-sided removal", cfg({ boardId: ID1 }), cfg(), cfg({ boardId: ID1 }), { base: ID1, ours: null, theirs: ID1 }, ID1],
  ])("%s writes a board-identity conflict keeping all three values", (_l, base, ours, theirs, sides, merged) => {
    const m = mergeConfig(base, ours, theirs);
    expect(m.merged.boardId).toBe(merged);
    const c = conflictsOf(m.merged).filter((e) => e.kind === "board-identity");
    expect(c).toEqual([{ fieldPath: "/boardId", field: "boardId", kind: "board-identity", ...sides }]);
  });

  it("is clean for a one-sided add and for identical values", () => {
    expect(conflictsOf(mergeConfig(cfg(), cfg({ boardId: ID1 }), cfg()).merged)).toEqual([]);
    expect(mergeConfig(cfg(), cfg({ boardId: ID1 }), cfg()).merged.boardId).toBe(ID1);
    expect(conflictsOf(mergeConfig(cfg({ boardId: ID1 }), cfg({ boardId: ID1 }), cfg({ boardId: ID1, project: "q" })).merged)).toEqual([]);
  });
});

describe("2.1 the real config writer never changes or removes a boardId", () => {
  it("refuses a change and a removal, allows an add and an unchanged write", async () => {
    const root = tempDir("bid-writer");
    await initProject(root, { name: "w" });
    const minted = readConfig(root).boardId as string;
    await expect(writeConfig({ ...readConfig(root), boardId: ID2 } as never, root)).rejects.toThrow(/board_id_immutable/);
    const { boardId: _drop, ...without } = readConfig(root);
    await expect(writeConfig(without as never, root)).rejects.toThrow(/board_id_immutable/);
    expect(readConfig(root).boardId).toBe(minted);
    await writeConfig({ ...readConfig(root), project: "renamed" } as never, root);
    expect(readConfig(root)).toMatchObject({ project: "renamed", boardId: minted });
  });
});

describe("init and board-id init mint the id; nothing else does", () => {
  it("init mints a b- id and init --force keeps it", async () => {
    const root = tempDir("bid-init");
    await initProject(root, { name: "a" });
    const id = readConfig(root).boardId as string;
    expect(id).toMatch(BOARD_ID_REGEX);
    await initProject(root, { name: "a", force: true });
    expect(readConfig(root).boardId).toBe(id);
  });

  it("board-id init mints an id on a board without one and commits only config.json", async () => {
    const { root } = await makeProjectRepo({ prefix: "bid-cli" });
    const c = readConfig(root);
    delete c.boardId;
    writeConfigRaw(root, c);
    writeFileSync(join(root, "stray.txt"), "not committed\n");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "drop id");
    writeFileSync(join(root, "stray.txt"), "still not committed\n");
    const result = await handleBoardIdInit(root, "json");
    expect(result.exitCode ?? 0).toBe(0);
    expect(readConfig(root).boardId).toMatch(BOARD_ID_REGEX);
    expect(headFiles(root)).toEqual([".story/config.json"]);
  });

  it("board-id init refuses a board that already has one", async () => {
    const { root } = await makeProjectRepo({ prefix: "bid-again" });
    const before = readConfig(root).boardId;
    const result = await handleBoardIdInit(root, "md");
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/already has the board id/);
    expect(readConfig(root).boardId).toBe(before);
  });
});

describe("2.1 the landed-check (helper level; receipt add runs it in commit 3)", () => {
  it("reports missing without minting one", async () => {
    const { root } = await makeProjectRepo({ prefix: "bid-missing" });
    const c = readConfig(root);
    delete c.boardId;
    writeConfigRaw(root, c);
    const bytes = readFileSync(join(root, ".story", "config.json"), "utf-8");
    expect(checkBoardIdLanded(root, "main")).toMatchObject({ ok: false, code: "board_id_missing" });
    expect(readFileSync(join(root, ".story", "config.json"), "utf-8")).toBe(bytes);
  });

  it("reports not landed, then ok once the id is on the default branch", async () => {
    const { root } = await makeProjectRepo({ prefix: "bid-landed", commit: false });
    git(root, "commit", "-q", "--allow-empty", "-m", "root");
    expect(checkBoardIdLanded(root, "main")).toMatchObject({ ok: false, code: "board_id_not_landed" });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    expect(checkBoardIdLanded(root, "main")).toEqual({ ok: true, boardId: readConfig(root).boardId });
  });

  it("reports conflicted while a board-identity conflict is open", async () => {
    const { root } = await makeProjectRepo({ prefix: "bid-conf" });
    const c = readConfig(root);
    writeConfigRaw(root, { ...c, _conflicts: [{ fieldPath: "/boardId", field: "boardId", kind: "board-identity", base: null, ours: c.boardId, theirs: ID2 }] });
    expect(checkBoardIdLanded(root, "main")).toMatchObject({ ok: false, code: "board_id_conflicted" });
  });

  it("two clones run init; the second meets the conflict, reads diverged, and adopt lets it through", async () => {
    const origin = tempDir("bid-origin");
    git(origin, "init", "-q", "--bare", "-b", "main");
    const seed = await makeProjectRepo({ prefix: "bid-seed" });
    const seedConfig = readConfig(seed.root);
    delete seedConfig.boardId;
    writeConfigRaw(seed.root, seedConfig);
    git(seed.root, "commit", "-q", "-am", "no id yet");
    git(seed.root, "push", "-q", origin, "main");
    const one = tempDir("bid-one");
    const two = tempDir("bid-two");
    git(one, "clone", "-q", origin, ".");
    git(two, "clone", "-q", origin, ".");
    await handleBoardIdInit(one, "json");
    await handleBoardIdInit(two, "json");
    git(one, "push", "-q", "origin", "main");
    git(two, "fetch", "-q", "origin");
    const landed = readConfig(one).boardId as string;
    const local = readConfig(two).boardId as string;
    expect(local).not.toBe(landed);
    // The merge the second clone meets (the merge driver runs mergeConfig).
    const merged = mergeConfig(seedConfig, readConfig(two), readConfig(one)).merged;
    expect(conflictsOf(merged).map((e) => e.kind)).toEqual(["board-identity"]);
    expect(checkBoardIdLanded(two, "origin/main")).toMatchObject({ ok: false, code: "board_id_diverged", local, landed });
    // resolve refuses it and names adopt.
    writeConfigRaw(two, merged);
    await expect(handleResolve("config", two, { field: "boardId", use: "theirs" })).rejects.toThrow(/board-id adopt/);
    const blanket = await handleResolve("config", two, { use: "theirs" });
    expect(blanket.output).toMatch(/board-id adopt/);
    expect(conflictsOf(readConfig(two)).map((e) => e.kind)).toEqual(["board-identity"]);
    expect(checkBoardIdLanded(two, "origin/main")).toMatchObject({ code: "board_id_conflicted" });
    // adopt takes the landed id, clears the conflict, commits only config.json.
    const adopted = await handleBoardIdAdopt(two, { ref: "origin/main" }, "json");
    expect(adopted.exitCode ?? 0).toBe(0);
    expect(readConfig(two).boardId).toBe(landed);
    expect(conflictsOf(readConfig(two))).toEqual([]);
    expect(headFiles(two)).toEqual([".story/config.json"]);
    expect(checkBoardIdLanded(two, "origin/main")).toEqual({ ok: true, boardId: landed });
  });

  it("adopt refuses while a receipt on this board names the local id, and names it", async () => {
    const origin = await makeProjectRepo({ prefix: "bid-adopt-ref" });
    const local = readConfig(origin.root).boardId as string;
    git(origin.root, "branch", "landed");
    const r = receipt({ id: "rc-aaaaaaaaaaaaaaaa", target: `${local}:t-0000000000000000` });
    writeFileSync(join(origin.root, ".story", "tickets", "T-001.json"), JSON.stringify({
      id: "T-001", title: "t", description: "", type: "task", status: "open", phase: "p0", order: 10,
      createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null, receipts: [r],
    }, null, 2) + "\n");
    // Make the landed branch carry a different id.
    git(origin.root, "checkout", "-q", "landed");
    writeConfigRaw(origin.root, { ...readConfig(origin.root), boardId: ID2 });
    git(origin.root, "commit", "-q", "-am", "other id");
    git(origin.root, "checkout", "-q", "main");
    const result = await handleBoardIdAdopt(origin.root, { ref: "landed" }, "md");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("rc-aaaaaaaaaaaaaaaa");
    expect(readConfig(origin.root).boardId).toBe(local);
  });
});

describe("2.2 and 2.4 federation references, read only", () => {
  it("a first use across an uninitialised federation refuses once, naming every board, and writes nothing", async () => {
    const { orch, node } = await makeFederation();
    const nodeConfig = readConfig(node);
    delete nodeConfig.boardId;
    writeConfigRaw(node, nodeConfig);
    const before = [readFileSync(join(orch, ".story", "config.json"), "utf-8"), readFileSync(join(node, ".story", "config.json"), "utf-8")];
    const registry = boardRegistry(orch);
    expect(() => assertBoardsInitialised(registry, [".", "api"])).toThrow(/board_id_missing: \. \(.*\), api \(.*\)/);
    expect([readFileSync(join(orch, ".story", "config.json"), "utf-8"), readFileSync(join(node, ".story", "config.json"), "utf-8")]).toEqual(before);
  });

  it("two boards with one id resolve to duplicate, and validate and team doctor --ci report both paths", async () => {
    const { orch, node } = await makeFederation();
    writeConfigRaw(orch, { ...readConfig(orch), boardId: ID1, team: { enabled: true } });
    writeConfigRaw(node, { ...readConfig(node), boardId: ID1 });
    const registry = boardRegistry(orch);
    expect(resolveBoardRef(registry, ID1)).toEqual({ state: "duplicate", paths: [orch, node] });
    expect(duplicateBoardIds(registry)).toEqual([{ boardId: ID1, paths: [orch, node] }]);
    const loaded = await loadProject(orch);
    const v = handleValidate({ state: loaded.state, warnings: loaded.warnings, root: orch, handoversDir: join(orch, ".story", "handovers"), format: "json" });
    expect(v.exitCode).not.toBe(0);
    expect(v.output).toContain("duplicate_board_id");
    expect(v.output).toContain(node);
    const d = await handleTeamDoctor(orch, { ci: true, format: "json" });
    expect(d.exitCode).toBe(1);
    expect(d.output).toContain("duplicate_board_id");
    expect(d.output).toContain(node);
  });

  it("an alias rename keeps the meaning, a rebind is mismatched, a removal is unresolved", async () => {
    const { orch, node } = await makeFederation();
    const nodeId = readConfig(node).boardId as string;
    const ref = canonicalRef(nodeId, "t-0000000000000000");
    expect(ref).toBe(`${nodeId}:t-0000000000000000`);
    const orchConfig = readConfig(orch);
    const nodes = orchConfig.nodes as Record<string, unknown>;
    writeConfigRaw(orch, { ...orchConfig, nodes: { backend: nodes.api } });
    expect(resolveBoardRef(boardRegistry(orch), nodeId)).toMatchObject({ state: "ok", entry: { alias: "backend", path: node } });
    const other = tempDir("bid-rebind");
    await initProject(other, { name: "other" });
    writeConfigRaw(orch, { ...orchConfig, nodes: { api: { ...(nodes.api as object), path: other } } });
    expect(resolveAlias(boardRegistry(orch), "api", nodeId)).toMatchObject({ state: "mismatched", expected: nodeId, path: other });
    expect(resolveBoardRef(boardRegistry(orch), nodeId).state).toBe("unresolved");
    writeConfigRaw(orch, { ...orchConfig, nodes: {} });
    expect(resolveAlias(boardRegistry(orch), "api", nodeId).state).toBe("unresolved");
  });

  it("the same ref resolves to the same board from the root and from a child", async () => {
    const { orch, node } = await makeFederation();
    writeConfigRaw(node, { ...readConfig(node), orchestrator: orch });
    writeConfigRaw(orch, { ...readConfig(orch), boardId: ID1 });
    const nodeId = readConfig(node).boardId as string;
    for (const id of [ID1, nodeId]) {
      expect(resolveBoardRef(boardRegistry(node), id)).toEqual(resolveBoardRef(boardRegistry(orch), id));
    }
    expect(resolveBoardRef(boardRegistry(node), nodeId)).toMatchObject({ state: "ok", entry: { path: node } });
  });
});

describe("review fixes: board identity", () => {
  const ticketWith = (id: string, receipts: unknown[], over: Record<string, unknown> = {}) => JSON.stringify({
    id, title: "t", description: "", type: "task", status: "open", phase: "p0", order: 10,
    createdDate: "2026-01-01", completedDate: null, blockedBy: [], parentTicket: null, receipts, ...over,
  }, null, 2) + "\n";

  /** A repo whose branch `landed` carries ID2, so adopt would replace the local id. */
  async function adoptRepo(prefix: string) {
    const { root } = await makeProjectRepo({ prefix });
    const local = readConfig(root).boardId as string;
    git(root, "checkout", "-q", "-b", "landed");
    writeConfigRaw(root, { ...readConfig(root), boardId: ID2 });
    git(root, "commit", "-q", "-am", "other id");
    git(root, "checkout", "-q", "main");
    return { root, local };
  }

  it("board-id init reads and writes under one lock, so a concurrent config edit survives", async () => {
    const { root } = await makeProjectRepo({ prefix: "bid-lock" });
    const c = readConfig(root);
    delete c.boardId;
    writeConfigRaw(root, c);
    git(root, "commit", "-q", "-am", "drop id");
    let held!: () => void;
    let release!: () => void;
    const isHeld = new Promise<void>((r) => { held = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const holder = withProjectLock(root, { strict: false }, async () => { held(); await gate; });
    await isHeld;
    const init = handleBoardIdInit(root, "json");
    await new Promise((r) => setTimeout(r, 200));
    writeConfigRaw(root, { ...readConfig(root), project: "edited-concurrently" });
    release();
    await holder;
    const result = await init;
    expect(result.exitCode ?? 0).toBe(0);
    expect(readConfig(root)).toMatchObject({ project: "edited-concurrently", boardId: expect.stringMatching(BOARD_ID_REGEX) });
  });

  it("adopt refuses when an otherwise schema-invalid record holds a receipt naming the local id", async () => {
    const { root, local } = await adoptRepo("bid-adopt-invalid");
    const r = receipt({ id: "rc-dddddddddddddddd", target: `${local}:t-0000000000000000` });
    writeFileSync(join(root, ".story", "tickets", "T-002.json"), ticketWith("T-002", [r], { status: 42, type: "nonsense" }));
    const result = await handleBoardIdAdopt(root, { ref: "landed" }, "md");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("rc-dddddddddddddddd");
    expect(readConfig(root).boardId).toBe(local);
  });

  it("adopt refuses when a ticket or issue record cannot be inspected", async () => {
    const { root, local } = await adoptRepo("bid-adopt-unreadable");
    writeFileSync(join(root, ".story", "issues", "ISS-001.json"), "{ not json\n");
    const result = await handleBoardIdAdopt(root, { ref: "landed" }, "md");
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/cannot be inspected/);
    expect(result.output).toContain("ISS-001.json");
    expect(readConfig(root).boardId).toBe(local);
  });

  /** A repo whose branch `landed` carries this board's id with an open board-identity conflict. */
  async function landedConflictRepo(prefix: string) {
    const { root } = await makeProjectRepo({ prefix });
    const local = readConfig(root).boardId as string;
    git(root, "checkout", "-q", "-b", "landed");
    writeConfigRaw(root, { ...readConfig(root), _conflicts: [{ fieldPath: "/boardId", field: "boardId", kind: "board-identity", base: null, ours: local, theirs: ID2 }] });
    git(root, "commit", "-q", "-am", "landed with an open identity conflict");
    git(root, "checkout", "-q", "main");
    return { root, local };
  }

  it("the landed-check reads conflicted while the landed config's own board identity is unresolved", async () => {
    const { root } = await landedConflictRepo("bid-landed-conf");
    expect(checkBoardIdLanded(root, "landed")).toMatchObject({ ok: false, code: "board_id_conflicted" });
  });

  it("adopt refuses to clear a local conflict from a landed identity that is itself unresolved", async () => {
    const { root, local } = await landedConflictRepo("bid-adopt-landed-conf");
    writeConfigRaw(root, { ...readConfig(root), _conflicts: [{ fieldPath: "/boardId", field: "boardId", kind: "board-identity", base: null, ours: local, theirs: ID2 }] });
    const result = await handleBoardIdAdopt(root, { ref: "landed" }, "md");
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/unresolved board identity conflict/);
    expect(conflictsOf(readConfig(root)).map((e) => e.kind)).toEqual(["board-identity"]);
  });

  it("the board-identity hint names the command as it is and what it adopts", () => {
    expect(BOARD_IDENTITY_RESOLVE_HINT).not.toContain("<b-id>");
    expect(BOARD_IDENTITY_RESOLVE_HINT).toContain("`storybloq board-id adopt`");
    expect(BOARD_IDENTITY_RESOLVE_HINT).toMatch(/landed board id on the default branch/);
  });
});
