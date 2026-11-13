/**
 * ISS-1499 slice A: `handover create` with lineage (plan section 5).
 *
 * A4 (C2 for create): with no lineage line and no lineage flag, the bytes on
 * disk and the reply, in md and json, sequenced and team-mode filenames, on
 * the CLI and through the registered MCP tool, equal goldens captured from
 * main before any lineage code existed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject } from "../../../src/core/init.js";
import { isolateEnv, runCli, callMcp, type IsolatedEnv } from "../../fixtures/handover-lineage/harness.js";
import { LINE, TAIL_SHAPES } from "../../fixtures/handover-lineage/shapes.js";
import { appendLineage, readLineage } from "../../../src/core/handover-lineage.js";
import { handleHandoverCreate, lineageIsInvisible } from "../../../src/cli/commands/handover.js";
import { extractHandoverHeading } from "../../../src/federation/handover-utils.js";
import { parseHandoverMarkdown } from "../../../src/core/markdown-sections.js";
import { hasCarriedForwardHeading, parseCarriedForwardSection } from "../../../src/core/handover-template.js";

const here = resolve(fileURLToPath(import.meta.url), "..");
const GOLDENS = join(here, "../../fixtures/handover-lineage/create-goldens.json");
const UPDATE = process.env.STORYBLOQ_UPDATE_LINEAGE_GOLDENS === "1";

let env: IsolatedEnv;
beforeEach(() => { env = isolateEnv(); });
afterEach(() => {
  env.restore();
  rmSync(env.base, { recursive: true, force: true });
});

async function project(team: boolean): Promise<string> {
  const root = realpathSync(mkdtempSync(join(env.base, "proj-")));
  await initProject(root, { name: "lineage" });
  if (team) {
    const cfgPath = join(root, ".story", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    cfg.team = { enabled: true };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  }
  writeFileSync(join(root, ".story", "handovers", "2026-01-01-01-old.md"), "# Old\n\nolder work\n");
  return root;
}

/** Replaces the project root and the exact filename that was written, nothing broader. */
function normalise(text: string, root: string, file: string): string {
  return text.split(root).join("<ROOT>").split(file).join("<FILE>");
}

const localDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const utcDate = (d: Date): string => d.toISOString().slice(0, 10);

/** The written filename has main's format for the mode and today's date (local for sequenced, UTC for team). */
function expectFilename(file: string, team: boolean, before: Date, after: Date): void {
  const m = team
    ? /^(\d{4}-\d{2}-\d{2})-\d{6}-[0-9a-f]{8}-golden\.md$/.exec(file)
    : /^(\d{4}-\d{2}-\d{2})-01-golden\.md$/.exec(file);
  expect(m, `filename format: ${file}`).not.toBeNull();
  const day = team ? utcDate : localDate;
  expect([day(before), day(after)]).toContain(m![1]);
}

/** Contents with no lineage line: each must be written and answered exactly as main does. */
const UNLINKED_CONTENTS: Record<string, string> = {
  plain: "# Session\nDone.",
  trailingWhitespace: "# T\n\nbody  \n\n\n  \n",
  crlf: "# T\r\n\r\n- a\r\n",
  nearMissV1: "# T\n\nbody\n\n<!-- storybloq-lineage v1 continues=a.md -->\n",
  v2Line: '# T\n\n<!-- storybloq-lineage v2 continues="a.md" -->\n',
  v10Line: "# T\n\n<!-- storybloq-lineage v10 -->\n",
  lineNotFinal: "# T\n\n" + LINE + "\nmore text\n",
  unicode: "# Café ✓\n\nnaïve notes\n",
};

type Surface = "cli-md" | "cli-json" | "mcp";
interface Golden { file: string; bytes: string; reply: string; exitCode: number | null; isError: boolean }

async function createVia(surface: Surface, root: string, content: string, team: boolean): Promise<Golden> {
  const dir = join(root, ".story", "handovers");
  const before = new Set(readdirSync(dir));
  const startedAt = new Date();
  let reply: string;
  let exitCode: number | null = null;
  let isError = false;
  if (surface === "mcp") {
    const r = await callMcp(root, "storybloq_handover_create", { content, slug: "golden" });
    reply = r.text;
    isError = r.isError;
  } else {
    const r = await runCli(root, ["handover", "create", "--content", content, "--slug", "golden", "--format", surface === "cli-json" ? "json" : "md"]);
    reply = r.stdout;
    exitCode = r.exitCode ?? 0;
  }
  const added = readdirSync(dir).filter((f) => !before.has(f));
  expect(added.length).toBe(1);
  const file = added[0]!;
  expectFilename(file, team, startedAt, new Date());
  return {
    file: normalise(file, root, file),
    bytes: readFileSync(join(dir, file)).toString("base64"),
    reply: normalise(reply, root, file),
    exitCode,
    isError,
  };
}

describe("A4 unlinked identity: no lineage input writes and answers exactly as main", () => {
  const goldens: Record<string, Golden> = !UPDATE && existsSync(GOLDENS) ? JSON.parse(readFileSync(GOLDENS, "utf8")) as Record<string, Golden> : {};

  for (const team of [false, true]) {
    for (const surface of ["cli-md", "cli-json", "mcp"] as const) {
      for (const [name, content] of Object.entries(UNLINKED_CONTENTS)) {
        const key = `${team ? "team" : "sequenced"}/${surface}/${name}`;
        it(key, async () => {
          const root = await project(team);
          const got = await createVia(surface, root, content, team);
          // The bytes on disk are the content exactly as received.
          expect(Buffer.from(got.bytes, "base64").toString("utf8")).toBe(content);
          if (UPDATE) {
            const all = existsSync(GOLDENS) ? JSON.parse(readFileSync(GOLDENS, "utf8")) as Record<string, Golden> : {};
            all[key] = got;
            writeFileSync(GOLDENS, JSON.stringify(Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b))), null, 2) + "\n");
            return;
          }
          expect(goldens[key], `no golden for ${key}`).toBeDefined();
          expect(got).toEqual(goldens[key]);
        });
      }
    }
  }
});

// ---------------------------------------------------------------------------
// A5 to A11, A13b: linked writes (plan section 5)
// ---------------------------------------------------------------------------

const OLD = "2026-01-01-01-old.md";
const lineOf = (attrs: string): string => `<!-- storybloq-lineage v1${attrs ? " " + attrs : ""} -->`;

interface Warning { code: string; target: string | null; detail: string | null }
interface LineageJson {
  linked: boolean;
  continues: string | null;
  from: string | null;
  absorbs: string[];
  role: string | null;
  at: string | null;
  by: string | null;
  forkChildren: string[];
  warnings: Warning[];
}
interface Created { file: string; bytes: string; stdout: string; exitCode: number; lineage: LineageJson | undefined }

const hdir = (root: string): string => join(root, ".story", "handovers");

function newFile(root: string, before: Set<string>): string {
  const added = readdirSync(hdir(root)).filter((f) => !before.has(f));
  expect(added.length).toBe(1);
  return added[0]!;
}

/** `handover create` on the CLI, json unless `md` is set. */
async function create(root: string, content: string, flags: readonly string[] = [], md = false): Promise<Created> {
  const before = new Set(readdirSync(hdir(root)));
  const r = await runCli(root, ["handover", "create", "--content", content, "--slug", "lin", "--format", md ? "md" : "json", ...flags]);
  const file = newFile(root, before);
  const lineage = md ? undefined : (JSON.parse(r.stdout) as { data: { lineage?: LineageJson } }).data.lineage;
  return { file, bytes: readFileSync(join(hdir(root), file), "utf8"), stdout: r.stdout, exitCode: r.exitCode ?? 0, lineage };
}

/** `storybloq_handover_create` through the registered MCP tool. */
async function createMcp(root: string, content: string): Promise<{ file: string; bytes: string; text: string; isError: boolean }> {
  const before = new Set(readdirSync(hdir(root)));
  const r = await callMcp(root, "storybloq_handover_create", { content, slug: "lin" });
  const file = newFile(root, before);
  return { file, bytes: readFileSync(join(hdir(root), file), "utf8"), text: r.text, isError: r.isError };
}

const seed = (root: string, name: string, body: string): void => writeFileSync(join(hdir(root), name), body);
const codes = (l: LineageJson | undefined): string[] => (l?.warnings ?? []).map((w) => w.code);
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
};

const UNLINKED_RESULT = { linked: false, continues: null, from: null, absorbs: [], role: null, at: null, by: null, forkChildren: [] };

describe("A5 linked write from flags", () => {
  let savedCeiling: string | undefined;
  beforeEach(() => {
    savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = env.base;
  });
  afterEach(() => {
    if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
  });

  it("outside any repository with no email: the bytes are appendLineage(content, line), no at, no by", async () => {
    const root = await project(false);
    const content = "# Session\n\nDid things.  \n\n\n";
    const r = await create(root, content, ["--continues", OLD]);
    expect(r.exitCode).toBe(0);
    expect(r.bytes).toBe(appendLineage(content, lineOf(`continues="${OLD}"`)));
    expect(r.lineage).toEqual({ linked: true, continues: OLD, from: null, absorbs: [], role: null, at: null, by: null, forkChildren: [], warnings: [] });
  });

  it("in a repository with a commit and a local user.email: at is the short HEAD and by the local email", async () => {
    const root = await project(false);
    git(root, "init", "-q");
    git(root, "config", "user.email", "local@x.y");
    git(root, "config", "user.name", "Local");
    git(root, "commit", "-q", "--allow-empty", "-m", "init");
    const at = git(root, "rev-parse", "--short", "HEAD");
    const r = await create(root, "# S\n\nbody\n", ["--new-line", "--role", "pen"]);
    expect(r.bytes).toBe(appendLineage("# S\n\nbody\n", lineOf(`role="pen" at="${at}" by="local@x.y"`)));
    expect(r.lineage).toMatchObject({ linked: true, continues: null, role: "pen", at, by: "local@x.y" });
  });

  it("in a repository with no commit: by is present and at is absent", async () => {
    const root = await project(false);
    git(root, "init", "-q");
    git(root, "config", "user.email", "local@x.y");
    const r = await create(root, "# S\n\nbody\n", ["--continues", OLD]);
    expect(r.bytes).toBe(appendLineage("# S\n\nbody\n", lineOf(`continues="${OLD}" by="local@x.y"`)));
    expect(r.lineage).toMatchObject({ at: null, by: "local@x.y" });
  });

  it("outside any repository with a global user.email: by is the global email, at is absent", async () => {
    writeFileSync(env.gitGlobal, "[user]\n\temail = global@x.y\n");
    const root = await project(false);
    const r = await create(root, "# S\n\nbody\n", ["--continues", OLD]);
    expect(r.bytes).toBe(appendLineage("# S\n\nbody\n", lineOf(`continues="${OLD}" by="global@x.y"`)));
    expect(r.lineage).toMatchObject({ at: null, by: "global@x.y" });
  });

  it("an email that breaks the value rule is omitted and never echoed", async () => {
    writeFileSync(env.gitGlobal, "[user]\n\temail = bad<mail>@x.y\n");
    const root = await project(false);
    const r = await create(root, "# S\n\nbody\n", ["--continues", OLD]);
    expect(r.bytes).toBe(appendLineage("# S\n\nbody\n", lineOf(`continues="${OLD}"`)));
    expect(r.lineage).toMatchObject({ linked: true, by: null });
    expect(r.stdout).not.toContain("bad<mail>");
  });

  it("the markdown reply adds one lineage block after the existing text", async () => {
    const root = await project(false);
    const r = await create(root, "# S\n\nbody\n", ["--continues", OLD, "--role", "pen"], true);
    expect(r.stdout).toMatch(/^Created handover: \S+\.md\n/);
    expect(r.stdout).toContain(`Lineage: continues ${OLD} (role pen)`);
  });
});

describe("A6 linked write from a content line", () => {
  const body = "# T\n\nbody\n";
  const contentLine = lineOf(`role="r" continues="${OLD}" at="deadbee" by="z@z.z"`);
  const canonical = lineOf(`continues="${OLD}" role="r"`);

  it("CLI: the line is re-serialised canonically and at and by are recomputed", async () => {
    const root = await project(false);
    const r = await create(root, body + "\n" + contentLine + "\n");
    expect(r.bytes).toBe(appendLineage(body, canonical));
    expect(r.lineage).toMatchObject({ linked: true, continues: OLD, role: "r", at: null, by: null });
  });

  it("registered MCP tool: the same bytes", async () => {
    const root = await project(false);
    const r = await createMcp(root, body + "\n" + contentLine + "\n");
    expect(r.isError).toBe(false);
    expect(r.bytes).toBe(appendLineage(body, canonical));
    expect(r.text).toContain(`Lineage: continues ${OLD} (role r)`);
  });

  it("handleHandoverCreate with surface mcp: the same bytes", async () => {
    const root = await project(false);
    const before = new Set(readdirSync(hdir(root)));
    await handleHandoverCreate(body + "\n" + contentLine + "\n", "lin", "md", root, { surface: "mcp", stamp: false });
    expect(readFileSync(join(hdir(root), newFile(root, before)), "utf8")).toBe(appendLineage(body, canonical));
  });

  it("a selector flag overrides the content line and the line is discarded", async () => {
    const root = await project(false);
    const r = await create(root, body + "\n" + contentLine + "\n", ["--new-line"]);
    expect(r.bytes).toBe(appendLineage(body, lineOf("")));
    expect(r.lineage).toMatchObject({ linked: true, continues: null, role: null });
    expect(codes(r.lineage)).toEqual(["content_line_discarded"]);
  });

  const invalidContents: Record<string, string> = {
    "an invalid continues": body + "\n" + lineOf('continues="a/b.md"') + "\n",
    "an invalid first continues and a valid second one": body + "\n" + lineOf(`continues="a/b.md" continues="${OLD}"`) + "\n",
  };
  for (const [name, content] of Object.entries(invalidContents)) {
    it(`${name} in a content line on the CLI: the body is written unlinked`, async () => {
      const root = await project(false);
      const r = await create(root, content);
      expect(r.bytes).toBe(body);
      expect(r.lineage).toEqual({ ...UNLINKED_RESULT, warnings: [{ code: "continues_invalid", target: null, detail: null }] });
      expect(r.stdout).not.toContain("a/b.md");
    });
    it(`${name} in a content line through the MCP tool: the body is written unlinked`, async () => {
      const root = await project(false);
      const r = await createMcp(root, content);
      expect(r.bytes).toBe(body);
      expect(r.text).not.toContain("a/b.md");
      expect(r.text).toContain("Written unlinked");
    });
  }

  it("an invalid --continues writes the content exactly as received", async () => {
    const root = await project(false);
    const content = "# T\n\nbody  \n\n";
    const r = await create(root, content, ["--continues", "../x.md"]);
    expect(r.bytes).toBe(content);
    expect(r.lineage).toEqual({ ...UNLINKED_RESULT, warnings: [{ code: "continues_invalid", target: null, detail: null }] });
    expect(r.stdout).not.toContain("../x.md");
  });

  const stacked = body + "\n" + lineOf(`continues="${OLD}"`) + "\n" + lineOf('continues="x/y.md"') + "\n";
  it("stacked lines, the final one invalid, on the CLI: neither line is written and the file reads unlinked", async () => {
    const root = await project(false);
    const r = await create(root, stacked);
    expect(r.bytes).toBe(body);
    expect(readLineage(r.bytes).kind).toBe("unlinked");
    expect(r.lineage?.linked).toBe(false);
  });
  it("stacked lines, the final one invalid, through the MCP tool: neither line is written", async () => {
    const root = await project(false);
    const r = await createMcp(root, stacked);
    expect(r.bytes).toBe(body);
    expect(readLineage(r.bytes).kind).toBe("unlinked");
  });
  it("a selector flag over two stacked lines discards both", async () => {
    const root = await project(false);
    const r = await create(root, stacked, ["--continues", OLD]);
    expect(r.bytes).toBe(appendLineage(body, lineOf(`continues="${OLD}"`)));
    expect(codes(r.lineage)).toEqual(["content_line_discarded", "content_line_discarded"]);
  });
  it("a selector flag with an invalid target over two stacked lines writes the body with neither line", async () => {
    const root = await project(false);
    const r = await create(root, stacked, ["--continues", "a\\b.md"]);
    expect(r.bytes).toBe(body);
    expect(codes(r.lineage).sort()).toEqual(["content_line_discarded", "content_line_discarded", "continues_invalid"]);
  });

  it("every attribute_dropped reason is produced through create, and no failed value is echoed", async () => {
    const root = await project(false);
    const details = new Set<string>();
    const take = (r: Created): void => {
      for (const w of r.lineage!.warnings) if (w.code === "attribute_dropped") details.add(w.detail!);
    };
    const role = await create(root, body, ["--new-line", "--role", 'bad"role']);
    expect(role.stdout).not.toContain('bad\\"role');
    expect(role.stdout).not.toContain("bad");
    take(role);
    const from = await create(root, body, ["--new-line", "--from", "../evil.md"]);
    expect(from.stdout).not.toContain("evil");
    take(from);
    take(await create(root, body + "\n" + lineOf(`continues="${OLD}" x="1"`) + "\n"));
    take(await create(root, body + "\n" + lineOf(`continues="${OLD}" role="a" role="b"`) + "\n"));
    const nine = Array.from({ length: 9 }, (_, i) => `absorbs="a${i}.md"`).join(" ");
    take(await create(root, body + "\n" + lineOf(`continues="${OLD}" ${nine}`) + "\n"));
    expect([...details].sort()).toEqual(["absorbs:count_limit", "from:invalid", "role:duplicate", "role:invalid", "x:unknown"]);
  });
});

describe("A7 write-time check", () => {
  const rejected: Record<string, { content: string; flags: string[]; written: string }> = {
    "content that is only a lineage line": { content: lineOf(`continues="${OLD}"`) + "\n", flags: [], written: "" },
    "a body that is only a title": { content: "# Title\n", flags: ["--continues", OLD], written: "# Title\n" },
    "a body ending in a bare federation heading": { content: "## Shipped\n- T-001\n# ", flags: ["--continues", OLD], written: "## Shipped\n- T-001\n# " },
  };
  for (const [name, row] of Object.entries(rejected)) {
    it(`rejects ${name}: the unlinked fallback bytes and parser_check_failed`, async () => {
      const root = await project(false);
      const r = await create(root, row.content, row.flags);
      expect(r.bytes).toBe(row.written);
      expect(r.lineage).toEqual({ ...UNLINKED_RESULT, warnings: [{ code: "parser_check_failed", target: null, detail: null }] });
    });
  }

  it("rejects the federation heading case only because of the federation heading", () => {
    const b = "## Shipped\n- T-001\n# ";
    const f = appendLineage(b, lineOf(`continues="${OLD}"`));
    expect(parseHandoverMarkdown(f, "h.md")).toEqual(parseHandoverMarkdown(b, "h.md"));
    expect(parseCarriedForwardSection(f)).toEqual(parseCarriedForwardSection(b));
    expect(hasCarriedForwardHeading(f)).toBe(hasCarriedForwardHeading(b));
    expect(extractHandoverHeading(f)).not.toEqual(extractHandoverHeading(b));
  });

  const fixtureRoot = join(here, "../../fixtures");
  const fixtures = listFixtureHandovers(fixtureRoot);
  it("finds the handover fixtures", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(30);
  });

  for (const rel of fixtures) {
    it(`accepts the fixture ${rel}: written linked`, async () => {
      const root = await project(false);
      const content = readFileSync(join(fixtureRoot, rel), "utf8");
      const r = await create(root, content, ["--continues", OLD]);
      expect(r.lineage?.linked).toBe(true);
      expect(r.bytes).toBe(appendLineage(content, lineOf(`continues="${OLD}"`)));
    });
  }

  for (const shape of TAIL_SHAPES.filter((s) => s.linked && s.body !== undefined && s.body !== "")) {
    it(`accepts the A2 shape "${shape.name}": written linked`, async () => {
      const root = await project(false);
      const r = await create(root, shape.bytes.toString("utf8"));
      expect(r.lineage?.linked).toBe(true);
      expect(r.bytes).toBe(appendLineage(shape.body!, lineOf('continues="2026-11-13-01-a.md" role="manager"')));
    });
  }

  it("lineageIsInvisible agrees with the four readers on every fixture and shape", () => {
    const line = lineOf(`continues="${OLD}"`);
    const bodies = [
      ...fixtures.map((rel) => readFileSync(join(fixtureRoot, rel), "utf8")),
      ...TAIL_SHAPES.filter((s) => s.body !== undefined).map((s) => s.body!),
      ...Object.values(rejected).map((r) => r.content.startsWith("<!--") ? "" : r.content),
    ];
    let rejectedCount = 0;
    for (const b of bodies) {
      const f = appendLineage(b, line);
      const expected =
        JSON.stringify(parseHandoverMarkdown(b, "h.md")) === JSON.stringify(parseHandoverMarkdown(f, "h.md")) &&
        JSON.stringify(parseCarriedForwardSection(b)) === JSON.stringify(parseCarriedForwardSection(f)) &&
        hasCarriedForwardHeading(b) === hasCarriedForwardHeading(f) &&
        extractHandoverHeading(b) === extractHandoverHeading(f);
      if (!expected) rejectedCount++;
      expect(lineageIsInvisible(b, f, "h.md")).toBe(expected);
    }
    expect(rejectedCount).toBeGreaterThanOrEqual(3);
  });
});

describe("the federation heading extractor keeps findLatestHandover's behaviour", () => {
  it("first ATX h1 or deeper with a space, trimmed, clipped to 117 plus an ellipsis over 120", () => {
    expect(extractHandoverHeading("intro\n#  Title here  \n# second")).toBe("Title here");
    expect(extractHandoverHeading("no heading")).toBeNull();
    expect(extractHandoverHeading("#NoSpace\n")).toBeNull();
    expect(extractHandoverHeading("# " + "a".repeat(120))).toBe("a".repeat(120));
    expect(extractHandoverHeading("# " + "a".repeat(121))).toBe("a".repeat(117) + "...");
  });
});

describe("A8 never refuses", () => {
  const rows: { name: string; flags: string[]; linked: boolean; codes: string[] }[] = [
    { name: "a traversal target", flags: ["--continues", "../x.md"], linked: false, codes: ["continues_invalid"] },
    { name: "a target with a slash", flags: ["--continues", "a/b.md"], linked: false, codes: ["continues_invalid"] },
    { name: "a quote in the target", flags: ["--continues", 'a"b.md'], linked: false, codes: ["continues_invalid"] },
    { name: "an angle bracket in the target", flags: ["--continues", "a<b.md"], linked: false, codes: ["continues_invalid"] },
    { name: "a target not ending in .md", flags: ["--continues", "a.txt"], linked: false, codes: ["continues_invalid"] },
    { name: "a missing target", flags: ["--continues", "2026-02-02-01-gone.md"], linked: true, codes: ["parent_not_in_checkout"] },
    { name: "both selectors", flags: ["--continues", OLD, "--new-line"], linked: true, codes: ["new_line_ignored"] },
    { name: "modifiers with no parent source", flags: ["--role", "r", "--from", OLD, "--absorbs", OLD], linked: false, codes: ["modifier_ignored", "modifier_ignored", "modifier_ignored"] },
    { name: "--from with --continues", flags: ["--from", OLD, "--continues", OLD], linked: true, codes: ["from_dropped"] },
  ];
  for (const row of rows) {
    it(row.name, async () => {
      const root = await project(false);
      const content = "# T\n\nbody\n";
      const r = await create(root, content, row.flags);
      expect(r.exitCode).toBe(0);
      expect(r.lineage?.linked).toBe(row.linked);
      expect(codes(r.lineage)).toEqual(row.codes);
      if (!row.linked) expect(r.bytes).toBe(content);
    });
  }

  it("both selectors: --continues wins", async () => {
    const root = await project(false);
    const r = await create(root, "# T\n\nbody\n", ["--new-line", "--continues", OLD]);
    expect(r.lineage).toMatchObject({ linked: true, continues: OLD });
    expect(r.bytes).toBe(appendLineage("# T\n\nbody\n", lineOf(`continues="${OLD}"`)));
  });

  it("modifiers with no parent source are named in the markdown reply too", async () => {
    const root = await project(false);
    const r = await create(root, "# T\n\nbody\n", ["--role", "r"], true);
    expect(r.stdout).toContain("--role");
  });

  it("an oversized composed line drops absorbs from the last, still links, and names each", async () => {
    const root = await project(false);
    const tips = Array.from({ length: 8 }, (_, i) => `2026-01-0${i + 2}-01-${String(i).repeat(140)}.md`);
    for (const t of tips) seed(root, t, "# Tip\n\nwork\n\n" + lineOf("") + "\n");
    const r = await create(root, "# T\n\nbody\n", ["--new-line", ...tips.flatMap((t) => ["--absorbs", t])]);
    expect(r.exitCode).toBe(0);
    expect(r.lineage?.linked).toBe(true);
    const sized = r.lineage!.warnings.filter((w) => w.code === "attribute_dropped" && w.detail === "absorbs:size");
    expect(sized.length).toBeGreaterThan(0);
    expect(r.lineage!.absorbs).toEqual(tips.slice(0, 8 - sized.length));
    expect(Buffer.byteLength(r.bytes.trimEnd().split("\n").pop()!, "latin1")).toBeLessThanOrEqual(1024);
  });
});

describe("A9 fork report at write", () => {
  it("the second child of one parent names the first", async () => {
    const root = await project(false);
    const first = await create(root, "# A\n\nx\n", ["--continues", OLD]);
    const second = await create(root, "# B\n\nx\n", ["--continues", OLD]);
    expect(first.lineage?.forkChildren).toEqual([]);
    expect(second.lineage?.forkChildren).toEqual([first.file]);
    expect(second.lineage?.linked).toBe(true);
  });

  it("continuing a non-head unlinked handover names its unlinked child; continuing the head reports none", async () => {
    const root = await project(false);
    seed(root, "2026-01-02-01-newer.md", "# Newer\n\nwork\n");
    const nonHead = await create(root, "# A\n\nx\n", ["--continues", OLD]);
    expect(nonHead.lineage?.forkChildren).toEqual(["2026-01-02-01-newer.md"]);
    const head = await create(root, "# B\n\nx\n", ["--continues", "2026-01-02-01-newer.md"]);
    expect(head.lineage?.forkChildren).toEqual([]);
  });

  it("the markdown reply names the fork", async () => {
    const root = await project(false);
    seed(root, "2026-01-02-01-newer.md", "# Newer\n\nwork\n");
    const r = await create(root, "# A\n\nx\n", ["--continues", OLD], true);
    expect(r.stdout).toContain("2026-01-02-01-newer.md");
  });
});

describe("A10 absorbs", () => {
  const TIP = "2026-01-03-01-tip.md";
  async function withTip(): Promise<string> {
    const root = await project(false);
    seed(root, TIP, "# Tip\n\nwork\n\n" + lineOf("") + "\n");
    return root;
  }

  it("kept for an open tip", async () => {
    const root = await withTip();
    const r = await create(root, "# A\n\nx\n", ["--continues", OLD, "--absorbs", TIP]);
    expect(r.lineage).toMatchObject({ linked: true, absorbs: [TIP], warnings: [] });
    expect(r.bytes).toBe(appendLineage("# A\n\nx\n", lineOf(`continues="${OLD}" absorbs="${TIP}"`)));
  });

  it("dropped and named for a non-tip, a missing file, the parent and an invalid value", async () => {
    const root = await withTip();
    seed(root, "2026-01-02-01-newer.md", "# Newer\n\nwork\n");
    // OLD has the unlinked child `newer`, so it is not a tip.
    const r = await create(root, "# A\n\nx\n", [
      "--continues", TIP,
      "--absorbs", OLD,
      "--absorbs", "2026-02-02-01-gone.md",
      "--absorbs", TIP,
      "--absorbs", "../evil.md",
    ]);
    expect(r.lineage?.linked).toBe(true);
    expect(r.lineage?.absorbs).toEqual([]);
    expect(r.lineage?.warnings).toEqual([
      { code: "absorb_dropped", target: OLD, detail: "not_a_tip" },
      { code: "absorb_dropped", target: "2026-02-02-01-gone.md", detail: "not_found" },
      { code: "absorb_dropped", target: TIP, detail: "is_parent" },
      { code: "absorb_dropped", target: null, detail: "invalid" },
    ]);
    expect(r.stdout).not.toContain("evil");
  });
});

describe("A11 role", () => {
  const PARENT = "2026-01-02-01-parent.md";
  it("is copied from the parent's line and replaced by --role", async () => {
    const root = await project(false);
    seed(root, PARENT, "# P\n\nwork\n\n" + lineOf(`continues="${OLD}" role="manager"`) + "\n");
    const copied = await create(root, "# A\n\nx\n", ["--continues", PARENT]);
    expect(copied.lineage?.role).toBe("manager");
    expect(copied.bytes).toBe(appendLineage("# A\n\nx\n", lineOf(`continues="${PARENT}" role="manager"`)));
    const replaced = await create(root, "# B\n\nx\n", ["--continues", PARENT, "--role", "worker"]);
    expect(replaced.lineage?.role).toBe("worker");
  });
});

describe("A13b scan failures in create", () => {
  const TIP = "2026-01-03-01-tip.md";

  it("a not_regular entry: still linked, scan_incomplete with the count, every absorbs dropped", async () => {
    const root = await project(false);
    seed(root, TIP, "# Tip\n\nwork\n\n" + lineOf("") + "\n");
    mkdirSync(join(hdir(root), "2026-01-05-01-dir.md"));
    const r = await create(root, "# A\n\nx\n", ["--continues", OLD, "--absorbs", TIP]);
    expect(r.lineage?.linked).toBe(true);
    expect(r.lineage?.absorbs).toEqual([]);
    expect(r.lineage?.warnings).toEqual([
      { code: "scan_incomplete", target: null, detail: "1" },
      { code: "absorb_dropped", target: TIP, detail: "scan_incomplete" },
    ]);
  });

  it("a parent that is a symlink: parent_unreadable, still linked", async () => {
    const root = await project(false);
    symlinkSync(join(hdir(root), OLD), join(hdir(root), "2026-01-04-01-link.md"));
    const r = await create(root, "# A\n\nx\n", ["--continues", "2026-01-04-01-link.md"]);
    expect(r.lineage?.linked).toBe(true);
    expect(codes(r.lineage)).toEqual(["parent_unreadable", "scan_incomplete"]);
  });

  it("a folder that cannot be listed still writes and reports only scan_failed", async () => {
    const root = await project(false);
    chmodSync(hdir(root), 0o300);
    try {
      const r = await runCli(root, ["handover", "create", "--content", "# A\n\nx\n", "--slug", "lin", "--format", "json", "--continues", "2026-02-02-01-gone.md"]);
      const l = (JSON.parse(r.stdout) as { data: { lineage: LineageJson } }).data.lineage;
      expect(r.exitCode ?? 0).toBe(0);
      expect(l.linked).toBe(true);
      expect(l.forkChildren).toEqual([]);
      expect(l.warnings).toEqual([{ code: "scan_failed", target: null, detail: null }]);
    } finally {
      chmodSync(hdir(root), 0o755);
    }
  });

  it("U1, X, U2 with X a symlink: continuing U2 reports no fork", async () => {
    const root = await project(false);
    seed(root, "2026-01-03-01-u1.md", "# U1\n\nwork\n");
    symlinkSync(join(hdir(root), OLD), join(hdir(root), "2026-01-02-01-x.md"));
    const r = await create(root, "# A\n\nx\n", ["--continues", OLD]);
    expect(r.lineage?.linked).toBe(true);
    expect(r.lineage?.forkChildren).toEqual([]);
    expect(codes(r.lineage)).toEqual(["scan_incomplete"]);
  });

  it("two concurrent creates continuing one parent: the second reports the first as a fork child", async () => {
    const root = await project(false);
    const results = await Promise.all([1, 2].map((i) =>
      handleHandoverCreate(`# C${i}\n\nx\n`, `c${i}`, "json", root, { stamp: false }, { continues: OLD })));
    const data = results.map((r) => (JSON.parse(r.output) as { data: { filename: string; lineage: LineageJson } }).data);
    const forks = data.map((d) => d.lineage.forkChildren);
    const withFork = data.findIndex((d) => d.lineage.forkChildren.length > 0);
    expect(withFork).toBeGreaterThanOrEqual(0);
    expect(forks[withFork]).toEqual([data[1 - withFork]!.filename]);
    expect(forks[1 - withFork]).toEqual([]);
  });
});

function listFixtureHandovers(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name === "handover-lineage") continue;
      out.push(...listFixtureHandovers(dir, r));
    } else if (e.isFile() && e.name.endsWith(".md") && (/(^|\/)handovers\//.test(r) || e.name.startsWith("handover"))) {
      out.push(r);
    }
  }
  return out.sort();
}
