import {
  createServer as httpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";
import type { LocalCliRuntime } from "./local-runtime.js";

export interface BrowserViewer {
  url: string;
  close(): Promise<void>;
}
/** A process owns one viewer. Closing is terminal even while startup is pending. */
export function lazyViewer(start: () => Promise<BrowserViewer>) {
  let closing = false,
    pending: Promise<BrowserViewer> | undefined,
    cleanup: Promise<void> | undefined;
  const get = () => {
    if (closing)
      return Promise.reject(new Error("Storybloq viewer is closed."));
    if (!pending) {
      pending = start()
        .then(async (viewer) => {
          if (closing) {
            await viewer.close();
            throw new Error("Storybloq viewer is closed.");
          }
          return viewer;
        })
        .catch((error) => {
          if (!closing) pending = undefined;
          throw error;
        });
    }
    return pending;
  };
  return {
    open: async () => {
      const viewer = await get();
      if (closing) throw new Error("Storybloq viewer is closed.");
      return viewer.url;
    },
    close: () => {
      closing = true;
      return (cleanup ??= (async () => {
        const viewer = await pending?.catch(() => undefined);
        if (viewer) await viewer.close();
      })());
    },
  };
}
const failure =
  "The local board request could not be confirmed. Reload before retrying a change.";
const maxBody = 512 * 1024;
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) throw new RangeError("body");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function record(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function keys(v: Record<string, unknown>, expected: string[]) {
  return (
    Object.keys(v).length === expected.length &&
    expected.every((k) => Object.hasOwn(v, k))
  );
}
const writeTools = new Set([
  "storybloq_item_save",
  "storybloq_ticket_reopen",
  "storybloq_note_save",
]);
export function requestHandler(
  client: Pick<Client, "callTool">,
  allowed: Set<string>,
  capability: string,
  html: string,
  hostHtml: string,
  origin: () => string,
  isClosed: () => boolean,
  maxWrites = 10000,
) {
  let active = 0;
  const consumed = new Set<string>();
  const respond = (res: ServerResponse, status: number, value: unknown) => {
    if (!res.destroyed) {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(value));
    }
  };
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    if (req.headers.host !== origin().slice("http://".length)) {
      respond(res, 403, { error: failure });
      req.resume();
      return;
    }
    if (
      req.method === "GET" &&
      /^\/(?:\?theme=(?:light|dark))?$/.test(req.url ?? "")
    ) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(hostHtml);
      return;
    }
    if (req.method !== "POST" || req.url !== "/api") {
      respond(res, 404, { error: failure });
      req.resume();
      return;
    }
    const supplied = req.headers["x-storybloq-capability"];
    const valid =
      typeof supplied === "string" &&
      /^[a-f0-9]{64}$/.test(supplied) &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(capability));
    if (
      !valid ||
      req.headers.origin !== origin() ||
      req.headers["content-type"] !== "application/json"
    ) {
      respond(res, 403, { error: failure });
      req.resume();
      return;
    }
    if (isClosed() || active >= 8) {
      respond(res, 503, { error: failure });
      req.resume();
      return;
    }
    active++;
    try {
      const input = await body(req);
      if (!record(input)) {
        respond(res, 400, { error: failure });
        return;
      }
      if (input.operation === "open" && keys(input, ["operation"])) {
        const result = await client.callTool({
          name: "storybloq_board",
          arguments: {},
        });
        respond(res, 200, { html, result });
      } else if (
        input.operation === "call" &&
        keys(input, ["operation", "name", "arguments"]) &&
        typeof input.name === "string" &&
        allowed.has(input.name) &&
        record(input.arguments)
      ) {
        if (writeTools.has(input.name)) {
          const nonce = req.headers["x-storybloq-request"];
          if (typeof nonce !== "string" || !/^[a-f0-9]{32}$/.test(nonce)) {
            respond(res, 403, { error: failure });
            return;
          }
          if (consumed.has(nonce)) {
            respond(res, 409, { error: failure });
            return;
          }
          if (consumed.size >= maxWrites) {
            respond(res, 503, { error: failure, code: "viewer_capacity" });
            return;
          }
          // Consume synchronously before the canonical call, retaining it after every outcome.
          consumed.add(nonce);
        }
        respond(
          res,
          200,
          await client.callTool({
            name: input.name,
            arguments: input.arguments,
          }),
        );
      } else respond(res, 400, { error: failure });
    } catch (error) {
      respond(
        res,
        error instanceof RangeError
          ? 413
          : error instanceof SyntaxError
            ? 400
            : 503,
        { error: failure },
      );
    } finally {
      active--;
    }
  };
}
export async function createBrowserViewer(
  root: string,
  html: string,
  hostHtml: string,
  localCli?: LocalCliRuntime,
): Promise<BrowserViewer> {
  const server = createServer(root, html, { localCli });
  const client = new Client({ name: "Storybloq local browser", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  let listener: ReturnType<typeof httpServer> | undefined;
  let closed = false,
    closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      closed = true;
      if (listener?.listening) {
        const done = new Promise<void>((resolve) =>
          listener!.close(() => resolve()),
        );
        listener.closeAllConnections();
        await done;
      }
      await client.close();
      await server.close();
    })());
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const allowed = new Set(
      (await client.listTools()).tools.map((t) => t.name),
    );
    const capability = randomBytes(32).toString("hex");
    let origin = "";
    listener = httpServer(
      requestHandler(
        client,
        allowed,
        capability,
        html,
        hostHtml,
        () => origin,
        () => closed,
      ),
    );
    listener.requestTimeout = 15_000;
    listener.headersTimeout = 10_000;
    listener.maxConnections = 16;
    await new Promise<void>((resolve, reject) => {
      listener!.once("error", reject);
      listener!.listen(0, "127.0.0.1", () => {
        listener!.off("error", reject);
        resolve();
      });
    });
    const address = listener.address();
    if (!address || typeof address === "string") throw Error("listen");
    origin = `http://127.0.0.1:${address.port}`;
    listener.unref();
    return { url: origin + "/#" + capability, close };
  } catch (error) {
    await close();
    throw error;
  }
}
