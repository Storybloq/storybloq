import { localBrowserPost } from "../src/local-browser-transport.js";
import { randomBytes } from "node:crypto";
import { createServer as httpServer, request } from "node:http";
import { JSDOM } from "jsdom";
import { mountWorkspace } from "../src/workspace-view.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createBrowserViewer, lazyViewer, requestHandler } from "../src/local-browser.js";
import { fixture, ticket } from "./fixture.js";

async function session() {
  const f = await fixture();
  const viewer = await createBrowserViewer(
    f.root,
    "<h1>Real board</h1>",
    "<h1>Host</h1>",
  );
  const u = new URL(viewer.url);
  const origin = u.origin;
  const headers = {
    origin,
    "content-type": "application/json",
    "x-storybloq-capability": u.hash.slice(1),
  };
  const post = (body: unknown, extra = {}) =>
    fetch(origin + "/api", {
      method: "POST",
      headers: {
        ...headers,
        "x-storybloq-request": randomBytes(16).toString("hex"),
        ...extra,
      },
      body: JSON.stringify(body),
    });
  const call = async (name: string, args = {}) => {
    const r = await post({ operation: "call", name, arguments: args });
    assert.equal(r.status, 200);
    return r.json() as Promise<any>;
  };
  return {
    ...f,
    viewer,
    origin,
    headers,
    post,
    call,
    close: async () => {
      await viewer.close();
      await f.cleanup();
    },
  };
}
test("protected loopback viewer denies foreign capability, origin, host and oversized requests without writes", async () => {
  const s = await session();
  try {
    const path = join(s.root, ".story/tickets/T-001.json"),
      before = await readFile(path);
    const body = {
      operation: "call",
      name: "storybloq_item_save",
      arguments: {},
    };
    for (const bad of [
      { "x-storybloq-capability": "bad" },
      { "x-storybloq-capability": "f".repeat(64) },
      { origin: "https://evil.example" },
      { "content-type": "text/plain" },
    ])
      assert.equal((await s.post(body, bad)).status, 403);
    // Identical requests with a valid fresh nonce each, differing only in Host.
    const withHost = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          s.origin + "/api",
          {
            method: "POST",
            headers: {
              ...s.headers,
              "x-storybloq-request": randomBytes(16).toString("hex"),
              host,
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify({ operation: "open" }));
      });
    assert.equal(await withHost(new URL(s.origin).host), 200);
    assert.equal(await withHost("evil.example"), 403);
    assert.equal((await s.post({ operation: "other" })).status, 400);
    assert.equal(
      (
        await s.post({
          operation: "call",
          name: "storybloq_init",
          arguments: {},
        })
      ).status,
      400,
    );
    assert.equal(
      (await s.post({ operation: "open", extra: true })).status,
      400,
    );
    assert.equal(
      (
        await s.post({
          operation: "call",
          name: "storybloq_board",
          arguments: {},
          padding: "a".repeat(524288),
        })
      ).status,
      413,
    );
    const publicPage = await fetch(s.origin);
    assert.equal(publicPage.status, 200);
    assert.equal((await fetch(s.origin + "/?theme=dark")).status, 200);
    assert.ok(!(await publicPage.text()).includes(s.root));
    const open = (await (await s.post({ operation: "open" })).json()) as any;
    assert.equal(open.html, "<h1>Real board</h1>");
    assert.equal(open.result.structuredContent.project, "Demo project");
    assert.deepEqual(await readFile(path), before);
  } finally {
    await s.close();
  }
});
test("simultaneous viewer lifetimes keep canonical saves and stale protection bound to their projects", async () => {
  const a = await session(),
    b = await session();
  try {
    assert.notEqual(a.origin, b.origin);
    assert.equal(
      (
        await b.post(
          { operation: "call", name: "storybloq_board", arguments: {} },
          { "x-storybloq-capability": a.viewer.url.split("#")[1] },
        )
      ).status,
      403,
    );
    assert.notEqual(a.viewer.url.split("#")[1], b.viewer.url.split("#")[1]);
    const path = join(b.root, ".story/tickets/T-001.json"),
      before = await readFile(path);
    const e = (
      await a.call("storybloq_item_editor", { kind: "tickets", id: "T-001" })
    )._meta.editor;
    const save = await a.call("storybloq_item_save", {
      kind: "tickets",
      id: e.id,
      revision: e.revision,
      patch: { title: "Only project A" },
    });
    assert.equal(save.isError, undefined);
    assert.deepEqual(await readFile(path), before);
    assert.equal(
      JSON.parse(
        await readFile(join(a.root, ".story/tickets/T-001.json"), "utf8"),
      ).title,
      "Only project A",
    );
    await a.put(
      "tickets/T-001.json",
      ticket("T-001", { title: "External edit" }),
    );
    const stale = await a.call("storybloq_item_save", {
      kind: "tickets",
      id: e.id,
      revision: e.revision,
      patch: { title: "Must refuse" },
    });
    assert.equal(stale.isError, true);
    assert.equal(
      JSON.parse(
        await readFile(join(a.root, ".story/tickets/T-001.json"), "utf8"),
      ).title,
      "External edit",
    );
    assert.equal(
      (await b.call("storybloq_board")).structuredContent.project,
      "Demo project",
    );
  } finally {
    await a.close();
    await b.close();
  }
});
test("lazy startup coalesces and shutdown disposes a late listener without publishing a URL", async () => {
  let finish!: (v: any) => void,
    starts = 0,
    closes = 0;
  const lazy = lazyViewer(async () => {
    starts++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const first = lazy.open(),
    second = lazy.open();
  await Promise.resolve();
  assert.equal(starts, 1);
  const closing = lazy.close();
  finish({
    url: "http://127.0.0.1:1/#secret",
    close: async () => {
      closes++;
    },
  });
  await assert.rejects(first, /closed/i);
  await assert.rejects(second, /closed/i);
  await closing;
  assert.equal(closes, 1);
  await assert.rejects(lazy.open(), /closed/i);
  assert.equal(starts, 1);
});
test("failed lazy startup can retry while open and close is idempotent", async () => {
  let starts = 0,
    closes = 0;
  const lazy = lazyViewer(async () => {
    if (++starts === 1) throw Error("bind");
    return {
      url: "local",
      close: async () => {
        closes++;
      },
    };
  });
  await assert.rejects(lazy.open());
  assert.equal(await lazy.open(), "local");
  assert.equal(await lazy.open(), "local");
  await Promise.all([lazy.close(), lazy.close()]);
  assert.equal(closes, 1);
});

test("canonical commit followed by lost response preserves draft without replay until explicit reload", async () => {
  const s = await session();
  const dom = new JSDOM(await readFile("src/app.html", "utf8")),
    d = dom.window.document;
  let saves = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    if (name !== "storybloq_item_save") return s.call(name, args);
    saves++;
    // Destroy the HTTP client after the real server commits but before its result is consumed.
    return new Promise<any>((resolve, reject) => {
      const req = request(
        s.origin + "/api",
        {
          method: "POST",
          headers: {
            ...s.headers,
            "x-storybloq-request": randomBytes(16).toString("hex"),
          },
        },
        (res) => {
          res.destroy();
          reject(Error("Response lost after commit"));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ operation: "call", name, arguments: args }));
    });
  };
  const view = mountWorkspace(d, call);
  const wait = async (predicate: () => boolean) => {
    for (let n = 0; n < 200 && !predicate(); n++)
      await new Promise((r) => setTimeout(r, 5));
    assert.ok(predicate());
  };
  try {
    view.receive(await s.call("storybloq_board"));
    d.querySelector<HTMLButtonElement>(".item")!.click();
    await wait(() => {
      const b = d.getElementById("edit-item") as HTMLButtonElement;
      return !!b && !b.hidden && !b.disabled;
    });
    (d.getElementById("edit-item") as HTMLButtonElement).click();
    await wait(() => !!d.getElementById("edit-title"));
    const title = d.getElementById("edit-title") as HTMLInputElement;
    title.value = "Committed despite lost response";
    title.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    (d.getElementById("save-item") as HTMLButtonElement).click();
    await wait(() => /could not be confirmed/i.test(d.body.textContent!));
    assert.equal(saves, 1);
    assert.equal(title.value, "Committed despite lost response");
    assert.match(d.body.textContent!, /draft is preserved.*reload/i);
    assert.equal(
      JSON.parse(
        await readFile(join(s.root, ".story/tickets/T-001.json"), "utf8"),
      ).title,
      title.value,
    );
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(saves, 1);
    // Explicit fresh read reconciles the committed data; never silently resubmit.
    const fresh = (
      await s.call("storybloq_item_editor", { kind: "tickets", id: "T-001" })
    )._meta.editor;
    assert.equal(fresh.fields.title, title.value);
    assert.equal(saves, 1);
  } finally {
    view.dispose();
    dom.window.close();
    await s.close();
  }
});

test("ready-viewer open cannot return a URL after the shutdown fence", async () => {
  let closes = 0;
  const lazy = lazyViewer(async () => ({
    url: "ready",
    close: async () => {
      closes++;
    },
  }));
  assert.equal(await lazy.open(), "ready");
  const opening = lazy.open(),
    closing = lazy.close();
  await assert.rejects(opening, /closed/i);
  await closing;
  assert.equal(closes, 1);
});

test("write transport consumes a nonce before dispatch and refuses concurrent or changed-payload duplicates", async () => {
  const s = await session();
  try {
    const e = (
      await s.call("storybloq_item_editor", { kind: "tickets", id: "T-001" })
    )._meta.editor;
    const body = {
      operation: "call",
      name: "storybloq_item_save",
      arguments: {
        kind: "tickets",
        id: e.id,
        revision: e.revision,
        patch: { title: "Exactly one transport write" },
      },
    };
    const nonce = { "x-storybloq-request": "a".repeat(32) };
    const both = await Promise.all([s.post(body, nonce), s.post(body, nonce)]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
    assert.equal(
      (
        await s.post(
          { ...body, name: "storybloq_note_save", arguments: {} },
          nonce,
        )
      ).status,
      409,
    );
    assert.equal(
      (await s.post(body, { "x-storybloq-request": "" })).status,
      403,
    );
    assert.equal(
      JSON.parse(
        await readFile(join(s.root, ".story/tickets/T-001.json"), "utf8"),
      ).title,
      "Exactly one transport write",
    );
  } finally {
    await s.close();
  }
});

test("production host transport does not replay a write after its committed response is lost", async () => {
  const s = await session();
  let attempts = 0,
    explicitSends = 0;
  const proxy = httpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const upstream = await fetch(s.origin + "/api", {
      method: "POST",
      headers: {
        ...s.headers,
        "x-storybloq-request": String(req.headers["x-storybloq-request"]),
      },
      body: Buffer.concat(chunks),
    });
    await upstream.arrayBuffer();
    attempts++;
    res.destroy();
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  const send: typeof fetch = async (_path, init) => {
    explicitSends++;
    return fetch(`http://127.0.0.1:${address.port}/api`, init);
  };
  try {
    const e = (
      await s.call("storybloq_item_editor", { kind: "tickets", id: "T-001" })
    )._meta.editor;
    await assert.rejects(
      localBrowserPost(
        s.viewer.url.split("#")[1],
        {
          operation: "call",
          name: "storybloq_item_save",
          arguments: {
            kind: "tickets",
            id: e.id,
            revision: e.revision,
            patch: { title: "Production transport committed" },
          },
        },
        send,
      ),
    );
    assert.equal(explicitSends, 1);
    assert.equal(attempts, 1);
    assert.equal(
      JSON.parse(
        await readFile(join(s.root, ".story/tickets/T-001.json"), "utf8"),
      ).title,
      "Production transport committed",
    );
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await s.close();
  }
});

test("write admission never evicts consumed nonces, including failed dispatches, at capacity", async () => {
  let calls = 0,
    origin = "";
  const cap = "b".repeat(64);
  const fake = {
    callTool: async () => {
      calls++;
      if (calls === 2) throw Error("canonical failure");
      return { isError: true, content: [] };
    },
  } as any;
  const server = httpServer(
    requestHandler(
      fake,
      new Set(["storybloq_item_save"]),
      cap,
      "board",
      "host",
      () => origin,
      () => false,
      2,
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  const post = (nonce: string) =>
    fetch(origin + "/api", {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "x-storybloq-capability": cap,
        "x-storybloq-request": nonce,
      },
      body: JSON.stringify({
        operation: "call",
        name: "storybloq_item_save",
        arguments: {},
      }),
    });
  try {
    assert.equal((await post("1".repeat(32))).status, 200);
    assert.equal(calls, 1);
    assert.equal((await post("1".repeat(32))).status, 409);
    assert.equal(calls, 1);
    assert.equal((await post("2".repeat(32))).status, 503);
    assert.equal(calls, 2);
    assert.equal((await post("2".repeat(32))).status, 409);
    assert.equal(calls, 2);
    const capacity = await post("3".repeat(32));
    assert.equal(capacity.status, 503);
    assert.equal(((await capacity.json()) as any).code, "viewer_capacity");
    assert.equal((await post("1".repeat(32))).status, 409);
    assert.equal(calls, 2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("production capacity guidance reaches ticket and note editors while preserving drafts", async () => {
  for (const kind of ["tickets", "notes"]) {
    const s = await session();
    await mkdir(join(s.root, ".story/notes"));
    await s.put("notes/N-001.json", {
      id: "N-001",
      title: "Note",
      content: "Decision",
      tags: [],
      status: "active",
      createdDate: "2026-10-02",
      updatedDate: "2026-10-02",
    });
    const dom = new JSDOM(await readFile("src/app.html", "utf8")),
      d = dom.window.document;
    const capacityFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ error: "safe", code: "viewer_capacity" }), {
        status: 503,
      });
    const view = mountWorkspace(d, (name, args) =>
      name.endsWith("_save")
        ? localBrowserPost(
            "a".repeat(64),
            { operation: "call", name, arguments: args },
            capacityFetch,
          )
        : s.call(name, args),
    );
    const wait = async (predicate: () => boolean) => {
      for (let n = 0; n < 200 && !predicate(); n++)
        await new Promise((r) => setTimeout(r, 5));
      assert.ok(predicate(), d.body.textContent?.slice(-800));
    };
    try {
      view.receive(await s.call("storybloq_board"));
      if (kind === "tickets") {
          // Match the actual ticket card rather than a seeded issue card.
        const cards = Array.from(
          d.querySelectorAll<HTMLButtonElement>(".item"),
        );
        cards.find((b) => b.textContent?.includes("T-001"))!.click();
        await wait(() => {
          const b = d.getElementById("edit-item") as HTMLButtonElement;
          return !!b && !b.hidden && !b.disabled;
        });
        (d.getElementById("edit-item") as HTMLButtonElement).click();
      } else {
        (d.getElementById("nav-notes") as HTMLButtonElement).click();
        await wait(() => !!d.querySelector('[data-note-id="N-001"]'));
        (
          d.querySelector('[data-note-id="N-001"]') as HTMLButtonElement
        ).click();
        await wait(() => {
          const b = d.getElementById("edit-note") as HTMLButtonElement;
          return !!b && !b.hidden && !b.disabled;
        });
        (d.getElementById("edit-note") as HTMLButtonElement).click();
      }
      const titleId = kind === "tickets" ? "edit-title" : "note-title";
      await wait(() => !!d.getElementById(titleId));
      const title = d.getElementById(titleId) as HTMLInputElement;
      title.value = "Capacity draft";
      title.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      (
        d.getElementById(
          kind === "tickets" ? "save-item" : "save-note",
        ) as HTMLButtonElement
      ).click();
      await wait(() =>
        /Restart this task's Storybloq connection/.test(d.body.textContent!),
      );
      assert.equal(title.value, "Capacity draft");
      assert.match(d.body.textContent!, /Reloading this page will not reset/);
    } finally {
      view.dispose();
      dom.window.close();
      await s.close();
    }
  }
});
