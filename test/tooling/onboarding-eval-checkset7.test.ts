/**
 * T-538 check set 7 (plan v5 8c, core): each rule passes a clean engine run
 * and fails the run that breaks it.
 */
import { describe, it, expect } from "vitest";
import { checkSetupApply, cs7TurnsFrom, rule6, type Cs7Call, type Cs7Options, type Cs7Turn } from "../../scripts/onboarding-eval-checkset7.js";
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
const checkpoint = (id: string, title: string, key: string) => ({ ...item(id, title, key), ownerCheckpoint: { kind: "acceptance" } });
const LEDGER = { tickets: [item("T-001", "Sign in", "K2"), item("T-002", "Profile", "K3"), checkpoint("T-003", "Accept sign in", "K4")], issues: [] };
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
      [{ owner: "keep my title", calls: [shell(`storybloq setup-apply --setup ${SID} --resolve '[{"target":"K2 (T-001)","resolution":"accept-current","ownerWords":"keep my title"}]'`, `-> storybloq · resolved K2 (T-001): accept-current\nSetup applied: ${SID}`)], text: `Setup applied: ${SID}` }],
    );
    expect(checkSetupApply(turns, opts({ ledger })).failures).toEqual([]);
  });

  it("rule 2: an extra keyed record under this setup and a key of the wrong kind each fail (review r1 #10)", () => {
    const ledger = { tickets: [...LEDGER.tickets.slice(0, 2), item("T-003", "Accept sign in", "K4"), item("T-011", "Billing", "K9")], issues: [] };
    expect(checkSetupApply(run(), opts({ ledger })).failures).toEqual([
      "rule 2: T-003 (key K4) is a ticket, the payload's a checkpoint",
      "rule 2: keyed records under this setup that the payload does not hold: T-011 (key K9)",
    ]);
  });

  it("rule 2: a stated status is part of the record, exactly; an unstated one is not checked (T-538 S3a-1, review #3 #4)", () => {
    const stated = { ...payload, tickets: [{ key: "K2", title: "Sign in", status: "complete" }, { key: "K3", title: "Profile", status: "open" }] };
    const runWith = (p: unknown) => run({ calls: [shell(heredoc(p), APPLIED)] });
    const ledger = (s2: string, s3: string | undefined) => {
      const { status: _, ...k3 } = LEDGER.tickets[1]! as Record<string, unknown>;
      return { tickets: [{ ...LEDGER.tickets[0]!, status: s2 }, s3 === undefined ? k3 : { ...k3, status: s3 }, LEDGER.tickets[2]!], issues: [] };
    };
    expect(checkSetupApply(runWith(stated), opts({ ledger: ledger("complete", "open") })).failures).toEqual([]);
    expect(checkSetupApply(runWith(stated), opts({ ledger: ledger("complete", "inprogress") })).failures).toEqual([
      "rule 2: T-002 (key K3) is inprogress, the payload open",
    ]);
    expect(checkSetupApply(runWith(stated), opts({ ledger: ledger("complete", undefined) })).failures).toEqual([
      "rule 2: T-002 (key K3) is without a status, the payload open",
    ]);
    expect(checkSetupApply(runWith(stated), opts({ ledger: ledger("open", "open") })).failures).toEqual([
      "rule 2: T-001 (key K2) is open, the payload complete",
    ]);
    expect(checkSetupApply(runWith(stated), opts({ ledger: ledger("complete", "complete") })).failures).toEqual([
      "rule 2: T-002 (key K3) is complete, the payload open",
    ]);
    expect(checkSetupApply(run(), opts({ ledger: ledger("complete", "complete") })).failures).toEqual([]);
    expect(checkSetupApply(run(), opts({ ledger: ledger("inprogress", undefined) })).failures).toEqual([]);
  });

  it("rule 2: checkpoints a successful drop-checkpoints removed are not expected (review r1 #10)", () => {
    const stop = "Ambiguity: schema-5 enable refused · .story/config.json · observed team ledger below schema 5; expected schema 5 · resolutions: drop-checkpoints | stop";
    const turns = run(
      { calls: [shell(heredoc(payload), stop)], text: stop },
      [{ owner: "drop them", calls: [shell(`storybloq setup-apply --setup ${SID} --resolve '[{"target":".story/config.json","resolution":"drop-checkpoints","ownerWords":"drop them"}]'`, `-> storybloq · resolved .story/config.json: drop-checkpoints (material, review recorded)\nSetup applied: ${SID}`)], text: `Setup applied: ${SID}` }],
    );
    expect(checkSetupApply(turns, opts({ ledger: { tickets: LEDGER.tickets.slice(0, 2), issues: [] } })).failures).toEqual([]);
  });

  describe("rule 4: a resolution must answer an outstanding ambiguity with the owner's words, and only an applied one amends (review r1 #9)", () => {
    const ledger = { tickets: [item("T-001", "Log in", "K2"), ...LEDGER.tickets.slice(1)], issues: [] };
    const stop = "Ambiguity: owned field edited · K2 (T-001) · observed title; expected title · resolutions: accept-current | restore-planned | stop";
    const resolveTurns = (owner: string, target: string, output: string) => run(
      { calls: [shell(heredoc(payload), stop)], text: stop },
      [{ owner, calls: [shell(`storybloq setup-apply --setup ${SID} --resolve '[{"target":"${target}","resolution":"accept-current","ownerWords":"keep my title"}]'`, output)], text: "" }],
    );
    const titleFailure = 'rule 2: T-001 (key K2) is titled "Log in", the payload "Sign in"';

    it("an owner message that does not hold the resolution's words fails, and the key is not exempted", () => {
      const turns = resolveTurns("carry on", "K2 (T-001)", `-> storybloq · resolved K2 (T-001): accept-current\nSetup applied: ${SID}`);
      expect(checkSetupApply(turns, opts({ ledger })).failures).toEqual([
        'rule 4: turn 4 resolved "K2 (T-001)" with words no owner message after its ambiguity holds',
        titleFailure,
      ]);
    });

    it("a target no outstanding ambiguity names fails, and the key is not exempted", () => {
      const turns = resolveTurns("keep my title", "K3 (T-002)", `-> storybloq · resolved K3 (T-002): accept-current\nSetup applied: ${SID}`);
      expect(checkSetupApply(turns, opts({ ledger })).failures).toEqual([
        'rule 4: turn 4 resolved "K3 (T-002)", which no outstanding ambiguity names',
        titleFailure,
      ]);
    });

    it("restore-planned reported resolved exempts no title: the edited title that remains fails (review r2 #1)", () => {
      const turns = run(
        { calls: [shell(heredoc(payload), stop)], text: stop },
        [{ owner: "put it back", calls: [shell(`storybloq setup-apply --setup ${SID} --resolve '[{"target":"K2 (T-001)","resolution":"restore-planned","ownerWords":"put it back"}]'`, `-> storybloq · resolved K2 (T-001): restore-planned\nSetup applied: ${SID}`)], text: "" }],
      );
      expect(checkSetupApply(turns, opts({ ledger })).failures).toEqual([titleFailure]);
    });

    it("a batch the engine refused grants nothing, even for an answer it printed as resolved first (review r2 #2)", () => {
      const two = `${stop}\nAmbiguity: owned field edited · K3 (T-002) · observed title; expected title · resolutions: accept-current | restore-planned | stop`;
      const answers = '[{"target":"K2 (T-001)","resolution":"accept-current","ownerWords":"keep my title"},{"target":"K3 (T-002)","resolution":"accept-current","ownerWords":"keep my title"}]';
      const turns = run(
        { calls: [shell(heredoc(payload), two)], text: two },
        [{ owner: "keep my title", calls: [shell(`storybloq setup-apply --setup ${SID} --resolve '${answers}'`, "-> storybloq · resolved K2 (T-001): accept-current\nSetup refused: K3 (T-002): accept-current changes the approved package")], text: "" }],
      );
      expect(checkSetupApply(turns, opts({ ledger })).failures).toEqual([titleFailure]);
    });

    it("a refused resolution exempts nothing", () => {
      const turns = resolveTurns("keep my title", "K2 (T-001)", "Setup refused: K2 (T-001): accept-current changes the approved package");
      expect(checkSetupApply(turns, opts({ ledger })).failures).toEqual([titleFailure]);
    });
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

describe("rule 6: establishment tickets (T-538 S3a-2)", () => {
  const quality = (level: string, status = "pending") => ({ level, components: [{ id: "app", test: { status } }] });
  const scaffold = { key: "K2", blockedBy: [] };
  const est = (extra: Record<string, unknown> = {}) => ({ key: "K3", blockedBy: ["K2"], establishes: { component: "app" }, ...extra });
  const story = { key: "K4", blockedBy: ["K3"] };

  it("passes one establishment ticket per pending test component that something waits on, with no status", () => {
    expect(rule6({ quality: quality("tests-only"), tickets: [scaffold, est(), story] })).toEqual([]);
    expect(rule6({ quality: quality("full"), tickets: [scaffold, est(), story] })).toEqual([]);
  });

  it("reads dependents on the effective graph: a checkpoint that reviews it counts", () => {
    expect(rule6({ quality: quality("tests-only"), tickets: [scaffold, est()], checkpoints: [{ key: "K6", blockedBy: ["K3"], gates: [] }] })).toEqual([]);
    expect(rule6({ quality: quality("tests-only"), tickets: [scaffold, est()], checkpoints: [{ key: "K6", blockedBy: [], gates: ["K2"] }] }))
      .toEqual(["rule 6: nothing waits on K3, the establishment ticket for app"]);
  });

  it("fails a pending component with no establishment ticket, or two", () => {
    expect(rule6({ quality: quality("tests-only"), tickets: [scaffold, story] })).toEqual(["rule 6: component app's test stage is pending and has 0 establishment tickets; expected exactly one"]);
    expect(rule6({ quality: quality("tests-only"), tickets: [scaffold, est(), { ...est(), key: "K5" }, story] })).toEqual(["rule 6: component app's test stage is pending and has 2 establishment tickets; expected exactly one"]);
  });

  it("fails an establishment ticket that states a status", () => {
    expect(rule6({ quality: quality("tests-only"), tickets: [scaffold, est({ status: "open" }), story] })).toEqual(["rule 6: K3, the establishment ticket for app, states a status (open); setup-verify completes it"]);
  });

  it("owes nothing under minimal, or for an established test stage", () => {
    expect(rule6({ quality: quality("minimal"), tickets: [scaffold, story] })).toEqual([]);
    expect(rule6({ quality: quality("tests-only", "established"), tickets: [scaffold, story] })).toEqual([]);
  });

  it("runs inside checkSetupApply on the payload as sent", () => {
    const sent = { ...payload, quality: quality("tests-only") };
    const turns: Cs7Turn[] = [
      { owner: "set it up", calls: [], text: PACKAGE },
      { owner: APPROVE, calls: [shell(heredoc(sent), APPLIED)], text: APPLIED },
    ];
    expect(checkSetupApply(turns, opts()).failures).toContain("rule 6: component app's test stage is pending and has 0 establishment tickets; expected exactly one");
  });
});
