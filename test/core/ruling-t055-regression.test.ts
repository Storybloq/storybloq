import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { writeRulingUnlocked, loadCitationContext } from "../../src/core/ruling-loader.js";
import { resolveEntityCitations, renderCitation } from "../../src/core/ruling.js";
import { formatCitedRulingsSection } from "../../src/core/output-formatter.js";
import { handleTicketGet } from "../../src/cli/commands/ticket.js";
import { makeState, makeTicket } from "./test-factories.js";
import type { CommandContext } from "../../src/cli/run.js";

function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    state: makeState(),
    warnings: [],
    root: "/tmp/test",
    handoversDir: "/tmp/test/.story/handovers",
    format: "md",
    ...overrides,
  };
}

/**
 * T-476 acceptance criterion 4: "The T-055-style incident is
 * reproducible-then-fixed in a test: a stale restatement cannot occur
 * because the surface renders the live chain."
 *
 * The incident (agentkit-rn T-055/N-012, quoted in this ticket's own
 * filing): a gate's text RESTATED an owner requirement -- copied the
 * owner's words into the gate's own description at write time. When the
 * owner later issued a superseding ruling, the restatement had no way to
 * know: it was a frozen string, not a pointer. The gate and the ledger
 * diverged from itself, and nothing detected it.
 *
 * This test reproduces that shape (a frozen restatement DOES go stale --
 * that is not a bug, it is what "restatement" means) and then proves the
 * fix: a citing item that references the ruling BY ID, resolved at read
 * time through the exact function every instruction-builder site
 * (pick-ticket.ts, guide.ts, issue-fix.ts, issue-sweep.ts) calls, always
 * renders the CURRENT chain -- so the same incident is structurally
 * impossible for anything built on `citesRulings` + `resolveEntityCitations`.
 */

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function newRulingsProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "t055-regression-"));
  tmpDirs.push(dir);
  return dir;
}

const OWNER_REQUIREMENT_V1 =
  "The 08-14 rollout gate requires two-key sign-off before any irreversible deploy.";
const OWNER_REQUIREMENT_V2 =
  "SUPERSEDED 08-22: the two-key rule now also covers rollback actions, not just forward deploys.";

describe("T-476 acceptance 4: T-055-style stale restatement, reproduced then fixed", () => {
  it("REPRODUCTION: a frozen restatement of the owner's requirement does not update when the requirement changes", async () => {
    // This is the failure mode itself, not code under test: a gate's
    // description PARAPHRASED the owner's ruling at write time, exactly as
    // T-055's gate text did. The string is created once and never revisited.
    const gateDescriptionWrittenAtCreationTime = `Gate requirement (as of filing): ${OWNER_REQUIREMENT_V1}`;

    // The owner later supersedes the requirement -- V2 is now the only
    // authoritative text. But the restatement above is just a string sitting
    // in a JSON file; nothing re-derives it, so it still reads V1 forever.
    expect(gateDescriptionWrittenAtCreationTime).toContain(OWNER_REQUIREMENT_V1);
    expect(gateDescriptionWrittenAtCreationTime).not.toContain(OWNER_REQUIREMENT_V2);
    // This is the divergence T-055/N-012 hit: the gate and the ledger now
    // disagree, and nothing in the gate's own text can tell you that.
  });

  it("FIX: an item that cites the ruling by id renders the CURRENT text after supersession, through the same resolver every instruction-builder site uses", async () => {
    const dir = await newRulingsProject();
    await writeRulingUnlocked(
      {
        id: "r-0000000000000az9",
        text: OWNER_REQUIREMENT_V1,
        attribution: "owner-direct",
        recordedBy: { client: "claude", id: "field-session-1" },
        date: "2026-08-14",
        scopeTags: ["rollout-gate"],
        supersedes: null,
      },
      dir,
      { createOnly: true },
    );

    // Instead of restating the requirement, the gate CITES it.
    const gateDescription = "Gate requirement: see cited ruling.";
    const citesRulings = ["r-0000000000000az9"];

    // Read #1, before the owner changes anything: current == what was cited.
    const beforeCtx = loadCitationContext(dir);
    const before = resolveEntityCitations({ id: "gate-1", citesRulings }, beforeCtx);
    expect(before).toHaveLength(1);
    const beforeRendered = renderCitation(before[0]!);
    expect(beforeRendered.status).toBe("resolved");
    expect(beforeRendered.current?.text).toBe(OWNER_REQUIREMENT_V1);

    // The owner now supersedes the ruling -- the exact moment T-055's
    // restatement went stale without anyone knowing.
    await writeRulingUnlocked(
      {
        id: "r-0000000000000az8",
        text: OWNER_REQUIREMENT_V2,
        attribution: "owner-direct",
        recordedBy: { client: "claude", id: "field-session-2" },
        date: "2026-08-22",
        scopeTags: ["rollout-gate"],
        supersedes: "r-0000000000000az9",
      },
      dir,
      { createOnly: true },
    );

    // Read #2, after supersession, with NO edit to the gate's own JSON --
    // this is the point: the citing item is untouched, only the ruling
    // chain moved.
    const afterCtx = loadCitationContext(dir);
    const after = resolveEntityCitations({ id: "gate-1", citesRulings }, afterCtx);
    const afterRendered = renderCitation(after[0]!);
    expect(afterRendered.status).toBe("resolved");
    expect(afterRendered.stale).toBe(true);
    expect(afterRendered.current?.text).toBe(OWNER_REQUIREMENT_V2);
    expect(afterRendered.current?.text).not.toBe(OWNER_REQUIREMENT_V1);

    // The rendered markdown block -- the exact string every
    // instruction-builder site (pick-ticket.ts, guide.ts, issue-fix.ts,
    // issue-sweep.ts) splices into an agent's instruction -- also carries
    // the CURRENT text and says explicitly that it superseded the cited one.
    const section = formatCitedRulingsSection(after);
    expect(section).toContain(OWNER_REQUIREMENT_V2);
    expect(section).not.toContain(OWNER_REQUIREMENT_V1);
    expect(section).toContain("superseded by r-0000000000000az8");
  });

  it("FIX, end to end through an actual surface: handleTicketGet never re-emits a superseded citation's stale text", async () => {
    const dir = await newRulingsProject();
    await writeRulingUnlocked(
      {
        id: "r-0000000000000az9",
        text: OWNER_REQUIREMENT_V1,
        attribution: "owner-direct",
        recordedBy: { client: "claude", id: "field-session-1" },
        date: "2026-08-14",
        scopeTags: [],
        supersedes: null,
      },
      dir,
      { createOnly: true },
    );
    const ctxBefore = makeCtx({
      root: dir,
      state: makeState({ tickets: [makeTicket({ id: "T-001", citesRulings: ["r-0000000000000az9"] })] }),
    });
    const before = handleTicketGet("T-001", ctxBefore);
    expect(before.output).toContain(OWNER_REQUIREMENT_V1);

    await writeRulingUnlocked(
      {
        id: "r-0000000000000az8",
        text: OWNER_REQUIREMENT_V2,
        attribution: "owner-direct",
        recordedBy: { client: "claude", id: "field-session-2" },
        date: "2026-08-22",
        scopeTags: [],
        supersedes: "r-0000000000000az9",
      },
      dir,
      { createOnly: true },
    );
    // Same ticket, same citesRulings field, completely untouched -- only the
    // ruling ledger changed. A T-055-style restatement would still show V1.
    const ctxAfter = makeCtx({
      root: dir,
      state: makeState({ tickets: [makeTicket({ id: "T-001", citesRulings: ["r-0000000000000az9"] })] }),
    });
    const after = handleTicketGet("T-001", ctxAfter);
    expect(after.output).toContain(OWNER_REQUIREMENT_V2);
    expect(after.output).not.toContain(OWNER_REQUIREMENT_V1);
  });

  it("REGRESSION (codex round-1 finding): a superseding ruling sitting under a non-canonical filename must not let the OLD ruling render as falsely current", async () => {
    const dir = await newRulingsProject();
    await writeRulingUnlocked(
      {
        id: "r-0000000000000az9",
        text: OWNER_REQUIREMENT_V1,
        attribution: "owner-direct",
        recordedBy: { client: "claude", id: "field-session-1" },
        date: "2026-08-14",
        scopeTags: [],
        supersedes: null,
      },
      dir,
      { createOnly: true },
    );
    // The superseding ruling exists and is fully readable, but sits under a
    // filename that is not itself a canonical ruling-id shape (e.g. a manual
    // copy or an out-of-band write). Before the fix, this ruling vanished
    // from BOTH `rulings` and `unavailableIds`, so scanCompleteness stayed
    // "complete" and the old ruling resolved as falsely current.
    await mkdir(`${dir}/.story/rulings`, { recursive: true });
    await writeFile(
      `${dir}/.story/rulings/copy-of-superseding-ruling.json`,
      JSON.stringify({
        id: "r-0000000000000az8",
        text: OWNER_REQUIREMENT_V2,
        attribution: "owner-direct",
        recordedBy: { client: "claude", id: "field-session-2" },
        date: "2026-08-22",
        scopeTags: [],
        supersedes: "r-0000000000000az9",
        createdAt: null,
      }),
    );
    const ctx = makeCtx({
      root: dir,
      state: makeState({ tickets: [makeTicket({ id: "T-001", citesRulings: ["r-0000000000000az9"] })] }),
    });
    const result = handleTicketGet("T-001", ctx);
    const parsed = JSON.parse(handleTicketGet("T-001", makeCtx({ root: dir, format: "json", state: ctx.state })).output);
    // Never falsely "resolved -> current" -- the true successor is invisible
    // through the normal path, so the honest answer is "indeterminate".
    expect(parsed.data.citedRulings[0].status).toBe("indeterminate");
    expect(result.output).not.toContain(`Status: current`);
  });
});
