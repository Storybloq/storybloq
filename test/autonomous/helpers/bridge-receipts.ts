/**
 * Gate-grade bridge receipts for stage tests (ISS-1332).
 *
 * Builders only: nothing here touches a report, so a test carries a receipt
 * only where its own report literal says so. A plan receipt is computed from
 * the plan text the test wrote; a code receipt is a real item (the fixture
 * root made a git repository with a baseline commit) and a real review clone
 * whose range holds the same change, because the gate's evidence is git's own.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The models[] entry a Codex bridge call reports at tier max. */
export const BRIDGE_REVIEW_MODEL = {
  provider: "codex",
  role: "review",
  requested: "max",
  resolved: "gpt-6-astra",
  observed: "gpt-6-astra",
  evidence: "runtime_session_record",
  selection: "requested",
};

/** Identity per command, never written to a config (ISS-1220). */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t.t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", "core.hooksPath=/dev/null", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

/** The plan receipt for exactly this text, counted as the gate counts it. */
export function planReceipt(planText: string, sessionId = "bridge-plan-1") {
  const lines = planText.length === 0 ? 0 : planText.replace(/\n$/, "").split("\n").length;
  return {
    receipt: `REVIEWED: plan.md (~${lines} lines)`,
    planSha256: createHash("sha256").update(planText, "utf8").digest("hex"),
    models: [BRIDGE_REVIEW_MODEL],
    sessionId,
  };
}

export interface BridgeCodeItem {
  /** The item's baseline commit in the fixture root: set it as the session's mergeBase. */
  readonly baseline: string;
  readonly receipt: {
    readonly cwd: string;
    readonly base: string;
    readonly head: string;
    readonly receipt: string;
    readonly models: (typeof BRIDGE_REVIEW_MODEL)[];
    readonly sessionId: string;
  };
  /** Removes the review clone; the root belongs to the test. */
  readonly cleanup: () => void;
}

/**
 * Makes `root` a repository whose baseline commit is the fixture as it stands,
 * then writes `after` to `path` as the item's one change: a tracked
 * modification when the fixture already created the path, an untracked file
 * when it did not. The review clone's base holds the path's baseline bytes (or
 * lacks it, when the fixture never made it) and its head holds `after`, so the
 * receipt chains from the baseline to the working tree. `lacking-path` builds
 * the base without the path, for the unrelated-base refusal only.
 */
export function bridgeCodeItem(
  root: string,
  opts: { readonly path?: string; readonly after?: string; readonly reviewBase?: "matching" | "lacking-path"; readonly sessionId?: string } = {},
): BridgeCodeItem {
  const path = opts.path ?? "src/item.ts";
  const after = opts.after ?? "export const item = 1;\n";
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", "baseline");
  const baseline = git(root, "rev-parse", "HEAD");
  const before = existsSync(join(root, path)) ? readFileSync(join(root, path)) : null;
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), after);

  const clone = mkdtempSync(join(tmpdir(), "bridge-review-"));
  git(clone, "init", "-q");
  writeFileSync(join(clone, "README.md"), "review clone\n");
  if (before !== null && opts.reviewBase !== "lacking-path") {
    mkdirSync(dirname(join(clone, path)), { recursive: true });
    writeFileSync(join(clone, path), before);
  }
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "review base");
  const base = git(clone, "rev-parse", "HEAD");
  mkdirSync(dirname(join(clone, path)), { recursive: true });
  writeFileSync(join(clone, path), after);
  git(clone, "add", "-A");
  git(clone, "commit", "-q", "-m", "review head");
  const head = git(clone, "rev-parse", "HEAD");
  const [added, deleted] = git(clone, "diff", "--numstat", base, head, "--", path).split("\t");
  const changed = Number(added) + Number(deleted);

  return {
    baseline,
    receipt: { cwd: clone, base, head, receipt: `REVIEWED: ${path} (~${changed} changed lines)`, models: [BRIDGE_REVIEW_MODEL], sessionId: opts.sessionId ?? "bridge-code-1" },
    cleanup: () => rmSync(clone, { recursive: true, force: true }),
  };
}
