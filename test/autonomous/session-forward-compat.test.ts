import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  createSession,
  describeSessionLookupFailure,
  findSessionById,
  findSessionByIdDetailed,
  sessionDir,
  writeSessionSync,
} from "../../src/autonomous/session.js";
import {
  CURRENT_SESSION_SCHEMA_VERSION,
  type FullSessionState,
} from "../../src/autonomous/session-types.js";

/**
 * ISS-902: forward compatibility of session state.json.
 *
 * T-328 covered the backward direction (old file, new code). This is the
 * forward direction: a file written by NEW code, read by code already shipped.
 * That direction cannot be fixed retroactively in released readers, so the
 * only lever is what the writer puts on disk, and these tests pin it.
 *
 * The failure this prevents is not a cosmetic parse error. `resolvedBranchStrategy`
 * gates every session read through a whole-file safeParse, so one out-of-vocab
 * value made `findSessionById` return null and every guide action report the
 * session as missing while `status` still listed it as live.
 */

const createdRoots: string[] = [];
function track(root: string): string {
  createdRoots.push(root);
  return root;
}

afterEach(() => {
  while (createdRoots.length) {
    rmSync(createdRoots.pop()!, { recursive: true, force: true });
  }
});

function newRoot(): string {
  const root = track(mkdtempSync(join(tmpdir(), "iss902-")));
  mkdirSync(join(root, ".story", "sessions"), { recursive: true });
  return root;
}

/**
 * The constraints a pre-T-328 reader places on the two fields T-328 changed,
 * transcribed from the schema at commit e074244c:
 *
 *   schemaVersion:            z.literal(CURRENT_SESSION_SCHEMA_VERSION)  // 1
 *   resolvedBranchStrategy:   z.enum(["none", "per-ticket"]).default("none")
 *
 * Passthrough everywhere else on purpose: this models what an OLD reader
 * rejects, and it rejected exactly these two declarations. Reproducing the
 * entire 900-line historical schema would test the fields T-328 never touched.
 */
const PreT328Pins = z
  .object({
    schemaVersion: z.literal(1),
    resolvedBranchStrategy: z.enum(["none", "per-ticket"]).default("none"),
  })
  .passthrough();

/** Write a session carrying `strategy`, and return the raw on-disk JSON. */
function persistWithStrategy(root: string, strategy: string): Record<string, unknown> {
  const created = createSession(root, "coding", "ws-iss902");
  const dir = sessionDir(root, created.sessionId);
  writeSessionSync(dir, {
    ...created,
    resolvedBranchStrategy: strategy,
  } as unknown as FullSessionState);
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf-8"));
}

describe("ISS-902: a pre-T-328 reader can still parse what we write", () => {
  it("persists the legacy spelling for the default strategy, and stays canonical in memory", () => {
    const root = newRoot();
    const raw = persistWithStrategy(root, "current");

    // The bytes an old reader sees.
    expect(raw.resolvedBranchStrategy).toBe("none");
    expect(PreT328Pins.safeParse(raw).success).toBe(true);

    // ...and this build reads its own file back as canonical.
    const reread = findSessionById(root, raw.sessionId as string);
    expect(reread).not.toBeNull();
    expect(reread!.state.resolvedBranchStrategy).toBe("current");
  });

  it("leaves per-ticket alone, since old readers already accept it", () => {
    const root = newRoot();
    const raw = persistWithStrategy(root, "per-ticket");

    expect(raw.resolvedBranchStrategy).toBe("per-ticket");
    expect(PreT328Pins.safeParse(raw).success).toBe(true);
    expect(findSessionById(root, raw.sessionId as string)!.state.resolvedBranchStrategy)
      .toBe("per-ticket");
  });

  /**
   * The accepted residual, pinned so it is a known cost rather than a
   * surprise. "main" has no pre-T-328 spelling to fall back to. It is opt-in,
   * so the blast radius is users who chose it, not every default session --
   * which is the whole reason "current" is downgraded and "main" is not.
   */
  it("cannot save the opt-in main strategy from an old reader, and does not pretend to", () => {
    const root = newRoot();
    const raw = persistWithStrategy(root, "main");

    expect(raw.resolvedBranchStrategy).toBe("main");
    expect(PreT328Pins.safeParse(raw).success).toBe(false);

    // And this residual stays UNDIAGNOSABLE to a pre-T-328 reader: those
    // builds have neither the fence nor "main", and this file still carries
    // schemaVersion 1, so they collapse it to a missing session exactly as
    // before. The fence only helps readers that already have it, i.e. from
    // this version forward, after some future bump. Nothing here fixes the
    // already-shipped ones -- that is the whole reason "current" is
    // downgraded instead of being left to the fence.
    expect(raw.schemaVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION);

    // Current readers must still round-trip it faithfully.
    expect(findSessionById(root, raw.sessionId as string)!.state.resolvedBranchStrategy)
      .toBe("main");
  });

  it("leaves an absent strategy absent, and still reads back as the canonical default", () => {
    const root = newRoot();
    // createSession does not set the field; the guide does at start. A session
    // written before that assignment must not gain a bogus value from the
    // encode boundary.
    const created = createSession(root, "coding", "ws-iss902");
    const dir = sessionDir(root, created.sessionId);
    writeSessionSync(dir, created);

    const raw = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8"));
    expect("resolvedBranchStrategy" in raw).toBe(false);
    expect(PreT328Pins.safeParse(raw).success).toBe(true);
    expect(findSessionById(root, created.sessionId)!.state.resolvedBranchStrategy)
      .toBe("current");
  });

  it("downgrades on EVERY write, not just at session creation", () => {
    const root = newRoot();
    const created = createSession(root, "coding", "ws-iss902");
    const dir = sessionDir(root, created.sessionId);

    let state = writeSessionSync(dir, {
      ...created,
      resolvedBranchStrategy: "current",
    } as unknown as FullSessionState);
    // writeSessionSync returns canonical in memory even though disk got "none".
    expect(state.resolvedBranchStrategy).toBe("current");

    for (let i = 0; i < 3; i++) {
      state = writeSessionSync(dir, { ...state, guideCallCount: i });
    }

    const raw = JSON.parse(readFileSync(join(dir, "state.json"), "utf-8"));
    expect(raw.resolvedBranchStrategy).toBe("none");
    expect(PreT328Pins.safeParse(raw).success).toBe(true);
  });
});

describe("ISS-902: the schemaVersion fence reports skew instead of absence", () => {
  function plantSchemaVersion(root: string, version: number): string {
    const created = createSession(root, "coding", "ws-iss902");
    const path = join(sessionDir(root, created.sessionId), "state.json");
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    raw.schemaVersion = version;
    writeFileSync(path, JSON.stringify(raw, null, 2));
    return created.sessionId;
  }

  it("names version skew, and the remedy, for a newer writer", () => {
    const root = newRoot();
    const id = plantSchemaVersion(root, CURRENT_SESSION_SCHEMA_VERSION + 1);

    const lookup = findSessionByIdDetailed(root, id);
    expect(lookup.kind).toBe("version-skew");
    if (lookup.kind !== "version-skew") throw new Error("unreachable");
    expect(lookup.writerVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION + 1);
    expect(lookup.readerVersion).toBe(CURRENT_SESSION_SCHEMA_VERSION);

    const message = describeSessionLookupFailure(id, lookup);
    expect(message).not.toMatch(/not found/i);
    expect(message).toMatch(/newer storybloq/i);
    expect(message).toMatch(/restart/i);
    // The operator's first question is "did I lose the work?".
    expect(message).toMatch(/NOT lost/i);
  });

  it("runs BEFORE schema parse, so an unparseable newer file still reports skew", () => {
    const root = newRoot();
    const created = createSession(root, "coding", "ws-iss902");
    const path = join(sessionDir(root, created.sessionId), "state.json");
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    raw.schemaVersion = CURRENT_SESSION_SCHEMA_VERSION + 1;
    // A field this build's schema cannot accept -- exactly the T-328 shape.
    raw.resolvedBranchStrategy = "some-future-strategy";
    writeFileSync(path, JSON.stringify(raw, null, 2));

    expect(findSessionByIdDetailed(root, created.sessionId).kind).toBe("version-skew");
  });

  it("does not fire for the current version", () => {
    const root = newRoot();
    const id = plantSchemaVersion(root, CURRENT_SESSION_SCHEMA_VERSION);
    expect(findSessionByIdDetailed(root, id).kind).toBe("found");
  });
});

describe("ISS-902: findSessionById distinguishes absent from unreadable", () => {
  it("reports a missing directory as missing", () => {
    const root = newRoot();
    const lookup = findSessionByIdDetailed(root, "11111111-2222-3333-4444-555555555555");

    expect(lookup.kind).toBe("missing");
    expect(describeSessionLookupFailure("11111111-2222-3333-4444-555555555555", lookup))
      .toMatch(/not found/i);
  });

  it("reports a present-but-unparseable state.json as corrupt, not missing", () => {
    const root = newRoot();
    const created = createSession(root, "coding", "ws-iss902");
    writeFileSync(join(sessionDir(root, created.sessionId), "state.json"), "{ not json");

    const lookup = findSessionByIdDetailed(root, created.sessionId);
    expect(lookup.kind).toBe("unreadable");

    const message = describeSessionLookupFailure(created.sessionId, lookup);
    expect(message).toMatch(/corrupt/i);
    expect(message).not.toMatch(/not found/i);
    // session_report is the tool that could already tell the operator this.
    expect(message).toMatch(/session report/i);
  });

  it("reports a schema-invalid state.json as corrupt, not missing", () => {
    const root = newRoot();
    const created = createSession(root, "coding", "ws-iss902");
    const path = join(sessionDir(root, created.sessionId), "state.json");
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    delete raw.sessionId;
    writeFileSync(path, JSON.stringify(raw, null, 2));

    const lookup = findSessionByIdDetailed(root, created.sessionId);
    expect(lookup.kind).toBe("unreadable");
    if (lookup.kind !== "unreadable") throw new Error("unreachable");
    expect(lookup.reason).toBe("schema");
  });

  it("reports a session directory with no state.json as unreadable-file", () => {
    const root = newRoot();
    const created = createSession(root, "coding", "ws-iss902");
    rmSync(join(sessionDir(root, created.sessionId), "state.json"));

    const lookup = findSessionByIdDetailed(root, created.sessionId);
    expect(lookup.kind).toBe("unreadable");
    if (lookup.kind !== "unreadable") throw new Error("unreachable");
    // Distinct from invalid-json and from schema: the directory survived but
    // the file did not, which is a different operator story.
    expect(lookup.reason).toBe("unreadable-file");
  });

  /**
   * ISS-556 recovery must survive the ISS-902 refactor. readSessionDetailed
   * now validates the snapshot it already decoded instead of calling
   * readSessionResilient, so this is the regression that would catch the
   * recovery being dropped on the detailed path.
   */
  it("still recovers an invalid lensReviewHistory disposition", () => {
    const root = newRoot();
    const created = createSession(root, "coding", "ws-iss902");
    const path = join(sessionDir(root, created.sessionId), "state.json");
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    raw.lensReviewHistory = [{
      ticketId: "T-001",
      stage: "CODE_REVIEW",
      lens: "security",
      category: "injection",
      severity: "major",
      disposition: "not-a-real-disposition",
      description: "planted by the ISS-902 regression test",
      timestamp: "2026-07-28T00:00:00.000Z",
    }];
    writeFileSync(path, JSON.stringify(raw, null, 2));

    const lookup = findSessionByIdDetailed(root, created.sessionId);
    expect(lookup.kind, "ISS-556 recovery was lost on the detailed path").toBe("found");
    if (lookup.kind !== "found") throw new Error("unreachable");
    expect(lookup.info.state.lensReviewHistory).toEqual([]);
  });

  it("keeps the null contract for the callers that only branch on presence", () => {
    const root = newRoot();
    const created = createSession(root, "coding", "ws-iss902");
    writeFileSync(join(sessionDir(root, created.sessionId), "state.json"), "{ not json");

    expect(findSessionById(root, created.sessionId)).toBeNull();
    expect(findSessionById(root, "11111111-2222-3333-4444-555555555555")).toBeNull();
  });
});
