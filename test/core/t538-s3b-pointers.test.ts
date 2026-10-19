/**
 * T-538 S3b commit 5: a setup can owe a pointer block in CLAUDE.md and
 * AGENTS.md. The engine never writes either file. A block already there is
 * receipted applied; otherwise an intent receipt is committed, the proposal
 * is created beside the file, and the run stops for the owner (applied,
 * keep-current or stop). A proposal is adopted or removed only while it
 * holds the bytes its intent recorded; an applied block that later goes is
 * pointer drift, and a waived one is never checked.
 */
import { describe, it, expect, vi } from "vitest";
import { open, readdir, readFile, writeFile, type FileHandle } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadProject } from "../../src/core/project-loader.js";
import { setupApply, setupApplySeams, setupResolve, setupResume } from "../../src/core/setup-apply.js";
import { parseSetupPayload, validateSetupPayload, type SetupPayload } from "../../src/core/setup-payload.js";
import { SID, faultOnce, payload, pinEnvironment } from "./t538-s3a2-fixture.js";

vi.setConfig({ testTimeout: 30_000 });
const { folder } = pinEnvironment("t538-s3b-ptr");

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const CLAUDE = "## Storybloq\nRead CLAUDE.md's canonical facts first.\n";
const AGENTS = "## Storybloq\nThis project keeps its plan in .story/.\n";

function withPointers(pointers: Array<{ path: string; block: string }>): Record<string, unknown> {
  const p = payload();
  (p.governance as Record<string, unknown>).pointers = pointers;
  return p;
}

const proposal = (root: string, path: string) => join(root, `${path}.storybloq-${SID}.proposed`);
const resolve1 = (root: string, target: string, resolution: string) =>
  setupResolve(root, SID, [{ target, resolution, ownerWords: "the owner said so" }]);

async function progress(root: string, status: "active" | "archived"): Promise<SetupPayload> {
  const { state } = await loadProject(root);
  const note = state.notes.find((n) => n.status === status && (n as { setup?: { record?: string } }).setup?.record === "progress");
  return parseSetupPayload(note!.content);
}

const ambiguity = (klass: string, target: string) => expect.stringMatching(new RegExp(`^Ambiguity: ${klass} · ${target.replace(".", "\\.")} · `));

/** A project with these entry files, and a setup that owes CLAUDE.md's block, stopped at its pointer. */
async function stopped(files: Record<string, string> = { "CLAUDE.md": "# demo\n" }, pointers = [{ path: "CLAUDE.md", block: CLAUDE }]): Promise<string> {
  const root = await folder();
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  const r = await setupApply(root, withPointers(pointers));
  expect(r.exitCode).toBe(4);
  return root;
}

describe("the pointer payload", () => {
  const refusal = (pointers: unknown, files: unknown[] = []): string => {
    const p = payload();
    p.governance = { canonicalFactsPath: "RULES.md", files, pointers };
    try {
      validateSetupPayload(p);
      return "accepted";
    } catch (err) {
      return (err as Error).message;
    }
  };

  it("takes CLAUDE.md and AGENTS.md, one block each, non-empty and ending in a newline", () => {
    expect(refusal([{ path: "CLAUDE.md", block: CLAUDE }, { path: "AGENTS.md", block: AGENTS }])).toBe("accepted");
    expect(refusal([{ path: "README.md", block: CLAUDE }])).not.toBe("accepted");
    expect(refusal([{ path: "CLAUDE.md", block: CLAUDE }, { path: "CLAUDE.md", block: AGENTS }])).toMatch(/two pointers name CLAUDE\.md/);
    expect(refusal([{ path: "CLAUDE.md", block: "no newline" }])).toMatch(/the pointer block for CLAUDE\.md must be non-empty and end in a newline/);
    expect(refusal([{ path: "CLAUDE.md", block: "\n" }])).toMatch(/must be non-empty/);
    expect(refusal([{ path: "CLAUDE.md", block: CLAUDE }], [{ path: "CLAUDE.md", content: "# x\n" }])).toMatch(/CLAUDE\.md is both a governance file and a pointer target/);
  });

  it("a payload without pointers reads and serializes as before", () => {
    expect((validateSetupPayload(payload()).governance as Record<string, unknown>).pointers).toBeUndefined();
  });

  it("refuses a pointer at an entry file that does not exist, with nothing written", async () => {
    const root = await folder();
    const r = await setupApply(root, withPointers([{ path: "AGENTS.md", block: AGENTS }]));
    expect(r.exitCode).toBe(2);
    expect(r.lines.at(-1)).toBe("Setup stopped: the pointer target AGENTS.md does not exist; a pointer block goes into an entry file already there.");
    expect(existsSync(join(root, ".story"))).toBe(false);
  });
});

describe("a pointer step", () => {
  it("receipts a block already there as applied, and never writes the file", async () => {
    const root = await folder();
    const claude = `# demo\n\n${CLAUDE}more\n`;
    await writeFile(join(root, "CLAUDE.md"), claude);
    const r = await setupApply(root, withPointers([{ path: "CLAUDE.md", block: CLAUDE }]));
    expect(r.exitCode).toBe(0);
    expect(r.lines).toContain("-> file · CLAUDE.md carries setup's pointer block");
    expect(await readFile(join(root, "CLAUDE.md"), "utf-8")).toBe(claude);
    expect((await progress(root, "archived")).receipts).toContainEqual({ step: "pointer:CLAUDE.md", target: "file:CLAUDE.md", ownedPre: null, ownedPost: sha(CLAUDE), outcome: "applied" });
    expect(existsSync(proposal(root, "CLAUDE.md"))).toBe(false);
  });

  it("stops with the proposal beside the file and its intent receipted; applied is refused until the block is there; then resume receipts it and removes the proposal", async () => {
    const root = await stopped();
    expect(await readFile(join(root, "CLAUDE.md"), "utf-8")).toBe("# demo\n");
    const proposed = await readFile(proposal(root, "CLAUDE.md"), "utf-8");
    expect(proposed).toBe(`# demo\n\n${CLAUDE}`);
    expect((await progress(root, "active")).receipts).toContainEqual({ step: "pointer-proposal:CLAUDE.md", target: `file:CLAUDE.md.storybloq-${SID}.proposed`, ownedPre: sha("# demo\n"), ownedPost: sha(proposed) });

    const again = await setupResume(root, SID);
    expect(again.exitCode).toBe(4);
    expect(again.lines).toContainEqual(ambiguity("pointer edit owed", "CLAUDE.md"));
    expect(again.lines).toContain(`Ambiguity: pointer edit owed · CLAUDE.md · observed setup's pointer block is not in it; expected the block in CLAUDE.md.storybloq-${SID}.proposed · resolutions: applied | keep-current | stop`);
    expect((await resolve1(root, "CLAUDE.md", "applied")).lines.at(-1)).toBe("Setup refused: CLAUDE.md: applied, but it does not carry setup's pointer block yet.");

    await writeFile(join(root, "CLAUDE.md"), proposed);
    const done = await resolve1(root, "CLAUDE.md", "applied");
    expect(done.exitCode).toBe(0);
    expect(existsSync(proposal(root, "CLAUDE.md"))).toBe(false);
    const final = await progress(root, "archived");
    expect(final.receipts.filter((x) => x.step === "pointer:CLAUDE.md")).toEqual([{ step: "pointer:CLAUDE.md", target: "file:CLAUDE.md", ownedPre: null, ownedPost: sha(CLAUDE), outcome: "applied" }]);
    expect(final.amendments).toEqual([]);
  });

  it("(a) a replacement that keeps the block receipts; (b) one that drops it is refused at resume", async () => {
    const a = await stopped();
    await writeFile(join(a, "CLAUDE.md"), `rewritten by the owner\n${CLAUDE}and more\n`);
    expect((await setupResume(a, SID)).exitCode).toBe(0);

    const b = await stopped();
    await writeFile(join(b, "CLAUDE.md"), "rewritten without the block\n");
    const r = await setupResume(b, SID);
    expect(r.exitCode).toBe(4);
    expect(r.lines).toContainEqual(ambiguity("pointer edit owed", "CLAUDE.md"));
  });

  it("both files stop in turn; keep-current waives one, leaves it as it is, and removes setup's proposal", async () => {
    const root = await stopped({ "CLAUDE.md": "# demo\n", "AGENTS.md": "# agents\n" }, [{ path: "CLAUDE.md", block: CLAUDE }, { path: "AGENTS.md", block: AGENTS }]);
    await writeFile(join(root, "CLAUDE.md"), await readFile(proposal(root, "CLAUDE.md"), "utf-8"));
    const second = await setupResume(root, SID);
    expect(second.exitCode).toBe(4);
    expect(second.lines).toContainEqual(ambiguity("pointer edit owed", "AGENTS.md"));
    expect(await readFile(proposal(root, "AGENTS.md"), "utf-8")).toBe(`# agents\n\n${AGENTS}`);

    expect((await resolve1(root, "AGENTS.md", "keep-current")).exitCode).toBe(0);
    expect(await readFile(join(root, "AGENTS.md"), "utf-8")).toBe("# agents\n");
    expect(existsSync(proposal(root, "AGENTS.md"))).toBe(false);
    const final = await progress(root, "archived");
    expect(final.receipts).toContainEqual(expect.objectContaining({ step: "pointer:AGENTS.md", outcome: "waived" }));
    expect(final.amendments).toEqual([expect.objectContaining({ class: "pointer edit owed", target: "AGENTS.md", resolution: "keep-current", material: false })]);
  });
});

describe("pointer drift", () => {
  it("an applied block later removed is pointer drift, and keep-current waives it", async () => {
    const root = await folder();
    await writeFile(join(root, "CLAUDE.md"), `# demo\n\n${CLAUDE}`);
    faultOnce("step:pointer:CLAUDE.md");
    expect((await setupApply(root, withPointers([{ path: "CLAUDE.md", block: CLAUDE }]))).exitCode).toBe(3);
    await writeFile(join(root, "CLAUDE.md"), "# demo\n");
    const r = await setupResume(root, SID);
    expect(r.exitCode).toBe(4);
    expect(r.lines).toContain("Ambiguity: governance file drifted · CLAUDE.md · observed setup's pointer block is no longer in it; expected the pointer block the owner applied · resolutions: keep-current | stop");
    expect((await resolve1(root, "CLAUDE.md", "keep-current")).exitCode).toBe(0);
  });

  it("a waived pointer is never drift-checked: keep-current then resume does not reopen it", async () => {
    const root = await stopped({ "CLAUDE.md": "# demo\n", "AGENTS.md": `# agents\n${AGENTS}` }, [{ path: "CLAUDE.md", block: CLAUDE }, { path: "AGENTS.md", block: AGENTS }]);
    faultOnce("step:pointer:AGENTS.md");
    expect((await resolve1(root, "CLAUDE.md", "keep-current")).exitCode).toBe(3);
    await writeFile(join(root, "CLAUDE.md"), "# changed again\n");
    expect((await setupResume(root, SID)).exitCode).toBe(0);
  });
});

describe("proposal ownership", () => {
  it("a hand-edited proposal is a conflict, neither reused nor removed, even once the block is applied", async () => {
    const root = await stopped();
    await writeFile(proposal(root, "CLAUDE.md"), "mine\n");
    const r = await setupResume(root, SID);
    expect(r.exitCode).toBe(4);
    expect(r.lines).toContain(`Ambiguity: proposal conflict · CLAUDE.md · observed CLAUDE.md.storybloq-${SID}.proposed holds bytes setup did not write; expected setup's proposal or none; the file is left as it is · resolutions: keep-current | stop`);
    expect(await readFile(proposal(root, "CLAUDE.md"), "utf-8")).toBe("mine\n");

    await writeFile(join(root, "CLAUDE.md"), `# demo\n\n${CLAUDE}`);
    const done = await setupResume(root, SID);
    expect(done.exitCode).toBe(0);
    expect(done.lines).toContain(`-> file · CLAUDE.md.storybloq-${SID}.proposed is not setup's proposal; left as it is`);
    expect(await readFile(proposal(root, "CLAUDE.md"), "utf-8")).toBe("mine\n");
  });

  it("a file already at the proposal path is a conflict, never adopted", async () => {
    const root = await folder();
    await writeFile(join(root, "CLAUDE.md"), "# demo\n");
    await writeFile(proposal(root, "CLAUDE.md"), "someone else's\n");
    const r = await setupApply(root, withPointers([{ path: "CLAUDE.md", block: CLAUDE }]));
    expect(r.exitCode).toBe(4);
    expect(r.lines).toContainEqual(ambiguity("proposal conflict", "CLAUDE.md"));
    expect(await readFile(proposal(root, "CLAUDE.md"), "utf-8")).toBe("someone else's\n");
  });

  it("a crash after the intent and before the proposal: resume creates it from the intent", async () => {
    const root = await folder();
    await writeFile(join(root, "CLAUDE.md"), "# demo\n");
    faultOnce("pointer-intent:CLAUDE.md");
    expect((await setupApply(root, withPointers([{ path: "CLAUDE.md", block: CLAUDE }]))).exitCode).toBe(3);
    expect(existsSync(proposal(root, "CLAUDE.md"))).toBe(false);
    const r = await setupResume(root, SID);
    expect(r.exitCode).toBe(4);
    expect(r.lines).toContainEqual(ambiguity("pointer edit owed", "CLAUDE.md"));
    expect(await readFile(proposal(root, "CLAUDE.md"), "utf-8")).toBe(`# demo\n\n${CLAUDE}`);
  });

  it("a crash after the intent, with the entry file changed since: nothing is created, and the stop says why", async () => {
    const root = await folder();
    await writeFile(join(root, "CLAUDE.md"), "# demo\n");
    faultOnce("pointer-intent:CLAUDE.md");
    await setupApply(root, withPointers([{ path: "CLAUDE.md", block: CLAUDE }]));
    await writeFile(join(root, "CLAUDE.md"), "# edited\n");
    const r = await setupResume(root, SID);
    expect(r.exitCode).toBe(4);
    expect(r.lines).toContainEqual(expect.stringContaining("expected setup's pointer block (CLAUDE.md changed since its proposal was recorded)"));
    expect(existsSync(proposal(root, "CLAUDE.md"))).toBe(false);
  });

  it("a crash after the proposal is created: resume adopts the same bytes", async () => {
    const root = await folder();
    await writeFile(join(root, "CLAUDE.md"), "# demo\n");
    faultOnce("pointer-proposed:CLAUDE.md");
    expect((await setupApply(root, withPointers([{ path: "CLAUDE.md", block: CLAUDE }]))).exitCode).toBe(3);
    const before = await readFile(proposal(root, "CLAUDE.md"), "utf-8");
    const r = await setupResume(root, SID);
    expect(r.exitCode).toBe(4);
    expect(r.lines).toContainEqual(ambiguity("pointer edit owed", "CLAUDE.md"));
    expect(await readFile(proposal(root, "CLAUDE.md"), "utf-8")).toBe(before);
    expect((await progress(root, "active")).receipts.filter((x) => x.step === "pointer-proposal:CLAUDE.md")).toHaveLength(1);
  });

  it("a proposal replaced after its check is never deleted: the captured bytes are checked and put back", async () => {
    const root = await stopped();
    await writeFile(join(root, "CLAUDE.md"), await readFile(proposal(root, "CLAUDE.md"), "utf-8"));
    setupApplySeams.fault = async (point) => {
      if (point === "pointer-tidy:CLAUDE.md") await writeFile(proposal(root, "CLAUDE.md"), "the owner's own notes\n");
    };
    const done = await resolve1(root, "CLAUDE.md", "applied");
    expect(done.exitCode).toBe(0);
    expect(done.lines).toContain(`-> file · CLAUDE.md.storybloq-${SID}.proposed is not setup's proposal; left as it is`);
    expect(await readFile(proposal(root, "CLAUDE.md"), "utf-8")).toBe("the owner's own notes\n");
    expect((await readdir(root)).filter((f) => f.includes(".cleanup-"))).toEqual([]);
  });

  it("when something takes the proposal's place after the capture, the captured bytes are kept at the cleanup path and the newcomer is untouched", async () => {
    const root = await stopped();
    await writeFile(join(root, "CLAUDE.md"), await readFile(proposal(root, "CLAUDE.md"), "utf-8"));
    setupApplySeams.fault = async (point) => {
      if (point === "pointer-tidy:CLAUDE.md") await writeFile(proposal(root, "CLAUDE.md"), "the owner's own notes\n");
      if (point === "pointer-tidy-captured:CLAUDE.md") await writeFile(proposal(root, "CLAUDE.md"), "newer still\n");
    };
    const done = await resolve1(root, "CLAUDE.md", "applied");
    expect(done.exitCode).toBe(0);
    expect(await readFile(proposal(root, "CLAUDE.md"), "utf-8")).toBe("newer still\n");
    const kept = (await readdir(root)).filter((f) => f.startsWith(`CLAUDE.md.storybloq-${SID}.proposed.cleanup-`));
    expect(kept).toHaveLength(1);
    expect(await readFile(join(root, kept[0]!), "utf-8")).toBe("the owner's own notes\n");
    expect(done.lines).toContain(`-> file · CLAUDE.md.storybloq-${SID}.proposed changed while setup removed it; the bytes it held are kept at ${kept[0]}`);
  });

  it("a write through a descriptor opened before the cleanup is read back after the unlink, kept and reported, never deleted", async () => {
    const root = await stopped();
    await writeFile(join(root, "CLAUDE.md"), await readFile(proposal(root, "CLAUDE.md"), "utf-8"));
    let fd: FileHandle | null = null;
    setupApplySeams.fault = async (point) => {
      if (point === "pointer-tidy:CLAUDE.md") fd = await open(proposal(root, "CLAUDE.md"), "r+");
      if (point === "pointer-tidy-held:CLAUDE.md") {
        await fd!.truncate(0);
        await fd!.write("the owner's late edit\n", 0);
      }
    };
    const done = await resolve1(root, "CLAUDE.md", "applied");
    await (fd as FileHandle | null)?.close();
    expect(done.exitCode).toBe(0);
    expect(done.lines).toContain(`-> file · CLAUDE.md.storybloq-${SID}.proposed is not setup's proposal; left as it is`);
    expect(await readFile(proposal(root, "CLAUDE.md"), "utf-8")).toBe("the owner's late edit\n");
    expect((await readdir(root)).filter((f) => f.includes(".cleanup-"))).toEqual([]);
  });

  for (const [when, point] of [["after the read and before the unlink", "pointer-tidy-read:CLAUDE.md"], ["in the restore", "pointer-tidy-restore:CLAUDE.md"]] as const) {
    it(`an error ${when} keeps the cleanup path, names it, and loses no byte`, async () => {
      const root = await stopped();
      await writeFile(join(root, "CLAUDE.md"), await readFile(proposal(root, "CLAUDE.md"), "utf-8"));
      setupApplySeams.fault = async (at) => {
        if (at === "pointer-tidy:CLAUDE.md") await writeFile(proposal(root, "CLAUDE.md"), "the owner's own notes\n");
        if (at === point) throw new Error(`injected fault at ${at}`);
      };
      const done = await resolve1(root, "CLAUDE.md", "applied");
      expect(done.exitCode).toBe(0);
      const kept = (await readdir(root)).filter((f) => f.startsWith(`CLAUDE.md.storybloq-${SID}.proposed.cleanup-`));
      expect(kept).toHaveLength(1);
      expect(await readFile(join(root, kept[0]!), "utf-8")).toBe("the owner's own notes\n");
      expect(done.lines).toContain(`-> file · CLAUDE.md.storybloq-${SID}.proposed could not be removed safely; its bytes are kept at ${kept[0]}`);
    });
  }

  it("a crash between the receipt and the removal replays cleanly: the receipt holds and the proposal goes", async () => {
    const root = await stopped();
    await writeFile(join(root, "CLAUDE.md"), await readFile(proposal(root, "CLAUDE.md"), "utf-8"));
    faultOnce("pointer-receipted:CLAUDE.md");
    expect((await setupResume(root, SID)).exitCode).toBe(3);
    expect(existsSync(proposal(root, "CLAUDE.md"))).toBe(true);
    expect((await progress(root, "active")).receipts).toContainEqual(expect.objectContaining({ step: "pointer:CLAUDE.md", outcome: "applied" }));
    expect((await setupResume(root, SID)).exitCode).toBe(0);
    expect(existsSync(proposal(root, "CLAUDE.md"))).toBe(false);
    expect((await progress(root, "archived")).receipts.filter((x) => x.step === "pointer:CLAUDE.md")).toHaveLength(1);
  });
});
