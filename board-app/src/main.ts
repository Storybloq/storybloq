import { readFile } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { createLocalServer } from "./local-server.js";
import { captureLocalCliRuntime } from "./local-runtime.js";
import { createBrowserViewer, lazyViewer } from "./local-browser.js";
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
    const localCli =
      local && process.argv.includes("--local-cli-profile-v1")
        ? await captureLocalCliRuntime(import.meta.url)
        : undefined;
    let pinnedRoot: string | undefined;
    const viewer = lazyViewer(async () => {
      if (!pinnedRoot) throw Error("No local project");
      const hostHtml = await readFile(
        new URL("./local-browser.html", import.meta.url),
        "utf8",
      );
      return createBrowserViewer(pinnedRoot, html, hostHtml, localCli);
    });
    const openBrowser = (project: string) => {
      if (pinnedRoot && pinnedRoot !== project)
        throw Error("Project binding changed");
      pinnedRoot = project;
      return viewer.open();
    };
    const server = local
      ? await createLocalServer(process.cwd(), html, localCli, openBrowser)
      : createServer(root!, html, { approvedNodeRoots });
    let closing: Promise<void> | undefined;
    const shutdown = () =>
      (closing ??= (async () => {
        await viewer.close();
        await server.close();
      })());
    process.stdin.once("end", () => {
      void shutdown();
    });
    process.stdin.once("close", () => {
      void shutdown();
    });
    const priorClose = server.server.onclose;
    server.server.onclose = () => {
      priorClose?.();
      void viewer.close();
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        void shutdown().finally(() => {
          process.exitCode = 0;
        });
      });
    await server.connect(new StdioServerTransport());
  } catch {
    process.stderr.write(
      "Storybloq board could not start. Build the plugin and check its configuration.\n",
    );
    process.exitCode = 1;
  }
}
