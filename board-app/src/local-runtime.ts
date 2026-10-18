import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface LocalCliRuntime {
  version: 1;
  command: string;
  args: [string, "--local-cli"];
  package: "@storybloq/storybloq";
  sha256: string;
}

/** Only the new packaged CLI launcher supplies this marker. No shell PATH lookup. */
export async function captureLocalCliRuntime(serverUrl: string): Promise<LocalCliRuntime> {
  const root = resolve(dirname(await realpath(fileURLToPath(serverUrl))), "../..");
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (manifest.name !== "@storybloq/storybloq") throw new Error("Invalid local runtime package");
  const entry = await realpath(join(root, "dist/cli.js"));
  const bytes = await readFile(entry);
  return {
    version: 1,
    command: await realpath(process.execPath),
    args: [entry, "--local-cli"],
    package: "@storybloq/storybloq",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
