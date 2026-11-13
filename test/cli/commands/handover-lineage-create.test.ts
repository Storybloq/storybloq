/**
 * ISS-1499 slice A: `handover create` with lineage (plan section 5).
 *
 * A4 (C2 for create): with no lineage line and no lineage flag, the bytes on
 * disk and the reply, in md and json, sequenced and team-mode filenames, on
 * the CLI and through the registered MCP tool, equal goldens captured from
 * main before any lineage code existed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initProject } from "../../../src/core/init.js";
import { isolateEnv, runCli, callMcp, type IsolatedEnv } from "../../fixtures/handover-lineage/harness.js";
import { LINE } from "../../fixtures/handover-lineage/shapes.js";

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
