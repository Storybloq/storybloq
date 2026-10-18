/**
 * T-538 S1: anchors for `src/skill/checkpoints.md`, the procedure for working
 * an owner checkpoint, and its routing from SKILL.md and autonomous-mode.md.
 * Anchors are local fixtures, not exports from `src/` (see
 * skill-ruling-anchors.test.ts). Each rule is pinned inside its own numbered
 * section, and every section is asserted to occur once and be non-empty, so
 * no anchor passes over an empty slice.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "skill");
const read = (name: string) => readFile(join(SKILL_DIR, name), "utf-8");

/** From `heading` to the next heading of equal or higher level. */
function section(doc: string, heading: string): string {
  const lines = doc.split("\n");
  const starts = lines.flatMap((l, i) => (l === heading ? [i] : []));
  expect(starts, `heading ${heading} occurs once`).toHaveLength(1);
  const level = heading.match(/^#+/)![0].length;
  const start = starts[0]!;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i]!.match(/^(#+) /);
    if (m && m[1]!.length <= level) { end = i; break; }
  }
  const body = lines.slice(start + 1, end).join("\n").trim();
  expect(body.length, `section ${heading} is non-empty`).toBeGreaterThan(0);
  return body;
}

const ANCHORS: readonly (readonly [string, readonly string[]])[] = [
  ["## 1. Prepare, then ask", ["checkpoint evidence", "docs/checkpoints/", "approve; change requested; not now", "verbatim", "checkpoint change"]],
  ["## 2. Approve", ["storybloq_checkpoint_resolve", "artifactRef", "one of the record's revisions", "owner-direct"]],
  ["## 3. Change requested", ["ticket get", "storybloq_checkpoint_reopen` first", "storybloq_ruling_create", "citesRuling", "never depends on the checkpoint", "--add-blocked-by", "only a pending checkpoint", "storybloq_checkpoint_change"]],
  ["## 4. Not now", ["Nothing is written"]],
  ["## 5. Never invent an answer", ["owner message", "not the owner's answer"]],
  ["## 6. First-version acceptance evidence", ["demonstrated behaviour", "unverified claims", "limitations"]],
  ["## 7. Reopen", ["checkpoint_reassess", "do not rewrite it"]],
];

describe("checkpoints.md (T-538 S1)", () => {
  it("names the ready state and the tokens up front", async () => {
    const doc = await read("checkpoints.md");
    expect(doc).toContain("[checkpoint pending, ready]");
    expect(doc).toContain("generation, revision, digest");
  });

  it.each(ANCHORS)("%s carries its rule", async (heading, anchors) => {
    expect(anchors.length).toBeGreaterThan(0);
    const body = section(await read("checkpoints.md"), heading);
    for (const a of anchors) expect(body, `${heading} names ${a}`).toContain(a);
  });

  it("SKILL.md routes to it in one Support Files line, and autonomous mode names it for a checkpoint-blocked target", async () => {
    const skill = await read("SKILL.md");
    expect(skill.split("\n").filter((l) => l.includes("checkpoints.md"))).toEqual([
      "- **`checkpoints.md`** -- Owner checkpoints: read it for a ready checkpoint or the owner's answer to one",
    ]);
    const auto = await read("autonomous-mode.md");
    const line = auto.split("\n").find((l) => l.includes("checkpoints.md"));
    expect(line).toContain("checkpoint-blocked");
    expect(line).toContain("never answer it yourself");
  });
});
