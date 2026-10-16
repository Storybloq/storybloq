// Local diagnostic only: synthetic records, no host-latency or wall-clock test gate.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { JSDOM } from "jsdom";
import { fixture, ticket, issue } from "./fixture.js";
import { readBoard } from "../src/board.js";
import { overviewPage, initialQuery } from "../src/overview.js";
import { createNotes } from "../src/notes.js";
import { captureRoots } from "../src/federation.js";
import { mountWorkspace } from "../src/workspace-view.js";

const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function measure(read: () => Promise<unknown>) {
  await read();
  const samplesMs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    await read();
    samplesMs.push(performance.now() - start);
  }
  return { samplesMs, medianMs: median(samplesMs) };
}
const sizes = (value: string | Buffer) => ({
  bytes: Buffer.byteLength(value),
  gzip: gzipSync(value).length,
  brotli: brotliCompressSync(value).length,
});
const f = await fixture();
let dom: JSDOM | undefined, view: ReturnType<typeof mountWorkspace> | undefined;
try {
  await mkdir(join(f.root, ".story", "notes"));
  for (let i = 1; i <= 1000; i++) {
    const id = "T-" + String(i).padStart(3, "0");
    await f.put(
      `tickets/${id}.json`,
      ticket(id, {
        title: "Synthetic work " + i,
        status: i % 3 === 0 ? "complete" : i % 3 === 1 ? "inprogress" : "open",
      }),
    );
  }
  for (let i = 1; i <= 400; i++) {
    const id = "ISS-" + String(i).padStart(3, "0");
    await f.put(`issues/${id}.json`, issue(id));
  }
  for (let i = 1; i <= 200; i++) {
    const id = "N-" + String(i).padStart(3, "0");
    await f.put(`notes/${id}.json`, {
      id,
      title: "Continuity " + i,
      content: "Synthetic performance record. ".repeat(40),
      tags: ["performance"],
      status: "active",
      createdDate: "2026-10-02",
      updatedDate: "2026-10-02",
    });
  }
  const notes = createNotes(f.root, captureRoots(f.root, []));
  const query = {
    status: "active" as const,
    query: "continuity",
    offset: 0,
    limit: 24,
  };
  const boardRead = await measure(() => readBoard(f.root));
  const notesList = await measure(() => notes.list(query));
  const overview = overviewPage(
    (await readBoard(f.root)).overview,
    initialQuery,
  );
  const page = await notes.list(query);
  const html = await readFile("dist/board.html", "utf8");
  const packaged = new JSDOM(html);
  const browserModule = packaged.window.document.querySelector(
    'script[type="module"]',
  )?.textContent;
  if (!browserModule)
    throw new Error("Build the production resource before profiling.");
  const payload = { html: sizes(html), javascript: sizes(browserModule) };
  packaged.window.close();
  dom = new JSDOM(await readFile("src/app.html", "utf8"));
  const calls: Record<string, unknown>[] = [];
  view = mountWorkspace(dom.window.document, async (name, args) => {
    if (name === "storybloq_notes") {
      calls.push({ ...args });
      return { _meta: { notes: { ...page, offset: args.offset } } };
    }
    return { _meta: { overview } };
  });
  const renders: number[] = [];
  for (let i = 0; i < 25; i++) {
    const start = performance.now();
    view.receive({ _meta: { overview } });
    renders.push(performance.now() - start);
  }
  const boardDom = {
    medianMs: median(renders),
    visibleCards: dom.window.document.querySelectorAll(".item").length,
  };
  dom.window.document.getElementById("nav-notes")!.click();
  await pause(0);
  calls.length = 0;
  const input = dom.window.document.getElementById(
    "notes-search",
  ) as HTMLInputElement;
  for (const character of "continuity") {
    input.value += character;
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await pause(35);
  }
  await pause(300);
  console.log(
    JSON.stringify(
      {
        environment: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
        },
        limits:
          "Synthetic local ledger reads and JSDOM controller timings. Search counts use immediate transport; real slow requests may already coalesce. Compressed sizes are estimates, not observed host transfers. No browser layout, Core Web Vitals or ChatGPT host timing.",
        dataset: { tickets: 1000, issues: 400, notes: 200 },
        payload,
        readBoard: boardRead,
        notesList,
        boardDom,
        searchBurst: {
          characters: 10,
          intervalMs: 35,
          requests: calls.length,
          queries: calls.map((c) => c.query),
        },
      },
      null,
      2,
    ),
  );
} finally {
  view?.dispose();
  dom?.window.close();
  await f.cleanup();
}
