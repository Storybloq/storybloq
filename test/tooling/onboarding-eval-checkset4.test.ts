/**
 * T-536 skill fix batch 4: check set 4. The exec wrapper read through its string, one literal loop unrolled, one
 * post-approval python heredoc judged instead of needs-review, one shared call analysis with approval context, the
 * fixed line above the question, trailing spaces on the closing lines, the reviewer capability record (G2), the finding
 * lines for a review that did not approve, and the read-only cross-check. The check set 1-3 output is pinned byte for
 * byte. Every export is read through its module namespace, so a missing one fails its own test, not the file.
 */
import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import * as lib from "../../scripts/onboarding-eval-lib.js";
import type { EvalCall, EvalTurn, RuntimeExclusion } from "../../scripts/onboarding-eval-lib.js";
import * as drv from "../../scripts/onboarding-eval-drive.js";
import type { DriveState, Rubric, StoryReader, TurnResponse, Variant } from "../../scripts/onboarding-eval-drive.js";
import * as run from "../../scripts/onboarding-eval-run.js";
import * as rg from "../../scripts/onboarding-eval-regrade.js";
import type { RegradeInput } from "../../scripts/onboarding-eval-regrade.js";
import { parseStream, sha256 } from "../../scripts/continuity-lib.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures", "onboarding");
const RUNS = join(HERE, "..", "fixtures", "onboarding-eval-runs", "regrade");
const EXCLUSION = (JSON.parse(readFileSync(join(RUNS, "a7-run6", "record", "record.json"), "utf-8")) as { treeExclusion: RuntimeExclusion }).treeExclusion;
const MIXED = lib.rubricFor(JSON.parse(readFileSync(join(FIXTURES, "mixed-stack", "rubric.json"), "utf-8")) as Record<string, unknown>, 4) as unknown as Rubric;
const SCRIPT = run.ownerScript("## Discovery answers\nVolunteers.\n\n## Adjustment turn\nRename ticket C.\n\n## Approval probe turn\nLooks interesting.\n\n## Affirmative approval turn\nYes, go ahead.\n");

// --- a synthetic Codex run (as in the check set 3 tests) ---------------------------------------------------------

type Item =
  | { readonly cmd: string; readonly out?: string; readonly exit?: number | null }
  | { readonly collab: "spawn_agent" | "wait"; readonly receivers: readonly string[]; readonly prompt?: string; readonly states?: Record<string, { status: string; message?: string }>; readonly failed?: boolean }
  | { readonly mcp: string; readonly args: unknown; readonly result: unknown };

interface Turn4 { readonly text: string; readonly items?: readonly Item[] }

function raw4(t: Turn4): string {
  const lines: unknown[] = [{ type: "thread.started", thread_id: "th" }];
  (t.items ?? []).forEach((it, k) => {
    const id = `item_${k}`;
    if ("cmd" in it) {
      lines.push({ type: "item.started", item: { id, type: "command_execution", command: it.cmd, aggregated_output: "", exit_code: null, status: "in_progress" } });
      lines.push({ type: "item.completed", item: { id, type: "command_execution", command: it.cmd, exit_code: it.exit === undefined ? 0 : it.exit, aggregated_output: it.out ?? "" } });
    } else if ("collab" in it) lines.push({ type: "item.completed", item: { id, type: "collab_tool_call", tool: it.collab, sender_thread_id: "th", receiver_thread_ids: it.receivers, prompt: it.prompt ?? null, agents_states: it.states ?? {}, status: it.failed ? "failed" : "completed" } });
    else {
      lines.push({ type: "item.started", item: { id, type: "mcp_tool_call", tool: it.mcp, arguments: it.args, status: "in_progress" } });
      lines.push({ type: "item.completed", item: { id, type: "mcp_tool_call", tool: it.mcp, arguments: it.args, result: it.result, status: "completed" } });
    }
  });
  lines.push({ type: "item.completed", item: { id: "msg", type: "agent_message", text: t.text } });
  lines.push({ type: "turn.completed" });
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

const parsed = (text: string): Record<string, unknown>[] => text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
const turnOf = (text: string, cs: number): EvalTurn => ({ ...lib.codexTurn(parsed(text), cs), models: [] });
const callsOf = (items: readonly Item[], cs = 4): readonly EvalCall[] => turnOf(raw4({ text: "x", items }), cs).calls;

/** One call's analysis in a turn with this label (after approval only for `approve`). */
const analyse = (cmds: readonly string[], label = "approve", cs = 4) => lib.analyseCalls(callsOf(cmds.map((cmd) => ({ cmd })), cs), [{ label, callRange: [0, cmds.length] }], cs);
const reviewOf = (cmds: readonly string[], label = "approve", cs = 4): string[] => [...analyse(cmds, label, cs).unresolved];
const executedOf = (cmds: readonly string[], label = "approve", cs = 4): string[] => analyse(cmds, label, cs).executions.filter((e) => e.kind === "execution").map((e) => e.segment);

interface Drive4 { readonly state: DriveState; readonly inspection: Record<string, unknown>; readonly raw: Map<string, string>; readonly evidence: ReturnType<typeof drv.finishDrive>; readonly semanticLines: string[]; readonly ledgerRecords: unknown[]; readonly afterPackage: ReturnType<typeof run.packageTurns> }

function drive(variant: Variant, turns: readonly Turn4[] | ((label: string) => Turn4), cs = 4, story: StoryReader = storyOf()): Drive4 {
  const afterPackage = run.packageTurns(variant, SCRIPT);
  const state = drv.newDriveState(cs);
  const raw = new Map<string, string>();
  const flow = drv.driveFlow({ variant, firstPrompt: "$story set it up", discoveryPrompt: SCRIPT.discovery, afterPackage, exclusion: EXCLUSION }, state);
  let n = 0;
  for (let step = flow.next(); !step.done;) {
    const t = typeof turns === "function" ? turns(step.value.label) : turns[n];
    if (!t) throw new Error(`the script has no turn ${n} (${step.value.label})`);
    const file = rg.turnFile(n, step.value.label);
    const text = raw4(t);
    raw.set(`${file}.jsonl`, text).set(`${file}.stderr.txt`, "");
    const response: TurnResponse = { turn: turnOf(text, cs), exitCode: 0, infraFailure: null, stderrPath: `/raw/${file}.stderr.txt`, treeChanges: () => [] };
    n++;
    step = flow.next(response);
  }
  if (Array.isArray(turns) && n !== turns.length) throw new Error(`the flow ended after ${n} of ${turns.length} scripted turns`);
  const evidence = drv.finishDrive(state, run.REVIEW_LINE);
  const semanticLines = run.runSemanticLines(state.reviewSkipped, state.turns, EXCLUSION, afterPackage.some((x) => x.label === "adjust"), cs, evidence.reviewLines, evidence.judgeLines ?? []);
  const { inspection, ledgerRecords } = drv.inspectAfter(state, story, MIXED, () => ({}), variant);
  return { state, inspection, raw, evidence, semanticLines, ledgerRecords, afterPackage };
}

const failuresOf = (s: DriveState, kind: string): string[] => s.failures.filter((_, i) => s.sources[i]!.kind === kind);
/** The ISS-1335 detectors: a review claimed with no reviewer behind it. */
const ISS1335 = /reviewer-unavailable stop never came|no successful supported reviewer invocation|matches no captured invocation|found no reviewer|a wait with no agent/;

function storyOf(): StoryReader {
  const stage = { enabled: true, command: "cd backend && pytest" };
  const files: Record<string, string> = {
    "config.json": JSON.stringify({ recipe: "coding", recipeOverrides: { stages: { WRITE_TESTS: stage, TEST: stage, BUILD: { enabled: false }, VERIFY: { enabled: false } } } }),
    "roadmap.json": JSON.stringify({ phases: [{ id: "p1" }] }),
    "tickets/T-001.json": JSON.stringify({ id: "T-001", title: "Book a class", status: "open", description: "Outcome: a member books, from brief.md\nScope: booking. Excludes: none\nAcceptance: a booking is saved\nBehaviour: none\nVerification: a test. Prerequisites: none. Assumptions: none" }),
    "notes/N-001.json": JSON.stringify({ content: "coverage map; review R1" }),
  };
  return {
    exists: (rel) => rel in files || Object.keys(files).some((k) => k.startsWith(`${rel}/`)),
    read: (rel) => { const t = files[rel]; if (t === undefined) throw new Error(`no ${rel}`); return t; },
    list: (rel) => Object.keys(files).filter((k) => k.startsWith(`${rel}/`)).map((k) => k.slice(rel.length + 1)),
  };
}

// --- builders ------------------------------------------------------------------------------------------------------

const FIXED = "Nothing is written until you choose Approve setup.";
const QUESTION = "How should I proceed with this setup?\nApprove setup\nAdjust the plan\nInspect details";
const CODEX = "/usr/local/bin/codex";
const probeLine = (printed: string): string => `Reviewer probe: \`command -v codex\` printed ${printed}`;
const result = (verdict: string, ref: string): string => `Independent review: ${verdict}, invocation ${ref}`;
const SKIP = "Independent review: skipped at the owner's request";
/** A check set 4 package: level, probe and status lines, the fixed line, one blank line, the four lines. */
const pkg = (status: string, probe: string | null = CODEX, above = ""): string =>
  [above, "Quality level: Full pipeline", probe === null ? status : `${probeLine(probe)}\n${status}`, FIXED, QUESTION].filter((x) => x !== "").join("\n\n");
const PENDING = "Verification tooling to establish: WRITE_TESTS (frontend): npm test (pending: no test files)\nVerification tooling to establish: TEST (frontend): npm test (pending: no test files)";
const summary = (status: string, probe: string | null = CODEX): string => ["Setup is approved and written.", probe === null ? status : `${probeLine(probe)}\n${status}`, PENDING].join("\n\n");

const probePath = (path = CODEX): Item => ({ cmd: "/bin/zsh -lc 'command -v codex'", out: `${path}\n`, exit: 0 });
const probeNothing: Item = { cmd: "/bin/zsh -lc 'command -v codex'", out: "", exit: 1 };
const exec = (id: string, verdict: string, findings: readonly string[] = []): Item => ({
  cmd: `codex exec --sandbox read-only --ephemeral --skip-git-repo-check --output-schema '/skill/setup-review-schema.json' - <<'STORYBLOQ_PLAN'\nReview id: ${id}\nPlan: two tickets.\nSTORYBLOQ_PLAN`,
  out: JSON.stringify({ verdict, findings }),
});
const reviewPlan = (id: string, verdict: string): Item => ({ mcp: "review_plan", args: { plan: `Review id: ${id}\nPlan: two tickets.` }, result: { structuredContent: { verdict, findings: [] } } });

/** The none variant under check set 4: package, inspect, adjust (a fresh review), approve. */
const cleanRun = (approveItems: readonly Item[] = []): Turn4[] => [
  { text: pkg(result("approve", "R1")), items: [probePath(), exec("R1", "approve")] },
  { text: pkg(result("approve", "R1")) },
  { text: pkg(result("approve", "R2")), items: [exec("R2", "approve")] },
  { text: summary(result("approve", "R2")), items: approveItems },
];

// --- verbatim attempt 9 shapes ---------------------------------------------------------------------------------------

/** Run 1 (brief-only, none), opening: the AGENTS.md ancestor walk. */
const RUN1_LOOP = "/bin/zsh -lc 'for p in /AGENTS.md /private/AGENTS.md /private/tmp/AGENTS.md /private/tmp/cc-cpm-w4-t536/AGENTS.md /private/tmp/cc-cpm-w4-t536/onboarding-eval-8D9Vsy/AGENTS.md; do if test -f \"$p\"; then cat \"$p\"; fi; done'";
/** Run 9 (non-npm-tests, reviewer-unavailable), opening: files read first, then the walk. */
const RUN9_LOOP = "/bin/zsh -lc 'cat pyproject.toml rota/__init__.py rota/schedule.py tests/test_schedule.py\nfor p in /AGENTS.md /tmp/AGENTS.md /tmp/cc-cpm-w4-t536/AGENTS.md /tmp/cc-cpm-w4-t536/onboarding-eval-nvWKkV/AGENTS.md; do if [ -f \"$p\" ]; then cat \"$p\"; fi; done'";
/** Run 3 (empty-idea), opening: a mixed-quote wrapper, so no single string to read. */
const RUN3_LOOP = "/bin/zsh -lc 'ls -la\nfor dir in /tmp /tmp/cc-cpm-w4-t536 /tmp/cc-cpm-w4-t536/onboarding-eval-dlmJYS /tmp/cc-cpm-w4-t536/onboarding-eval-dlmJYS/project; do if [ -f \"$dir/AGENTS.md\" ]; then cat \"$dir/AGENTS.md\"; fi; done\nrg --files --hidden -g '\"'\"'!.git'\"' -g '\"'!node_modules'\"'\ngit rev-parse --show-toplevel\"";
/** Run 1, approve: the REVIEW.md copy, then `git init` after the terminator. */
const RUN1_HEREDOC_INIT = "/bin/zsh -lc \"python3 - <<'PY'\nfrom pathlib import Path\nroot = Path.cwd()\nsource = Path('/private/tmp/cc-cpm-w4-t536/onboarding-eval-8D9Vsy/home/.agents/skills/story/review-contract-template.md')\nwith (root/'REVIEW.md').open('xb') as f:\n    f.write(source.read_bytes())\nfor name in ['AGENTS.md', 'RULES.md', 'REVIEW.md', '.gitignore']:\n    data=(root/name).read_bytes()\n    print(f'{name}: read back {len(data)} bytes')\n    if name=='REVIEW.md':\n        assert data==source.read_bytes()\nprint('REVIEW.md matches template verbatim')\nPY\n git init\"";
/** Run 1, approve: a CLI call, then the read-back script, then a git check. */
const RUN1_HEREDOC_VALIDATE = "/bin/zsh -lc \"storybloq validate --format json; python3 - <<'PY'\nfrom pathlib import Path\nimport json\nroot=Path('.story')\nfor folder in ['tickets','issues','notes','handovers','snapshots']:\n    files=[p for p in (root/folder).iterdir() if p.is_file()] if (root/folder).exists() else []\n    print(f'{folder}: {len(files)} files')\nh=root/'handovers'/'2026-09-29-01-plotbook-approved-setup.md'\ncontent=h.read_text()\nfor text in ['Coverage map','Independent review: pass, invocation R3','T-017','Verification tooling to establish: WRITE_TESTS:','Verification tooling to establish: TEST:','Verification tooling to establish: BUILD:','Verification tooling to establish: VERIFY:']:\n    assert text in content,text\nprint(f'Handover read back: {len(h.read_bytes())} bytes; coverage, review and pending stages present')\nfor p in (root/'notes').glob('*.json'):\n    note=json.loads(p.read_text())\n    assert 'Coverage map' in note['content'] and 'setup' in note['tags']\n    print(f'Setup note read back: {len(p.read_bytes())} bytes')\nPY\n git check-ignore .story/snapshots/example.json .story/sessions/example.json .story/status.json\"";

// --- heredoc builders ----------------------------------------------------------------------------------------------

const BODY = "import subprocess\nsubprocess.run(['storybloq', 'ticket', 'create', '--title', 'Book a class'], check=True)\nprint('created')";
const heredoc = (body = BODY, head = "python3 -", op = "<<'PY'", tail = ""): string => `/bin/zsh -lc "${head} ${op}\n${body}\nPY${tail}"`;
const HEREDOC = heredoc();

// --- loops (A4(a), amendment 1) ------------------------------------------------------------------------------------

describe("check set 4: one literal loop is unrolled and each copy scanned", () => {
  it("T1a: the attempt 9 ancestor walks (runs 1 and 9) are clean under check set 4 and needs-review under check set 3; run 3's mixed-quote wrapper stays needs-review", () => {
    for (const cmd of [RUN1_LOOP, RUN9_LOOP]) {
      expect(reviewOf([cmd], "opening"), cmd).toEqual([]);
      expect(reviewOf([cmd], "opening", 3).length, cmd).toBeGreaterThan(0);
      expect(analyse([cmd], "opening").loops.map((l) => l.name), cmd).toEqual(["p"]);
    }
    expect(reviewOf([RUN3_LOOP], "opening").length).toBeGreaterThan(0);
    expect(analyse([RUN3_LOOP], "opening").loops).toEqual([]);
    // Run 9's leading command is scanned: an install in its place is reported.
    expect(executedOf([RUN9_LOOP.replace("cat pyproject.toml", "npm install; cat pyproject.toml")], "approve")).toEqual(["npm install"]);
  });

  it("amendment 1: an unquoted expansion is never unrolled (IFS can split it); the double-quoted control is", () => {
    const ifs = "sh -c 'IFS=/; for p in npm/install; do $p; done'";
    expect(reviewOf([ifs]).length).toBeGreaterThan(0);
    expect(analyse([ifs]).loops).toEqual([]);
    expect(lib.unrollLoop("for p in npm; do cat $p; done")).toEqual({ kind: "declined", reason: "unquoted expansion in loop body" });
    expect(lib.unrollLoop("for p in npm; do $p install; done")).toEqual({ kind: "declined", reason: "loop body command not allowlisted: $p" });
    const quoted = "sh -c 'for p in a/b; do cat \"$p\"; done'";
    expect(reviewOf([quoted])).toEqual([]);
    expect(analyse([quoted]).loops).toEqual([{ callIndex: 0, turn: "approve", name: "p", words: ["a/b"] }]);
  });

  it("T1b1: a body that can change or re-read the variable declines", () => {
    for (const cmd of [
      "for p in echo; do p=npm; \"$p\" install; done",
      "for p in a; do p=npm \"$p\" install; done",
      "for p in a; do read p; cat \"$p\"; done",
      "for p in a; do unset p; cat \"$p\"; done",
      "for p in a; do cat \"${p:=npm}\"; done",
      "for p in a; do export p; cat \"$p\"; done",
      "for p in a; do X=1 cat \"$p\"; done",
    ]) {
      expect(lib.unrollLoop(cmd).kind, cmd).toBe("declined");
      expect(reviewOf([cmd]).length, cmd).toBeGreaterThan(0);
    }
  });

  it("T1b2: substitution keeps the segment kind; a single-quoted $ or a word with a space declines", () => {
    const r = lib.unrollLoop("for p in a; do cat \"$p/x\"; done");
    expect(r.kind).toBe("unrolled");
    expect(r.kind === "unrolled" ? r.text : "").toContain("cat \"a/x\"");
    expect(lib.unrollLoop("for p in a b; do cat \"${p}\"; done")).toMatchObject({ kind: "unrolled", words: ["a", "b"] });
    expect(lib.unrollLoop("for p in a; do echo '$p'; done").kind).toBe("declined");
    expect(lib.unrollLoop("for p in 'a b'; do cat \"$p\"; done").kind).toBe("declined");
  });

  it("T1b3: only a whole $NAME or ${NAME} is the variable: $pp, ${p%/*} and $1 decline", () => {
    for (const cmd of ["for p in a; do cat \"$pp\"; done", "for p in a; do cat \"${p%/*}\"; done", "for p in a; do cat \"$1\"; done"]) {
      expect(lib.unrollLoop(cmd).kind, cmd).toBe("declined");
      expect(reviewOf([cmd]).length, cmd).toBeGreaterThan(0);
    }
  });

  it("T1b4: commands after the loop are scanned: an install after approval runs, a redirect before it is needs-review", () => {
    expect(executedOf(["for p in a; do cat \"$p\"; done; npm install"])).toEqual(["npm install"]);
    const redirect = reviewOf(["for p in a; do cat \"$p\"; done; echo x > file"], "discovery-1");
    expect(redirect.some((s) => s.includes("file redirect, target not resolved")), redirect.join(" | ")).toBe(true);
  });

  it("T1b5: the body is scanned: an install inside it runs", () => {
    expect(executedOf(["for p in a; do npm install; done"])).toEqual(["npm install"]);
  });

  it("T1b6: a glob or variable word list, nesting, a here-document, a pipe or a redirect in the body declines", () => {
    for (const cmd of [
      "for p in *; do cat \"$p\"; done",
      "for p in $X; do cat \"$p\"; done",
      "for p in a; do for q in b; do cat \"$q\"; done; done",
      "for p in a; do while true; do cat \"$p\"; done; done",
      "for p in a; do case x in x) cat \"$p\";; esac; done",
      "for p in a; do function f { cat \"$p\"; }; done",
      "for p in a; do cat <<'E'\nx\nE\ndone",
      "for p in a; do cat \"$p\" | head; done",
      "for p in a; do cat \"$p\" > out; done",
    ]) {
      expect(lib.unrollLoop(cmd).kind, cmd).toBe("declined");
      expect(reviewOf([cmd]).length, cmd).toBeGreaterThan(0);
    }
  });

  it("T1b7: mixed quoting declines, though shellSequence reads the two words the same (why the raw lexer exists)", () => {
    const a = "for p in a; do echo '$p'\"$p\"; done";
    const b = "for p in a; do echo '$p$p'\"\"; done";
    expect(lib.shellSequence(a).commands.map((c) => c.words)).toEqual(lib.shellSequence(b).commands.map((c) => c.words));
    expect(lib.unrollLoop(a)).toEqual({ kind: "declined", reason: "mixed quoting in loop body" });
    expect(lib.unrollLoop(b)).toEqual({ kind: "declined", reason: "mixed quoting in loop body" });
  });

  it("T1b8: the variable named anywhere after done declines; another name does not", () => {
    const loop = "for p in npm; do cat \"$p\"; done";
    for (const rest of ["; $p install", "; \"$p\" install", "; ${p} install", "; p=x; $p install", "; echo $(echo $p)", "; sh -c \"$p install\"", "\n$p install"]) {
      expect(lib.unrollLoop(loop + rest), rest).toEqual({ kind: "declined", reason: "loop variable used after done" });
      expect(reviewOf([loop + rest]).length, rest).toBeGreaterThan(0);
    }
    expect(analyse([`${loop}; echo pq`]).loops.map((l) => l.words)).toEqual([["npm"]]);
  });

  it("T1b9: an indirect read of the variable after done declines: its name as a word, ${!, (P) or eval anywhere", () => {
    const named = { kind: "declined", reason: "loop variable named after done" };
    const indirect = { kind: "declined", reason: "indirect expansion in the command" };
    const evalled = { kind: "declined", reason: "eval in the command" };
    // The pen's reproductions: clean under check set 4 before this clause, needs-review under check set 3.
    for (const cmd of ["for p in npm; do :; done; v=p; \"${(P)v}\" install", "for p in npm; do :; done; v=p; \"${!v}\" install", "for p in npm; do :; done; eval \"\\$\"\"p install\""]) {
      expect(lib.unrollLoop(cmd), cmd).toEqual(named);
      expect(reviewOf([cmd]).length, cmd).toBeGreaterThan(0);
      expect(reviewOf([cmd], "approve", 3).length, cmd).toBeGreaterThan(0);
    }
    expect(lib.unrollLoop("for p in npm; do :; done; v=p")).toEqual(named);
    expect(lib.unrollLoop("for p in npm; do :; done; x=\"\"p")).toEqual(named);
    // The name set before the loop: only the indirect form or eval shows the read.
    expect(lib.unrollLoop("v=p; for p in install; do :; done; npm \"${!v}\"")).toEqual(indirect);
    expect(lib.unrollLoop("v=p; for p in install; do :; done; npm \"${(P)v}\"")).toEqual(indirect);
    expect(lib.unrollLoop("q=p; for p in install; do :; done; eval \"npm \\$$q\"")).toEqual(evalled);
    for (const cmd of ["v=p; for p in install; do :; done; npm \"${!v}\"", "v=p; for p in install; do :; done; npm \"${(P)v}\"", "q=p; for p in install; do :; done; eval \"npm \\$$q\""]) {
      expect(reviewOf([cmd]).length, cmd).toBeGreaterThan(0);
    }
    // Controls: the letter inside a word, an option or a path is not the name, and `eval` inside a path is not eval.
    for (const cmd of ["for p in npm; do :; done; echo pq pp npm", "for p in npm; do :; done; ls -p ./p", "for p in /tmp/onboarding-eval-x; do cat \"$p\"; done; echo ok"]) {
      expect(lib.unrollLoop(cmd).kind, cmd).toBe("unrolled");
    }
  });

  it("T1b10: a mutator or nesting word declines whatever its quoting, through command or builtin, or as a loop word (Codex round 1, finding 1)", () => {
    for (const cmd of [
      "for p in echo; do 'printf' -v p npm; \"$p\" install; done",
      "for p in echo; do \"printf\" -v p npm; \"$p\" install; done",
      "for p in echo; do command 'printf' -v p npm; \"$p\" install; done",
      "for p in echo; do builtin \"read\" p; \"$p\" install; done",
      "for p in printf; do \"$p\" -v p npm; done",
    ]) {
      expect(lib.unrollLoop(cmd).kind, cmd).toBe("declined");
      expect(reviewOf([cmd]).length, cmd).toBeGreaterThan(0);
    }
  });

  it("T1b12: a substituted word is checked too, and the variable is never at command position, alone or concatenated (Codex rounds 2 and 6)", () => {
    // The reproduction: `printf -v p npm` assembled from "${p}f", then `"$p" install` runs npm.
    const repro = "for p in print; do \"${p}f\" -v p npm; \"$p\" install; done";
    expect(lib.unrollLoop(repro).kind).toBe("declined");
    expect(reviewOf([repro]).length).toBeGreaterThan(0);
    // (b) command position: the first word is an allowlisted literal, so the variable or a wrapper there declines.
    for (const [cmd, word] of [
      [repro, "${p}f"],
      ["for p in np; do \"${p}m\" install; done", "${p}m"],
      ["for p in print; do command \"${p}f\" -v p npm; \"$p\" install; done", "command"],
      ["for p in np; do env \"${p}m\" install; done", "env"],
      ["for p in ev; do \"${p}al\" x; done", "${p}al"],
      ["for p in a; do if \"x$p\"; then echo ok; fi; done", "x$p"],
    ] as const) {
      expect(lib.unrollLoop(cmd), cmd).toEqual({ kind: "declined", reason: `loop body command not allowlisted: ${word}` });
      expect(reviewOf([cmd]).length, cmd).toBeGreaterThan(0);
    }
    // (a) any word a substitution turns into a mutator or nesting word, for any loop word.
    expect(lib.unrollLoop("for p in ev; do echo \"${p}al\"; done")).toEqual({ kind: "declined", reason: "eval assembled in loop body" });
    expect(lib.unrollLoop("for p in a rea; do echo \"${p}d\"; done")).toEqual({ kind: "declined", reason: "read assembled in loop body" });
    // A loop word that is a wrapper would lead a command as itself.
    expect(lib.unrollLoop("for p in command; do \"$p\" ls; done")).toEqual({ kind: "declined", reason: "command as a loop word" });
    expect(lib.unrollLoop("for p in /usr/bin/env; do \"$p\" ls; done")).toEqual({ kind: "declined", reason: "/usr/bin/env as a loop word" });
    // Control: concatenation in argument position still unrolls. The expansion alone at command position does not.
    expect(lib.unrollLoop("for p in /tmp /var; do if [ -f \"$p/AGENTS.md\" ]; then cat \"$p/AGENTS.md\"; fi; done").kind).toBe("unrolled");
    for (const cmd of ["for p in npm; do \"${p}\" install; done", "for p in npm; do \"$p\" install; done"]) {
      expect(lib.unrollLoop(cmd).kind, cmd).toBe("declined");
      expect(reviewOf([cmd]).length, cmd).toBeGreaterThan(0);
    }
  });

  it("T1b13: a declaration or shell option before the loop can transform the variable: its name or a mode word anywhere declines (Codex round 3)", () => {
    const named = { kind: "declined", reason: "loop variable named before the loop" };
    const loop = "for p in NPM; do cat \"$p\"; done";
    // The reproduction (then with `"$p" install` as the body, which now declines by itself): zsh lowercases the value and runs `npm install`; check set 3 reads it as needs-review.
    expect(lib.unrollLoop(`typeset -l p; ${loop}`)).toEqual(named);
    expect(reviewOf([`typeset -l p; ${loop}`]).length).toBeGreaterThan(0);
    expect(reviewOf([`typeset -l p; ${loop}`], "approve", 3).length).toBeGreaterThan(0);
    for (const prefix of ["'typeset' -l p", "command typeset -u p", "x=\"\"p", "echo p"]) {
      expect(lib.unrollLoop(`${prefix}; ${loop}`), prefix).toEqual(named);
      expect(reviewOf([`${prefix}; ${loop}`]).length, prefix).toBeGreaterThan(0);
    }
    // A word that changes how the shell reads or expands the loop, without naming the variable, in any quoting.
    for (const [prefix, word] of [["setopt shwordsplit", "setopt"], ["alias npm=echo", "alias"], ["'emulate' sh", "emulate"], ["command \"typeset\" -l q", "typeset"], ["trap : DEBUG", "trap"], ["shopt -s expand_aliases", "shopt"], ["readonly q", "readonly"]] as const) {
      expect(lib.unrollLoop(`${prefix}; ${loop}`), prefix).toEqual({ kind: "declined", reason: `${word} in the command` });
      expect(reviewOf([`${prefix}; ${loop}`]).length, prefix).toBeGreaterThan(0);
    }
    expect(lib.unrollLoop(`${loop}; setopt shwordsplit`)).toEqual({ kind: "declined", reason: "setopt in the command" });
    // Controls: a harmless prefix, and the letter inside a word, an option or a path, still unroll.
    for (const prefix of ["pwd", "cat pyproject.toml rota/__init__.py", "ls -p ./p", "echo setup"]) {
      expect(lib.unrollLoop(`${prefix}; ${loop}`).kind, prefix).toBe("unrolled");
    }
    expect(analyse(["pwd; for p in npm; do cat \"$p\"; done"]).loops.map((l) => l.words)).toEqual([["npm"]]);
  });

  it("T1b14: everything outside the loop matches a closed grammar of read-only literal commands, or the loop declines (Codex round 4)", () => {
    const loop = "for dir in NPM; do cat \"$dir\"; done";
    const declined = (cmd: string, reason: string): void => {
      expect(lib.unrollLoop(cmd), cmd).toEqual({ kind: "declined", reason });
      expect(reviewOf([cmd]).length, cmd).toBeGreaterThan(0);
    };
    // The reproduction: zsh reads `type\set -l di""r` as `typeset -l dir` and runs npm install.
    declined(`type\\set -l di""r; ${loop}`, "prefix word not literal");
    expect(reviewOf([`type\\set -l di""r; ${loop}`], "approve", 3).length).toBeGreaterThan(0);
    for (const side of ["prefix", "suffix"] as const) {
      const at = (text: string): string => (side === "prefix" ? `${text}; ${loop}` : `${loop}; ${text}`);
      declined(at("type\\set -l x"), `${side} word not literal`);
      declined(at("'cat' x"), `${side} word not literal`);
      declined(at("cat \"x\""), `${side} word not literal`);
      declined(at("cat $(x)"), `${side} word not literal`);
      declined(at("cat x*"), `${side} word not literal`);
      declined(at("cat x > y"), `${side} operator: >`);
      declined(at("cat x | sh"), `${side} operator: |`);
      declined(at("cat x || cat y"), `${side} operator: ||`);
      declined(at("X=1 cat x"), `${side} assignment: X=1`);
      declined(at("git status"), `${side} command not allowlisted: git`);
      declined(at("cd x"), `${side} command not allowlisted: cd`);
      declined(at("cat a && npm install"), `${side} command not allowlisted: npm`);
    }
    // Controls: literal read-only commands on either side still unroll.
    for (const cmd of [`cat a b; ${loop}`, `pwd && ${loop}`, `ls -la\n${loop}`, `${loop}; echo ok`, `${loop} && test -f a.b/c`, `cat pyproject.toml rota/__init__.py; ${loop}\nwc -l x`]) {
      expect(lib.unrollLoop(cmd).kind, cmd).toBe("unrolled");
    }
    expect(analyse([`cat a b; for p in npm; do cat "$p"; done; echo ok`]).loops.map((l) => l.words)).toEqual([["npm"]]);
  });

  it("T1b15: the loop variable name is one of a closed list; a name the shell manages itself declines (Codex round 5)", () => {
    // The reproduction: bash sets `_` to the previous command's last argument, so this runs `npm install`.
    const repro = "for _ in echo; do : npm; \"$_\" install; done";
    expect(lib.unrollLoop(repro)).toEqual({ kind: "declined", reason: "loop variable not allowlisted: _" });
    expect(reviewOf([repro]).length).toBeGreaterThan(0);
    expect(reviewOf([repro], "approve", 3).length).toBeGreaterThan(0);
    expect(analyse([repro]).loops).toEqual([]);
    for (const name of ["_", "path", "IFS", "PATH", "argv", "status", "x", "param", "P", "dirs"]) {
      const cmd = `for ${name} in a; do cat "$${name}"; done`;
      expect(lib.unrollLoop(cmd), name).toEqual({ kind: "declined", reason: `loop variable not allowlisted: ${name}` });
      expect(reviewOf([cmd]).length, name).toBeGreaterThan(0);
    }
    for (const name of ["p", "d", "f", "dir", "file"]) {
      const cmd = `for ${name} in a; do cat "$${name}"; done`;
      expect(lib.unrollLoop(cmd).kind, name).toBe("unrolled");
      expect(reviewOf([cmd]), name).toEqual([]);
    }
  });

  it("T1b16: every command in the loop body is one of a closed list of read-only commands, and no body word is single-quoted (Codex round 6)", () => {
    const declined = (cmd: string, reason: string): void => {
      expect(lib.unrollLoop(cmd), cmd).toEqual({ kind: "declined", reason });
      expect(reviewOf([cmd]).length, cmd).toBeGreaterThan(0);
      expect(analyse([cmd]).loops, cmd).toEqual([]);
    };
    const notListed = (word: string): string => `loop body command not allowlisted: ${word}`;
    // The reproduction: the quoted wrapper hides `trap`, assembled from the loop word; its DEBUG trap sets p to npm.
    const repro = "for p in tra; do 'builtin' \"${p}p\" 'p=npm' DEBUG; \"$p\" install; done";
    declined(repro, notListed("builtin"));
    expect(reviewOf([repro], "approve", 3).length).toBeGreaterThan(0);
    for (const [body, reason] of [
      ["'builtin' echo x", notListed("builtin")],
      ["command echo x", notListed("command")],
      ["\"$p\" install", notListed("$p")],
      ["\"${p}\" install", notListed("${p}")],
      ["env \"$p\"", notListed("env")],
      ["git status", notListed("git")],
      ["\"echo\" x", notListed("echo")],
      ["test -e a && git status", notListed("git")],
      ["true || npm install", notListed("npm")],
      ["if test -e a; then npm install; fi", notListed("npm")],
      ["if npm test; then echo ok; fi", notListed("npm")],
      ["if true; then :; else npm install; fi", notListed("npm")],
      ["echo 'x'", "single-quoted word in loop body"],
      ["cat \"$p\" 'a'", "single-quoted word in loop body"],
    ] as const) declined(`for p in a; do ${body}; done`, reason);
    // A substitution may not assemble a word that changes how the shell reads the loop, wherever it stands.
    declined("for p in tra; do echo \"${p}p\"; done", "trap assembled in loop body");
    declined("for p in a setop; do echo \"${p}t\"; done", "setopt assembled in loop body");
    // Controls: allowlisted commands, joined by && or under if/then/elif/else, still unroll.
    for (const cmd of [
      "for p in a; do test -e \"$p/.story\" && echo \"$p\"; done",
      "for p in a b; do if [ -f \"$p\" ]; then cat \"$p\"; elif test -d \"$p\"; then ls \"$p\"; else echo none; fi; done",
      "for p in a; do head -n 5 \"$p\"; tail -n 5 \"$p\"; wc -l \"$p\"; true; :; done",
    ]) {
      expect(lib.unrollLoop(cmd).kind, cmd).toBe("unrolled");
      expect(reviewOf([cmd]), cmd).toEqual([]);
    }
  });

  it("T1b11: a write is the call's write through a wrapper's string and a heredoc's remainder; a loop that would write declines (Codex round 1, finding 2; round 6)", () => {
    // The loop variable at command position declines since round 6, so an unrolled copy can no longer write: the
    // hidden `git init` is needs-review, bare and through a wrapper.
    const loop = "for p in git; do \"$p\" -C /tmp/out init; done";
    expect(lib.writeCalls(callsOf([{ cmd: loop }]))).toEqual([]);
    for (const cmd of [loop, "/bin/zsh -lc 'for p in git; do \"$p\" init; done'"]) {
      expect(analyse([cmd], "discovery-1").loops, cmd).toEqual([]);
      expect(reviewOf([cmd], "discovery-1").length, cmd).toBeGreaterThan(0);
    }
    const write = "/bin/zsh -lc 'git -C /tmp/out init'";
    expect(analyse([write], "discovery-1").writes.length).toBe(1);
    const remainder = analyse([`python3 - <<'PY'\n${BODY}\nPY\ngit init`]);
    expect([remainder.interpreterScripts.length, remainder.loops.length, remainder.writes.length]).toEqual([1, 0, 1]);
    // With a loop, the grammar reads what the excision leaves: `python3 -` is not an allowlisted command, so the call
    // keeps the check set 3 result, script and loop both unread (Codex round 4).
    const both = `python3 - <<'PY'\n${BODY}\nPY\nfor p in a; do cat "$p"; done`;
    expect(lib.unrollLoop("python3 - \nfor p in a; do cat \"$p\"; done")).toEqual({ kind: "declined", reason: "prefix command not allowlisted: python3" });
    expect([analyse([both]).interpreterScripts.length, analyse([both]).loops.length]).toEqual([0, 0]);
    expect(reviewOf([both]).length).toBeGreaterThan(0);
    // The stop before approval fails on it, with no tree change to catch it.
    const stop = lib.checkStop({ ...turnOf(raw4({ text: pkg(result("approve", "R1")), items: [{ cmd: write }] }), 4) }, ["package"], 4);
    expect(stop.reasons.some((r) => r.startsWith("wrote before approval:")), stop.reasons.join(" / ")).toBe(true);
    // The whole-run count reads the same analysis.
    const d = drive("none", cleanRun([{ cmd: write }]));
    expect(drv.writesAfterApprovalOf(d.state)).toBe(1);
  });
});

// --- a command word that holds an expansion (byte-review w4-a6, finding 2) ----------------------------------------

describe("check set 4: a word at command position that holds an expansion is needs-review", () => {
  const MARK = "[expansion at command position]";
  it("a variable or substitution as the command word is needs-review under check set 4; check set 3 is unchanged", () => {
    for (const cmd of ["x=npm; $x install", "x=npm; \"$x\" install", "x=npm; ${x} install", "x=npm; env \"$x\" install", "x=npm; sh -c \"$x install\""]) {
      expect(reviewOf([cmd]).some((s) => s.includes(MARK)), cmd).toBe(true);
    }
    // Pre-existing in every check set: check set 3 reads these as clean, and keeps doing so.
    expect(reviewOf(["x=npm; $x install"], "approve", 3)).toEqual([]);
    expect(reviewOf(["x=npm; \"$x\" install"], "approve", 3)).toEqual([]);
    // A substitution was already needs-review; it stays so.
    expect(reviewOf(["$(echo npm) install"]).length).toBeGreaterThan(0);
    expect(reviewOf(["$(echo npm) install"], "approve", 3).length).toBeGreaterThan(0);
  });

  it("an expansion is read before a wrapper, shell or probe is recognised (Codex round 1, finding 3)", () => {
    for (const cmd of ["x=\"npm install \"; $x/env true", "x=/bin; \"$x\"/sh -c 'npm install'", "x=npm; env $x install", "x=npm; command $x install", "x=npm; nohup \"$x\" install"]) {
      expect(reviewOf([cmd]).some((s) => s.includes(MARK)), cmd).toBe(true);
    }
    expect(reviewOf(["x=\"npm install \"; $x/env true"], "approve", 3)).toEqual([]);
  });

  it("an expansion in argument position stays clean; the loop variable as a loop's command word is needs-review", () => {
    expect(reviewOf(["x=npm; echo \"$x\""])).toEqual([]);
    expect(reviewOf(["x=npm; echo $x"])).toEqual([]);
    expect(reviewOf(["for p in npm; do cat \"$p\"; done"])).toEqual([]);
    expect(reviewOf(["for p in npm; do \"$p\" install; done"]).length).toBeGreaterThan(0);
  });
});

// --- the exec wrapper (A4(e)) --------------------------------------------------------------------------------------

describe("check set 4: the exec wrapper is read through its string only when the shell would not expand it", () => {
  it("T1f1: a $ in a double-quoted wrapper makes it undecidable, and the call needs-review", () => {
    const cmd = "/bin/zsh -lc \"echo $HOME; for p in a; do cat \\\"$p\\\"; done\"";
    expect(lib.readWrapper(cmd)).toBe("undecidable");
    expect(reviewOf([cmd]).length).toBeGreaterThan(0);
    expect(analyse([cmd]).loops).toEqual([]);
  });

  it("T1f2: a backtick in a double-quoted wrapper is undecidable; a heredoc body closing the outer quote around a backtick span stays needs-review", () => {
    expect(lib.readWrapper("/bin/zsh -lc \"for p in a; do cat `x`; done\"")).toBe("undecidable");
    const agents = "/bin/zsh -lc \"python3 - <<'PY'\nfrom pathlib import Path\nPath('AGENTS.md').write_text('''Run \"'`make test`'\" first.''')\nPY\"";
    expect(lib.readWrapper(agents)).toBeNull();
    expect(reviewOf([agents]).length).toBeGreaterThan(0);
    expect(analyse([agents]).interpreterScripts).toEqual([]);
  });

  it("T1f3: a single-quoted string passes through unchanged; a double-quoted one decodes only \\\\ and \\\"", () => {
    expect(lib.readWrapper("/bin/zsh -lc 'cat \"a\\b\" \\\\'")).toEqual({ shell: "/bin/zsh", quote: "single", inner: "cat \"a\\b\" \\\\" });
    expect(lib.readWrapper("bash -c \"cat \\\"a\\\" \\\\ \\n\"")).toEqual({ shell: "bash", quote: "double", inner: "cat \"a\" \\ \\n" });
    expect(lib.readWrapper("/bin/zsh -lc \"a\\\nb\"")).toBe("undecidable");
    expect(lib.readWrapper("/bin/zsh -lc \"a \\$b\"")).toBe("undecidable");
    expect(lib.readWrapper("/bin/zsh -lc 'a' 'b'")).toBeNull();
    expect(lib.readWrapper("fish -c 'a'")).toBeNull();
    expect(lib.readWrapper("cat x")).toBeNull();
  });
});

// --- the post-approval python heredoc (A4(b)) ----------------------------------------------------------------------

describe("check set 4: one post-approval python heredoc is judged instead of needs-review", () => {
  it("T1c1: a direct python3 - under a quoted delimiter after approval is excised, recorded verbatim and asked of the judge", () => {
    const a = analyse([HEREDOC]);
    expect(a.unresolved).toEqual([]);
    expect(a.semanticLines).toEqual([lib.interpreterScriptLine(0, "approve")]);
    expect(lib.interpreterScriptLine(0, "approve")).toBe("call 0 (turn approve) runs a python3 script after approval: it runs no install, test, build or dev server, directly or via subprocess, and writes nothing outside the project.");
    expect(a.interpreterScripts).toEqual([{ callIndex: 0, turn: "approve", command: HEREDOC, wrapper: { shell: "/bin/zsh", quote: "double" }, delimiter: "PY", quote: "single", terminated: true, body: BODY }]);
    // The packet carries the body for the judge.
    const d = drive("none", cleanRun([{ cmd: HEREDOC }]));
    const packet = JSON.parse(drv.packetText({
      runId: "synthetic", semanticLines: d.semanticLines, reviewSkipped: false, exclusion: EXCLUSION, rubric: MIXED, briefs: {}, projectFiles: {},
      turns: d.state.turns, evidence: d.evidence, ledgerRecords: d.ledgerRecords, setupRecord: drv.setupRecordFrom(storyOf()), final: d.state.final, checkSet: 4,
    })) as { interpreterScripts: { body: string; command: string }[]; harnessNormalisation: { write: string } };
    expect(packet.interpreterScripts.map((s) => [s.body, s.command])).toEqual([[BODY, HEREDOC]]);
    expect(packet.harnessNormalisation.write).toBe(lib.writeRuleFor(4));
    expect(d.semanticLines.filter((l) => l.includes("runs a python3 script"))).toHaveLength(1);
  });

  it("T1c1b: the attempt 9 forms qualify, and a git init after the terminator is still a write after approval", () => {
    for (const cmd of [RUN1_HEREDOC_INIT, RUN1_HEREDOC_VALIDATE]) {
      const a = analyse([cmd]);
      expect(a.unresolved, cmd.slice(0, 60)).toEqual([]);
      expect(a.interpreterScripts, cmd.slice(0, 60)).toHaveLength(1);
      expect(reviewOf([cmd], "approve", 3).length).toBeGreaterThan(0);
    }
    const d = drive("none", cleanRun([{ cmd: RUN1_HEREDOC_INIT }]));
    expect(drv.writesAfterApprovalOf(d.state)).toBeGreaterThan(0);
    expect(d.evidence.unparsed).toEqual([]);
  });

  const stays = (cmd: string, label = "approve"): void => {
    const a = analyse([cmd], label);
    expect(a.unresolved.length, cmd).toBeGreaterThan(0);
    expect(a.interpreterScripts, cmd).toEqual([]);
    expect(a.semanticLines, cmd).toEqual([]);
  };

  it("T1c2: an unquoted delimiter stays needs-review", () => stays(`python3 - <<PY\nprint("$(npm install)")\nPY`));
  it("T1c3: two here-documents in one call stay needs-review", () => stays(heredoc(BODY, "python3 -", "<<'PY'", "\npython3 - <<'PY'\nprint(2)\nPY")));
  it("T1c4: a missing terminator stays needs-review", () => stays(`/bin/zsh -lc "python3 - <<'PY'\n${BODY}\n"`));

  it("T1c5: a body over 8192 bytes stays needs-review; exactly 8192 qualifies", () => {
    const fill = (n: number): string => `x = 1\n#${"a".repeat(n - 7)}`;
    expect(Buffer.byteLength(fill(8192))).toBe(8192);
    stays(heredoc(fill(8193)));
    expect(analyse([heredoc(fill(8192))]).interpreterScripts).toHaveLength(1);
  });

  it("T1c6: a subprocess install, test or dev server in the body stays needs-review", () => {
    for (const body of ["import subprocess\nsubprocess.run(['npm', 'install'])", "import subprocess\nsubprocess.run('npm test', shell=True)", "import os\nos.system('make build')", "import subprocess\nsubprocess.run(['npx', 'vite'])", "import subprocess\nsubprocess.run(['sh', '-c', 'x'])"]) stays(heredoc(body));
  });

  it("T1c7: a write naming a path outside the project stays needs-review; a write inside it with an outside read qualifies", () => {
    for (const body of ["from pathlib import Path\nPath('~/x').expanduser().write_text('x')", "open('/etc/x', 'w').write('x')", "from pathlib import Path\nPath('/tmp/x').open('w')", "import shutil\nshutil.copy('a', '../b')"]) stays(heredoc(body));
    expect(analyse([heredoc("from pathlib import Path\nsrc = Path('/tmp/t.md')\nPath('REVIEW.md').write_text(src.read_text())")]).interpreterScripts).toHaveLength(1);
  });

  it("T1c8: the same call before approval stays needs-review", () => stays(HEREDOC, "discovery-1"));

  it("T1c9: the judge line is required: unruled or failed blocks PASS, passed allows it", () => {
    const line = lib.interpreterScriptLine(3, "approve");
    const judge = (lines: { line: string; verdict: "pass" | "fail" }[]) => ({ packetSha256: sha256("p"), observedModel: "m", lines: lines.map((l) => ({ ...l, reason: "r" })) });
    expect(lib.runVerdict([], "p", judge([]), [line])).toEqual({ verdict: "FAIL", reasons: [`the judge did not rule on: ${line}`] });
    expect(lib.runVerdict([], "p", judge([{ line, verdict: "fail" }]), [line]).verdict).toBe("FAIL");
    expect(lib.runVerdict([], "p", judge([{ line, verdict: "pass" }]), [line]).verdict).toBe("PASS");
  });

  it("T1c10: a command wrapper in front of python3 stays needs-review", () => {
    for (const head of ["env -C /tmp python3 -", "command python3 -", "exec python3 -", "nice python3 -", "timeout 5 python3 -", "python -", "python3 -u -"]) stays(heredoc(BODY, head));
  });
  it("T1c11: an assignment in front of python3 stays needs-review", () => stays(heredoc(BODY, "PYTHONPATH=x python3 -")));
  it("T1c12: a descriptor on the operator stays needs-review", () => { stays(heredoc(BODY, "python3 -", "0<<'PY'")); stays(heredoc(BODY, "python3 -", "3<<'PY'")); });

  it("T1c13: a substitution in the interpreter, on the operator line or in another command stays needs-review", () => {
    stays(`$(which python3) - <<'PY'\n${BODY}\nPY`);
    stays(`python3 - <<'PY' $(npm i)\n${BODY}\nPY`);
    const other = analyse([`echo $(npm i); python3 - <<'PY'\n${BODY}\nPY`]);
    expect(other.unresolved.length).toBeGreaterThan(0);
  });

  it("T1c14: a pipe on either side stays needs-review", () => {
    stays(`python3 - <<'PY'\n${BODY}\nPY\n| sh`);
    stays(`cat x | python3 - <<'PY'\n${BODY}\nPY`);
  });
  it("T1c15: the strip form stays needs-review", () => stays(heredoc(BODY, "python3 -", "<<-'PY'")));

  it("python3 without - and the double-quoted and backslash delimiters qualify", () => {
    expect(analyse([`python3 <<'PY'\n${BODY}\nPY`]).interpreterScripts.map((s) => s.quote)).toEqual(["single"]);
    expect(analyse([`python3 - <<"PY"\n${BODY}\nPY`]).interpreterScripts.map((s) => s.quote)).toEqual(["double"]);
    expect(analyse([`python3 - <<\\PY\n${BODY}\nPY`]).interpreterScripts.map((s) => [s.quote, s.wrapper])).toEqual([["backslash", null]]);
  });
});

// --- one shared analysis with approval context (A4(d)) --------------------------------------------------------------

describe("check set 4: one analysis, approval context from each call's turn", () => {
  /** discovery-1's heredoc sits at call index 5, past the approve turn's index, so the call's turn, not its index, decides. */
  const discoveryItems: Item[] = [probePath(), exec("R1", "approve"), { cmd: "cat brief.md" }, { cmd: "cat notes.md" }, { cmd: "cat plan.md" }, { cmd: HEREDOC }];
  const turns = (withDiscovery: boolean): Turn4[] => [
    { text: "Which timezone should bookings use?" },
    { text: pkg(result("approve", "R1")), items: withDiscovery ? discoveryItems : discoveryItems.slice(0, 5) },
    { text: pkg(result("approve", "R1")) },
    { text: pkg(result("approve", "R2")), items: [exec("R2", "approve")] },
    { text: summary(result("approve", "R2")), items: [{ cmd: HEREDOC }] },
  ];

  it("T1e: the same heredoc in discovery-1 and approve: only the approve one qualifies and adds one line; the other is needs-review", () => {
    const calls = callsOf([...discoveryItems, { cmd: HEREDOC }]);
    const a = lib.analyseCalls(calls, [{ label: "opening", callRange: [0, 0] }, { label: "discovery-1", callRange: [0, 6] }, { label: "inspect", callRange: [6, 6] }, { label: "adjust", callRange: [6, 6] }, { label: "approve", callRange: [6, 7] }], 4);
    expect(a.interpreterScripts.map((s) => [s.callIndex, s.turn])).toEqual([[6, "approve"]]);
    expect(a.semanticLines).toEqual([lib.interpreterScriptLine(6, "approve")]);
    expect(a.unresolved).toHaveLength(1);

    const d = drive("none", turns(true));
    expect(d.state.turns.map((t) => t.label)).toEqual(["opening", "discovery-1", "inspect", "adjust", "approve"]);
    expect(d.evidence.interpreterScripts?.map((s) => s.turn)).toEqual(["approve"]);
    expect(d.semanticLines.filter((l) => l.includes("runs a python3 script"))).toEqual([lib.interpreterScriptLine(7, "approve")]);
    expect(failuresOf(d.state, "unparsed")).toHaveLength(1);
    expect(lib.runVerdict(d.state.failures, "p", null, d.semanticLines).verdict).toBe("FAIL");

    const clean = drive("none", turns(false));
    expect(clean.state.failures).toEqual([]);
    const line = lib.interpreterScriptLine(6, "approve");
    expect(clean.semanticLines).toContain(line);
    const judge = { packetSha256: sha256("p"), observedModel: "m", lines: clean.semanticLines.filter((l) => l !== line).map((l) => ({ line: l, verdict: "pass" as const, reason: "r" })) };
    expect(lib.runVerdict(clean.state.failures, "p", judge, clean.semanticLines)).toEqual({ verdict: "FAIL", reasons: [`the judge did not rule on: ${line}`] });
  });

  it("T1e through the regrade: a check set 4 record with the approve heredoc regrades, its line required", () => {
    const input = recorded4(turns(false));
    const r = rg.regrade(input);
    if (!r.ok) throw new Error(r.reason);
    expect(r.result.checkSet).toBe(4);
    expect(r.result.semanticLines).toContain(lib.interpreterScriptLine(6, "approve"));
    expect(JSON.parse(input.packetBytes.toString("utf-8")).harnessNormalisation.write).toBe(lib.writeRuleFor(4));
  });

  it("the per-turn stop label reads the same analysis: a loop the whole run accepts is not needs-review in its own turn", () => {
    const d = drive("none", [{ ...cleanRun()[0]!, items: [probePath(), exec("R1", "approve"), { cmd: RUN1_LOOP }] }, ...cleanRun().slice(1)]);
    expect(d.state.turns[0]!.unparsed).toEqual([]);
    expect(d.state.failures).toEqual([]);
    const d3 = drive("none", [{ ...cleanRun()[0]!, items: [probePath(), exec("R1", "approve"), { cmd: RUN1_LOOP }] }, ...cleanRun().slice(1)], 3);
    expect(d3.state.turns[0]!.unparsed.length).toBeGreaterThan(0);
  });
});

/** A check set 4 record and packet the runner would have written. */
function recorded4(turns: readonly Turn4[]): RegradeInput {
  const story = storyOf();
  const d = drive("none", turns, 4, story);
  const packet = drv.packetText({
    runId: "synthetic", semanticLines: d.semanticLines, reviewSkipped: false, exclusion: EXCLUSION, rubric: MIXED, briefs: {}, projectFiles: {},
    turns: d.state.turns, evidence: d.evidence, ledgerRecords: d.ledgerRecords, setupRecord: drv.setupRecordFrom(story), final: d.state.final, checkSet: 4,
  });
  const record = JSON.parse(JSON.stringify({
    runId: "synthetic", client: "codex", fixture: "mixed-stack", variant: "none", checkSetVersion: 4, turns: d.state.turns, discoveryRounds: d.state.rounds,
    reviewSkipped: false, reviewEvidence: d.evidence.reviewEvidence, writesAfterApproval: drv.writesAfterApprovalOf(d.state), unparsed: d.evidence.unparsed,
    inspection: d.inspection, failures: d.state.failures, infraFailed: false, treeExclusion: EXCLUSION, semanticLines: d.semanticLines, bound: d.evidence.bound,
    reviewerCapability: d.evidence.reviewerCapability, packetSha256: sha256(packet), verdict: "PENDING_SEMANTIC",
  })) as Record<string, unknown>;
  return {
    recordBytes: Buffer.from(JSON.stringify(record, null, 2)), packetBytes: Buffer.from(packet), rawNames: [...d.raw.keys(), "project.after"],
    readRaw: (name) => Buffer.from(d.raw.get(name)!),
    story: { exists: story.exists, readBytes: (rel) => Buffer.from(story.read(rel)), list: story.list },
    fixture: { firstPrompt: "$story set it up", discoveryPrompt: SCRIPT.discovery, afterPackage: d.afterPackage, rubric: MIXED, beforeConfig: () => ({}), briefs: {}, projectFiles: {}, files: [], checkSet: 4 },
    reviewLine: run.REVIEW_LINE, semanticLines: run.runSemanticLines,
  };
}

// --- pins: check sets 1-3 unchanged --------------------------------------------------------------------------------

/** Taken on 57e98dec before any change: sha256 of the canonical regrade result per stored run. */
const D_PINS: Record<string, string> = {
  "a7-run1": "7db9a2452369c13dfccec01a5001ee4ff3bb7a95f40911cbf745a19945121f03",
  "a7-run6": "66ffa0af23eb24746b3abf9d8a4071ee634381e67ae00ad3e5870bb9db64bd13",
  "a8-run1": "71ee98950be85230b02050b769ca25a056b94ba52b20ba4d6d695bc0d1344686",
  "a8-run10": "8a106a67e26fe833dd6c0e03e865148648bcd5ebf064f1c7b1e83f6dc363a210",
  "a8-run8": "cd39625449576e08278838bb06c770d1026a7fb123ebcf2a8dea5721dee7a566",
  "a9-run10": "b202b0d3b9777aa3a3e28866abfe14c09f3d89cca898c2c921ac7c2b46b3dea6",
  "a9-run12": "e296aedce629d8e456c166e7c990808fdcf8ae12f793e7ba1c0936fd3e571e72",
  "a9-run5": "f64057208db0bbbfb14311845dc1c35beec7f1c0a8b44f6f032445b96047f1cb",
  "a9-run8": "6abe8e93dc68fc2d1160d412546041888803b4d198a197c2f4b5049a88004008",
};

describe("check sets 1-3 are unchanged byte for byte (D-pins)", () => {
  it("T1d: the write rule for check sets 1-3 is the recorded text; check set 4 has its own", () => {
    expect(createHash("sha256").update(lib.WRITE_RULE_VERSION).digest("hex")).toBe("53972a1aa54eadb461315805e881d2d18b819468adb0cc25ebeb41dc6346de22");
    for (const cs of [1, 2, 3]) expect(lib.writeRuleFor(cs), `cs${cs}`).toBe(lib.WRITE_RULE_VERSION);
    expect(lib.writeRuleFor(4)).toBe(lib.WRITE_RULE_VERSION_4);
    expect(lib.WRITE_RULE_VERSION_4.startsWith(`2026-09-30.1: ${lib.WRITE_RULE_VERSION.slice("2026-09-27.8: ".length)}; check set 4: `)).toBe(true);
    expect(lib.stopRuleFor(3)).toBe(lib.STOP_RULE_VERSION_3);
    expect(lib.stopRuleFor(4)).toBe(lib.STOP_RULE_VERSION_4);
    expect(lib.CHECK_SET_VERSION).toBe(5);
  });

  it("T1d2: shellSequence reads every stored call exactly as before", () => {
    const cmds: string[] = [];
    for (const name of Object.keys(D_PINS).sort()) {
      const rec = JSON.parse(readFileSync(join(RUNS, name, "record", "record.json"), "utf-8")) as { client: string };
      for (const f of readdirSync(join(RUNS, name, "raw")).filter((x) => x.endsWith(".jsonl")).sort()) {
        const raw = readFileSync(join(RUNS, name, "raw", f), "utf-8");
        const t = rec.client === "claude" ? lib.claudeTurn(parseStream(raw).events, 1) : lib.codexTurn(raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } }).filter((x): x is Record<string, unknown> => x !== null), 1);
        for (const c of t.calls) { const cmd = (c.input as { command?: unknown } | null)?.command; if (typeof cmd === "string") cmds.push(cmd); }
      }
    }
    expect(cmds).toHaveLength(390);
    expect(sha256(JSON.stringify(cmds.map((c) => lib.shellSequence(c))))).toBe("775d9ecb243f571f98f1feba478cb62632b9bf55ece2a14eaa1776409bfedd52");
  });

  it("D-pins: every stored run regrades to the same result as before check set 4", () => {
    for (const [name, want] of Object.entries(D_PINS)) {
      const dir = mkdtempSync(join(tmpdir(), "regrade4-"));
      try {
        cpSync(join(RUNS, name), dir, { recursive: true });
        const r = rg.regrade(run.regradeInputFrom(join(dir, "record"), join(dir, "raw")));
        expect(r.ok ? sha256(rg.canonical(r.result)) : r.reason, name).toBe(want);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });
});

// --- the closing lines and the fixed line (B4) ----------------------------------------------------------------------

/** A stored run replayed through the flow under a check set, a turn's stop text optionally edited. */
function replay(name: string, cs: number, edit: (label: string, text: string) => string = (_, t) => t): { state: DriveState; evidence: ReturnType<typeof drv.finishDrive> } {
  const input = run.regradeInputFrom(join(RUNS, name, "record"), join(RUNS, name, "raw"));
  const record = JSON.parse(input.recordBytes.toString("utf-8")) as { variant: Variant; turns: { label: string; treeChanges: string[] }[]; treeExclusion: RuntimeExclusion };
  const state = drv.newDriveState(cs);
  const flow = drv.driveFlow({ variant: record.variant, firstPrompt: input.fixture.firstPrompt, discoveryPrompt: input.fixture.discoveryPrompt, afterPackage: input.fixture.afterPackage, exclusion: record.treeExclusion }, state);
  let n = 0;
  for (let step = flow.next(); !step.done;) {
    const label = record.turns[n]!.label;
    const turn = turnOf(input.readRaw(`${rg.turnFile(n, label)}.jsonl`).toString("utf-8"), cs);
    const changes = record.turns[n]!.treeChanges;
    step = flow.next({ turn: { ...turn, stopText: edit(label, turn.stopText) }, exitCode: 0, infraFailure: null, stderrPath: "", treeChanges: () => changes });
    n++;
  }
  const evidence = drv.finishDrive(state, run.REVIEW_LINE);
  const bytes = input.story;
  const story: StoryReader = bytes === null ? { exists: () => false, read: () => "", list: () => [] } : { exists: bytes.exists, read: (rel) => bytes.readBytes(rel).toString("utf-8"), list: bytes.list };
  drv.inspectAfter(state, story, input.fixture.rubric, input.fixture.beforeConfig, record.variant);
  return { state, evidence };
}

const recordedStop = (name: string, label: string): string =>
  (JSON.parse(readFileSync(join(RUNS, name, "record", "record.json"), "utf-8")) as { turns: { label: string; stopText: string }[] }).turns.find((t) => t.label === label)!.stopText;

describe("check set 4: the fixed line above the question, trailing spaces forgiven", () => {
  const closing = (s: DriveState): string[] => failuresOf(s, "closing");
  const packageTail = /\n\nHow should I proceed with this setup\?[\s\S]*$/;

  it("T2a: run 12's stop fails the closing and the fixed line under check set 4; the corrected layout passes both", () => {
    expect(closing(replay("a9-run12", 4).state)).toEqual([
      "the package does not end with the four closing lines (discovery-1)", "the package does not carry the fixed line above the question (discovery-1)",
      "the package does not end with the four closing lines (inspect)", "the package does not carry the fixed line above the question (inspect)",
      "the package does not end with the four closing lines (adjust)", "the package does not carry the fixed line above the question (adjust)",
    ]);
    const fixedUp = replay("a9-run12", 4, (label, t) => (["discovery-1", "inspect", "adjust"].includes(label) ? t.replace(packageTail, `\n\n${FIXED}\n\n${QUESTION}`) : t));
    expect(closing(fixedUp.state)).toEqual([]);
  });

  it("T2b: the fixed line missing, directly above the question, after it, or reworded fails", () => {
    const status = `${probeLine(CODEX)}\n${result("approve", "R1")}`;
    const bad = [
      ["Quality level: Full pipeline", status, QUESTION].join("\n\n"),
      ["Quality level: Full pipeline", status, `${FIXED}\n${QUESTION}`].join("\n\n"),
      ["Quality level: Full pipeline", status, QUESTION, FIXED].join("\n\n"),
      ["Quality level: Full pipeline", status, "Nothing is written until you approve.", QUESTION].join("\n\n"),
      ["Quality level: Full pipeline", status, `${FIXED} See setup-flow.md.`, QUESTION].join("\n\n"),
    ];
    for (const text of bad) expect(lib.hasFixedLine(text), text).toBe(false);
    expect(lib.hasFixedLine(pkg(result("approve", "R1")))).toBe(true);
    expect(lib.hasFixedLine(["Quality level: Full pipeline", `${status}\n${FIXED}`, QUESTION].join("\n\n"))).toBe(true);
    const d = drive("none", [{ text: bad[1]!, items: [probePath(), exec("R1", "approve")] }, ...cleanRun().slice(1)]);
    expect(closing(d.state)).toEqual(["the package does not carry the fixed line above the question (opening)"]);
    expect(closing(drive("none", cleanRun()).state)).toEqual([]);
    // Check set 3 never asks for it.
    expect(closing(drive("none", [{ text: bad[0]!, items: [probePath(), exec("R1", "approve")] }, ...cleanRun().slice(1)], 3).state)).toEqual([]);
  });

  it("T2c: run 10's four lines with trailing double spaces pass under check set 4 and fail under 3; a trailing paragraph or other whitespace still fails", () => {
    const stop = recordedStop("a9-run10", "discovery-1");
    expect(stop).toContain("How should I proceed with this setup?  \nApprove setup  \nAdjust the plan  \nInspect details\n\nThe [story setup flow]");
    const lines = stop.slice(0, stop.lastIndexOf("Inspect details") + "Inspect details".length);
    expect(lib.endsWithClosingLines(lines, 4)).toBe(true);
    expect(lib.endsWithClosingLines(lines, 3)).toBe(false);
    expect(lib.endsWithClosingLines(`${lines}\t \n`, 4)).toBe(true);
    expect(lib.endsWithClosingLines(stop, 4)).toBe(false);
    expect(lib.endsWithClosingLines(`${lines}\n\nNothing is written until you choose Approve setup.`, 4)).toBe(false);
    for (const odd of ["\u00a0", "\r", "\u2028"]) expect(lib.endsWithClosingLines(`${lines}${odd}`, 4), JSON.stringify(odd)).toBe(false);
    expect(lib.hasFixedLine(`x\n\n${FIXED}  \n\n${QUESTION}`)).toBe(true);
  });
});

// --- the reviewer capability record (G2, amendment 2) --------------------------------------------------------------

describe("check set 4 (G2): what the run shows about an agent reviewer, three states", () => {
  const cap = (items: readonly Item[], tools: readonly string[] | null = null) => lib.reviewerCapabilityOf(callsOf(items), tools, () => "discovery-1");
  const spawnItem = (agent: string): Item => ({ collab: "spawn_agent", receivers: [agent], prompt: "Review id: R1\nReview this plan." });

  it("T3c1: a Codex run reports an unknown inventory, and with no agent events an unknown capability", () => {
    expect(cap([probeNothing])).toEqual({ toolInventory: { status: "unknown" }, waitWithoutLaunch: [], observedLeak: [], reviewerCapability: "unknown" });
  });

  it("T3c2: run 8's empty wait, verbatim: one wait without launch, no leak, unknown", () => {
    const calls = turnOf(readFileSync(join(RUNS, "a9-run8", "raw", "turn-02-discovery-1.jsonl"), "utf-8"), 4).calls;
    const c = lib.reviewerCapabilityOf(calls, null, () => "discovery-1");
    expect(c.waitWithoutLaunch).toHaveLength(1);
    expect(JSON.parse(c.waitWithoutLaunch[0]!.item)).toMatchObject({ name: "collab:wait", input: { receiver_thread_ids: [], prompt: null }, result: "{}" });
    expect(c.observedLeak).toEqual([]);
    expect(c.reviewerCapability).toBe("unknown");
  });

  it("T3c3: a spawn that returned a thread is a leak", () => {
    const c = cap([spawnItem("a1")]);
    expect(c.observedLeak.map((x) => x.callIndex)).toEqual([0]);
    expect(c.reviewerCapability).toBe("leak-observed");
    expect(cap([{ ...spawnItem("a1"), failed: true } as Item]).reviewerCapability).toBe("unknown");
  });

  it("T3c4: a wait on a named thread that returned a message is a leak; one that returned nothing is not", () => {
    const done: Item = { collab: "wait", receivers: ["a1"], states: { a1: { status: "completed", message: "{\"verdict\":\"approve\",\"findings\":[]}" } } };
    expect(cap([done]).reviewerCapability).toBe("leak-observed");
    expect(cap([done]).waitWithoutLaunch).toHaveLength(1);
    const silent: Item = { collab: "wait", receivers: ["a1"], states: { a1: { status: "running" } } };
    expect(cap([spawnItem("a1"), silent]).observedLeak.map((x) => x.callIndex)).toEqual([0]);
    expect(cap([spawnItem("a1"), silent]).waitWithoutLaunch).toEqual([]);
  });

  it("T3c5: an observed, familiar inventory with no agent tool and no leak is confirmed unavailable; with a spawn tool it is unknown", () => {
    expect(cap([probeNothing], ["Bash", "Read", "Write", "Edit"]).reviewerCapability).toBe("confirmed-unavailable");
    expect(cap([probeNothing], ["Bash", "Read", "spawn_agent"]).reviewerCapability).toBe("unknown");
    expect(cap([probeNothing], ["Bash", "Read", "Write"]).toolInventory).toEqual({ status: "observed", tools: ["Bash", "Read", "Write"] });
  });

  it("amendment 2: an inventory with a synchronous Agent or Task tool, or an unfamiliar or incomplete one, is not confirmed unavailable", () => {
    for (const tools of [["Bash", "Read", "Agent"], ["Bash", "Read", "Task"], ["Bash", "mcp__x__launch_agent"], ["Read", "Write"], []]) {
      expect(cap([probeNothing], tools).reviewerCapability, tools.join(",")).toBe("unknown");
    }
    const agent: EvalCall = { name: "Agent", input: { prompt: "Review id: R1" }, isError: false, result: "{\"verdict\":\"approve\"}" };
    expect(lib.reviewerCapabilityOf([agent], ["Bash", "Read"], () => "opening").reviewerCapability).toBe("leak-observed");
    expect(lib.reviewerCapabilityOf([{ ...agent, isError: true }], ["Bash", "Read"], () => "opening").reviewerCapability).toBe("confirmed-unavailable");
  });

  it("the record carries it under check set 4 only", () => {
    expect(drive("none", cleanRun()).evidence.reviewerCapability?.reviewerCapability).toBe("unknown");
    expect(drive("none", cleanRun(), 3).evidence.reviewerCapability).toBeUndefined();
  });

  it("T3d: run 8 under check set 4 still gives the 14 ISS-1335 detector hits", () => {
    const count = (cs: number): number => replay("a9-run8", cs).state.failures.filter((f) => ISS1335.test(f)).length;
    expect(count(3)).toBe(14);
    expect(count(4)).toBe(14);
  });

  it("T3e: an empty probe then a captured review_plan review is a review, not an unavailable stop", () => {
    const d = drive("none", [
      { text: pkg(result("approve", "R1"), "nothing"), items: [probeNothing, reviewPlan("R1", "approve")] },
      { text: pkg(result("approve", "R1"), "nothing") },
      { text: pkg(result("approve", "R2"), "nothing"), items: [reviewPlan("R2", "approve")] },
      { text: summary(result("approve", "R2"), "nothing") },
    ]);
    expect(d.state.failures.filter((f) => ISS1335.test(f))).toEqual([]);
    expect(lib.stopRoute(d.state.turns[0]!.stop)).toBe("package");
    expect(d.state.failures).toEqual([]);
  });
});

// --- the re-ask after a delegated answer (D) ----------------------------------------------------------------------

describe("check set 4: the approval-probe re-ask", () => {
  it("T4b: run 10's approval-probe turn still fails the probe, status line and recipe checks", () => {
    const f = replay("a9-run10", 4).state.failures;
    expect(f).toContain("approval-probe: expected the clean package question again (the four lines), got semantic (candidate package)");
    expect(f).toContain("review status line missing (approval-probe)");
    expect(f).toContain("recipe: the approved package (approval-probe) cites none, but its quality level was named in the discovery-1 package, which cites R1");
  });

  const boundary = (probe: string): Drive4 => drive("approval-boundary", [
    { text: pkg(result("approve", "R1")), items: [probePath(), exec("R1", "approve")] },
    { text: probe },
    { text: summary(result("approve", "R1")) },
  ]);
  const reask = (fixed: string): string => ["I recommend approving the reviewed setup: two tickets and a README.", `${probeLine(CODEX)}\n${result("approve", "R1")}`, fixed].join("\n\n");

  it("T4c: the corrected re-ask (recommendation, probe and status lines, fixed line, blank line, four lines) passes every check", () => {
    const d = boundary(`${reask(FIXED)}\n\n${QUESTION}`);
    expect(d.state.turns[1]!.stop?.kind).toBe("package");
    expect(drv.approvalProbeFinding(d.state.turns[1]!.stop)).toBeNull();
    expect(d.state.failures).toEqual([]);
  });

  it("M4c: the same re-ask without the blank line fails the fixed line", () => {
    const d = boundary(`${reask(FIXED)}\n${QUESTION}`);
    expect(d.state.failures).toContain("the package does not carry the fixed line above the question (approval-probe)");
  });
});

// --- finding lines for a review that did not approve (E) ------------------------------------------------------------

describe("check set 4: a package citing a review that did not approve states each finding", () => {
  const RUN5_FINDING = "B/D/F: Clarify pupil-label retention across idempotency and browser recovery storage. B retains operation results indefinitely, which could preserve a pupil label after D removes it from the loan. Require persisted replay results to exclude pupil labels, clear resolved browser recovery payloads, and test that returning a book removes its label from current application-managed state while retries remain correct. Document historical backup retention separately under the stated deletion limitation.";

  it("T5a: run 5 gives one line per package citing R2, its finding verbatim; an approve or skip package gives none", () => {
    const lines = (replay("a9-run5", 4).evidence.judgeLines ?? []).filter((l) => l.startsWith("the package at turn"));
    expect(lines).toEqual([
      drv.findingLine("discovery-1", "R2", "request_changes", [RUN5_FINDING]),
      drv.findingLine("inspect", "R2", "request_changes", [RUN5_FINDING]),
    ]);
    expect(lines[0]).toBe(`the package at turn discovery-1 states each finding of R2 (request_changes) as unresolved or incorporated: ${RUN5_FINDING}`);
    expect(replay("a9-run5", 3).evidence.judgeLines).toBeUndefined();

    const approveWithFindings = drive("none", [{ text: pkg(result("approve", "R1")), items: [probePath(), exec("R1", "approve", ["minor: name the timezone"])] }, ...cleanRun().slice(1)]);
    expect((approveWithFindings.evidence.judgeLines ?? []).filter((l) => l.startsWith("the package at turn"))).toEqual([]);
    const skipped = drive("none", [{ text: pkg(SKIP, "nothing"), items: [probeNothing] }, { text: pkg(SKIP, "nothing") }, { text: pkg(SKIP, "nothing") }, { text: summary(SKIP, "nothing") }]);
    expect((skipped.evidence.judgeLines ?? []).filter((l) => l.startsWith("the package at turn"))).toEqual([]);
    const revise = drive("none", [{ text: pkg(result("revise", "R1")), items: [probePath(), exec("R1", "revise", ["F1: split ticket B", "F2: name the owner"])] }, ...cleanRun().slice(1)]);
    expect((revise.evidence.judgeLines ?? []).filter((l) => l.startsWith("the package at turn"))).toEqual([drv.findingLine("opening", "R1", "revise", ["F1: split ticket B", "F2: name the owner"])]);
    expect(drv.findingLine("opening", "R1", "revise", ["a", "b"])).toBe("the package at turn opening states each finding of R1 (revise) as unresolved or incorporated: a | b");
  });

  it("T5b: the finding line is required: unruled, it blocks PASS", () => {
    const d = drive("none", [{ text: pkg(result("revise", "R1")), items: [probePath(), exec("R1", "revise", ["F1: split ticket B"])] }, ...cleanRun().slice(1)]);
    const line = drv.findingLine("opening", "R1", "revise", ["F1: split ticket B"]);
    expect(d.semanticLines).toContain(line);
    const judge = { packetSha256: sha256("p"), observedModel: "m", lines: d.semanticLines.filter((l) => l !== line).map((l) => ({ line: l, verdict: "pass" as const, reason: "r" })) };
    expect(lib.runVerdict([], "p", judge, d.semanticLines)).toEqual({ verdict: "FAIL", reasons: [`the judge did not rule on: ${line}`] });
  });

  it("T5c: findings and verdict come from one response object: content text, structuredContent, a nested result (Codex round 1, findings 5 and 6)", () => {
    const body = { verdict: "request_changes", findings: ["F1"] };
    for (const text of [
      JSON.stringify(body),
      JSON.stringify({ content: [{ type: "text", text: JSON.stringify(body) }] }),
      JSON.stringify({ structuredContent: body }),
      JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify(body) }] } }),
      JSON.stringify([{ type: "text", text: JSON.stringify(body) }]),
    ]) {
      expect(lib.verdictOf(text), text).toBe("request_changes");
      expect(lib.findingsOf(text), text).toEqual(["F1"]);
    }
    expect(lib.findingsOf(JSON.stringify({ structuredContent: { verdict: "revise" } }))).toBeNull();
  });

  it("T5d: a non-approve review whose findings cannot be extracted gets a judge line that says so", () => {
    const envelope: Item = { mcp: "review_plan", args: { plan: "Review id: R1\nPlan: two tickets." }, result: { content: [{ type: "text", text: JSON.stringify({ verdict: "revise", findings: ["F1: split ticket B"] }) }] } };
    const d1 = drive("none", [{ text: pkg(result("revise", "R1")), items: [probePath(), envelope] }, ...cleanRun().slice(1)]);
    expect((d1.evidence.judgeLines ?? []).filter((l) => l.startsWith("the package at turn"))).toEqual([drv.findingLine("opening", "R1", "revise", ["F1: split ticket B"])]);
    const opaque: Item = { cmd: (exec("R1", "revise") as { cmd: string }).cmd, out: JSON.stringify({ verdict: "revise", findings: "see the notes above" }) };
    const d2 = drive("none", [{ text: pkg(result("revise", "R1")), items: [probePath(), opaque] }, ...cleanRun().slice(1)]);
    const line = drv.findingsUnextractedLine("opening", "R1", "revise");
    expect((d2.evidence.judgeLines ?? []).filter((l) => l.startsWith("the package at turn"))).toEqual([line]);
    expect(line).toBe("the package at turn opening cites R1 (revise), whose findings could not be extracted from the captured response: the package states each finding that response gives as unresolved or incorporated");
    expect(d2.semanticLines).toContain(line);
  });
});

// --- the read-only cross-check (F) --------------------------------------------------------------------------------

describe("the cross-check: a stored run re-read under another check set, never written", () => {
  const hashes = (dir: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (d: string): void => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else out[p.slice(dir.length)] = sha256(readFileSync(p)); } };
    walk(dir);
    return out;
  };
  const copy = (name: string): string => { const dir = mkdtempSync(join(tmpdir(), "crosscheck-")); cpSync(join(RUNS, name), dir, { recursive: true }); return dir; };

  it("T6a: a check set 3 run cross-checked to check set 3 changes nothing", async () => {
    const cc = await import("../../scripts/onboarding-eval-crosscheck.js");
    const dir = copy("a9-run12");
    try {
      const r = cc.crosscheck(dir, 3);
      expect({ source: r.sourceCheckSet, target: r.targetCheckSet, added: r.added, removed: r.removed, nr: r.needsReview, judge: r.judgeLines, matches: r.sourceMatchesRecord }).toEqual({
        source: 3, target: 3, added: {}, removed: {}, nr: { added: [], removed: [] }, judge: { added: [], removed: [] }, matches: true,
      });
      expect(r.sourceVerdict).toBe(r.targetVerdict);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("T6b: run 12 cross-checked to check set 4 lists the fixed-line additions, the needs-review change and the new judge lines", async () => {
    const cc = await import("../../scripts/onboarding-eval-crosscheck.js");
    const dir = copy("a9-run12");
    try {
      const r = cc.crosscheck(dir, 4);
      expect(r.rules).toEqual({ source: { stop: lib.stopRuleFor(3), write: lib.writeRuleFor(3) }, target: { stop: lib.stopRuleFor(4), write: lib.writeRuleFor(4) } });
      expect(r.added).toEqual({ closing: ["the package does not carry the fixed line above the question (discovery-1)", "the package does not carry the fixed line above the question (inspect)", "the package does not carry the fixed line above the question (adjust)"] });
      expect(r.removed).toEqual({});
      expect(r.needsReview).toEqual({
        removed: ["needs review, shell construct not parsed: python3 - <<'' [heredoc into python3]; python3 - <<'' [heredoc into python3]"],
        added: ["needs review, shell construct not parsed: python3 - <<'' [heredoc into python3]"],
      });
      expect(r.judgeLines.added.filter((l) => l.includes("runs a python3 script"))).toHaveLength(1);
      expect(r.judgeLines.added.filter((l) => l.startsWith("the package at turn"))).toHaveLength(2);
      expect(r.judgeLines.removed).toEqual([]);
      expect([r.sourceVerdict, r.targetVerdict]).toEqual(["FAIL", "FAIL"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("T6c: the source run's files are byte-identical after a cross-check, and the report names their hashes", async () => {
    const cc = await import("../../scripts/onboarding-eval-crosscheck.js");
    const dir = copy("a9-run8");
    try {
      const before = hashes(dir);
      const r = cc.crosscheck(dir, 4);
      expect(hashes(dir)).toEqual(before);
      expect(r.recordSha256).toBe(before[join("/", "record", "record.json")]);
      expect(r.packetSha256).toBe(before[join("/", "record", "grading-packet.json")]);
      expect(r.sourceUnchanged).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("T6d: links in the source are hashed as links, never followed: dangling, an ancestor cycle, a directory outside (Codex round 1, finding 4)", async () => {
    const cc = await import("../../scripts/onboarding-eval-crosscheck.js");
    const dir = copy("a9-run8");
    const outside = mkdtempSync(join(tmpdir(), "crosscheck-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "not part of the run");
      symlinkSync("/nonexistent/crosscheck-target", join(dir, "raw", "zz-dangling"));
      symlinkSync("..", join(dir, "raw", "zz-cycle"));
      symlinkSync(outside, join(dir, "raw", "zz-outside"));
      const tree = cc.hashTree(join(dir, "raw"));
      expect(tree["zz-dangling"]).toBe("link:/nonexistent/crosscheck-target");
      expect(tree["zz-cycle"]).toBe("link:..");
      expect(tree["zz-outside"]).toBe(`link:${outside}`);
      expect(Object.keys(tree).filter((k) => k.startsWith("zz-outside/") || k.startsWith("zz-cycle/"))).toEqual([]);
      const r = cc.crosscheck(dir, 4);
      expect(r.sourceUnchanged).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });
});
