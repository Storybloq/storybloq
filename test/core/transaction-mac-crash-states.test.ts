/**
 * ISS-1399: the CLI recovers the crash states the Mac app's transaction
 * leaves (the ISS-1395 cross-writer contract; the app never recovers a
 * journal itself).
 *
 * The fixtures follow what macos/claudestory/Core/NativeTransaction.swift
 * writes at 5ffb9084 (file sha256
 * 0caffb9e5735833cd548f64bf31579d6b2fc4499bbae675accb2a62d3a251823): the
 * journal at `.story/.txn.json` as `{entries, commitStarted, owner}`, write
 * entries only, absolute `target` and `tempPath`, `tempPath` as
 * `<target>.<pid>.tmp`, owner `{pid, processSignature: null, episodeId}`,
 * and the commit marker written whole at `.story/.txn.json.marker.tmp` and
 * renamed over the journal. The journal here is semantically compatible
 * JSON: the same keys, values and layout, with strings quoted by
 * JSON.stringify. Byte identity with the app's JSONSerialization quoting is
 * not claimed. No mocks: real files, recovered by a locked load.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../../src/core/init.js";
import { handleTicketCreate } from "../../src/cli/commands/ticket.js";
import { loadProject } from "../../src/core/project-loader.js";

const MAC_PID = 4242;
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** NativeTransaction.journal: two-space JSON, no trailing newline. */
function macJournal(targets: string[], commitStarted: boolean): string {
  const q = (s: string) => JSON.stringify(s);
  const items = targets.map(
    (t) => `    {\n      "op": "write",\n      "target": ${q(t)},\n      "tempPath": ${q(`${t}.${MAC_PID}.tmp`)}\n    }`,
  );
  return (
    `{\n  "entries": [\n${items.join(",\n")}\n  ],\n  "commitStarted": ${commitStarted},\n` +
    `  "owner": {\n    "pid": ${MAC_PID},\n    "processSignature": null,\n    "episodeId": "5f2c7a8e-6c1d-4b8a-9d0e-1f2a3b4c5d6e"\n  }\n}`
  );
}

interface Fixture {
  root: string;
  journal: string;
  sidecar: string;
  targets: string[];
  old: string[];
  next: string[];
}

async function project(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "iss1399-mac-"));
  roots.push(root);
  await initProject(root, { name: "iss1399" });
  for (const title of ["First", "Second"]) {
    await handleTicketCreate(
      { title, type: "task", phase: "p0", description: "", blockedBy: [], parentTicket: null },
      "json",
      root,
    );
  }
  const dir = join(root, ".story", "tickets");
  const targets = readdirSync(dir).filter((n) => n.endsWith(".json")).sort().map((n) => join(dir, n));
  expect(targets).toHaveLength(2);
  const old = targets.map((t) => readFileSync(t, "utf-8"));
  const next = old.map((o) => JSON.stringify({ ...JSON.parse(o), title: `${JSON.parse(o).title} moved` }, null, 2) + "\n");
  return { root, journal: join(root, ".story", ".txn.json"), sidecar: join(root, ".story", ".txn.json.marker.tmp"), targets, old, next };
}

function stageTemps(f: Fixture): void {
  f.targets.forEach((t, i) => writeFileSync(`${t}.${MAC_PID}.tmp`, f.next[i]!));
}

function leftovers(f: Fixture): string[] {
  return [f.journal, f.sidecar, ...f.targets.map((t) => `${t}.${MAC_PID}.tmp`)].filter((p) => existsSync(p));
}

describe("ISS-1399: Mac-produced crash states, recovered by the CLI", () => {
  it("X1: a false journal, its temps and a half-written marker sidecar roll back and leave nothing", async () => {
    const f = await project();
    writeFileSync(f.journal, macJournal(f.targets, false));
    stageTemps(f);
    const marker = macJournal(f.targets, true);
    writeFileSync(f.sidecar, marker.slice(0, Math.floor(marker.length / 2)));
    await loadProject(f.root);
    expect(f.targets.map((t) => readFileSync(t, "utf-8"))).toEqual(f.old);
    expect(leftovers(f)).toEqual([]);
  });

  it("X2: a published marker with no target renamed is finished forward", async () => {
    const f = await project();
    writeFileSync(f.journal, macJournal(f.targets, true));
    stageTemps(f);
    await loadProject(f.root);
    expect(f.targets.map((t) => readFileSync(t, "utf-8"))).toEqual(f.next);
    expect(leftovers(f)).toEqual([]);
  });

  it("X3: partially applied targets are finished forward", async () => {
    const f = await project();
    writeFileSync(f.journal, macJournal(f.targets, true));
    writeFileSync(f.targets[0]!, f.next[0]!);
    writeFileSync(`${f.targets[1]!}.${MAC_PID}.tmp`, f.next[1]!);
    await loadProject(f.root);
    expect(f.targets.map((t) => readFileSync(t, "utf-8"))).toEqual(f.next);
    expect(leftovers(f)).toEqual([]);
  });
});
