/**
 * ISS-1499 slice A: the lineage line grammar (A1), the tail rule on strings
 * (A2, string side), removal and addition (A3) and the Parent / tip / fork /
 * loop computations (A12). Pure: no file is touched here.
 */
import { describe, it, expect } from "vitest";
import {
  LINEAGE_MAX_LINE_BYTES,
  appendLineage,
  buildLineageGraph,
  parseLineageLine,
  readLineage,
  serializeLineage,
  splitLineage,
  walkLine,
  type LineageScan,
  type ScannedFile,
} from "../../src/core/handover-lineage.js";
import { LINE, TAIL_SHAPES } from "../fixtures/handover-lineage/shapes.js";

const P = "<!-- storybloq-lineage v1";
const line = (attrs: string): string => `${P}${attrs} -->`;

// ---------------------------------------------------------------------------
// A1. Grammar
// ---------------------------------------------------------------------------

describe("A1 lineage grammar", () => {
  it("the bare line is valid and marks the first handover of a new line", () => {
    expect(parseLineageLine(`${P} -->`)).toEqual({
      lineage: { continues: { state: "absent" }, from: null, absorbs: [], role: null, at: null, by: null },
      dropped: [],
    });
  });

  it("parses every attribute", () => {
    const r = parseLineageLine(line(' continues="a.md" from="b.md" absorbs="c.md" absorbs="d.md" role="worker" at="abc1234" by="w@x.y"'));
    expect(r).toEqual({
      lineage: { continues: { state: "valid", file: "a.md" }, from: "b.md", absorbs: ["c.md", "d.md"], role: "worker", at: "abc1234", by: "w@x.y" },
      dropped: [],
    });
  });

  it.each([
    ["v2", '<!-- storybloq-lineage v2 continues="a.md" -->'],
    ["v10", "<!-- storybloq-lineage v10 -->"],
    ["v1 with no space before -->", "<!-- storybloq-lineage v1-->"],
    ["two spaces between parts", '<!-- storybloq-lineage v1  continues="a.md" -->'],
    ["leading space", ' <!-- storybloq-lineage v1 -->'],
    ["trailing space", '<!-- storybloq-lineage v1 --> '],
    ["an unquoted value", "<!-- storybloq-lineage v1 continues=a.md -->"],
    ["a quote inside a value", '<!-- storybloq-lineage v1 role="a"b" -->'],
    ["an uppercase attribute name", '<!-- storybloq-lineage v1 Role="a" -->'],
    ["not a comment", "storybloq-lineage v1"],
  ])("%s is not a lineage line", (_n, l) => {
    expect(parseLineageLine(l)).toBeNull();
  });

  it("the first occurrence counts, valid or not; later ones are dropped as duplicates", () => {
    expect(parseLineageLine(line(' continues="a.md" continues="b.md"'))).toEqual({
      lineage: { continues: { state: "valid", file: "a.md" }, from: null, absorbs: [], role: null, at: null, by: null },
      dropped: [{ attribute: "continues", reason: "duplicate" }],
    });
    const r = parseLineageLine(line(' continues="../a.md" continues="b.md" role="x" role="y"'))!;
    expect(r.lineage.continues).toEqual({ state: "invalid" });
    expect(r.lineage.role).toBe("x");
    expect(r.dropped).toEqual([
      { attribute: "continues", reason: "invalid" },
      { attribute: "continues", reason: "duplicate" },
      { attribute: "role", reason: "duplicate" },
    ]);
    const s = parseLineageLine(line(' role="<x>" role="ok"'))!;
    expect(s.lineage.role).toBeNull();
    expect(s.dropped).toEqual([{ attribute: "role", reason: "invalid" }, { attribute: "role", reason: "duplicate" }]);
  });

  it("nine absorbs keep the first eight; duplicates are removed silently", () => {
    const nine = Array.from({ length: 9 }, (_, i) => ` absorbs="t${i}.md"`).join("");
    const r = parseLineageLine(line(nine))!;
    expect(r.lineage.absorbs).toEqual(["t0.md", "t1.md", "t2.md", "t3.md", "t4.md", "t5.md", "t6.md", "t7.md"]);
    expect(r.dropped).toEqual([{ attribute: "absorbs", reason: "count_limit" }]);
    const d = parseLineageLine(line(' absorbs="a.md" absorbs="a.md" absorbs="b.md"'))!;
    expect(d.lineage.absorbs).toEqual(["a.md", "b.md"]);
    expect(d.dropped).toEqual([]);
  });

  it("an unknown attribute is dropped by name and the rest of the line counts", () => {
    const r = parseLineageLine(line(' continues="a.md" colour="red" role="w"'))!;
    expect(r.lineage.continues).toEqual({ state: "valid", file: "a.md" });
    expect(r.lineage.role).toBe("w");
    expect(r.dropped).toEqual([{ attribute: "colour", reason: "unknown" }]);
  });

  it.each([
    ["<", "a<b"],
    [">", "a>b"],
    ["backslash", "a\\b"],
    ["tab", "a\tb"],
    ["DEL", "a\u007fb"],
    ["a non-ASCII byte", "café"],
    ["empty", ""],
  ])("a role holding %s is dropped as invalid", (_n, v) => {
    const r = parseLineageLine(line(` role="${v}" at="abc1234"`))!;
    expect(r).not.toBeNull();
    expect(r.lineage.role).toBeNull();
    expect(r.lineage.at).toBe("abc1234");
    expect(r.dropped).toEqual([{ attribute: "role", reason: "invalid" }]);
  });

  it.each([
    ["a slash", "a/b.md", false],
    ["two dots", "a..b.md", false],
    ["no .md", "a.txt", false],
    ["255 bytes", "a".repeat(252) + ".md", true],
    ["256 bytes", "a".repeat(253) + ".md", false],
    ["a space", "a b.md", true],
  ])("a FILE value with %s is valid: %s", (_n, v, ok) => {
    for (const attr of ["continues", "from", "absorbs"]) {
      const r = parseLineageLine(line(` ${attr}="${v}"`))!;
      expect(r.dropped.length === 0).toBe(ok);
    }
    const c = parseLineageLine(line(` continues="${v}"`))!;
    expect(c.lineage.continues).toEqual(ok ? { state: "valid", file: v } : { state: "invalid" });
  });

  it.each([
    ["role", "r".repeat(64), true],
    ["role", "r".repeat(65), false],
    ["by", "b".repeat(128), true],
    ["by", "b".repeat(129), false],
    ["at", "abcdef0", true],
    ["at", "abcdef", false],
    ["at", "a".repeat(40), true],
    ["at", "a".repeat(41), false],
    ["at", "ABCDEF0", false],
    ["at", "abcdefg", false],
  ])("%s of %s characters is valid: %s", (attr, v, ok) => {
    const r = parseLineageLine(line(` ${attr}="${v}"`))!;
    expect(r.dropped).toEqual(ok ? [] : [{ attribute: attr, reason: "invalid" }]);
  });

  it("a line over 1,024 bytes is not a lineage line even when it matches", () => {
    const base = line(' role="x"');
    const pad = line(` role="x" zz="${"q".repeat(LINEAGE_MAX_LINE_BYTES - base.length - 6)}"`);
    expect(pad.length).toBe(LINEAGE_MAX_LINE_BYTES);
    expect(parseLineageLine(pad)).not.toBeNull();
    const over = line(` role="x" zz="${"q".repeat(LINEAGE_MAX_LINE_BYTES - base.length - 5)}"`);
    expect(over.length).toBe(LINEAGE_MAX_LINE_BYTES + 1);
    expect(parseLineageLine(over)).toBeNull();
  });

  it("serialises in canonical order", () => {
    const s = serializeLineage({ by: "w@x.y", at: "abc1234", role: "worker", absorbs: ["c.md", "d.md"], from: "b.md", continues: "a.md" });
    expect(s.line).toBe('<!-- storybloq-lineage v1 continues="a.md" from="b.md" absorbs="c.md" absorbs="d.md" role="worker" at="abc1234" by="w@x.y" -->');
    expect(s.dropped).toEqual([]);
    expect(parseLineageLine(s.line)!.lineage).toEqual(s.lineage);
    expect(serializeLineage({}).line).toBe("<!-- storybloq-lineage v1 -->");
  });

  it("serialising drops invalid values by name and refuses an invalid continues", () => {
    const s = serializeLineage({ role: "a<b", from: "../x.md", by: "ok", absorbs: ["x/y.md", "z.md", "z.md"] });
    expect(s.line).toBe('<!-- storybloq-lineage v1 absorbs="z.md" by="ok" -->');
    // The plan fixes no order for these diagnostics: compare as a set, with the exact count.
    expect(s.dropped).toHaveLength(3);
    expect(s.dropped).toEqual(expect.arrayContaining([
      { attribute: "from", reason: "invalid" },
      { attribute: "role", reason: "invalid" },
      { attribute: "absorbs", reason: "invalid" },
    ]));
    expect(() => serializeLineage({ continues: "a/b.md" })).toThrow();
  });

  it("the size rule drops absorbs last to first, then from, then by, then role", () => {
    const big = (c: string) => c.repeat(252) + ".md";
    const absorbs = ["a", "b", "c"].map(big);
    const input = { continues: big("p"), from: big("f"), absorbs, role: "r".repeat(64), at: "a".repeat(40), by: "b".repeat(128) };
    const s = serializeLineage(input);
    expect(Buffer.byteLength(s.line)).toBeLessThanOrEqual(LINEAGE_MAX_LINE_BYTES);
    // Every value at its maximum: all absorbs go, last first, and the rest fits.
    expect(s.dropped).toEqual([
      { attribute: "absorbs", reason: "size" },
      { attribute: "absorbs", reason: "size" },
      { attribute: "absorbs", reason: "size" },
    ]);
    expect(s.lineage).toEqual({ continues: { state: "valid", file: big("p") }, from: big("f"), absorbs: [], role: "r".repeat(64), at: "a".repeat(40), by: "b".repeat(128) });
    // The order past absorbs, at a smaller limit: absorbs (last to first), from, by, role.
    const small = { continues: "p.md", from: "f".repeat(40) + ".md", absorbs: ["a1.md", "a2.md"], role: "r".repeat(30), at: "abc1234", by: "b".repeat(30) };
    const full = serializeLineage(small).line.length;
    const steps: string[] = [];
    for (let limit = full; limit > 0; limit--) {
      let r;
      try { r = serializeLineage(small, limit); } catch { break; }
      const names = r.dropped.map((d) => d.attribute).join(",");
      if (steps[steps.length - 1] !== names) steps.push(names);
      expect(r.line.length).toBeLessThanOrEqual(limit);
    }
    expect(steps).toEqual(["", "absorbs", "absorbs,absorbs", "absorbs,absorbs,from", "absorbs,absorbs,from,by", "absorbs,absorbs,from,by,role"]);
    expect(serializeLineage(small, full - 1).lineage.absorbs).toEqual(["a1.md"]);
    // continues with at always fits at the real limit.
    expect(serializeLineage({ continues: big("p"), at: "a".repeat(40) }).dropped).toEqual([]);
  });

  it("the size rule keeps a line of exactly 1,024 bytes and trims one of 1,025 at the last absorbs", () => {
    const fixed = serializeLineage({ continues: "p.md" }).line.length;
    // Each absorbs adds ` absorbs="NAME"`: 11 bytes plus the name.
    const names: string[] = [];
    let room = LINEAGE_MAX_LINE_BYTES - fixed;
    while (room > 11 + 200 + 15) {
      names.push(`${names.length}`.padEnd(197, "x") + ".md");
      room -= 211;
    }
    names.push("z".repeat(room - 11 - 3) + ".md");
    const kept = serializeLineage({ continues: "p.md", absorbs: names });
    expect(kept.line.length).toBe(1024);
    expect(kept.dropped).toEqual([]);
    expect(parseLineageLine(kept.line)!.lineage.absorbs).toEqual(names);
    const over = [...names.slice(0, -1), "z" + names[names.length - 1]!];
    const trimmed = serializeLineage({ continues: "p.md", absorbs: over });
    expect(trimmed.dropped).toEqual([{ attribute: "absorbs", reason: "size" }]);
    expect(trimmed.lineage.absorbs).toEqual(names.slice(0, -1));
  });
});

// ---------------------------------------------------------------------------
// A2. Tail rule (string side)
// ---------------------------------------------------------------------------

describe("A2 tail rule on a string", () => {
  it.each(TAIL_SHAPES.map((s) => [s.name, s] as const))("%s", (_n, shape) => {
    const content = shape.bytes.toString("utf8");
    const r = readLineage(content);
    expect(r.kind).toBe(shape.linked ? "linked" : "unlinked");
    const split = splitLineage(content);
    expect(split.lineage !== null).toBe(shape.linked);
    if (shape.linked) {
      expect(split.lineage).toEqual(parseLineageLine(LINE));
      if (shape.body !== undefined) expect(split.body).toBe(shape.body);
    } else {
      expect(split.body).toBe(content);
    }
    expect(readLineage(split.body).kind).toBe("unlinked");
  });
});

// ---------------------------------------------------------------------------
// A3. Removing and adding the line
// ---------------------------------------------------------------------------

describe("A3 appendLineage and splitLineage", () => {
  const lastNonBlank = (s: string): string => s.split("\n").filter((l) => !/^[ \t\r]*$/.test(l)).pop() ?? "";

  it.each([
    ["# T\n", "# T\n"],
    ["# T", "# T\n"],
    ["# T\r\n", "# T\r\n"],
    ["a\n\n\n", "a\n"],
    ["a  \n", "a  \n"],
    ["a\t", "a\t\n"],
    ["a\n \n\t\n\r\n", "a\n"],
    ["# T\n\n## Shipped\n- T-001\n", "# T\n\n## Shipped\n- T-001\n"],
  ])("round trip of %j", (body, normalised) => {
    const final = appendLineage(body, LINE);
    expect(final).toBe(normalised.replace(/\n$/, "") + "\n\n" + LINE + "\n");
    const split = splitLineage(final);
    expect(split.body).toBe(normalised);
    expect(split.lineage).toEqual(parseLineageLine(LINE));
    expect(split.discarded).toEqual([]);
    expect(lastNonBlank(split.body)).toBe(lastNonBlank(body));
    expect(lastNonBlank(final.slice(0, final.length - LINE.length - 1))).toBe(lastNonBlank(body));
  });

  it("an unlinked content comes back as the same string", () => {
    const c = "# T\n\nbody  \n\n\n";
    expect(splitLineage(c).body).toBe(c);
    expect(splitLineage(c).lineage).toBeNull();
  });

  it("removes every stacked line; the effective lineage is the final one", () => {
    const first = '<!-- storybloq-lineage v1 continues="old.md" -->';
    const second = '<!-- storybloq-lineage v1 continues="../bad.md" -->';
    const s = splitLineage("# T\n\nbody\n\n" + first + "\n\n" + second + "\n");
    expect(s.body).toBe("# T\n\nbody\n");
    expect(s.lineage!.lineage.continues).toEqual({ state: "invalid" });
    expect(s.discarded).toEqual([parseLineageLine(first)]);
    const three = splitLineage(first + "\n" + LINE + "\n" + second + "\n");
    expect(three.body).toBe("");
    expect(three.discarded.length).toBe(2);
  });

  it("a stacked line hidden behind more than 2,048 bytes of blank lines is still removed", () => {
    const content = "# T\n" + LINE + "\n" + " \n".repeat(1100) + LINE + "\n";
    const s = splitLineage(content);
    expect(s.body).toBe("# T\n");
    expect(s.discarded.length).toBe(1);
    expect(readLineage(s.body).kind).toBe("unlinked");
  });
});

// ---------------------------------------------------------------------------
// A12. Parent, tips, forks, loops
// ---------------------------------------------------------------------------

function U(name: string): ScannedFile {
  return { name, state: "unlinked", nearMiss: false };
}
function X(name: string): ScannedFile {
  return { name, state: "unknown", reason: "not_regular" };
}
function L(name: string, attrs: string): ScannedFile {
  const parsed = parseLineageLine(line(attrs));
  if (!parsed) throw new Error(`bad test line ${attrs}`);
  return { name, state: "linked", lineage: parsed };
}
function scan(...files: ScannedFile[]): LineageScan {
  return { files, enumerated: true, complete: files.every((f) => f.state !== "unknown") };
}

describe("A12 lineage graph", () => {
  it("Parent of an unlinked handover is the next unlinked one in listing order, whatever the name shape", () => {
    // listHandovers order: same-day NN before timestamp names, undated last.
    const g = buildLineageGraph(scan(U("2026-11-13-02-b.md"), U("2026-11-13-01-a.md"), U("2026-11-13-120000-abcd1234-c.md"), U("2026-11-12-x.md"), U("notes.md")));
    expect(g.parent.get("2026-11-13-02-b.md")).toEqual({ kind: "file", file: "2026-11-13-01-a.md", certain: true });
    expect(g.parent.get("2026-11-13-01-a.md")).toEqual({ kind: "file", file: "2026-11-13-120000-abcd1234-c.md", certain: true });
    expect(g.parent.get("2026-11-12-x.md")).toEqual({ kind: "file", file: "notes.md", certain: true });
    expect(g.parent.get("notes.md")).toEqual({ kind: "root" });
    expect(g.defaultLine).toEqual(["2026-11-13-02-b.md", "2026-11-13-01-a.md", "2026-11-13-120000-abcd1234-c.md", "2026-11-12-x.md", "notes.md"]);
    expect(g.head).toBe("2026-11-13-02-b.md");
    expect(g.tips).toEqual(["2026-11-13-02-b.md"]);
  });

  it("the default chain passes over linked handovers, and an unknown file between makes the edge provisional", () => {
    const g = buildLineageGraph(scan(U("u1.md"), L("l1.md", ""), U("u2.md"), X("x.md"), U("u3.md")));
    expect(g.parent.get("u1.md")).toEqual({ kind: "file", file: "u2.md", certain: true });
    expect(g.parent.get("u2.md")).toEqual({ kind: "file", file: "u3.md", certain: false });
    expect(g.parent.get("l1.md")).toEqual({ kind: "root" });
    expect(g.parent.has("x.md")).toBe(false);
    expect(g.tips).toEqual(["u1.md", "l1.md"]);
    expect(g.certainChildren.get("u3.md")).toBeUndefined();
    expect(g.children.get("u3.md")).toEqual(["u2.md"]);
  });

  it("each broken reason", () => {
    const g = buildLineageGraph(scan(
      L("miss.md", ' continues="gone.md"'),
      L("unr.md", ' continues="x.md"'),
      L("self.md", ' continues="self.md"'),
      L("inv.md", ' continues="a/b.md"'),
      X("x.md"),
      L("ok.md", ' continues="u.md"'),
      U("u.md"),
    ));
    expect(g.parent.get("miss.md")).toEqual({ kind: "broken", reason: "missing", target: "gone.md" });
    expect(g.parent.get("unr.md")).toEqual({ kind: "broken", reason: "unreadable", target: "x.md" });
    expect(g.parent.get("self.md")).toEqual({ kind: "broken", reason: "self", target: "self.md" });
    expect(g.parent.get("inv.md")).toEqual({ kind: "broken", reason: "invalid", target: null });
    expect(g.parent.get("ok.md")).toEqual({ kind: "file", file: "u.md", certain: true });
    expect(g.loops).toEqual([]);
    expect(walkLine(g, "miss.md")).toEqual({ files: ["miss.md"], end: "broken", brokenTarget: "gone.md", brokenReason: "missing", provisional: false });
  });

  it("an unknown file is on no line: never a parent, child, tip or target", () => {
    const g = buildLineageGraph(scan(X("x.md"), L("a.md", ' absorbs="x.md"')));
    expect(g.tips).toEqual(["a.md"]);
    expect(g.absorbedBy.size).toBe(0);
    expect(g.children.has("x.md")).toBe(false);
    expect(g.defaultLine).toEqual([]);
    expect(g.head).toBeNull();
  });

  it("tips, open tips and forks", () => {
    const g = buildLineageGraph(scan(U("u1.md"), L("l1.md", ' continues="u2.md"'), U("u2.md"), L("l2.md", ' continues="u2.md"')));
    expect(g.tips).toEqual(["u1.md", "l1.md", "l2.md"]);
    expect(g.openTips).toEqual(["u1.md", "l1.md", "l2.md"]);
    expect(g.forks).toEqual([{ parent: "u2.md", children: ["u1.md", "l1.md", "l2.md"] }]);
  });

  it("a provisional edge never counts toward a fork", () => {
    const g = buildLineageGraph(scan(U("u1.md"), X("x.md"), U("u2.md"), L("l1.md", ' continues="u2.md"')));
    expect(g.children.get("u2.md")).toEqual(["u1.md", "l1.md"]);
    expect(g.forks).toEqual([]);
  });

  it("absorbs close a tip only when it names another handover's tip", () => {
    const g = buildLineageGraph(scan(
      L("m.md", ' absorbs="w.md" absorbs="p.md" absorbs="gone.md" absorbs="x.md" absorbs="m.md"'),
      L("w.md", ' continues="p.md"'),
      L("p.md", ""),
      X("x.md"),
    ));
    expect(g.tips).toEqual(["m.md", "w.md"]);
    expect(g.absorbedBy).toEqual(new Map([["w.md", ["m.md"]]]));
    expect(g.openTips).toEqual(["m.md"]);
  });

  it("a two-file loop no tip reaches is found", () => {
    const g = buildLineageGraph(scan(U("u.md"), L("a.md", ' continues="b.md"'), L("b.md", ' continues="a.md"')));
    expect(g.loops).toEqual([["a.md", "b.md"]]);
    expect(g.tips).toEqual(["u.md"]);
    const w = walkLine(g, "a.md");
    expect(w).toEqual({ files: ["a.md", "b.md"], end: "broken", brokenTarget: "a.md", brokenReason: "repeat", provisional: false });
  });

  it("a loop a tip leads into is found once, with or without that tip absorbed", () => {
    const files = [L("c.md", ' continues="a.md"'), L("b.md", ' continues="a.md"'), L("a.md", ' continues="b.md"')];
    const g = buildLineageGraph(scan(...files));
    expect(g.loops).toEqual([["b.md", "a.md"]]);
    expect(g.tips).toEqual(["c.md"]);
    expect(walkLine(g, "c.md")).toEqual({ files: ["c.md", "a.md", "b.md"], end: "broken", brokenTarget: "a.md", brokenReason: "repeat", provisional: false });
    const h = buildLineageGraph(scan(L("d.md", ' absorbs="c.md"'), ...files));
    expect(h.loops).toEqual([["b.md", "a.md"]]);
    expect(h.openTips).toEqual(["d.md"]);
    expect(h.absorbedBy.get("c.md")).toEqual(["d.md"]);
  });

  it("a self-reference is a broken link, not a loop", () => {
    const g = buildLineageGraph(scan(L("s.md", ' continues="s.md"')));
    expect(g.loops).toEqual([]);
    expect(g.tips).toEqual(["s.md"]);
    expect(walkLine(g, "s.md").brokenReason).toBe("self");
  });

  it("an acyclic chain of 1,200 linked files is one line and no loop", () => {
    const names = Array.from({ length: 1200 }, (_, i) => `h${String(1199 - i).padStart(4, "0")}.md`);
    const files = names.map((n, i) => (i === names.length - 1 ? L(n, "") : L(n, ` continues="${names[i + 1]}"`)));
    const g = buildLineageGraph(scan(...files));
    expect(g.loops).toEqual([]);
    expect(g.tips).toEqual([names[0]]);
    const w = walkLine(g, names[0]!);
    expect(w.files).toEqual(names);
    expect(w.end).toBe("root");
    expect(new Set(w.files).size).toBe(w.files.length);
  });

  it("an acyclic default chain of 1,200 unlinked files is one line", () => {
    const names = Array.from({ length: 1200 }, (_, i) => `u${String(1199 - i).padStart(4, "0")}.md`);
    const g = buildLineageGraph(scan(...names.map(U)));
    expect(g.loops).toEqual([]);
    expect(g.tips).toEqual([names[0]]);
    expect(walkLine(g, names[0]!).files.length).toBe(1200);
  });

  it("every walk returns each file at most once", () => {
    const g = buildLineageGraph(scan(L("t.md", ' continues="a.md"'), L("a.md", ' continues="b.md"'), L("b.md", ' continues="c.md"'), L("c.md", ' continues="a.md"')));
    for (const f of ["t.md", "a.md", "b.md", "c.md"]) {
      const w = walkLine(g, f);
      expect(new Set(w.files).size).toBe(w.files.length);
      expect(w.brokenReason).toBe("repeat");
    }
    expect(walkLine(g, "t.md").files).toEqual(["t.md", "a.md", "b.md", "c.md"]);
  });

  it("a walk over a provisional edge says so", () => {
    const g = buildLineageGraph(scan(U("u1.md"), X("x.md"), U("u2.md")));
    expect(walkLine(g, "u1.md")).toEqual({ files: ["u1.md", "u2.md"], end: "root", brokenTarget: null, brokenReason: null, provisional: true });
  });
});
