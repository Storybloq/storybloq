/**
 * T-489 Codex app-server client: WebSocket over a Unix domain socket.
 *
 * WHY THIS IS HAND-ROLLED, recorded so it is not "simplified" back:
 *
 * 1. The daemon control socket speaks WEBSOCKET, not raw JSON. This was MEASURED
 *    (see .story/duet-plans/t489-transport-measurement.md), and the way it was
 *    measured is the reason this docblock exists. Writing raw JSON to the socket
 *    produces ZERO bytes on every channel and the connection is closed with no
 *    error anywhere; the close is only observable on the NEXT write, as EPIPE.
 *    Scanning all 256 possible first bytes shows 79 leave the connection open and
 *    177 close it, and the open set is EXACTLY RFC 7230 `tchar` plus CR and LF:
 *    the legal first characters of an HTTP request-line method. `{` is not a
 *    tchar, so a JSON frame dies on byte one, before any parse.
 *
 *    THE CONSEQUENCE FOR A FUTURE READER: if this transport ever regresses to
 *    raw JSON, nothing reports an error. There is no log line, no rejection and
 *    no exception. The only symptom is a wake that never happens. That silence
 *    is why the framing below is tested directly rather than trusted.
 *
 * 2. Node's built-in global `WebSocket` CANNOT be used here and must not be
 *    re-proposed. It accepts only `ws:`/`wss:` URLs -- `new WebSocket("ws+unix://...")`
 *    throws `DOMException: Expected a ws: or wss: protocol` -- and the only escape
 *    hatch, an undici dispatcher carrying `socketPath`, is unreachable because
 *    undici is not publicly importable (MODULE_NOT_FOUND / ERR_MODULE_NOT_FOUND).
 *    Our endpoint is a Unix socket. Separately, `engines.node` is `>=20` and the
 *    global WebSocket is flag-gated before 22, whereas `node:http` and
 *    `node:crypto` predate that floor, so this choice removes the version problem
 *    rather than deferring it.
 *
 * Rulings: r-snc9nppxxkrv9rr7 as amended by r-4gppsdk0z92s6t6r.
 */

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { Socket } from "node:net";

/**
 * Hard ceiling on a single frame and on the receive buffer.
 *
 * A peer can DECLARE a length before sending any of it, so without this a frame
 * header claiming gigabytes would have us buffering toward exhaustion long before
 * any deadline fired. 16 MiB is far above any real app-server response.
 */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/**
 * Largest legal frame HEADER: 2 bytes plus an 8-byte extended length plus a 4-byte
 * mask. A server must not mask, but the receive buffer is sized before any frame
 * has been validated, so the masked form is what bounds it.
 */
const MAX_HEADER_BYTES = 14;
/** The most an INCOMPLETE frame can legally occupy while it is still arriving. */
const MAX_BUFFER_BYTES = MAX_FRAME_BYTES + MAX_HEADER_BYTES;

/** RFC 6455 3.  Fixed GUID the server mixes into the accept hash. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** RFC 6455 5.2 opcodes we recognise. Anything else is a protocol violation. */
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/**
 * Why each outcome is distinguished: the caller records these verbatim as the
 * wake `reason`, and collapsing them would hide which half of the transport
 * failed. `socket-absent` in particular is a NORMAL state (the control socket
 * exists only while a daemon runs), not an anomaly.
 */
export type CodexTransportReason =
  | "socket-absent"
  | "handshake"
  | "frame"
  | "closed"
  | "timeout"
  | "io";

export class CodexAppServerError extends Error {
  readonly reason: CodexTransportReason;

  constructor(reason: CodexTransportReason, message: string) {
    super(message);
    this.name = "CodexAppServerError";
    this.reason = reason;
  }
}

export interface CodexAppServerClientOptions {
  /** Absolute path to `app-server-control.sock`. */
  readonly socketPath: string;
  /** Our own version, echoed by the server into its userAgent (attributability). */
  readonly clientVersion: string;
  /** Wall-clock budget covering connect, handshake and every RPC. */
  readonly deadlineMs: number;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

/**
 * One decoded frame. `payload` is already unmasked.
 */
interface DecodedFrame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
  /** Server frames MUST NOT be masked (RFC 6455 5.1); the receive path enforces it. */
  readonly masked: boolean;
  /** RSV1-3. Nonzero without a negotiated extension is a protocol error. */
  readonly rsv: number;
  /** Which length encoding the sender used, so non-minimal encodings are detectable. */
  readonly lengthForm: "7bit" | "16bit" | "64bit";
}

/**
 * Decode at most one frame from the head of `buf`.
 *
 * Returns null when the buffer does not yet hold a COMPLETE frame; a frame may be
 * split across TCP reads and several frames may arrive in one read, and neither is
 * an error. Callers keep the remainder and try again on the next chunk.
 *
 * Exported for direct test coverage: the encoder/decoder pair is the part whose
 * failure mode is silent, so it is exercised on bytes rather than through mocks.
 */
export interface DecodeOptions {
  /**
   * Apply the rules that bind a SERVER frame, at the HEADER, before waiting for a
   * payload. Off by default so the same decoder can still read masked CLIENT
   * frames (the test server does exactly that).
   */
  readonly enforceServerRules?: boolean;
  readonly maxPayloadBytes?: number;
}

export function decodeFrame(
  buf: Buffer,
  options: DecodeOptions = {},
): { frame: DecodedFrame; rest: Buffer } | null {
  if (buf.length < 2) return null;
  const b0 = buf[0]!;
  const b1 = buf[1]!;
  const fin = (b0 & 0x80) !== 0;
  const rsv = (b0 & 0x70) >> 4;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;
  let lengthForm: DecodedFrame["lengthForm"] = "7bit";

  if (len === 126) {
    if (buf.length < off + 2) return null;
    len = buf.readUInt16BE(off);
    lengthForm = "16bit";
    off += 2;
  } else if (len === 127) {
    if (buf.length < off + 8) return null;
    const big = buf.readBigUInt64BE(off);
    // A frame larger than a JS integer can index cannot be handled; treat it as a
    // protocol violation rather than truncating it into a plausible-looking value.
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CodexAppServerError("frame", "frame length exceeds MAX_SAFE_INTEGER");
    }
    len = Number(big);
    lengthForm = "64bit";
    off += 8;
  }

  let mask: Buffer | null = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.subarray(off, off + 4);
    off += 4;
  }
  // VALIDATE FROM THE HEADER, before waiting for the payload. Every one of these
  // is derivable from the declared length, so a frame that can never be legal is
  // rejected without buffering a single byte of its body.
  const max = options.maxPayloadBytes ?? MAX_FRAME_BYTES;
  if (len > max) {
    throw new CodexAppServerError("frame", `frame length ${String(len)} exceeds ${String(max)}`);
  }
  if (options.enforceServerRules === true) {
    const violation = headerViolation({ fin, opcode, masked, rsv, lengthForm, declaredLength: len });
    if (violation !== null) throw new CodexAppServerError("frame", violation);
  }

  if (buf.length < off + len) return null;

  let payload = buf.subarray(off, off + len);
  if (mask) {
    // Servers MUST NOT mask (RFC 6455 5.1). Unmasking anyway is defensive, not
    // permissive: a masked server frame still decodes rather than becoming garbage
    // that JSON.parse would report as a confusing syntax error.
    const copy = Buffer.from(payload);
    for (let i = 0; i < copy.length; i++) copy[i] = copy[i]! ^ mask[i % 4]!;
    payload = copy;
  }
  return { frame: { fin, opcode, payload, masked, rsv, lengthForm }, rest: buf.subarray(off + len) };
}

/**
 * Server-frame rules that are decidable from the HEADER alone.
 *
 * Split out from the frame so it can run before the payload has arrived, which is
 * what stops a declared-but-unsent gigabyte from being buffered.
 */
function headerViolation(header: {
  fin: boolean;
  opcode: number;
  masked: boolean;
  rsv: number;
  lengthForm: DecodedFrame["lengthForm"];
  declaredLength: number;
}): string | null {
  if (header.masked) return "server frame was masked";
  if (header.rsv !== 0) return `reserved bits set (rsv ${String(header.rsv)})`;
  const n = header.declaredLength;
  // Non-minimal length encodings are a protocol error, and accepting them lets a
  // peer smuggle two readings of the same bytes past anything that re-encodes.
  if (header.lengthForm === "16bit" && n < 126) return "non-minimal 16-bit length";
  if (header.lengthForm === "64bit" && n < 65536) return "non-minimal 64-bit length";
  if (header.opcode >= 0x8) {
    // Control frames must never be fragmented and never exceed 125 bytes. Echoing
    // an oversized ping back as a pong would emit an invalid frame of our own.
    if (!header.fin) return "fragmented control frame";
    if (n > 125) return `control frame payload ${String(n)} exceeds 125`;
  }
  return null;
}

/**
 * Reject a server frame that violates RFC 6455.
 *
 * Kept SEPARATE from `decodeFrame` on purpose: the decoder stays generic so it can
 * also decode masked CLIENT frames (the test server uses it for exactly that), and
 * the prohibition on masked SERVER frames is enforced here, on the receive path,
 * where it actually applies. Unmasking a server frame is not the same as
 * permitting it.
 *
 * Returns a reason string, or null when the frame is acceptable.
 */
export function serverFrameViolation(frame: DecodedFrame): string | null {
  return headerViolation({
    fin: frame.fin,
    opcode: frame.opcode,
    masked: frame.masked,
    rsv: frame.rsv,
    lengthForm: frame.lengthForm,
    declaredLength: frame.payload.length,
  });
}

/**
 * Encode one masked client frame.
 *
 * Client frames MUST be masked (RFC 6455 5.3); an unmasked client frame is a
 * protocol violation the server may close on, which would look exactly like the
 * silent hang-up described at the top of this file.
 *
 * The three length encodings are the reason this is tested at 125/126/127 and at
 * 65535/65536: a 7-bit-only encoder passes every small fixture and then fails on
 * the first realistic payload.
 */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;

  const n = payload.length;
  let head: Buffer;
  if (n < 126) {
    head = Buffer.from([0x80 | opcode, 0x80 | n]);
  } else if (n < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 126;
    head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, mask, masked]);
}

/** Fatal UTF-8 decoder: throws rather than substituting replacement characters. */
/**
 * Close status codes a peer may put ON THE WIRE (RFC 6455 7.4.1, plus the IANA
 * registrations that followed it).
 *
 * The exclusions are the point. 1005, 1006 and 1015 are codes an endpoint
 * SYNTHESIZES for itself to describe a close it never received a code for; a peer
 * that puts one on the wire has committed a protocol violation, and accepting it
 * would report a clean shutdown that never happened. 1004 is reserved and
 * undefined, so it means nothing either.
 */
export function closeCodeAllowed(code: number): boolean {
  if (code >= 3000 && code <= 4999) return true; // registered and private use
  if (code >= 1000 && code <= 1003) return true;
  return code >= 1007 && code <= 1014;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function isValidUtf8(buf: Buffer): boolean {
  try {
    UTF8.decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** The accept value a conforming server must return for `key`. */
export function expectedAccept(key: string): string {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

export interface CodexAppServerClient {
  /** Send one request and resolve with its `result`. */
  request(method: string, params: unknown): Promise<unknown>;
  /** Destroy the socket. Idempotent; safe to call from a `finally`. */
  close(): void;
}

/**
 * Connect, upgrade, and complete the `initialize` handshake.
 *
 * The returned client is usable only until `close()`; the caller owns that call
 * and must make it from a `finally` on every path, because an open socket keeps a
 * handle alive and would outlive the wake.
 */
export async function connectCodexAppServer(
  options: CodexAppServerClientOptions,
): Promise<CodexAppServerClient> {
  const { socketPath, clientVersion, deadlineMs } = options;

  const key = randomBytes(16).toString("base64");
  const socket = await upgrade(socketPath, key, deadlineMs);

  let buffer = socket.head;
  let closed = false;
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();

  const raw: Socket = socket.socket;

  const failAll = (error: Error): void => {
    for (const [, p] of pending) p.reject(error);
    pending.clear();
  };

  // Idempotent on the SOCKET, not on the flag: the close path sets `closed` before
  // half-closing, and a later close() from the caller's `finally` must still tear
  // the socket down rather than return early and leak the handle.
  const destroy = (): void => {
    closed = true;
    if (!raw.destroyed) raw.destroy();
  };

  // Attached BEFORE the first write so a teardown race cannot surface as an
  // unhandled 'error' event.
  raw.on("error", (err: Error) => {
    failAll(new CodexAppServerError("io", `socket error: ${err.message}`));
    destroy();
  });
  raw.on("close", () => {
    failAll(new CodexAppServerError("closed", "connection closed before response"));
    closed = true;
  });

  /**
   * Parse everything currently buffered.
   *
   * Called from the `data` handler AND after each request is registered, because
   * the upgrade `head` can already contain a complete response. Draining only on
   * `data` would leave those bytes unparsed until more traffic happened to arrive,
   * which for a one-request-and-done wake is never.
   */
  const drain = (): void => {
    for (;;) {
      let step: { frame: DecodedFrame; rest: Buffer } | null;
      try {
        // Server rules enforced AT THE HEADER: an illegal frame is rejected before
        // its payload is buffered.
        step = decodeFrame(buffer, { enforceServerRules: true, maxPayloadBytes: MAX_FRAME_BYTES });
      } catch (err) {
        failAll(err instanceof Error ? err : new CodexAppServerError("frame", String(err)));
        destroy();
        return;
      }
      if (!step) return;
      buffer = step.rest;
      const violation = serverFrameViolation(step.frame);
      if (violation !== null) {
        failAll(new CodexAppServerError("frame", violation));
        destroy();
        return;
      }
      const { fin, opcode, payload } = step.frame;

      // Fragmented or binary frames are REJECTED, never misparsed. Concatenating a
      // continuation or feeding a binary payload to JSON.parse would turn a
      // protocol violation into a confusing downstream error.
      if (opcode === OP_CONTINUATION || !fin || opcode === OP_BINARY) {
        failAll(
          new CodexAppServerError(
            "frame",
            `unsupported frame (opcode ${opcode}, fin ${String(fin)})`,
          ),
        );
        destroy();
        return;
      }

      if (opcode === OP_CLOSE) {
        // A close payload is either empty or a 2-byte status code plus an optional
        // UTF-8 reason. One byte is malformed, and a reason that is not valid UTF-8
        // is a protocol error rather than something to render with replacements.
        if (payload.length === 1 || (payload.length > 2 && !isValidUtf8(payload.subarray(2)))) {
          failAll(new CodexAppServerError("frame", "malformed close frame payload"));
          destroy();
          return;
        }
        if (payload.length >= 2 && !closeCodeAllowed(payload.readUInt16BE(0))) {
          failAll(new CodexAppServerError("frame", "close frame carried a forbidden status code"));
          destroy();
          return;
        }
        // Reply with a close frame, then stop. Whatever had already been resolved
        // stands; anything still pending becomes `closed`.
        //
        // `end()` rather than `write()` + `destroy()`: destroy() discards queued
        // writes, so the close reply would never reach the peer. end() flushes it
        // and then half-closes, which is what RFC 6455 7.1.1 asks for.
        closed = true;
        try {
          raw.end(encodeFrame(OP_CLOSE, Buffer.alloc(0)));
        } catch {
          raw.destroy();
        }
        failAll(new CodexAppServerError("closed", "server closed the connection"));
        return;
      }

      if (opcode === OP_PING) {
        // A pong carries the ping's payload back and must not disturb correlation.
        try {
          raw.write(encodeFrame(OP_PONG, payload));
        } catch {
          // Ignored: a failed pong is reported by the next read or the deadline.
        }
        continue;
      }

      if (opcode === OP_PONG) continue;

      if (opcode !== OP_TEXT) {
        failAll(new CodexAppServerError("frame", `unsupported opcode ${opcode}`));
        destroy();
        return;
      }

      let text: string;
      try {
        // FATAL decoding: `Buffer.toString("utf8")` silently substitutes U+FFFD, so
        // malformed bytes could still parse as JSON and resolve an RPC. Invalid
        // UTF-8 in a text frame is a protocol error (RFC 6455 8.1).
        text = UTF8.decode(payload);
      } catch {
        failAll(new CodexAppServerError("frame", "text frame was not valid UTF-8"));
        destroy();
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        failAll(
          new CodexAppServerError(
            "frame",
            `malformed JSON in text frame: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        destroy();
        return;
      }

      // DEMULTIPLEX ON PRESENCE OF `id`, NEVER ON ARRIVAL ORDER. The server emits
      // unsolicited notifications (measured: remoteControl/status/changed arrives
      // immediately after initialize) which carry `method` and no `id`. A reader
      // that assumed the next frame answers the last request would hand that
      // notification back as the response.
      if (!isRecord(parsed) || !("id" in parsed)) continue;

      const id = parsed["id"];
      if (typeof id !== "number") continue;
      const waiter = pending.get(id);
      if (!waiter) continue;
      pending.delete(id);

      if ("error" in parsed && parsed["error"] !== undefined && parsed["error"] !== null) {
        waiter.reject(
          new CodexAppServerError("io", `rpc error: ${JSON.stringify(parsed["error"]).slice(0, 400)}`),
        );
      } else {
        waiter.resolve(parsed["result"]);
      }
    }
  };

  raw.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    // DRAIN FIRST, then bound WHAT REMAINS. Capping the pre-drain buffer counts
    // header bytes and any coalesced following frame against a PAYLOAD limit, so a
    // payload of exactly MAX_FRAME_BYTES -- which the declared-length cap ALLOWS --
    // could never be received, and a conforming peer would be cut off at the
    // boundary. After a drain, what is left is by definition ONE incomplete frame,
    // whose largest legal size is its header plus that payload.
    drain();
    // UNREACHABLE WHILE THE HEADER CAP STANDS, and kept deliberately as an
    // assertion of that invariant rather than as a defence that fires. The proof:
    // `decodeFrame` reads the declared length from the first 2-10 bytes and THROWS
    // when it exceeds the cap, before buffering any body, so the only remainder
    // that can survive a drain is an incomplete frame with a LEGAL length, which
    // is at most header + MAX_FRAME_BYTES. No fixture can reach this branch, and a
    // test claiming to was what the round-3 review caught. What WOULD make it
    // reachable: a caller-raised `maxPayloadBytes`, or continuation frames being
    // buffered across frames instead of rejected. Both are one edit away, and this
    // is the line that would hold at that moment.
    if (!closed && buffer.length > MAX_BUFFER_BYTES) {
      failAll(new CodexAppServerError("frame", "receive buffer exceeded the frame limit"));
      destroy();
    }
  });

  const request = (method: string, params: unknown): Promise<unknown> => {
    if (closed) {
      return Promise.reject(new CodexAppServerError("closed", "client is closed"));
    }
    const id = nextId++;
    // No `jsonrpc` field: MEASURED, ClientRequest carries exactly method, params
    // and id. Adding one is neither required nor rejected, so it is omitted.
    const body = JSON.stringify({ id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        raw.write(encodeFrame(OP_TEXT, Buffer.from(body, "utf8")));
      } catch (err) {
        pending.delete(id);
        reject(
          new CodexAppServerError("io", `write failed: ${err instanceof Error ? err.message : String(err)}`),
        );
        return;
      }
      // The response may already be buffered (upgrade `head`), in which case no
      // further `data` event will ever arrive to trigger a parse.
      drain();
    });
  };

  const client: CodexAppServerClient = { request, close: destroy };

  // `initialize` is a normal request and is sent FIRST. clientInfo.name is
  // "storybloq" and the version is ours: the server echoes both into its
  // userAgent, which is what makes a wake attributable to us.
  //
  // OWNERSHIP TRANSFER: until this resolves, the socket belongs to US. If the
  // handshake rejects (an rpc error, a synchronous write failure, a frame
  // violation) the caller never receives a client and therefore can never call
  // close(), so an un-destroyed socket would stay open for the life of the
  // process with its deadline already cleared. Destroy on every rejection and
  // rethrow; hand ownership to the caller only on success.
  try {
    await withDeadline(
      request("initialize", {
        clientInfo: { name: "storybloq", title: null, version: clientVersion },
        capabilities: null,
      }),
      deadlineMs,
      destroy,
    );
  } catch (err) {
    destroy();
    throw err;
  }

  return client;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject with `timeout` if `promise` outlives `ms`, running `onTimeout` first. */
export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new CodexAppServerError("timeout", `deadline exceeded after ${ms}ms`));
        }, ms);
        // Do not hold the event loop open on account of the deadline itself.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Perform the HTTP/1.1 Upgrade over a Unix socket and hand back the raw socket.
 *
 * `node:http` supports `socketPath`; the global WebSocket does not, which is the
 * entire reason this function exists (see the file docblock).
 */
function upgrade(
  socketPath: string,
  key: string,
  deadlineMs: number,
): Promise<{ socket: Socket; head: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      path: "/",
      method: "GET",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
      },
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new CodexAppServerError("timeout", `upgrade deadline exceeded after ${deadlineMs}ms`));
    }, deadlineMs);
    timer.unref?.();

    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    req.on("upgrade", (res, socket: Socket, head: Buffer) => {
      if (res.statusCode !== 101) {
        socket.destroy();
        done(() =>
          reject(new CodexAppServerError("handshake", `upgrade returned status ${String(res.statusCode)}`)),
        );
        return;
      }
      // VERIFIED against the RFC 6455 GUID, not merely checked for presence: a
      // server that echoes an arbitrary accept value is not speaking this protocol.
      const accept = res.headers["sec-websocket-accept"];
      if (accept !== expectedAccept(key)) {
        socket.destroy();
        done(() =>
          reject(new CodexAppServerError("handshake", "Sec-WebSocket-Accept did not verify")),
        );
        return;
      }
      // The `head` buffer can already carry the first frame. Dropping it silently
      // loses the first response.
      done(() => resolve({ socket, head: Buffer.from(head ?? []) }));
    });

    // A plain response means the server answered WITHOUT upgrading. DESTROY rather
    // than drain: a server that sends headers and never finishes the body would
    // otherwise keep the socket alive long after the wake has already failed.
    req.on("response", (res) => {
      const status = res.statusCode;
      res.destroy();
      req.destroy();
      done(() =>
        reject(
          new CodexAppServerError("handshake", `server did not upgrade (status ${String(status)})`),
        ),
      );
    });

    req.on("error", (err: NodeJS.ErrnoException) => {
      // The control socket exists only while a daemon runs, so a missing socket is
      // an expected state and gets its own reason rather than a generic failure.
      const reason: CodexTransportReason =
        err.code === "ENOENT" || err.code === "ECONNREFUSED" ? "socket-absent" : "io";
      done(() => reject(new CodexAppServerError(reason, `connect failed: ${err.message}`)));
    });

    req.end();
  });
}
