/**
 * T-538 S1 review: immutable checkpoint evidence on the filesystem. Sources
 * are read through one no-follow handle that must be the regular file that
 * was checked; destinations are written only through real directories; refs
 * on an immutable checkpoint are stored revisions whose bytes match their
 * names; and `--commit` commits the copied file with the ticket.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { chmod, mkdtemp, rm, readFile, writeFile, mkdir, readdir, rename, symlink, truncate, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { initProject } from "../../src/core/init.js";
import {
  addCheckpointEvidence,
  attachCheckpoint,
  changeCheckpoint,
  createCheckpoint,
  resolveCheckpoint,
  type ExpectedCheckpoint,
} from "../../src/core/checkpoint-lifecycle.js";
import { parseOwnerCheckpoint, type OwnerCheckpoint } from "../../src/core/owner-checkpoint.js";
import { handleTicketCreate } from "../../src/cli/commands/ticket.js";
import { runWithBoardWriteContext } from "../../src/core/board-write-recorder.js";
import { reportBoardWrite } from "../../src/core/board-git-state.js";
import type { Ticket } from "../../src/models/ticket.js";

const ACTOR = "owner@example.test";
const saved: Record<string, string | undefined> = {};
let scratchHome: string;

beforeAll(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), "t538-ev-home-"));
  for (const k of ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) saved[k] = process.env[k];
  process.env.HOME = scratchHome;
  process.env.GIT_CONFIG_GLOBAL = join(scratchHome, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  await writeFile(join(scratchHome, "gitconfig"), "[user]\n\tname = T\n\temail = t@example.test\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n");
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratchHome, { recursive: true, force: true });
});

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

async function project(): Promise<string> {
  const dir = await tempDir("t538-ev-");
  await initProject(dir, { name: "t538" });
  const path = join(dir, ".story", "config.json");
  const config = JSON.parse(await readFile(path, "utf-8"));
  config.schemaVersion = 5;
  await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  return dir;
}

function checkpointOf(t: object): OwnerCheckpoint {
  const p = parseOwnerCheckpoint(t);
  if (p.kind !== "ok") throw new Error(`not a readable checkpoint: ${p.kind}`);
  return p.checkpoint;
}
const expectedOf = (t: object): ExpectedCheckpoint => {
  const cp = checkpointOf(t);
  return { generation: cp.generation, revision: cp.revision, digest: cp.digest };
};
const ticketFile = (dir: string, id: string) => join(dir, ".story", "tickets", `${id}.json`);
const onDisk = async (dir: string, id: string) => JSON.parse(await readFile(ticketFile(dir, id), "utf-8")) as Ticket;
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const ACCEPTANCE = { kind: "acceptance" as const, criteria: "The demo prints the greeting", evidenceRefs: [] as string[] };

async function immutable(dir: string, evidenceRefs: string[] = []): Promise<Ticket> {
  return createCheckpoint(dir, {
    title: "Accept the demo", description: "", phase: "p0", owner: "owner",
    content: { ...ACCEPTANCE, evidenceRefs }, actor: ACTOR, evidenceMode: "immutable",
  });
}

async function source(dir: string, name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

/** The lock was released: a second, ordinary evidence add on the same checkpoint goes through. */
async function lockReleased(dir: string, cp: Ticket): Promise<void> {
  const ok = await source(dir, "after.txt", "after\n");
  const out = await addCheckpointEvidence(dir, cp.id, expectedOf(await onDisk(dir, cp.id)), { file: ok, actor: ACTOR });
  expect(out.reused).toBe(false);
}

const nothingIn = async (d: string) => expect(await readdir(d)).toEqual([]);

// ---------------------------------------------------------------------------

describe("the destination is never reached through a link", () => {
  it("a docs directory that links outside the project is refused, and nothing is written there", async () => {
    const dir = await project();
    const cp = await immutable(dir);
    const outside = await tempDir("t538-ev-out-");
    await symlink(outside, join(dir, "docs"));
    const src = await source(dir, "demo.txt", "hello\n");
    const before = await readFile(ticketFile(dir, cp.id), "utf-8");
    await expect(addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR })).rejects.toThrow(/docs is a link or not a directory/);
    await nothingIn(outside);
    expect(await readFile(ticketFile(dir, cp.id), "utf-8")).toBe(before);
  });

  it("a checkpoint directory that links outside is refused", async () => {
    const dir = await project();
    const cp = await immutable(dir);
    const outside = await tempDir("t538-ev-out-");
    await mkdir(join(dir, "docs", "checkpoints"), { recursive: true });
    await symlink(outside, join(dir, "docs", "checkpoints", cp.id));
    const src = await source(dir, "demo.txt", "hello\n");
    await expect(addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR })).rejects.toThrow(/is a link or not a directory/);
    await nothingIn(outside);
  });

  it("a target that is a link to matching bytes outside is refused, not reused", async () => {
    const dir = await project();
    const cp = await immutable(dir);
    const outside = await tempDir("t538-ev-out-");
    await writeFile(join(outside, "same.txt"), "hello\n");
    await mkdir(join(dir, "docs", "checkpoints", cp.id), { recursive: true });
    await symlink(join(outside, "same.txt"), join(dir, "docs", "checkpoints", cp.id, `${sha("hello\n").slice(0, 16)}.txt`));
    const src = await source(dir, "demo.txt", "hello\n");
    const before = await readFile(ticketFile(dir, cp.id), "utf-8");
    await expect(addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR })).rejects.toThrow(/is a link/);
    expect(await readFile(ticketFile(dir, cp.id), "utf-8")).toBe(before);
  });

  it("a checkpoint directory replaced by a link during publication is refused, and nothing lands outside", async () => {
    const dir = await project();
    const cp = await immutable(dir);
    const outside = await tempDir("t538-ev-out-");
    const src = await source(dir, "demo.txt", "hello\n");
    const cpDir = join(dir, "docs", "checkpoints", cp.id);
    const before = await readFile(ticketFile(dir, cp.id), "utf-8");
    await expect(addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR }, {
      async afterDestinationCheck() {
        await rename(cpDir, `${cpDir}-moved`);
        await symlink(outside, cpDir);
      },
    })).rejects.toThrow(/is a link or not a directory/);
    await nothingIn(outside);
    expect(await readFile(ticketFile(dir, cp.id), "utf-8")).toBe(before);
  });
  it("a swap during publication is refused before anything is created through it", async () => {
    // A read-only target directory: a create through the swapped link would
    // fail with a permission error, so the refusal must come first.
    const dir = await project();
    const cp = await immutable(dir);
    const outside = await tempDir("t538-ev-out-");
    await chmod(outside, 0o500);
    const src = await source(dir, "demo.txt", "hello\n");
    const cpDir = join(dir, "docs", "checkpoints", cp.id);
    try {
      await expect(addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR }, {
        async afterDestinationCheck() {
          await rename(cpDir, `${cpDir}-moved`);
          await symlink(outside, cpDir);
        },
      })).rejects.toThrow(/is a link or not a directory/);
    } finally {
      await chmod(outside, 0o700);
    }
  });
});


describe("a failed publication removes only the file it created", () => {
  it("an unrelated file of the same name behind a swapped directory is kept, and the created file is reported as an orphan", async () => {
    const dir = await project();
    const cp = await immutable(dir);
    const src = await source(dir, "demo.txt", "shown\n");
    const cpDir = join(dir, "docs", "checkpoints", cp.id);
    let name = "";
    const failure = await addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR }, {
      async afterCreate() {
        await rename(cpDir, `${cpDir}-moved`);
        name = (await readdir(`${cpDir}-moved`))[0]!;
        await mkdir(cpDir);
        await writeFile(join(cpDir, name), "unrelated\n");
      },
    }).then(() => null, (err: unknown) => err);
    expect(existsSync(join(cpDir, name))).toBe(true);
    expect(await readFile(join(cpDir, name), "utf-8")).toBe("unrelated\n");
    expect(String(failure)).toMatch(/orphan/);
    expect(await readFile(join(`${cpDir}-moved`, name), "utf-8")).toBe("shown\n");
  });

  it("a swap that still reaches the created file removes it", async () => {
    const dir = await project();
    const cp = await immutable(dir);
    const src = await source(dir, "demo.txt", "shown\n");
    const cpDir = join(dir, "docs", "checkpoints", cp.id);
    await expect(addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR }, {
      async afterCreate() {
        await rename(cpDir, `${cpDir}-moved`);
        await symlink(`${cpDir}-moved`, cpDir);
      },
    })).rejects.toThrow(/is a link or not a directory/);
    await nothingIn(`${cpDir}-moved`);
  });
});

describe("the source is read once, from the file that was checked", () => {
  it("a final component replaced between the check and the open is refused", async () => {
    const dir = await project();
    const cp = await immutable(dir);
    const src = await source(dir, "demo.txt", "checked\n");
    await expect(addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR }, {
      async afterSourceCheck() {
        // Renamed, not removed, so the checked inode stays allocated and the
        // replacement can never reuse it.
        await rename(src, `${src}.checked`);
        await writeFile(src, "swapped\n");
      },
    })).rejects.toThrow(/changed while it was being read/);
    expect(existsSync(join(dir, "docs"))).toBe(false);
  });

  it("a final component replaced by a link to a file outside is refused", async () => {
    const dir = await project();
    const cp = await immutable(dir);
    const outside = await tempDir("t538-ev-out-");
    await writeFile(join(outside, "secret.txt"), "secret\n");
    const src = await source(dir, "demo.txt", "checked\n");
    await expect(addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR }, {
      async afterSourceCheck() {
        await unlink(src);
        await symlink(join(outside, "secret.txt"), src);
      },
    })).rejects.toThrow(/is a link/);
    expect(existsSync(join(dir, "docs"))).toBe(false);
  });

  it("an ancestor replaced by a link to a directory outside is refused", async () => {
    const dir = await project();
    const cp = await immutable(dir);
    const outside = await tempDir("t538-ev-out-");
    await writeFile(join(outside, "demo.txt"), "secret\n");
    await mkdir(join(dir, "sub"));
    const src = await source(dir, join("sub", "demo.txt"), "checked\n");
    await expect(addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR }, {
      async afterSourceCheck() {
        await rename(join(dir, "sub"), join(dir, "sub-old"));
        await symlink(outside, join(dir, "sub"));
      },
    })).rejects.toThrow(/changed while it was being read/);
    expect(existsSync(join(dir, "docs"))).toBe(false);
  });

  it("an ancestor replaced by a link, even to the same directory moved inside the project, is refused", async () => {
    const dir = await project();
    const cp = await immutable(dir);
    await mkdir(join(dir, "sub"));
    const src = await source(dir, join("sub", "demo.txt"), "checked\n");
    await expect(addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR }, {
      async afterSourceCheck() {
        await rename(join(dir, "sub"), join(dir, "sub-old"));
        await symlink(join(dir, "sub-old"), join(dir, "sub"));
      },
    })).rejects.toThrow(/changed while it was being read/);
    expect(existsSync(join(dir, "docs"))).toBe(false);
  });

  it("a link inside the project, even to a file inside it, is refused", async () => {
    const dir = await project();
    const cp = await immutable(dir);
    await source(dir, "real.txt", "real\n");
    await symlink(join(dir, "real.txt"), join(dir, "alias.txt"));
    await expect(addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: join(dir, "alias.txt"), actor: ACTOR })).rejects.toThrow(/is a link/);
  });

  it("a FIFO is refused without blocking, and the lock is released", async () => {
    const dir = await project();
    const cp = await immutable(dir);
    execFileSync("mkfifo", [join(dir, "pipe.txt")]);
    await expect(addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: join(dir, "pipe.txt"), actor: ACTOR })).rejects.toThrow(/not a regular file/);
    await lockReleased(dir, cp);
  }, 15_000);

  it("a file over 32 MiB is refused, and the lock is released", async () => {
    const dir = await project();
    const cp = await immutable(dir);
    const big = await source(dir, "big.bin", "");
    await truncate(big, 32 * 1024 * 1024 + 1);
    await expect(addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: big, actor: ACTOR })).rejects.toThrow(/larger than 32 MiB/);
    expect(existsSync(join(dir, "docs"))).toBe(false);
    await lockReleased(dir, cp);
  });

  it("a file of exactly 32 MiB is accepted", async () => {
    const dir = await project();
    const cp = await immutable(dir);
    const big = await source(dir, "edge.bin", "");
    await truncate(big, 32 * 1024 * 1024);
    const out = await addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: big, actor: ACTOR });
    expect((await readFile(join(dir, out.ref))).length).toBe(32 * 1024 * 1024);
  });
});

describe("refs on an immutable checkpoint are stored revisions", () => {
  async function withRevision(dir: string): Promise<{ cp: Ticket; ref: string }> {
    const cp = await immutable(dir);
    const src = await source(dir, "demo.txt", "a\n");
    const out = await addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR });
    return { cp: out.ticket, ref: out.ref };
  }

  it("create refuses an arbitrary ref", async () => {
    const dir = await project();
    await expect(immutable(dir, ["build 42"])).rejects.toThrow(/not one of its stored revisions/);
    expect(await readdir(join(dir, ".story", "tickets"))).toEqual([]);
  });

  it("attach refuses an arbitrary ref", async () => {
    const dir = await project();
    const out = await handleTicketCreate({ title: "Work", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null }, "json", dir);
    const id = JSON.parse(out.output).data.id as string;
    await expect(attachCheckpoint(dir, id, { owner: "owner", content: { ...ACCEPTANCE, evidenceRefs: ["notes.md"] }, actor: ACTOR, evidenceMode: "immutable" }))
      .rejects.toThrow(/not one of its stored revisions/);
  });

  it("change refuses an arbitrary, a missing, a modified and a linked ref; a stored one is accepted", async () => {
    const dir = await project();
    const { cp, ref } = await withRevision(dir);
    const change = (refs: string[]) => changeCheckpoint(dir, cp.id, expectedOf(cp), { kind: "acceptance", criteria: "Changed criteria", evidenceRefs: refs }, ACTOR);
    await expect(change([ref, "build 42"])).rejects.toThrow(/not one of its stored revisions/);
    await expect(change([`docs/checkpoints/${cp.id}/0123456789abcdef.txt`])).rejects.toThrow(/does not exist/);
    // A ref naming another checkpoint's directory is not this checkpoint's revision.
    await expect(change([ref.replace(cp.id, "T-999")])).rejects.toThrow(/not one of its stored revisions/);
    const stored = join(dir, ref);
    await writeFile(stored, "modified\n");
    await expect(change([ref])).rejects.toThrow(/no longer holds the content its name records/);
    const outside = await tempDir("t538-ev-out-");
    await writeFile(join(outside, "a.txt"), "a\n");
    await unlink(stored);
    await symlink(join(outside, "a.txt"), stored);
    await expect(change([ref])).rejects.toThrow(/is a link/);
    await unlink(stored);
    await writeFile(stored, "a\n");
    const changed = await change([ref]);
    expect(checkpointOf(changed).evidenceRefs).toEqual([ref]);
  });

  it("resolve checks the approved file's bytes against its name", async () => {
    const dir = await project();
    const { cp, ref } = await withRevision(dir);
    await writeFile(join(dir, ref), "modified\n");
    await expect(resolveCheckpoint(dir, cp.id, expectedOf(cp), { response: "ok", artifactRef: ref, actor: ACTOR })).rejects.toThrow(/no longer holds the content its name records/);
    expect((await onDisk(dir, cp.id)).status).toBe("open");
  });

  it("resolve refuses an approved file replaced by a link to the same bytes", async () => {
    const dir = await project();
    const { cp, ref } = await withRevision(dir);
    const outside = await tempDir("t538-ev-out-");
    await writeFile(join(outside, "a.txt"), "a\n");
    await unlink(join(dir, ref));
    await symlink(join(outside, "a.txt"), join(dir, ref));
    await expect(resolveCheckpoint(dir, cp.id, expectedOf(cp), { response: "ok", artifactRef: ref, actor: ACTOR })).rejects.toThrow(/is a link/);
  });

  it("resolve refuses a missing approved file", async () => {
    const dir = await project();
    const { cp, ref } = await withRevision(dir);
    await unlink(join(dir, ref));
    await expect(resolveCheckpoint(dir, cp.id, expectedOf(cp), { response: "ok", artifactRef: ref, actor: ACTOR })).rejects.toThrow(/does not exist/);
  });
});

describe("evidence --commit commits the copied file with the ticket", () => {
  async function repo(): Promise<string> {
    const dir = await project();
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    return dir;
  }

  async function evidenceWithCommit(dir: string, cp: Ticket, file: string) {
    const { value, context } = await runWithBoardWriteContext("checkpoint evidence", true, () =>
      addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file, actor: ACTOR }));
    return { value, report: await reportBoardWrite(context) };
  }

  it("a fresh clone has the file the ref names, with matching bytes", async () => {
    const dir = await repo();
    const cp = await immutable(dir);
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "checkpoint"], { cwd: dir });
    const src = await source(dir, "demo.txt", "shown\n");
    const { value, report } = await evidenceWithCommit(dir, cp, src);
    expect(report.gitCommit?.[0]?.outcome).toBe("committed");
    expect(report.gitCommit?.[0]?.paths).toContain(value.ref);
    // Only the ticket and the copied file: the source stays uncommitted.
    expect(report.gitCommit?.[0]?.paths).toHaveLength(2);
    const clone = await tempDir("t538-ev-clone-");
    execFileSync("git", ["clone", "-q", dir, join(clone, "c")]);
    const cloned = await readFile(join(clone, "c", value.ref));
    expect(sha(cloned).slice(0, 16)).toBe(value.ref.split("/").pop()!.split(".")[0]);
    const ticket = JSON.parse(await readFile(join(clone, "c", ".story", "tickets", `${cp.id}.json`), "utf-8"));
    expect(checkpointOf(ticket).evidenceRefs).toEqual([value.ref]);
  });

  it("an ignored docs directory reports the commit incomplete, never committed", async () => {
    const dir = await repo();
    await writeFile(join(dir, ".gitignore"), "docs/\n");
    const cp = await immutable(dir);
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "checkpoint"], { cwd: dir });
    const src = await source(dir, "demo.txt", "shown\n");
    const { value, report } = await evidenceWithCommit(dir, cp, src);
    expect(report.gitCommit?.[0]?.outcome).toBe("incomplete");
    expect(report.gitCommit?.[0]?.reason).toContain(value.ref);
    expect(report.lines.some((l) => l.startsWith("Git: commit incomplete"))).toBe(true);
  });

  it("reusing a revision already on the record commits a file that was never committed", async () => {
    const dir = await repo();
    const cp = await immutable(dir);
    const src = await source(dir, "demo.txt", "shown\n");
    const first = await addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR });
    execFileSync("git", ["add", "-A", ".story"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "ticket only"], { cwd: dir });
    const { value, report } = await evidenceWithCommit(dir, first.ticket, src);
    expect(value.reused).toBe(true);
    expect(report.gitCommit?.[0]?.outcome).toBe("committed");
    expect(report.gitCommit?.[0]?.paths).toEqual([value.ref]);
  });

  it("an identical retry with --commit after a plain add commits the ticket's ref with the file", async () => {
    const dir = await repo();
    const cp = await immutable(dir);
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "checkpoint"], { cwd: dir });
    const src = await source(dir, "demo.txt", "shown\n");
    const first = await addCheckpointEvidence(dir, cp.id, expectedOf(cp), { file: src, actor: ACTOR });
    const { value, report } = await evidenceWithCommit(dir, first.ticket, src);
    expect(value.reused).toBe(true);
    expect(report.gitCommit?.[0]?.outcome).toBe("committed");
    const inHead = JSON.parse(execFileSync("git", ["show", `HEAD:.story/tickets/${cp.id}.json`], { cwd: dir, encoding: "utf-8" }));
    expect(checkpointOf(inHead).evidenceRefs).toEqual([value.ref]);
    expect(execFileSync("git", ["ls-tree", "--name-only", "HEAD", "--", value.ref], { cwd: dir, encoding: "utf-8" }).trim()).toBe(value.ref);
  });

  it("a hash-named checkpoint ticket is committed from its own file on reuse", async () => {
    const dir = await repo();
    const legacy = await immutable(dir);
    const hashId = "t-0123456789abcdef";
    const moved = { ...(await onDisk(dir, legacy.id)), id: hashId, displayId: legacy.id };
    await unlink(ticketFile(dir, legacy.id));
    await writeFile(ticketFile(dir, hashId), JSON.stringify(moved, null, 2) + "\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "checkpoint"], { cwd: dir });
    const src = await source(dir, "demo.txt", "shown\n");
    const cp = await onDisk(dir, hashId);
    const first = await addCheckpointEvidence(dir, hashId, expectedOf(cp), { file: src, actor: ACTOR });
    const { value, report } = await evidenceWithCommit(dir, first.ticket, src);
    expect(value.reused).toBe(true);
    expect(report.gitCommit?.[0]?.outcome).toBe("committed");
    expect(existsSync(ticketFile(dir, legacy.id))).toBe(false);
    const inHead = JSON.parse(execFileSync("git", ["show", `HEAD:.story/tickets/${hashId}.json`], { cwd: dir, encoding: "utf-8" }));
    expect(checkpointOf(inHead).evidenceRefs).toEqual([value.ref]);
    expect(execFileSync("git", ["status", "--porcelain", "--", ".story"], { cwd: dir, encoding: "utf-8" })).toBe("");
  });

  it("evidence in a nested repository is never committed apart from its ticket", async () => {
    const dir = await repo();
    const cp = await immutable(dir);
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "checkpoint"], { cwd: dir });
    await mkdir(join(dir, "docs"));
    execFileSync("git", ["init", "-q"], { cwd: join(dir, "docs") });
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" });
    const src = await source(dir, "demo.txt", "shown\n");
    const { report } = await evidenceWithCommit(dir, cp, src);
    expect(report.gitCommit?.length).toBeGreaterThan(0);
    for (const entry of report.gitCommit ?? []) expect(entry.outcome).toBe("incomplete");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" })).toBe(before);
    expect(execFileSync("git", ["rev-list", "--all", "--count"], { cwd: join(dir, "docs"), encoding: "utf-8" }).trim()).toBe("0");
    const line = report.lines.find((l) => l.startsWith("Git: commit incomplete")) ?? "";
    expect(line).toContain(realpathSync(dir));
    expect(line).toContain(realpathSync(join(dir, "docs")));
  });
});
