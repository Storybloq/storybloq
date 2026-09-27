import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultHealthDeps, readFileThreeValued, runBounded } from "../../../src/core/health/deps.js";
import { storybloqGlobalDir } from "../../../src/core/global-config.js";
import { probeRead } from "./subprocess-probe.js";
import { initProject } from "../../../src/core/init.js";
import { ensureCapture } from "../../../src/core/session-intel/capture.js";
import { processEra } from "../../../src/core/session-intel/process-era.js";
import { resolveCallerBinding } from "../../../src/core/session-intel/presence-bridge.js";
import { handleStopHookSample } from "../../../src/cli/commands/session-intel.js";
import { SID, assistantRecord, localCommandRecord, writeTranscript } from "../session-intel-fixtures.js";

/** Every file under `dir`, by relative path, with its exact bytes. */
function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else out[rel] = readFileSync(full, "utf-8");
    }
  };
  walk(dir, "");
  return out;
}

const DEPS_MODULE = fileURLToPath(new URL("../../../src/core/health/deps.ts", import.meta.url));

/**
 * The default adapters are the only place the syscalls happen, so this is the
 * only test that needs a real (isolated) HOME. Everything else in
 * `core/health` is a pure function of injected data.
 */
describe("T-502 default health adapters", () => {
  let home: string;
  let projectDir: string;
  let originalHome: string | undefined;
  let originalGlobalDir: string | undefined;
  let originalCodexHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "storybloq-health-home-"));
    projectDir = mkdtempSync(join(tmpdir(), "storybloq-health-proj-"));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    // ISS-1331: the global dir resolves from STORYBLOQ_GLOBAL_DIR before HOME, and a gate env sets it, so the
    // fixture pins it to the HOME stub's own dir; CODEX_HOME is cleared for the same reason.
    originalGlobalDir = process.env.STORYBLOQ_GLOBAL_DIR;
    originalCodexHome = process.env.CODEX_HOME;
    process.env.STORYBLOQ_GLOBAL_DIR = join(home, ".claude", "storybloq");
    delete process.env.CODEX_HOME;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalGlobalDir === undefined) delete process.env.STORYBLOQ_GLOBAL_DIR;
    else process.env.STORYBLOQ_GLOBAL_DIR = originalGlobalDir;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  describe("readFileThreeValued", () => {
    it("reports a missing path as absent", () => {
      expect(readFileThreeValued(join(projectDir, "nope.json"), 1024)).toEqual({ kind: "absent" });
    });

    it("reports a dangling symlink as absent", () => {
      const link = join(projectDir, "dangling");
      symlinkSync(join(projectDir, "missing"), link);
      expect(readFileThreeValued(link, 1024).kind).toBe("absent");
    });

    /**
     * These two assert the THREE-VALUED contract (kind, and the text on ok)
     * rather than deep-equalling the whole record. `BoundedRead`'s ok variant
     * gained a `target` field in T-523, and a whole-object equality here turns
     * every additive field on a shared return type into a failure in a health
     * test that does not consume it. The fields this adapter exists to provide
     * are still pinned exactly.
     */
    it("reads a regular file", () => {
      const p = join(projectDir, "a.json");
      writeFileSync(p, "{\"a\":1}");
      const res = readFileThreeValued(p, 1024);
      expect(res.kind).toBe("ok");
      expect(res.kind === "ok" ? res.text : null).toBe("{\"a\":1}");
    });

    it("follows a legitimate symlink, matching readBoundedFile's documented contract", () => {
      const target = join(projectDir, "real.json");
      writeFileSync(target, "{}");
      const link = join(projectDir, "link.json");
      symlinkSync(target, link);
      const res = readFileThreeValued(link, 1024);
      expect(res.kind).toBe("ok");
      expect(res.kind === "ok" ? res.text : null).toBe("{}");
    });

    it("reports a symlink loop as indeterminate, not absent", () => {
      const a = join(projectDir, "loop-a");
      const b = join(projectDir, "loop-b");
      symlinkSync(b, a);
      symlinkSync(a, b);
      expect(readFileThreeValued(a, 1024).kind).toBe("indeterminate");
    });

    it("reports an over-cap file as indeterminate and names the cap", () => {
      const p = join(projectDir, "big.json");
      writeFileSync(p, "x".repeat(200));
      const read = readFileThreeValued(p, 100);
      expect(read.kind).toBe("indeterminate");
      expect(read.kind === "indeterminate" && read.reason).toContain("larger than 100 bytes");
    });

    // Run in a CHILD under a SIGKILL deadline: a blocking-read regression
    // would freeze the worker's event loop, and a Vitest timeout is a timer on
    // that same loop, so it could never fire.
    it("reports a FIFO as indeterminate without blocking", { timeout: 40_000 }, () => {
      const p = join(projectDir, "pipe");
      if (spawnSync("mkfifo", [p], { stdio: "ignore" }).status !== 0) return; // no mkfifo here
      const probe = probeRead({
        moduleFile: DEPS_MODULE,
        exportName: "readFileThreeValued",
        path: p,
        timeoutMs: 20_000,
      });
      expect(probe.timedOut).toBe(false);
      expect(probe.status).toBe(0);
      expect(probe.value).toEqual({ kind: "indeterminate", reason: "not a regular file" });
    });

    it("reports a directory as indeterminate", () => {
      expect(readFileThreeValued(projectDir, 1024).kind).toBe("indeterminate");
    });

    it("reports an unreadable file as indeterminate", () => {
      if (process.getuid?.() === 0) return; // root can read anything
      const p = join(projectDir, "secret.json");
      writeFileSync(p, "{}");
      chmodSync(p, 0o000);
      try {
        expect(readFileThreeValued(p, 1024).kind).toBe("indeterminate");
      } finally {
        chmodSync(p, 0o600);
      }
    });
  });

  describe("runBounded", () => {
    it("reports a missing binary as enoent", () => {
      expect(runBounded("storybloq-no-such-binary-xyz", ["--version"], 500)).toEqual({ kind: "enoent" });
    });

    it("reports a slow command as timeout, not failed", { timeout: 5000 }, () => {
      expect(runBounded("sleep", ["5"], 100)).toEqual({ kind: "timeout" });
    });

    it("reports a non-zero exit as failed with the code", () => {
      const result = runBounded("false", [], 2000);
      expect(result.kind).toBe("failed");
      expect(result.kind === "failed" && result.code).toBe(1);
    });

    it("reports success with stdout", () => {
      const result = runBounded("echo", ["hello"], 2000);
      expect(result.kind).toBe("ok");
      expect(result.kind === "ok" && result.stdout.trim()).toBe("hello");
    });
  });

  describe("the assembled deps", () => {
    it("reads the machine-wide kill switch", () => {
      expect(storybloqGlobalDir()).toBe(join(home, ".claude", "storybloq"));
      const deps = defaultHealthDeps({ ledgerRoot: null });
      expect(deps.globalConfig()).toBeNull();
      mkdirSync(join(home, ".claude", "storybloq"), { recursive: true });
      writeFileSync(join(home, ".claude", "storybloq", "config.json"), JSON.stringify({ healthCheck: { enabled: false } }));
      expect(defaultHealthDeps({ ledgerRoot: null }).globalConfig()).toEqual({ healthCheck: { enabled: false } });
    });

    it("round-trips the shared update-check cache", async () => {
      const deps = defaultHealthDeps({ ledgerRoot: null });
      expect(deps.versionCache.read("1.14.0")).toBeNull();
      mkdirSync(join(home, ".claude", "storybloq"), { recursive: true });
      writeFileSync(
        join(home, ".claude", "storybloq", "update-check.json"),
        JSON.stringify({ latestVersion: "1.15.0", fetchedAt: Date.now() }),
      );
      const info = defaultHealthDeps({ ledgerRoot: null }).versionCache.read("1.14.0");
      expect(info).toEqual({ currentVersion: "1.14.0", latestVersion: "1.15.0", updateAvailable: true });
      // A fresh cache is returned without a fetch, so this resolves offline.
      await expect(
        defaultHealthDeps({ ledgerRoot: null }).versionCache.refresh({ currentVersion: "1.14.0", force: false, timeoutMs: 1 }),
      ).resolves.toEqual(info);
    });

    it("reports the home directory, platform and env it will use", () => {
      const deps = defaultHealthDeps({ ledgerRoot: null });
      expect(deps.homeDir).toBe(home);
      expect(deps.platform).toBe(process.platform);
      expect(deps.env).toBe(process.env);
      expect(deps.now()).toBeGreaterThan(0);
    });

    it("reads the auto-compact window layers for the given project directory", () => {
      mkdirSync(join(projectDir, ".claude"), { recursive: true });
      writeFileSync(join(projectDir, ".claude", "settings.json"), JSON.stringify({ autoCompactWindow: 500_000 }));
      const diag = defaultHealthDeps({ ledgerRoot: null }).settings.autoCompactWindow(projectDir);
      const project = diag.layers.find((l) => l.source === "project")!;
      expect(project.kind).toBe("ok");
      expect(project.value).toBe(500_000);
    });

    it("returns absent for a skill marker that is not installed, and reads one that is", () => {
      const deps = defaultHealthDeps({ ledgerRoot: null });
      const claude = deps.skillMarker.targets().find((t) => t.id === "claude")!;
      expect(deps.skillMarker.installed(claude)).toBe(false);
      expect(deps.skillMarker.marker(claude)).toEqual({ kind: "absent" });
      mkdirSync(claude.dir, { recursive: true });
      writeFileSync(join(claude.dir, "SKILL.md"), "# skill\n");
      writeFileSync(join(claude.dir, ".storybloq-version"), "1.13.0\n");
      const fresh = defaultHealthDeps({ ledgerRoot: null });
      expect(fresh.skillMarker.installed(claude)).toBe(true);
      expect(fresh.skillMarker.marker(claude)).toEqual({ kind: "ok", value: "1.13.0" });
    });

    it("has no caller sample without a ledger root", () => {
      expect(defaultHealthDeps({ ledgerRoot: null }).callerSample(150)).toBeNull();
    });

    // The branch that mattered: a BOUND caller. The rejected implementation
    // (T-501's acquireCallerSample) refreshes here through sampleSession,
    // which PERSISTS onto the presence record. A health run must observe
    // session state, never write it, and must not describe a sample too old
    // to still be true of this session.
    async function boundFixture(
      fn: (ctx: { root: string; projects: string; sessionId: string }) => Promise<void> | void,
    ): Promise<void> {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "storybloq-health-bound-")));
      const root = join(base, "proj");
      const projects = join(base, "home", ".claude", "projects");
      mkdirSync(root, { recursive: true });
      mkdirSync(projects, { recursive: true });
      const saved = {
        sid: process.env.CLAUDE_CODE_SESSION_ID,
        pid: process.env.CLAUDE_PID,
        client: process.env.STORYBLOQ_CLIENT,
      };
      try {
        await initProject(root, { name: "health-bound" });
        process.env.CLAUDE_CODE_SESSION_ID = SID;
        process.env.CLAUDE_PID = String(process.pid);
        delete process.env.STORYBLOQ_CLIENT;
        processEra.reset();
        await fn({ root, projects, sessionId: SID });
      } finally {
        for (const [k, v] of [["CLAUDE_CODE_SESSION_ID", saved.sid], ["CLAUDE_PID", saved.pid], ["STORYBLOQ_CLIENT", saved.client]] as const) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        processEra.reset();
        rmSync(base, { recursive: true, force: true });
      }
    }

    const encoded = (root: string) => root.replace(/[^A-Za-z0-9]/g, "-");

    it("leaves the presence tree byte-identical for a bound caller with no stored sample", { timeout: 20_000 }, async () => {
      await boundFixture(async ({ root, sessionId }) => {
        const capture = ensureCapture({ root, sessionId, source: "startup", now: Date.now() });
        expect(capture.status).not.toBe("skipped");
        // The precondition the regression depends on: the caller really is bound.
        expect(resolveCallerBinding(root).bound).toBe(true);

        const telemetry = join(root, ".story", "telemetry");
        const before = snapshotTree(telemetry);
        expect(Object.keys(before).length).toBeGreaterThan(0);
        expect(defaultHealthDeps({ ledgerRoot: root }).callerSample(150)).toBeNull();
        expect(snapshotTree(telemetry)).toEqual(before);
      });
    });

    it("reports a FRESH stored 1M-model flag and leaves the tree byte-identical", { timeout: 20_000 }, async () => {
      await boundFixture(async ({ root, projects, sessionId }) => {
        const now = Date.now();
        ensureCapture({ root, sessionId, source: "startup", now: now - 60_000 });
        writeTranscript(projects, encoded(root), sessionId, [
          localCommandRecord({ ts: new Date(now - 30_000).toISOString(), form: "backtick", oneMillion: true }),
          assistantRecord({ ts: new Date(now - 20_000).toISOString(), read: 50_000 }),
        ]);
        const sampled = handleStopHookSample({ root, sessionId, cwd: root, now, projectsDir: projects });
        expect(sampled.result?.presence).toBe("persisted");

        const telemetry = join(root, ".story", "telemetry");
        const before = snapshotTree(telemetry);
        expect(defaultHealthDeps({ ledgerRoot: root }).callerSample(150)).toEqual({ oneMillionFlag: true });
        expect(snapshotTree(telemetry)).toEqual(before);
      });
    });

    it("refuses a STALE stored sample instead of describing a session that may have changed model", { timeout: 20_000 }, async () => {
      await boundFixture(async ({ root, projects, sessionId }) => {
        // Well past sessionIntel's maxSampleAgeMs (30 s by default).
        const old = Date.now() - 10 * 60_000;
        ensureCapture({ root, sessionId, source: "startup", now: old - 60_000 });
        writeTranscript(projects, encoded(root), sessionId, [
          localCommandRecord({ ts: new Date(old - 30_000).toISOString(), form: "backtick", oneMillion: true }),
          assistantRecord({ ts: new Date(old - 20_000).toISOString(), read: 50_000 }),
        ]);
        const sampled = handleStopHookSample({ root, sessionId, cwd: root, now: old, projectsDir: projects });
        expect(sampled.result?.presence).toBe("persisted");

        const telemetry = join(root, ".story", "telemetry");
        const before = snapshotTree(telemetry);
        expect(defaultHealthDeps({ ledgerRoot: root }).callerSample(150)).toBeNull();
        expect(snapshotTree(telemetry)).toEqual(before);
      });
    });

    it("resolves the session-intel config with and without a ledger root", () => {
      const deps = defaultHealthDeps({ ledgerRoot: null });
      expect(deps.sessionIntelConfig(null).recommendedWindowMax).toBeGreaterThan(0);
      mkdirSync(join(projectDir, ".story"), { recursive: true });
      writeFileSync(join(projectDir, ".story", "config.json"), JSON.stringify({ sessionIntel: { recommendedWindowMax: 0 } }));
      expect(deps.sessionIntelConfig(projectDir).recommendedWindowMax).toBe(0);
    });
  });
});
