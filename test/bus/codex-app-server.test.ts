/**
 * T-489 transport and framing tests.
 *
 * These drive the REAL client against a fake WebSocket server over a Unix socket.
 * The framing layer is deliberately NOT mocked: the encoder/decoder pair is the
 * component whose failure mode is silent (see the codex-app-server docblock), so
 * mocking it would leave the only thing worth testing unexercised.
 */

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexAppServerError,
  connectCodexAppServer,
  decodeFrame,
  encodeFrame,
  closeCodeAllowed,
  expectedAccept,
  serverFrameViolation,
  type CodexAppServerClient,
} from "../../src/bus/codex-app-server.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;

interface FakeServer {
  readonly socketPath: string;
  /** Every complete frame the server received from the client. */
  readonly received: { opcode: number; payload: Buffer }[];
  /** Raw bytes as they arrived, for masking assertions. */
  readonly rawReceived: Buffer[];
  /**
   * How many upgraded sockets the CLIENT has closed its side of.
   *
   * `end` and not `close`: an HTTP upgrade socket is half-open on the server, so
   * the server's `close` does not fire until the SERVER also ends. `end` is the
   * FIN from the client, which is exactly the signal that the client tore down.
   */
  peerClosedSides(): number;
  stop(): Promise<void>;
}

type UpgradeMode =
  | "normal"
  | "wrong-accept"
  | "no-upgrade"
  // Headers sent, body promised and never finished: the case that keeps a socket
  // alive if the client merely drains the response instead of destroying it.
  | "no-upgrade-unfinished"
  | "bad-status";

interface FakeServerOptions {
  readonly mode?: UpgradeMode;
  /**
   * Called for each TEXT frame the client sends. Return raw bytes to write back,
   * or undefined to stay silent. Receives the parsed message and the socket so a
   * case can write arbitrary frames.
   */
  onMessage?(message: Record<string, unknown>, socket: Socket): Buffer | undefined | void;
  /**
   * When set, the initialize RESPONSE is written in the SAME socket write as the
   * 101 handshake, so Node hands it to the client as the upgrade `head`, and the
   * normal initialize reply is SUPPRESSED. Both halves matter: a separate write
   * arrives as ordinary `data`, and a duplicate reply would let a client that
   * ignores `head` pass anyway.
   */
  readonly answerInitializeInHead?: boolean;
  /** Answer `initialize` with an rpc error, to exercise handshake teardown. */
  readonly failInitialize?: boolean;
}

const dirs: string[] = [];
const servers: FakeServer[] = [];
const clients: CodexAppServerClient[] = [];

async function startFakeServer(options: FakeServerOptions = {}): Promise<FakeServer> {
  const dir = await mkdtemp(join(tmpdir(), "t489-ws-"));
  dirs.push(dir);
  const socketPath = join(dir, "app-server-control.sock");
  const received: { opcode: number; payload: Buffer }[] = [];
  const rawReceived: Buffer[] = [];
  const mode = options.mode ?? "normal";
  // An UPGRADED socket is detached from the server's connection tracking, so
  // neither closeAllConnections() nor close() will wait for it or end it. Holding
  // them here is what makes teardown terminate.
  const live: Socket[] = [];
  let closed = 0;

  const server = http.createServer((_req, res) => {
    // A plain (non-upgrading) response: the client must treat this as a handshake
    // failure rather than waiting forever for an upgrade that will not come.
    res.statusCode = 200;
    res.end("not a websocket");
  });

  server.on("upgrade", (req, socket: Socket, head: Buffer) => {
    live.push(socket);
    socket.on("end", () => {
      closed++;
    });
    if (mode === "no-upgrade") {
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (mode === "no-upgrade-unfinished") {
      // Promises 1024 bytes and sends none. A client that calls res.resume() waits
      // forever for a body that never comes.
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 1024\r\n\r\n");
      return;
    }
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept =
      mode === "wrong-accept"
        ? createHash("sha1").update("not-the-key" + WS_GUID).digest("base64")
        : createHash("sha1").update(key + WS_GUID).digest("base64");
    const status = mode === "bad-status" ? "HTTP/1.1 200 OK" : "HTTP/1.1 101 Switching Protocols";
    const handshake = Buffer.from(
      `${status}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    if (options.answerInitializeInHead === true && mode === "normal") {
      // ONE write: handshake bytes plus the id-1 initialize response. Node's HTTP
      // client parser hands everything past the headers to `upgrade` as `head`.
      socket.write(
        Buffer.concat([
          handshake,
          encodeServerText(JSON.stringify({ id: 1, result: { userAgent: "from-head" } })),
        ]),
      );
    } else {
      socket.write(handshake);
    }
    if (mode !== "normal") return;

    let buf = Buffer.from(head ?? []);
    socket.on("error", () => {
      /* client teardown races are expected in these tests */
    });
    socket.on("data", (chunk: Buffer) => {
      rawReceived.push(Buffer.from(chunk));
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const step = decodeFrame(buf);
        if (!step) return;
        buf = step.rest;
        received.push({ opcode: step.frame.opcode, payload: step.frame.payload });
        if (step.frame.opcode !== OP_TEXT) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(step.frame.payload.toString("utf8")) as Record<string, unknown>;
        } catch {
          continue;
        }
        // Answer initialize so the client can finish connecting, UNLESS this case
        // is proving the head buffer is honoured (then head carries the only reply).
        if (parsed["method"] === "initialize") {
          if (options.answerInitializeInHead === true) continue;
          if (options.failInitialize === true) {
            socket.write(
              encodeServerText(
                JSON.stringify({ id: parsed["id"], error: { code: -32000, message: "nope" } }),
              ),
            );
            continue;
          }
          socket.write(
            encodeServerText(JSON.stringify({ id: parsed["id"], result: { userAgent: "fake" } })),
          );
          continue;
        }
        const reply = options.onMessage?.(parsed, socket);
        if (reply) socket.write(reply);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const handle: FakeServer = {
    socketPath,
    received,
    rawReceived,
    peerClosedSides: () => closed,
    stop: async () => {
      // Upgraded sockets first (they are detached, see `live`), then any plain
      // connection, then the listener. server.close() only fires its callback once
      // everything has ended, so skipping either step deadlocks teardown.
      for (const s of live.splice(0)) s.destroy();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  servers.push(handle);
  return handle;
}

/** A masked SERVER frame, which RFC 6455 5.1 forbids. */
function encodeMaskedServerFrame(opcode: number, payload: Buffer): Buffer {
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, masked]);
}

/** Server frames are UNMASKED (RFC 6455 5.1). */
function encodeServerFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const n = payload.length;
  let head: Buffer;
  if (n < 126) {
    head = Buffer.from([(fin ? 0x80 : 0x00) | opcode, n]);
  } else if (n < 65536) {
    head = Buffer.alloc(4);
    head[0] = (fin ? 0x80 : 0x00) | opcode;
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = (fin ? 0x80 : 0x00) | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

function encodeServerText(text: string): Buffer {
  return encodeServerFrame(OP_TEXT, Buffer.from(text, "utf8"));
}

/**
 * Wait for a condition the PEER observes.
 *
 * The client rejects a pending request the moment it decodes a close frame, which
 * happens before the server has read the client's close REPLY off the wire.
 * Asserting on the server's view immediately after the rejection would be testing
 * a synchrony that does not exist.
 */
async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition not observed within ${String(ms)}ms`);
}

async function connect(server: FakeServer, deadlineMs = 4000): Promise<CodexAppServerClient> {
  const client = await connectCodexAppServer({
    socketPath: server.socketPath,
    clientVersion: "9.9.9",
    deadlineMs,
  });
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("T-489 codex app-server transport: handshake", () => {
  it("completes the upgrade and sends initialize first, naming storybloq and our version", async () => {
    const server = await startFakeServer();
    await connect(server);

    const texts = server.received.filter((f) => f.opcode === OP_TEXT);
    expect(texts.length).toBeGreaterThanOrEqual(1);
    // Asserted on the BYTES the server received, not on an intermediate builder.
    const first = JSON.parse(texts[0]!.payload.toString("utf8")) as Record<string, unknown>;
    expect(first["method"]).toBe("initialize");
    const params = first["params"] as Record<string, unknown>;
    const clientInfo = params["clientInfo"] as Record<string, unknown>;
    expect(clientInfo["name"]).toBe("storybloq");
    expect(clientInfo["version"]).toBe("9.9.9");
    expect(first).not.toHaveProperty("jsonrpc");
  });

  it("rejects a Sec-WebSocket-Accept that does not verify against the GUID", async () => {
    const server = await startFakeServer({ mode: "wrong-accept" });
    await expect(connect(server)).rejects.toMatchObject({ reason: "handshake" });
  });

  it("rejects a non-101 upgrade status", async () => {
    const server = await startFakeServer({ mode: "bad-status" });
    await expect(connect(server)).rejects.toMatchObject({ reason: "handshake" });
  });

  it("rejects a server that answers without upgrading", async () => {
    const server = await startFakeServer({ mode: "no-upgrade" });
    await expect(connect(server)).rejects.toMatchObject({ reason: "handshake" });
  });

  it("DESTROYS the socket when initialize is rejected", async () => {
    // Codex review: the caller never receives a client on this path, so it can
    // never call close(). An un-destroyed socket would stay open for the life of
    // the process with its deadline already cleared.
    const server = await startFakeServer({ failInitialize: true });
    await expect(connect(server)).rejects.toBeInstanceOf(CodexAppServerError);
    await waitFor(() => server.peerClosedSides() >= 1);
  });

  it("fails fast AND tears down when the server sends headers and never finishes the body", async () => {
    // Rejecting is not the property under test: the old draining version rejected
    // too. What the fix changes is whether the CONNECTION survives the rejection,
    // so assert the client actually closed its side. `res.resume()` alone leaves
    // the socket open waiting for a body that never arrives.
    const server = await startFakeServer({ mode: "no-upgrade-unfinished" });
    await expect(connect(server, 3000)).rejects.toMatchObject({ reason: "handshake" });
    await waitFor(() => server.peerClosedSides() >= 1);
  });

  it("reports a missing socket as socket-absent without crashing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "t489-missing-"));
    dirs.push(dir);
    await expect(
      connectCodexAppServer({
        socketPath: join(dir, "nope.sock"),
        clientVersion: "1.0.0",
        deadlineMs: 2000,
      }),
    ).rejects.toMatchObject({ reason: "socket-absent" });
  });

  it("does not drop a response delivered in the upgrade head buffer", async () => {
    // The initialize response is written in the SAME write as the 101, so it
    // arrives as `head`, and the server sends no other reply. A client that
    // ignores `head`, or that only parses inside its `data` handler, hangs here
    // until the deadline: no further byte ever arrives to trigger a parse.
    const server = await startFakeServer({ answerInitializeInHead: true });
    const client = await connect(server, 3000);
    expect(client).toBeDefined();
  });

  it("verifies the accept value the same way a conforming server computes it", () => {
    const key = randomBytes(16).toString("base64");
    expect(expectedAccept(key)).toBe(
      createHash("sha1").update(key + WS_GUID).digest("base64"),
    );
  });
});

describe("T-489 codex app-server transport: framing", () => {
  it("masks every client frame", async () => {
    const server = await startFakeServer();
    await connect(server);
    const all = Buffer.concat(server.rawReceived);
    // Second byte of the first frame carries the mask bit.
    expect(all.length).toBeGreaterThan(2);
    expect((all[1]! & 0x80) !== 0).toBe(true);
  });

  for (const size of [125, 126, 127, 65535, 65536]) {
    it(`round-trips a ${String(size)}-byte payload exactly`, async () => {
      // 125 is the last 7-bit length, 126/127 use the 16-bit extension, 65535 is
      // the last 16-bit length and 65536 forces the 64-bit extension. A
      // 7-bit-only encoder passes small fixtures and fails here.
      const server = await startFakeServer({
        onMessage: (msg) =>
          msg["method"] === "echo"
            ? encodeServerText(JSON.stringify({ id: msg["id"], result: { n: size } }))
            : undefined,
      });
      const client = await connect(server);
      const text = "x".repeat(size);
      const result = (await client.request("echo", { text })) as Record<string, unknown>;
      expect(result["n"]).toBe(size);

      const echoed = server.received
        .filter((f) => f.opcode === OP_TEXT)
        .map((f) => JSON.parse(f.payload.toString("utf8")) as Record<string, unknown>)
        .find((m) => m["method"] === "echo");
      expect(echoed).toBeDefined();
      expect((echoed!["params"] as Record<string, unknown>)["text"]).toBe(text);
    });
  }

  it("encodes the three length forms with the right headers", () => {
    expect(encodeFrame(OP_TEXT, Buffer.alloc(125))[1]! & 0x7f).toBe(125);
    expect(encodeFrame(OP_TEXT, Buffer.alloc(126))[1]! & 0x7f).toBe(126);
    expect(encodeFrame(OP_TEXT, Buffer.alloc(65536))[1]! & 0x7f).toBe(127);
  });

  it("parses a frame split across two writes and two frames in one write", async () => {
    const server = await startFakeServer({
      onMessage: (msg, socket) => {
        if (msg["method"] !== "split") return undefined;
        const a = encodeServerText(JSON.stringify({ id: msg["id"], result: { ok: "a" } }));
        // Deliver the response in two chunks, splitting mid-frame.
        socket.write(a.subarray(0, 3));
        setTimeout(() => socket.write(a.subarray(3)), 15);
        return undefined;
      },
    });
    const client = await connect(server);
    const split = (await client.request("split", {})) as Record<string, unknown>;
    expect(split["ok"]).toBe("a");

    // Two frames in ONE write: a notification and the response together.
    const server2 = await startFakeServer({
      onMessage: (msg) => {
        if (msg["method"] !== "both") return undefined;
        return Buffer.concat([
          encodeServerText(JSON.stringify({ method: "note/one", params: {}, emittedAtMs: 1 })),
          encodeServerText(JSON.stringify({ id: msg["id"], result: { ok: "b" } })),
        ]);
      },
    });
    const client2 = await connect(server2);
    const both = (await client2.request("both", {})) as Record<string, unknown>;
    expect(both["ok"]).toBe("b");
  });

  it("answers a ping with a pong carrying the payload, without disturbing correlation", async () => {
    const server = await startFakeServer({
      onMessage: (msg, socket) => {
        if (msg["method"] !== "pinged") return undefined;
        socket.write(encodeServerFrame(OP_PING, Buffer.from("ping-payload", "utf8")));
        setTimeout(
          () => socket.write(encodeServerText(JSON.stringify({ id: msg["id"], result: { ok: true } }))),
          15,
        );
        return undefined;
      },
    });
    const client = await connect(server);
    const result = (await client.request("pinged", {})) as Record<string, unknown>;
    expect(result["ok"]).toBe(true);

    const pong = server.received.find((f) => f.opcode === 0xa);
    expect(pong).toBeDefined();
    expect(pong!.payload.toString("utf8")).toBe("ping-payload");
  });

  it("replies to a close frame and stops, failing anything still pending", async () => {
    const server = await startFakeServer({
      onMessage: (msg, socket) => {
        if (msg["method"] !== "goodbye") return undefined;
        socket.write(encodeServerFrame(OP_CLOSE, Buffer.alloc(0)));
        return undefined;
      },
    });
    const client = await connect(server);
    await expect(client.request("goodbye", {})).rejects.toMatchObject({ reason: "closed" });
    // The reply is flushed with end(); a client that used write()+destroy() would
    // discard it and this never arrives.
    await waitFor(() => server.received.some((f) => f.opcode === OP_CLOSE));
  });

  it("rejects a binary frame as failed:frame rather than parsing it", async () => {
    const server = await startFakeServer({
      onMessage: (msg, socket) => {
        if (msg["method"] !== "bin") return undefined;
        // Valid JSON bytes, wrong opcode: a client that ignored the opcode would
        // resolve this happily, which is exactly the misparse being forbidden.
        socket.write(
          encodeServerFrame(OP_BINARY, Buffer.from(JSON.stringify({ id: msg["id"], result: { ok: 1 } }))),
        );
        return undefined;
      },
    });
    const client = await connect(server);
    await expect(client.request("bin", {})).rejects.toMatchObject({ reason: "frame" });
  });

  it("rejects a fragmented frame as failed:frame rather than concatenating it", async () => {
    const server = await startFakeServer({
      onMessage: (msg, socket) => {
        if (msg["method"] !== "frag") return undefined;
        // COMPLETE, VALID JSON with FIN=0. If the payload were truncated,
        // JSON.parse would reject it and the test would pass without the fin check
        // ever running. A client that ignores `fin` resolves this happily.
        const body = JSON.stringify({ id: msg["id"], result: { ok: 1 } });
        socket.write(encodeServerFrame(OP_TEXT, Buffer.from(body), false));
        return undefined;
      },
    });
    const client = await connect(server);
    await expect(client.request("frag", {})).rejects.toMatchObject({ reason: "frame" });
  });

  it("treats a close arriving before any response as failed:closed", async () => {
    const server = await startFakeServer({
      onMessage: (_msg, socket) => {
        socket.end();
        return undefined;
      },
    });
    const client = await connect(server);
    await expect(client.request("whatever", {})).rejects.toMatchObject({ reason: "closed" });
  });
});

describe("T-489 codex app-server transport: RFC 6455 server-frame validation", () => {
  // Codex review: unmasking a server frame is not the same as PERMITTING it, and
  // the decoder previously ignored RSV bits, non-minimal lengths and oversized
  // control frames. An oversized ping was the sharpest of these: echoing it back
  // as a pong would have emitted an invalid frame of our own.
  async function rejects(raw: (id: unknown) => Buffer): Promise<void> {
    const server = await startFakeServer({
      onMessage: (msg, socket) => {
        if (msg["method"] !== "probe") return undefined;
        socket.write(raw(msg["id"]));
        return undefined;
      },
    });
    const client = await connect(server);
    await expect(client.request("probe", {})).rejects.toMatchObject({ reason: "frame" });
  }

  it("rejects a MASKED server frame", async () => {
    await rejects((id) => encodeMaskedServerFrame(OP_TEXT, Buffer.from(JSON.stringify({ id, result: {} }))));
  });

  it("rejects a frame with RSV bits set", async () => {
    await rejects((id) => {
      const frame = encodeServerText(JSON.stringify({ id, result: {} }));
      frame[0] = frame[0]! | 0x40; // RSV1
      return frame;
    });
  });

  it("rejects a non-minimal 16-bit length encoding", async () => {
    await rejects((id) => {
      const body = Buffer.from(JSON.stringify({ id, result: {} }));
      const head = Buffer.alloc(4);
      head[0] = 0x80 | OP_TEXT;
      head[1] = 126;
      head.writeUInt16BE(body.length, 2); // < 126, so 126 is not minimal
      return Buffer.concat([head, body]);
    });
  });

  it("rejects an oversized control frame instead of echoing an invalid pong", async () => {
    await rejects(() => encodeServerFrame(OP_PING, Buffer.alloc(126, 0x61)));
  });

  it("rejects a fragmented control frame", async () => {
    await rejects(() => encodeServerFrame(OP_CLOSE, Buffer.alloc(0), false));
  });

  it("rejects an OVERSIZED declared length from the HEADER, before the payload exists", () => {
    // The point is the buffering, not the rejection: a peer that declares a
    // gigabyte and sends nothing must be refused on the 10 header bytes it did
    // send. Only the header is supplied here, so a decoder that waits for the
    // payload returns null and this fails.
    const head = Buffer.alloc(10);
    head[0] = 0x80 | OP_TEXT;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(64 * 1024 * 1024), 2);
    expect(() => decodeFrame(head)).toThrow(/exceeds/);
  });

  it("rejects an oversized length even when the frame is otherwise well formed", () => {
    const payload = Buffer.alloc(200, 0x61);
    expect(() => decodeFrame(encodeServerFrame(OP_TEXT, payload), { maxPayloadBytes: 100 })).toThrow(
      CodexAppServerError,
    );
    // Negative control: the same frame under a sufficient cap decodes.
    expect(decodeFrame(encodeServerFrame(OP_TEXT, payload), { maxPayloadBytes: 300 })).not.toBeNull();
  });

  it("applies the RSV rule from the HEADER, before the payload arrives", () => {
    // Same distinction as the size cap: header-decidable violations must not wait
    // on a body the peer may never send.
    const head = Buffer.alloc(4);
    head[0] = 0x80 | 0x40 | OP_TEXT; // RSV1
    head[1] = 126;
    head.writeUInt16BE(50_000, 2);
    expect(() => decodeFrame(head, { enforceServerRules: true })).toThrow(CodexAppServerError);
  });

  it("does NOT enforce server rules unless asked (the client masks its own frames)", () => {
    // encodeFrame masks, as a client must. Enforcing the no-mask rule by default
    // would make the codec reject the frames we ourselves emit.
    expect(decodeFrame(encodeFrame(OP_TEXT, Buffer.from("{}")))).not.toBeNull();
  });

  it("accepts a well-formed server frame (negative control)", () => {
    const step = decodeFrame(encodeServerText("{}"));
    expect(serverFrameViolation(step!.frame)).toBeNull();
  });
});

describe("T-489 codex app-server transport: demultiplexing", () => {
  it("demultiplexes on presence of id, never on arrival order", async () => {
    // The measured server emits remoteControl/status/changed unsolicited right
    // after initialize. A reader that assumed the next frame answers the last
    // request would return the NOTIFICATION as the response.
    const server = await startFakeServer({
      onMessage: (msg, socket) => {
        if (msg["method"] !== "later") return undefined;
        socket.write(
          encodeServerText(
            JSON.stringify({
              method: "remoteControl/status/changed",
              params: { status: "disabled" },
              emittedAtMs: 1788683905065,
            }),
          ),
        );
        setTimeout(
          () =>
            socket.write(
              encodeServerText(JSON.stringify({ id: msg["id"], result: { real: "answer" } })),
            ),
          15,
        );
        return undefined;
      },
    });
    const client = await connect(server);
    const result = (await client.request("later", {})) as Record<string, unknown>;
    expect(result["real"]).toBe("answer");
    expect(result).not.toHaveProperty("status");
  });

  it("correlates concurrent requests to their own ids, out of order", async () => {
    const server = await startFakeServer({
      onMessage: (msg, socket) => {
        if (msg["method"] !== "slow" && msg["method"] !== "fast") return undefined;
        const delay = msg["method"] === "slow" ? 40 : 5;
        setTimeout(
          () =>
            socket.write(
              encodeServerText(JSON.stringify({ id: msg["id"], result: { who: msg["method"] } })),
            ),
          delay,
        );
        return undefined;
      },
    });
    const client = await connect(server);
    const [slow, fast] = await Promise.all([
      client.request("slow", {}) as Promise<Record<string, unknown>>,
      client.request("fast", {}) as Promise<Record<string, unknown>>,
    ]);
    expect(slow["who"]).toBe("slow");
    expect(fast["who"]).toBe("fast");
  });

  it("surfaces an rpc error object as an error, not as a result", async () => {
    const server = await startFakeServer({
      onMessage: (msg) =>
        msg["method"] === "boom"
          ? encodeServerText(JSON.stringify({ id: msg["id"], error: { code: -1, message: "nope" } }))
          : undefined,
    });
    const client = await connect(server);
    await expect(client.request("boom", {})).rejects.toBeInstanceOf(CodexAppServerError);
  });
});

describe("T-489 frame codec units", () => {
  it("returns null for an incomplete frame instead of guessing", () => {
    const full = encodeFrame(OP_TEXT, Buffer.from("hello"));
    for (let cut = 1; cut < full.length; cut++) {
      expect(decodeFrame(full.subarray(0, cut))).toBeNull();
    }
    expect(decodeFrame(full)).not.toBeNull();
  });

  it("round-trips masked payloads at every length boundary", () => {
    for (const n of [0, 1, 125, 126, 127, 65535, 65536]) {
      const payload = randomBytes(n);
      const encoded = encodeFrame(OP_TEXT, payload);
      const decoded = decodeFrame(encoded);
      expect(decoded).not.toBeNull();
      expect(decoded!.frame.payload.equals(payload)).toBe(true);
      expect(decoded!.rest.length).toBe(0);
    }
  });

  it("decodes FIXED wire vectors whose length bytes are written independently", () => {
    // Round-tripping our own encoder through our own decoder cannot catch a
    // SYMMETRIC mistake: both sides would agree on the wrong bytes. These headers
    // are written by hand from the RFC so the decoder is checked against the wire
    // format rather than against its counterpart.
    const v125 = Buffer.concat([Buffer.from([0x81, 125]), Buffer.alloc(125, 0x41)]);
    expect(decodeFrame(v125)!.frame.payload.length).toBe(125);

    const h126 = Buffer.alloc(4);
    h126[0] = 0x81; h126[1] = 126; h126.writeUInt16BE(126, 2);
    expect(decodeFrame(Buffer.concat([h126, Buffer.alloc(126, 0x42)]))!.frame.payload.length).toBe(126);

    const h65535 = Buffer.alloc(4);
    h65535[0] = 0x81; h65535[1] = 126; h65535.writeUInt16BE(65535, 2);
    expect(decodeFrame(Buffer.concat([h65535, Buffer.alloc(65535, 0x43)]))!.frame.payload.length).toBe(65535);

    const h65536 = Buffer.alloc(10);
    h65536[0] = 0x81; h65536[1] = 127; h65536.writeBigUInt64BE(BigInt(65536), 2);
    expect(decodeFrame(Buffer.concat([h65536, Buffer.alloc(65536, 0x44)]))!.frame.payload.length).toBe(65536);
  });

  it("returns null when a split lands INSIDE an extended-length header", () => {
    const h = Buffer.alloc(10);
    h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(65536), 2);
    const full = Buffer.concat([h, Buffer.alloc(65536, 0x45)]);
    // Cuts at 3 and 6 fall inside the 8-byte length field.
    for (const cut of [2, 3, 6, 9, 10, 1000]) {
      expect(decodeFrame(full.subarray(0, cut))).toBeNull();
    }
    expect(decodeFrame(full)!.frame.payload.length).toBe(65536);
  });

  it("leaves trailing bytes untouched when two frames share a buffer", () => {
    const a = encodeFrame(OP_TEXT, Buffer.from("first"));
    const b = encodeFrame(OP_TEXT, Buffer.from("second"));
    const step = decodeFrame(Buffer.concat([a, b]));
    expect(step!.frame.payload.toString()).toBe("first");
    const next = decodeFrame(step!.rest);
    expect(next!.frame.payload.toString()).toBe("second");
  });
});

describe("T-489 codex app-server transport: payload validation", () => {
  async function failsWith(raw: (id: unknown) => Buffer, reason: string): Promise<void> {
    const server = await startFakeServer({
      onMessage: (msg, socket) => {
        if (msg["method"] !== "probe") return undefined;
        socket.write(raw(msg["id"]));
        return undefined;
      },
    });
    const client = await connect(server);
    await expect(client.request("probe", {})).rejects.toMatchObject({ reason });
  }

  it("rejects a text frame that is not valid UTF-8 instead of parsing replacements", async () => {
    // The bytes are chosen so a LENIENT decode still yields valid JSON: 0xFF
    // becomes U+FFFD inside a string, the result parses, and the rpc RESOLVES with
    // a value the peer never sent. Only a fatal decoder refuses.
    await failsWith((id) => {
      const head = Buffer.from(`{"id":${String(id)},"result":{"v":"`, "utf-8");
      const tail = Buffer.from('"}}', "utf-8");
      return encodeServerFrame(OP_TEXT, Buffer.concat([head, Buffer.from([0xff]), tail]));
    }, "frame");
  });

  it("accepts multi-byte UTF-8 unharmed (negative control)", async () => {
    const server = await startFakeServer({
      onMessage: (msg, socket) => {
        if (msg["method"] !== "probe") return undefined;
        socket.write(encodeServerText(JSON.stringify({ id: msg["id"], result: { v: "caf\u00e9 \u2713" } })));
        return undefined;
      },
    });
    const client = await connect(server);
    await expect(client.request("probe", {})).resolves.toEqual({ v: "caf\u00e9 \u2713" });
  });

  it("ACCEPTS a payload of exactly the declared-length limit", async () => {
    // The boundary the previous cap silently made unreachable. `len > max` ALLOWS
    // exactly the limit, so a conforming peer can legally send it; a receive
    // buffer capped at the same number counts the 10-byte header too and cuts that
    // peer off. Slow (a real 16 MiB round trip) and kept anyway: this is the exact
    // case where the two caps disagree, and nothing cheaper distinguishes them.
    const LIMIT = 16 * 1024 * 1024;
    const server = await startFakeServer({
      onMessage: (msg, socket) => {
        if (msg["method"] !== "probe") return undefined;
        const body = Buffer.from(JSON.stringify({ id: msg["id"], result: { v: "x" } }), "utf-8");
        // Padded to EXACTLY the limit with insignificant JSON whitespace, so it
        // stays parseable while occupying the full frame budget.
        const padded = Buffer.concat([body.subarray(0, body.length - 1), Buffer.alloc(LIMIT - body.length, 0x20), Buffer.from("}")]);
        expect(padded.length).toBe(LIMIT);
        const head = Buffer.alloc(10);
        head[0] = 0x80 | OP_TEXT;
        head[1] = 127;
        head.writeBigUInt64BE(BigInt(LIMIT), 2);
        socket.write(Buffer.concat([head, padded]));
        return undefined;
      },
    });
    const client = await connect(server);
    await expect(client.request("probe", {})).resolves.toEqual({ v: "x" });
  }, 30_000);

  it("bounds the buffer at the HEADER, so a huge declared length buffers nothing", async () => {
    // What actually protects the buffer, and the reason the post-drain cap can
    // never fire: an over-limit length is refused on the 10 header bytes, so a peer
    // that declares a gigabyte gets no accumulation at all. Asserted end to end
    // here, not just on the codec, because the ordering inside `decodeFrame` is
    // only load-bearing if the connection calls it that way.
    const server = await startFakeServer({
      onMessage: (msg, socket) => {
        if (msg["method"] !== "probe") return undefined;
        const head = Buffer.alloc(10);
        head[0] = 0x80 | OP_TEXT;
        head[1] = 127;
        head.writeBigUInt64BE(BigInt(1024 * 1024 * 1024), 2);
        socket.write(head); // header only: the body is never sent
        return undefined;
      },
    });
    const client = await connect(server);
    await expect(client.request("probe", {})).rejects.toThrow(/exceeds/);
  });

  it("does not count a COALESCED following frame against the limit", async () => {
    // A chunk legitimately carries the tail of one frame and the head of the next.
    // Capping before draining counts both, so an ordinary pipelined pair could be
    // rejected purely for arriving together.
    const server = await startFakeServer({
      onMessage: (msg, socket) => {
        if (msg["method"] !== "probe") return undefined;
        socket.write(
          Buffer.concat([
            encodeServerText(JSON.stringify({ method: "noise/one", params: {} })),
            encodeServerText(JSON.stringify({ id: msg["id"], result: { v: "coalesced" } })),
            encodeServerText(JSON.stringify({ method: "noise/two", params: {} })),
          ]),
        );
        return undefined;
      },
    });
    const client = await connect(server);
    await expect(client.request("probe", {})).resolves.toEqual({ v: "coalesced" });
  });

  it("rejects a ONE-BYTE close payload as malformed rather than reporting a clean close", async () => {
    // A close payload is empty, or a 2-byte status code plus an optional reason.
    // One byte is a protocol violation, and reporting it as `closed` would tell the
    // caller the peer shut down cleanly when it did not.
    await failsWith(() => encodeServerFrame(OP_CLOSE, Buffer.from([0x03])), "frame");
  });

  it("rejects a close reason that is not valid UTF-8", async () => {
    await failsWith(
      () => encodeServerFrame(OP_CLOSE, Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from([0xff])])),
      "frame",
    );
  });

  it("rejects a close carrying a status code that may never appear ON THE WIRE", async () => {
    // 1005, 1006 and 1015 are codes an endpoint synthesizes for ITSELF to describe
    // a close it received no code for. A peer that sends one has violated the
    // protocol, and accepting it reports a clean shutdown that never happened.
    for (const code of [1005, 1006, 1015, 1004, 999, 2000]) {
      await failsWith(() => {
        const body = Buffer.alloc(2);
        body.writeUInt16BE(code, 0);
        return encodeServerFrame(OP_CLOSE, body);
      }, "frame");
    }
  });

  it("accepts the close codes that ARE legal on the wire (negative control)", async () => {
    // Without this, rejecting every code would pass the test above while breaking
    // every ordinary shutdown.
    for (const code of [1000, 1001, 1003, 1007, 1011, 1014, 3000, 4999]) {
      await failsWith(() => {
        const body = Buffer.alloc(2);
        body.writeUInt16BE(code, 0);
        return encodeServerFrame(OP_CLOSE, body);
      }, "closed");
    }
  });

  it("classifies close codes at every boundary of the allowed ranges", () => {
    expect([999, 1004, 1005, 1006, 1015, 1016, 2999, 5000, 0].map(closeCodeAllowed)).toEqual([
      false, false, false, false, false, false, false, false, false,
    ]);
    expect([1000, 1003, 1007, 1014, 3000, 4999].map(closeCodeAllowed)).toEqual([
      true, true, true, true, true, true,
    ]);
  });

  it("still reports a WELL-FORMED close as closed (negative control)", async () => {
    // Without this, rejecting every close payload would pass the two tests above
    // while breaking the ordinary shutdown path.
    await failsWith(
      () => encodeServerFrame(OP_CLOSE, Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from("bye", "utf-8")])),
      "closed",
    );
    await failsWith(() => encodeServerFrame(OP_CLOSE, Buffer.alloc(0)), "closed");
  });
});
