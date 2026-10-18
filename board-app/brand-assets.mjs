import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import inventory from "./assets/manifest.json" with { type: "json" };

const latinRange =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";

async function readAsset(asset) {
  const bytes = await readFile(
    new URL(`./assets/${asset.path}`, import.meta.url),
  );
  if (
    bytes.length !== asset.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== asset.sha256
  ) {
    throw new Error(`Brand asset does not match manifest: ${asset.path}`);
  }
  const signature =
    asset.kind === "font"
      ? Buffer.from("wOF2")
      : asset.kind === "image"
        ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
        : null;
  if (signature && !bytes.subarray(0, signature.length).equals(signature)) {
    throw new Error(`Invalid brand asset signature: ${asset.path}`);
  }
  return bytes;
}

function replaceToken(html, token, value) {
  if (html.split(token).length !== 2) {
    throw new Error(`Expected exactly one brand placeholder: ${token}`);
  }
  return html.replace(token, () => value);
}

// Each invocation owns validated buffers, so concurrent builds never share mutable state.
export async function embedBrandAssets(template) {
  const assets = await Promise.all(
    inventory.map(async (asset) => ({
      ...asset,
      bytes: await readAsset(asset),
      licenseText: asset.license
        ? (await readAsset(asset.license)).toString("utf8")
        : null,
    })),
  );
  const css = assets
    .filter((asset) => asset.kind === "font")
    .map((asset) => {
      const notice = `${asset.copyright}\n${asset.licenseText}`;
      if (notice.includes("*/") || /<\/style/i.test(notice)) {
        throw new Error(`Unsafe font notice: ${asset.path}`);
      }
      return `/* ${notice}\n*/\n@font-face { font-family: "${asset.family}"; font-style: normal; font-weight: ${asset.weight}; font-display: swap; src: url(data:font/woff2;base64,${asset.bytes.toString("base64")}) format("woff2"); unicode-range: ${latinRange}; }`;
    })
    .join("\n");
  let html = replaceToken(
    template,
    "<!-- BRAND ASSETS -->",
    `<style id="story-brand-assets">${css}</style>`,
  );
  for (const asset of assets.filter((asset) => asset.kind === "image")) {
    html = replaceToken(
      html,
      `__WORDMARK_${asset.theme.toUpperCase()}__`,
      `data:image/png;base64,${asset.bytes.toString("base64")}`,
    );
  }
  return html;
}
