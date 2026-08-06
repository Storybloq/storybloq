/**
 * ISS-982 (pen pre-implementation finding, sent after Codex round 9's plan
 * approval): a session written to disk BEFORE this field existed must still
 * parse after the upgrade -- the exact ISS-902 shape ("widening a field
 * bricks in-flight sessions for any older reader"), already paid for once.
 *
 * `.default([])` on `commitAttributionAudits` is what makes a session
 * missing the key parse successfully rather than fail the whole state.json
 * read. This is a forward-compat property, not a mechanism claim: pinned by
 * asserting the CONSEQUENCE (parses, value is []) through the real
 * production parser, and by a mutant that removes `.default([])` and
 * confirms this exact test is what dies.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionState } from "../../src/autonomous/session-types.js";
import { createSession } from "../../src/autonomous/session.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A real, schema-valid state to mutate -- a hand-built fixture would drift from the real schema. */
function realState(): Record<string, unknown> {
  const root = mkdtempSync(join(tmpdir(), "storybloq-commit-audits-"));
  roots.push(root);
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
  const s = createSession(root, "default", "ws-1");
  return JSON.parse(
    readFileSync(join(root, ".story", "sessions", s.sessionId, "state.json"), "utf-8"),
  ) as Record<string, unknown>;
}

describe("commitAttributionAudits forward-compat (ISS-982)", () => {
  it("a session written before this field existed still parses, defaulting to []", () => {
    const raw = realState();
    expect("commitAttributionAudits" in raw).toBe(true); // this build's own writer always includes it
    delete raw.commitAttributionAudits; // simulate a pre-ISS-982 session on disk

    const result = parseSessionState(raw);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.commitAttributionAudits).toEqual([]);
  });

  it("createSession initializes a fresh (not disk-loaded) session with commitAttributionAudits present and empty", () => {
    const root = mkdtempSync(join(tmpdir(), "storybloq-commit-audits-fresh-"));
    roots.push(root);
    mkdirSync(join(root, ".story", "sessions"), { recursive: true });
    const s = createSession(root, "default", "ws-1");
    expect(s.commitAttributionAudits).toEqual([]);
  });
});
