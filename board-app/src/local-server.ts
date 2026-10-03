import { captureLocalContext } from "./local-context.js";
import { createServer, createBoardHost } from "./server.js";
import { readBoard } from "./board.js";

/** One stdio connection belongs to one captured local task context. */
export async function createLocalServer(startDir: string, html: string) {
  const context = captureLocalContext(startDir);
  const root = context.resolve();
  if (root) {
    await readBoard(root);
    return createServer(root, html);
  }
  const server = createBoardHost(html);
  let activating: Promise<boolean> | undefined;
  const activate = () => {
    if (!activating) {
      activating = (async () => {
        const detected = context.resolve();
        if (!detected) return false;
        // Do not expose the normal tools while setup is only partially written.
        await readBoard(detected);
        bootstrap.remove();
        createServer(detected, html, {}, server);
        return true;
      })().finally(() => {
        activating = undefined;
      });
    }
    return activating;
  };
  const bootstrap = server.registerTool(
    "storybloq_board",
    {
      title: "Open Storybloq board",
      description:
        "Check this local task for Storybloq. Offer setup when missing; never initialize without the user's setup workflow.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const ready = await activate();
        return {
          content: [
            {
              type: "text" as const,
              text: ready
                ? "Storybloq is ready in this task. Call storybloq_board again to open the project board."
                : "This task has no Storybloq project. Use the Storybloq skill to set it up, then open Storybloq again.",
            },
          ],
          structuredContent: { setupRequired: !ready, ready },
        };
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "The local Storybloq ledger is incomplete or cannot be read. Finish setup or repair it, then open Storybloq again.",
            },
          ],
        };
      }
    },
  );
  return server;
}
