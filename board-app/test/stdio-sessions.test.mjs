import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("built stdio sessions tool reads private runtime state without changing any source bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "storybloq-stdio-sessions-")),
    client = new Client({ name: "sessions-stdio-probe", version: "1" }),
    id = "11111111-1111-4111-8111-111111111111";
  const put = (file, data) =>
    writeFile(join(root, ".story", file), JSON.stringify(data));
  const call = async (offset = 0) => {
    const r = await client.callTool({
      name: "storybloq_sessions",
      arguments: { offset },
    });
    assert.deepEqual(r.content, []);
    assert.equal(r.structuredContent, undefined);
    return r;
  };
  try {
    await mkdir(join(root, ".story/telemetry/presence"), { recursive: true });
    await mkdir(join(root, ".story/sessions", id, "telemetry"), {
      recursive: true,
    });
    await put("config.json", {
      version: 1,
      schemaVersion: 4,
      project: "Disposable sessions probe",
      type: "app",
      language: "ts",
      features: {
        tickets: true,
        issues: true,
        handovers: true,
        roadmap: true,
        reviews: true,
      },
    });
    const now = new Date().toISOString();
    await put("status.json", {
      schemaVersion: 1,
      sessionActive: true,
      sessionId: id,
      state: "TEST",
      observedAt: now,
      source: "hook",
      ticket: "T-001",
      ticketTitle: "Verify running-session information",
      targetWork: ["T-001", "ISS-001"],
      completedThisSession: ["ISS-001"],
      claudeStatus: "waiting_for_input",
      alive: true,
      pendingInstruction: "PRIVATE_INSTRUCTION",
      ownerTask: { client: "codex", id: "PRIVATE_OWNER" },
      tokenPressure: {
        state: "advisory",
        pctBucket: 60,
        ceilingSource: "model",
        ceilingConfidence: "low",
        compactNeeded: false,
      },
    });
    await put("telemetry/presence/interactive.json", {
      schemaVersion: 1,
      sessionId: "interactive",
      startedAt: now,
      lastEventAt: now,
      openTools: [
        { id: "a", tool: "Read", target: "src/app.ts", startedAt: now },
      ],
      milestone: { kind: "reviewing", at: now },
    });
    await writeFile(
      join(root, ".story/sessions", id, "state.json"),
      JSON.stringify({ sessionId: id }),
    );
    await writeFile(join(root, ".story/sessions", id, "telemetry/alive"), "0");
    await writeFile(
      join(root, ".story/sessions", id, "telemetry/lastMcpCall"),
      now,
    );
    const paths = [
      "config.json",
      "status.json",
      "telemetry/presence/interactive.json",
      `sessions/${id}/state.json`,
      `sessions/${id}/telemetry/alive`,
      `sessions/${id}/telemetry/lastMcpCall`,
    ];
    const before = await Promise.all(
      paths.map((p) => readFile(join(root, ".story", p))),
    );
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL("../dist/server.js", import.meta.url))],
        env: { STORYBLOQ_PROJECT_ROOT: root },
        stderr: "pipe",
      }),
    );
    const tool = (await client.listTools()).tools.find(
      (t) => t.name === "storybloq_sessions",
    );
    assert.ok(tool);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.deepEqual(tool._meta.ui.visibility, ["app"]);
    const r = await call();
    assert.equal(r.isError, undefined, JSON.stringify(r));
    const v = r._meta.sessions;
    assert.equal(v.status.record.currentWork.id, "T-001");
    assert.equal(v.status.record.queue.completed, 1);
    assert.equal(v.status.record.derivedStatus, "needsInput");
    assert.equal(v.status.record.alive, false);
    assert.equal(v.status.record.telemetryAvailable, true);
    assert.equal(v.presence.items[0].activity.state, "working");
    assert.equal(v.presence.items[0].milestone.selfReported, true);
    assert.doesNotMatch(JSON.stringify(v), /PRIVATE_/);
    for (let i = 0; i < paths.length; i++)
      assert.deepEqual(
        await readFile(join(root, ".story", paths[i])),
        before[i],
        paths[i],
      );
    await put("status.json", {
      schemaVersion: 1,
      sessionActive: false,
      source: "hook",
    });
    const interactive = await call();
    assert.equal(interactive._meta.sessions.status.kind, "inactive");
    assert.equal(interactive._meta.sessions.presence.items.length, 1);
    assert.deepEqual(
      (await readdir(join(root, ".story/sessions", id, "telemetry"))).sort(),
      ["alive", "lastMcpCall"],
    );
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
});
