/**
 * T-538 commit 3 (plan v5 6.1): the schedule grammar, the later sessions a schedule asks for, and the
 * preservation rules on synthetic snapshots, one row per rule. The rules on real kills are in
 * t538-host-faults.test.ts; these rows prove each rule can fail.
 */
import { describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventsLog } from "../../scripts/onboarding-eval-checkset7-events.js";
import { editedSnapshotFindings, END_RAW, EDITED_RAW, killRaw, parseTreeSnap, treeSnapshot, preservationFindings, protectedPathsOf, TreeSnapError, type TreeSnap } from "../../scripts/onboarding-eval-preserve.js";
import { checkSchedule, parseSchedule, scheduleFor } from "../../scripts/onboarding-eval-schedule.js";
import { walkNoFollow } from "../../scripts/onboarding-eval-walk.js";
import { faultSnapshotFindings, laterSessions, NO_FACTS, type SessionScript } from "../../scripts/onboarding-eval-sessions.js";

describe("6.1: the fault schedule", () => {
  it("parses entries into session order and maps --fault to 1=f1", () => {
    expect(parseSchedule("2=b:recovery:bootstrap:manifest-removed,1=a:bootstrap:publish")).toEqual([
      { session: 1, id: "a", selector: "bootstrap:publish" }, { session: 2, id: "b", selector: "recovery:bootstrap:manifest-removed" },
    ]);
    expect(parseSchedule("1=f1:step:item:*")).toEqual([{ session: 1, id: "f1", selector: "step:item:*" }]);
    expect(scheduleFor("step:config#2", null)).toEqual([{ session: 1, id: "f1", selector: "step:config#2" }]);
    expect(scheduleFor(null, null)).toBeNull();
  });

  it.each([
    ["", "--fault-schedule is empty"],
    ["a:step:config", "--fault-schedule entry a:step:config is not <session>=<id>:<selector>"],
    ["0=a:step:config", "--fault-schedule entry 0=a:step:config is not <session>=<id>:<selector>"],
    ["1=a b:step:config", "--fault-schedule id a b is not an id"],
    ["1=a:Step Config", "--fault-schedule selector Step Config is not a point, point:* or point#n"],
    ["1=a:step:config#0", "--fault-schedule selector step:config#0 is not a point, point:* or point#n"],
    ["1=a:step:config,2=a:step:handover", "--fault-schedule: two entries share an id"],
    ["1=a:step:config,1=b:step:handover", "--fault-schedule: two entries share a session"],
    ["2=a:step:config", "--fault-schedule: the armed sessions must be 1 to 1 with no gap"],
    ["1=a:step:config,3=b:step:handover", "--fault-schedule: the armed sessions must be 1 to 2 with no gap"],
  ])("refuses %j", (text, message) => {
    expect(() => parseSchedule(text)).toThrow(message);
  });

  it("refuses --fault with --fault-schedule, and checkSchedule refuses the same shapes as parsing", () => {
    expect(() => scheduleFor("step:config", "1=a:step:config")).toThrow("--fault and --fault-schedule are exclusive");
    expect(() => checkSchedule([{ session: 2, id: "a", selector: "step:config" }])).toThrow("no gap");
  });

  const script: SessionScript = { editRuling: "keep my edit", milestoneRun: "", demoApproval: "", changeRequest: "", reopen: "", reapproval: "" };
  it("asks for one later session per armed session: k armed, k later, the last unarmed", () => {
    expect(laterSessions("interrupted", "/story", script, null).map((s) => s.turns.map((t) => t.label))).toEqual([["session-2-open"]]);
    expect(laterSessions("interrupted", "/story", script, null, 2).map((s) => s.turns.map((t) => t.label))).toEqual([["session-2-open"], ["session-3-open"]]);
    expect(laterSessions("interrupted-edited", "/story", script, null, 2).map((s) => s.turns.map((t) => t.label))).toEqual([["session-2-open", "edit-ruling"], ["session-3-open"]]);
    expect(laterSessions("interrupted", "/story", script, null, 3)).toHaveLength(3);
  });
});

const b64 = (s: string): string => Buffer.from(s, "utf-8").toString("base64");
const snap = (files: Record<string, string | object>, extra: Partial<TreeSnap> = {}): TreeSnap => ({
  files: Object.fromEntries(Object.entries(files).map(([p, v]) => [p, b64(typeof v === "string" ? v : JSON.stringify(v))])), links: [], truncated: false, problems: [], ...extra,
});
const ticket = (id: string, key: string, over: Record<string, unknown> = {}) => ({ id, title: `t ${id}`, status: "open", blockedBy: [], updatedDate: "2026-11-10", setup: { key }, ...over });
const note = (status: string) => ({ id: "N-001", createdDate: "2026-11-10", status, setup: { record: "progress" } });

/** A log with one attempt (pid 111) that fired at `point` on line 5, step:config at line 2 and one archive commit (the fault's own when it is the archive's). */
function log(point = "step:handover", over: Partial<EventsLog> = {}): EventsLog {
  const ev = (line: number, p: string) => ({ line, attempt: line < 5 ? "a1" : "a2", seq: line, point: p, setupId: "SS-0123abcd", invocation: null, revision: null });
  return {
    attempts: [{ line: 0, attempt: "a1", pid: 111, entry: "cli" }, { line: 6, attempt: "a2", pid: 222, entry: "cli" }],
    events: [ev(2, "step:config"), ev(4, point), ...(point === "archive-committed" ? [] : [ev(8, "archive-committed")])],
    overlaps: [],
    fired: [{ line: 5, attempt: "a1", id: "f1", selector: point, point, target: null, invocation: null }],
    ...over,
  };
}

const BASE = {
  "src/app.ts": "app",
  ".story/config.json": { version: 5 },
  ".story/tickets/T-001.json": ticket("T-001", "K1"),
  ".story/tickets/T-002.json": ticket("T-002", "K2", { blockedBy: ["T-009"] }),
  ".story/notes/N-001.json": note("active"),
};
const END = { ...BASE, ".story/tickets/T-002.json": ticket("T-002", "K2", { blockedBy: ["T-009", "T-001"], updatedDate: "2026-11-11" }), ".story/notes/N-001.json": note("archived") };
const rules = (baseline: TreeSnap, end: TreeSnap, l: EventsLog = log(), selector = "step:handover") =>
  preservationFindings("interrupted", { baseline, end, protectedPaths: ["src/app.ts"], selector, firedLine: Math.min(...(l.fired ?? []).map((f) => f.line)), log: l });

describe("6.1: the preservation rules", () => {
  it("hold on a resume that only wired a published item and archived the note", () => {
    expect(rules(snap(BASE), snap(END))).toEqual([]);
  });

  it.each<[string, Record<string, string | object>, string[]]>([
    ["a protected file changed", { "src/app.ts": "app2" }, ["interrupted: src/app.ts changed after the baseline"]],
    ["the bootstrap manifest left", { ".story/.setup-bootstrap.json": "{}" }, ["interrupted: the bootstrap manifest is still there after the resume"]],
    ["a lock left", { ".story/.lock": "" }, ["interrupted: .story/.lock is still there after the resume"]],
    ["a lock temp of a pid not killed", { ".story/.lock.tmp.222.0123abcd-0123-4abc-8abc-0123456789ab": "" }, ["interrupted: .story/.lock.tmp.222.0123abcd-0123-4abc-8abc-0123456789ab is still there after the resume"]],
    ["the note not archived", { ".story/notes/N-001.json": note("active") }, ["interrupted: the progress note ends active, not archived"]],
    ["the note replaced", { ".story/notes/N-001.json": { ...note("archived"), createdDate: "2026-11-11" } }, ["interrupted: the progress note is not the one at the baseline (path, id or created date changed)"]],
    ["a field no step owns changed", { ".story/tickets/T-001.json": ticket("T-001", "K1", { title: "renamed" }) }, ["interrupted: K1 changed title after the baseline, which no remaining step owns"]],
    ["a displayId that is not the id", { ".story/tickets/T-001.json": ticket("T-001", "K1", { displayId: "T-777" }) }, ["interrupted: K1's displayId changed to something other than its id"]],
    ["an owner edge lost", { ".story/tickets/T-002.json": ticket("T-002", "K2", { blockedBy: ["T-001"] }) }, ["interrupted: K2 lost a blockedBy edge it had at the baseline"]],
    ["a key published twice", { ".story/tickets/T-003.json": ticket("T-003", "K1") }, ["interrupted: K1 is not at its baseline path after the resume", "interrupted: K1 is published 2 times"]],
    ["config changed after step:config committed", { ".story/config.json": { version: 6 } }, ["interrupted: config.json changed after step:config committed before the fault"]],
  ])("find %s", (_name, change, findings) => {
    expect(rules(snap(BASE), snap({ ...END, ...change }))).toEqual(findings);
  });

  it("allow a killed pid's lock temp (ISS-1184), and a displayId filled with the id", () => {
    const end = { ...END, ".story/.lock.tmp.111.0123abcd-0123-4abc-8abc-0123456789ab": "", ".story/tickets/T-001.json": ticket("T-001", "K1", { displayId: "T-001" }) };
    expect(rules(snap(BASE), snap(end))).toEqual([]);
  });

  it("find a missing note, a moved item, a truncated or linked snapshot, and an archive not committed once", () => {
    const { [".story/notes/N-001.json"]: _n, ...noNote } = END;
    expect(rules(snap(BASE), snap(noNote))).toEqual(["interrupted: no progress note after the resume"]);
    const { [".story/tickets/T-001.json"]: t1, ...moved } = END;
    expect(rules(snap(BASE), snap({ ...moved, ".story/tickets/t-moved.json": t1 }))).toEqual(["interrupted: K1 is not at its baseline path after the resume"]);
    expect(rules(snap(BASE, { truncated: true }), snap(END, { links: ["x"] }))).toEqual(["interrupted: the baseline snapshot is truncated", "interrupted: the project's links changed after the baseline"]);
    const twice = log("step:handover");
    expect(rules(snap(BASE), snap(END), { ...twice, events: [...twice.events, { ...twice.events[2]!, line: 9 }] })).toEqual(["interrupted: the archive committed 2 times, not once"]);
  });

  it("hold the archive class to an archived note at the baseline, and every other class to an active one", () => {
    const archivedBase = { ...BASE, ".story/notes/N-001.json": note("archived") };
    expect(rules(snap(archivedBase), snap(END), log("archive-committed"), "archive-committed")).toEqual([]);
    expect(rules(snap(archivedBase), snap(END))).toEqual(["interrupted: the progress note was archived at the baseline, not active"]);
    expect(rules(snap(BASE), snap(END), log("archive-committed"), "archive-committed")).toEqual(["interrupted: the progress note was active at the baseline, not archived"]);
  });

  it("parse a snapshot file, refusing every other shape by name", () => {
    expect(parseTreeSnap(JSON.stringify(snap(BASE)))).toEqual(snap(BASE));
    for (const [text, why] of [["{", "not JSON"], ["[]", "not an object"], ['{"files":{"a":1},"links":[],"truncated":false}', "files is not a map of base64 strings"], ['{"files":{},"links":"x","truncated":false}', "links is not a list of paths"], ['{"files":{},"links":[]}', "truncated is not a boolean"]]) {
      expect(() => parseTreeSnap(text!), text).toThrow(new TreeSnapError(why!));
    }
  });

  it("take the protected paths from the fixture's manifest, outside .story/", () => {
    expect(protectedPathsOf([{ path: "project/src/app.ts" }, { path: "project/.story/config.json" }, { path: "rubric.json" }, { path: "project/README.md" }])).toEqual(["README.md", "src/app.ts"]);
    // The regrade's manifest names the same files under fixture/, and must give the same list.
    expect(protectedPathsOf([{ path: "fixture/project/src/app.ts" }, { path: "fixture/project/.story/config.json" }, { path: "fixture/rubric.json" }, { path: "fixture/project/README.md" }])).toEqual(["README.md", "src/app.ts"]);
  });
});

describe("6.1: interrupted-edited's second snapshot", () => {
  const edits = { edgeTicket: "T-002", blocker: "T-001", describedTicket: "T-001", description: "d\n\nOwner edit: keep it small." };
  const kill = snap(BASE);
  const edited = { ...BASE, ".story/tickets/T-001.json": ticket("T-001", "K1", { description: edits.description, updatedDate: "2026-11-11" }), ".story/tickets/T-002.json": ticket("T-002", "K2", { blockedBy: ["T-009", "T-001"] }) };

  it("differs from the kill snapshot in exactly the recorded owner edits (a displayId filled with the id allowed)", () => {
    expect(editedSnapshotFindings(kill, snap(edited), edits)).toEqual([]);
    expect(editedSnapshotFindings(kill, snap({ ...edited, ".story/tickets/T-002.json": ticket("T-002", "K2", { blockedBy: ["T-009", "T-001"], displayId: "T-002" }) }), edits)).toEqual([]);
  });

  it.each<[string, Record<string, string | object>, string[]]>([
    ["another file changed", { "src/app.ts": "x" }, ["interrupted-edited: src/app.ts differs between the kill snapshot and the edited snapshot, and no owner edit names it"]],
    ["another field of an edited ticket changed", { ".story/tickets/T-002.json": ticket("T-002", "K2", { blockedBy: ["T-009", "T-001"], status: "complete" }) }, ["interrupted-edited: .story/tickets/T-002.json changed status, which the owner edits do not name"]],
    ["the edge missing", { ".story/tickets/T-002.json": ticket("T-002", "K2", { blockedBy: ["T-009"] }) }, ["interrupted-edited: T-002's blockedBy is not the kill snapshot's plus T-001"]],
    ["an edge the owner did not add", { ".story/tickets/T-002.json": ticket("T-002", "K2", { blockedBy: ["T-009", "T-001", "T-005"] }) }, ["interrupted-edited: T-002's blockedBy is not the kill snapshot's plus T-001"]],
    ["a displayId that is not the id", { ".story/tickets/T-001.json": ticket("T-001", "K1", { description: "d\n\nOwner edit: keep it small.", displayId: "T-777" }) }, ["interrupted-edited: .story/tickets/T-001.json changed displayId, which the owner edits do not name"]],
    ["the description not the edit", { ".story/tickets/T-001.json": ticket("T-001", "K1", { description: "other" }) }, ["interrupted-edited: T-001's description is not the owner's edit"]],
  ])("finds %s", (_name, change, findings) => {
    expect(editedSnapshotFindings(kill, snap({ ...edited, ...change }), edits)).toEqual(findings);
  });

  it("finds an edit naming a ticket the kill snapshot does not hold", () => {
    expect(editedSnapshotFindings(kill, snap(edited), { ...edits, blocker: "T-404" })).toEqual(["interrupted-edited: the kill snapshot does not hold the edited tickets"]);
  });
});

describe("6.1: the live attempt's recorded snapshots", () => {
  const named = (m: Record<string, TreeSnap | string>) => ({ read: (n: string) => (n in m ? (typeof m[n] === "string" ? m[n] as string : JSON.stringify(m[n])) : null), protectedPaths: ["src/app.ts"] });
  const harness = { ...NO_FACTS, schedule: [{ session: 1, id: "f1", selector: "step:handover", fired: true }] };

  it("pass when every snapshot is recorded and the rules hold", () => {
    expect(faultSnapshotFindings("interrupted", harness, log(), named({ [killRaw("f1")]: snap(BASE), [END_RAW]: snap(END) }))).toEqual([]);
  });

  it("apply nothing to a stored run whose log has no fired record (the legacy marker)", () => {
    expect(faultSnapshotFindings("interrupted", harness, { ...log(), fired: [] }, undefined)).toEqual([]);
    expect(faultSnapshotFindings("interrupted", harness, null, undefined)).toEqual([]);
  });

  it("find a run that kept no snapshots, a missing kill or end snapshot, and a malformed one", () => {
    expect(faultSnapshotFindings("interrupted", harness, log(), undefined)).toEqual(["interrupted: the run kept no fault snapshots"]);
    expect(faultSnapshotFindings("interrupted", harness, log(), named({ [END_RAW]: snap(END) }))).toEqual(["interrupted: the kill snapshot of f1 (fault-kill.f1.json) is missing"]);
    expect(faultSnapshotFindings("interrupted", harness, log(), named({ [killRaw("f1")]: snap(BASE) }))).toEqual(["interrupted: the end snapshot (fault-end.json) is missing"]);
    expect(faultSnapshotFindings("interrupted", harness, log(), named({ [killRaw("f1")]: snap(BASE), [END_RAW]: "{" }))).toEqual(["interrupted: the end snapshot (fault-end.json) is malformed: not JSON"]);
  });

  it("P6: every later kill snapshot is held: an item created between two faults and changed after the second kill is caught", () => {
    const two = log("step:handover", { fired: [{ line: 5, attempt: "a1", id: "f1", selector: "step:handover", point: "step:handover", target: null, invocation: null }, { line: 7, attempt: "a2", id: "f2", selector: "step:handover", point: "step:handover", target: null, invocation: null }] });
    const h2 = { ...NO_FACTS, schedule: [{ session: 1, id: "f1", selector: "step:handover", fired: true }, { session: 2, id: "f2", selector: "step:handover", fired: true }] };
    const second = { ...BASE, ".story/tickets/T-003.json": ticket("T-003", "K3") };
    const end = { ...END, ".story/tickets/T-003.json": ticket("T-003", "K3") };
    const snaps = (e: Record<string, string | object>, k2: TreeSnap = snap(second)) => named({ [killRaw("f1")]: snap(BASE), [killRaw("f2")]: k2, [END_RAW]: snap(e) });
    expect(faultSnapshotFindings("interrupted", h2, two, snaps(end))).toEqual([]);
    // The first kill never saw K3, so only the second kill's snapshot can hold the end to it.
    expect(faultSnapshotFindings("interrupted", h2, two, snaps({ ...end, ".story/tickets/T-003.json": ticket("T-003", "K3", { title: "renamed" }) })))
      .toEqual(["interrupted: K3 changed title after the baseline, which no remaining step owns"]);
    expect(faultSnapshotFindings("interrupted", h2, two, snaps(end, snap(second, { truncated: true })))).toEqual(["interrupted: the kill snapshot of f2 is truncated"]);
    expect(faultSnapshotFindings("interrupted", h2, two, snaps(end, snap(second, { problems: ["project/x could not be read (EACCES)"] })))).toEqual(["interrupted: the kill snapshot of f2: project/x could not be read (EACCES)"]);
    expect(faultSnapshotFindings("interrupted", h2, two, named({ [killRaw("f1")]: snap(BASE), [END_RAW]: snap(end) }))).toEqual(["interrupted: the kill snapshot of f2 (fault-kill.f2.json) is missing"]);
  });

  it("Q2: config.json committed between two faults and changed after the second kill is caught from the second kill's line", () => {
    const ev = (line: number, attempt: string, p: string) => ({ line, attempt, seq: line, point: p, setupId: "SS-0123abcd", invocation: null, revision: null });
    const two: EventsLog = {
      attempts: [{ line: 0, attempt: "a1", pid: 111, entry: "cli" }, { line: 4, attempt: "a2", pid: 222, entry: "cli" }, { line: 10, attempt: "a3", pid: 333, entry: "cli" }],
      events: [ev(2, "a1", "step:item:K3"), ev(6, "a2", "step:config"), ev(8, "a2", "step:handover"), ev(12, "a3", "archive-committed")],
      overlaps: [],
      fired: [{ line: 3, attempt: "a1", id: "f1", selector: "step:item:*", point: "step:item:K3", target: null, invocation: null }, { line: 9, attempt: "a2", id: "f2", selector: "step:handover", point: "step:handover", target: null, invocation: null }],
    };
    const h2 = { ...NO_FACTS, schedule: [{ session: 1, id: "f1", selector: "step:item:*", fired: true }, { session: 2, id: "f2", selector: "step:handover", fired: true }] };
    const k1 = { ...BASE, ".story/config.json": { version: 5 } };
    const k2 = { ...BASE, ".story/config.json": { version: 6 } };
    const end = { ...END, ".story/config.json": { version: 6 } };
    const snaps = (e: Record<string, string | object>) => named({ [killRaw("f1")]: snap(k1), [killRaw("f2")]: snap(k2), [END_RAW]: snap(e) });
    expect(faultSnapshotFindings("interrupted", h2, two, snaps(end))).toEqual([]);
    expect(faultSnapshotFindings("interrupted", h2, two, snaps({ ...end, ".story/config.json": { version: 7 } })))
      .toEqual(["interrupted: config.json changed after step:config committed before the fault"]);
  });

  it("hold interrupted-edited to the edited baseline: missing is a finding, and the end is compared with it, not with the kill", () => {
    const edits = { edgeTicket: "T-002", blocker: "T-001", describedTicket: "T-001", description: "edited" };
    const editedFiles = { ...BASE, ".story/tickets/T-001.json": ticket("T-001", "K1", { description: "edited" }), ".story/tickets/T-002.json": ticket("T-002", "K2", { blockedBy: ["T-009", "T-001"] }) };
    const end = { ...editedFiles, ".story/notes/N-001.json": note("archived") };
    const h = { ...harness, edits };
    expect(faultSnapshotFindings("interrupted-edited", h, log(), named({ [killRaw("f1")]: snap(BASE), [END_RAW]: snap(end) }))).toEqual(["interrupted-edited: the snapshot after the owner's edits (fault-edited.json) is missing"]);
    expect(faultSnapshotFindings("interrupted-edited", h, log(), named({ [killRaw("f1")]: snap(BASE), [EDITED_RAW]: snap(editedFiles), [END_RAW]: snap(end) }))).toEqual([]);
    // The end losing the owner's description is a change from the edited baseline.
    const lost = { ...end, ".story/tickets/T-001.json": ticket("T-001", "K1") };
    expect(faultSnapshotFindings("interrupted-edited", h, log(), named({ [killRaw("f1")]: snap(BASE), [EDITED_RAW]: snap(editedFiles), [END_RAW]: snap(lost) }))).toEqual(["interrupted-edited: K1 changed description after the baseline, which no remaining step owns"]);
  });
});

describe("Codex round 1 P2: the kill snapshot's walk never follows, and every bound holds", () => {
  const tree = (f: (d: string) => void): string => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "t538snap-")));
    f(d);
    return d;
  };
  it("a file swapped for a link between its listing and its open is a problem, and the link's target is never read", () => {
    const d = tree((d) => { writeFileSync(join(d, "a.txt"), "mine"); writeFileSync(join(d, "secret"), "outside bytes"); });
    try {
      const snap = parseTreeSnap(treeSnapshot(d, undefined, undefined, undefined, (step, rel) => {
        if (step === "open" && rel === "a.txt") { unlinkSync(join(d, "a.txt")); symlinkSync(join(d, "secret"), join(d, "a.txt")); }
      }));
      expect(snap.files["a.txt"]).toBeUndefined();
      expect(snap.problems).toEqual(["project/a.txt could not be read (ELOOP)"]);
      expect(preservationFindings("v", { baseline: snap, end: snap, protectedPaths: [], selector: "step:config", firedLine: Number.POSITIVE_INFINITY, log: { events: [], attempts: [], fired: [] } as unknown as EventsLog }))
        .toEqual(expect.arrayContaining(["v: the baseline snapshot: project/a.txt could not be read (ELOOP)", "v: the end snapshot: project/a.txt could not be read (ELOOP)"]));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it("a file that grows past the byte bound while it is read stops at the bound and truncates the snapshot", () => {
    const d = tree((d) => { writeFileSync(join(d, "grow.log"), "x"); });
    try {
      const snap = parseTreeSnap(treeSnapshot(d, 10, 1024, 64, (step, rel) => {
        if (step === "open" && rel === "grow.log") appendFileSync(join(d, "grow.log"), Buffer.alloc(4096, 120));
      }));
      expect(snap.truncated).toBe(true);
      expect(snap.files["grow.log"]).toBeUndefined();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it("many empty folders count against the entry bound, as does depth", () => {
    const wide = tree((d) => { for (let n = 0; n < 50; n++) mkdirSync(join(d, `e${n}`)); });
    const deep = tree((d) => { mkdirSync(join(d, ...Array.from({ length: 8 }, (_, n) => `d${n}`)), { recursive: true }); });
    try {
      expect(parseTreeSnap(treeSnapshot(wide, 10)).truncated).toBe(true);
      expect(parseTreeSnap(treeSnapshot(wide, 60)).truncated).toBe(false);
      expect(parseTreeSnap(treeSnapshot(deep, 100, 1024, 4)).truncated).toBe(true);
      expect(parseTreeSnap(treeSnapshot(deep, 100, 1024, 8)).truncated).toBe(false);
    } finally {
      rmSync(wide, { recursive: true, force: true });
      rmSync(deep, { recursive: true, force: true });
    }
  });
  it("Q1: a folder wider than the entry bound: the listing reads the bound plus one names, nothing past the bound is lstat'd, and the snapshot is refused", () => {
    const d = tree((d) => { for (let n = 0; n < 200; n++) writeFileSync(join(d, `f${String(n).padStart(3, "0")}`), ""); });
    try {
      const seen = { check: 0, name: 0 };
      const snap = parseTreeSnap(treeSnapshot(d, 20, 1024, 64, (step) => { if (step === "check" || step === "name") seen[step]++; }));
      expect(seen).toEqual({ check: 20, name: 21 });
      expect(snap.truncated).toBe(true);
      expect(snap.problems).toEqual(["project: the snapshot stopped at its entry bound (20)"]);
      expect(preservationFindings("v", { baseline: snap, end: snap, protectedPaths: [], selector: "step:config", firedLine: Number.POSITIVE_INFINITY, log: { events: [], attempts: [], fired: [] } as unknown as EventsLog }))
        .toEqual(expect.arrayContaining(["v: the baseline snapshot is truncated", "v: the baseline snapshot: project: the snapshot stopped at its entry bound (20)"]));
      // A walk with no budget still sees every entry, through the same streaming listing.
      let all = 0;
      expect(walkNoFollow(d, "t", { link: () => {}, file: () => { all++; return null; } }).stopped).toBeNull();
      expect(all).toBe(200);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it("Q1: once the byte bound is spent the walk ends at once: no later entry is listed, lstat'd or opened", () => {
    const d = tree((d) => { writeFileSync(join(d, "a.bin"), Buffer.alloc(4096, 120)); mkdirSync(join(d, "b")); for (let n = 0; n < 30; n++) writeFileSync(join(d, `c${n}`), "x"); });
    try {
      const after: string[] = [];
      let over = false;
      const snap = parseTreeSnap(treeSnapshot(d, 4000, 1024, 64, (step, rel) => {
        if (over) after.push(`${step} ${rel}`);
        if (step === "open" && rel === "a.bin") over = true;
      }));
      expect(after).toEqual([]);
      expect(snap.truncated).toBe(true);
      expect(snap.problems).toEqual(["project: the snapshot stopped at its byte bound (1024)"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it("a snapshot's problems must be a list of findings; an older snapshot without the field reads as none", () => {
    expect(parseTreeSnap(JSON.stringify({ files: {}, links: [], truncated: false })).problems).toEqual([]);
    expect(() => parseTreeSnap(JSON.stringify({ files: {}, links: [], truncated: false, problems: "x" }))).toThrow(TreeSnapError);
  });
});
