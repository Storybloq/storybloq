#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { installCodexPlugin } from "./cli/codex-plugin-install.js";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "install") {
  try {
    await installCodexPlugin({
      packageRoot: fileURLToPath(new URL("../", import.meta.url)),
    });
    process.stdout.write(
      "Storybloq is installed in Codex. In a new local Codex task, ask: Open Storybloq for this project.\nAfter updating Storybloq, run storybloq-codex install again and restart existing tasks.\n",
    );
  } catch (error) {
    process.stderr.write(`Storybloq plugin: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
} else {
  process.stdout.write(
    "Usage: storybloq-codex install\nInstall or refresh the local Storybloq Codex plugin. Requires Node 20+ and the Codex CLI.\n",
  );
  if (
    args.length &&
    !(args.length === 1 && ["--help", "-h"].includes(args[0] ?? ""))
  )
    process.exitCode = 2;
}
