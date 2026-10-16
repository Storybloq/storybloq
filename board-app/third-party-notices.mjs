import { readFile, readdir, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// The bundle's actual inputs determine which vendor licenses must travel with it.
export async function writeThirdPartyNotices(metafiles, destination) {
  const packages = new Map();
  for (const input of metafiles.flatMap((meta) => Object.keys(meta.inputs))) {
    if (!input.includes("node_modules/")) continue;
    let directory = dirname(resolve(input));
    while (directory !== dirname(directory)) {
      try {
        await access(resolve(directory, "package.json"));
        const pkg = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
        if (pkg.name && pkg.version) { packages.set(directory, pkg); break; }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      directory = dirname(directory);
    }
  }
  const notices = [];
  for (const [directory, pkg] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const files = (await readdir(directory)).filter((file) => /^(license|copying|notice)(\.|$)/i.test(file)).sort();
    let text;
    if (!files.length && pkg.name === "@cfworker/json-schema" && pkg.version === "4.1.1") {
      // Its npm tarball omits the license file. Preserve the upstream license.
      text = await Promise.all(["cfworker-MIT.txt", "cfworker-THIRD_PARTY_NOTICES.md"].map((file) => readFile(new URL("./assets/licenses/" + file, import.meta.url), "utf8")));
    } else {
      if (!files.length) throw new Error(`Missing bundled license text for ${pkg.name}`);
      text = await Promise.all(files.map((file) => readFile(resolve(directory, file), "utf8")));
    }
    notices.push(`${pkg.name} ${pkg.version}\nLicense: ${pkg.license ?? "See included text"}\n${text.join("\n")}`);
  }
  await writeFile(destination, notices.join("\n\n"));
}
