import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  symlink,
  rm,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { fixture } from "./fixture.js";
import { emptySessionIntel } from "../../src/presence/session-intel-fields.js";
import {
  presenceFileBase,
  PRESENCE_SCHEMA_VERSION,
} from "../../src/presence/types.js";

const id = "11111111-1111-4111-8111-111111111111";
const active = (extra = {}) => ({
  schemaVersion: 1,
  sessionActive: true,
  sessionId: id,
  state: "CODE_REVIEW",
  observedAt: new Date().toISOString(),
  source: "hook",
  ...extra,
});
const presence = (sessionId = "interactive", extra = {}) => ({
  schemaVersion: PRESENCE_SCHEMA_VERSION,
  sessionId,
  startedAt: new Date().toISOString(),
  lastEventAt: new Date().toISOString(),
  ...extra,
});
async function setup() {
  const f = await fixture();
  const server = createServer(f.root, "<h1>Sessions</h1>"),
    client = new Client({ name: "session-tests", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = (args = {}) =>
    client.callTool({
      name: "storybloq_sessions",
      arguments: args,
    }) as Promise<any>;
  const read = async (args = {}) => {
    const r = await call(args);
    assert.equal(r.isError, undefined, JSON.stringify(r));
    assert.deepEqual(r.content, []);
    assert.equal(r.structuredContent, undefined);
    assert.ok(r._meta.sessions);
    return r._meta.sessions;
  };
  const addPresence = async (sessionId = "interactive", extra = {}) => {
    await mkdir(join(f.root, ".story/telemetry/presence"), { recursive: true });
    await f.put(
      "telemetry/presence/" + presenceFileBase(sessionId) + ".json",
      presence(sessionId, extra),
    );
  };
  const telemetry = async (
    alive?: string,
    lastMcpCall = new Date().toISOString(),
    shutdown = false,
    state: unknown = { sessionId: id },
  ) => {
    const dir = join(f.root, ".story/sessions", id, "telemetry");
    await mkdir(dir, { recursive: true });
    if (state !== null)
      await writeFile(
        join(f.root, ".story/sessions", id, "state.json"),
        typeof state === "string" ? state : JSON.stringify(state),
      );
    await writeFile(join(dir, "lastMcpCall"), lastMcpCall);
    if (alive !== undefined) await writeFile(join(dir, "alive"), alive);
    if (shutdown)
      await writeFile(join(dir, "shutdown"), "content is irrelevant");
  };
  return {
    ...f,
    call,
    read,
    addPresence,
    telemetry,
    tools: () => client.listTools(),
    close: async () => {
      await client.close();
      await server.close();
      await f.cleanup();
    },
  };
}
test("runtime reads distinguish missing and inactive status without creating runtime directories", async () => {
  const s = await setup();
  try {
    const before = await readdir(join(s.root, ".story"));
    const missing = await s.read();
    assert.equal(missing.status.kind, "missing");
    assert.deepEqual(missing.presence.items, []);
    assert.deepEqual(await readdir(join(s.root, ".story")), before);
    await s.put("status.json", {
      schemaVersion: 1,
      sessionActive: false,
      source: "hook",
    });
    assert.equal((await s.read()).status.kind, "inactive");
  } finally {
    await s.close();
  }
});
test("app-only sessions tool is bounded, read-only and private", async () => {
  const s = await setup();
  try {
    const tool = (await s.tools()).tools.find(
      (t) => t.name === "storybloq_sessions",
    )!;
    assert.ok(tool);
    assert.deepEqual((tool._meta as any).ui.visibility, ["app"]);
    assert.equal(tool.annotations?.readOnlyHint, true);
    const bad = await s.call({ offset: 100 });
    assert.ok(bad.isError);
    await s.put(
      "status.json",
      active({
        pendingInstruction: "PRIVATE_INSTRUCTION",
        ownerTask: { secret: "PRIVATE_OWNER" },
        binaryFingerprint: { sha256: "PRIVATE_BINARY" },
        unknown: "PRIVATE_UNKNOWN",
      }),
    );
    const view = await s.read();
    assert.equal(view.status.kind, "active");
    assert.doesNotMatch(JSON.stringify(view), /PRIVATE_/);
  } finally {
    await s.close();
  }
});
test("active issue-only status projects progress, alerts, subprocesses and bounded metadata", async () => {
  const s = await setup();
  try {
    await s.put(
      "status.json",
      active({
        ticket: " ",
        currentIssue: {
          id: "i-0123456789abcdef",
          displayId: "ISS-003",
          title: "Fix refresh",
          severity: "high",
        },
        targetWork: [" ISS-003 ", "T-001", "ISS-003", ""],
        completedThisSession: ["T-001"],
        claudeStatus: "waiting_for_input",
        healthState: "crashed",
        contextPressure: "critical",
        recentDeferrals: { total: 3, critical: 1 },
        lastReviewVerdict: {
          verdict: "revise",
          summary: "Read the exact diff",
          round: 2,
          findingCount: 1,
        },
        runningSubprocesses: [
          {
            pid: 234,
            category: "review",
            stage: "CODE_REVIEW",
            startedAt: new Date().toISOString(),
          },
        ],
        branch: "codex/test",
        substage: "Independent review",
        tokenPressure: {
          state: "advisory",
          pctBucket: 60,
          ceilingSource: "model",
          ceilingConfidence: "low",
          compactNeeded: false,
        },
      }),
    );
    const v = await s.read();
    assert.equal(v.status.record.currentWork.id, "ISS-003");
    assert.equal(v.status.record.queue.total, 2);
    assert.equal(v.status.record.queue.completed, 1);
    assert.equal(v.status.record.derivedStatus, "needsInput");
    assert.deepEqual(
      v.status.record.alerts.map((a: any) => a.kind),
      ["waiting", "health", "review", "pressure", "deferrals"],
    );
    assert.equal(v.status.record.runningSubprocesses[0].pid, 234);
    assert.equal(v.status.record.tokenPressure.pctBucket, 60);
  } finally {
    await s.close();
  }
});
test("malformed and future status retain valid presence, including portable encoded identifiers", async () => {
  const s = await setup();
  try {
    await s.addPresence("Claude:UPPER");
    await s.put("status.json", {
      schemaVersion: 1,
      sessionActive: true,
      sessionId: "../escape",
      state: "TEST",
      observedAt: "today",
      source: "hook",
    });
    let v = await s.read();
    assert.equal(v.status.kind, "malformed");
    assert.equal(v.presence.items[0].sessionId, "Claude:UPPER");
    await s.put("status.json", { schemaVersion: 2, sessionActive: false });
    v = await s.read();
    assert.equal(v.status.kind, "unsupported");
    assert.equal(v.presence.items.length, 1);
    await writeFile(join(s.root, ".story/status.json"), "{");
    assert.equal((await s.read()).status.kind, "malformed");
  } finally {
    await s.close();
  }
});
test("presence isolates malformed/future siblings, drops malformed tools and excludes raw intelligence", async () => {
  const s = await setup();
  try {
    await s.addPresence("a", {
      openTools: [
        {
          id: "t",
          tool: "Read",
          target: "src/app.ts",
          startedAt: new Date().toISOString(),
        },
        null,
      ],
      arrangementPresence: [
        {
          arrangementId: "a-0123456789abcdef",
          role: "pen",
          lifecycle: "active",
          supervising: { workerActive: true },
        },
      ],
      milestone: {
        kind: "future-kind",
        at: new Date().toISOString(),
        note: "Self reported",
      },
      sessionIntel: {
        ...emptySessionIntel(),
        transcriptPath: "/private/PRIVATE_INTELLIGENCE/transcript.jsonl",
      },
      ownerIdentity: { client: "codex", clientTaskId: "PRIVATE_OWNER" },
    });
    await s.put("telemetry/presence/b.json", {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      sessionId: "wrong",
      startedAt: new Date().toISOString(),
    });
    await s.put(
      "telemetry/presence/c.json",
      presence("c", { schemaVersion: PRESENCE_SCHEMA_VERSION + 1 }),
    );
    const v = await s.read();
    assert.equal(v.presence.items.length, 1);
    assert.equal(v.presence.items[0].openTools.length, 1);
    assert.match(v.presence.items[0].supervision, /worker active/);
    assert.equal(v.presence.items[0].milestone.selfReported, true);
    assert.match(v.presence.items[0].milestone.label, /future-kind/);
    assert.equal(v.presence.malformed, 1);
    assert.equal(v.presence.unsupported, 1);
    assert.doesNotMatch(JSON.stringify(v), /PRIVATE_/);
    assert.equal(v.presence.items[0].sessionIntel, undefined);
  } finally {
    await s.close();
  }
});
test("presence hides suppressed/ended/stale records and pages visible rows", async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 25; i++)
      await s.addPresence("p" + String(i).padStart(2, "0"));
    await s.addPresence("suppressed", { suppressed: true });
    await s.addPresence("ended", { endedAt: new Date().toISOString() });
    await s.addPresence("ended-empty", { endedAt: "" });
    await s.addPresence("stale", {
      startedAt: "2020-01-01T00:00:00Z",
      lastEventAt: "2020-01-01T00:00:00Z",
    });
    const first = await s.read(),
      second = await s.read({ offset: 20 });
    assert.equal(first.presence.total, 25);
    assert.equal(first.presence.items.length, 20);
    assert.equal(second.presence.items.length, 5);
    assert.equal(first.presence.items[0].sessionId, "p00");
  } finally {
    await s.close();
  }
});
for (const [value, expected] of [
  ["0", false],
  ["123456789", true],
  ["-1", null],
  ["garbage", null],
  ["9223372036854775808", null],
  ["", null],
] as const)
  test("telemetry alive semantics " + JSON.stringify(value), async () => {
    const s = await setup();
    try {
      await s.put("status.json", active({ alive: true }));
      await s.telemetry(value);
      const r = (await s.read()).status.record;
      assert.equal(r.telemetryAvailable, expected !== null);
      assert.equal(r.alive, expected ?? true);
    } finally {
      await s.close();
    }
  });
test("shutdown wins without alive, but telemetry requires nonempty lastMcpCall", async () => {
  const s = await setup();
  try {
    await s.put("status.json", active({ alive: true }));
    await s.telemetry(undefined, new Date().toISOString(), true);
    assert.equal((await s.read()).status.record.alive, false);
    await s.telemetry(undefined, "   ", true);
    const r = (await s.read()).status.record;
    assert.equal(r.alive, true);
    assert.equal(r.telemetryAvailable, false);
  } finally {
    await s.close();
  }
});
const generation = "0123456789abcdef";
const generationDir = (root: string) =>
  join(root, ".story/sessions", id, "telemetry/generations", generation);
test("a taken-over session reads alive and shutdown from the current owner's generation, lastMcpCall from its canonical path", async () => {
  const s = await setup();
  try {
    const last = new Date().toISOString();
    await s.put("status.json", active({ alive: true }));
    // The displaced owner left a legacy shutdown marker behind.
    await s.telemetry(undefined, last, true, {
      sessionId: id,
      heartbeatGeneration: generation,
    });
    await mkdir(generationDir(s.root), { recursive: true });
    await writeFile(join(generationDir(s.root), "alive"), "123");
    let r = (await s.read()).status.record;
    assert.equal(r.alive, true);
    assert.equal(r.telemetryAvailable, true);
    assert.equal(r.lastMcpCall, last);
    await writeFile(join(generationDir(s.root), "shutdown"), "1");
    r = (await s.read()).status.record;
    assert.equal(r.alive, false);
    assert.equal(r.telemetryAvailable, true);
  } finally {
    await s.close();
  }
});
for (const [label, state] of [
  ["a malformed generation id", { sessionId: id, heartbeatGeneration: "../x" }],
  ["a non-string generation id", { sessionId: id, heartbeatGeneration: 7 }],
  ["an empty generation id", { sessionId: id, heartbeatGeneration: "" }],
  ["an unparsable session state", "{"],
  ["a non-object session state", "[]"],
  ["a missing session state", null],
] as const)
  test("telemetry falls back to the status signals for " + label, async () => {
    const s = await setup();
    try {
      await s.put("status.json", active({ alive: true }));
      await s.telemetry("0", new Date().toISOString(), true, state);
      const r = (await s.read()).status.record;
      assert.equal(r.alive, true);
      assert.equal(r.telemetryAvailable, false);
    } finally {
      await s.close();
    }
  });
test("an oversized session state falls back to the status signals", async () => {
  const s = await setup();
  try {
    await s.put("status.json", active({ alive: true }));
    await s.telemetry("0", new Date().toISOString(), true, {
      sessionId: id,
      pad: "x".repeat(300 * 1024),
    });
    const r = (await s.read()).status.record;
    assert.equal(r.alive, true);
    assert.equal(r.telemetryAvailable, false);
  } finally {
    await s.close();
  }
});
test("oversized optional lists are capped and truncation is explicit", async () => {
  const s = await setup();
  try {
    await s.put(
      "status.json",
      active({
        targetWork: Array.from({ length: 501 }, (_, i) => "T-" + i),
        completedThisSession: Array.from({ length: 501 }, (_, i) => "T-" + i),
        runningSubprocesses: Array.from({ length: 201 }, (_, i) => ({
          pid: i + 1,
          category: "build",
          stage: "TEST",
          startedAt: new Date().toISOString(),
        })),
        ticketTitle: "x".repeat(3000),
      }),
    );
    const r = (await s.read()).status.record;
    assert.equal(r.queue.items.length, 500);
    assert.equal(r.completedThisSession.length, 500);
    assert.equal(r.runningSubprocesses.length, 200);
    assert.equal(r.truncated, true);
  } finally {
    await s.close();
  }
});
test("roster read cap is deterministic and discloses unread candidates", async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 102; i++)
      await s.addPresence("p" + String(i).padStart(3, "0"));
    const p = (await s.read()).presence;
    assert.equal(p.total, 100);
    assert.equal(p.unread, 2);
    assert.equal(p.items[0].sessionId, "p000");
  } finally {
    await s.close();
  }
});
for (const path of [
  "status.json",
  "telemetry",
  "telemetry/presence",
  "sessions",
  `sessions/${id}`,
  `sessions/${id}/telemetry`,
])
  test("unsafe runtime path is refused: " + path, async () => {
    const s = await setup();
    try {
      await s.put("status.json", active());
      await s.addPresence();
      await s.telemetry("123");
      await s.read();
      const target = join(s.root, ".story", path);
      await rm(target, { recursive: true, force: true });
      await symlink(
        path === "status.json" ? join(s.root, ".story/config.json") : s.root,
        target,
      );
      const r = await s.call();
      assert.ok(r.isError, JSON.stringify(r));
      assert.doesNotMatch(JSON.stringify(r), new RegExp(s.root));
    } finally {
      await s.close();
    }
  });
test("valid exact-size runtime documents pass; valid oversized documents refuse without writes", async () => {
  const s = await setup();
  try {
    const padded = (record: unknown, size: number) => {
      const text = JSON.stringify(record);
      return text + " ".repeat(size - Buffer.byteLength(text));
    };
    const statusPath = join(s.root, ".story/status.json");
    await writeFile(statusPath, padded(active(), 256 * 1024));
    await s.read();
    await writeFile(statusPath, padded(active(), 256 * 1024 + 1));
    const before = await readFile(statusPath);
    assert.ok((await s.call()).isError);
    assert.deepEqual(await readFile(statusPath), before);
    await rm(statusPath);
    await s.addPresence();
    const path = join(s.root, ".story/telemetry/presence/interactive.json");
    await writeFile(path, padded(presence(), 16 * 1024));
    await s.read();
    await writeFile(path, padded(presence(), 16 * 1024 + 1));
    const noteBefore = await readFile(path);
    assert.ok((await s.call()).isError);
    assert.deepEqual(await readFile(path), noteBefore);
  } finally {
    await s.close();
  }
});
test("reading runtime leaves status and every source record byte-identical and avoids ledger parsing", async () => {
  const s = await setup();
  try {
    await s.put("status.json", active());
    await s.addPresence();
    await s.telemetry("123");
    await writeFile(
      join(s.root, ".story/tickets/T-001.json"),
      "malformed unrelated ticket",
    );
    const paths = [
      "status.json",
      "telemetry/presence/interactive.json",
      `sessions/${id}/telemetry/alive`,
      `sessions/${id}/telemetry/lastMcpCall`,
      "tickets/T-001.json",
    ];
    const before = await Promise.all(
      paths.map((p) => readFile(join(s.root, ".story", p))),
    );
    await s.read();
    for (let i = 0; i < paths.length; i++)
      assert.deepEqual(
        await readFile(join(s.root, ".story", paths[i])),
        before[i],
      );
  } finally {
    await s.close();
  }
});
test("status identity change during marker reads refuses a mixed-session result", async () => {
  const s = await setup();
  const original = fs.promises.open;
  try {
    await s.put("status.json", active());
    await s.telemetry("123");
    await s.read();
    let triggered = false;
    fs.promises.open = async function (...args: Parameters<typeof original>) {
      if (String(args[0]).endsWith("/telemetry/alive") && !triggered) {
        triggered = true;
        await s.put(
          "status.json",
          active({ sessionId: "22222222-2222-4222-8222-222222222222" }),
        );
      }
      return original(...args);
    } as typeof original;
    syncBuiltinESMExports();
    const r = await s.call();
    assert.equal(triggered, true, "marker interception must actually run");
    assert.ok(r.isError, JSON.stringify(r));
  } finally {
    fs.promises.open = original;
    syncBuiltinESMExports();
    await s.close();
  }
});
test("fixed startup root rejects a replacement directory", async () => {
  const s = await setup(),
    old = s.root + "-old";
  try {
    await s.read();
    await rename(s.root, old);
    await mkdir(s.root);
    await mkdir(join(s.root, ".story"));
    const r = await s.call();
    assert.ok(r.isError, JSON.stringify(r));
  } finally {
    await s.close();
    await rm(old, { recursive: true, force: true });
  }
});
test("presence entry limit and individual symlink refuse controlled snapshots", async () => {
  const s = await setup();
  try {
    await s.addPresence();
    await s.read();
    const dir = join(s.root, ".story/telemetry/presence");
    await symlink(join(s.root, ".story/config.json"), join(dir, "other.json"));
    assert.ok((await s.call()).isError);
    await rm(join(dir, "other.json"));
    for (let i = 0; i < 2000; i++)
      await writeFile(join(dir, "ignored" + i), "");
    assert.ok((await s.call()).isError);
  } finally {
    await s.close();
  }
});
test("invalid UTF-8 runtime input is refused without a path leak", async () => {
  const s = await setup();
  try {
    await s.read();
    await writeFile(join(s.root, ".story/status.json"), Buffer.from([0xff]));
    const r = await s.call();
    assert.ok(r.isError);
    assert.doesNotMatch(JSON.stringify(r), new RegExp(s.root));
  } finally {
    await s.close();
  }
});
test("canonical parser to activity projection preserves strict timestamp and ended precedence", async () => {
  const s = await setup();
  try {
    const now = new Date().toISOString();
    await s.addPresence("valid", {
      openTools: [
        { id: "t", tool: "Read", startedAt: now, target: "src/app.ts" },
      ],
    });
    await s.addPresence("bad-tool", { openTools: [{ id: "t", tool: "Read" }] });
    await s.addPresence("fallback", { lastEventAt: "not a timestamp" });
    await s.addPresence("date-only", {
      startedAt: "2026-10-01",
      lastEventAt: "2026-10-01",
    });
    await s.addPresence("prose", {
      startedAt: "October 1, 2026",
      lastEventAt: "October 1, 2026",
    });
    await s.addPresence("empty-ended", { endedAt: "" });
    await s.addPresence("bad-required", { startedAt: "invalid" });
    const p = (await s.read()).presence,
      byId = new Map<string, any>(p.items.map((x: any) => [x.sessionId, x]));
    assert.equal(byId.get("valid").activity.state, "working");
    assert.equal(byId.get("bad-tool").activity.state, "idleRecent");
    assert.equal(byId.get("fallback").activity.state, "idleRecent");
    assert.equal(byId.get("date-only").activity.state, "unknown");
    assert.equal(byId.get("prose").activity.state, "unknown");
    assert.equal(byId.has("empty-ended"), false);
    assert.equal(byId.has("bad-required"), false);
    assert.equal(p.malformed, 1);
  } finally {
    await s.close();
  }
});
test("marker and basename ceilings are decisive independent of parsing", async () => {
  const s = await setup();
  try {
    await s.put("status.json", active());
    await s.telemetry("1" + " ".repeat(127));
    await s.read();
    await s.telemetry("1" + " ".repeat(128));
    assert.ok((await s.call()).isError);
    await s.telemetry("1");
    await s.addPresence();
    await writeFile(
      join(s.root, ".story/telemetry/presence", "x".repeat(207) + ".json"),
      JSON.stringify(presence()),
    );
    assert.ok((await s.call()).isError);
  } finally {
    await s.close();
  }
});
test("raw required status fields are individually validated and health alert branches match Mac", async () => {
  const s = await setup();
  try {
    for (const [key, value] of [
      ["sessionId", "../bad"],
      ["state", ""],
      ["observedAt", ""],
      ["source", ""],
      ["sessionActive", "true"],
      ["schemaVersion", null],
    ] as const) {
      await s.put("status.json", { ...active(), [key]: value });
      assert.equal((await s.read()).status.kind, "malformed", String(key));
    }
    for (const healthState of [
      "healthy",
      "working",
      "waiting-on-build",
      "ended",
      "unknown",
    ]) {
      await s.put("status.json", active({ healthState }));
      assert.equal((await s.read()).status.record.alerts.length, 0);
    }
    await s.put("status.json", active({ healthState: "future-state" }));
    const r = (await s.read()).status.record;
    assert.equal(r.alerts[0].tone, "ochre");
    assert.equal(r.alerts[0].kind, "health");
  } finally {
    await s.close();
  }
});
test("persisted role summaries and future milestones do not imply automatic liveness", async () => {
  const s = await setup();
  try {
    await s.addPresence("pen", {
      arrangementPresence: [
        {
          arrangementId: "a-0123456789abcdef",
          role: "pen",
          lifecycle: "suspended",
          supervising: { workerActive: false },
        },
      ],
      milestone: { kind: "reviewing", at: "2099-01-01T00:00:00Z" },
    });
    await s.addPresence("worker", {
      arrangementPresence: [
        {
          arrangementId: "a-0123456789abcdef",
          role: "worker",
          lifecycle: "active",
        },
      ],
      milestone: {
        kind: "gate-hold",
        at: "2020-01-01T00:00:00Z",
        gateName: "Owner gate",
      },
    });
    const p = (await s.read()).presence;
    assert.match(p.items[0].supervision, /worker not active/);
    assert.equal(p.items[0].milestone.clockAnomaly, true);
    assert.equal(p.items[0].milestone.overdue, false);
    assert.equal(p.items[1].supervision, null);
    assert.equal(p.items[1].milestone.overdue, true);
    assert.match(p.items[1].milestone.label, /Owner gate/);
  } finally {
    await s.close();
  }
});
for (const mutation of ["ancestor", "absent-shutdown", "root"])
  test(
    "runtime snapshot detects interleaved " + mutation + " replacement",
    async () => {
      const s = await setup(),
        original = fs.promises.open,
        backup = s.root + "-old";
      try {
        await s.put("status.json", active());
        await s.telemetry("1");
        await s.read();
        let triggered = false;
        fs.promises.open = async function (
          ...args: Parameters<typeof original>
        ) {
          const handle = await original(...args);
          if (String(args[0]).endsWith("/telemetry/alive") && !triggered) {
            triggered = true;
            if (mutation === "ancestor") {
              const dir = join(s.root, ".story/sessions", id, "telemetry");
              await rename(dir, dir + "-old");
              await mkdir(dir);
              await writeFile(join(dir, "alive"), "1");
              await writeFile(
                join(dir, "lastMcpCall"),
                new Date().toISOString(),
              );
            } else if (mutation === "absent-shutdown")
              await writeFile(
                join(s.root, ".story/sessions", id, "telemetry/shutdown"),
                "",
              );
            else {
              await rename(s.root, backup);
              await mkdir(s.root);
              await mkdir(join(s.root, ".story"));
            }
          }
          return handle;
        } as typeof original;
        syncBuiltinESMExports();
        const r = await s.call();
        assert.equal(triggered, true);
        assert.ok(r.isError, JSON.stringify(r));
      } finally {
        fs.promises.open = original;
        syncBuiltinESMExports();
        await s.close();
        await rm(backup, { recursive: true, force: true });
      }
    },
  );

test("scalar title, branch and review-summary caps are independently observable", async () => {
  const s = await setup();
  try {
    for (const [field, cap] of [
      ["ticketTitle", 2000],
      ["branch", 256],
      ["reviewSummary", 2000],
    ] as const) {
      for (const extra of [0, 1]) {
        const value = "x".repeat(cap + extra);
        const raw =
          field === "reviewSummary"
            ? { lastReviewVerdict: { verdict: "approve", summary: value } }
            : { [field]: value };
        await s.put("status.json", active({ ticket: "T-001", ...raw }));
        const r = (await s.read()).status.record;
        const projected =
          field === "ticketTitle"
            ? r.currentWork.title
            : field === "branch"
              ? r.branch
              : r.lastReviewVerdict.summary;
        assert.equal(projected, "x".repeat(cap));
        assert.equal(
          r.truncated,
          extra === 1,
          field + " independently reports clipping",
        );
      }
    }
  } finally {
    await s.close();
  }
});
