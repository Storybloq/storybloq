/**
 * T-536: the mechanical checks the onboarding evaluations score with, and the
 * integrity of the fixtures they run on.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bareToolName, checkRecipe, checkStop, classifyStop, claudeTurn, codexRolloutModels, codexTurn, componentCommandFindings, degradedFindings,
  dependencyCycles, digestChanges, executionCalls, isCheckpointTicket, isCitationOnly, isRuntimeState, isTestInvocation, readStop, resolveTestStages, reviewerInvocations, runtimeExclusion,
  runVerdict, readTurnStop, semanticStopLine, shellCommands, shellQuote, shellSequence, stopRoute, STOP_RULE_VERSION, summaryCounts, ticketFindings, TREE_EXCLUSION_LINE, treeCheckOutcome, treeDigest, turnArgs, writeCalls, type EvalCall, type EvalTurn, type JudgeResult,
} from "../../scripts/onboarding-eval-lib.js";
import { sha256 } from "../../scripts/continuity-lib.js";
import {
  ADJUSTMENT_REVIEW_LINE, ADJUSTMENT_SKIP_LINE, finalize, finalizeRecord, fixtureEvidence, isolationProblems, launcherScript, materializeFixture,
  ownerScript, REVIEW_LINE, runSemanticLines, scrubClientEnv, semanticLinesFor,
} from "../../scripts/onboarding-eval-run.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "onboarding");
const bash = (command: string): EvalCall => ({ name: "Bash", input: { command }, isError: false });
const tool = (name: string): EvalCall => ({ name, input: {}, isError: false });
const turn = (stopText: string, calls: EvalCall[] = []): EvalTurn => ({ calls, stopText, models: [], sessionId: null, terminal: { status: "completed", detail: "" }, initTools: null });
const segments = (...cmds: string[]): string[] => executionCalls(cmds.map(bash)).filter((h) => h.kind === "execution").map((h) => h.segment);
const reviews = (...cmds: string[]): string[] => executionCalls(cmds.map(bash)).filter((h) => h.kind === "review").map((h) => h.segment);

describe("writeCalls", () => {
  it("counts storybloq writes, file edits, git init and shell redirects", () => {
    const writes = [
      tool("storybloq_init"), tool("storybloq_ticket_create"), tool("storybloq_ticket_update"), tool("storybloq_snapshot"),
      tool("Write"), tool("Edit"), bash("git init"), bash("cd x && storybloq phase create --id a"),
      bash("storybloq config set-overrides --json '{}'"), bash("echo hi > CLAUDE.md"), bash("printf x | tee notes.md"),
    ];
    expect(writeCalls(writes)).toHaveLength(writes.length);
  });

  it("does not count reads, discovery or descriptor redirects", () => {
    const reads = [
      tool("storybloq_status"), tool("storybloq_ticket_list"), tool("ToolSearch"), tool("Read"), tool("AskUserQuestion"),
      bash("cat package.json"), bash("ls -la 2>/dev/null"), bash("git log --oneline -20 2>&1"), bash("grep -rn init docs > /dev/null"),
    ];
    expect(writeCalls(reads)).toEqual([]);
  });
});

describe("executionCalls", () => {
  it("finds installs, tests, builds and dev servers, including after cd", () => {
    const segs = executionCalls([bash("npm test"), bash("cd backend && pytest -q"), bash("npm run build"), bash("pip install -e ."), bash("npx vite"), bash("go test ./...")]).map((h) => h.segment);
    expect(segs).toEqual(["npm test", "pytest -q", "npm run build", "pip install -e .", "npx vite", "go test ./..."]);
  });

  it("recognises Node's built-in test runner and package scripts, not other node runs", () => {
    for (const cmd of ["node --test", "node --test test/books.test.js", "/usr/local/bin/node --test", "node --experimental-vm-modules --test", "node -r ts-node/register --test", "node --test-reporter spec --test", "node --test=true", "node --run test", "node --run=build"]) {
      expect(segments(cmd), cmd).toEqual([cmd]);
      expect(checkStop(turn("Who uses it?", [bash(cmd)]), ["discovery"]).ok, cmd).toBe(false);
    }
    for (const cmd of ["node --version", "node -v", "node app.js --test", "node -e 1", "node --eval=1", "node"]) {
      expect(executionCalls([bash(cmd)]), cmd).toEqual([]);
      expect(checkStop(turn("Who uses it?", [bash(cmd)]), ["discovery"]).ok, cmd).toBe(true);
    }
    // An unlisted option may have consumed the next word: a later --test is flagged, not dropped.
    expect(reviews("node --weird x --test")).toEqual(["node --weird x --test"]);
  });

  it("ignores reading a manifest or searching for a command name", () => {
    expect(executionCalls([bash("cat package.json"), bash("grep -n pytest pyproject.toml"), bash("npm view vite version"), bash("git status")])).toEqual([]);
  });

  it("sees through newlines, env and other wrappers, executable options, quoting and sh -c", () => {
    expect(segments("pwd\nnpm test")).toEqual(["npm test"]);
    expect(segments("env npm test")).toEqual(["npm test"]);
    expect(segments("env -i FOO=1 npm test")).toEqual(["npm test"]);
    expect(segments("npm --prefix frontend test")).toEqual(["npm --prefix frontend test"]);
    expect(segments("pnpm -C web run build")).toEqual(["pnpm -C web run build"]);
    expect(segments("timeout 60 pytest -q")).toEqual(["pytest -q"]);
    expect(segments("nohup npx vite &")).toEqual(["npx vite"]);
    expect(segments("FOO=1 BAR=2 python3 -m pytest")).toEqual(["python3 -m pytest"]);
    expect(segments("bash -c 'cd backend && pytest'")).toEqual(["pytest"]);
    expect(segments('sh -lc "npm run dev"')).toEqual(["npm run dev"]);
    expect(segments("/usr/local/bin/npm test")).toEqual(["/usr/local/bin/npm test"]);
    expect(segments("echo 'npm test'")).toEqual([]);
  });

  it("reports a construct it cannot see through for review, never as clean", () => {
    for (const cmd of ["echo $(npm test)", "`npm test`", "eval \"npm test\"", "cat <<EOF | sh\nnpm test\nEOF", "ls | xargs npm test"]) {
      const hits = executionCalls([bash(cmd)]);
      expect(hits.some((h) => h.kind === "review"), cmd).toBe(true);
      expect(checkStop(turn("Who uses it?", [bash(cmd)]), ["discovery"]).ok, cmd).toBe(false);
    }
  });

  it("reads wrapper options that take a separate value, so the value is never taken for the command", () => {
    expect(segments("nice -n 5 npm test")).toEqual(["npm test"]);
    expect(segments("nice -n5 npm test")).toEqual(["npm test"]);
    expect(segments("nice -10 npm test")).toEqual(["npm test"]);
    expect(segments("timeout -s KILL 60 npm test")).toEqual(["npm test"]);
    expect(segments("timeout --signal KILL 60 npm test")).toEqual(["npm test"]);
    expect(segments("timeout --signal=KILL -k 5 60 npm test")).toEqual(["npm test"]);
    expect(segments("sudo -u app npm test")).toEqual(["npm test"]);
    expect(segments("sudo -E -u app -g staff npm test")).toEqual(["npm test"]);
    expect(segments("stdbuf -o L npm test")).toEqual(["npm test"]);
    expect(segments("env -u HOME -C /tmp npm test")).toEqual(["npm test"]);
    for (const cmd of ["nice -n 5 npm test", "timeout -s KILL 60 npm test", "sudo -u app npm test", "env -u HOME npm test"]) expect(reviews(cmd), cmd).toEqual([]);
  });

  it("reads pnpm's -w and --workspace-root as flags, so the subcommand after them still counts", () => {
    expect(segments("pnpm -w test")).toEqual(["pnpm -w test"]);
    expect(segments("pnpm --workspace-root test")).toEqual(["pnpm --workspace-root test"]);
    expect(segments("pnpm -C web -w run build")).toEqual(["pnpm -C web -w run build"]);
    for (const cmd of ["pnpm -w test", "pnpm --workspace-root test"]) expect(checkStop(turn("Who uses it?", [bash(cmd)]), ["discovery"]).ok, cmd).toBe(false);
  });

  it("treats command -v and -V as a lookup, and command with anything else as running it", () => {
    for (const cmd of ["command -v pytest", "command -V npm", "command -pv npm", "command -v npm && echo found"]) {
      expect(executionCalls([bash(cmd)]), cmd).toEqual([]);
      expect(checkStop(turn("Who uses it?", [bash(cmd)]), ["discovery"]).ok, cmd).toBe(true);
    }
    expect(segments("command pytest")).toEqual(["pytest"]);
    expect(segments("command -p npm test")).toEqual(["npm test"]);
  });

  it("runs env -S's split string as the command", () => {
    expect(segments('env -S "npm test"')).toEqual(["npm test"]);
    expect(segments("env -S'FOO=1 npm run build'")).toEqual(["npm run build"]);
    expect(segments('env -i --split-string="pytest -q" -x')).toEqual(["pytest -q -x"]);
  });

  it("reports control structures and unknown options for review while still finding what they run", () => {
    const ifThen = executionCalls([bash("if true; then npm test; fi")]);
    expect(ifThen.some((h) => h.kind === "review")).toBe(true);
    expect(ifThen.filter((h) => h.kind === "execution").map((h) => h.segment)).toEqual(["npm test"]);
    expect(reviews("for d in a b; do pytest; done").length).toBeGreaterThan(0);
    expect(reviews("sudo --weird x npm test").join()).toContain("sudo option --weird");
    expect(reviews("timeout --weird 5 60 npm test").join()).toContain("timeout option --weird");
    expect(reviews("env --weird x npm test").join()).toContain("env option --weird");
    // An unlisted option before the subcommand may have consumed a value: the later `test` is flagged, not dropped.
    expect(reviews("npm --loglevel warn test")).toEqual(["npm --loglevel warn test"]);
    expect(reviews("python3 -W ignore -m pytest")).toEqual(["python3 -W ignore -m pytest"]);
    expect(executionCalls([bash("npm view vite version")])).toEqual([]);
    for (const cmd of ["if true; then npm test; fi", "nice --weird 5 npm test", "npm --loglevel warn test"]) {
      expect(checkStop(turn("Who uses it?", [bash(cmd)]), ["discovery"]).ok, cmd).toBe(false);
    }
  });

  it("splits commands on operators and newlines but not inside quotes", () => {
    expect(shellCommands("a 'b;c' && d \"e|f\"\ng")).toEqual([["a", "b;c"], ["d", "e|f"], ["g"]]);
  });

  it("reports every operator, and keeps a redirect's ampersand in its word", () => {
    expect(shellSequence("(cd a && x) || y | z & w; v").operators).toEqual(["(", "&&", ")", "||", "|", "&", ";"]);
    expect(shellSequence("git log 2>&1 &>out").commands.map((c) => c.words)).toEqual([["git", "log", "2>&1", "&>out"]]);
    expect(shellQuote("it's $HOME `x`")).toBe("'it'\\''s $HOME `x`'");
  });
});

describe("stop points", () => {
  it("classifies the package, the review stop and a discovery question", () => {
    expect(classifyStop("...\n\n- Approve setup\n- Adjust the plan\n- Inspect details")).toBe("package");
    expect(classifyStop("No reviewer is available. Retry the review, or continue without independent review?")).toBe("review-unavailable");
    expect(readStop("Who will use this first?")).toEqual({ kind: "semantic", candidate: "discovery" });
    expect(classifyStop("Created 3 phases.")).toBe("none");
  });

  it("classifies only the terminal interaction: a package asked mid-turn and followed by other text is not a package stop", () => {
    const shownThenWorked = "Here is the package.\n- Approve setup\n- Adjust the plan\n- Inspect details\n\nI went ahead and looked at the tests.\n\nAll done.";
    expect(readStop(shownThenWorked)).toEqual({ kind: "semantic", candidate: "package" });
    expect(classifyStop("Here is the package.\n\nHow should I proceed with this setup?\n- Approve setup\n- Adjust the plan\n- Inspect details")).toBe("package");
    expect(readStop("Who uses it?\n\nI will assume librarians.")).toEqual({ kind: "semantic", candidate: "discovery" });
  });

  it("drops an answered or failed structured question and keeps one left pending as the last main-agent call", () => {
    const ask = (id: string) => ({ type: "assistant", request_id: id, message: { model: "m", content: [{ type: "tool_use", id, name: "AskUserQuestion", input: { questions: [{ question: "How should I proceed with this setup?", options: [{ label: "Approve setup" }, { label: "Adjust the plan" }, { label: "Inspect details" }] }] } }] } });
    const failed = claudeTurn([
      ask("q1"),
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "q1", content: "unavailable", is_error: true }] } },
      { type: "assistant", request_id: "r2", message: { model: "m", content: [{ type: "tool_use", id: "w1", name: "Bash", input: { command: "ls" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "w1", content: "ok" }] } },
      { type: "assistant", request_id: "r3", message: { model: "m", content: [{ type: "text", text: "Done for now." }] } },
      { type: "result", subtype: "success", result: "Done for now." },
    ]);
    expect(failed.stopText).toBe("Done for now.");
    expect(classifyStop(failed.stopText)).toBe("none");
    const pending = claudeTurn([ask("q2"), { type: "result", subtype: "success", result: "Here is the package." }]);
    // The pending question is kept; the result text before it is prose the judge rules on.
    expect(readTurnStop(pending)).toEqual({ kind: "semantic", candidate: "package" });
  });

  it("drops a pending Claude question that later main-agent text or tool use superseded, but not a nested agent's activity", () => {
    const ask = { type: "assistant", request_id: "q", message: { model: "m", content: [{ type: "tool_use", id: "q", name: "AskUserQuestion", input: { questions: [{ question: "How should I proceed with this setup?", options: [{ label: "Approve setup" }, { label: "Adjust the plan" }, { label: "Inspect details" }] }] } }] } };
    const result = { type: "result", subtype: "success", result: "I will assume the defaults." };
    const thenText = claudeTurn([ask, { type: "assistant", request_id: "t", message: { model: "m", content: [{ type: "text", text: "I will assume the defaults." }] } }, result]);
    expect(thenText.stopText).toBe("I will assume the defaults.");
    expect(classifyStop(thenText.stopText)).toBe("none");
    const thenTool = claudeTurn([ask, { type: "assistant", request_id: "b", message: { model: "m", content: [{ type: "tool_use", id: "b", name: "Bash", input: { command: "ls" } }] } }, result]);
    expect(thenTool.stopText).toBe("");
    const nestedAfter = claudeTurn([ask, { type: "assistant", parent_tool_use_id: "a0", request_id: "n", message: { model: "m", content: [{ type: "text", text: "nested chatter" }] } }, result]);
    expect(nestedAfter.pendingQuestion?.preamble).toBe("I will assume the defaults.");
    expect(readTurnStop(nestedAfter)).toEqual({ kind: "semantic", candidate: "package" });
  });

  it("drops a Codex message that tool activity followed, and keeps one that came last", () => {
    const msg = (text: string) => ({ type: "item.completed", item: { type: "agent_message", text } });
    const cmd = { type: "item.completed", item: { type: "command_execution", command: "ls", exit_code: 0 } };
    expect(codexTurn([msg("Approve setup?"), cmd, { type: "turn.completed" }]).stopText).toBe("");
    expect(codexTurn([msg("Approve setup?"), { type: "item.completed", item: { type: "mcp_tool_call", tool: "storybloq_status", status: "completed" } }]).stopText).toBe("");
    expect(codexTurn([cmd, msg("Who uses it?"), { type: "turn.completed" }]).stopText).toBe("Who uses it?");
    expect(codexTurn([msg("old"), cmd, msg("Who uses it?")]).stopText).toBe("Who uses it?");
  });

  it("fails a stop that wrote or executed, or stopped somewhere unexpected", () => {
    expect(checkStop(turn("Who uses it?"), ["discovery"]).ok).toBe(true);
    const wrote = checkStop(turn("Approve setup Adjust the plan Inspect details", [tool("storybloq_init")]), ["package"]);
    expect(wrote.ok).toBe(false);
    expect(wrote.reasons.join()).toContain("wrote before approval");
    expect(checkStop(turn("Who uses it?", [bash("npm install")]), ["discovery"]).reasons.join()).toContain("executed during setup");
    expect(checkStop(turn("Done."), ["package"]).reasons.join()).toContain("stopped at none");
  });
});

describe("resolveTestStages", () => {
  it("leaves the default recipe on npm test when nothing overrides it", () => {
    expect(resolveTestStages({})).toEqual({ kind: "enabled", command: "npm test", writeTests: true, test: true });
  });

  it("resolves both explicitly disabled, one shared command, and a mismatch", () => {
    expect(resolveTestStages({ recipeOverrides: { stages: { WRITE_TESTS: { enabled: false }, TEST: { enabled: false } } } })).toEqual({ kind: "disabled" });
    expect(resolveTestStages({ recipeOverrides: { stages: { WRITE_TESTS: { enabled: true, command: "pytest" }, TEST: { enabled: true, command: "pytest" } } } }))
      .toEqual({ kind: "enabled", command: "pytest", writeTests: true, test: true });
    expect(resolveTestStages({ recipeOverrides: { stages: { TEST: { enabled: true, command: "pytest" } } } }).kind).toBe("abort");
  });

  it("accepts a multi-part command only when every part runs from its own directory", () => {
    const parts = ["frontend", "backend"];
    expect(componentCommandFindings("npm --prefix frontend test && cd backend && pytest", parts)).toEqual([]);
    expect(componentCommandFindings("cd frontend && npm test; cd ../backend && pytest", parts)).toEqual([]);
    expect(componentCommandFindings("cd ./frontend/ && npm test && cd .. && cd backend && python -m pytest", parts)).toEqual([]);
    expect(componentCommandFindings("npm test", parts).join()).toContain("project root");
    expect(componentCommandFindings("pytest", ["frontend", "backend"]).join()).toContain("no test command runs in frontend");
    // A relative cd resolves against the current directory, not the root.
    expect(componentCommandFindings("cd frontend && npm test; cd backend && pytest", parts)).toEqual(["`pytest` runs in frontend/backend, which is not a component", "no test command runs in backend"]);
    expect(componentCommandFindings("cd frontend && npm test && cd backend && pytest", parts).join()).toContain("frontend/backend");
    expect(componentCommandFindings("cd frontend && cd frontend && npm test", ["frontend"]).join()).toContain("frontend/frontend");
    expect(componentCommandFindings("cd .. && npm test", ["frontend"]).join()).toContain("leaves the project");
    expect(componentCommandFindings("cd /abs/frontend && npm test", ["frontend"]).join()).toContain("leaves the project");
    // A root for config or collection is not a working directory: only a cd or the executable's own directory option moves a run.
    expect(componentCommandFindings("pytest --rootdir frontend; pytest --rootdir backend", parts)).toEqual([
      "`pytest --rootdir frontend` runs at the project root, not in a component",
      "`pytest --rootdir backend` runs at the project root, not in a component",
      "no test command runs in frontend",
      "no test command runs in backend",
    ]);
    expect(componentCommandFindings("pytest frontend/tests && pytest backend/tests", parts).join()).toContain("project root");
    expect(componentCommandFindings("make -C frontend test && cd backend && pytest", parts)).toEqual([]);
    // Only a test invocation covers a component.
    expect(componentCommandFindings("cd frontend && npm run build; cd ../backend && pip install -e .", parts)).toEqual(["no test command runs in frontend", "no test command runs in backend"]);
    expect(componentCommandFindings("cd frontend && npm ci && npm test; cd ../backend && pytest", parts)).toEqual([]);
    // Structures that change scope or control flow are refused rather than guessed.
    for (const cmd of ["(cd frontend && npm test) && cd backend && pytest", "cd frontend && npm test || true; cd ../backend && pytest", "{ cd frontend; npm test; }; cd backend && pytest", "cd frontend | npm test", "if true; then cd frontend && npm test; fi", "env -C frontend npm test && cd backend && pytest", "cd frontend && $(echo npm) test"]) {
      expect(componentCommandFindings(cmd, parts).join(), cmd).toContain("cannot tell where");
    }
    const exp = { testStages: "disabled-or-components" as const, components: ["frontend", "backend"] };
    expect(checkRecipe({ kind: "disabled" }, exp)).toBeNull();
    expect(checkRecipe({ kind: "enabled", command: "npm test", writeTests: true, test: true }, exp)).toContain("project root");
  });

  it("recognises test invocations and nothing else", () => {
    for (const cmd of ["npm test", "npm run test:unit", "yarn test", "pnpm run test", "npx vitest run", "pytest -q", "python3 -m pytest", "uv run pytest", "poetry run pytest", "go test ./...", "cargo test", "make check", "bundle exec rspec", "./gradlew test", "node --test", "node --test test/books.test.js", "node --run test"]) {
      expect(isTestInvocation(cmd.split(" ")), cmd).toBe(true);
    }
    for (const cmd of ["npm ci", "npm install", "npm run build", "npm run dev", "pip install -e .", "uv sync", "go build", "cargo build", "make", "npx vite", "node --version", "node --run build", "node app.js --test"]) {
      expect(isTestInvocation(cmd.split(" ")), cmd).toBe(false);
    }
  });

  it("checks the resolution against a fixture's expectation", () => {
    expect(checkRecipe({ kind: "disabled" }, { testStages: "disabled" })).toBeNull();
    expect(checkRecipe({ kind: "enabled", command: "npm test", writeTests: true, test: true }, { testStages: "same-command", command: "pytest" })).toContain("expected pytest");
    expect(checkRecipe({ kind: "disabled" }, { testStages: "same-command-or-disabled" })).toBeNull();
    expect(checkRecipe({ kind: "abort", reason: "x" }, { testStages: "disabled" })).toContain("refuse to start");
  });
});

describe("ticketFindings", () => {
  const full = "Outcome: a. Scope: b. Excludes: none. Acceptance: d. Behaviour: e. Verification: f. Prerequisites: none. Assumptions: n/a.";
  const t = (id: string, title: string, description: string, blockedBy: string[] = []) => ({ id, title, description, status: "open", blockedBy });
  it("flags missing template fields, unresolved and self dependencies, and spares a well-formed checkpoint", () => {
    const findings = ticketFindings([
      t("T-001", "Catalogue", full),
      t("T-002", "Lending", "Do lending.", ["T-001", "T-009"]),
      t("T-003", "Checkpoint: owner reviews the catalogue", "Question: is the list right?", ["T-003"]),
    ]);
    expect(findings).toContain('T-002 "Lending" lacks Outcome:, Scope:, Excludes:, Acceptance:, Behaviour:, Verification:, Prerequisites:, Assumptions:');
    expect(findings).toContain("T-002 blockedBy T-009, which no created ticket has");
    expect(findings).toContain("T-003 is blockedBy itself");
    expect(findings.some((f) => f.startsWith("T-001") || f.includes('"Checkpoint'))).toBe(false);
  });

  it("flags empty labels, and none on a label that must be concrete", () => {
    const findings = ticketFindings([
      t("T-001", "Export", "Outcome: Scope: Excludes: Acceptance: Behaviour: Verification: Prerequisites: Assumptions:"),
      t("T-002", "Import", "Outcome: none. Scope: a. Excludes: none. Acceptance: b. Behaviour: none. Verification: c. Prerequisites: none. Assumptions: none."),
    ]);
    expect(findings.find((f) => f.startsWith("T-001"))).toContain("leaves Outcome:, Scope:, Excludes:, Acceptance:, Behaviour:, Verification:, Prerequisites:, Assumptions: empty");
    expect(findings).toContain('T-002 "Import" leaves Outcome: empty');
  });

  it("treats a review feature as ordinary work and a checkpoint only by its title convention", () => {
    expect(isCheckpointTicket({ title: "Build review screen" })).toBe(false);
    expect(isCheckpointTicket({ title: "Acceptance tests for export" })).toBe(false);
    expect(isCheckpointTicket({ title: "Checkpoint: owner accepts the first version" })).toBe(true);
    const findings = ticketFindings([
      t("T-001", "Build review screen", ""),
      t("T-002", "Checkpoint: owner looks at the prototype", "The owner looks at it."),
    ]);
    expect(findings.some((f) => f.startsWith('T-001 "Build review screen" lacks'))).toBe(true);
    expect(findings).toContain('T-002 "Checkpoint: owner looks at the prototype" is a checkpoint with no Question: or Criteria:');
  });

  it("reports dependency cycles with their path and accepts a branching graph", () => {
    expect(dependencyCycles([t("A", "a", full, ["B"]), t("B", "b", full, ["A"])])).toEqual([["A", "B", "A"]]);
    expect(dependencyCycles([t("A", "a", full, ["B"]), t("B", "b", full, ["C"]), t("C", "c", full, ["A"])])).toEqual([["A", "B", "C", "A"]]);
    expect(dependencyCycles([t("A", "a", full), t("B", "b", full, ["A"]), t("C", "c", full, ["A"]), t("D", "d", full, ["B", "C"])])).toEqual([]);
    expect(ticketFindings([t("A", "a", full, ["B"]), t("B", "b", full, ["A"])])).toContain("dependency cycle: A -> B -> A");
  });

  it("reads the completion summary's counts", () => {
    expect(summaryCounts("Created 5 phases, 18 tickets, 3 issues.")).toEqual({ phases: 5, tickets: 18 });
    expect(summaryCounts("All done.")).toEqual({ phases: null, tickets: null });
  });
});

describe("transcript normalisation", () => {
  it("keeps nested agents' calls for auditing, so a nested reviewer running pytest is caught", () => {
    const t = claudeTurn([
      { type: "assistant", request_id: "r1", message: { model: "m", content: [{ type: "tool_use", id: "a1", name: "Agent", input: { prompt: "review the plan" } }] } },
      { type: "assistant", parent_tool_use_id: "a1", request_id: "n1", message: { model: "m", content: [{ type: "tool_use", id: "n1", name: "Bash", input: { command: "pytest -q" } }] } },
      { type: "user", parent_tool_use_id: "a1", message: { content: [{ type: "tool_result", tool_use_id: "n1", content: "3 passed" }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a1", content: "no findings" }] } },
      { type: "assistant", request_id: "r2", message: { model: "m", content: [{ type: "text", text: "Who uses it?" }] } },
      { type: "result", subtype: "success", result: "Who uses it?" },
    ]);
    expect(t.calls.find((c) => c.name === "Bash")?.nested).toBe(true);
    const stop = checkStop(t, ["discovery"]);
    expect(stop.ok).toBe(false);
    expect(stop.reasons.join()).toContain("[nested] pytest -q");
  });

  it("reports the client's terminal status", () => {
    expect(claudeTurn([{ type: "result", subtype: "success", result: "x" }]).terminal.status).toBe("completed");
    expect(claudeTurn([{ type: "result", subtype: "error_max_budget_usd", is_error: true }]).terminal.status).toBe("failed");
    expect(claudeTurn([]).terminal.status).toBe("missing");
    expect(codexTurn([{ type: "turn.completed" }]).terminal.status).toBe("completed");
    expect(codexTurn([{ type: "turn.failed", error: { message: "rate limited" } }]).terminal.detail).toContain("rate limited");
    expect(codexTurn([]).terminal.status).toBe("missing");
  });

  it("strips the MCP server prefix", () => {
    expect(bareToolName("mcp__storybloq__storybloq_init")).toBe("storybloq_init");
    expect(bareToolName("mcp__codex-bridge__review_plan")).toBe("review_plan");
    expect(bareToolName("Write")).toBe("Write");
  });

  it("reads a Claude turn's calls, final text and structured questions", () => {
    const t = claudeTurn([
      { type: "system", subtype: "init", session_id: "s-1" },
      { type: "assistant", request_id: "r1", message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id: "u1", name: "mcp__storybloq__storybloq_status", input: {} }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u1", content: "ok" }] } },
      { type: "assistant", request_id: "r2", message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id: "u2", name: "AskUserQuestion", input: { questions: [{ question: "How should I proceed with this setup?", options: [{ label: "Approve setup" }] }] } }] } },
      { type: "result", subtype: "success", result: "Here is the package." },
    ]);
    expect(t.calls.map((c) => c.name)).toEqual(["storybloq_status", "AskUserQuestion"]);
    expect(t.stopText).toContain("Here is the package.");
    expect(t.stopText).toContain("Approve setup");
    expect(t.sessionId).toBe("s-1");
    expect(t.models).toEqual(["claude-opus-5-5"]);
  });

  it("reads a Codex turn's commands, MCP calls, file changes and last message", () => {
    const t = codexTurn([
      { type: "thread.started", thread_id: "th-1" },
      { type: "item.completed", item: { type: "command_execution", command: "cat README.md", exit_code: 0 } },
      { type: "item.completed", item: { type: "mcp_tool_call", server: "storybloq", tool: "storybloq_init", arguments: { name: "x" }, status: "completed" } },
      { type: "item.completed", item: { type: "file_change", changes: [{ path: "CLAUDE.md", kind: "add" }], status: "completed" } },
      { type: "item.completed", item: { type: "agent_message", text: "first" } },
      { type: "item.completed", item: { type: "agent_message", text: "Approve setup?" } },
    ]);
    expect(t.calls.map((c) => c.name)).toEqual(["Bash", "storybloq_init", "Write"]);
    expect(t.stopText).toBe("Approve setup?");
    expect(t.sessionId).toBe("th-1");
  });

  it("reads the models a Codex thread ran on from its rollout turn contexts", () => {
    expect(codexRolloutModels([
      { type: "session_meta", payload: { id: "th-1" } },
      { type: "turn_context", payload: { model: "gpt-6-astra" } },
      { type: "response_item", payload: { model: "not-a-turn-context" } },
      { type: "turn_context", payload: { model: "gpt-6-astra" } },
      { type: "turn_context", payload: { model: "gpt-6-mini" } },
      { type: "turn_context", payload: {} },
    ])).toEqual(["gpt-6-astra", "gpt-6-mini"]);
  });
});

describe("onboarding fixtures", () => {
  const names = readdirSync(FIXTURES).filter((n) => existsSync(join(FIXTURES, n, "rubric.json"))).sort();

  it("has the seven stage-1 fixtures", () => {
    expect(names).toEqual(["brief-only", "conflicting-briefs", "empty-idea", "empty-scaffold", "existing-partial", "mixed-stack", "non-npm-tests"]);
  });

  it.each(names)("%s carries a rubric, an opening prompt and scripted owner turns", (name) => {
    const rubric = JSON.parse(readFileSync(join(FIXTURES, name, "rubric.json"), "utf-8")) as Record<string, unknown>;
    expect(rubric.fixture).toBe(name);
    expect(["empty", "brief-only", "existing", "interrupted"]).toContain(rubric.class);
    expect(Array.isArray(rubric.requirements) && rubric.requirements.length > 0).toBe(true);
    expect(["disabled", "same-command", "same-command-or-disabled", "disabled-or-components"]).toContain((rubric.expectedRecipe as { testStages: string }).testStages);
    expect(readFileSync(join(FIXTURES, name, "opening-prompt.txt"), "utf-8").trim().length).toBeGreaterThan(0);
    const script = ownerScript(readFileSync(join(FIXTURES, name, "owner-answers.md"), "utf-8"));
    expect(script.discovery.length).toBeGreaterThan(0);
    expect(script.adjustment.length).toBeGreaterThan(0);
    expect(script.approval).toContain("Approve setup");
  });

  it("materializes a standalone project: placeholders dropped, scaffold directories created", () => {
    const dest = mkdtempSync(join(tmpdir(), "t536-fixture-"));
    try {
      const empty = materializeFixture("empty-idea", join(dest, "a"));
      expect(readdirSync(empty)).toEqual([]);
      const scaffold = materializeFixture("empty-scaffold", join(dest, "b"));
      for (const d of ["tickets", "issues", "handovers", "notes", "lessons"]) expect(existsSync(join(scaffold, ".story", d))).toBe(true);
      expect(JSON.parse(readFileSync(join(scaffold, ".story", "roadmap.json"), "utf-8")).phases.map((p: { id: string }) => p.id)).toEqual(["p0"]);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it("digests links without following them: ancestor loops, external targets and dangling links", () => {
    const dir = mkdtempSync(join(tmpdir(), "t536-digest-"));
    const outside = mkdtempSync(join(tmpdir(), "t536-outside-"));
    try {
      mkdirSync(join(dir, "a"));
      writeFileSync(join(dir, "a", "f.txt"), "x");
      writeFileSync(join(outside, "secret.txt"), "outside");
      symlinkSync("..", join(dir, "a", "up"));
      symlinkSync(join(outside, "secret.txt"), join(dir, "ext"));
      symlinkSync("missing", join(dir, "dangling"));
      symlinkSync("a/f.txt", join(dir, "same"));
      const d = treeDigest(dir);
      expect(d["a/up"]).toBe("link:..");
      expect(d.ext).toBe(`link:${join(outside, "secret.txt")}`);
      expect(d.dangling).toBe("link:missing");
      expect(d.same).toBe("link:a/f.txt");
      expect(d["a/f.txt"]).not.toBe(d.same);
      expect(Object.keys(d).some((k) => k.startsWith("a/up/"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("digestChanges names every added, removed or changed path", () => {
    expect(digestChanges({ a: "1", b: "2" }, { a: "1", b: "3", c: "4" })).toEqual(["b", "c"]);
  });
});

describe("reviewer, degraded and verdict checks", () => {
  const call = (name: string, input: unknown, extra: Partial<EvalCall> = {}): EvalCall => ({ name, input, isError: false, result: "ok", ...extra });

  it("counts only successful reviewer invocations that returned something", () => {
    const r = reviewerInvocations([
      call("Bash", { command: "codex exec --output-schema s.json 'review'" }),
      call("review_plan", {}, { isError: true }),
      call("Agent", {}, { result: "" }),
      call("Agent", {}, { nested: true }),
      call("Bash", { command: "cat codex.md" }),
    ]);
    expect(r.map((x) => [x.via, x.ok])).toEqual([["codex-exec", true], ["review_plan", false], ["agent", false]]);
  });

  it("never offers a help or version probe as a review candidate, and carries each candidate's input and result", () => {
    const r = reviewerInvocations([
      call("Bash", { command: "codex exec --help" }, { result: "Usage: codex exec" }),
      call("Bash", { command: "codex --version" }, { result: "codex 1.0" }),
      call("Bash", { command: "codex exec -V" }, { result: "1.0" }),
      call("Bash", { command: "codex exec help" }, { result: "Usage" }),
      call("Bash", { command: "codex exec 'Review this plan: T-1 catalogue'" }, { result: "Findings: none" }),
      call("Agent", { prompt: "summarise the README" }, { result: "It is a tool library." }),
    ]);
    expect(r.map((x) => [x.via, x.index])).toEqual([["codex-exec", 4], ["agent", 5]]);
    expect(r[0]!.input).toContain("Review this plan: T-1 catalogue");
    expect(r[0]!.result).toBe("Findings: none");
    // An unrelated agent task is still only a candidate: the judge rules on it, citing its index.
    expect(r[1]!.input).toContain("summarise the README");
  });

  it("requires the degraded condition, then a search naming the creation tools after init and before the first creation", () => {
    const init = call("storybloq_init", {});
    const broad = call("ToolSearch", { query: "storybloq" });
    const named = call("ToolSearch", { query: "select:storybloq_phase_create,storybloq_ticket_create" });
    const create = call("storybloq_phase_create", {});
    expect(degradedFindings([init, named, create], ["Bash"])).toEqual([]);
    expect(degradedFindings([broad, init, create], ["Bash"]).join()).toContain("before any search naming");
    expect(degradedFindings([init, broad, create], ["Bash"]).join()).toContain("before any search naming");
    expect(degradedFindings([init, named, create], ["mcp__storybloq__storybloq_phase_create"]).join()).toContain("condition not established");
    expect(degradedFindings([init, named, create], null).join()).toContain("unproven");
    expect(degradedFindings([init, call("Bash", { command: "storybloq phase create --id a" })], ["Bash"])).toEqual([]);
    expect(degradedFindings([init, call("Bash", { command: "storybloq phase create --id a" }, { isError: true })], ["Bash"]).join()).toContain("nothing was created");
  });

  it("passes a run only with a clean record and a judge bound to its packet", () => {
    const packet = JSON.stringify({ runId: "r" });
    const lines = ["q", "c"];
    const judge = (over: Partial<JudgeResult> = {}): JudgeResult => ({ packetSha256: sha256(packet), observedModel: "gpt-6-astra", lines: [{ line: "q", verdict: "pass", reason: "" }, { line: "c", verdict: "pass", reason: "" }], ...over });
    expect(runVerdict(["x"], packet, judge(), lines).verdict).toBe("FAIL");
    expect(runVerdict([], packet, null, lines).verdict).toBe("PENDING_SEMANTIC");
    expect(runVerdict([], packet, judge(), lines).verdict).toBe("PASS");
    expect(runVerdict([], packet, judge({ packetSha256: "0" }), lines).verdict).toBe("FAIL");
    expect(runVerdict([], packet, judge({ observedModel: "" }), lines).verdict).toBe("FAIL");
    expect(runVerdict([], packet, judge({ lines: [{ line: "q", verdict: "pass", reason: "" }] }), lines).reasons.join()).toContain("did not rule on: c");
    expect(runVerdict([], packet, judge({ lines: [{ line: "q", verdict: "fail", reason: "re-asked" }, { line: "c", verdict: "pass", reason: "" }] }), lines).verdict).toBe("FAIL");
  });

  it("passes a bound line only when the judge cites candidates the packet offered", () => {
    const packet = JSON.stringify({ runId: "r" });
    const judge = (citations?: number[]): JudgeResult => ({ packetSha256: sha256(packet), observedModel: "gpt-6-astra", lines: [{ line: "rev", verdict: "pass", reason: "", ...(citations ? { citations } : {}) }] });
    expect(runVerdict([], packet, judge([4]), ["rev"], { rev: [4, 7] }).verdict).toBe("PASS");
    expect(runVerdict([], packet, judge(), ["rev"], { rev: [4] }).reasons.join()).toContain("without citing");
    expect(runVerdict([], packet, judge([]), ["rev"], { rev: [4] }).verdict).toBe("FAIL");
    expect(runVerdict([], packet, judge([4, 9]), ["rev"], { rev: [4] }).reasons.join()).toContain("cited 9");
    expect(runVerdict([], packet, judge([4]), ["rev"], { rev: [] }).verdict).toBe("FAIL");
  });
});

describe("runner safety", () => {
  it("quotes the launcher's paths so spaces, dollars, backticks and quotes stay literal", () => {
    const dir = mkdtempSync(join(tmpdir(), "t536 launch $HOME `id` 'q' \"d\"-"));
    try {
      const fakeNode = join(dir, "node $PATH `x`");
      writeFileSync(fakeNode, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
      chmodSync(fakeNode, 0o755);
      const cli = join(dir, "cli 'it''s' $(id) `id`.js");
      const launcher = join(dir, "storybloq");
      writeFileSync(launcher, launcherScript(fakeNode, cli));
      chmodSync(launcher, 0o755);
      const r = spawnSync(launcher, ["a b", "$HOME"], { encoding: "utf-8" });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(`${cli}\na b\n$HOME\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scrubs inherited client homes and identities, and refuses homes outside the scratch directory", () => {
    const scrubbed = scrubClientEnv({ PATH: "/bin", CODEX_HOME: "/real/.codex", CODEX_THREAD_ID: "t", CLAUDE_CONFIG_DIR: "/real", CLAUDE_CODE_SESSION_ID: "s", XDG_CONFIG_HOME: "/real/x", STORYBLOQ_CLIENT: "codex", CLAUDE_CODE_OAUTH_TOKEN: "tok" });
    expect(Object.keys(scrubbed).sort()).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "PATH"]);
    const work = "/tmp/eval-work";
    const ok = { HOME: `${work}/home`, CODEX_HOME: `${work}/home/.codex`, CLAUDE_CONFIG_DIR: `${work}/claude-config`, STORYBLOQ_GLOBAL_DIR: `${work}/g` };
    expect(isolationProblems(ok, work, "claude")).toEqual([]);
    expect(isolationProblems({ ...ok, CODEX_HOME: "/Users/me/.codex" }, work, "claude").join()).toContain("CODEX_HOME=/Users/me/.codex is outside");
    expect(isolationProblems({ HOME: ok.HOME }, work, "claude").join()).toContain("CODEX_HOME is not set");
    expect(isolationProblems({ ...ok, CODEX_THREAD_ID: "t" }, work, "codex").join()).toContain("CODEX_THREAD_ID is inherited");
    expect(isolationProblems({ HOME: ok.HOME, CODEX_HOME: ok.CODEX_HOME }, work, "codex")).toEqual([]);
  });

  it("splits the fixture into briefs and implementation files", () => {
    const dir = mkdtempSync(join(tmpdir(), "t536-evidence-"));
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "README.md"), "brief");
      writeFileSync(join(dir, "src", "app.py"), "def lend(): pass");
      writeFileSync(join(dir, "big.txt"), "x".repeat(20));
      const e = fixtureEvidence(dir, 18);
      expect(e.briefs["README.md"]).toBe("brief");
      expect(e.projectFiles["src/app.py"]).toBe("def lend(): pass");
      expect(e.briefs["big.txt"]).toContain("[truncated at 18 of 20 bytes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("asks for another review of a material adjustment only when review is available, and for disclosure of the skip otherwise", () => {
    const available = semanticLinesFor(false);
    expect(available).toContain(ADJUSTMENT_REVIEW_LINE);
    expect(available).toContain(REVIEW_LINE);
    expect(available).not.toContain(ADJUSTMENT_SKIP_LINE);
    const skipped = semanticLinesFor(true);
    expect(skipped).toContain(ADJUSTMENT_SKIP_LINE);
    expect(skipped).not.toContain(ADJUSTMENT_REVIEW_LINE);
    expect(skipped).not.toContain(REVIEW_LINE);
    expect(skipped.some((l) => /reviewed again/.test(l))).toBe(false);
  });

  it("finalizes a compliant reviewer-unavailable run with a material adjustment as PASS", () => {
    const lines = semanticLinesFor(true);
    const packet = JSON.stringify({ runId: "skip-run", semanticLines: lines, reviewSkipped: true });
    const record = { runId: "skip-run", failures: [], semanticLines: lines, bound: {}, packetSha256: sha256(packet) };
    const judge: JudgeResult = { packetSha256: sha256(packet), observedModel: "gpt-6-astra", lines: lines.map((line) => ({ line, verdict: "pass" as const, reason: "" })) };
    const r = finalizeRecord(record, packet, judge);
    expect(r.ok && r.verdict.verdict).toBe("PASS");
  });

  it("refuses to finalize a packet that belongs to another run, and leaves the record untouched", async () => {
    const judge: JudgeResult = { packetSha256: "", observedModel: "gpt-6-astra", lines: [] };
    const run = (id: string) => {
      const packet = JSON.stringify({ runId: id, semanticLines: ["q"] });
      return { packet, record: { runId: id, failures: [], semanticLines: ["q"], bound: {}, packetSha256: sha256(packet) } };
    };
    const a = run("run-a");
    const b = run("run-b");
    expect(finalizeRecord(a.record, b.packet, judge)).toEqual({ ok: false, reason: "the grading packet on disk does not match the hash this run recorded" });
    // Same bytes re-hashed into the record, but the packet names the other run.
    expect(finalizeRecord({ ...a.record, packetSha256: sha256(b.packet) }, b.packet, judge)).toEqual({ ok: false, reason: "the grading packet is for run run-b, not run-a" });
    expect(finalizeRecord({ ...a.record, semanticLines: ["other"] }, a.packet, judge).ok).toBe(false);
    const good = finalizeRecord(a.record, a.packet, { ...judge, packetSha256: sha256(a.packet), lines: [{ line: "q", verdict: "pass", reason: "" }] });
    expect(good.ok && good.verdict.verdict).toBe("PASS");

    const dir = mkdtempSync(join(tmpdir(), "t536-finalize-"));
    try {
      const recordText = JSON.stringify(a.record);
      writeFileSync(join(dir, "record.json"), recordText);
      writeFileSync(join(dir, "grading-packet.json"), b.packet);
      writeFileSync(join(dir, "judge.json"), JSON.stringify({ ...judge, packetSha256: sha256(b.packet) }));
      await expect(finalize(["--finalize", dir, "--judge", join(dir, "judge.json")])).rejects.toThrow("does not match the hash");
      expect(readFileSync(join(dir, "record.json"), "utf-8")).toBe(recordText);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("regressions from the 2026-09-27 Codex batch", () => {
  const RUNS = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "onboarding-eval-runs");
  const verbatim = <T>(name: string): T => JSON.parse(readFileSync(join(RUNS, name), "utf-8")) as T;
  const run1Command = verbatim<string>("run1-command.json");

  it("ends option parsing before the prompt on every client form, so a `- ` answer is the prompt (run 3)", () => {
    const base = { model: "m", project: "/p", claudeArgs: ["--disallowedTools", "Agent", "Task"], sessionId: "s" };
    for (const spec of [
      { ...base, client: "codex" as const, first: true },
      { ...base, client: "codex" as const, first: false },
      { ...base, client: "claude" as const, first: true },
      { ...base, client: "claude" as const, first: false },
    ]) {
      const args = turnArgs(spec, "- ");
      expect(args.slice(-2), `${spec.client} first=${spec.first}`).toEqual(["--", "- "]);
      expect(args.indexOf("--"), `${spec.client} first=${spec.first}`).toBe(args.length - 2);
    }
    expect(turnArgs({ ...base, client: "codex", first: false }, "x").slice(0, 3)).toEqual(["exec", "resume", "s"]);
    expect(turnArgs({ ...base, client: "claude", first: true }, "x")).toEqual(["-p", "--disallowedTools", "Agent", "Task", "--session-id", "s", "--", "x"]);
  });

  it("reads run 1's reviewer launch as no write: `git init` in a prompt argument is data (run 1)", () => {
    expect(run1Command).toContain("git init");
    expect(writeCalls([bash(run1Command)])).toEqual([]);
  });

  it("detects writes structurally, through lists, pipelines and nested shells", () => {
    const writes = [
      "cd x && git init", "git -C web init", "true; git init", "/bin/zsh -lc \"cd x && git init\"", "bash -c 'sh -c \"git init\"'",
      "npx storybloq init", "npx -y @storybloq/storybloq@latest ticket create --title t", "eval 'git init'", "echo \"$(git init)\"",
      "echo hi > CLAUDE.md", "zsh -lc 'echo hi >> notes.md'", "cat a | tee b",
    ];
    for (const cmd of writes) expect(writeCalls([bash(cmd)]), cmd).toHaveLength(1);
    const reads = [
      "codex exec 'Review: the package will git init and storybloq init'", "echo \"a > b\"", "grep -n 'git init' notes.md",
      "zsh -lc \"codex exec 'then echo x > y'\"", "git status", "storybloq status",
    ];
    for (const cmd of reads) expect(writeCalls([bash(cmd)]), cmd).toEqual([]);
  });

  it("classifies run 1's multi-line nested command once: the process substitution inside, not the wrapper outside (run 1)", () => {
    const hits = executionCalls([bash(run1Command)]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe("review");
    expect(hits[0]!.segment).toMatch(/--output-schema <\($/);
    expect(hits[0]!.segment).not.toContain("zsh");
  });

  it("still reviews a construct the wrapper's own shell runs, and one inside a live double-quoted substitution", () => {
    expect(reviews("zsh -lc \"echo $(date)\"")).toHaveLength(1);
    expect(reviews("echo \"`date`\"")).toHaveLength(1);
    expect(reviews("echo 'no $(sub) here'")).toEqual([]);
    expect(reviews("cat <<EOF\nx\nEOF")).not.toEqual([]);
  });

  it("reads run 1's stop as semantic, candidate package: its closing paragraph carries words beyond a citation (run 1)", () => {
    const stop = checkStop(turn(verbatim<string>("run1-stop.json")), ["discovery", "package"]);
    expect(stop).toMatchObject({ kind: "semantic", candidate: "package", ok: true });
    expect(stopRoute(stop)).toBe("package");
  });

  it("reads run 2's stop as semantic, candidate discovery, and the run goes to the judge with that line required (run 2)", () => {
    const text = verbatim<string>("run2-stop.json");
    const stop = checkStop(turn(text), ["discovery", "package"]);
    expect(stop).toMatchObject({ kind: "semantic", candidate: "discovery", ok: true, reasons: [] });
    expect(stopRoute(stop)).toBe("discovery");
    const line = semanticStopLine("opening", "discovery");
    expect(line).toContain("opening");
    const packet = JSON.stringify({ turns: [{ label: "opening", assistant: text }] });
    expect(runVerdict([], packet, null, [line]).verdict).toBe("PENDING_SEMANTIC");
    const ruled = (verdict: "pass" | "fail"): JudgeResult => ({ packetSha256: sha256(packet), observedModel: "m", lines: [{ line, verdict, reason: "r" }] });
    expect(runVerdict([], packet, ruled("pass"), [line]).verdict).toBe("PASS");
    expect(runVerdict([], packet, ruled("fail"), [line]).verdict).toBe("FAIL");
    expect(runVerdict([], packet, { ...ruled("pass"), lines: [] }, [line]).verdict).toBe("FAIL");
  });

  it("drops a trailing paragraph only when nothing remains after its marker, links, paths, punctuation and the connective allowlist", () => {
    expect(readStop("Who uses it?\n\nSee [setup-flow.md](x).\n\nSource: the skill.")).toEqual({ kind: "semantic", candidate: "discovery" });
    expect(readStop("Who uses it?\n\n[setup-flow.md](x)")).toEqual({ kind: "semantic", candidate: "discovery" });
    expect(readStop("Who uses it?\n\n`.story/skills/setup-flow.md`")).toEqual({ kind: "semantic", candidate: "discovery" });
    // A relative slash token is not an explicit citation form: residue, so the judge rules.
    expect(classifyStop("Who uses it?\n\n`skills/story/setup-flow.md`")).toBe("semantic");
    expect(readStop("Who uses it?\n\nThis comes from the story skill's [setup-flow.md](x).")).toEqual({ kind: "semantic", candidate: "discovery" });
    expect(readStop("Who uses it?\n\nPer the guidance document from `SKILL.md`.")).toEqual({ kind: "semantic", candidate: "discovery" });
    expect(isCitationOnly("Source: the skill’s file.")).toBe(true);
    // Allowlist words alone are not a citation: it needs a marker, a link or a path.
    expect(isCitationOnly("The skill.")).toBe(false);
    // Any residue keeps the paragraph, whatever its words: the judge rules on it.
    for (const residue of [
      "The [setup flow](x) asks this before planning.",
      "Note: the setup flow asks this first.",
      "I will assume librarians, per [the brief](x).",
      "See [the guide](x). The other workflow applies instead.",
      "Per [the brief](x), librarians rather than members.",
      "See [the guide](x) and pick a workflow.",
    ]) {
      expect(isCitationOnly(residue)).toBe(false);
      expect(readStop(`Who uses it?\n\n${residue}`)).toEqual({ kind: "semantic", candidate: "discovery" });
    }
    expect(classifyStop("Who uses it?\n\nSee [a](x).\n\nPlease pick one.\n\nSource: the skill.")).toBe("semantic");
    expect(classifyStop("Created 3 phases.")).toBe("none");
    expect(classifyStop("Created 3 phases.\n\nSee [docs](x).")).toBe("none");
    // Options named in prose are not the option list: the judge rules on the sentence around them.
    expect(readStop("Would you like to __approve setup__, *adjust the plan* or INSPECT DETAILS?")).toEqual({ kind: "semantic", candidate: "package" });
    expect(readStop("Would you like to approve setup or adjust the plan?")).toEqual({ kind: "semantic", candidate: "discovery" });
    expect(readStop("Would you like to approve, adjust or inspect?")).toEqual({ kind: "semantic", candidate: "discovery" });
    expect(readStop("Would you like to disapprove setup, readjust the plan or reinspect details?")).toEqual({ kind: "semantic", candidate: "discovery" });
    expect(STOP_RULE_VERSION).toMatch(/^2026-09-27\.13:/);
  });

  it("keeps link labels, bare words with a slash or a dot, and any question as residue: each ending is semantic with one judge line (Codex round 3)", () => {
    const options = "Here is the package.\n- Approve setup\n- Adjust the plan\n- Inspect details";
    for (const ending of ["Next.js", "yes/no", "[Choose a different workflow](https://example.com)", "See [the guide](x)?"]) {
      expect(isCitationOnly(ending)).toBe(false);
      const stop = checkStop(turn(`${options}\n\n${ending}`), ["discovery", "package"]);
      expect(stop).toMatchObject({ kind: "semantic", candidate: "package" });
      expect(runSemanticLines(false, [{ label: "opening", stop }], { source: "fixed set", patterns: [] })).toEqual([...semanticLinesFor(false), semanticStopLine("opening", "package")]);
      expect(runVerdict([], "{}", null, [semanticStopLine("opening", "package")]).verdict).toBe("PENDING_SEMANTIC");
    }
    expect(isCitationOnly("See [setup-flow.md](https://example.com).")).toBe(true);
    expect(isCitationOnly("Source: .story/config.json")).toBe(true);
    expect(isCitationOnly("Source: /private/tmp/x/setup-flow.md")).toBe(true);
    expect(isCitationOnly("Source: `SKILL.md`.")).toBe(true);
    expect(isCitationOnly("Source: skills/story")).toBe(false);
    expect(isCitationOnly("Source: setup-flow.md")).toBe(true);
    expect(isCitationOnly("Source: ./docs/setup-flow.md")).toBe(true);
    expect(isCitationOnly("Source: ~/notes/setup-flow.md")).toBe(true);
    expect(isCitationOnly("Source: notes.txt")).toBe(false);
    expect(isCitationOnly("Source: the [setup-flow.md](x)?")).toBe(false);
    // One word outside the allowlist is residue, however long or short.
    expect(isCitationOnly("Source: the [skill](x), definitively.")).toBe(false);
    expect(isCitationOnly("Source: the [skill](x), so.")).toBe(false);
    expect(isCitationOnly("Source: the [skill](x).")).toBe(true);
  });

  it("strips a slash token only in an explicit citation form: a relative slash token is residue, bare or as a link label (Codex round 4)", () => {
    const options = "Here is the package.\n- Approve setup\n- Adjust the plan\n- Inspect details";
    for (const ending of ["Node.js/Next.js", "[Node.js/Next.js](https://example.com)", "Source: docs/setup-flow.md"]) {
      expect(isCitationOnly(ending)).toBe(false);
      for (const [question, candidate] of [["Which stack should we use?", "discovery"], [options, "package"]] as const) {
        const stop = checkStop(turn(`${question}\n\n${ending}`), ["discovery", "package"]);
        expect(stop).toMatchObject({ kind: "semantic", candidate });
        expect(runSemanticLines(false, [{ label: "opening", stop }], { source: "fixed set", patterns: [] })).toEqual([...semanticLinesFor(false), semanticStopLine("opening", candidate)]);
      }
    }
  });

  it("keeps a package clean after a non-option closing paragraph only when it is exactly one listed selection question (Codex rounds 5 and 6)", () => {
    const options = "Here is the package.\n- Approve setup\n- Adjust the plan\n- Inspect details";
    const forms = ["Which would you like?", "Which one would you like?", "Which would you like to do?", "What would you like to do?", "How would you like to proceed?",
      "Which option do you prefer?", "Which do you prefer?", "Which one should we pick?", "Which should we do?"];
    for (const plain of [...forms, "**Which would you like?**", "  which  WOULD you   like?  "]) {
      expect(readStop(`${options}\n\n${plain}`)).toEqual({ kind: "package", candidate: null });
    }
    for (const other of [
      "I choose option one. Should we proceed?", "I choose option one. Which would you like?", "Which would you like? I recommend approving.",
      "Should I deploy now?", "Which would you like, Node.js/Next.js?", "Which would you like to deploy?", "Would you like which?", "**Should I deploy now?**", "Which should we do.",
      "See [the guide](x)?", "Which would you like, per [the brief](x)?", "Which would you like, given setup-flow.md?", "See the setup guidance before choosing?",
    ]) {
      const stop = checkStop(turn(`${options}\n\n${other}`), ["discovery", "package"]);
      expect(stop).toMatchObject({ kind: "semantic", candidate: "package" });
      expect(runSemanticLines(false, [{ label: "opening", stop }], { source: "fixed set", patterns: [] })).toEqual([...semanticLinesFor(false), semanticStopLine("opening", "package")]);
    }
    // The bold non-form question is semantic through the package rule itself: without the options it is a discovery question, and the judge rules on it.
    expect(readStop("**Should I deploy now?**")).toEqual({ kind: "semantic", candidate: "discovery" });
    expect(readStop("**Who uses it?**\n\nSource: the skill.")).toEqual({ kind: "semantic", candidate: "discovery" });
  });

  it("keeps a package clean only when its closing paragraph is the option list, with at most one listed prefix line, or one listed selection question (Codex rounds 9 and 10)", () => {
    const list = "- Approve setup\n- Adjust the plan\n- Inspect details";
    // The skill's package question, verbatim from setup-flow.md: `- question: "How should I proceed with this setup?"`.
    const skillQuestion = "How should I proceed with this setup?";
    const ask = { type: "assistant", request_id: "q", message: { model: "m", content: [{ type: "tool_use", id: "q", name: "AskUserQuestion", input: { questions: [{ question: skillQuestion, options: [{ label: "Approve setup" }, { label: "Adjust the plan" }, { label: "Inspect details" }] }] } }] } };
    // The structured path: with no result text the rendered question is read like any ending, and it is the option list.
    const bare = claudeTurn([ask, { type: "result", subtype: "success", result: "" }]);
    expect(bare.stopText).toBe(`${skillQuestion}\nApprove setup\nAdjust the plan\nInspect details`);
    expect(readTurnStop(bare)).toEqual({ kind: "package", candidate: null });
    expect(checkStop(bare, ["package"])).toMatchObject({ kind: "package", ok: true });
    // Whitespace-only result text is no text.
    expect(readTurnStop(claudeTurn([ask, { type: "result", subtype: "success", result: " \n " }]))).toEqual({ kind: "package", candidate: null });
    // Any result text before it is prose the harness does not validate: semantic, one judge line, candidate from the question's shape.
    // A preamble ending in a blank line leaves the rendered question as its own paragraph, so only the structured rule sends it to the judge.
    for (const preamble of ["I selected Approve setup for you.", "Here is the package.", "I selected Approve setup for you.\n\n"]) {
      const asked = claudeTurn([ask, { type: "result", subtype: "success", result: preamble }]);
      expect(asked.stopText).toBe(`${preamble}\n${skillQuestion}\nApprove setup\nAdjust the plan\nInspect details`);
      const stop = checkStop(asked, ["discovery", "package"]);
      expect(stop, preamble).toMatchObject({ kind: "semantic", candidate: "package", ok: true });
      expect(runSemanticLines(false, [{ label: "opening", stop }], { source: "fixed set", patterns: [] })).toEqual([...semanticLinesFor(false), semanticStopLine("opening", "package")]);
    }
    // The preamble is every main-agent text block before the question, not the result text alone; stopText (the packet's assistant ending) carries it.
    const said = "I selected Approve setup for you.";
    const askBlock = ask.message.content[0]!;
    const sameMessage = claudeTurn([{ type: "assistant", request_id: "q", message: { model: "m", content: [{ type: "text", text: said }, askBlock] } }, { type: "result", subtype: "success", result: "" }]);
    const earlierMessage = claudeTurn([
      { type: "assistant", request_id: "t", message: { model: "m", content: [{ type: "text", text: said }] } },
      { type: "assistant", request_id: "b", message: { model: "m", content: [{ type: "tool_use", id: "b", name: "Bash", input: { command: "ls" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b", content: "ok" }] } },
      ask, { type: "result", subtype: "success", result: "" },
    ]);
    for (const t of [sameMessage, earlierMessage]) {
      expect(t.stopText).toBe(`${said}\n${skillQuestion}\nApprove setup\nAdjust the plan\nInspect details`);
      const stop = checkStop(t, ["discovery", "package"]);
      expect(stop).toMatchObject({ kind: "semantic", candidate: "package" });
      expect(runSemanticLines(false, [{ label: "opening", stop }], { source: "fixed set", patterns: [] })).toEqual([...semanticLinesFor(false), semanticStopLine("opening", "package")]);
    }
    // A result that repeats the last text block is counted once.
    expect(claudeTurn([{ type: "assistant", request_id: "q", message: { model: "m", content: [{ type: "text", text: said }, askBlock] } }, { type: "result", subtype: "success", result: said }]).stopText)
      .toBe(`${said}\n${skillQuestion}\nApprove setup\nAdjust the plan\nInspect details`);
    // Nested agents' text is not the main agent's and adds nothing.
    expect(readTurnStop(claudeTurn([{ type: "assistant", parent_tool_use_id: "a0", request_id: "n", message: { model: "m", content: [{ type: "text", text: said }] } }, ask, { type: "result", subtype: "success", result: "" }]))).toEqual({ kind: "package", candidate: null });
    const askWho = { type: "assistant", request_id: "w", message: { model: "m", content: [{ type: "tool_use", id: "w", name: "AskUserQuestion", input: { questions: [{ question: "Who uses it?", options: [{ label: "Librarians" }, { label: "Members" }] }] } }] } };
    expect(readTurnStop(claudeTurn([askWho, { type: "result", subtype: "success", result: "I will assume librarians." }]))).toEqual({ kind: "semantic", candidate: "discovery" });
    expect(readTurnStop(claudeTurn([askWho, { type: "result", subtype: "success", result: "  \n" }]))).toEqual({ kind: "semantic", candidate: "discovery" });
    for (const clean of [
      `Here is the package.\n\n${list}`, `Here is the package.\n\n${skillQuestion}\n${list}`, `Here is the package.\n\nWhich would you like?\n${list}`,
      "Here is the package.\n\n1. **Approve setup**\n2. Adjust the plan\n3. inspect details", `Here is the package.\n\n${list}\n\nWhich would you like?`,
    ]) {
      expect(readStop(clean), clean).toEqual({ kind: "package", candidate: null });
    }
    for (const ending of [
      `I selected Approve setup for you.\n${list}`, `Here are your options:\n${list}`, `Here is the package.\n${list}`,
      `Which would you like?\nI selected Approve setup for you.\n${list}`, `${skillQuestion}\nWhich would you like?\n${list}`,
      `Here is the package.\n\n${list}\n\nI selected Approve setup for you.`, `Here is the package.\n\n${list}\n\nI recommend Approve setup. Which would you like?`,
      `Here is the package.\n\n${list}\nI picked Approve setup.`, "I chose Approve setup over Adjust the plan.\n- Inspect details",
      "Here is the package.\n\n- Approve setup (recommended)\n- Adjust the plan\n- Inspect details", "Here is the package.\n\n- Approve setup\n- Adjust the plan\n- Inspect details\n- Approve setup",
      "You could also Adjust the plan.\n\n- Approve setup\n- Approve setup\n- Inspect details",
      "Approve setup / Adjust the plan / Inspect details",
    ]) {
      const stop = checkStop(turn(ending), ["discovery", "package"]);
      expect(stop, ending).toMatchObject({ kind: "semantic", candidate: "package", ok: true });
      expect(runSemanticLines(false, [{ label: "opening", stop }], { source: "fixed set", patterns: [] })).toEqual([...semanticLinesFor(false), semanticStopLine("opening", "package")]);
    }
    // Options spread over three paragraphs never read as a package: the stop fails as unexpected rather than passing clean.
    const spread = "Here is the package.\n- Approve setup\n\n- Adjust the plan\n\n- Inspect details";
    expect(readStop(spread)).toEqual({ kind: "none", candidate: null });
    expect(checkStop(turn(spread), ["discovery", "package"]).ok).toBe(false);
  });

  it("never keeps a discovery stop clean: any question in an ending without the package is semantic with one judge line (Codex round 8)", () => {
    for (const asked of [
      "Who uses it?", "**Who uses it?**", "Some context first.\n\nWho uses it?",
      "I will assume librarians, so should I proceed?", "I will assume librarians; should I proceed?", "I will assume librarians.Should I proceed?",
      "Who uses it?\n\n**I will assume librarians. Should I proceed?**", "Who uses it?\n\nI will assume librarians. Should I proceed?",
      "Who uses it? Librarians, I assume.", "I will assume librarians. Who uses it?",
    ]) {
      const stop = checkStop(turn(asked), ["discovery", "package"]);
      expect(stop, asked).toMatchObject({ kind: "semantic", candidate: "discovery", ok: true });
      expect(stopRoute(stop)).toBe("discovery");
      expect(runSemanticLines(false, [{ label: "opening", stop }], { source: "fixed set", patterns: [] })).toEqual([...semanticLinesFor(false), semanticStopLine("opening", "discovery")]);
    }
    for (const done of ["Created 3 phases. All done.", "Created 3 phases.\n\nSource: the skill."]) {
      expect(readStop(done)).toEqual({ kind: "none", candidate: null });
      expect(checkStop(turn(done), ["discovery", "package"]).ok).toBe(false);
    }
    const options = "Here is the package.\n- Approve setup\n- Adjust the plan\n- Inspect details";
    for (const form of ["Which would you like?", "Which one would you like?", "Which would you like to do?", "What would you like to do?", "How would you like to proceed?",
      "Which option do you prefer?", "Which do you prefer?", "Which one should we pick?", "Which should we do?"]) {
      expect(readStop(`${options}\n\n${form}`)).toEqual({ kind: "package", candidate: null });
    }
  });

  it("does not strip either Codex example, and neither passes its stop check as clean (Codex rounds 1 and 2)", () => {
    const redirect = "Approve setup / Adjust the plan / Inspect details\n\nSee [the guide](x). Please choose a different workflow there.";
    const librarians = "Who uses it?\n\nPer [the brief](x), librarians.";
    expect(isCitationOnly("See [the guide](x). Please choose a different workflow there.")).toBe(false);
    expect(isCitationOnly("Per [the brief](x), librarians.")).toBe(false);
    expect(readStop(redirect)).toEqual({ kind: "semantic", candidate: "package" });
    expect(readStop(librarians)).toEqual({ kind: "semantic", candidate: "discovery" });
    expect(classifyStop("Approve setup / Adjust the plan / Inspect details\n\nChoose a different workflow at [the guide](url).")).toBe("semantic");
  });

  it("reads quoted executable names like the shell does: eval, source, xargs and find -exec are reviewed, and a write behind them counts", () => {
    expect(reviews(`"eval" "npm test"`)).toEqual(["eval npm test [eval]"]);
    expect(reviews(`'xargs' npm test`)).toEqual(["xargs npm test [xargs]"]);
    expect(reviews(`"source" ./env.sh`)).toEqual(["source ./env.sh [source]"]);
    expect(reviews(`find . "-exec" rm x ";"`)).toHaveLength(1);
    expect(reviews("echo eval xargs source")).toEqual([]);
    expect(writeCalls([bash(`"eval" "git init"`)])).toHaveLength(1);
    expect(writeCalls([bash(`xargs -I{} git init`)])).toHaveLength(1);
    expect(writeCalls([bash(`echo "eval git init"`)])).toEqual([]);
  });

  it("matches a gitignore ** segment across zero directories, so a re-included config write is still reported (Codex round 1)", () => {
    const exclusion = { source: ".story/.gitignore" as const, patterns: ["*", "!**/config.json"] };
    expect(isRuntimeState(".story/config.json", exclusion)).toBe(false);
    expect(isRuntimeState(".story/a/b/config.json", exclusion)).toBe(false);
    expect(digestChanges({}, { ".story/config.json": "x", ".story/telemetry/p.json": "y" }, exclusion)).toEqual([".story/config.json"]);
    const inner = { source: ".story/.gitignore" as const, patterns: ["/sessions/**/state.json", "cache/**"] };
    expect(isRuntimeState(".story/sessions/state.json", inner)).toBe(true);
    expect(isRuntimeState(".story/sessions/a/b/state.json", inner)).toBe(true);
    expect(isRuntimeState(".story/cache/x/y.json", inner)).toBe(true);
    expect(isRuntimeState(".story/tickets/state.json", inner)).toBe(false);
  });

  it("disables exclusion entirely when .story/.gitignore holds a pattern form it cannot read: every change reported, never clean (Codex round 2)", () => {
    const work = mkdtempSync(join(tmpdir(), "eval-exclusion-"));
    try {
      const project = materializeFixture("empty-scaffold", work);
      writeFileSync(join(project, ".story", ".gitignore"), "/sessions/\n!/sessions/important[.]json\n");
      const exclusion = runtimeExclusion(project);
      expect(exclusion).toEqual({ source: "disabled", patterns: [], unsupported: "!/sessions/important[.]json" });
      const changes = digestChanges({ ".story/sessions/important.json": "a" }, { ".story/sessions/important.json": "b", ".story/servers/a": "y" }, exclusion);
      expect(changes).toEqual([".story/servers/a", ".story/sessions/important.json"]);
      expect(treeCheckOutcome("opening", changes, exclusion)).toEqual({ clean: false, failure: null, judge: true });
      expect(treeCheckOutcome("opening", [], exclusion)).toEqual({ clean: false, failure: null, judge: true });
      expect(TREE_EXCLUSION_LINE).toContain("unsupported");
      writeFileSync(join(project, ".story", ".gitignore"), "a**b\n");
      expect(runtimeExclusion(project)).toMatchObject({ source: "disabled", unsupported: "a**b" });
      rmSync(join(project, ".story", ".gitignore"));
      expect(runtimeExclusion(project).source).toBe("fixed set");
      mkdirSync(join(project, ".story", ".gitignore"));
      expect(runtimeExclusion(project).source).toBe("disabled");
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

  it("requires a judge line per semantic stop and, with exclusion disabled, the tree line even when nothing changed", () => {
    const disabled = { source: "disabled" as const, patterns: [], unsupported: "a**b" };
    const fixed = { source: "fixed set" as const, patterns: ["/sessions/"] };
    const turns = [
      { label: "opening", stop: { kind: "semantic" as const, candidate: "discovery" as const } },
      { label: "discovery-1", stop: { kind: "package" as const, candidate: null } },
      { label: "approve", stop: null },
    ];
    const base = semanticLinesFor(false);
    expect(runSemanticLines(false, turns, fixed)).toEqual([...base, semanticStopLine("opening", "discovery")]);
    expect(runSemanticLines(false, turns, disabled)).toEqual([...base, semanticStopLine("opening", "discovery"), TREE_EXCLUSION_LINE]);
    expect(runSemanticLines(false, turns.slice(1), fixed)).toEqual(base);
    expect(runSemanticLines(false, turns.slice(1, 2), disabled)).toEqual([...base, TREE_EXCLUSION_LINE]);
  });

  it("fails the tree check mechanically on a reported change while exclusion is in force", () => {
    const exclusion = { source: "fixed set" as const, patterns: ["/sessions/"] };
    expect(treeCheckOutcome("opening", [".story/config.json"], exclusion)).toEqual({ clean: false, failure: "opening: project changed before approval: .story/config.json", judge: false });
    expect(treeCheckOutcome("opening", [], exclusion)).toEqual({ clean: true, failure: null, judge: false });
  });

  it("ignores the runtime state minted under .story before approval, per the fixture's .story/.gitignore (run 4)", () => {
    const work = mkdtempSync(join(tmpdir(), "eval-exclusion-"));
    try {
      const exclusion = runtimeExclusion(materializeFixture("empty-scaffold", work));
      expect(exclusion.source).toBe(".story/.gitignore");
      const changed = verbatim<string[]>("run4-tree-changes.json");
      const after = Object.fromEntries(changed.map((k) => [k, k.endsWith("/") ? "dir" : "x"]));
      expect(digestChanges({}, after)).toEqual(changed);
      expect(digestChanges({}, after, exclusion)).toEqual([]);
      expect(digestChanges({}, { ...after, ".story/tickets/T-001.json": "x", "notes.md": "y" }, exclusion)).toEqual([".story/tickets/T-001.json", "notes.md"]);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

  it("uses the fixed runtime set without a .story/.gitignore, and never excludes a .story it did not only mint", () => {
    const work = mkdtempSync(join(tmpdir(), "eval-exclusion-"));
    try {
      const exclusion = runtimeExclusion(materializeFixture("brief-only", work));
      expect(exclusion.source).toBe("fixed set");
      const minted = { ".story/": "dir", ".story/telemetry/": "dir", ".story/telemetry/presence/": "dir", ".story/telemetry/presence/a.json": "x", ".story/.lock": "x" };
      expect(digestChanges({}, minted, exclusion)).toEqual([]);
      expect(digestChanges({}, { ...minted, ".story/config.json": "x" }, exclusion)).toEqual([".story/", ".story/config.json"]);
      expect(digestChanges({}, { ".story/": "dir" }, exclusion)).toEqual([".story/"]);
      expect(isRuntimeState("telemetry/a.json", exclusion)).toBe(false);
      expect(isRuntimeState(".story/tickets/telemetry/a.json", exclusion)).toBe(false);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });

  it("applies gitignore order: a later negation re-includes", () => {
    const exclusion = { source: ".story/.gitignore" as const, patterns: ["sessions/", "!sessions/keep.json", "*.tmp"] };
    expect(isRuntimeState(".story/sessions/a/state.json", exclusion)).toBe(true);
    expect(isRuntimeState(".story/sessions/keep.json", exclusion)).toBe(false);
    expect(isRuntimeState(".story/tickets/x.tmp", exclusion)).toBe(true);
    expect(isRuntimeState(".story/tickets/x.json", exclusion)).toBe(false);
  });
});
