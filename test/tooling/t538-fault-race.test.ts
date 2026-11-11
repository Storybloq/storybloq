/**
 * T-538 commit 3, Codex round 1 P1: two processes that reach the same scheduled fault point at once. The marker is
 * claimed exclusively before anything is written, so only the winner writes the kill snapshot, and a loser can
 * never overwrite it.
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { treeSnapshot } from "../../scripts/eval-fault-mcp.js";

const PKG = join(__dirname, "..", "..");
const TSX = join(PKG, "node_modules", ".bin", "tsx");
const RACERS = 12;

/** One racer: waits for the start file, then reaches the fault point once under the shared id, with its own tree. */
const RACER = `
import { existsSync } from "node:fs";
import { collector } from ${JSON.stringify(join(PKG, "scripts", "eval-fault-mcp.ts"))};
const [events, root, go] = process.argv.slice(2);
const fire = collector(events, "step:handover", "cli", () => { process.stdout.write("killed\\n"); process.exit(0); }, {}, "f1");
while (!existsSync(go)) {}
fire("step:handover", { invocation: "inv-" + process.pid, root, target: undefined, setupId: null });
process.stdout.write("lost\\n");
`;

describe("P1: the scheduled fault's marker is claimed before its kill snapshot", () => {
  it("of many processes reaching the point at once, one fires, and the kill snapshot is that one's tree", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "t538race-")));
    try {
      const script = join(dir, "racer.mts");
      writeFileSync(script, RACER);
      const events = join(dir, "events.jsonl");
      writeFileSync(events, "");
      const go = join(dir, "go");
      const roots: string[] = [];
      for (let n = 0; n < RACERS; n++) {
        const root = join(dir, `root-${n}`);
        mkdirSync(join(root, ".story", "tickets"), { recursive: true });
        // Each tree is large enough that its snapshot takes a while, and differs from every other one.
        for (let k = 0; k < 40; k++) writeFileSync(join(root, ".story", "tickets", `T-${k}.json`), JSON.stringify({ racer: n, k, pad: "x".repeat(2000) }));
        roots.push(root);
      }
      const runs = roots.map((root) => new Promise<{ root: string; out: string }>((resolve, reject) => {
        const c = spawn(TSX, [script, events, root, go], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        c.stdout.on("data", (b: Buffer) => { out += b.toString(); });
        c.on("error", reject);
        let err = "";
        c.stderr.on("data", (b: Buffer) => { err += b.toString(); });
        c.on("close", () => resolve({ root, out: out + err }));
      }));
      // Let every racer load and wait at the start line.
      await new Promise((r) => setTimeout(r, 4000));
      writeFileSync(go, "");
      const done = await Promise.all(runs);
      const winners = done.filter((d) => d.out.includes("killed"));
      expect(winners.length, done.map((d) => d.out).join("\n").slice(0, 2000)).toBe(1);
      expect(done.filter((d) => d.out.includes("lost")).length).toBe(RACERS - 1);
      const fired = readFileSync(events, "utf-8").split("\n").filter((l) => l.includes("\"fault-fired\""));
      expect(fired.length).toBe(1);
      const kill = `${events}.kill.f1.json`;
      expect(existsSync(kill)).toBe(true);
      expect(readFileSync(kill, "utf-8")).toBe(treeSnapshot(winners[0]!.root));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
