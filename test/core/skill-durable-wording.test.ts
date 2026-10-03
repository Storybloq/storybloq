/**
 * ISS-1107: "durable" means pushed. The skill files a session reads at work
 * time never call a written or locally committed board file durable; the one
 * permitted use is the SKILL.md glossary line that defines the word.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const skillDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "skill");
const FILES = ["SKILL.md", "autonomous-mode.md", "orchestrator-mode.md", "bus-mode.md", "duet-mode.md"];
const GLOSSARY = "Written: on disk in .story/, not yet committed. Committed: in a local commit. Pushed: on the remote; only this is durable.";
const STATUS_LINE = "Status and recap report local commit state, and on a non-default branch the difference from origin/<default>; they do not report push state.";

describe("skill durable wording (ISS-1107)", () => {
  it("P1: only the glossary line says durable, and the glossary is present", () => {
    const hits: string[] = [];
    for (const file of FILES) {
      readFileSync(join(skillDir, file), "utf-8").split("\n").forEach((line, i) => {
        if (/durable/i.test(line) && line !== GLOSSARY) hits.push(`${file}:${i + 1}: ${line.slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
    const skill = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
    expect(skill.split("\n")).toContain(GLOSSARY);
    expect(skill).toContain(STATUS_LINE);
    expect(skill).toContain("`Board not committed`");
  });
});
