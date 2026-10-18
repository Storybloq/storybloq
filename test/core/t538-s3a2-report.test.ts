/**
 * T-538 S3a-2 commit 9: the live setup report reads its pending lines from
 * the setup verification record, and an open keyed ticket blocked by an open
 * establishment ticket waits on verification. The frozen report is unchanged.
 */
import { describe, it, expect, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setupApply, setupReport } from "../../src/core/setup-apply.js";
import { setupVerify } from "../../src/core/setup-verify.js";
import { SID, comp, editTicket, est, payload, pinEnvironment, t } from "./t538-s3a2-fixture.js";

vi.setConfig({ testTimeout: 30_000 });
const { folder } = pinEnvironment("t538-s3a2rep");

const REPLAY = join(import.meta.dirname, "fixtures", "t538-replay.sh");
const COMMAND = `sh ${REPLAY} vitest-pass`;

async function ready(): Promise<string> {
  const root = await folder();
  expect((await setupApply(root, payload({ components: [comp({ command: COMMAND })] }))).exitCode).toBe(0);
  await editTicket(root, "T-001", (r) => { r.status = "complete"; r.completedDate = "2026-10-18"; });
  return root;
}

const live = async (root: string) => (await setupReport(root, SID)).lines;
const frozen = async (root: string) => (await setupReport(root, SID, { historical: true })).lines;
const pendingOf = (lines: string[]) => lines.filter((l) => l.startsWith("Pending:"));

describe("the live report's pending lines", () => {
  it("before anything, the record's line is the payload's", async () => {
    const root = await ready();
    expect(pendingOf(await live(root))).toEqual([`Pending: TEST: ${COMMAND} (pending: no tests yet)`]);
  });

  it("a verified component drops out, and the frozen report stays byte-equal", async () => {
    const root = await ready();
    const before = await frozen(root);
    expect((await setupVerify(root, { ticket: "T-002" })).exitCode).toBe(0);
    expect(pendingOf(await live(root))).toEqual([]);
    expect(await frozen(root)).toEqual(before);
    expect(pendingOf(before)).toEqual([`Pending: TEST: ${COMMAND} (pending: no tests yet)`]);
  });

  it("a left-off component says the owner left it off", async () => {
    const root = await ready();
    const before = await frozen(root);
    expect((await setupVerify(root, { ticket: "T-002", resolve: "leave-off", ownerWords: "later" })).exitCode).toBe(0);
    expect(pendingOf(await live(root))).toEqual([`Pending: TEST: ${COMMAND} (pending: left off by the owner)`]);
    expect(await frozen(root)).toEqual(before);
  });

  it("a ticket closed without verification names the reopen", async () => {
    const root = await ready();
    await editTicket(root, "T-002", (r) => { r.status = "complete"; r.completedDate = "2026-10-18"; });
    expect(pendingOf(await live(root))).toEqual([`Pending: TEST: ${COMMAND} (pending: closed without verification; run storybloq setup-verify --ticket T-002 --reopen)`]);
    expect((await setupVerify(root, { ticket: "T-002", reopen: true })).exitCode).toBe(0);
    expect(pendingOf(await live(root))).toEqual([`Pending: TEST: ${COMMAND} (pending: no tests yet)`]);
  });

  it("with no record (a legacy setup) the payload's lines stand", async () => {
    const root = await ready();
    const path = join(root, ".story", "config.json");
    const { setupVerification: _r, ...rest } = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify(rest, null, 2) + "\n");
    await editTicket(root, "T-002", (r) => { r.status = "complete"; r.completedDate = "2026-10-18"; });
    expect(pendingOf(await live(root))).toEqual([`Pending: TEST: ${COMMAND} (pending: no tests yet)`]);
  });

  it("names the component when the setup has several", async () => {
    const root = await folder();
    const components = [comp({ id: "web", workdir: "web", command: COMMAND }), comp({ id: "api", workdir: "api", command: COMMAND })];
    const tickets = [t("K2", []), est("K3", "K2", "web"), t("K5", []), est("K6", "K5", "api")];
    expect((await setupApply(root, payload({ components, tickets }))).exitCode).toBe(0);
    await editTicket(root, "T-003", (r) => { r.status = "complete"; r.completedDate = "2026-10-18"; });
    await editTicket(root, "T-004", (r) => { r.status = "complete"; r.completedDate = "2026-10-18"; });
    expect(pendingOf(await live(root))).toEqual([
      `Pending: TEST (web): ${COMMAND} (pending: no tests yet)`,
      `Pending: TEST (api): ${COMMAND} (pending: closed without verification; run storybloq setup-verify --ticket T-004 --reopen)`,
    ]);
  });
});

describe("what everything open waits on", () => {
  it("a ticket blocked by an open establishment ticket waits on verification, after the owner", async () => {
    const root = await folder();
    const cp = { key: "K6", title: "K6", kind: "acceptance", criteria: "c", evidenceRefs: [], description: "", phase: "K1", blockedBy: [], gates: ["K2"] };
    expect((await setupApply(root, payload({ components: [comp({ command: COMMAND })], checkpoints: [cp] }))).exitCode).toBe(0);
    const lines = await live(root);
    expect(lines.at(-2)).toBe("Ready to build: none");
    expect(lines.at(-1)).toBe("First story: none (everything open waits on the owner and verification)");
  });
});
