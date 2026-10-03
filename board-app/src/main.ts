import { readFile } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { createLocalServer } from "./local-server.js";
const local = process.argv.includes("--local");
const root = process.env.STORYBLOQ_PROJECT_ROOT;
if (!local && !root) {
  process.stderr.write(
    "Set STORYBLOQ_PROJECT_ROOT to the project you intend to share.\n",
  );
  process.exitCode = 1;
} else {
  try {
    const html = await readFile(
      new URL("./board.html", import.meta.url),
      "utf8",
    );
    const approvedNodeRoots: unknown = local
      ? []
      : JSON.parse(process.env.STORYBLOQ_APPROVED_NODE_ROOTS ?? "[]");
    if (
      !Array.isArray(approvedNodeRoots) ||
      approvedNodeRoots.length > 200 ||
      !approvedNodeRoots.every((v) => typeof v === "string")
    )
      throw new Error("Invalid startup roots");
    const server = local
      ? await createLocalServer(process.cwd(), html)
      : createServer(root!, html, { approvedNodeRoots });
    await server.connect(new StdioServerTransport());
  } catch {
    process.stderr.write(
      "Storybloq board could not start. Build the plugin and check its configuration.\n",
    );
    process.exitCode = 1;
  }
}
