// T-538 proxy (plan section 5, amendment A1). One fixed AF_UNIX listener and no TCP listener of
// its own. CONNECT only, one request per socket, every limit enforced here, independent of the
// runner and the relay. A log line never carries text from a request: a refused line holds a code
// from the fixed set, and an allowed line holds only the validated listed authority.
import dns from "node:dns";
import fs from "node:fs";
import net from "node:net";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export const FIXED_PATHS = { sockPath: "/vol/sock/proxy.sock", logPath: "/vol/proxy/log/proxy.log" };
export const EXIT_UNEXPECTED_ENTRY = 3;
export const EXIT_BAD_CONFIG = 4;

const MiB = 1048576;
/** Section 12. The expiry has no default: it comes from the attempt's deadline. */
export const DEFAULT_LIMITS = { conns: 100, bytes: 256 * MiB, sockets: 32, headerMs: 10_000, headerBytes: 8192, lifeMs: 45 * 60_000, logBytes: 16 * MiB };

/** The only text a refused line can carry. */
export const REFUSAL_CODES = ["method", "malformed", "not-listed", "private-address", "header-timeout", "header-size", "too-many-sockets", "ceiling"];

const AUTHORITY = /^[a-z0-9.-]+:[1-9][0-9]{0,4}$/;
const CONNECT_LINE = /^CONNECT ([^ \r\n]*) HTTP\/1\.1\r\n/;
const ABSOLUTE_LINE = /^[A-Z]+ http:\/\/([a-z0-9.-]+:[1-9][0-9]{0,4})\/[^ \r\n]* HTTP\/1\.1\r\n/;

/** Loopback, RFC 1918 (the Docker bridges and the VM's range among them), link-local, CGNAT, multicast, reserved, unspecified, and anything not IPv4. */
export function isRefusedAddress(address) {
  if (net.isIP(address) !== 4) return true;
  const [a, b] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

/** A listed entry is a lowercase name and a decimal port; an IP literal never is one. */
export function listEntryIsValid(entry) {
  if (!AUTHORITY.test(entry)) return false;
  const [host, port] = entry.split(":");
  return net.isIP(host) === 0 && !host.endsWith(".") && Number(port) <= 65535;
}

export function readConfig(env) {
  const list = (v) => (v ?? "").split(",").filter(Boolean);
  const allow = list(env.ALLOW);
  const plain = list(env.PLAIN);
  const privateOk = env.ALLOW_PRIVATE === "1";
  const expiryMs = Number(env.EXPIRY_MS);
  let limits;
  try { limits = { ...DEFAULT_LIMITS, ...JSON.parse(env.LIMITS ?? "{}") }; } catch { return null; }
  if (![...allow, ...plain].every(listEntryIsValid) || !Number.isInteger(expiryMs) || expiryMs <= 0) return null;
  // The stub routes exist for tests only, and never beside a credential.
  if (env.CREDENTIAL === "1" && (plain.length > 0 || privateOk)) return null;
  return { allow, plain, privateOk, expiryMs, limits };
}

function openLog(logPath, limit) {
  fs.mkdirSync(dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  const reserve = Math.min(64 * 1024, Math.floor(limit / 4));
  let pos = 0;
  let counterAt = -1;
  let dropped = 0;
  const put = (text) => { pos += fs.writeSync(fd, text, pos); };
  const counter = () => `${JSON.stringify({ t: Date.now(), logFull: 1, dropped: String(dropped).padStart(12, "0") })}\n`;
  return {
    line(o) {
      const text = `${JSON.stringify({ t: Date.now(), ...o })}\n`;
      if (counterAt < 0 && pos + text.length <= limit - reserve) return put(text);
      dropped += 1;
      if (counterAt < 0) { counterAt = pos; put(counter()); } else fs.writeSync(fd, counter(), counterAt);
    },
    /** A ceiling hit is bounded by the ceilings themselves, so it stays past the cap on ordinary lines. */
    hit(o) {
      const text = `${JSON.stringify({ t: Date.now(), ...o })}\n`;
      if (pos + text.length <= limit) put(text);
    },
  };
}

/**
 * Starts the listener and returns it. `lookup` and `exit` are seams for tests; production uses
 * the system resolver and process.exit. Throws on a stale volume before listening.
 */
export function startProxy({ sockPath, logPath, allow, plain, privateOk, expiryMs, limits, lookup = dns.lookup, exit = process.exit }) {
  if (fs.readdirSync(dirname(sockPath)).length > 0) throw Object.assign(new Error("unexpected entry"), { code: "UNEXPECTED_ENTRY" });
  const log = openLog(logPath, limits.logBytes);
  const allowed = new Set(allow);
  const plainList = new Set(plain);
  const open = new Set();
  const tunnels = new Set();
  let accepted = 0;
  let upTotal = 0;
  let bytesHit = false;
  let connsHit = false;
  let nextId = 0;
  const closeAll = () => { for (const t of [...tunnels]) t(); for (const s of [...open]) s.destroy(); };

  const srv = net.createServer({ allowHalfOpen: true }, (c) => {
    const cid = ++nextId;
    const started = Date.now();
    open.add(c);
    c.on("close", () => open.delete(c));
    c.on("error", () => {});
    if (open.size > limits.sockets) { log.line({ cid, refuse: "too-many-sockets" }); c.destroy(); return; }
    const refuse = (code, status = "403 Forbidden") => {
      log.line({ cid, refuse: code });
      c.end(`HTTP/1.1 ${status}\r\n\r\n`);
      setTimeout(() => c.destroy(), 200).unref();
    };
    if (bytesHit) return refuse("ceiling");
    if (++accepted > limits.conns) {
      if (!connsHit) { connsHit = true; log.hit({ "ceiling-hit": "connections" }); }
      return refuse("ceiling");
    }
    let buf = Buffer.alloc(0);
    const stopHeaders = () => { clearTimeout(deadline); c.off("data", onData); c.off("end", onEnd); };
    const deadline = setTimeout(() => { stopHeaders(); refuse("header-timeout", "408 Request Timeout"); }, limits.headerMs);
    const onEnd = () => { stopHeaders(); log.line({ cid, refuse: "malformed" }); c.destroy(); };
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0 ? buf.length > limits.headerBytes : end + 4 > limits.headerBytes) { stopHeaders(); return refuse("header-size"); }
      if (end < 0) return;
      stopHeaders();
      c.pause();
      const head = buf.toString("latin1", 0, end + 2);
      const connect = CONNECT_LINE.exec(head);
      const absolute = ABSOLUTE_LINE.exec(head);
      const plainHit = absolute !== null && plainList.has(absolute[1]);
      if (connect === null && !plainHit) return refuse(head.startsWith("CONNECT ") ? "malformed" : "method");
      const authority = plainHit ? absolute[1] : connect[1];
      if (!plainHit && !AUTHORITY.test(authority)) return refuse("malformed");
      if (!plainHit && !allowed.has(authority)) return refuse("not-listed");
      const [host, port] = authority.split(":");
      tunnel(c, cid, started, authority, host, Number(port), plainHit, plainHit ? buf : buf.subarray(end + 4), refuse);
    };
    c.on("end", onEnd);
    c.on("data", onData);
  });

  const tunnel = (c, cid, started, authority, host, port, plainHit, first, refuse) => {
    let up = null;
    let upBytes = 0;
    let downBytes = 0;
    let connected = false;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(life);
      tunnels.delete(finish);
      if (connected) log.line({ cid, closed: 1, up: upBytes, down: downBytes, ms: Date.now() - started });
      else if (up !== null && !c.destroyed) { log.line({ cid, closed: 1, connected: false, ms: Date.now() - started }); c.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); }
      c.destroy();
      up?.destroy();
    };
    const life = setTimeout(() => { log.hit({ "ceiling-hit": "lifetime", cid }); finish(); }, limits.lifeMs);
    tunnels.add(finish);
    c.on("close", finish);
    /** Counted before the chunk goes: the chunk that would cross is not sent. */
    const forward = (d) => {
      if (upTotal + d.length > limits.bytes) {
        if (!bytesHit) { bytesHit = true; log.hit({ "ceiling-hit": "upstream-bytes", forwarded: upTotal }); }
        closeAll();
        return;
      }
      upTotal += d.length;
      upBytes += d.length;
      if (!up.write(d)) { c.pause(); up.once("drain", () => c.resume()); }
    };
    lookup(host, { all: true }, (err, addresses) => {
      if (finished) return;
      if (err || addresses.length === 0 || (!plainHit && !privateOk && addresses.some((a) => isRefusedAddress(a.address)))) {
        finished = true;
        clearTimeout(life);
        tunnels.delete(finish);
        c.off("close", finish);
        return refuse("private-address");
      }
      up = net.connect({ host: addresses[0].address, port, allowHalfOpen: true });
      up.on("connect", () => {
        connected = true;
        log.line({ cid, allow: authority, plain: plainHit });
        if (!plainHit) c.write("HTTP/1.1 200 OK\r\n\r\n");
        if (first.length > 0) forward(first);
        c.on("data", forward);
        up.on("data", (d) => {
          downBytes += d.length;
          if (!c.write(d)) { up.pause(); c.once("drain", () => up.resume()); }
        });
        c.on("end", () => up.end());
        up.on("end", () => c.end());
        c.resume();
      });
      up.on("error", finish);
      up.on("close", finish);
    });
  };

  const expiry = setTimeout(() => {
    log.hit({ "ceiling-hit": "expiry" });
    closeAll();
    exit(0);
  }, expiryMs);
  srv.on("close", () => clearTimeout(expiry));
  srv.listen(sockPath, () => {
    fs.chmodSync(sockPath, 0o660);
    log.line({ listening: 1 });
  });
  return { server: srv, closeAll };
}

export function main(env, paths, exit = process.exit) {
  const config = readConfig(env);
  if (config === null) return exit(EXIT_BAD_CONFIG);
  try {
    return startProxy({ ...paths, ...config, exit });
  } catch (e) {
    return exit(e.code === "UNEXPECTED_ENTRY" || e.code === "EEXIST" ? EXIT_UNEXPECTED_ENTRY : 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.env, FIXED_PATHS);
