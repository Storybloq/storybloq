/**
 * T-460 step 6: drive the BUILT server over real stdio in a scratch project and
 * make actual tool calls against the trimmed schemas.
 *
 * The unit tests exercise the in-process registration path. This exercises what
 * a client does: spawn `storybloq --mcp`, handshake, list tools, then CALL the
 * high-traffic ones. A schema shape broken by a string edit shows up here as an
 * argument rejection, which no byte measurement would catch.
 *
 * Run from the package root after a build: node scripts/smoke-mcp.mjs
 * Pass --keep to leave the scratch repo on disk for inspection.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const keep = process.argv.includes("--keep");
const root = mkdtempSync(join(tmpdir(), "storybloq-smoke-"));
console.log(`scratch project: ${root}`);
const story = join(root, ".story");
for (const d of ["tickets", "issues", "notes", "lessons", "handovers"]) {
  mkdirSync(join(story, d), { recursive: true });
}
writeFileSync(join(story, "config.json"), JSON.stringify({
  version: 2, schemaVersion: 1, project: "smoke", type: "npm", language: "typescript",
  features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
}));
writeFileSync(join(story, "roadmap.json"), JSON.stringify({
  title: "smoke", date: "2026-08-12",
  phases: [{ id: "p1", label: "P1", name: "Phase 1", description: "smoke" }], blockers: [],
}));

// Autonomous mode requires git, so the scratch project is a real repo.
execFileSync("git", ["init", "-q"], { cwd: root });
execFileSync("git", ["config", "user.email", "smoke@test"], { cwd: root });
execFileSync("git", ["config", "user.name", "smoke"], { cwd: root });
writeFileSync(join(root, "README.md"), "smoke\n");
execFileSync("git", ["add", "-A"], { cwd: root });
execFileSync("git", ["commit", "-qm", "init"], { cwd: root });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(process.cwd(), "dist", "cli.js"), "--mcp"],  // run from the package root
  cwd: root,
  env: { ...process.env, PWD: root },
});
const client = new Client({ name: "smoke", version: "0.0.0" });

let failures = 0;
const call = async (name, args) => {
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content ?? []).map((c) => c.text ?? "").join("").slice(0, 600).replace(/\n/g, " ");
    const bad = res.isError === true;
    if (bad) failures++;
    console.log(`  ${bad ? "FAIL" : "ok  "} ${name}: ${text}`);
    return res;
  } catch (err) {
    failures++;
    console.log(`  THREW ${name}: ${err.message}`);
    return null;
  }
};

// The finally is what keeps repeated local runs from littering tmpdir, and it
// also closes the transport -- an early throw would otherwise leave the server
// subprocess parented to a dead script.
try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  const bytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
  console.log(`tools/list over real stdio: ${tools.length} tools, ${bytes} bytes`);

  // High-traffic tools whose describe strings were trimmed hardest.
  await call("storybloq_status", { format: "json" });
  await call("storybloq_ticket_create", { title: "Smoke ticket", description: "d", phase: "p1", type: "chore" });
  await call("storybloq_issue_create", { title: "Smoke issue", impact: "smoke impact", severity: "low" });
  await call("storybloq_ticket_list", {});
  await call("storybloq_issue_list", { status: "open" });
  await call("storybloq_note_create", { content: "smoke note", tags: ["idea"] });
  await call("storybloq_recommend", { count: 3 });
  await call("storybloq_validate", { format: "json" });
  await call("storybloq_session_guard", {});
  // The guide is the single biggest schema; a start call exercises its enums.
  await call("storybloq_autonomous_guide", { action: "start", mode: "auto", sessionId: null, reviewEffort: "light" });
} finally {
  await client.close().catch(() => {});
  if (keep) console.log(`\nscratch project kept at ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL CALLS OK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
