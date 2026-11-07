// T-538 S5b-0 commit 2: the proxy, relay, supervisor, seccomp identity and launch argv, on the host.
// The same behaviours through a real container are in t538-container.docker.test.ts.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attemptRunArgs, BASE_IMAGE, compactProfile, profileBytes, proxyRunArgs, SECCOMP_COMPACT_SHA256, SECCOMP_FILE_SHA256, securityOptProblems, volumeInitArgs,
} from "../../scripts/onboarding-eval-container.js";

const PKG = join(import.meta.dirname, "..", "..");
const DIR = join(PKG, "scripts", "eval-container");
const proxyFile: string = join(DIR, "proxy.mjs");
const relayFile: string = join(DIR, "relay.mjs");
const supFile: string = join(DIR, "sup.mjs");
const sha256 = (d: string | Buffer): string => createHash("sha256").update(d).digest("hex");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 4000): Promise<void> => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await sleep(10); };

interface Rig {
  readonly sock: string;
  readonly logText: () => string;
  readonly lines: () => Record<string, unknown>[];
  readonly good: string;
  readonly port: number;
  readonly received: () => number;
  readonly flooded: () => number;
  readonly lookups: () => number;
  readonly lookupOptions: () => unknown;
  readonly exited: () => number | null;
}
type Opts = Record<string, unknown> & { limits?: Record<string, number>; addresses?: { address: string }[] | Error; dns?: { v4: { address: string }[]; v6: { address: string }[] }; sink?: "no-read" | "flood" };

async function withProxy(opts: Opts, body: (r: Rig) => Promise<void>): Promise<void> {
  const { startProxy, DEFAULT_LIMITS } = await import(proxyFile);
  const root = mkdtempSync(join(tmpdir(), "t538p"));
  mkdirSync(join(root, "s"));
  const logPath = join(root, "l", "proxy.log");
  let received = 0;
  const sinkSockets = new Set<net.Socket>();
  let flooded = 0;
  const sink = net.createServer({ allowHalfOpen: true }, (c) => {
    sinkSockets.add(c);
    c.on("error", () => {});
    if (opts.sink === "no-read") return;
    if (opts.sink === "flood") {
      const chunk = Buffer.alloc(1 << 20, 7);
      const pump = (): void => { while (!c.destroyed && flooded < 128) { flooded += 1; if (!c.write(chunk)) { c.once("drain", pump); return; } } };
      pump();
      return;
    }
    c.on("data", (d) => { received += d.length; });
    c.pipe(c);
  });
  await new Promise<void>((r) => sink.listen(0, "127.0.0.1", r));
  const port = (sink.address() as net.AddressInfo).port;
  let lookups = 0;
  let lookupOptions: unknown = null;
  let exited: number | null = null;
  const good = `sink.test:${port}`;
  const lookup = (_h: string, o: { family?: number }, cb: (e: Error | null, a?: unknown) => void): void => {
    lookups += 1;
    lookupOptions = o;
    if (opts.dns) {
      // What a resolver does: AAAA answers come back unless the caller asked for IPv4 only.
      const answers = o.family === 4 ? opts.dns.v4 : [...opts.dns.v4, ...opts.dns.v6];
      if (answers.length === 0) cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
      else cb(null, answers);
      return;
    }
    if (opts.addresses instanceof Error) cb(opts.addresses);
    else cb(null, opts.addresses ?? [{ address: "127.0.0.1" }]);
  };
  const sock = join(root, "s", "proxy.sock");
  const { limits, addresses: _a, dns: _d, sink: _s, ...rest } = opts;
  const p = startProxy({ sockPath: sock, logPath, allow: [good], plain: [], privateOk: true, expiryMs: 60_000, limits: { ...DEFAULT_LIMITS, ...limits }, lookup, exit: (c: number) => { exited = c; }, ...rest });
  await until(() => existsSync(sock));
  const logText = (): string => readFileSync(logPath, "utf8");
  try {
    await body({
      sock, logText, good, port,
      lines: () => logText().trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>),
      received: () => received, flooded: () => flooded, lookups: () => lookups, lookupOptions: () => lookupOptions, exited: () => exited,
    });
  } finally {
    p.closeAll();
    p.server.close();
    for (const s of sinkSockets) s.destroy();
    sink.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const dial = (r: Rig): net.Socket => { const c = net.connect(r.sock); c.on("error", () => {}); return c; };
const connectLine = (a: string): string => `CONNECT ${a} HTTP/1.1\r\nHost: x\r\n\r\n`;
/** The first reply line, or "closed" with no reply. */
const ask = (r: Rig, text: string, ms = 2000): Promise<string> => new Promise((res) => {
  const c = dial(r);
  let b = "";
  c.on("connect", () => c.write(text));
  c.on("data", (d) => { b += d.toString("latin1"); if (b.includes("\r\n\r\n")) { c.destroy(); res(b.split("\r\n")[0]!); } });
  c.on("close", () => res(b ? b.split("\r\n")[0]! : "closed"));
  setTimeout(() => { c.destroy(); res("timeout"); }, ms);
});
const openTunnel = (r: Rig): Promise<net.Socket> => new Promise((res) => {
  const c = dial(r);
  c.on("connect", () => c.write(connectLine(r.good)));
  c.once("data", () => res(c));
});
const closed = (c: net.Socket, ms = 3000): Promise<boolean> => new Promise((res) => { if (c.destroyed) return res(true); c.on("close", () => res(true)); setTimeout(() => res(false), ms); });
const refusals = (r: Rig): unknown[] => r.lines().filter((l) => "refuse" in l).map((l) => l.refuse);

describe("the proxy's request parser", () => {
  it.each([
    ["evil.example:443", "not-listed"], ["10.0.0.1:443", "not-listed"], ["[::1]:443", "malformed"], ["user@sink.test:443", "malformed"],
    ["SINK.TEST:443", "malformed"], ["sink.test.:443", "not-listed"], ["sink.test:0443", "malformed"], ["sink.test:9", "not-listed"], ["sink%2etest:443", "malformed"],
  ])("refuses CONNECT %s with code %s and never resolves", async (authority, code) => {
    await withProxy({}, async (r) => {
      expect(await ask(r, connectLine(authority))).toBe("HTTP/1.1 403 Forbidden");
      expect(refusals(r)).toEqual([code]);
      expect(r.lookups()).toBe(0);
    });
  });
  it.each([
    ["POST / HTTP/1.1\r\n\r\n", "method"], ["GET http://sink.test:80/ HTTP/1.1\r\n\r\n", "method"], ["CONNECT a:1 HTTP/1.0\r\n\r\n", "malformed"], ["CONNECT  a:1 HTTP/1.1\r\n\r\n", "malformed"],
  ])("refuses %j with code %s", async (text, code) => {
    await withProxy({}, async (r) => {
      expect(await ask(r, text)).toBe("HTTP/1.1 403 Forbidden");
      expect(refusals(r)).toEqual([code]);
    });
  });
  it("a listed authority matches byte for byte: the listed name on another port is refused", async () => {
    await withProxy({}, async (r) => {
      expect(await ask(r, connectLine(`sink.test:${r.port + 1}`))).toBe("HTTP/1.1 403 Forbidden");
      expect(await ask(r, connectLine(r.good))).toBe("HTTP/1.1 200 OK");
    });
  });
});

describe("the proxy's address checks", () => {
  it("classifies every range of section 5", async () => {
    const { isRefusedAddress } = await import(proxyFile);
    for (const a of ["0.0.0.0", "0.1.2.3", "10.0.0.1", "127.0.0.1", "100.64.0.1", "100.127.255.255", "169.254.1.1", "172.16.0.1", "172.17.0.2", "172.31.255.255", "192.168.0.1", "192.168.65.5", "224.0.0.1", "239.1.1.1", "240.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "2001:4860:4860::8888", "::ffff:8.8.8.8", "not an address"]) expect(isRefusedAddress(a), a).toBe(true);
    for (const a of ["8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "169.253.1.1", "192.167.1.1", "192.169.1.1", "223.255.255.255", "9.255.255.255", "11.0.0.1"]) expect(isRefusedAddress(a), a).toBe(false);
  });
  it.each([
    ["one private among public", [{ address: "8.8.8.8" }, { address: "10.0.0.1" }]],
    ["the private one first", [{ address: "192.168.65.1" }, { address: "8.8.8.8" }]],
    ["a documentation address among public", [{ address: "8.8.8.8" }, { address: "192.0.2.7" }]],
    ["a benchmarking address among public", [{ address: "8.8.8.8" }, { address: "198.18.0.1" }]],
    ["an IPv6 answer of any class", [{ address: "8.8.8.8" }, { address: "2001:4860:4860::8888" }]],
    ["no answer", []],
  ])("refuses a listed name that resolves to %s, and connects to nothing", async (_n, addresses) => {
    await withProxy({ privateOk: false, addresses }, async (r) => {
      expect(await ask(r, connectLine(r.good))).toBe("HTTP/1.1 403 Forbidden");
      expect(refusals(r)).toEqual(["private-address"]);
      expect(r.lines().some((l) => "allow" in l)).toBe(false);
    });
  });
  it("a dual-stack name connects to its checked IPv4 literal, asking for IPv4 only and never resolving again", async () => {
    const seen: unknown[] = [];
    const connect = (o: { port: number }): net.Socket => { seen.push(o); return net.connect({ host: "127.0.0.1", port: o.port, allowHalfOpen: true }); };
    const dns = { v4: [{ address: "8.8.8.8" }, { address: "1.1.1.1" }], v6: [{ address: "2001:4860:4860::8888" }] };
    await withProxy({ privateOk: false, dns, connect }, async (r) => {
      const c = await openTunnel(r);
      expect(r.lookupOptions()).toEqual({ all: true, family: 4 });
      expect(r.lookups()).toBe(1);
      expect(seen).toEqual([{ host: "8.8.8.8", port: r.port, family: 4, allowHalfOpen: true }]);
      c.destroy();
    });
  });
  it("a name with only IPv6 answers is refused", async () => {
    await withProxy({ privateOk: false, dns: { v4: [], v6: [{ address: "2001:4860:4860::8888" }] } }, async (r) => {
      expect(await ask(r, connectLine(r.good))).toBe("HTTP/1.1 403 Forbidden");
      expect(refusals(r)).toEqual(["private-address"]);
    });
  });
  it("an IPv6 answer is refused even on the stub's private route", async () => {
    await withProxy({ privateOk: true, addresses: [{ address: "::1" }] }, async (r) => {
      expect(await ask(r, connectLine(r.good))).toBe("HTTP/1.1 403 Forbidden");
      expect(refusals(r)).toEqual(["private-address"]);
    });
  });
  it("the policy is exactly the sixteen ruled ranges", async () => {
    const { PROHIBITED_RANGES } = await import(proxyFile);
    expect(PROHIBITED_RANGES).toEqual(["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "255.255.255.255/32"]);
  });
  // First and last address refused; the neighbours are public unless another range owns them (null).
  it.each([
    ["0.0.0.0/8", "0.0.0.0", "0.255.255.255", null, "1.0.0.0"],
    ["10.0.0.0/8", "10.0.0.0", "10.255.255.255", "9.255.255.255", "11.0.0.0"],
    ["100.64.0.0/10", "100.64.0.0", "100.127.255.255", "100.63.255.255", "100.128.0.0"],
    ["127.0.0.0/8", "127.0.0.0", "127.255.255.255", "126.255.255.255", "128.0.0.0"],
    ["169.254.0.0/16", "169.254.0.0", "169.254.255.255", "169.253.255.255", "169.255.0.0"],
    ["172.16.0.0/12", "172.16.0.0", "172.31.255.255", "172.15.255.255", "172.32.0.0"],
    ["192.0.0.0/24", "192.0.0.0", "192.0.0.255", "191.255.255.255", "192.0.1.0"],
    ["192.0.2.0/24", "192.0.2.0", "192.0.2.255", "192.0.1.255", "192.0.3.0"],
    ["192.88.99.0/24", "192.88.99.0", "192.88.99.255", "192.88.98.255", "192.88.100.0"],
    ["192.168.0.0/16", "192.168.0.0", "192.168.255.255", "192.167.255.255", "192.169.0.0"],
    ["198.18.0.0/15", "198.18.0.0", "198.19.255.255", "198.17.255.255", "198.20.0.0"],
    ["198.51.100.0/24", "198.51.100.0", "198.51.100.255", "198.51.99.255", "198.51.101.0"],
    ["203.0.113.0/24", "203.0.113.0", "203.0.113.255", "203.0.112.255", "203.0.114.0"],
    ["224.0.0.0/4", "224.0.0.0", "239.255.255.255", "223.255.255.255", null],
    ["240.0.0.0/4", "240.0.0.0", "255.255.255.254", null, null],
    ["255.255.255.255/32", "255.255.255.255", "255.255.255.255", null, null],
  ])("the edges of %s", async (_cidr, first, last, below, above) => {
    const { isRefusedAddress } = await import(proxyFile);
    expect(isRefusedAddress(first), first).toBe(true);
    expect(isRefusedAddress(last), last).toBe(true);
    for (const n of [below, above]) if (n !== null) expect(isRefusedAddress(n), n).toBe(false);
  });
  it("a failed lookup is refused with a code, not its text", async () => {
    await withProxy({ privateOk: false, addresses: new Error("FAKETOKEN123") }, async (r) => {
      expect(await ask(r, connectLine(r.good))).toBe("HTTP/1.1 403 Forbidden");
      expect(refusals(r)).toEqual(["private-address"]);
      expect(r.logText()).not.toContain("FAKETOKEN123");
    });
  });
  it("resolves once and connects by the checked address", async () => {
    await withProxy({}, async (r) => {
      const c = await openTunnel(r);
      expect(r.lookups()).toBe(1);
      c.destroy();
    });
  });
  it("an upstream that refuses is a 502 and a closed line, with no allow line", async () => {
    const free = net.createServer();
    await new Promise<void>((res) => free.listen(0, "127.0.0.1", res));
    const dead = (free.address() as net.AddressInfo).port;
    await new Promise((res) => free.close(res));
    await withProxy({ allow: [`dead.test:${dead}`] }, async (r) => {
      expect(await ask(r, connectLine(`dead.test:${dead}`))).toBe("HTTP/1.1 502 Bad Gateway");
      expect(r.lines().some((l) => "allow" in l)).toBe(false);
      expect(r.lines().some((l) => l.closed === 1 && l.connected === false)).toBe(true);
    });
  });
});

describe("a tunnel", () => {
  it("echoes, keeps half-close both ways, and logs the listed authority and the bytes each way", async () => {
    await withProxy({}, async (r) => {
      const c = await openTunnel(r);
      let b = "";
      c.on("data", (d) => { b += d; });
      const ended = new Promise((res) => c.on("end", res));
      c.write("half-close-row");
      c.end();
      await ended;
      expect(b).toBe("half-close-row");
      c.destroy();
      await until(() => r.logText().includes("closed"));
      const allow = r.lines().find((l) => "allow" in l)!;
      expect(allow.allow).toBe(r.good);
      const done = r.lines().find((l) => "closed" in l)!;
      expect(done).toMatchObject({ cid: allow.cid, up: 14, down: 14 });
      expect(typeof done.ms).toBe("number");
    });
  });
  it("carries a smuggled second request to the upstream only, as counted bytes, and decides nothing on it", async () => {
    await withProxy({}, async (r) => {
      const second = "CONNECT evil.example:443 HTTP/1.1\r\n\r\n";
      const c = dial(r);
      let b = "";
      c.on("connect", () => c.write(connectLine(r.good) + second));
      c.on("data", (d) => { b += d; });
      await until(() => b.includes("evil.example"));
      expect(b.endsWith(second)).toBe(true);
      expect(r.received()).toBe(second.length);
      c.destroy();
      await until(() => r.logText().includes("closed"));
      expect(refusals(r)).toEqual([]);
      expect(r.lines().find((l) => "closed" in l)).toMatchObject({ up: second.length });
    });
  });
  it("an upstream that stops reading holds the client back, and nothing buffers without bound", async () => {
    await withProxy({ sink: "no-read" }, async (r) => {
      const c = await openTunnel(r);
      const chunk = Buffer.alloc(1 << 20, 7);
      let wrote = 0;
      const pump = (): void => { while (wrote < 64 && !c.destroyed) { wrote += 1; if (!c.write(chunk)) { c.once("drain", pump); return; } } };
      pump();
      await until(() => wrote >= 64, 1500);
      expect(wrote).toBeLessThan(64);
      c.destroy();
    });
  });
  it("a client that stops reading holds the upstream back, and nothing buffers without bound", async () => {
    await withProxy({ sink: "flood" }, async (r) => {
      const c = dial(r);
      c.on("connect", () => c.write(connectLine(r.good)));
      await new Promise<void>((res) => c.once("readable", () => res()));
      await until(() => r.flooded() >= 64, 1500);
      expect(r.flooded()).toBeLessThan(64);
      c.destroy();
    });
  });
});

describe("the plainHttp list", () => {
  it("forwards an absolute-form request for a listed stub, whole, past the address check", async () => {
    const stub = net.createServer((c) => { c.on("error", () => {}); c.pipe(c); });
    await new Promise<void>((res) => stub.listen(0, "127.0.0.1", res));
    const port = (stub.address() as net.AddressInfo).port;
    const a = `stub.test:${port}`;
    await withProxy({ privateOk: false, plain: [a] }, async (r) => {
      const text = `GET http://${a}/v1 HTTP/1.1\r\nHost: x\r\n\r\n`;
      expect(await ask(r, text)).toBe(`GET http://${a}/v1 HTTP/1.1`);
      expect(r.lines().find((l) => "allow" in l)).toMatchObject({ allow: a, plain: true });
    });
    stub.close();
  });
  it("gives a listed stub no CONNECT, and an unlisted absolute form no forwarding", async () => {
    await withProxy({ plain: ["stub.test:8080"] }, async (r) => {
      expect(await ask(r, connectLine("stub.test:8080"))).toBe("HTTP/1.1 403 Forbidden");
      expect(await ask(r, "GET http://other.test:8080/ HTTP/1.1\r\n\r\n")).toBe("HTTP/1.1 403 Forbidden");
      expect(refusals(r)).toEqual(["not-listed", "method"]);
    });
  });
});

describe("the proxy's configuration", () => {
  const ok = { ALLOW: "a.test:443", EXPIRY_MS: "1000" };
  it("reads a valid configuration, with section 12's numbers by default", async () => {
    const { readConfig, DEFAULT_LIMITS } = await import(proxyFile);
    expect(DEFAULT_LIMITS).toEqual({ conns: 100, bytes: 268435456, sockets: 32, headerMs: 10000, headerBytes: 8192, lifeMs: 2700000, logBytes: 16777216 });
    expect(readConfig(ok)).toEqual({ allow: ["a.test:443"], plain: [], privateOk: false, expiryMs: 1000, limits: DEFAULT_LIMITS });
    expect(readConfig({ ...ok, CREDENTIAL: "1" })).not.toBeNull();
    expect(readConfig({ ...ok, LIMITS: '{"conns":50}' }).limits.conns).toBe(50);
  });
  it.each([
    ["no expiry", { ALLOW: "a.test:443" }],
    ["a plain list beside the credential", { ...ok, CREDENTIAL: "1", PLAIN: "stub:8080" }],
    ["private addresses beside the credential", { ...ok, CREDENTIAL: "1", ALLOW_PRIVATE: "1" }],
    ["an IP literal listed", { ...ok, ALLOW: "8.8.8.8:443" }],
    ["an uppercase name listed", { ...ok, ALLOW: "A.test:443" }],
    ["a trailing dot listed", { ...ok, ALLOW: "a.test.:443" }],
    ["a port out of range listed", { ...ok, ALLOW: "a.test:70000" }],
    ["an unreadable limits value", { ...ok, LIMITS: "{" }],
    ["limits that are null", { ...ok, LIMITS: "null" }],
    ["limits that are a list", { ...ok, LIMITS: "[1]" }],
    ["limits that are a number", { ...ok, LIMITS: "5" }],
    ["a limit that is a string", { ...ok, LIMITS: '{"bytes":"unlimited"}' }],
    ["a limit that is a numeric string", { ...ok, LIMITS: '{"conns":"50"}' }],
    ["a limit that is null", { ...ok, LIMITS: '{"bytes":null}' }],
    ["a negative limit", { ...ok, LIMITS: '{"conns":-1}' }],
    ["a zero limit", { ...ok, LIMITS: '{"sockets":0}' }],
    ["a fractional limit", { ...ok, LIMITS: '{"lifeMs":1.5}' }],
    ["an infinite limit", { ...ok, LIMITS: '{"bytes":1e400}' }],
    ["an unknown limit", { ...ok, LIMITS: '{"burst":5}' }],
    ["a limit named for the prototype", { ...ok, LIMITS: '{"__proto__":5}' }],
    ["an expiry in another notation", { ...ok, EXPIRY_MS: "1e3" }],
    ["an expiry past the attempt deadline", { ...ok, EXPIRY_MS: String(211 * 60_000 + 1) }],
  ])("refuses %s, and main exits 4", async (_n, env) => {
    const { readConfig, main } = await import(proxyFile);
    expect(readConfig(env)).toBeNull();
    let code: number | null = null;
    main(env, { sockPath: "/nonexistent/s", logPath: "/nonexistent/l" }, (c: number) => { code = c; });
    expect(code).toBe(4);
  });
  it.each(["conns", "bytes", "sockets", "headerMs", "headerBytes", "lifeMs", "logBytes"])("%s can tighten its ruled number, reach it, and never pass it", async (key) => {
    const { readConfig, DEFAULT_LIMITS, MAX_EXPIRY_MS } = await import(proxyFile);
    const ruled = DEFAULT_LIMITS[key] as number;
    const low = key === "logBytes" ? 65536 : 1;
    expect(readConfig({ ...ok, LIMITS: JSON.stringify({ [key]: low }) }).limits[key]).toBe(low);
    expect(readConfig({ ...ok, LIMITS: JSON.stringify({ [key]: ruled }) }).limits[key]).toBe(ruled);
    expect(readConfig({ ...ok, LIMITS: JSON.stringify({ [key]: ruled + 1 }) })).toBeNull();
    expect(readConfig({ ...ok, EXPIRY_MS: String(MAX_EXPIRY_MS) }).expiryMs).toBe(211 * 60_000);
  });
  it("the smallest log limit still holds its reserved records, and the next size down is refused", async () => {
    const { readConfig } = await import(proxyFile);
    expect(readConfig({ ...ok, LIMITS: '{"logBytes":65535}' })).toBeNull();
    await withProxy({ limits: { logBytes: 65536, conns: 100_000, sockets: 64 } }, async (r) => {
      for (let round = 0; round < 110 && !r.logText().includes("logFull"); round++) await Promise.all(Array.from({ length: 20 }, () => ask(r, "GET / HTTP/1.1\r\n\r\n")));
      expect(r.logText()).toContain("logFull");
      await Promise.all(Array.from({ length: 20 }, () => ask(r, "GET / HTTP/1.1\r\n\r\n")));
      expect(statSync(join(r.sock, "..", "..", "l", "proxy.log")).size).toBeLessThanOrEqual(65536);
    });
  }, 60_000);
  it("refuses a socket folder that holds anything, and a log that exists, so no volume is reused", async () => {
    const { main } = await import(proxyFile);
    const root = mkdtempSync(join(tmpdir(), "t538c"));
    mkdirSync(join(root, "s"));
    mkdirSync(join(root, "l"));
    const codes: number[] = [];
    writeFileSync(join(root, "l", "proxy.log"), "");
    main(ok, { sockPath: join(root, "s", "proxy.sock"), logPath: join(root, "l", "proxy.log") }, (c: number) => codes.push(c));
    writeFileSync(join(root, "s", "stale"), "");
    main(ok, { sockPath: join(root, "s", "proxy.sock"), logPath: join(root, "l", "other.log") }, (c: number) => codes.push(c));
    expect(codes).toEqual([3, 3]);
    expect(existsSync(join(root, "s", "proxy.sock"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
  it("gives the socket mode 0660 and the log 0600", async () => {
    await withProxy({}, async (r) => {
      await until(() => r.logText().includes("listening"));
      expect(statSync(r.sock).mode & 0o777).toBe(0o660);
      expect(statSync(join(r.sock, "..", "..", "l", "proxy.log")).mode & 0o777).toBe(0o600);
    });
  });
});

describe("header limits", () => {
  it("the deadline is one total from accept, never reset by bytes", async () => {
    await withProxy({ limits: { headerMs: 300 } }, async (r) => {
      const c = dial(r);
      let reply = "";
      c.on("data", (d) => { reply += d; });
      const t0 = Date.now();
      const tick = setInterval(() => { if (!c.destroyed) c.write("C"); }, 40);
      await closed(c);
      clearInterval(tick);
      expect(Date.now() - t0).toBeLessThan(1500);
      expect(reply.split("\r\n")[0]).toBe("HTTP/1.1 408 Request Timeout");
      expect(refusals(r)).toEqual(["header-timeout"]);
    });
  });
  it("a header block over the limit closes, one that fits exactly passes", async () => {
    await withProxy({ limits: { headerBytes: 256 } }, async (r) => {
      const head = connectLine(r.good).slice(0, -2);
      const fits = `${head}X: ${"y".repeat(256 - head.length - 7)}\r\n\r\n`;
      expect(Buffer.byteLength(fits)).toBe(256);
      expect(await ask(r, fits)).toBe("HTTP/1.1 200 OK");
      expect(await ask(r, `${head}X: ${"y".repeat(256 - head.length - 6)}\r\n\r\n`)).toBe("HTTP/1.1 403 Forbidden");
      expect(await ask(r, "C".repeat(257))).toBe("HTTP/1.1 403 Forbidden");
      expect(refusals(r)).toEqual(["header-size", "header-size"]);
    });
  });
  it("a socket that ends before completing its headers closes at once and frees its slot", async () => {
    await withProxy({ limits: { sockets: 2 } }, async (r) => {
      for (let i = 0; i < 6; i++) {
        const c = dial(r);
        await new Promise((res) => c.on("connect", res));
        c.end("CON");
        expect(await closed(c, 2000)).toBe(true);
      }
      expect(refusals(r)).toEqual(Array(6).fill("malformed"));
      expect(await ask(r, connectLine(r.good))).toBe("HTTP/1.1 200 OK");
    });
  });
});

describe("the proxy's ceilings", () => {
  it("over the socket limit closes at once, and an open tunnel is untouched", async () => {
    await withProxy({ limits: { sockets: 2 } }, async (r) => {
      const a = await openTunnel(r);
      const b = await openTunnel(r);
      const third = dial(r);
      expect(await closed(third, 2000)).toBe(true);
      expect(refusals(r)).toEqual(["too-many-sockets"]);
      let got = "";
      a.on("data", (d) => { got += d; });
      a.write("alive");
      await until(() => got === "alive");
      expect(got).toBe("alive");
      a.destroy();
      b.destroy();
    });
  });
  it("the chunk that would cross the byte ceiling is not sent, every tunnel closes, and new connections are refused", async () => {
    await withProxy({ limits: { bytes: 1000 } }, async (r) => {
      const a = await openTunnel(r);
      const b = await openTunnel(r);
      a.write(Buffer.alloc(900));
      await until(() => r.received() === 900);
      const closedA = closed(a);
      const closedB = closed(b);
      b.write(Buffer.alloc(200));
      expect(await closedA).toBe(true);
      expect(await closedB).toBe(true);
      await sleep(100);
      expect(r.received()).toBe(900);
      expect(await ask(r, connectLine(r.good))).toBe("HTTP/1.1 403 Forbidden");
      expect(r.lines().filter((l) => l["ceiling-hit"] === "upstream-bytes")).toMatchObject([{ forwarded: 900 }]);
      expect(refusals(r)).toEqual(["ceiling"]);
    });
  });
  it("counts bytes that arrive with the request, against the same ceiling", async () => {
    await withProxy({ limits: { bytes: 10 } }, async (r) => {
      const c = dial(r);
      c.on("connect", () => c.write(connectLine(r.good) + "x".repeat(11)));
      c.resume();
      expect(await closed(c)).toBe(true);
      expect(r.received()).toBe(0);
      expect(r.lines().some((l) => l["ceiling-hit"] === "upstream-bytes")).toBe(true);
    });
  });
  it("the connection ceiling refuses new ones, logs one hit, and an open tunnel goes on", async () => {
    await withProxy({ limits: { conns: 1 } }, async (r) => {
      const a = await openTunnel(r);
      for (let i = 0; i < 3; i++) expect(await ask(r, connectLine(r.good))).toBe("HTTP/1.1 403 Forbidden");
      let got = "";
      a.on("data", (d) => { got += d; });
      a.write("alive");
      await until(() => got === "alive");
      expect(got).toBe("alive");
      expect(r.lines().filter((l) => l["ceiling-hit"] === "connections")).toHaveLength(1);
      expect(refusals(r)).toEqual(["ceiling", "ceiling", "ceiling"]);
      a.destroy();
    });
  });
  it("the connection lifetime closes that tunnel and logs its name", async () => {
    await withProxy({ limits: { lifeMs: 200 } }, async (r) => {
      const a = await openTunnel(r);
      expect(await closed(a)).toBe(true);
      expect(r.lines().some((l) => l["ceiling-hit"] === "lifetime")).toBe(true);
    });
  });
  it("expiry closes every tunnel, records their bytes, and ends the process with no runner", async () => {
    await withProxy({ expiryMs: 400 }, async (r) => {
      const a = await openTunnel(r);
      a.write("abc");
      await until(() => r.received() === 3);
      expect(await closed(a)).toBe(true);
      await until(() => r.exited() !== null);
      expect(r.exited()).toBe(0);
      expect(r.lines().some((l) => l["ceiling-hit"] === "expiry")).toBe(true);
      expect(r.lines().find((l) => "closed" in l)).toMatchObject({ up: 3 });
    });
  });
  it("expiry holds in a real process whose parent does nothing more", async () => {
    const root = mkdtempSync(join(tmpdir(), "t538e"));
    mkdirSync(join(root, "s"));
    const wrapper = `import(${JSON.stringify(proxyFile)}).then((m) => m.main({ ALLOW: "a.test:1", EXPIRY_MS: "300" }, { sockPath: ${JSON.stringify(join(root, "s", "p.sock"))}, logPath: ${JSON.stringify(join(root, "l", "p.log"))} }));`;
    const child = spawn(process.execPath, ["-e", wrapper], { stdio: "ignore" });
    const code = await new Promise((res) => child.on("exit", res));
    expect(code).toBe(0);
    expect(readFileSync(join(root, "l", "p.log"), "utf8")).toContain('"ceiling-hit":"expiry"');
    rmSync(root, { recursive: true, force: true });
  });
});

describe("the proxy's log", () => {
  it("holds no text from a request, wherever a token is placed", async () => {
    await withProxy({}, async (r) => {
      for (const text of ["CONNECT FAKETOKEN123:443 HTTP/1.1\r\n\r\n", "CONNECT evil.example:443 HTTP/1.1\r\nProxy-Authorization: FAKETOKEN123\r\n\r\nFAKETOKEN123", "GET http://FAKETOKEN123:80/FAKETOKEN123 HTTP/1.1\r\n\r\n", `CONNECT ${r.good} HTTP/1.1\r\nProxy-Authorization: FAKETOKEN123\r\n\r\nFAKETOKEN123`]) await ask(r, text);
      const c = await openTunnel(r);
      c.write("FAKETOKEN123");
      await sleep(50);
      c.destroy();
      await until(() => r.logText().includes("closed"));
      expect(r.logText()).not.toContain("FAKETOKEN123");
      const { REFUSAL_CODES } = await import(proxyFile);
      for (const code of refusals(r)) expect(REFUSAL_CODES).toContain(code);
    });
  });
  it("stops at its size limit with one counter line, and a ceiling hit still lands", async () => {
    await withProxy({ limits: { logBytes: 2048, conns: 60 } }, async (r) => {
      for (let i = 0; i < 70; i++) await ask(r, connectLine("no.test:1"));
      const lines = r.lines();
      expect(readFileSync(join(r.sock, "..", "..", "l", "proxy.log")).length).toBeLessThanOrEqual(2048);
      const counters = lines.filter((l) => l.logFull === 1);
      expect(counters).toHaveLength(1);
      expect(Number(counters[0]!.dropped)).toBeGreaterThan(30);
      expect(lines.filter((l) => l["ceiling-hit"] === "connections")).toHaveLength(1);
    });
  });
});

describe("the relay", () => {
  const rig = async (body: (port: number, upstreamEnded: () => string) => Promise<void>): Promise<void> => {
    const { startRelay } = await import(relayFile);
    const root = mkdtempSync(join(tmpdir(), "t538r"));
    const sockPath = join(root, "u.sock");
    let got = "";
    const upstream = net.createServer({ allowHalfOpen: true }, (c) => { c.on("data", (d) => { got += d; c.write(d); }); c.on("end", () => { got += "<end>"; c.end("late"); }); });
    await new Promise<void>((res) => upstream.listen(sockPath, res));
    const relay = startRelay({ port: 0, sockPath });
    await new Promise((res) => relay.on("listening", res));
    expect(relay.address().address).toBe("127.0.0.1");
    try { await body(relay.address().port, () => got); } finally { relay.close(); upstream.close(); rmSync(root, { recursive: true, force: true }); }
  };
  it("carries bytes both ways, listens on loopback only, and keeps half-close", async () => {
    await rig(async (port, got) => {
      const c = net.connect(port, "127.0.0.1");
      let b = "";
      c.on("data", (d) => { b += d; });
      const ended = new Promise((res) => c.on("end", res));
      c.write("hello");
      await until(() => b === "hello");
      c.end();
      await ended;
      expect(b, "the reply after the client's half-close still arrives").toBe("hellolate");
      expect(got()).toBe("hello<end>");
    });
  });
  it("with the proxy gone closes the client and does not retry", async () => {
    const { startRelay } = await import(relayFile);
    const relay = startRelay({ port: 0, sockPath: "/nonexistent/u.sock" });
    await new Promise((res) => relay.on("listening", res));
    const c = net.connect(relay.address().port, "127.0.0.1");
    c.on("error", () => {});
    expect(await closed(c)).toBe(true);
    relay.close();
  });
});

describe("the supervisor", () => {
  const run = (deadline: unknown, body: (child: ReturnType<typeof spawn>, root: string) => Promise<void>, before?: (root: string) => void): Promise<void> => {
    const root = mkdtempSync(join(tmpdir(), "t538s"));
    before?.(root);
    const relay = join(root, "fake-relay.mjs");
    writeFileSync(relay, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(join(root, "pid"))}, String(process.pid)); console.log("relay output"); setInterval(() => {}, 1000);`);
    const wrapper = `import(${JSON.stringify(supFile)}).then((m) => m.supervise({ deadlineSeconds: ${JSON.stringify(deadline)}, logPath: ${JSON.stringify(join(root, "relay.log"))}, relayPath: ${JSON.stringify(relay)} }));`;
    const child = spawn(process.execPath, ["-e", wrapper], { stdio: ["ignore", "pipe", "pipe"] });
    const gone = new Promise((res) => child.once("exit", res));
    const pidFile = join(root, "pid");
    return body(child, root).finally(async () => {
      const wasRunning = child.exitCode === null && child.signalCode === null;
      child.kill("SIGKILL");
      await gone;
      if (wasRunning) await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "", 2000);
      if (existsSync(pidFile)) {
        const p = Number(readFileSync(pidFile, "utf8"));
        if (p > 0 && alive(p)) { process.kill(p, "SIGKILL"); await until(() => !alive(p)); }
      }
      rmSync(root, { recursive: true, force: true });
    });
  };
  const exitOf = (c: ReturnType<typeof spawn>): Promise<number | null> => new Promise((res) => c.on("exit", (code) => res(code)));
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const relayPid = async (root: string): Promise<number> => { await until(() => existsSync(join(root, "pid")) && readFileSync(join(root, "pid"), "utf8") !== ""); return Number(readFileSync(join(root, "pid"), "utf8")); };

  it("ends the attempt with no restart when the relay dies, and keeps its output out of its own streams", async () => {
    await run(60, async (child, root) => {
      let streams = "";
      child.stdout!.on("data", (d) => { streams += d; });
      child.stderr!.on("data", (d) => { streams += d; });
      const pid = await relayPid(root);
      await until(() => existsSync(join(root, "relay.log")) && readFileSync(join(root, "relay.log"), "utf8").includes("relay output"));
      const exit = exitOf(child);
      process.kill(pid, "SIGKILL");
      expect(await exit).toBe(70);
      const log = readFileSync(join(root, "relay.log"), "utf8");
      expect(log).toContain("relay output");
      expect(log).toContain("relay-exit null SIGKILL");
      expect(streams).toBe("");
    });
  });
  it("its own deadline takes the relay with it and exits with a distinct code", async () => {
    await run(1, async (child, root) => {
      const pid = await relayPid(root);
      expect(await exitOf(child)).toBe(71);
      await until(() => !alive(pid));
      expect(alive(pid)).toBe(false);
    });
  });
  it("a stop takes the relay with it", async () => {
    await run(60, async (child, root) => {
      const pid = await relayPid(root);
      const exit = exitOf(child);
      child.kill("SIGTERM");
      expect(await exit).toBe(0);
      await until(() => !alive(pid));
      expect(alive(pid)).toBe(false);
    });
  });
  it.each([[0], [-1], [1.5], ["x"]])("refuses the deadline %j", async (bad) => {
    await run(bad, async (child) => { expect(await exitOf(child)).toBe(2); });
  });
  it("will not write its log through a link", async () => {
    const target = mkdtempSync(join(tmpdir(), "t538t"));
    writeFileSync(join(target, "victim"), "");
    await run(60, async (child, root) => {
      expect(await exitOf(child)).not.toBe(0);
      expect(existsSync(join(root, "pid"))).toBe(false);
    }, (root) => symlinkSync(join(target, "victim"), join(root, "relay.log")));
    expect(readFileSync(join(target, "victim"), "utf8")).toBe("");
    rmSync(target, { recursive: true, force: true });
  });
  it("a failing body still leaves no relay and no folder behind", async () => {
    let pid = 0;
    let folder = "";
    await expect(run(60, async (_child, root) => {
      folder = root;
      pid = await relayPid(root);
      throw new Error("deliberate");
    })).rejects.toThrow("deliberate");
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(false);
    expect(existsSync(folder)).toBe(false);
  });
});

describe("staging the build context", { timeout: 90_000 }, () => {
  const stageFile = join(import.meta.dirname, "..", "..", "scripts", "eval-container", "stage-context.mjs");
  const NAMES = ["Dockerfile", "proxy.Dockerfile", "proxy.mjs", "relay.mjs", "sup.mjs", "envelope.mjs", "pack.sh", "storybloq-launcher"];
  const made: string[] = [];
  const temp = (): string => { const d = mkdtempSync(join(tmpdir(), "t538p")); made.push(d); return d; };
  /** A tiny package around a copy of the script, which finds its root from its own path. */
  const fakePackage = (): string => {
    const root = temp();
    const e = join(root, "scripts", "eval-container");
    mkdirSync(e, { recursive: true });
    cpSync(stageFile, join(e, "stage-context.mjs"));
    for (const n of NAMES) writeFileSync(join(e, n), n);
    writeFileSync(join(root, "scripts", "build-eval.mjs"), 'import fs from "node:fs"; fs.mkdirSync(".eval-dist", { recursive: true }); fs.writeFileSync(".eval-dist/x", "built");');
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fake-pkg", version: "1.0.0", files: ["scripts"] }));
    writeFileSync(join(root, "package-lock.json"), "{}");
    return root;
  };
  const stage = (root: string, dest: string, cwd: string): number | null => spawnSync(process.execPath, [join(root, "scripts", "eval-container", "stage-context.mjs"), dest], { cwd, encoding: "utf8", timeout: 80_000 }).status;
  const expectStaged = (ctx: string): void => {
    expect(readdirSync(ctx).sort()).toEqual([...NAMES, "pkg"].sort());
    expect(readFileSync(join(ctx, "pkg", "package-lock.json"), "utf8")).toBe("{}");
    expect(readFileSync(join(ctx, "pkg", ".eval-dist", "x"), "utf8")).toBe("built");
    expect(JSON.parse(readFileSync(join(ctx, "pkg", "package.json"), "utf8")).name).toBe("fake-pkg");
  };
  it("refuses a folder that holds anything, with its contents intact and nothing built", () => {
    const root = fakePackage();
    const dest = temp();
    writeFileSync(join(dest, "keep"), "mine");
    expect(stage(root, dest, root)).toBe(2);
    expect(readFileSync(join(dest, "keep"), "utf8")).toBe("mine");
    expect(existsSync(join(root, ".eval-dist"))).toBe(false);
  });
  it("refuses the package root itself, a file and a link", () => {
    const root = fakePackage();
    expect(stage(root, root, root)).toBe(2);
    expect(existsSync(join(root, "package.json"))).toBe(true);
    const dir = temp();
    writeFileSync(join(dir, "file"), "mine");
    expect(stage(root, join(dir, "file"), root)).toBe(2);
    expect(readFileSync(join(dir, "file"), "utf8")).toBe("mine");
    const empty = temp();
    symlinkSync(empty, join(dir, "link"));
    expect(stage(root, join(dir, "link"), root)).toBe(2);
    expect(readdirSync(empty)).toEqual([]);
  });
  it("stages into a folder it creates, and into an empty one", () => {
    const root = fakePackage();
    const parent = temp();
    expect(stage(root, join(parent, "new", "ctx"), root)).toBe(0);
    expectStaged(join(parent, "new", "ctx"));
    const empty = temp();
    expect(stage(root, empty, root)).toBe(0);
    expectStaged(empty);
  });
  it("a relative destination from outside the package root lands where it was named", () => {
    const root = fakePackage();
    const outside = temp();
    expect(stage(root, join("rel", "ctx"), outside)).toBe(0);
    expectStaged(join(outside, "rel", "ctx"));
    expect(existsSync(join(root, "rel"))).toBe(false);
  });
  it("cleans up its temporary folders", () => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
    expect(made).toEqual([]);
  });
});

describe("the seccomp profile", () => {
  const bytes = profileBytes();
  it("is the file M1 measured, and its compacted form is the manifest's", () => {
    expect(sha256(readFileSync(join(DIR, "seccomp-attempt.json")))).toBe(SECCOMP_FILE_SHA256);
    expect(SECCOMP_FILE_SHA256).toBe("2cb512e0b6c5062bb05e0975de5aed06ffd4e010dcb8bce2ecb064072ffb1698");
    expect(sha256(compactProfile(bytes))).toBe(SECCOMP_COMPACT_SHA256);
  });
  it("is Docker 20.10.22's default plus one rule, naming only what bwrap needs", () => {
    const profile = JSON.parse(bytes) as { defaultAction: string; syscalls: Record<string, unknown>[]; [k: string]: unknown };
    const base = JSON.parse(readFileSync(join(PKG, "test", "fixtures", "t538-container", "default-seccomp-20.10.22.json"), "utf8")) as typeof profile;
    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
    const key = (o: unknown): string => JSON.stringify(o);
    const known = new Set(base.syscalls.map(key));
    const added = profile.syscalls.filter((s) => !known.has(key(s)));
    expect(added).toEqual([{ names: ["clone", "unshare", "setns", "mount", "umount2", "pivot_root"], action: "SCMP_ACT_ALLOW", args: [], comment: "t538 bwrap", includes: {}, excludes: {} }]);
    expect(profile.syscalls).toHaveLength(base.syscalls.length + 1);
    expect({ ...profile, syscalls: [] }).toEqual({ ...base, syscalls: [] });
  });
  const seccomp = `seccomp=${compactProfile(bytes)}`;
  it("the attempt's SecurityOpt passes exactly with both entries, in either order", () => {
    expect(securityOptProblems("attempt", ["no-new-privileges", seccomp])).toEqual([]);
    expect(securityOptProblems("attempt", [seccomp, "no-new-privileges"])).toEqual([]);
    expect(securityOptProblems("other", ["no-new-privileges"])).toEqual([]);
  });
  it.each([
    ["seccomp unconfined", ["no-new-privileges", "seccomp=unconfined"]],
    ["no profile", ["no-new-privileges"]],
    ["a changed profile", ["no-new-privileges", `${seccomp} `]],
    ["two profiles", ["no-new-privileges", seccomp, seccomp]],
    ["no no-new-privileges", [seccomp]],
    ["apparmor unconfined", ["no-new-privileges", seccomp, "apparmor=unconfined"]],
    ["no-new-privileges twice", ["no-new-privileges", "no-new-privileges", seccomp]],
    ["nothing", []],
  ])("the attempt refuses %s", (_n, opts) => {
    expect(securityOptProblems("attempt", opts).length).toBeGreaterThan(0);
  });
  it.each([
    ["the narrow profile", ["no-new-privileges", seccomp]],
    ["seccomp unconfined", ["no-new-privileges", "seccomp=unconfined"]],
    ["nothing", []],
  ])("another role refuses %s", (_n, opts) => {
    expect(securityOptProblems("other", opts).length).toBeGreaterThan(0);
  });
});

describe("the launch argv and the images", () => {
  const value = (args: readonly string[], flag: string): string[] => args.flatMap((a, i) => (a === flag ? [args[i + 1]!] : []));
  const attempt = attemptRunArgs("x", "img", 12600);
  const proxy = proxyRunArgs("x", "pimg", { ALLOW: "a.test:443", EXPIRY_MS: "1000" });
  it("the attempt keeps --init as PID 1 with the supervisor as its child and a fixed entrypoint", () => {
    expect(attempt).toContain("--init");
    expect(value(attempt, "--entrypoint")).toEqual(["node"]);
    expect(attempt.slice(-3)).toEqual(["img", "/opt/eval/sup.mjs", "12600"]);
  });
  it("the attempt has no network and exactly the project and read-only socket mounts", () => {
    expect(value(attempt, "--network")).toEqual(["none"]);
    expect(value(attempt, "--mount")).toEqual(["type=volume,source=t538-att-x,target=/vol/att", "type=volume,source=t538-sock-x,target=/vol/sock,readonly"]);
    for (const absent of ["--publish", "-p", "--dns", "--add-host", "--privileged", "--cap-add", "--volumes-from", "--device", "--pid", "--ipc", "--uts", "--userns", "-e", "--env"]) expect(attempt, absent).not.toContain(absent);
  });
  it("the attempt runs section 4's limits and the narrow profile", () => {
    expect(value(attempt, "--user")).toEqual(["1001:1001"]);
    expect(attempt).toContain("--read-only");
    expect(value(attempt, "--cap-drop")).toEqual(["ALL"]);
    expect(value(attempt, "--security-opt")).toEqual(["no-new-privileges", `seccomp=${join(DIR, "seccomp-attempt.json")}`]);
    expect([value(attempt, "--memory"), value(attempt, "--memory-swap"), value(attempt, "--pids-limit"), value(attempt, "--cpus")].flat()).toEqual(["2g", "2g", "512", "2"]);
    expect(value(attempt, "--tmpfs")).toEqual(["/tmp:rw,noexec,nosuid,nodev,size=256m"]);
    expect(value(attempt, "--restart")).toEqual(["no"]);
    expect(value(attempt, "--label")).toEqual(["cpm-t538-attempt=x", "cpm-t538-role=attempt"]);
  });
  it("the proxy has its external network, its two mounts with no copy-up of the log, and no published port", () => {
    expect(proxy).toContain("--init");
    expect(value(proxy, "--network")).toEqual(["t538-ext-x"]);
    expect(value(proxy, "--mount")).toEqual(["type=volume,source=t538-sock-x,target=/vol/sock", "type=volume,source=t538-plog-x,target=/vol/proxy,volume-nocopy=true"]);
    expect(value(proxy, "--user")).toEqual(["10001:1001"]);
    expect(value(proxy, "--security-opt")).toEqual(["no-new-privileges"]);
    expect([value(proxy, "--memory"), value(proxy, "--memory-swap"), value(proxy, "--pids-limit"), value(proxy, "--cpus")].flat()).toEqual(["128m", "128m", "64", "1"]);
    expect(value(proxy, "--env")).toEqual(["ALLOW=a.test:443", "EXPIRY_MS=1000"]);
    expect(value(proxy, "--entrypoint")).toEqual(["node"]);
    expect(proxy.slice(-2)).toEqual(["pimg", "/opt/proxy.mjs"]);
    for (const absent of ["--publish", "-p", "--dns", "--add-host", "--privileged", "--cap-add"]) expect(proxy, absent).not.toContain(absent);
  });
  it("the volume setup is deterministic: fixed owner, folder 0750, no copy-up", () => {
    const init = volumeInitArgs("x", "pimg");
    expect(init.at(-1)).toBe("chown 10001:1001 /vol/sock /vol/proxy && chmod 750 /vol/sock && chmod 700 /vol/proxy");
    expect(value(init, "--cap-add")).toEqual(["CHOWN", "FOWNER"]);
    expect(value(init, "--mount")[1]).toContain("volume-nocopy=true");
  });
  it("both images pin the same base digest, the attempt's carries procps and the pinned client, and neither has a socket folder", () => {
    const attemptFile = readFileSync(join(DIR, "Dockerfile"), "utf8");
    const proxyImage = readFileSync(join(DIR, "proxy.Dockerfile"), "utf8");
    for (const text of [attemptFile, proxyImage]) {
      expect(text).toContain(`FROM ${BASE_IMAGE}\n`);
      expect(text).not.toContain("/vol/sock");
      expect(text).not.toContain("/vol/proxy");
    }
    expect(attemptFile).toMatch(/apt-get install[^\n]* procps /);
    expect(attemptFile).toContain("@openai/codex@0.163.0");
    expect(attemptFile.trimEnd().endsWith("USER eval")).toBe(true);
  });
});
