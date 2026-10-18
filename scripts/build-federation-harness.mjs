// ISS-1393: bundles the test-only loadFederationState harness for the Mac
// app's federation parity test. Run from storybloq/ after `npm run build` and
// before the app suite; the output path defaults to dist-test/ (gitignored).
import { build } from "esbuild";

const outfile = process.argv[2] ?? "dist-test/load-federation-state.mjs";
await build({
  entryPoints: ["test/federation/harness/load-federation-state.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  outfile,
  logLevel: "warning",
});
console.log(outfile);
