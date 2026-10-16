import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { embedBrandAssets } from "../brand-assets.mjs";

const root = new URL("../", import.meta.url);
const inventory = JSON.parse(
  await readFile(new URL("assets/manifest.json", root), "utf8"),
);

test("shipped JavaScript stays within the browser payload budget", async () => {
  const html = await readFile(new URL("dist/board.html", root), "utf8");
  const dom = new JSDOM(html);
  try {
    const script = dom.window.document.querySelector('script[type="module"]');
    assert.ok(script, "production module exists");
    const bytes = Buffer.byteLength(script.textContent);
    assert.ok(
      bytes < 800000,
      `browser JavaScript is ${bytes} bytes (budget: 800000)`,
    );
  } finally {
    dom.window.close();
  }
});

test("production resource delivers the exact website fonts and wordmarks offline", async () => {
  const html = await readFile(new URL("dist/board.html", root), "utf8");
  for (const asset of inventory) {
    const bytes = await readFile(new URL(`assets/${asset.path}`, root));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      asset.sha256,
    );
    assert.ok(
      html.includes(bytes.toString("base64")),
      `missing embedded ${asset.path}`,
    );
    assert.equal(
      html.split(bytes.toString("base64")).length - 1,
      1,
      `duplicate embedded ${asset.path}`,
    );
    if (asset.license) {
      assert.ok(
        html.includes(
          await readFile(new URL(`assets/${asset.license.path}`, root), "utf8"),
        ),
      );
      assert.ok(html.includes(asset.copyright));
    }
  }
  assert.doesNotMatch(html, /__WORDMARK_|<!-- BRAND ASSETS -->/);
  assert.doesNotMatch(
    html,
    /(?:src|href)=["']https:\/\/(?:fonts\.googleapis|fonts\.gstatic)/,
  );
});

test("production and preview carry the identical self-contained brand pack", async () => {
  await promisify(execFile)(
    process.execPath,
    ["test/preview.mjs", "--build-only"],
    {
      cwd: fileURLToPath(root),
    },
  );
  const production = await readFile(new URL("dist/board.html", root), "utf8");
  const preview = await readFile(new URL("dist/preview.html", root), "utf8");
  const brandStyle = (html) =>
    html.match(/<style id="story-brand-assets">[\s\S]*?<\/style>/)?.[0];
  assert.ok(brandStyle(production), "production must include brand CSS");
  assert.equal(brandStyle(preview), brandStyle(production));
  for (const image of inventory.filter((asset) => asset.kind === "image")) {
    assert.ok(
      preview.includes(
        (await readFile(new URL(`assets/${image.path}`, root))).toString(
          "base64",
        ),
      ),
    );
  }
});

test("overlapping embedding calls own their output and reject invalid placeholders", async () => {
  const template = await readFile(new URL("src/app.html", root), "utf8");
  const [first, second] = await Promise.all([
    embedBrandAssets(template),
    embedBrandAssets(template),
  ]);
  assert.equal(first, second);
  await assert.rejects(
    embedBrandAssets(template.replace("<!-- BRAND ASSETS -->", "")),
    /Expected exactly one brand placeholder/,
  );
  await assert.rejects(
    embedBrandAssets(template + "__WORDMARK_LIGHT__"),
    /Expected exactly one brand placeholder/,
  );
});

test("changed or missing inputs fail before any HTML can be emitted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "story-brand-"));
  try {
    await cp(new URL("assets", root), join(directory, "assets"), {
      recursive: true,
    });
    await cp(
      new URL("brand-assets.mjs", root),
      join(directory, "brand-assets.mjs"),
    );
    const { embedBrandAssets: isolatedEmbed } = await import(
      pathToFileURL(join(directory, "brand-assets.mjs")).href
    );
    const template = await readFile(new URL("src/app.html", root), "utf8");
    const fontPath = join(directory, "assets", inventory[0].path);
    const original = await readFile(fontPath);
    const changed = Buffer.from(original);
    changed[changed.length - 1] ^= 1;
    await writeFile(fontPath, changed);
    await assert.rejects(
      isolatedEmbed(template),
      /Brand asset does not match manifest/,
    );
    await writeFile(fontPath, original);
    const licensePath = join(directory, "assets", inventory[0].license.path);
    await writeFile(licensePath, "Incomplete license");
    await assert.rejects(
      isolatedEmbed(template),
      /Brand asset does not match manifest/,
    );
    await rm(licensePath);
    await assert.rejects(isolatedEmbed(template), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generated production and preview modules preserve bundled bytes and parse", async () => {
  const htmlFor = [
    ["dist/board.html", "src/app.ts"],
    ["dist/preview.html", "test/preview.ts"],
  ];
  for (const [file, entry] of htmlFor) {
    const html = await readFile(new URL(file, root), "utf8");
    const document = new JSDOM(html).window.document;
    assert.equal(
      document.querySelectorAll("#story-brand-assets").length,
      1,
      `${file}: one brand pack`,
    );
    assert.equal(
      document.querySelectorAll("script").length,
      1,
      `${file}: one script`,
    );
    const module = document.querySelector('script[type="module"]');
    assert.ok(module, `${file}: executable module is present`);
    const result = await build({
      absWorkingDir: fileURLToPath(root),
      entryPoints: [entry],
      bundle: true,
      platform: "browser",
      minify: true,
      format: "esm",
      write: false,
      logLevel: "warning",
    });
    const expected = result.outputFiles[0].text.replaceAll(
      "</script",
      "<\\/script",
    );
    const actual = module.textContent;
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    assert.equal(
      digest(actual),
      digest(expected),
      `${file}: embedded bundle bytes were changed`,
    );
    const syntax = spawnSync(
      process.execPath,
      ["--input-type=module", "--check"],
      {
        input: actual,
        encoding: "utf8",
        maxBuffer: 65536,
      },
    );
    assert.equal(
      syntax.status,
      0,
      `${file}: invalid module: ${(syntax.stderr ?? String(syntax.error ?? "")).slice(0, 500)}`,
    );
  }
});
