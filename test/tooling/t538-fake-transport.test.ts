// T-538 S5b-0 commit 6a: the fake transport's own rows. It must behave as the seam does from runAttempt's
// side (paths under /vol/att, every exec recorded, the helper's documents), and nothing under scripts/
// may reach it.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { treeDigest } from "../../scripts/onboarding-eval-lib.js";
import { asAttemptPath, type ExecSpec } from "../../scripts/onboarding-eval-transport.js";
import { makeFakeTransport } from "./fake-transport.js";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const root = mkdtempSync(join(tmpdir(), "t538-ft-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const spec = (o: Partial<ExecSpec> = {}): ExecSpec => ({ argv: ["true"], cwd: asAttemptPath("/vol/att/project"), env: {}, stdin: null, timeoutSeconds: 10, stdoutLimit: 1 << 20, stderrLimit: 1 << 20, ...o });

describe("the fake transport", () => {
  it("runs in the mapped folder, maps /vol/att in arguments and env, and prints container paths only", async () => {
    const tree = mkdtempSync(join(root, "t-"));
    const t = makeFakeTransport({ tree });
    const r = await t.exec(spec({ argv: ["/bin/sh", "-c", 'pwd; echo "$HOME"; ls /vol/att'], env: { HOME: "/vol/att/home", PATH: "/usr/bin:/bin" } }));
    expect(r.outcome).toBe("ok");
    expect(r.stdout.toString().split("\n").slice(0, 3)).toEqual(["/vol/att/project", "/vol/att/home", "project"]);
    expect(r.stdout.toString()).not.toContain(tree);
    expect(t.calls).toEqual([{ kind: "exec", argv: ["/bin/sh", "-c", 'pwd; echo "$HOME"; ls /vol/att'], cwd: "/vol/att/project", env: { HOME: "/vol/att/home", PATH: "/usr/bin:/bin" } }]);
  });
  it("refuses what the real transport refuses", () => {
    const t = makeFakeTransport({ tree: mkdtempSync(join(root, "t-")) });
    expect(() => t.exec(spec({ env: { NODE_OPTIONS: "x" } as never }))).toThrow(/not allowed/);
    expect(() => t.exec(spec({ cwd: "/etc" as never }))).toThrow(/not a path under/);
    expect(() => t.exec(spec({ argv: [] }))).toThrow(/bad exec/);
  });
  it("streams whole lines and answers a stubbed command without running it", async () => {
    const t = makeFakeTransport({ tree: mkdtempSync(join(root, "t-")), stub: (argv) => (argv[0] === "codex" ? { status: 0, stdout: "{\"a\":1}\n{\"b\":2}\n" } : null) });
    const seen: string[] = [];
    const r = await t.execStream(spec({ argv: ["codex", "exec"] }), (l) => seen.push(l.toString()));
    expect([seen, r.child?.status]).toEqual([['{"a":1}', '{"b":2}'], 0]);
    expect(t.calls[0]!.kind).toBe("stream");
  });
  it("answers the helper from the same functions, on the mapped tree", async () => {
    const tree = mkdtempSync(join(root, "t-"));
    const t = makeFakeTransport({ tree });
    mkdirSync(join(tree, "project", ".story"), { recursive: true });
    writeFileSync(join(tree, "project", ".story", "config.json"), "{}");
    symlinkSync("config.json", join(tree, "project", ".story", "link"));
    expect(await t.helper("tree-digest", ["/vol/att/project"])).toEqual(treeDigest(join(tree, "project")));
    expect((await t.readBytes(asAttemptPath("/vol/att/project/.story/config.json"), 10))?.toString()).toBe("{}");
    expect(await t.readBytes(asAttemptPath("/vol/att/project/none"), 10)).toBeNull();
    await expect(t.readBytes(asAttemptPath("/vol/att/project/.story/link"), 10)).rejects.toThrow(/a symlink/);
    await expect(t.helper("rm" as never, [])).rejects.toThrow(/unknown helper operation/);
    const c = await t.captureLive([["ticket", "next"]]);
    expect([c.status, c.packExit, c.tar.length > 0]).toEqual(["consistent", 0, true]);
  });
  it("records stop, pack and removal and gives the scripted answers", async () => {
    const t = makeFakeTransport({ tree: mkdtempSync(join(root, "t-")), stop: () => ({ ok: false, reason: "scripted" }), left: () => 2 });
    const sig = new AbortController().signal;
    expect(await t.stop(10, sig)).toEqual({ ok: false, reason: "scripted" });
    expect(await t.packFinal({ image: "i", volume: "v", target: "/vol/att", profile: "attempt", rawDir: root, onCreated: () => {}, timeoutMs: 1 }, sig)).toEqual({ ok: false, reason: "the fake has no pack" });
    expect(await t.remove(sig)).toEqual({ left: 2 });
    expect(t.calls.map((c) => c.kind)).toEqual(["stop", "pack", "remove"]);
  });
});

describe("nothing under scripts/ reaches the fake", () => {
  it("no script imports the fake or anything else under test/tooling", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|mts|mjs|js)$/.test(e.name) && /from\s+["'][^"']*\/test\/tooling\/|import\(\s*["'][^"']*\/test\/tooling\/|fake-transport/.test(readFileSync(p, "utf8"))) offenders.push(p);
      }
    };
    walk(join(PKG, "scripts"));
    expect(offenders).toEqual([]);
  });
});
