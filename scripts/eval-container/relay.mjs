// T-538 relay (amendment A1): 127.0.0.1:3128 to the proxy's unix socket. One stream per
// connection, no retries, half-close kept, payloads never logged. Not a security boundary:
// a tool can reach the socket directly, so the proxy enforces everything.
import net from "node:net";
import { pathToFileURL } from "node:url";

export function startRelay({ port, sockPath }) {
  const srv = net.createServer({ allowHalfOpen: true, pauseOnConnect: true }, (c) => {
    const u = net.connect({ path: sockPath, allowHalfOpen: true });
    c.on("error", () => u.destroy());
    u.on("error", () => c.destroy());
    u.on("connect", () => {
      c.pipe(u);
      u.pipe(c);
      c.resume();
    });
    c.on("close", () => u.destroy());
    u.on("close", () => c.destroy());
  });
  srv.listen(port, "127.0.0.1");
  return srv;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startRelay({ port: 3128, sockPath: "/vol/sock/proxy.sock" });
