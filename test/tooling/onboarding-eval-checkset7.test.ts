/**
 * T-538 check set 7 (plan v5 8c, core): each rule passes a clean engine run
 * and fails the run that breaks it.
 */
import { describe, it, expect } from "vitest";
import { checkSetupApply, cs7TurnsFrom, type Cs7Call, type Cs7Options, type Cs7Turn } from "../../scripts/onboarding-eval-checkset7.js";
import type { DriveTurn } from "../../scripts/onboarding-eval-drive.js";
import type { EvalCall } from "../../scripts/onboarding-eval-lib.js";

const SID = "SS-0123abcd";
const APPROVE = "Approve setup";

const payload = {
  setupId: SID,
  ownerLabel: "Sam",
  tickets: [{ key: "K2", title: "Sign in" }, { key: "K3", title: "Profile" }],
  checkpoints: [{ key: "K4", title: "Accept sign in", kind: "acceptance" }],
  issues: [],
};

const PACKAGE = [
  "Here is the setup package.",
  "Plan, revision 0123456789ab:",
  "Ticket: Sign in",
  "Outcome: a user signs in",
  "Ticket: Profile",
  "Checkpoint (acceptance, owner Sam): Accept sign in",
  "End of plan, revision 0123456789ab",
].join("\n");

const APPLIED = ["-> storybloq · ticket T-001 \"Sign in\" created", `Setup applied: ${SID}`].join("\n");
const heredoc = (p: unknown) => `storybloq setup-apply <<'STORYBLOQ_SETUP'\n${JSON.stringify(p)}\nSTORYBLOQ_SETUP`;
const shell = (command: string, output: string): Cs7Call => ({ name: "Bash", command, input: { command }, output });
const mcp = (name: string, input: unknown, output: string): Cs7Call => ({ name: `mcp__storybloq__${name}`, command: null, input, output });

const item = (id: string, title: string, key?: string, extra: Record<string, unknown> = {}) => ({ id, title, ...(key ? { setup: { setupId: SID, key, ...extra } } : {}) });
const LEDGER = { tickets: [item("T-001", "Sign in", "K2"), item("T-002", "Profile", "K3"), item("T-003", "Accept sign in", "K4")], issues: [] };
const opts = (over: Partial<Cs7Options> = {}): Cs7Options => ({ ledger: LEDGER, baselineIds: [], approval: APPROVE, ...over });

function run(applyTurn: Partial<Cs7Turn> = {}, extra: Cs7Turn[] = [], before: Cs7Turn[] = []): Cs7Turn[] {
  return [
    { owner: "Set this project up", calls: [], text: "What are you building?" },
    ...before,
    { owner: "A habit tracker", calls: [], text: PACKAGE },
    { owner: APPROVE, calls: [shell(heredoc(payload), APPLIED)], text: `Setup applied: ${SID}`, ...applyTurn },
    ...extra,
  ];
}

describe("check set 7", () => {
  it("passes a clean run: one approved apply, its lines shown, the ledger matching the payload", () => {
    expect(checkSetupApply(run(), opts()).failures).toEqual([]);
  });

  it("accepts the MCP setup_apply call as the engine call", () => {
    const turns = run({ calls: [mcp("storybloq_setup_apply", { payload }, `[exit 0]\n${APPLIED}`)] });
    expect(checkSetupApply(turns, opts()).failures).toEqual([]);
  });

  it("rule 1: an engine line no setup-apply call printed fails", () => {
    const turns = run({ calls: [shell(heredoc(payload), "-> storybloq · ticket T-001 \"Sign in\" created")] });
    expect(checkSetupApply(turns, opts()).failures).toEqual([`rule 1: turn 3 shows "Setup applied: ${SID}", which no setup-apply call printed`]);
  });

  it("rule 2: a missing or duplicated key, a changed title and a new unkeyed record each fail; the fixture's own records do not", () => {
    const ledger = {
      tickets: [item("T-001", "Log in", "K2"), item("T-002", "Profile", "K3"), item("T-005", "Profile", "K3"), item("T-009", "Mine"), item("T-010", "Fixture's")],
      issues: [],
    };
    const failures = checkSetupApply(run(), opts({ ledger, baselineIds: ["T-010"] })).failures;
    expect(failures).toEqual([
      'rule 2: T-001 (key K2) is titled "Log in", the payload "Sign in"',
      "rule 2: payload key K3 has 2 records in the ledger; expected exactly one",
      "rule 2: payload key K4 has 0 records in the ledger; expected exactly one",
      "rule 2: records without a setup key appeared during setup: T-009",
    ]);
  });

  it("rule 2: a superseded duplicate is not counted, and a key the owner resolved may keep the owner's title", () => {
    const ledger = { tickets: [item("T-001", "Log in", "K2"), item("T-004", "Sign in", "K2", { supersededBy: "T-001" }), ...LEDGER.tickets.slice(1)], issues: [] };
    const stop = `Ambiguity: owned field edited · K2 (T-001) · observed title; expected title · resolutions: accept-current | restore-planned | stop\nSetup stopped: the owner must resolve owned field edited at K2 (T-001).`;
    const turns = run(
      { calls: [shell(heredoc(payload), stop)], text: stop },
      [{ owner: "keep my title", calls: [shell(`storybloq setup-apply --setup ${SID} --resolve '[{"target":"K2 (T-001)","resolution":"accept-current","ownerWords":"keep my title"}]'`, `Setup applied: ${SID}`)], text: `Setup applied: ${SID}` }],
    );
    expect(checkSetupApply(turns, opts({ ledger })).failures).toEqual([]);
  });

  it("rule 3: a payload that differs from the approved Plan fails", () => {
    const changed = { ...payload, tickets: [...payload.tickets, { key: "K7", title: "Billing" }], checkpoints: [{ key: "K4", title: "Accept sign in", kind: "demo" }] };
    const ledger = { tickets: [...LEDGER.tickets, item("T-004", "Billing", "K7")], issues: [] };
    const failures = checkSetupApply(run({ calls: [shell(heredoc(changed), APPLIED)] }), opts({ ledger })).failures;
    expect(failures).toEqual([
      "rule 3: the payload's tickets (Billing, Profile, Sign in) differ from the approved Plan's (Profile, Sign in)",
      "rule 3: the payload's checkpoints (demo|Sam|Accept sign in) differ from the approved Plan's (acceptance|Sam|Accept sign in)",
    ]);
  });

  it("rule 4: an apply before approval, a second payload, a bare call and an unprompted resolution each fail; a resume does not", () => {
    const early: Cs7Turn = { owner: "Looks fine", calls: [shell(`storybloq setup-apply --resume --setup ${SID}`, "Setup refused: no setup")], text: "ok" };
    const later: Cs7Turn[] = [
      { owner: "carry on", calls: [shell(`storybloq setup-apply --resume --setup ${SID}`, `Setup applied: ${SID} (already complete; nothing written)`)], text: "" },
      { owner: "again", calls: [shell(heredoc(payload), APPLIED), shell("storybloq setup-apply", "Setup refused: no payload"), shell(`storybloq setup-apply --setup ${SID} --resolve '[]'`, "Setup refused")], text: "" },
    ];
    const failures = checkSetupApply(run({}, later, [early]), opts()).failures;
    expect(failures).toEqual([
      "rule 4: 1 setup-apply call(s) ran before the owner's approval",
      "rule 4: the approved payload was sent 2 times; one approval allows one initial apply",
      "rule 4: turn 6 ran setup-apply with neither a payload, --resume nor --resolve",
      "rule 4: turn 6 sent a resolution with no earlier ambiguity for the owner to answer",
    ]);
  });

  it("rule 4: no approval at all fails every apply", () => {
    const turns = run().map((t) => (t.owner === APPROVE ? { ...t, owner: "sure, whatever you think" } : t));
    expect(checkSetupApply(turns, opts()).failures).toContain("rule 4: 1 setup-apply call(s) ran before the owner's approval");
  });

  it("rule 5: an individual create call, by MCP or CLI, fails", () => {
    const turns = run({}, [{ owner: "add one more", calls: [mcp("storybloq_ticket_create", { title: "x" }, "created"), shell("storybloq ticket create --title x --type task --phase build", "created")], text: "" }]);
    expect(checkSetupApply(turns, opts()).failures).toEqual([
      "rule 5: turn 4 called storybloq_ticket_create; the setup engine is the only writer",
      "rule 5: turn 4 ran storybloq ticket create; the setup engine is the only writer",
    ]);
  });

  it("reads the run's turns without nested calls", () => {
    const calls: EvalCall[] = [
      { name: "Bash", input: { command: "storybloq setup-apply --resume --setup SS-0123abcd" }, isError: false, result: "out" },
      { name: "mcp__storybloq__storybloq_ticket_create", input: {}, isError: false, nested: true, result: "" },
    ];
    const turns = cs7TurnsFrom([{ prompt: "p", stopText: "t", callRange: [0, 2] } as unknown as DriveTurn], calls);
    expect(turns).toEqual([{ owner: "p", text: "t", calls: [{ name: "Bash", command: "storybloq setup-apply --resume --setup SS-0123abcd", input: { command: "storybloq setup-apply --resume --setup SS-0123abcd" }, output: "out" }] }]);
  });
});
