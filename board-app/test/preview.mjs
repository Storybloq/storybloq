import { mkdir, readFile, writeFile } from "node:fs/promises";
import { embedBrandAssets } from "../brand-assets.mjs";
import { createServer } from "node:http";
let html;
if (process.argv.includes("--serve-built")) {
  // Serve one generated fixture through HTTP without a browser file URL.
  html = await readFile("dist/preview.html", "utf8");
} else {
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: ["test/preview.ts"],
    bundle: true,
    format: "esm",
    minify: true,
    write: false,
  });
  html = (
    await embedBrandAssets(await readFile("src/app.html", "utf8"))
  ).replace(
    "<!-- APP -->",
    () =>
      `<script type="module">${result.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`,
  );
  // Persist the fixture-only build so lease expiry does not discard visual work.
  await mkdir("dist", { recursive: true });
  await writeFile("dist/preview.html", html);
}
if (process.argv.includes("--build-only")) {
  console.log("Fixture-only preview built: dist/preview.html");
  process.exit(0);
}
createServer((req, res) => {
  if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/") {
    res.writeHead(404).end();
    return;
  }
  res
    .writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    })
    .end(html);
}).listen(4173, "127.0.0.1", () =>
  console.log("Fixture-only preview: http://127.0.0.1:4173"),
);
