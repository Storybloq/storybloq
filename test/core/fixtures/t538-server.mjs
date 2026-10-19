// T-538 S3b: a start command for VERIFY tests. Usage: node t538-server.mjs <port> <mode>
//   ok           listens on 127.0.0.1:<port>, answers 200 at /health and 404 elsewhere
//   status-500   listens, answers 500
//   close-after  answers 200 once, then closes its listener and stays alive
//   ignore-term  as ok, but ignores SIGTERM
//   exit         exits 3 without listening
import { createServer } from "node:http";

const port = Number(process.argv[2]);
const mode = process.argv[3] ?? "ok";
if (mode === "exit") {
  console.log("exiting before listening");
  process.exit(3);
}
if (mode === "ignore-term") process.on("SIGTERM", () => {});
const server = createServer((req, res) => {
  if (mode === "status-500") {
    res.writeHead(500).end("no");
    return;
  }
  res.writeHead(req.url === "/health" ? 200 : 404).end("ok");
  if (mode === "close-after") server.close();
});
server.listen(port, "127.0.0.1", () => console.log(`listening on ${port}`));
setInterval(() => {}, 1 << 30);
