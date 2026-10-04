/**
 * T-486 E3 (R3-4): evidence merged by an old driver against an old writer's
 * disposition change. A legacy issue carries `disposition:
 * accepted_out_of_scope` and no evidence. X (the current handler) adds a
 * reason and ref for it; Y (the pre-capability CLI) changes the disposition to
 * owner_gated. The old driver merges them with no conflict, and the binding
 * is what keeps that safe: the evidence view is unbound, md shows no reason,
 * and validate names both values. Under v5 the same three-way is a coupled
 * conflict. Dists come from the prefix `npm run compat:fetch` installs.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initProject } from "../../src/core/init.js";
import { loadProject } from "../../src/core/project-loader.js";
import { validateProject } from "../../src/core/validation.js";
import { threeWayMerge } from "../../src/core/merge-driver.js";
import { dispositionEvidenceView } from "../../src/core/resolution-kind.js";
import { handleIssueCreate, handleIssueGet, handleIssueUpdate } from "../../src/cli/commands/issue.js";
import { PRE_CAPABILITY, requireOldDists } from "./old-dists.js";

const { dists, skip } = requireOldDists([PRE_CAPABILITY]);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "t486-e3-"));
  dirs.push(d);
  return d;
}

function run(bin: string, cwd: string, home: string, ...args: string[]) {
  return spawnSync(bin, args, {
    cwd,
    encoding: "utf-8",
    timeout: 60_000,
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, GIT_CONFIG_GLOBAL: join(home, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" },
  });
}

const json = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;

describe.skipIf(skip !== null)(`E3: evidence against an old writer's disposition change${skip ? ` (${skip})` : ""}`, () => {
  it(`${PRE_CAPABILITY}'s driver merges clean, and the evidence it carries over is unbound, hidden and named by validate`, async () => {
    const old = dists[0]!;
    const work = temp();
    const home = join(work, "home");
    mkdirSync(home);
    const base = join(work, "base");
    mkdirSync(base);
    await initProject(base, { name: "t486" });
    const create = async (title: string) =>
      (JSON.parse((await handleIssueCreate({ title, severity: "medium", impact: "x", components: [], relatedTickets: [], location: [] }, "json", base)).output) as { data: { id: string } }).data.id;
    const id = await create("parked out of scope");
    const ref = await create("the scope decision");
    const rel = join(".story", "issues", `${id}.json`);
    writeFileSync(join(base, rel), JSON.stringify({ ...json(join(base, rel)), disposition: "accepted_out_of_scope" }, null, 2) + "\n");

    const x = join(work, "x");
    const y = join(work, "y");
    cpSync(base, x, { recursive: true });
    cpSync(base, y, { recursive: true });
    await handleIssueUpdate(id, { disposition: "accepted_out_of_scope", dispositionReason: "scope call", dispositionRef: ref }, "json", x);
    const meta = run(old.bin, y, home, "issue", "meta", "set", id, "disposition", '"owner_gated"');
    expect(meta.status, meta.stdout + meta.stderr).toBe(0);
    expect(json(join(y, rel))).toMatchObject({ disposition: "owner_gated" });

    const o = join(work, "O.json");
    const a = join(work, "A.json");
    const b = join(work, "B.json");
    cpSync(join(base, rel), o);
    cpSync(join(x, rel), a);
    cpSync(join(y, rel), b);
    const ours = json(a);
    const merge = run(old.bin, x, home, "merge-driver", o, a, b, rel);
    expect(merge.status, merge.stdout + merge.stderr).toBe(0);
    const merged = json(a);
    expect(merged).toMatchObject({ disposition: "owner_gated", dispositionReason: "scope call", dispositionRef: ref, dispositionFor: "accepted_out_of_scope" });
    expect(dispositionEvidenceView(merged).state).toBe("unbound");

    cpSync(a, join(x, rel));
    const { state, warnings } = await loadProject(x);
    const md = handleIssueGet(id, { state, warnings, root: x, handoversDir: join(x, ".story", "handovers"), format: "md" }).output;
    expect(md).toMatch(/^Disposition: owner_gated$/m);
    expect(md).not.toContain("scope call");
    const unbound = validateProject(state).findings.filter((f) => f.entity === id && f.code === "disposition_evidence_unbound");
    expect(unbound).toHaveLength(1);
    expect(unbound[0]!.message).toContain("written for accepted_out_of_scope");
    expect(unbound[0]!.message).toContain("the disposition is now owner_gated");

    // The same three-way under v5: the disposition group couples the sides.
    const v5 = threeWayMerge(json(o), ours, json(b), "issue");
    expect(v5.clean).toBe(false);
    expect(v5.conflicts.some((c) => c.group === "issue-disposition")).toBe(true);
  });
});
