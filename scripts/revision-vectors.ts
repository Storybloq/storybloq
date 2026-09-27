#!/usr/bin/env tsx
/**
 * Writes `test/fixtures/revision/vectors.json` (T-528): the ledger revision
 * vectors the CLI and the Mac app both pin. Each vector is a small `.story/`
 * tree; the generator materializes it in a temp directory and records what
 * `hashPass` enumerates and what `ledgerRevision` computes over it, so the
 * expected values come from the CLI code, never from a hand-typed hash. A
 * drift test regenerates the file in memory and compares.
 *
 * Usage:
 *   tsx scripts/revision-vectors.ts            # write the file
 *   tsx scripts/revision-vectors.ts --stdout   # print it
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPass, ledgerRevision, LEDGER_REVISION_HEADER, type RevisionEntry } from "../src/core/decisions-projection.js";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const VECTORS_OUT = join(pkgRoot, "test", "fixtures", "revision", "vectors.json");

/** A file with UTF-8 content, or a directory standing where a file is listed (unreadable as a file). */
export type VectorNode = { readonly path: string; readonly content: string } | { readonly path: string; readonly directory: true };

export interface VectorSpec {
  readonly name: string;
  readonly description: string;
  /** Paths relative to `.story/`. */
  readonly nodes: readonly VectorNode[];
}

const TICKET_1 = '{"id":"T-1","title":"Synthetic"}\n';
const TICKET_2 = '{"id":"T-2","title":"Second"}\n';
const ISSUE_1 = '{"id":"ISS-1","title":"Synthetic issue"}\n';
const RULING_1 = '{"id":"r-1111111111111111","text":"Verbatim"}\n';
const CONFIG = '{"version":2,"project":"vectors"}\n';
const BASE: readonly VectorNode[] = [
  { path: "config.json", content: CONFIG },
  { path: "tickets/T-1.json", content: TICKET_1 },
  { path: "issues/ISS-1.json", content: ISSUE_1 },
  { path: "rulings/r-1111111111111111.json", content: RULING_1 },
];

export const VECTOR_SPECS: readonly VectorSpec[] = [
  { name: "empty-ledger", description: "an empty .story/: three absent singletons, no directories", nodes: [] },
  { name: "base", description: "config, one ticket, one issue, one ruling; both catalogs absent", nodes: BASE },
  {
    name: "empty-catalogs",
    description: "base with both catalogs present and zero bytes long: a line with the empty file's hash, not `-`",
    nodes: [...BASE, { path: "capabilities.json", content: "" }, { path: "glossary.json", content: "" }],
  },
  {
    name: "catalogs",
    description: "base with both catalogs holding an empty envelope",
    nodes: [...BASE, { path: "capabilities.json", content: '{"version":1,"capabilities":[]}\n' }, { path: "glossary.json", content: '{"version":1,"terms":[]}\n' }],
  },
  { name: "ticket-added", description: "base plus a second ticket", nodes: [...BASE, { path: "tickets/T-2.json", content: TICKET_2 }] },
  { name: "ticket-deleted", description: "base without its ticket (the directory stays, empty)", nodes: BASE.filter((n) => n.path !== "tickets/T-1.json").concat([{ path: "tickets", directory: true }]) },
  {
    name: "one-byte-edit",
    description: "base with a same-length, one-byte edit to the ticket",
    nodes: BASE.map((n) => (n.path === "tickets/T-1.json" ? { path: n.path, content: TICKET_1.replace("Synthetic", "Synthetik") } : n)),
  },
  {
    name: "nfd-name",
    description: "a ruling whose file name is written in NFD; the revision line carries the NFC form",
    nodes: [...BASE, { path: "rulings/Café.json", content: RULING_1 }],
  },
  {
    name: "utf8-order",
    description: "rulings named .json, U+E000.json and U+10000.json: UTF-8 byte order puts U+E000 before U+10000, UTF-16 code-unit order the reverse",
    nodes: [...BASE, { path: "rulings/.json", content: RULING_1 }, { path: "rulings/\uE000.json", content: RULING_1 }, { path: "rulings/\u{10000}.json", content: RULING_1 }],
  },
  {
    name: "non-json-ignored",
    description: "base plus a non-JSON file in tickets/ and a JSON file in an unlisted directory; neither is an input",
    nodes: [...BASE, { path: "tickets/README.md", content: "notes\n" }, { path: "notes/N-1.json", content: '{"id":"N-1"}\n' }],
  },
  {
    name: "unreadable-entry",
    description: "base plus a directory named like a ticket file: unreadable, so the revision is null",
    nodes: [...BASE, { path: "tickets/T-5.json", directory: true }],
  },
];

export interface Vector extends VectorSpec {
  readonly entries: readonly RevisionEntry[];
  readonly revision: string | null;
}

/** Materialize a spec under `root/.story/`. Exported so the drift test and the Swift loader test build the same tree. */
export function materialize(root: string, nodes: readonly VectorNode[]): void {
  const storyDir = join(root, ".story");
  mkdirSync(storyDir, { recursive: true });
  for (const n of nodes) {
    const abs = join(storyDir, n.path);
    if ("directory" in n) {
      mkdirSync(abs, { recursive: true });
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, n.content);
    }
  }
}

export function buildVectors(): Vector[] {
  return VECTOR_SPECS.map((spec) => {
    const root = mkdtempSync(join(tmpdir(), "revision-vector-"));
    try {
      materialize(root, spec.nodes);
      // Reasons are the local OS's wording; the vectors carry the kind only.
      const entries = hashPass(root).map((e) => ({ path: e.path, state: e.state.kind === "unreadable" ? { kind: "unreadable" as const, reason: "" } : e.state }));
      return { ...spec, entries, revision: ledgerRevision(entries) };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

export function serializeVectors(): string {
  return `${JSON.stringify({ schemaVersion: 1, header: LEDGER_REVISION_HEADER, vectors: buildVectors() }, null, 2)}\n`;
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isMain) {
  const output = serializeVectors();
  if (process.argv.includes("--stdout")) {
    process.stdout.write(output);
  } else {
    mkdirSync(dirname(VECTORS_OUT), { recursive: true });
    writeFileSync(VECTORS_OUT, output);
    process.stderr.write(`wrote ${VECTORS_OUT}\n`);
  }
}
