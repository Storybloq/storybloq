import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeThirdPartyNotices } from "./third-party-notices.mjs";
import { embedBrandAssets } from "./brand-assets.mjs";
import { generateWriterTypes } from "./writer-api.mjs";
process.chdir(fileURLToPath(new URL(".", import.meta.url)));
const packaged = process.argv.includes("--package");
const output = packaged ? "../dist/board" : "dist";
await generateWriterTypes();
const common = {
  absWorkingDir: process.cwd(),
  bundle: true,
  format: "esm",
  nodePaths: [resolve("node_modules")],
  logLevel: "warning",
  metafile: true,
};
await mkdir(output, { recursive: true });
const browser = await build({
  ...common,
  entryPoints: ["src/app.ts"],
  platform: "browser",
  minify: true,
  write: false,
});
await writeFile(
  `${output}/board.html`,
  (await embedBrandAssets(await readFile("src/app.html", "utf8"))).replace(
    "<!-- APP -->",
    () =>
      `<script type="module">${browser.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`,
  ),
);
const host = await build({
  ...common,
  entryPoints: ["src/local-browser-host.ts"],
  platform: "browser",
  minify: true,
  write: false,
});
await writeFile(
  `${output}/local-browser.html`,
  (await readFile("src/local-browser-host.html", "utf8")).replace(
    "<!-- HOST -->",
    () =>
      `<script type="module">${host.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`,
  ),
);
const server = await build({
  ...common,
  entryPoints: ["src/main.ts"],
  platform: "node",
  ...(packaged
    ? {
        external: [
          "@modelcontextprotocol/sdk",
          "@modelcontextprotocol/sdk/*",
          "canonicalize",
          "proper-lockfile",
        ],
        banner: {
          js: 'import { createRequire as storybloqCreateRequire } from "node:module"; const require = storybloqCreateRequire(import.meta.url);',
        },
      }
    : { packages: "external" }),
  outfile: `${output}/server.js`,
});
if (packaged) {
  await writeThirdPartyNotices(
    [browser.metafile, host.metafile, server.metafile],
    `${output}/THIRD_PARTY_NOTICES.txt`,
  );
} else {
  await mkdir("dist/test", { recursive: true });
  await build({
    ...common,
    entryPoints: [
      "test/board.test.ts",
      "test/local-browser.test.ts",
      "test/local-context.test.ts",
      "test/ui.test.ts",
      "test/history.test.ts",
      "test/federation.test.ts",
      "test/workspace.test.mjs",
      "test/editor.test.ts",
      "test/editor-ui.test.ts",
      "test/notes.test.ts",
      "test/notes-ui.test.ts",
      "test/sessions.test.ts",
      "test/sessions-ui.test.ts",
      "test/session-projection.test.mjs",
      "test/runtime-budget.test.ts",
      "test/performance.ts",
    ],
    platform: "node",
    packages: "external",
    outdir: "dist/test",
  });
}
