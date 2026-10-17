import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  mkdir,
  cp,
  symlink,
  rm,
  readdir,
  lstat,
  readlink,
  writeFile,
  realpath,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { fixture, ticket } from "./fixture.js";
import { nodePreviewTickets } from "../src/federation.js";
import { makeState, makeTicket } from "../../test/core/test-factories.js";

async function connect(root: string, approvedNodeRoots: string[] = []) {
  const server = (createServer as any)(root, "<h1>Board</h1>", {
    approvedNodeRoots,
  });
  const client = new Client({ name: "federation-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
async function config(f: Awaited<ReturnType<typeof fixture>>, nodes: any) {
  const existing = JSON.parse(
    await readFile(join(f.root, ".story/config.json"), "utf8"),
  );
  await f.put("config.json", { ...existing, type: "orchestrator", nodes });
}
const summary = {
  ticketCount: 10,
  openTickets: 4,
  completeTickets: 6,
  issueCount: 3,
  openIssues: 2,
  lastHandoverDate: "2026-09-29",
  lastHandoverTitle: "Recorded work",
  reachable: true,
  countingContract: 2,
};
test("prototype-named nodes with absent cache entries stay readable", async () => {
  const f = await fixture();
  const c = await connect(f.root);
  try {
    await config(f, { constructor: { path: "." } });
    await f.put("federation-cache.json", {
      lastScanTimestamp: new Date().toISOString(),
      nodes: {},
    });
    const before = await inventory(f.root);
    const result: any = await c.client.callTool({
      name: "storybloq_federation",
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    assert.equal(result._meta.federation.nodes[0].name, "constructor");
    assert.equal(result._meta.federation.nodes[0].cacheState, "missing");
    assert.equal(result._meta.federation.nodes[0].cache, null);
    assert.deepEqual(await inventory(f.root), before);
  } finally {
    await c.close();
    await f.cleanup();
  }
});
async function inventory(root: string) {
  const result: Record<string, string> = {};
  async function walk(path: string, relative = "") {
    for (const name of (await readdir(path)).sort()) {
      const full = join(path, name),
        key = relative + name,
        stat = await lstat(full);
      if (stat.isSymbolicLink()) result[key] = "link:" + (await readlink(full));
      else if (stat.isDirectory()) {
        result[key + "/"] = "directory";
        await walk(full, key + "/");
      } else
        result[key] = createHash("sha256")
          .update(await readFile(full))
          .digest("hex");
    }
  }
  await walk(join(root, ".story"));
  return result;
}
test("all new reads are app-only and preserve the entire root and approved node ledger", async () => {
  const f = await fixture(),
    external = await fixture();
  const c = await connect(f.root, [external.root]);
  try {
    await config(f, { external: { path: external.root } });
    await mkdir(join(f.root, ".story/handovers"));
    await writeFile(
      join(f.root, ".story/handovers/2026-09-30-test.md"),
      "# Work\n\nRead only.",
    );
    await f.put("federation-cache.json", {
      lastScanTimestamp: new Date().toISOString(),
      nodes: { external: summary },
    });
    const before = await inventory(f.root),
      beforeNode = await inventory(external.root);
    const tools = (await c.client.listTools()).tools;
    assert.equal(tools.length, 17);
    for (const name of [
      "storybloq_timeline",
      "storybloq_timeline_group",
      "storybloq_handover_detail",
      "storybloq_federation",
      "storybloq_node_detail",
    ]) {
      const tool = tools.find((t) => t.name === name);
      assert.equal(tool?.annotations?.readOnlyHint, true);
      assert.equal(tool?.annotations?.destructiveHint, false);
      assert.deepEqual((tool?._meta?.ui as any)?.visibility, ["app"]);
    }
    const h: any = await c.client.callTool({
      name: "storybloq_timeline",
      arguments: {},
    });
    const g: any = await c.client.callTool({
      name: "storybloq_timeline_group",
      arguments: { group: h._meta.history.groups.items[0].key },
    });
    const body: any = await c.client.callTool({
      name: "storybloq_handover_detail",
      arguments: { id: g._meta.handovers.items[0].key },
    });
    const graph: any = await c.client.callTool({
      name: "storybloq_federation",
      arguments: {},
    });
    const node: any = await c.client.callTool({
      name: "storybloq_node_detail",
      arguments: { name: "external" },
    });
    for (const r of [h, g, body, graph, node]) {
      assert.equal(r.isError, undefined);
      assert.deepEqual(r.content, []);
      assert.ok(!JSON.stringify(r).includes(f.root));
      assert.ok(!JSON.stringify(r).includes(external.root));
      assert.ok(!JSON.stringify(r).includes("DO_NOT_EXPOSE"));
    }
    assert.deepEqual(await inventory(f.root), before);
    assert.deepEqual(await inventory(external.root), beforeNode);
  } finally {
    await c.close();
    await f.cleanup();
    await external.cleanup();
  }
});
test("trusted macOS root spellings work, but prefix siblings and different aliases are not approval", async () => {
  const f = await fixture(),
    external = await fixture();
  const sibling = f.root + "-sibling",
    alias = external.root + "-alias";
  await mkdir(sibling);
  await cp(join(external.root, ".story"), join(sibling, ".story"), {
    recursive: true,
  });
  await symlink(external.root, alias);
  await config(f, {
    declared: { path: external.root },
    canonical: { path: await realpath(external.root) },
    sibling: { path: sibling },
    alias: { path: alias },
  });
  const c = await connect(f.root, [external.root]);
  try {
    for (const name of ["declared", "canonical"]) {
      const r: any = await c.client.callTool({
        name: "storybloq_node_detail",
        arguments: { name },
      });
      assert.equal(r._meta.node.preview.state, "ready");
    }
    for (const name of ["sibling", "alias"]) {
      const r: any = await c.client.callTool({
        name: "storybloq_node_detail",
        arguments: { name },
      });
      assert.equal(r._meta.node.preview.state, "not-approved");
      assert.ok(!JSON.stringify(r).includes(external.root));
      assert.ok(!JSON.stringify(r).includes(sibling));
    }
  } finally {
    await c.close();
    await rm(sibling, { recursive: true, force: true });
    await rm(alias, { force: true });
    await f.cleanup();
    await external.cleanup();
  }
});
test("federation separates dependency direction from runtime links and labels cached freshness", async () => {
  const f = await fixture();
  const c = await connect(f.root);
  try {
    await config(f, {
      library: {
        path: "library",
        kind: "library",
        stack: "Swift",
        role: "Shared code",
        summary: "Used by apps",
        health: "green",
      },
      app: {
        path: "app",
        dependsOn: ["library"],
        links: [{ to: "service", via: "HTTPS" }],
        health: "yellow",
      },
      service: {
        path: "service",
        links: [{ to: "app", via: "events" }],
        health: "grey",
      },
    });
    await f.put("federation-cache.json", {
      lastScanTimestamp: new Date(Date.now() - 600000).toISOString(),
      nodes: {
        app: summary,
        service: { ...summary, reachable: false, unreachableReason: "Offline" },
      },
    });
    const before = await readFile(
      join(f.root, ".story/federation-cache.json"),
      "utf8",
    );
    const r: any = await c.client.callTool({
      name: "storybloq_federation",
      arguments: {},
    });
    assert.equal(r.isError, undefined);
    assert.deepEqual(r.content, []);
    const b = r._meta.federation;
    assert.equal(b.isOrchestrator, true);
    assert.deepEqual(
      b.edges.map((e: any) => [e.type, e.from, e.to, e.via ?? null]),
      [
        ["build", "library", "app", null],
        ["runtime", "app", "service", "HTTPS"],
        ["runtime", "service", "app", "events"],
      ],
    );
    assert.equal(
      b.nodes.find((n: any) => n.name === "app").cacheState,
      "stale",
    );
    assert.equal(
      b.nodes.find((n: any) => n.name === "app").cache.completeTickets,
      6,
    );
    assert.equal(
      b.nodes.find((n: any) => n.name === "service").cacheState,
      "unreachable",
    );
    assert.equal(
      b.nodes.find((n: any) => n.name === "library").cacheState,
      "missing",
    );
    assert.ok(!JSON.stringify(r).includes("DO_NOT_EXPOSE"));
    assert.ok(!JSON.stringify(r).includes(f.root));
    assert.equal(
      await readFile(join(f.root, ".story/federation-cache.json"), "utf8"),
      before,
    );
    const n: any = await c.client.callTool({
      name: "storybloq_node_detail",
      arguments: { name: "app" },
    });
    assert.deepEqual(n._meta.node.buildsAfter, ["library"]);
    assert.deepEqual(
      n._meta.node.runtimeOutgoing.map((e: any) => e.to),
      ["service"],
    );
    assert.deepEqual(
      n._meta.node.runtimeIncoming.map((e: any) => e.from),
      ["service"],
    );
    assert.equal(n._meta.node.preview.state, "unavailable");
  } finally {
    await c.close();
    await f.cleanup();
  }
});
test("federation invalid cache never deletes it; missing and future cache are explicit", async () => {
  const f = await fixture();
  const c = await connect(f.root);
  try {
    await config(f, { app: { path: "app" } });
    const missing: any = await c.client.callTool({
      name: "storybloq_federation",
      arguments: {},
    });
    assert.equal(missing._meta.federation.nodes[0].cacheState, "missing");
    for (const value of [
      {
        lastScanTimestamp: new Date(Date.now() + 600000).toISOString(),
        nodes: { app: summary },
      },
      { lastScanTimestamp: "invalid", nodes: { app: summary } },
      {
        lastScanTimestamp: new Date().toISOString(),
        nodes: { app: { ...summary, ticketCount: -1 } },
      },
    ]) {
      await f.put("federation-cache.json", value);
      const before = await readFile(
        join(f.root, ".story/federation-cache.json"),
        "utf8",
      );
      const r: any = await c.client.callTool({
        name: "storybloq_federation",
        arguments: {},
      });
      assert.equal(
        r._meta.federation.nodes[0].cacheState,
        value.lastScanTimestamp === "invalid" || value.nodes.app.ticketCount < 0
          ? "unavailable"
          : "future",
      );
      assert.equal(
        await readFile(join(f.root, ".story/federation-cache.json"), "utf8"),
        before,
      );
    }
    const fs = await import("node:fs/promises");
    await fs.writeFile(join(f.root, ".story/federation-cache.json"), "{BROKEN");
    const broken: any = await c.client.callTool({
      name: "storybloq_federation",
      arguments: {},
    });
    assert.equal(broken._meta.federation.nodes[0].cacheState, "unavailable");
    assert.equal(
      await readFile(join(f.root, ".story/federation-cache.json"), "utf8"),
      "{BROKEN",
    );
  } finally {
    await c.close();
    await f.cleanup();
  }
});
test("cycles and unknown relations produce warnings while a normal project has no nodes", async () => {
  const f = await fixture();
  const c = await connect(f.root);
  try {
    const app: any = await c.client.callTool({
      name: "storybloq_federation",
      arguments: {},
    });
    assert.equal(app._meta.federation.isOrchestrator, false);
    assert.deepEqual(app._meta.federation.nodes, []);
    await config(f, {
      a: { path: "a", dependsOn: ["b"] },
      b: { path: "b", dependsOn: ["a"], links: [{ to: "missing" }] },
    });
    const cycle: any = await c.client.callTool({
      name: "storybloq_federation",
      arguments: {},
    });
    assert.ok(
      cycle._meta.federation.warnings.some((w: string) => /cycle/i.test(w)),
    );
    assert.ok(
      cycle._meta.federation.warnings.some((w: string) => /runtime/i.test(w)),
    );
    assert.equal(
      cycle._meta.federation.edges.some((e: any) => e.to === "missing"),
      false,
    );
    await config(f, { a: { path: "../outside" } });
    const bad: any = await c.client.callTool({
      name: "storybloq_federation",
      arguments: {},
    });
    assert.equal(bad.isError, true);
    assert.ok(!JSON.stringify(bad).includes(f.root));
  } finally {
    await c.close();
    await f.cleanup();
  }
});
test("node previews read only configured children or exact startup-approved external roots and retain canonical lifecycle", async () => {
  const f = await fixture(),
    external = await fixture();
  await external.put(
    "tickets/T-002.json",
    ticket("T-002", { status: "inprogress" }),
  );
  await external.put(
    "tickets/T-003.json",
    ticket("T-003", { lifecycle: "deleted" }),
  );
  await external.put(
    "tickets/T-004.json",
    ticket("T-004", { ownerCheckpoint: {} }),
  );
  await external.put(
    "tickets/T-005.json",
    ticket("T-005", { parentTicket: "T-001" }),
  );
  await mkdir(join(f.root, "child"));
  await cp(join(external.root, ".story"), join(f.root, "child/.story"), {
    recursive: true,
  });
  await config(f, {
    child: { path: "child" },
    external: { path: external.root },
    linked: { path: "linked" },
  });
  await symlink(external.root, join(f.root, "linked"));
  const denied = await connect(f.root),
    allowed = await connect(f.root, [external.root]);
  try {
    const d: any = await denied.client.callTool({
      name: "storybloq_node_detail",
      arguments: { name: "external" },
    });
    assert.equal(d._meta.node.preview.state, "not-approved");
    assert.ok(!JSON.stringify(d).includes(external.root));
    const child: any = await denied.client.callTool({
      name: "storybloq_node_detail",
      arguments: { name: "child", limit: 1 },
    });
    assert.equal(child._meta.node.preview.state, "ready");
    assert.equal(child._meta.node.preview.total, 2);
    assert.equal(child._meta.node.preview.items[0].displayId, "T-002");
    const page: any = await denied.client.callTool({
      name: "storybloq_node_detail",
      arguments: { name: "child", offset: 1, limit: 1 },
    });
    assert.equal(page._meta.node.preview.items[0].displayId, "T-005");
    const e: any = await allowed.client.callTool({
      name: "storybloq_node_detail",
      arguments: { name: "external" },
    });
    assert.equal(e._meta.node.preview.state, "ready");
    const link: any = await allowed.client.callTool({
      name: "storybloq_node_detail",
      arguments: { name: "linked" },
    });
    assert.equal(link._meta.node.preview.state, "unavailable");
    const unknown: any = await denied.client.callTool({
      name: "storybloq_node_detail",
      arguments: { name: "unknown", root: external.root },
    });
    assert.equal(unknown.isError, true);
    await rm(join(f.root, "child/.story/tickets/T-002.json"));
    await symlink(
      "/etc/passwd",
      join(f.root, "child/.story/tickets/T-002.json"),
    );
    const unsafe: any = await denied.client.callTool({
      name: "storybloq_node_detail",
      arguments: { name: "child" },
    });
    assert.equal(unsafe._meta.node.preview.state, "unavailable");
  } finally {
    await denied.close();
    await allowed.close();
    await f.cleanup();
    await external.cleanup();
  }
});
test("an unavailable approved root does not block healthy local and approved node details", async () => {
  const f = await fixture(),
    external = await fixture();
  await mkdir(join(f.root, "child"));
  await cp(join(external.root, ".story"), join(f.root, "child/.story"), {
    recursive: true,
  });
  const missing = external.root + "-missing";
  await config(f, {
    child: { path: "child" },
    external: { path: external.root },
    missing: { path: missing },
  });
  const c = await connect(f.root, [missing, external.root]);
  try {
    for (const name of ["child", "external", "missing"]) {
      const r: any = await c.client.callTool({
        name: "storybloq_node_detail",
        arguments: { name },
      });
      assert.equal(r.isError, undefined);
      assert.equal(
        r._meta.node.preview.state,
        name === "missing" ? "unavailable" : "ready",
      );
      assert.ok(!JSON.stringify(r).includes(missing));
    }
  } finally {
    await c.close();
    await f.cleanup();
    await external.cleanup();
  }
});
test("the shared ledger boundary refuses oversized canonical identities before projection", async () => {
  const f = await fixture(),
    c = await connect(f.root);
  try {
    await f.put("tickets/T-001.json", ticket("T-" + "1".repeat(20000)));
    const r: any = await c.client.callTool({
      name: "storybloq_board_overview",
      arguments: {},
    });
    assert.equal(r.isError, true);
    assert.ok(!JSON.stringify(r).includes("1".repeat(100)));
  } finally {
    await c.close();
    await f.cleanup();
  }
});

test("Mac tilde-configured node paths still require an exact approved external root", async () => {
  const f = await fixture(),
    external = await fixture(homedir());
  await config(f, { external: { path: "~/" + basename(external.root) } });
  const denied = await connect(f.root),
    allowed = await connect(f.root, [external.root]);
  try {
    const d: any = await denied.client.callTool({
      name: "storybloq_node_detail",
      arguments: { name: "external" },
    });
    assert.equal(d._meta.node.preview.state, "not-approved");
    const a: any = await allowed.client.callTool({
      name: "storybloq_node_detail",
      arguments: { name: "external" },
    });
    assert.equal(a._meta.node.preview.state, "ready");
    assert.ok(!JSON.stringify(a).includes(external.root));
  } finally {
    await denied.close();
    await allowed.close();
    await f.cleanup();
    await external.cleanup();
  }
});

// T-566 F7: cached node numbers count only on main's current counting contract (T-486 U2-3b).
test("federation shows cached numbers only for current-contract summaries", async () => {
  const f = await fixture();
  const c = await connect(f.root);
  try {
    await config(f, {
      current: { path: "current" },
      older: { path: "older" },
      legacy: { path: "legacy" },
      offline: { path: "offline" },
    });
    const { countingContract: _, ...contractOne } = summary;
    await f.put("federation-cache.json", {
      lastScanTimestamp: new Date().toISOString(),
      nodes: {
        current: { ...summary, deliveredTickets: 5, withdrawnTickets: 1 },
        older: contractOne,
        legacy: {
          reachable: true,
          legacy: true,
          legacyReason: "rescan failed",
          lastHandoverDate: null,
          lastHandoverTitle: null,
        },
        offline: { reachable: false, unreachableReason: "Offline" },
      },
    });
    const r: any = await c.client.callTool({
      name: "storybloq_federation",
      arguments: {},
    });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    const node = (name: string) =>
      r._meta.federation.nodes.find((n: any) => n.name === name);
    assert.equal(node("current").cacheState, "fresh");
    assert.equal(node("current").cache.completeTickets, 6);
    assert.equal(node("current").cache.ticketCount, 10);
    for (const name of ["older", "legacy"]) {
      assert.equal(node(name).cacheState, "legacy", name);
      assert.equal(node(name).cache, null, name);
    }
    assert.equal(node("offline").cacheState, "unreachable");
    assert.equal(node("offline").cache, null);
  } finally {
    await c.close();
    await f.cleanup();
  }
});
test("node preview lists only the counted population", () => {
  const dup = "t-00000000000000bb";
  const state = makeState({
    tickets: [
      makeTicket({ id: "T-001", status: "open" }),
      makeTicket({ id: dup, status: "inprogress" }),
      makeTicket({ id: dup, status: "open" }),
    ],
  });
  assert.deepEqual(
    nodePreviewTickets(state).map((t) => t.id),
    ["T-001"],
  );
});
