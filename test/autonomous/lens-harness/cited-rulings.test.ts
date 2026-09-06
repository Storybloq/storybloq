/**
 * T-494 scope 2B: cited rulings reaching a LENS, and what happens when they
 * cannot.
 *
 * THE ENFORCEMENT CLAIM THIS FILE PINS. An earlier revision of this design said
 * a blocking meta-finding forces a reject, on the secrets gate's precedent.
 * That was wrong: the secrets finding blocks because its CATEGORY is in the
 * DEFAULT `alwaysBlock` list, and both `alwaysBlock` and `neverBlock` are
 * project configuration. So the tests below assert the verdict floor comes from
 * `nextActions` -- including under the `neverBlock: ["security"]` configuration
 * that demotes the meta-finding, which is the configuration the earlier design
 * would have passed under while delivering nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePrepare } from "../../../src/autonomous/lens-harness/prepare.js";
import {
  handleSynthesize,
  CITED_RULINGS_META_FINDING_ID,
} from "../../../src/autonomous/lens-harness/synthesize.js";
import {
  writeToCache,
  getFromCache,
} from "../../../src/autonomous/lens-harness/cache.js";
import { ReviewVerdictSchema } from "@storybloq/lenses";
import { buildCitationResolutionContext, resolveCitation } from "../../../src/core/ruling.js";
import type { CitationResolution } from "../../../src/core/ruling.js";
import { makeRuling } from "../../core/test-factories.js";

const RULING_TEXT = "Rulings reach agents by citation, not by paste.";

function citations(specs: { id: string; text: string }[]): CitationResolution[] {
  const rulings = specs.map((s) => makeRuling({ id: s.id, text: s.text }));
  const ctx = buildCitationResolutionContext(rulings, new Set(), "complete");
  return specs.map((s) => resolveCitation(s.id, ctx));
}

const ONE = [{ id: "r-0000000000000001", text: RULING_TEXT }];

let root: string;
let sessionDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t494-lens-"));
  sessionDir = join(root, ".story", "sessions", "sess-1");
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "example.ts"), "export function greet() {}\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function diffOfSize(bytes: number): string {
  const head = [
    "diff --git a/src/example.ts b/src/example.ts",
    "--- a/src/example.ts",
    "+++ b/src/example.ts",
    "@@ -0,0 +1,1 @@",
  ].join("\n");
  return `${head}\n+${"a".repeat(Math.max(0, bytes - head.length - 2))}\n`;
}

/**
 * NOTE ON THE INFLATION LEVER, because it corrects a premise.
 *
 * The design argued the near-cap case was reachable because "a CODE_REVIEW
 * prompt embeds the diff". It does not embed an unbounded one:
 * `packageContext` caps each lens artifact at `TOKEN_BUDGET_PER_LENS` (32,000),
 * so no diff can push a prompt near `MAX_PROMPT_SIZE` (200,000). The
 * ticketDescription is passed through unbounded and is the lever that actually
 * reaches the cap, so it is what these tests inflate. The hazard is real; the
 * stated cause was wrong.
 */
function prepare(opts: { diff: string; citedRulings?: CitationResolution[]; ticket?: string; unavailable?: string }) {
  return handlePrepare({
    stage: "CODE_REVIEW",
    diff: opts.diff,
    changedFiles: ["src/example.ts"],
    ticketDescription: opts.ticket ?? "test ticket",
    reviewRound: 1,
    projectRoot: root,
    sessionDir,
    sessionId: "sess-1",
    ...(opts.citedRulings ? { citedRulings: opts.citedRulings } : {}),
    ...(opts.unavailable ? { citedRulingsUnavailable: opts.unavailable } : {}),
  });
}

const MAX_PROMPT_SIZE = 200_000;

/**
 * The lens with the LONGEST prompt. Lens preambles differ in length (security
 * is roughly 2,200 characters wider than clean-code), so a size taken from
 * lens 0 leaves a wider lens over the cap and truncated by the pre-existing
 * path -- a failure that has nothing to do with the mutant a test is aimed at.
 */
function widestLens(): string {
  const probe = prepare({ diff: diffOfSize(200), ticket: "t" });
  return probe.lensPrompts.reduce((a, b) => (b.prompt.length > a.prompt.length ? b : a)).lens;
}

/**
 * A ticketDescription that lands the WIDEST lens prompt `slack` characters
 * below the cap.
 *
 * The slope is MEASURED, not assumed: the description is embedded in a lens
 * prompt more than once (1,000 characters of description grow the prompt by
 * 2,000), while the projectRules that carry the rulings block are embedded
 * once. Taking both as 1x put an earlier version of these tests over the cap.
 */
function ticketForSlack(slack: number): string {
  const widest = (o: ReturnType<typeof prepare>) =>
    Math.max(...o.lensPrompts.map((p) => p.prompt.length));
  const small = widest(prepare({ diff: diffOfSize(200), ticket: "t" }));
  const large = widest(prepare({ diff: diffOfSize(200), ticket: "t".repeat(1_001) }));
  const slope = (large - small) / 1_000;
  const intercept = small - slope;
  return "t".repeat(Math.max(1, Math.floor((MAX_PROMPT_SIZE - slack - intercept) / slope)));
}

describe("delivery to a lens", () => {
  it("puts the cited ruling in every active lens's prompt", () => {
    const out = prepare({ diff: diffOfSize(200), citedRulings: citations(ONE) });
    for (const p of out.lensPrompts) {
      expect(p.prompt).toContain("## Cited Rulings");
      expect(p.prompt).toContain("r-0000000000000001");
      expect(p.prompt).toContain(RULING_TEXT);
      expect(p.omittedCitedRulings).toBeUndefined();
    }
    expect(out.metadata.citedRulingsUndelivered).toEqual({});
  });

  it("keeps the metadata tier and marks the text when capacity cannot carry it", () => {
    // Truncation is a CAPACITY outcome, so this drives it with capacity.
    const ticket = ticketForSlack(2_000);
    const out = prepare({
      diff: diffOfSize(200),
      ticket,
      citedRulings: citations([{ id: "r-0000000000000001", text: "y".repeat(3_500) }]),
    });
    const p = out.lensPrompts.find((q) => q.lens === widestLens())!;
    expect(p.prompt).toContain("[text truncated, read with ruling_get r-0000000000000001]");
    expect(p.prompt).toContain("owner-direct");
    expect(p.prompt).toContain("2026-08-27");
    expect(p.omittedCitedRulings).toEqual(["r-0000000000000001"]);
  });

  it("delivers a LONG ruling whole when there is room, so the hold can clear", () => {
    // THE REGRESSION THIS PINS, and it is the reason the allowance is derived
    // from capacity rather than fixed. With a constant 3,000-character ceiling
    // this 3,500-character ruling was truncated no matter how empty the prompt
    // was, its id was reported undelivered, and the resulting nextActions entry
    // refused the review PERMANENTLY: the instruction it carries is to shrink
    // the artifact and rerun, and shrinking the artifact cannot move a
    // constant. A gate whose clearing condition is unreachable is not a gate.
    const text = "y".repeat(3_500);
    const out = prepare({
      diff: diffOfSize(200),
      citedRulings: citations([{ id: "r-0000000000000001", text }]),
    });
    for (const p of out.lensPrompts) {
      expect(p.prompt).toContain(text);
      expect(p.omittedCitedRulings).toBeUndefined();
    }
    expect(out.metadata.citedRulingsUndelivered).toEqual({});
  });

  it("delivers a ruling far above any fixed allowance when capacity allows", () => {
    // 60,000 characters is above every allowance this design tried before
    // capacity itself: the 3,000 constant, and the quarter-of-remaining that
    // replaced it (bounded by the cap at 50,000). Under either, this ruling was
    // reported undelivered FOREVER, because shrinking the artifact raises
    // remaining capacity and can never raise a ceiling the cap already bounds.
    const text = "y".repeat(60_000);
    const out = prepare({
      diff: diffOfSize(200),
      citedRulings: citations([{ id: "r-0000000000000001", text }]),
    });
    for (const p of out.lensPrompts) {
      expect(p.prompt).toContain(text);
      expect(p.prompt.length).toBeLessThanOrEqual(MAX_PROMPT_SIZE);
      expect(p.omittedCitedRulings).toBeUndefined();
    }
    expect(out.metadata.citedRulingsUndelivered).toEqual({});

    // And the consequence that matters: synthesis holds nothing.
    const held = synth({ undelivered: out.metadata.citedRulingsUndelivered });
    expect(held.reviewVerdict.nextActions).toEqual([]);
    expect(held.reviewVerdict.verdict).toBe("approve");
  });

  it("still truncates when the text exceeds what the prompt actually has", () => {
    // The other side of the same rule: the budget is real capacity, not an
    // unbounded one. 60,000 characters against a prompt with 2,000 to spare is
    // a genuine capacity failure, and reporting it is correct.
    const out = prepare({
      diff: diffOfSize(200),
      ticket: ticketForSlack(2_000),
      citedRulings: citations([{ id: "r-0000000000000001", text: "y".repeat(60_000) }]),
    });
    const p = out.lensPrompts.find((q) => q.lens === widestLens())!;
    expect(p.prompt.length).toBeLessThanOrEqual(MAX_PROMPT_SIZE);
    expect(p.omittedCitedRulings).toEqual(["r-0000000000000001"]);
  });

  it("clears the omission for the SAME ruling once the artifact shrinks", () => {
    // The retry instruction says to reduce what is supplied per review and
    // rerun. This is that instruction actually working, on one unchanged
    // ruling: held under a large ticket, delivered under a small one.
    const long = citations([{ id: "r-0000000000000001", text: "y".repeat(3_500) }]);
    const widest = widestLens();

    const held = prepare({
      diff: diffOfSize(200),
      ticket: ticketForSlack(2_000),
      citedRulings: long,
    });
    expect(held.lensPrompts.find((p) => p.lens === widest)!.omittedCitedRulings).toEqual([
      "r-0000000000000001",
    ]);

    const cleared = prepare({ diff: diffOfSize(200), ticket: "small", citedRulings: long });
    expect(cleared.lensPrompts.find((p) => p.lens === widest)!.omittedCitedRulings).toBeUndefined();
    expect(cleared.metadata.citedRulingsUndelivered).toEqual({});
  });
});

describe("capacity: the block is fitted to what is LEFT, and the fit is asserted", () => {
  it("near the cap, still delivers the METADATA tier rather than falling back to base", () => {
    // The discriminator, and the reason this is not merely a non-empty check.
    // The mutant budgets against the 200,000 cap instead of against REMAINING
    // capacity, so it renders the full ruling text, overshoots, trips the
    // assert, and falls back to the base prompt -- delivering the citation to
    // nobody. Correct behaviour truncates the TEXT and keeps the block, so the
    // reviewer still learns the ruling exists and how to read it. A non-empty
    // assertion passes under BOTH, which is why this one names the block.
    //
    // The sizes are what separate the two outcomes: 1,000 characters of
    // headroom against a ruling text of 900 fits only once the text is
    // truncated, and does not fit at all under a cap-sized budget.
    // The boundary assertion is made on the WIDEST lens, because the ticket is
    // sized to put that one 1,000 from the cap and the narrower lenses sit
    // thousands of characters further back with room for the full text. Their
    // job here is to show the block still reaches them.
    const widest = widestLens();
    const ticket = ticketForSlack(1_000);
    const long = [{ id: "r-0000000000000001", text: "y".repeat(900) }];
    const out = prepare({ diff: diffOfSize(200), ticket, citedRulings: citations(long) });

    const p = out.lensPrompts.find((q) => q.lens === widest)!;
    expect(p.promptTruncated).toBe(false);
    expect(p.prompt).toContain("[text truncated, read with ruling_get r-0000000000000001]");
    expect(p.omittedCitedRulings).toEqual(["r-0000000000000001"]);

    for (const q of out.lensPrompts) {
      expect(q.prompt).toContain("## Cited Rulings");
      expect(q.prompt.length).toBeLessThanOrEqual(MAX_PROMPT_SIZE);
    }
  });

  it("never exceeds MAX_PROMPT_SIZE on any path, asserted directly", () => {
    for (const slack of [100_000, 5_000, 1_000, 300, 50, -500]) {
      const ticket = ticketForSlack(slack);
      const out = prepare({ diff: diffOfSize(200), ticket, citedRulings: citations(ONE) });
      for (const p of out.lensPrompts) {
        if (p.promptTruncated) continue; // pre-existing ISS-1134 path, not this feature's
        expect(p.prompt.length).toBeLessThanOrEqual(MAX_PROMPT_SIZE);
      }
    }
  });

  it("delivers the BASE prompt unchanged and reports every id when not even the metadata floor fits", () => {
    // This feature never empties a prompt that would otherwise have gone out.
    const ticket = ticketForSlack(20);
    const withRulings = prepare({ diff: diffOfSize(200), ticket, citedRulings: citations(ONE) });
    const bareAgain = prepare({ diff: diffOfSize(200), ticket });

    const p = withRulings.lensPrompts[0]!;
    const q = bareAgain.lensPrompts[0]!;
    expect(p.prompt).toBe(q.prompt);
    expect(p.omittedCitedRulings).toEqual(["r-0000000000000001"]);
  });
});

describe("the cache key answers for the rulings", () => {
  it("misses when the SAME artifact carries DIFFERENT cited rulings", () => {
    // Without the rulings in the key, run 2 serves run 1's prompt and the
    // second ruling never reaches a lens, silently.
    const first = prepare({ diff: diffOfSize(200), citedRulings: citations(ONE) });
    const lens = first.lensPrompts[0]!.lens;
    const meta = JSON.parse(readFileSync(join(sessionDir, "lens-harness-meta.json"), "utf-8"));
    writeToCache(sessionDir, meta.cacheKeys[lens], []);

    const same = prepare({ diff: diffOfSize(200), citedRulings: citations(ONE) });
    expect(same.lensPrompts.find((p) => p.lens === lens)!.cached).toBe(true);

    const other = prepare({
      diff: diffOfSize(200),
      citedRulings: citations([{ id: "r-0000000000000002", text: "A different ruling." }]),
    });
    const p = other.lensPrompts.find((q) => q.lens === lens)!;
    expect(p.cached).toBeFalsy();
    expect(p.prompt).toContain("r-0000000000000002");
  });

  it("misses when an item that cited NOTHING becomes an item nothing is known about", () => {
    // Both rounds render an EMPTY rulings block, so the note is the only thing
    // that can separate their cache identities. Seeding from a round that cited
    // something instead would miss on the block alone and prove nothing about
    // the note -- the first version of this test did exactly that, and the
    // mutant that drops the note from the fingerprint survived it.
    const first = prepare({ diff: diffOfSize(200) });
    const lens = first.lensPrompts[0]!.lens;
    const meta = JSON.parse(readFileSync(join(sessionDir, "lens-harness-meta.json"), "utf-8"));
    writeToCache(sessionDir, meta.cacheKeys[lens], []);

    // Without this the test could pass on a cache that was never seeded.
    const same = prepare({ diff: diffOfSize(200) });
    expect(same.lensPrompts.find((p) => p.lens === lens)!.cached).toBe(true);

    const lost = prepare({ diff: diffOfSize(200), unavailable: "the ledger could not be read" });
    const p = lost.lensPrompts.find((q) => q.lens === lens)!;
    expect(p.cached).toBeFalsy();
    expect(p.prompt).toContain("## Cited Rulings: NOT AVAILABLE");
  });
});

describe("an item whose citations could not be resolved", () => {
  it("says so in EVERY lens prompt, under its own heading", () => {
    const out = prepare({ diff: diffOfSize(200), unavailable: "T-9 could not be resolved" });
    for (const p of out.lensPrompts) {
      expect(p.prompt).toContain("## Cited Rulings: NOT AVAILABLE");
      expect(p.prompt).toContain("T-9 could not be resolved");
      expect(p.prompt).toContain("do not read the absence of a rulings block as an absence of rulings");
    }
    expect(out.metadata.citedRulingsUnavailable).toBe("T-9 could not be resolved");
  });

  it("does NOT hold the verdict, because no rerun of the lens can fetch what is not there", () => {
    // The contrast that makes the distinction real: an UNDELIVERED ruling holds
    // (a shrunk artifact delivers it); an UNRESOLVABLE item discloses only.
    const out = prepare({ diff: diffOfSize(200), unavailable: "the ledger could not be read" });
    expect(out.metadata.citedRulingsUndelivered).toEqual({});
    for (const p of out.lensPrompts) expect(p.omittedCitedRulings).toBeUndefined();
  });

});

describe("the fit is computed BEFORE the cache early return", () => {
  it("reports the omission for a lens served from CACHE", () => {
    // Injection at synthesis preserves a finding that EXISTS; it does not make
    // one exist. The capacity check lives in prompt construction, so a fit
    // computed after the cache `continue` would never detect an omission on a
    // cached lens and there would be nothing to preserve.
    const ticket = ticketForSlack(20);
    const diff = diffOfSize(200);

    const first = prepare({ diff, ticket, citedRulings: citations(ONE) });
    const lens = first.lensPrompts[0]!.lens;
    // Seed the cache under the exact key this run minted.
    const meta = JSON.parse(readFileSync(join(sessionDir, "lens-harness-meta.json"), "utf-8"));
    writeToCache(sessionDir, meta.cacheKeys[lens], []);

    const second = prepare({ diff, ticket, citedRulings: citations(ONE) });
    const cached = second.lensPrompts.find((p) => p.lens === lens)!;
    expect(cached.cached).toBe(true);
    expect(cached.omittedCitedRulings).toEqual(["r-0000000000000001"]);
    expect(second.metadata.citedRulingsUndelivered[lens]).toEqual(["r-0000000000000001"]);
  });
});

/**
 * THE ENFORCEMENT HALF.
 *
 * These drive the REAL `runMergerPipeline` and the REAL `ReviewVerdictSchema`
 * out of the installed package, never a mock, because the claim under test is a
 * claim about that package's behaviour and an earlier revision of this design
 * got it wrong by reading documentation instead.
 */
const CORE = ["security", "error-handling", "clean-code", "concurrency"] as const;
const OK = { status: "ok", findings: [], error: null, notes: null };

/**
 * `undelivered` goes in through the CALLER metadata; `persisted` goes in
 * through the on-disk HarnessMeta that `prepare` writes. They are separate
 * parameters because the live MCP path passes NO metadata at all, so the
 * persisted record is the only source in production and a test that only ever
 * uses the caller path is not testing the shipped route.
 */
function synth(opts: {
  undelivered?: Record<string, readonly string[]>;
  persisted?: Record<string, readonly string[]>;
  reviewRound?: number;
  cacheKeys?: Record<string, string>;
  findings?: Record<string, unknown[]>;
  /** Lenses that produced NO output at all, so `parsed` has no entry for them. */
  omitLenses?: readonly string[];
}) {
  if (opts.cacheKeys || opts.persisted) {
    writeFileSync(
      join(sessionDir, "lens-harness-meta.json"),
      JSON.stringify({
        reviewId: "lens-t494",
        cacheKeys: opts.cacheKeys ?? {},
        ...(opts.persisted ? { citedRulingsUndelivered: opts.persisted } : {}),
      }),
    );
  }
  return handleSynthesize({
    stage: "CODE_REVIEW",
    lensResults: CORE.filter((lens) => !(opts.omitLenses ?? []).includes(lens)).map((lens) => ({
      lens,
      output: opts.findings?.[lens] ? { ...OK, findings: opts.findings[lens] } : OK,
    })),
    metadata: {
      activeLenses: [...CORE],
      skippedLenses: ["performance", "test-quality"],
      reviewRound: opts.reviewRound ?? 1,
      reviewId: "lens-t494",
      ...(opts.undelivered ? { citedRulingsUndelivered: opts.undelivered } : {}),
    },
    sessionDir,
    sessionId: "sess-1",
    projectRoot: root,
    diff: diffOfSize(200),
    changedFiles: ["src/example.ts"],
  });
}

describe("undelivered rulings hold the verdict", () => {
  it("emits a nextActions entry per affected lens and refuses approve", () => {
    const out = synth({ undelivered: { security: ["r-0000000000000001"] } });
    expect(out.reviewVerdict.nextActions.map((a) => a.lensId)).toEqual(["security"]);
    expect(out.reviewVerdict.verdict).not.toBe("approve");
  });

  it("emits NOTHING when every lens received its rulings", () => {
    // Without this, a mutant that emits unconditionally still passes the test
    // above, and every review would be held forever.
    const out = synth({ undelivered: { security: [] } });
    expect(out.reviewVerdict.nextActions).toEqual([]);
    expect(out.reviewVerdict.verdict).toBe("approve");
  });

  it("survives the REAL ReviewVerdictSchema on a FIRST round (attempt floor of 2)", () => {
    // `attempt` is z.number().int().min(2). Passing reviewRound straight
    // through is 1 on a first round, and the parse would THROW -- on the very
    // first delivery failure, not a rare one.
    const out = synth({ undelivered: { security: ["r-0000000000000001"] }, reviewRound: 1 });
    expect(out.reviewVerdict.nextActions[0]!.attempt).toBeGreaterThanOrEqual(2);
    expect(() => ReviewVerdictSchema.parse(out.reviewVerdict)).not.toThrow();
  });

  it("names the lens, the ids, and the condition that CLEARS the hold", () => {
    const out = synth({ undelivered: { security: ["r-0000000000000001"] } });
    const prompt = out.reviewVerdict.nextActions[0]!.retryPrompt;
    expect(prompt).toContain("security");
    expect(prompt).toContain("r-0000000000000001");
    // Retention is the load-bearing word: "reduce scope and re-run" is
    // satisfiable by deleting the citations, which clears the signal by
    // removing the thing it protects.
    expect(prompt).toMatch(/RETAINING|retain/);
    expect(prompt).toContain("no undelivered cited rulings");
  });

  it("carries the report as a finding as well as the hold", () => {
    const out = synth({ undelivered: { security: ["r-0000000000000001"] } });
    const ids = out.reviewVerdict.findings.map((f) => f.id);
    expect(ids).toContain(CITED_RULINGS_META_FINDING_ID);
  });

  it("still refuses approve under neverBlock: [\"security\"], which demotes the finding", () => {
    // This is the configuration the earlier severity-based design would have
    // PASSED under while delivering nothing. The hold comes from nextActions,
    // which no blocking policy can demote.
    mkdirSync(join(root, ".story"), { recursive: true });
    writeFileSync(
      join(root, ".story", "config.json"),
      JSON.stringify({ recipeOverrides: { blockingPolicy: { neverBlock: ["security"] } } }),
    );
    const out = synth({ undelivered: { security: ["r-0000000000000001"] } });
    expect(out.reviewVerdict.verdict).not.toBe("approve");
    expect(out.reviewVerdict.nextActions.map((a) => a.lensId)).toEqual(["security"]);
  });
});

describe("a review that missed its rulings is never cached", () => {
  it("suppresses write-back for the affected lens and keeps it for the others", () => {
    const keys = Object.fromEntries(CORE.map((l) => [l, `key-${l}`]));
    synth({ undelivered: { security: ["r-0000000000000001"] }, cacheKeys: keys });

    // The mutant that keeps the write-back lets a later same-key run serve
    // these findings from a reviewer that never saw the rulings, clearing the
    // omission with no lens re-run. That is the laundering path.
    expect(getFromCache(sessionDir, "key-security")).toBeNull();
    for (const lens of CORE.filter((l) => l !== "security")) {
      expect(getFromCache(sessionDir, `key-${lens}`)).not.toBeNull();
    }
  });
});

describe("the persisted delivery record cannot be erased by a caller", () => {
  it("holds the verdict on the PERSISTED record with no caller metadata at all", () => {
    // This is the shipped route: the MCP tool passes no citedRulingsUndelivered,
    // so everything rests on what prepare wrote to disk. Every other test in
    // this file went in through the caller field, which is not that route.
    const out = synth({ persisted: { security: ["r-0000000000000001"] } });
    expect(out.reviewVerdict.nextActions.map((a) => a.lensId)).toEqual(["security"]);
    expect(out.reviewVerdict.verdict).not.toBe("approve");
  });

  it("an EMPTY caller map does not clear a persisted failure", () => {
    // Precedence (`caller ?? persisted`) would take the empty map and approve
    // a review whose lens provably never received its rulings. The union can
    // only add a hold, which is the safe direction for a gate.
    const out = synth({ persisted: { security: ["r-0000000000000001"] }, undelivered: {} });
    expect(out.reviewVerdict.nextActions.map((a) => a.lensId)).toEqual(["security"]);
    expect(out.reviewVerdict.verdict).not.toBe("approve");
  });

  it("a PARTIAL caller map keeps the lenses it omits", () => {
    const out = synth({
      persisted: { security: ["r-0000000000000001"], "clean-code": ["r-0000000000000002"] },
      undelivered: { security: ["r-0000000000000001"] },
    });
    expect(out.reviewVerdict.nextActions.map((a) => a.lensId).sort()).toEqual([
      "clean-code",
      "security",
    ]);
  });

  it("unions the ids for a lens named by both, without duplicating one", () => {
    const out = synth({
      persisted: { security: ["r-0000000000000001"] },
      undelivered: { security: ["r-0000000000000001", "r-0000000000000002"] },
    });
    expect(out.reviewVerdict.nextActions).toHaveLength(1);
    const prompt = out.reviewVerdict.nextActions[0]!.retryPrompt;
    expect(prompt).toContain("r-0000000000000001");
    expect(prompt).toContain("r-0000000000000002");
    expect(prompt.match(/r-0000000000000001/g)).toHaveLength(1);
  });

  it("suppresses the write-back for a lens named ONLY by the persisted record", () => {
    synth({
      persisted: { security: ["r-0000000000000001"] },
      undelivered: {},
      cacheKeys: Object.fromEntries(CORE.map((l) => [l, `key-${l}`])),
    });
    expect(getFromCache(sessionDir, "key-security")).toBeNull();
  });
});

describe("the injected delivery finding never reaches the cache", () => {
  it("keeps it out of the SECURITY cache when another lens is the affected one", () => {
    // The finding is injected into `security` whichever lens missed its
    // rulings. So when the affected lens is error-handling, `security` is
    // itself cacheable and would store a blocking finding about a delivery
    // failure that is not its own -- and replay it after the failure clears.
    const keys = Object.fromEntries(CORE.map((l) => [l, `key-${l}`]));
    const out = synth({ undelivered: { "error-handling": ["r-0000000000000001"] }, cacheKeys: keys });
    expect(out.reviewVerdict.nextActions.map((a) => a.lensId)).toEqual(["error-handling"]);

    expect(getFromCache(sessionDir, "key-error-handling")).toBeNull();
    const cachedSecurity = getFromCache(sessionDir, "key-security");
    expect(cachedSecurity).not.toBeNull();
    expect(cachedSecurity!.map((f) => f.id)).not.toContain(CITED_RULINGS_META_FINDING_ID);
  });

  it("scrubs a replayed delivery finding so a CLEARED omission does not come back", () => {
    // Defense in depth for an entry written by an older build: a lens output
    // carrying the finding, with nothing undelivered this round, must not
    // report a delivery failure.
    const out = synth({
      findings: {
        security: [
          {
            id: CITED_RULINGS_META_FINDING_ID,
            severity: "blocking",
            category: "context-delivery",
            file: null,
            line: null,
            description: "stale replay from an older cache entry",
            suggestion: "should never survive",
            confidence: 1,
          },
        ],
      },
    });
    expect(out.reviewVerdict.findings.map((f) => f.id)).not.toContain(
      CITED_RULINGS_META_FINDING_ID,
    );
    expect(out.reviewVerdict.nextActions).toEqual([]);
    expect(out.reviewVerdict.verdict).toBe("approve");
  });
});

describe("the disclosure is FITTED, not concatenated past the cap", () => {
  it("keeps a near-cap prompt intact and reports the lens that could not carry the note", () => {
    // The regression this pins: the note used to be concatenated into
    // baseProjectRules by the caller, so it was inside the measurement rather
    // than subject to it -- and with no citations the fitter returns before the
    // assembled-length check, so a prompt just under the cap was pushed over it
    // by the disclosure alone and then EMPTIED by the pre-existing fail-to-zero
    // path. This feature must never cause total delivery failure.
    const ticket = ticketForSlack(20);
    const widest = widestLens();
    const out = prepare({ diff: diffOfSize(200), ticket, unavailable: "the ledger could not be read" });

    for (const p of out.lensPrompts) expect(p.prompt.length).toBeGreaterThan(0);
    expect(out.metadata.citedRulingsDisclosureUndelivered).toContain(widest);
    const w = out.lensPrompts.find((p) => p.lens === widest)!;
    expect(w.prompt).not.toContain("## Cited Rulings: NOT AVAILABLE");
    expect(w.prompt.length).toBeLessThanOrEqual(200_000);
  });

  it("reports NOTHING undelivered when every prompt has room for the note", () => {
    const out = prepare({ diff: diffOfSize(200), unavailable: "the ledger could not be read" });
    expect(out.metadata.citedRulingsDisclosureUndelivered).toBeUndefined();
  });
});

describe("a fabricated lens entry is never cached", () => {
  it("writes NO cache entry for a security lens that never ran", () => {
    // The hole: with error-handling undelivered and security absent, the
    // rulings meta-finding fabricates a security entry with status ok and
    // cached false. Security is not in `undelivered`, so the write-back used to
    // accept it, and filtering the injected finding out left an EMPTY findings
    // array -- a clean security review, cached, by a lens that never saw the
    // artifact. A later same-key run then approves on it.
    const out = synth({
      undelivered: { "error-handling": ["r-0000000000000001"] },
      omitLenses: ["security"],
      cacheKeys: { security: "key-security", "error-handling": "key-eh", "clean-code": "key-cc" },
    });
    expect(out.reviewVerdict.verdict).not.toBe("approve");
    expect(getFromCache(sessionDir, "key-security")).toBeNull();
    // The contrast: a lens that DID run and was not affected still caches, so
    // this is not a mutant that simply disabled the write-back.
    expect(getFromCache(sessionDir, "key-cc")).not.toBeNull();
  });
});
