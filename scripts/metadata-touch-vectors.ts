#!/usr/bin/env tsx
/**
 * Writes `test/fixtures/metadata-touch-vectors.json` (ISS-1388): pairs of raw
 * ticket or issue JSON texts, with whether T-481's `touchUpdated` stamps
 * `updatedDate` when the second replaces the first, plus a corpus of texts
 * with whether `JSON.parse` accepts them. The Mac app's writer reads the same
 * texts and must decide the same way. Every expected value comes from the CLI
 * code; a drift test regenerates the file in memory and compares.
 *
 * Texts are kept as raw JSON (and as base64 of their UTF-8 bytes, which is
 * what the Swift side reads), so number spellings, escapes, both Unicode
 * normalisation forms of a key, duplicate keys and `__proto__` all survive.
 *
 * Usage:
 *   tsx scripts/metadata-touch-vectors.ts            # write the file
 *   tsx scripts/metadata-touch-vectors.ts --stdout   # print it
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contentProjection, touchUpdated } from "../src/core/metadata-touch.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const VECTORS_OUT = join(pkgRoot, "test", "fixtures", "metadata-touch-vectors.json");

/** The stamp date; no case text contains it, so finding it in the result means the write stamped. */
export const STAMP = "2026-03-09";

export interface TouchCase {
  readonly name: string;
  /** The record on disk before the write, or null for a create. */
  readonly prior: string | null;
  /** The record the write produces, before any stamp. */
  readonly next: string;
}

const NFC = "é";
const NFD = "é";

/** A ticket's text with `body` spliced in after its fixed keys. */
const t = (body = "") =>
  `{"id":"T-001","title":"A","description":"","type":"task","status":"open","phase":"p1","order":10,` +
  `"createdDate":"2026-01-01","completedDate":null,"blockedBy":[]${body}}`;
/** An issue's text with `body` spliced in. */
const iss = (body = "") =>
  `{"id":"ISS-001","title":"B","status":"open","severity":"medium","components":[],"impact":"",` +
  `"resolution":null,"location":[],"discoveredDate":"2026-01-01","resolvedDate":null,"relatedTickets":[]${body}}`;

export const CASES: readonly TouchCase[] = [
  // No stamp: only non-content keys, or the loader's displayId fill, or key order.
  { name: "updatedDate only", prior: t(), next: t(`,"updatedDate":"2026-02-02"`) },
  { name: "updatedDate changed", prior: t(`,"updatedDate":"2026-02-01"`), next: t(`,"updatedDate":"2026-02-02"`) },
  { name: "earmark only", prior: t(), next: t(`,"earmark":{"holder":"w8","at":"2026-02-02T00:00:00Z"}`) },
  { name: "sweepAcquisition only", prior: t(), next: t(`,"sweepAcquisition":{"by":"sweep"}`) },
  { name: "all three non-content keys", prior: t(), next: t(`,"updatedDate":"2026-02-02","earmark":{"holder":"w8"},"sweepAcquisition":{"by":"s"}`) },
  { name: "displayId null vs filled", prior: t(`,"displayId":null`), next: t(`,"displayId":"T-001"`) },
  { name: "displayId absent vs filled", prior: t(), next: t(`,"displayId":"T-001"`) },
  { name: "top-level key order", prior: `{"id":"T-001","title":"A","status":"open"}`, next: `{"status":"open","title":"A","id":"T-001"}` },
  { name: "nested key order", prior: t(`,"claim":{"by":"w8","at":"x"}`), next: t(`,"claim":{"at":"x","by":"w8"}`) },
  { name: "issue updatedDate only", prior: iss(), next: iss(`,"updatedDate":"2026-02-02"`) },
  // Stamp: content changed.
  { name: "title change", prior: t(), next: t().replace(`"title":"A"`, `"title":"A2"`) },
  { name: "status change", prior: t(), next: t().replace(`"status":"open"`, `"status":"inprogress"`) },
  { name: "earmark plus claim change", prior: t(`,"claim":{"by":"a"}`), next: t(`,"claim":{"by":"b"},"earmark":{"holder":"w8"}`) },
  { name: "null vs absent content key", prior: t(`,"parentTicket":null`), next: t() },
  { name: "unknown passthrough key added", prior: t(), next: t(`,"priority":2`) },
  { name: "displayId differs from id", prior: t(), next: t(`,"displayId":"T-999"`) },
  { name: "issue status change", prior: iss(), next: iss().replace(`"status":"open"`, `"status":"resolved"`) },
  // Number and text forms.
  { name: "1 vs 1.0", prior: t(`,"x":1`), next: t(`,"x":1.0`) },
  { name: "1 vs true", prior: t(`,"x":1`), next: t(`,"x":true`) },
  { name: "0 vs false", prior: t(`,"x":0`), next: t(`,"x":false`) },
  { name: "2^53+1 vs 2^53", prior: t(`,"x":9007199254740993`), next: t(`,"x":9007199254740992`) },
  { name: "1e2 vs 100", prior: t(`,"x":1e2`), next: t(`,"x":100`) },
  { name: "-0 vs 0", prior: t(`,"x":-0`), next: t(`,"x":0`) },
  { name: "slash vs escaped slash", prior: t(`,"x":"/"`), next: t(`,"x":"\\/"`) },
  { name: "NFC vs NFD value", prior: t(`,"x":"${NFC}"`), next: t(`,"x":"${NFD}"`) },
  { name: "NFC vs NFD lone key", prior: t(`,"${NFC}":1`), next: t(`,"${NFD}":1`) },
  // NFC and NFD keys in the same object.
  { name: "both forms, NFC value changed", prior: t(`,"${NFC}":1,"${NFD}":2`), next: t(`,"${NFC}":3,"${NFD}":2`) },
  { name: "both forms, NFD value changed", prior: t(`,"${NFC}":1,"${NFD}":2`), next: t(`,"${NFC}":1,"${NFD}":3`) },
  { name: "both forms, order swapped", prior: t(`,"${NFC}":1,"${NFD}":2`), next: t(`,"${NFD}":2,"${NFC}":1`) },
  { name: "both forms nested, NFC value changed", prior: t(`,"claim":{"${NFC}":1,"${NFD}":2}`), next: t(`,"claim":{"${NFC}":3,"${NFD}":2}`) },
  { name: "both forms nested, NFD value changed", prior: t(`,"claim":{"${NFC}":1,"${NFD}":2}`), next: t(`,"claim":{"${NFC}":1,"${NFD}":3}`) },
  { name: "both forms nested, order swapped", prior: t(`,"claim":{"${NFC}":1,"${NFD}":2}`), next: t(`,"claim":{"${NFD}":2,"${NFC}":1}`) },
  // __proto__ is ordinary content.
  { name: "__proto__ added", prior: t(), next: t(`,"__proto__":{"x":1}`) },
  { name: "__proto__ unchanged", prior: t(`,"__proto__":{"x":1}`), next: t(`,"__proto__":{"x":1}`) },
  { name: "__proto__ changed", prior: t(`,"__proto__":{"x":1}`), next: t(`,"__proto__":{"x":2}`) },
  { name: "nested __proto__ added", prior: t(`,"claim":{"by":"a"}`), next: t(`,"claim":{"by":"a","__proto__":{"x":1}}`) },
  { name: "nested __proto__ unchanged", prior: t(`,"claim":{"__proto__":{"x":1}}`), next: t(`,"claim":{"__proto__":{"x":1}}`) },
  { name: "nested __proto__ changed", prior: t(`,"claim":{"__proto__":{"x":1}}`), next: t(`,"claim":{"__proto__":{"x":2}}`) },
  // Duplicate keys: the last wins.
  { name: "duplicate key, last wins", prior: t().replace(`"title":"A"`, `"title":"Z","title":"A"`), next: t() },
  { name: "escaped duplicate key, last wins", prior: t().replace(`"title":"A"`, `"title":"Z","\\u0074itle":"A"`), next: t() },
  // Non-finite numbers.
  { name: "overflow vs null", prior: t(`,"x":1e400`), next: t(`,"x":null`) },
  { name: "overflow vs negative overflow", prior: t(`,"x":1e400`), next: t(`,"x":-1e400`) },
  { name: "overflow in an array vs null", prior: t(`,"x":[1,1e400]`), next: t(`,"x":[1,null]`) },
  { name: "negative underflow vs 0", prior: t(`,"x":-1e-400`), next: t(`,"x":0`) },
  { name: "overflow vs 1", prior: t(`,"x":1e400`), next: t(`,"x":1`) },
  // Valid text forms.
  { name: "escaped lone surrogate unchanged", prior: t(`,"x":"\\ud800"`), next: t(`,"x":"\\ud800"`) },
  { name: "escaped lone surrogate changed", prior: t(`,"x":"\\ud800"`), next: t(`,"x":"\\udc00"`) },
  { name: "escaped vs literal supplementary character", prior: t(`,"x":"\\ud83d\\ude00"`), next: t(`,"x":"\u{1F600}"`) },
  // A create.
  { name: "create", prior: null, next: t() },
];

/** Texts for the parser: whether `JSON.parse` accepts each. */
export const CORPUS: readonly { readonly name: string; readonly text: string }[] = [
  ...["01", "-01", "00", "-", "1.", ".5", "1e", "1e+", "+1", "0x10", "NaN", "Infinity"].map((n) => ({ name: `number ${n}`, text: `{"a":${n}}` })),
  { name: "trailing comma in object", text: `{"a":1,}` },
  { name: "trailing comma in array", text: `[1,]` },
  { name: "trailing token", text: `{"a":1} x` },
  { name: "two values", text: `{"a":1}{}` },
  { name: "missing comma", text: `[1 2]` },
  ...["\\x", "\\u12", "\\u12G4", "\\'"].map((e) => ({ name: `escape ${e}`, text: `{"a":"${e}"}` })),
  { name: "raw NUL in string", text: `{"a":"\u0000"}` },
  { name: "raw tab in string", text: `{"a":"\t"}` },
  { name: "raw LF in string", text: `{"a":"\n"}` },
  { name: "NBSP between tokens", text: `{"a": 1}` },
  { name: "VT between tokens", text: `{"a":\u000b1}` },
  { name: "FF between tokens", text: `{"a":\u000c1}` },
  { name: "leading BOM", text: `﻿{"a":1}` },
  ...["{", `{"a"`, `{"a":`, `{"a":1`, "[", "[1", `"abc`, "tru", "nul"].map((x) => ({ name: `truncated ${x}`, text: x })),
  { name: "surrounding JSON whitespace", text: ` \t\n\r{"a":1} \t\n\r` },
  { name: "escaped NUL", text: `{"a":"\\u0000"}` },
  { name: "escaped slash", text: `{"a":"\\/"}` },
  { name: "every simple escape", text: `{"a":"\\"\\\\\\/\\b\\f\\n\\r\\t"}` },
  { name: "nested containers", text: `{"a":[{"b":[]},{}],"c":{"d":null,"e":true,"f":false,"g":-1.5e-3}}` },
  { name: "overflowing number", text: `{"a":1e400}` },
];

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

export function buildVectors() {
  const cases = CASES.map((c) => {
    const nextObj = JSON.parse(c.next) as Record<string, unknown>;
    const priorObj = c.prior === null ? null : (JSON.parse(c.prior) as Record<string, unknown>);
    const out = touchUpdated(nextObj, priorObj, STAMP) as Record<string, unknown>;
    return {
      name: c.name,
      prior: c.prior,
      next: c.next,
      priorBase64: c.prior === null ? null : b64(c.prior),
      nextBase64: b64(c.next),
      projectionsEqual: priorObj === null ? null : contentProjection(priorObj) === contentProjection(nextObj),
      stamps: out.updatedDate === STAMP,
    };
  });
  const corpus = CORPUS.map((c) => {
    let accepts = true;
    try { JSON.parse(c.text); } catch { accepts = false; }
    return { name: c.name, text: c.text, textBase64: b64(c.text), accepts };
  });
  return { stamp: STAMP, cases, corpus };
}

export function serializeVectors(): string {
  return JSON.stringify(buildVectors(), null, 2) + "\n";
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--stdout")) process.stdout.write(serializeVectors());
  else writeFileSync(VECTORS_OUT, serializeVectors());
}
