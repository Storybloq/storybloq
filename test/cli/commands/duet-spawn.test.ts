import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { handleDuetSpawn, reconcileSpawnJournal, type DuetSpawnDeps } from "../../../src/cli/commands/duet-spawn.js";
import { handleTicketCreate } from "../../../src/cli/commands/ticket.js";
import { initProject } from "../../../src/core/init.js";
import { loadArrangementsSafe } from "../../../src/core/arrangement-loader.js";
import { coordinateDuet, readDuetCoordination } from "../../../src/core/duet-coordination.js";
import { readSpawnJournal, writeSpawnJournal, type Launcher } from "../../../src/core/duet-spawn.js";
import { CliValidationError } from "../../../src/cli/helpers.js";
import { COMMANDS } from "../../../src/cli/commands/reference.js";

const PEN = "11111111-2222-4333-8444-555555555555";
const dirs: string[] = [];
// Byte-review F9: the handler's `client` dep does not reach coordinateDuet,
// which resolves the actor's client from STORYBLOQ_CLIENT; pin the environment
// so a codex-flavoured shell cannot turn every automatic case red.
beforeEach(() => {
  vi.stubEnv("STORYBLOQ_CLIENT", "claude");
  vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
  vi.stubEnv("CODEX_THREAD_ID", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

async function newProject(name = "pen"): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `duet-spawn-cli-${name}-`));
  dirs.push(dir);
  await initProject(dir, { name });
  await handleTicketCreate({ title: "Bound ticket", type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null }, "md", dir);
  return dir;
}

const quiet: Launcher = () => "fake-open";
const noPen = () => null;
function deps(over: Partial<DuetSpawnDeps> = {}): DuetSpawnDeps {
  return { launcher: quiet, detect: noPen, client: "claude", ...over };
}
function arrangements(dir: string) {
  return loadArrangementsSafe(dir).arrangements;
}
function journals(dir: string): string[] {
  const root = join(dir, ".story", "spawn");
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((d) => !d.startsWith(".")).flatMap((d) => readdirSync(join(root, d)).filter((f) => f.endsWith(".json")).map((f) => join(root, d, f)));
}
function role(out: string): string {
  const path = /Role: (.+)/.exec(out)?.[1];
  if (!path) throw new Error("no role path in output");
  return readFileSync(path, "utf-8");
}
function jsonData(out: string): Record<string, any> {
  return JSON.parse(out).data;
}

describe("T-530: storybloq duet spawn creates the arrangement, starts coordination and hands the worker its handshake", () => {
  it("auto mode with bounds and a pen task id: arrangement anchored to both ids, coordination started, role carries the nonce, output carries the prefilled receipt", async () => {
    const dir = await newProject();
    const res = await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN }, "json", dir, deps());
    expect(res.exitCode).toBe(0);
    const data = jsonData(res.output);
    expect(data.launch).toBe("opened");
    expect(data.arrangement.mode).toBe("auto");
    const [a] = arrangements(dir);
    expect(arrangements(dir)).toHaveLength(1);
    expect(a!.id).toBe(data.arrangement.id);
    expect(a!.parties).toEqual([
      { role: "pen", client: "claude", identityAnchor: PEN },
      // ISS-1303: the party records the model the worker actually runs, the default included.
      { role: "worker", client: "claude", identityAnchor: data.workerTaskId, modelTier: "opus" },
    ]);
    expect(a!.bounds).toEqual(["T-001"]);
    expect(a!.unreachability.onIrreversibleWork).toBe("hold");
    const view = readDuetCoordination(dir, a!);
    expect(view.state?.revision).toBe(1);
    expect(view.state?.start.mode).toBe("native-return");
    expect(view.route.status).toBe("missing");
    expect(a!.currentCoordinationSessionId).toBe(data.arrangement.coordinationSessionId);
    const text = readFileSync(data.rolePath, "utf-8");
    expect(text).toContain(view.state!.nonce);
    expect(data.handshake.nonce).toBe(view.state!.nonce);
    expect(text).toContain(`nonce ${view.state!.nonce}, worker w ${data.workerTaskId.slice(0, 8)}, sender`);
    // the journal reached launched and never carried the nonce
    const journal = readSpawnJournal(data.journalPath);
    expect(journal).toMatchObject({ stage: "launched", workerTaskId: data.workerTaskId, penTaskId: PEN, arrangementId: a!.id, proposedCoordinationSessionId: a!.currentCoordinationSessionId });
    expect(readFileSync(data.journalPath, "utf-8")).not.toContain(view.state!.nonce);
    // md output carries the pen's next step with the nonce, both ids and the receipt shape
    const md = await handleDuetSpawn({ name: "w2", pen: "p", bounds: ["T-001"], penTaskId: PEN }, "md", dir, deps());
    expect(md.output).toContain('Opened worker "w2"');
    expect(md.output).toMatch(/Worker task id: [0-9a-f-]{36}/);
    expect(md.output).toContain("Arrangement: a-");
    expect(md.output).toContain("nonce issued");
    expect(md.output).toContain("When the nonce echo arrives from w2, record the receipt:");
    expect(md.output).toContain("storybloq arrangement coordinate a-");
    expect(md.output).toContain('"direction":"worker-to-manager"');
    expect(md.output).toContain('"observedAt":"<fill at observation>"');
    expect(md.output).toContain('"senderTool":"<from the echo line>"');
    expect(md.output).toContain(`"id":"${PEN}"`);
    expect(md.output).not.toContain("type /story in it");
    expect(md.output).toContain("Permission mode: auto (product default");
    expect(arrangements(dir)).toHaveLength(2);
  });

  it("coordination integration (not a transport proof): the route is unverified until a receipt with the role's nonce from the worker anchor; wrong nonce and worker-authored writes are refused", async () => {
    const dir = await newProject();
    const data = jsonData((await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN }, "json", dir, deps())).output);
    const a = arrangements(dir)[0]!;
    const sid = a.currentCoordinationSessionId!;
    const nonce = data.handshake.nonce as string;
    expect(readDuetCoordination(dir, a).route.status).not.toBe("current");
    const receipt = (n: string) => ({ id: "rcpt-w-1", nonce: n, direction: "worker-to-manager" as const, source: { client: "claude" as const, id: data.workerTaskId as string }, destination: { client: "claude" as const, id: PEN }, mode: "native-return" as const, senderTool: "SendMessage", collectionTool: null, observedAt: new Date().toISOString() });
    await expect(coordinateDuet(dir, { action: "receipt", id: a.id, expectedRevision: 1, expectedSessionId: sid, clientTaskId: PEN, receipt: receipt(randomUUID()) })).rejects.toThrow(/does not match/);
    await expect(coordinateDuet(dir, { action: "receipt", id: a.id, expectedRevision: 1, expectedSessionId: sid, clientTaskId: data.workerTaskId, receipt: receipt(nonce) })).rejects.toThrow(/Only the arrangement pen/);
    const view = await coordinateDuet(dir, { action: "receipt", id: a.id, expectedRevision: 1, expectedSessionId: sid, clientTaskId: PEN, receipt: receipt(nonce) });
    expect(view.route.status).toBe("current");
  });

  it("omitted mode with a Claude pen and no bounds REFUSES before any mutation (owner ruling: never a silent manual fallback)", async () => {
    const dir = await newProject();
    let opened = 0;
    await expect(handleDuetSpawn({ name: "w", pen: "p", penTaskId: PEN }, "md", dir, deps({ launcher: () => { opened++; return "x"; } }))).rejects.toThrow(/--bounds is required for the automatic handshake/);
    await expect(handleDuetSpawn({ name: "w", pen: "p", penTaskId: PEN, arrangement: "auto" }, "md", dir, deps())).rejects.toThrow(/--bounds is required/);
    expect(opened).toBe(0);
    expect(arrangements(dir)).toEqual([]);
    expect(journals(dir)).toEqual([]);
  });

  it("explicit none launches with the manual handshake role and creates nothing", async () => {
    const dir = await newProject();
    const res = await handleDuetSpawn({ name: "w", pen: "p", arrangement: "none", penTaskId: PEN }, "md", dir, deps());
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain("Arrangement: none (");
    expect(res.output).toContain("handshake by name from the pen (p)");
    expect(role(res.output)).toContain("wait for the pen's handshake");
    expect(arrangements(dir)).toEqual([]);
    expect(readSpawnJournal(/Journal: (.+)/.exec(res.output)![1]!)).toMatchObject({ stage: "launched", arrangementId: null });
  });

  it("no pen task id degrades an omitted mode to none with the reason and refuses an explicit auto with the same reason", async () => {
    const dir = await newProject();
    const res = await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"] }, "md", dir, deps());
    expect(res.output).toContain("Arrangement: none (no pen task id");
    expect(res.output).toContain("--pen-task-id");
    expect(arrangements(dir)).toEqual([]);
    await expect(handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], arrangement: "auto" }, "md", dir, deps())).rejects.toThrow(/no pen task id/);
    expect(arrangements(dir)).toEqual([]);
  });

  it("a codex pen degrades an omitted mode to none with the transport reason and refuses an explicit auto", async () => {
    const dir = await newProject();
    const res = await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN }, "md", dir, deps({ client: "codex" }));
    expect(res.output).toContain("Arrangement: none (automatic handshake needs a Claude pen");
    expect(arrangements(dir)).toEqual([]);
    await expect(handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN, arrangement: "auto" }, "md", dir, deps({ client: "codex" }))).rejects.toThrow(/needs a Claude pen/);
    expect(arrangements(dir)).toEqual([]);
  });

  it("every deterministic refusal happens before any ledger write or journal", async () => {
    const dir = await newProject();
    const other = mkdtempSync(join(tmpdir(), "duet-spawn-bare-"));
    dirs.push(other);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ name: "bad name" }, /Invalid worker name/],
      [{ name: "p" }, /must differ/],
      [{ permissionMode: "yolo" }, /Unknown permission mode/],
      [{ role: "missing.md" }, /ENOENT|no such file/i],
      [{ dir: join(dir, "nope") }, /does not exist/],
      [{ bounds: ["T-999"] }, /T-999/],
    ];
    for (const [over, re] of cases) {
      await expect(handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN, ...over } as any, "md", dir, deps())).rejects.toThrow(re);
    }
    expect(arrangements(dir)).toEqual([]);
    expect(journals(dir)).toEqual([]);
    // a directory with no ledger is fine for a manual handshake too (ISS-1305)
    const res = await handleDuetSpawn({ name: "w", pen: "p", dir: other, arrangement: "none", penTaskId: PEN }, "md", dir, deps());
    expect(res.exitCode).toBe(0);
    expect(role(res.output)).toContain("which carries no ledger");
  });

  it("--print mutates nothing and writes nothing: it shows the command and the role it would write", async () => {
    const dir = await newProject();
    const res = await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN, print: true }, "md", dir, deps({ launcher: () => { throw new Error("must not launch"); } }));
    expect(res.exitCode).toBe(0);
    // a launch with its own ledger clears any inherited project-root variable (ISS-1305)
    expect(res.output).toContain("&& env -u STORYBLOQ_PROJECT_ROOT -u CLAUDESTORY_PROJECT_ROOT claude -n 'w' --session-id '<minted at launch>'");
    expect(res.output).toContain("'/story'");
    expect(res.output).toContain("no arrangement created, no files written");
    expect(res.output).toContain("Bounds: T-001");
    expect(res.output).toContain("<nonce issued at launch>");
    expect(arrangements(dir)).toEqual([]);
    expect(existsSync(join(dir, ".story", "spawn"))).toBe(false);
    const json = jsonData((await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN, print: true }, "json", dir, deps())).output);
    expect(json.launch).toBe("printed");
    expect(json.arrangement).toEqual({ mode: "auto", status: "skipped (--print)", bounds: ["T-001"] });
    expect(existsSync(join(dir, ".story", "spawn"))).toBe(false);
    // --print with a custom role previews the real text: the custom contents, the ledger paragraph and the handshake section (byte-review F3)
    writeFileSync(join(dir, "custom.md"), "MY CUSTOM ROLE\n");
    const custom = await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN, print: true, role: "custom.md" }, "md", dir, deps());
    expect(custom.output).toContain("MY CUSTOM ROLE");
    expect(custom.output).toContain("## Ledger");
    expect(custom.output).toContain("## Handshake");
    expect(custom.output).toContain("<nonce issued at launch>");
    const customNone = await handleDuetSpawn({ name: "w", pen: "p", penTaskId: PEN, print: true, role: "custom.md", arrangement: "none" }, "md", dir, deps());
    expect(customNone.output).toContain("MY CUSTOM ROLE");
    expect(customNone.output).not.toContain("## Handshake");
    expect(existsSync(join(dir, ".story", "spawn"))).toBe(false);
  });

  it("--no-auto-load with an automatic arrangement tells the pen to type /story first (byte-review F4)", async () => {
    const dir = await newProject();
    const res = await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN, autoLoad: false }, "md", dir, deps());
    expect(res.output).toContain("--no-auto-load: type /story in the worker window first");
    expect(res.output).not.toContain("loads /story on its own");
    expect(res.output).toContain("record the receipt:");
    expect(res.output).not.toContain("'/story'");
  });

  describe("journal and interruption windows", () => {
    function failingJournalAt(stage: string) {
      return (path: string, entry: Record<string, unknown>) => {
        if (entry.stage === stage) throw new Error(`journal write failed at ${stage}`);
        writeSpawnJournal(path, entry);
      };
    }

    it("(i) journal fails right after the arrangement commit: reconciliation finds it by worker anchor and offers the close command", async () => {
      const dir = await newProject();
      const err = await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN }, "md", dir, deps({ journal: failingJournalAt("created") })).catch((e) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("coordination not started");
      expect(err.message).toContain("worker");
      expect(err.message).toContain("not launched");
      expect(err.message).toMatch(/storybloq arrangement update a-\S+ --lifecycle closed/);
      expect(err.message).not.toContain("UNKNOWN");
      expect(arrangements(dir)).toHaveLength(1);
      expect(readSpawnJournal(journals(dir)[0]!)).toMatchObject({ stage: "intent" });
    });

    it("(ii) journal fails right after the coordination commit: reconciliation sees the proposed session live and says started, not launched", async () => {
      const dir = await newProject();
      const err = await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN }, "md", dir, deps({ journal: failingJournalAt("started") })).catch((e) => e as Error);
      expect(err.message).toMatch(/coordination [0-9a-f-]{36} started/);
      expect(err.message).toContain("not launched");
      expect(err.message).toContain("--lifecycle closed");
      expect(err.message).not.toContain("UNKNOWN");
      expect(readSpawnJournal(journals(dir)[0]!)).toMatchObject({ stage: "start-attempted" });
      expect(arrangements(dir)[0]!.currentCoordinationSessionId).toBeDefined();
    });

    it("(iii) journal fails after the launcher accepted: launch outcome UNKNOWN, no close offered", async () => {
      const dir = await newProject();
      const err = await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN }, "md", dir, deps({ journal: failingJournalAt("launched") })).catch((e) => e as Error);
      expect(err.message).toContain("launch outcome UNKNOWN");
      expect(err.message).toContain("storybloq roster list");
      expect(err.message).toContain("nonce echo");
      expect(err.message).not.toContain("never launched");
      expect(err.message).not.toContain("--lifecycle closed");
      expect(readSpawnJournal(journals(dir)[0]!)).toMatchObject({ stage: "launch-attempted" });
    });

    it("(iv) coordinate start throws: created, not started, close offered", async () => {
      const dir = await newProject();
      const err = await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN }, "md", dir, deps({ coordinate: async () => { throw new Error("start exploded"); } })).catch((e) => e as Error);
      expect(err.message).toContain("start exploded");
      expect(err.message).toContain("coordination not started");
      expect(err.message).toContain("--lifecycle closed");
      expect(readSpawnJournal(journals(dir)[0]!)).toMatchObject({ stage: "start-attempted" });
    });

    it("(v) artifacts cannot be written after start: started, not launched", async () => {
      const dir = await newProject();
      let spawnDir: string | null = null;
      const journal = (path: string, entry: Record<string, unknown>) => {
        writeSpawnJournal(path, entry);
        spawnDir = join(path, "..");
        if (entry.stage === "started") chmodSync(spawnDir, 0o500);
      };
      const err = await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN }, "md", dir, deps({ journal })).catch((e) => e as Error);
      chmodSync(spawnDir!, 0o700);
      expect(err.message).toMatch(/coordination [0-9a-f-]{36} started/);
      expect(err.message).toContain("not launched");
      expect(err.message).not.toContain("UNKNOWN");
    });

    it("(vi) launcher throws after accepting the script: UNKNOWN, and the script was handed over first", async () => {
      const dir = await newProject();
      let handed: string | null = null;
      const err = await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN }, "md", dir, deps({ launcher: (s) => { handed = s; throw new Error("open timed out"); } })).catch((e) => e as Error);
      expect(handed).not.toBeNull();
      expect(existsSync(handed!)).toBe(true);
      expect(err.message).toContain("open timed out");
      expect(err.message).toContain("launch outcome UNKNOWN");
      expect(err.message).not.toContain("--lifecycle closed");
      expect(readSpawnJournal(journals(dir)[0]!)).toMatchObject({ stage: "launch-attempted" });
    });

    it("(vii) success: final stage launched, no nonce in the journal, every write went through the atomic path", async () => {
      const dir = await newProject();
      const seen: string[] = [];
      const journal = (path: string, entry: Record<string, unknown>) => {
        seen.push(entry.stage as string);
        writeSpawnJournal(path, entry);
      };
      const data = jsonData((await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN }, "json", dir, deps({ journal }))).output);
      expect(seen).toEqual(["intent", "created", "start-attempted", "started", "artifacts", "launch-attempted", "launched"]);
      expect(readSpawnJournal(data.journalPath)).toMatchObject({ stage: "launched" });
      expect(readFileSync(data.journalPath, "utf-8")).not.toContain(data.handshake.nonce);
      expect(readdirSync(join(data.journalPath, "..")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    });
  });

  describe("--recover lists candidates read-only with both axes and never calls one an orphan", () => {
    async function spawnWith(dir: string, over: Partial<DuetSpawnDeps>, name = "w") {
      return handleDuetSpawn({ name, pen: "p", bounds: ["T-001"], penTaskId: PEN }, "json", dir, deps(over)).then((r) => jsonData(r.output)).catch((e) => e as Error);
    }
    const failAt = (stage: string) => (path: string, entry: Record<string, unknown>) => {
      if (entry.stage === stage) throw new Error(`stop at ${stage}`);
      writeSpawnJournal(path, entry);
    };

    it("covers intent-only, created, start-attempted, launch-attempted and launched (with and without a receipt)", async () => {
      const dir = await newProject();
      await spawnWith(dir, { journal: failAt("created") }, "w-intent");
      await spawnWith(dir, { coordinate: async () => { throw new Error("x"); } }, "w-created");
      await spawnWith(dir, { journal: failAt("started") }, "w-startatt");
      await spawnWith(dir, { journal: failAt("launched") }, "w-launchatt");
      const done = (await spawnWith(dir, {}, "w-done")) as Record<string, any>;
      const receipted = (await spawnWith(dir, {}, "w-receipted")) as Record<string, any>;
      const ra = arrangements(dir).find((a) => a.id === receipted.arrangement.id)!;
      await coordinateDuet(dir, { action: "receipt", id: ra.id, expectedRevision: 1, expectedSessionId: ra.currentCoordinationSessionId!, clientTaskId: PEN, receipt: { id: "r1", nonce: receipted.handshake.nonce, direction: "worker-to-manager", source: { client: "claude", id: receipted.workerTaskId }, destination: { client: "claude", id: PEN }, mode: "native-return", senderTool: "SendMessage", collectionTool: null, observedAt: new Date().toISOString() } });
      const res = await handleDuetSpawn({ recover: true }, "md", dir, deps());
      expect(res.exitCode).toBe(0);
      const out = res.output;
      expect(out).not.toMatch(/orphan/i);
      const line = (name: string) => out.split("\n").find((l) => l.includes(`w-${name}`)) ?? "";
      // intent only: the arrangement was created (journal failed after the commit) so reconciliation still finds it
      expect(line("intent")).toContain("not launched");
      expect(line("intent")).toContain("coordination not started");
      expect(line("intent")).toContain("--lifecycle closed");
      expect(line("created")).toContain("coordination not started");
      expect(line("created")).toContain("--lifecycle closed");
      expect(line("startatt")).toContain("started, no receipt yet");
      expect(line("startatt")).toContain("--lifecycle closed");
      expect(line("launchatt")).toContain("UNKNOWN");
      expect(line("launchatt")).not.toContain("--lifecycle closed");
      expect(line("done")).toContain("launched; await the echo");
      expect(line("done")).not.toContain("--lifecycle closed");
      expect(line("receipted")).toContain("receipt recorded");
      expect(line("receipted")).not.toContain("--lifecycle closed");
      // ISS-1294: a receipted launch has no echo left to await.
      expect(line("receipted")).toContain("launched; handshake complete");
      expect(line("receipted")).not.toContain("await the echo");
      // structured view of one candidate
      const j = readSpawnJournal(journals(dir).find((p) => p.includes("w-launchatt"))!)!;
      const rec = reconcileSpawnJournal(dir, j);
      expect(rec).toMatchObject({ launch: "unknown", coordination: "started-no-receipt", cleanup: false, arrangementId: expect.stringMatching(/^a-/) });
      expect(reconcileSpawnJournal(dir, readSpawnJournal(journals(dir).find((p) => p.includes("w-created"))!)!)).toMatchObject({ launch: "not-launched", coordination: "not-started", cleanup: true });
      expect(reconcileSpawnJournal(dir, readSpawnJournal(journals(dir).find((p) => p.includes("w-receipted"))!)!)).toMatchObject({ launch: "launched", coordination: "receipt", cleanup: false });
      // json listing
      const json = JSON.parse((await handleDuetSpawn({ recover: true }, "json", dir, deps())).output);
      expect(json.data.candidates).toHaveLength(6);
      expect(json.data.candidates.every((c: any) => typeof c.recommendation === "string")).toBe(true);
    });

    it("a rotated arrangement reads SUPERSEDED, a closed one has nothing to close, a garbage runtime is UNRESOLVED, and a journal with no arrangement has nothing to clean up", async () => {
      const dir = await newProject();
      const rotated = (await spawnWith(dir, { journal: failAt("started") }, "w-rot")) as Error;
      expect(rotated).toBeInstanceOf(Error);
      const ra = arrangements(dir)[0]!;
      await coordinateDuet(dir, { action: "start", id: ra.id, expectedRevision: 1, expectedSessionId: ra.currentCoordinationSessionId!, newSessionId: randomUUID(), mode: "native-return", clientTaskId: PEN });
      await spawnWith(dir, {}, "w-closed");
      const ca = arrangements(dir).find((a) => a.id !== ra.id)!;
      const caPath = join(dir, ".story", "arrangements", `${ca.id}.json`);
      writeFileSync(caPath, JSON.stringify({ ...JSON.parse(readFileSync(caPath, "utf-8")), lifecycle: "closed" }, null, 2));
      await spawnWith(dir, {}, "w-garbage");
      const ga = arrangements(dir).find((a) => a.id !== ra.id && a.id !== ca.id)!;
      writeFileSync(join(dir, ".story", "duet-sessions", ga.id, "state.json"), "{garbage");
      await spawnWith(dir, { createArrangement: async () => { throw new Error("no create"); } }, "w-none");
      const out = (await handleDuetSpawn({ recover: true }, "md", dir, deps())).output;
      const line = (name: string) => out.split("\n").find((l) => l.includes(`w-${name}`)) ?? "";
      expect(line("rot")).toContain("SUPERSEDED");
      expect(line("rot")).not.toContain("--lifecycle closed");
      expect(line("none")).toContain("nothing to clean up");
      expect(line("garbage")).toContain("UNRESOLVED");
      expect(line("garbage")).not.toContain("--lifecycle closed");
      expect(line("closed")).toContain("nothing to close");
      expect(line("closed")).not.toContain("--lifecycle closed");
      // ISS-1294: a launched worker on a closed arrangement awaits nothing; the journal is history.
      expect(line("closed")).not.toContain("await the echo");
      expect(line("closed")).toContain("this journal is historical and can be deleted");
      // A launched worker holds the nonce, so a runtime corrupted before any receipt is uncertain, not settled.
      expect(line("garbage")).toContain("launched; handshake status unknown, an echo may still arrive");
      expect(out).not.toMatch(/orphan/i);
    });

    it("ISS-1294: a launched worker awaits the echo only while its handshake is open, and is never cleanup-eligible", async () => {
      const dir = await newProject();
      const done = (await spawnWith(dir, {}, "w-open")) as Record<string, any>;
      const open = readSpawnJournal(done.journalPath)!;
      const opened = reconcileSpawnJournal(dir, open);
      expect(opened).toMatchObject({ launch: "launched", coordination: "started-no-receipt", cleanup: false });
      expect(opened.recommendation).toContain("launched; await the echo");

      // A replacement session with no receipt: this journal's challenge is obsolete, the replacement unverified.
      const rep = (await spawnWith(dir, {}, "w-replaced")) as Record<string, any>;
      const ra = arrangements(dir).find((a) => a.id === rep.arrangement.id)!;
      await coordinateDuet(dir, { action: "start", id: ra.id, expectedRevision: 1, expectedSessionId: ra.currentCoordinationSessionId!, newSessionId: randomUUID(), mode: "native-return", clientTaskId: PEN });
      const replaced = reconcileSpawnJournal(dir, readSpawnJournal(rep.journalPath)!);
      expect(replaced).toMatchObject({ launch: "launched", coordination: "superseded", cleanup: false });
      expect(replaced.recommendation).toContain("launched; the spawn challenge is superseded");
      expect(replaced.recommendation).toContain("SUPERSEDED");
      expect(replaced.recommendation).not.toContain("handshake complete");

      // The runtime corrupted after the launch, before any receipt.
      const cor = (await spawnWith(dir, {}, "w-corrupt")) as Record<string, any>;
      writeFileSync(join(dir, ".story", "duet-sessions", cor.arrangement.id, "state.json"), "{garbage");
      const corrupt = reconcileSpawnJournal(dir, readSpawnJournal(cor.journalPath)!);
      expect(corrupt).toMatchObject({ launch: "launched", coordination: "unresolved", cleanup: false });
      expect(corrupt.recommendation).toContain("launched; handshake status unknown, an echo may still arrive");

      // No arrangement requested, and none bearing the worker id: nothing echoes to this journal.
      const none = reconcileSpawnJournal(dir, { ...open, arrangementMode: "manual" });
      const stray = reconcileSpawnJournal(dir, { ...open, workerTaskId: "00000000-0000-4000-8000-000000000000" });
      expect(none).toMatchObject({ launch: "launched", coordination: "none-requested", cleanup: false });
      expect(stray).toMatchObject({ launch: "launched", coordination: "no-arrangement", cleanup: false });

      for (const rec of [replaced, corrupt, none, stray]) {
        expect(rec.recommendation).not.toContain("await the echo");
      }
      for (const rec of [opened, replaced, corrupt, none, stray]) {
        expect(rec.recommendation).not.toContain("--lifecycle closed");
      }
    });

    it("a journal with a missing, null or unrecognised stage reads UNKNOWN and never offers cleanup, even with a live worker identity (byte-review F2)", async () => {
      const dir = await newProject();
      const data = (await spawnWith(dir, {}, "w-live")) as Record<string, any>;
      const good = readSpawnJournal(data.journalPath)!;
      for (const stage of [undefined, null, "launchd", 42, "created "]) {
        const rec = reconcileSpawnJournal(dir, { ...good, stage });
        expect(rec.launch, String(stage)).toBe("unknown");
        expect(rec.cleanup, String(stage)).toBe(false);
        expect(rec.recommendation).toContain("UNKNOWN");
        expect(rec.recommendation).not.toContain("--lifecycle closed");
      }
      expect(reconcileSpawnJournal(dir, { ...good, stage: "created" })).toMatchObject({ launch: "not-launched" });
    });

    it("no OS launcher: the journal says launch-manual, recovery calls the manual run UNVERIFIED and never offers cleanup (byte-review F8, round 2)", async () => {
      const dir = await newProject();
      const data = (await spawnWith(dir, { launcher: () => null }, "w-manual")) as Record<string, any>;
      expect(data.launch).toBe("printed");
      expect(readSpawnJournal(data.journalPath)).toMatchObject({ stage: "launch-manual", launcher: null });
      const rec = reconcileSpawnJournal(dir, readSpawnJournal(data.journalPath)!);
      expect(rec.launch).toBe("manual");
      expect(rec.recommendation).toContain("UNVERIFIED");
      expect(rec.recommendation).not.toContain("await the echo");
      expect(rec.recommendation).not.toContain("--lifecycle closed");
      expect(rec.cleanup).toBe(false);
      // the pen may have pasted the command: an active arrangement with no receipt is exactly the case that must not be closed
      expect(arrangements(dir).find((a) => a.id === data.arrangement.id)!.lifecycle).toBe("active");
      const out = (await handleDuetSpawn({ recover: true }, "md", dir, deps())).output;
      const line = out.split("\n").find((l) => l.includes("w-manual"))!;
      expect(line).toContain("no OS launcher");
      expect(line).not.toContain("--lifecycle closed");
    });

    it("--recover with no name, pen or bounds runs on a project with no spawn dir and says so", async () => {
      const dir = await newProject();
      const res = await handleDuetSpawn({ recover: true }, "md", dir, deps());
      expect(res.exitCode).toBe(0);
      expect(res.output).toContain("No spawn journals");
    });
  });

  it("the role says where the ledger lives: subdirectory and symlink alias are the pen's project, another project is cross-project", async () => {
    const dir = await newProject();
    const other = await newProject("node");
    mkdirSync(join(dir, "packages", "x"), { recursive: true });
    const alias = join(mkdtempSync(join(tmpdir(), "duet-spawn-alias-")), "link");
    dirs.push(join(alias, ".."));
    symlinkSync(dir, alias);
    for (const d of [join(dir, "packages", "x"), alias]) {
      const r = await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN, dir: d }, "md", dir, deps());
      expect(role(r.output)).toContain("resolves to the pen's ledger");
      expect(r.output).not.toContain("Worker ledger:");
    }
    const cross = await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN, dir: other }, "md", dir, deps());
    expect(role(cross.output)).toContain(`loads the ledger at ${realpathSync(other)}`);
    expect(role(cross.output)).toContain("cannot read it from here");
    expect(cross.output).toContain(`Worker ledger: ${realpathSync(other)}`);
    expect(arrangements(dir)).toHaveLength(3);
    expect(arrangements(other)).toEqual([]);
  });

  it("refusals are CliValidationError so the CLI reports them as user errors", async () => {
    const dir = await newProject();
    await expect(handleDuetSpawn({ name: "w", pen: "p", penTaskId: PEN }, "md", dir, deps())).rejects.toBeInstanceOf(CliValidationError);
  });
});

describe("ISS-1303: the worker's model is pinned and the output says why", () => {
  it("absent --model: the launch carries --model opus, the output prints the reason line, JSON carries model and source", async () => {
    const dir = await newProject();
    const md = await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN }, "md", dir, deps());
    expect(md.output).toContain("Model: opus (default hands tier; pass --model to pin another)");
    expect(md.output).toContain(" --model 'opus' ");
    const lines = md.output.split("\n");
    expect(lines.indexOf("Model: opus (default hands tier; pass --model to pin another)")).toBe(lines.findIndex((l) => l.startsWith("Permission mode: ")) - 1);
    const json = jsonData((await handleDuetSpawn({ name: "w2", pen: "p", bounds: ["T-001"], penTaskId: PEN }, "json", dir, deps())).output);
    expect(json.model).toBe("opus");
    expect(json.modelSource).toBe("default");
    expect(json.modelReason).toBe("default hands tier; pass --model to pin another");
  });

  it("explicit --model sonnet passes through to the command, the reason line and the arrangement's worker party", async () => {
    const dir = await newProject();
    const md = await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN, model: "sonnet" }, "md", dir, deps());
    expect(md.output).toContain("Model: sonnet (as given on the command line)");
    expect(md.output).toContain(" --model 'sonnet' ");
    expect(md.output).not.toContain("--model 'opus'");
    expect(arrangements(dir)[0]!.parties[1]).toMatchObject({ role: "worker", modelTier: "sonnet" });
  });

  it("--print shows the resolved model in the command, the Model line and the JSON", async () => {
    const dir = await newProject();
    const md = await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN, print: true }, "md", dir, deps());
    expect(md.output).toContain("--session-id '<minted at launch>' --model 'opus' --permission-mode");
    expect(md.output).toContain("Model: opus (default hands tier; pass --model to pin another)");
    const json = jsonData((await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN, print: true, model: "sonnet" }, "json", dir, deps())).output);
    expect(json.command).toContain("--model 'sonnet'");
    expect(json).toMatchObject({ model: "sonnet", modelSource: "explicit", modelReason: "as given on the command line" });
    expect(existsSync(join(dir, ".story", "spawn"))).toBe(false);
  });

  it("the reference entry documents the default", () => {
    const entry = COMMANDS.find((c) => c.name === "duet spawn")!;
    expect(entry.description).toMatch(/--model defaults to opus \(the hands tier\)/);
  });
});

describe("ISS-1305: --dir may name a directory with no ledger when the pen's project resolves", () => {
  function bareDir(): string {
    const d = mkdtempSync(join(tmpdir(), "duet-spawn-worktree-"));
    dirs.push(d);
    return d;
  }

  it("a worktree without .story spawns in auto mode: the role names both paths, the script cds into the worktree and exports the pen's root", async () => {
    const dir = await newProject();
    const wt = bareDir();
    const res = await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN, dir: wt }, "md", dir, deps());
    expect(res.exitCode).toBe(0);
    const text = role(res.output);
    expect(text).toContain(`loads the board at ${realpathSync(dir)}`);
    expect(text).toContain(`\`${wt}\`, which carries no ledger`);
    expect(text).toContain("## Handshake");
    expect(res.output).toContain(`Worker ledger: the pen's board at ${realpathSync(dir)}; ${wt} carries no ledger`);
    expect(res.output).toContain(`cd '${wt}' && STORYBLOQ_PROJECT_ROOT='${realpathSync(dir)}' claude -n 'w'`);
    const script = readFileSync(/Script: (.+)/.exec(res.output)![1]!, "utf-8");
    expect(script).toContain(`cd '${wt}' || exit 1\nexport STORYBLOQ_PROJECT_ROOT='${realpathSync(dir)}'\n`);
    expect(arrangements(dir)).toHaveLength(1);
    const json = jsonData((await handleDuetSpawn({ name: "w2", pen: "p", bounds: ["T-001"], penTaskId: PEN, dir: wt }, "json", dir, deps())).output);
    expect(json.workerDir).toBe(wt);
    expect(json.workerProjectRoot).toBeNull();
  });

  it("--print previews the same launch and role for a worktree without .story", async () => {
    const dir = await newProject();
    const wt = bareDir();
    const res = await handleDuetSpawn({ name: "w", pen: "p", bounds: ["T-001"], penTaskId: PEN, dir: wt, print: true }, "md", dir, deps());
    expect(res.output).toContain(`cd '${wt}' && STORYBLOQ_PROJECT_ROOT='${realpathSync(dir)}' claude -n 'w'`);
    expect(res.output).toContain("which carries no ledger");
    expect(existsSync(join(dir, ".story", "spawn"))).toBe(false);
  });

  it("an unresolvable pen project is refused before anything is written, for a launch and for --print", async () => {
    const noProject = bareDir();
    const wt = bareDir();
    let opened = 0;
    const d = deps({ launcher: () => { opened++; return "x"; } });
    await expect(handleDuetSpawn({ name: "w", pen: "p", dir: wt, arrangement: "none", penTaskId: PEN }, "md", noProject, d)).rejects.toThrow(/the pen's project cannot be resolved/);
    await expect(handleDuetSpawn({ name: "w", pen: "p", dir: wt, arrangement: "none", penTaskId: PEN, print: true }, "md", noProject, d)).rejects.toThrow(/the pen's project cannot be resolved/);
    await expect(handleDuetSpawn({ name: "w", pen: "p", arrangement: "none", penTaskId: PEN }, "md", noProject, d)).rejects.toBeInstanceOf(CliValidationError);
    expect(opened).toBe(0);
    expect(readdirSync(noProject)).toEqual([]);
  });
});
