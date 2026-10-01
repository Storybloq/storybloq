import { createServer } from "node:http";
import { listBooks, addBook } from "./books.js";

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/books") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(listBooks()));
    return;
  }
  if (req.method === "POST" && req.url === "/books") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const book = addBook(JSON.parse(body));
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify(book));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(process.env.PORT ?? 3000);
