/**
 * ISS-1410 test harness, never shipped: sorts the records in the JSON file at
 * argv[2] with the CLI's compareByRank (src/core/fractional-index.ts) and
 * prints the ordered ids. compareByRank is in no built bundle's exports, so
 * scripts/build-federation-harness.mjs bundles this file for the Mac app's
 * rank-order parity rows. Every string crosses as an array of UTF-16 code
 * units, both ways, so no JSON layer can normalize or merge an NFC/NFD pair.
 */
import { readFileSync } from "node:fs";
import { compareByRank } from "../../../src/core/fractional-index.js";

type Units = number[];
interface Input { id: Units; rank?: Units; order?: number }

const file = process.argv[2];
if (!file) {
  process.stderr.write("usage: compare-by-rank <records.json>\n");
  process.exit(2);
}
const text = (u: Units) => String.fromCharCode(...u);
const units = (s: string) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const records = (JSON.parse(readFileSync(file, "utf8")) as Input[]).map((r) => ({
  id: text(r.id),
  ...(r.rank ? { rank: text(r.rank) } : {}),
  ...(r.order !== undefined ? { order: r.order } : {}),
}));
records.sort(compareByRank);
process.stdout.write(JSON.stringify(records.map((r) => units(r.id))));
