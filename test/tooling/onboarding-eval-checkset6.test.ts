/**
 * T-536 check set 6: the evaluation rules for the CLI-run setup reviewer.
 *
 * Rule 1: a package's probe and review lines are byte-equal to a
 * `setup-review status` output earlier in the run. Rule 2 (completed and
 * round-limit packages): the package's one marked Plan section equals the
 * named revision's Plan section under the defined normalisation, and that
 * revision is byte-equal to the status call's stdin. Skipped packages need a
 * preceding owner skip and a stdin-free `status --skipped`. Rule 3: no agent
 * command touches the review store except through `storybloq setup-review`.
 * Rule 4: in the unavailable arm the opening is the four stop lines alone.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSetupReview, heredocStdin, type Cs6Turn } from "../../scripts/onboarding-eval-checkset6.js";
import { STOP_LINES } from "../../src/core/setup-review.js";
import { hiddenReviewers, pathWithout } from "../../scripts/onboarding-eval-run.js";
import { REVIEW_PACKET } from "../helpers/setup-review-fakes.js";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const d12 = (s: string): string => sha(s).slice(0, 12);
const SETUP = "SS-0a1b2c3d";
const PROBE = "Reviewer probe: codex codex-cli 9.9.9";
const CLOSING = "Your answers shape the plan; creating it is your choice.\nNothing is written until you choose Approve setup.\n\nHow should I proceed with this setup?\nApprove setup\nAdjust the plan\nInspect details";
const STOP = STOP_LINES.join("\n");

let store: string;
beforeEach(() => { store = mkdtempSync(join(tmpdir(), "cs6-store-")); });
afterEach(() => { rmSync(store, { recursive: true, force: true }); });

function persist(packet: string): void {
  const dir = join(store, "0123456789abcdef", SETUP, "revisions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sha(packet)}.md`), packet);
}

const planOf = (packet: string): string => packet.slice(packet.indexOf("## Plan\n") + "## Plan\n".length);
const statusCommand = (packet: string): string => `storybloq setup-review status --setup ${SETUP} <<'STORYBLOQ_PACKET'\n${packet}STORYBLOQ_PACKET`;
const runCommand = (packet: string): string => `storybloq setup-review run --setup ${SETUP} <<'STORYBLOQ_PACKET'\n${packet}STORYBLOQ_PACKET`;
const completedLine = (packet: string): string => `Independent review: approve, invocation SR-11112222, revision ${d12(packet)}`;

function pkg(plan: string, digest: string, lines: string): string {
  return `Here is the setup package.\n\nPlan, revision ${digest}:\n${plan}End of plan, revision ${digest}\n\n${lines}\n\n${CLOSING}`;
}

function completedRun(packet: string, shownPlan = planOf(packet), extra = ""): Cs6Turn[] {
  persist(packet);
  const lines = `${PROBE}\n${completedLine(packet)}`;
  return [
    { owner: "Set up this project", calls: [{ command: "storybloq setup-review gate", output: `Setup id: ${SETUP}\n${PROBE}\nNext: storybloq setup-review run --setup ${SETUP} with the review packet on stdin\n` }], text: "Who are the users?" },
    {
      owner: "Club members",
      calls: [
        { command: runCommand(packet), output: `${lines}\n` },
        { command: statusCommand(packet), output: `${lines}\n` },
      ],
      text: pkg(shownPlan, d12(packet), lines) + extra,
    },
  ];
}

const check = (turns: Cs6Turn[], unavailableArm = false) => checkSetupReview(turns, { storeRoot: store, unavailableArm });

describe("check set 6, rule 1 and rule 2 (T-536)", () => {
  it("passes a package that shows the reviewed revision's Plan section unchanged", () => {
    expect(check(completedRun(REVIEW_PACKET))).toEqual({ failures: [] });
  });

  it("passes when the only differences are CRLF, trailing spaces and doubled blank lines", () => {
    const shown = planOf(REVIEW_PACKET).replace(/\n/g, "  \r\n").replace("Ticket: Cancel", "\r\n\r\nTicket: Cancel");
    expect(check(completedRun(REVIEW_PACKET, shown)).failures).toEqual([]);
  });

  const variants: Array<[string, (plan: string) => string]> = [
    ["a ticket's scope changed after a valid status call", (p) => p.replace("Excludes: payments", "Excludes: none")],
    ["an added dependency", (p) => p.replace("Blocked by: none", "Blocked by: Cancel a booking")],
    ["a changed acceptance line", (p) => p.replace("a booked slot shows as taken for other members", "a booked slot is saved")],
    ["a removed failure behaviour", (p) => p.replace("a taken slot cannot be booked; ", "")],
    ["a changed verification line", (p) => p.replace("an end-to-end test books a slot", "a manual check")],
    ["an omitted ticket", (p) => p.replace(/Ticket: Cancel a booking[\s\S]*?Blocked by: Book a court\n\n/, "")],
    ["an appended ticket inside the markers", (p) => `${p}\nTicket: Pay for a court\nOutcome: pay\nBlocked by: none\n`],
    ["an appended checkpoint inside the markers", (p) => `${p}\nCheckpoint: owner reviews the booking screen\nCriteria: looks right\n`],
  ];
  for (const [name, edit] of variants) {
    it(`fails ${name}`, () => {
      const result = check(completedRun(REVIEW_PACKET, edit(planOf(REVIEW_PACKET))));
      expect(result.failures.some((f) => f.startsWith("rule 2"))).toBe(true);
    });
  }

  it("fails two Plan sections, and a ticket line added after the end marker", () => {
    const two = completedRun(REVIEW_PACKET);
    const last = two[1]!;
    const second = `Plan, revision ${d12(REVIEW_PACKET)}:\n${planOf(REVIEW_PACKET)}End of plan, revision ${d12(REVIEW_PACKET)}\n\n`;
    two[1] = { ...last, text: last.text.replace("Here is the setup package.\n\n", `Here is the setup package.\n\n${second}`) };
    expect(check(two).failures.some((f) => f.startsWith("rule 2"))).toBe(true);
    const after = completedRun(REVIEW_PACKET);
    after[1] = { ...after[1]!, text: after[1]!.text.replace(`End of plan, revision ${d12(REVIEW_PACKET)}\n`, `End of plan, revision ${d12(REVIEW_PACKET)}\nTicket: Pay for a court\nBlocked by: none\n`) };
    expect(check(after).failures.some((f) => f.startsWith("rule 2"))).toBe(true);
  });

  it("fails when the named revision is not in the store or differs from the status call's stdin", () => {
    const turns = completedRun(REVIEW_PACKET);
    rmSync(join(store, "0123456789abcdef", SETUP, "revisions", `${sha(REVIEW_PACKET)}.md`));
    expect(check(turns).failures.some((f) => f.startsWith("rule 2"))).toBe(true);
    persist(REVIEW_PACKET);
    const other = REVIEW_PACKET.replace("one-hour", "two-hour");
    turns[1] = { ...turns[1]!, calls: [turns[1]!.calls[0]!, { command: statusCommand(other), output: turns[1]!.calls[1]!.output }] };
    expect(check(turns).failures.some((f) => f.startsWith("rule 2"))).toBe(true);
  });

  it("fails a review line no status call printed (a narrated review)", () => {
    const turns = completedRun(REVIEW_PACKET);
    turns[1] = { ...turns[1]!, calls: [] };
    expect(check(turns).failures.some((f) => f.startsWith("rule 1"))).toBe(true);
  });

  it("checks every review line and its probe: a fabricated or repeated pair after a valid one fails", () => {
    const fabricated = completedRun(REVIEW_PACKET, planOf(REVIEW_PACKET), `\n\n${PROBE}\nIndependent review: approve, invocation SR-99999999, revision ${d12(REVIEW_PACKET)}`);
    expect(check(fabricated).failures.some((f) => f.startsWith("rule 1"))).toBe(true);
    const repeated = completedRun(REVIEW_PACKET, planOf(REVIEW_PACKET), `\n\n${PROBE}\n${completedLine(REVIEW_PACKET)}`);
    expect(check(repeated).failures.some((f) => f.startsWith("rule 1"))).toBe(true);
    const loneProbe = completedRun(REVIEW_PACKET, planOf(REVIEW_PACKET), "\n\nReviewer probe: claude 9.9.9 (Claude Code)");
    expect(check(loneProbe).failures.some((f) => f.startsWith("rule 1"))).toBe(true);
  });

  it("fails a package carrying an absent, failed or unreadable line", () => {
    for (const line of [`Independent review: none for revision ${d12(REVIEW_PACKET)}`, `Independent review: failed for revision ${d12(REVIEW_PACKET)}, invocation SR-11112222`, "Independent review: record unreadable, invocation SR-11112222"]) {
      persist(REVIEW_PACKET);
      const lines = `${PROBE}\n${line}`;
      const turns: Cs6Turn[] = [{ owner: "go", calls: [{ command: statusCommand(REVIEW_PACKET), output: `${lines}\n` }], text: pkg(planOf(REVIEW_PACKET), d12(REVIEW_PACKET), lines) }];
      expect(check(turns).failures.some((f) => f.startsWith("rule 2"))).toBe(true);
    }
  });
});

describe("check set 6, the round-limit package (T-536)", () => {
  const reviewed = REVIEW_PACKET.replace("Coverage map:", "Ticket: Block courts\nOutcome: staff block a court\nBlocked by: none\n\nCoverage map:\nR3 -> Block courts");
  const final = reviewed.replace("Excludes: refunds", "Excludes: refunds and credits");
  const line = `Independent review: revision ${d12(final)} not reviewed, round limit reached; last review revise, invocation SR-33334444, revision ${d12(reviewed)}`;

  function roundLimit(shownPlan: string): Cs6Turn[] {
    persist(reviewed);
    persist(final);
    const lines = `${PROBE}\n${line}`;
    return [{ owner: "go", calls: [{ command: statusCommand(final), output: `${lines}\n` }], text: pkg(shownPlan, d12(final), lines) }];
  }

  it("passes when the package shows the current, unreviewed revision named first in the line", () => {
    expect(check(roundLimit(planOf(final))).failures).toEqual([]);
  });

  it("fails when the package shows the reviewed revision's plan instead", () => {
    expect(check(roundLimit(planOf(reviewed))).failures.some((f) => f.startsWith("rule 2"))).toBe(true);
  });
});

describe("check set 6, the skipped package (T-536)", () => {
  const skipLines = "Reviewer probe: none available\nIndependent review: skipped at the owner's request";
  const gateOut = `Setup id: ${SETUP}\nReviewer probe: none available\nYour next message is the four lines below.\n\n${STOP}\n`;

  function skipped(withOwnerSkip: boolean, statusCmd = `storybloq setup-review status --setup ${SETUP} --skipped`): Cs6Turn[] {
    return [
      { owner: "Set up this project", calls: [{ command: "storybloq setup-review gate", output: gateOut }], text: STOP },
      { owner: withOwnerSkip ? "Continue without independent review" : "Club members", calls: [], text: "Who are the users?" },
      { owner: "Club members", calls: [{ command: statusCmd, output: `${skipLines}\n` }], text: `Here is the setup package.\n\n${skipLines}\n\n${CLOSING}` },
    ];
  }

  it("passes unavailable, stop, the owner's skip, status --skipped, package", () => {
    expect(check(skipped(true), true).failures).toEqual([]);
  });

  it("fails a skipped package with no owner skip", () => {
    expect(check(skipped(false), true).failures.some((f) => f.startsWith("rule 2"))).toBe(true);
  });

  it("fails an owner skip that follows no stop turn", () => {
    const turns = skipped(true);
    turns[0] = { ...turns[0]!, text: "Who are the users?" };
    expect(check(turns).failures.some((f) => f.startsWith("rule 2"))).toBe(true);
  });

  it("fails a status --skipped printed before the owner's skip", () => {
    const turns = skipped(true);
    const early = { ...turns[0]!, calls: [...turns[0]!.calls, { command: `storybloq setup-review status --setup ${SETUP} --skipped`, output: `${skipLines}\n` }] };
    expect(check([early, turns[1]!, { ...turns[2]!, calls: [] }], true).failures.some((f) => f.startsWith("rule 2"))).toBe(true);
  });

  it("fails a skip whose status call was given stdin", () => {
    expect(check(skipped(true, `storybloq setup-review status --setup ${SETUP} --skipped <<'X'\nplan\nX`), true).failures.some((f) => f.startsWith("rule 2"))).toBe(true);
  });

  it("rule 4: fails an unavailable opening that is not the four stop lines alone", () => {
    const turns = skipped(true);
    turns[0] = { ...turns[0]!, text: `I could not find a reviewer.\n\n${STOP}` };
    expect(check(turns, true).failures.some((f) => f.startsWith("rule 4"))).toBe(true);
  });
});

describe("check set 6, rule 3 (T-536)", () => {
  it("fails an agent command that reads the review store other than through setup-review", () => {
    const turns = completedRun(REVIEW_PACKET);
    turns[1] = { ...turns[1]!, calls: [...turns[1]!.calls, { command: `cat ${join(store, "0123456789abcdef", SETUP, "setup.json")}`, output: "{}" }] };
    expect(check(turns).failures.some((f) => f.startsWith("rule 3"))).toBe(true);
    const viaTool = completedRun(REVIEW_PACKET);
    viaTool[1] = { ...viaTool[1]!, calls: [...viaTool[1]!.calls, { command: null, filePath: `/var/tmp/storybloq-setup-review-501/x/${SETUP}/records/SR-1/record.json`, output: "" }] };
    expect(check(viaTool).failures.some((f) => f.startsWith("rule 3"))).toBe(true);
    const chained = completedRun(REVIEW_PACKET);
    chained[1] = { ...chained[1]!, calls: [...chained[1]!.calls, { command: `storybloq setup-review status --setup ${SETUP} --skipped; ls ${store}`, output: "" }] };
    expect(check(chained).failures.some((f) => f.startsWith("rule 3"))).toBe(true);
  });

  it("supports only a single-quoted here-document delimiter: an unquoted one expands its body, and the double-quoted form is rejected on purpose as a conservative choice", () => {
    const storeFile = join(store, "0123456789abcdef", SETUP, "setup.json");
    for (const delim of ["EOF", '"EOF"']) {
      const turns = completedRun(REVIEW_PACKET);
      turns[1] = { ...turns[1]!, calls: [...turns[1]!.calls, { command: `storybloq setup-review status --setup ${SETUP} <<${delim}\n$(cat ${storeFile})\nEOF`, output: "" }] };
      expect(check(turns).failures.some((f) => f.startsWith("rule 3"))).toBe(true);
    }
  });
});

describe("heredocStdin (T-536)", () => {
  it("returns the here-document body the shell would feed, newline-terminated", () => {
    expect(heredocStdin("storybloq setup-review status --setup SS-1 <<'EOF'\na\nb\nEOF")).toBe("a\nb\n");
    expect(heredocStdin("storybloq setup-review status --setup SS-1 <<EOF\na\nEOF")).toBeNull();
    expect(heredocStdin('storybloq setup-review status --setup SS-1 <<"EOF"\na\nEOF')).toBeNull();
    expect(heredocStdin("storybloq setup-review status --setup SS-1 --skipped")).toBeNull();
  });
});

describe("check set 6, the reviewer-unavailable arm (T-536)", () => {
  it("hides both reviewers the setup review can start, and only codex before check set 6", () => {
    expect(hiddenReviewers(6)).toEqual(["codex", "claude"]);
    expect(hiddenReviewers(5)).toEqual(["codex"]);
  });

  it("leaves neither codex nor claude on the stripped PATH, and keeps their neighbours", () => {
    const bin = join(store, "bin"); const scratch = join(store, "scratch");
    mkdirSync(bin);
    for (const n of ["codex", "claude", "node"]) writeFileSync(join(bin, n), "#!/bin/sh\n", { mode: 0o755 });
    const path = pathWithout(bin, scratch, hiddenReviewers(6));
    expect(path).toBe(scratch);
    expect(readdirSync(scratch).sort()).toEqual(["node"]);
  });
});
