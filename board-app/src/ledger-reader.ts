import { lstat, opendir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TicketSchema } from "../../src/models/ticket.js";
import { IssueSchema } from "../../src/models/issue.js";
import { NoteSchema } from "../../src/models/note.js";
import { displayIdOf } from "../../src/core/resolver.js";
import { ConfigSchema } from "../../src/models/config.js";
import { RoadmapSchema } from "../../src/models/roadmap.js";
import { ProjectState } from "../../src/core/project-state.js";
import { MAX_SUPPORTED_SCHEMA_VERSION } from "../../src/core/errors.js";

import { BoardError } from "./errors.js";
import { readStampedText, fileStamp } from "./safe-files.js";
export { BoardError } from "./errors.js";

export interface ReadScope {
  files(dir: string, extension: string): Promise<string[]>;
  text(dir: string, name: string): Promise<string>;
  optionalText(name: string): Promise<string | undefined>;
  fileBytes(dir: string, name: string): number;
  totalBytes(): number;
}
function fail(message: string): never {
  throw new BoardError(message);
}
const stamp = fileStamp;
async function noJournal(base: string) {
  try {
    await lstat(join(base, ".txn.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  fail(
    "A Storybloq transaction is pending. Finish or recover it locally, then refresh.",
  );
}
/** The proof retains only bounded filesystem metadata, never the loaded ledger. */
function snapshotProof(
  base: string,
  stamps: Map<string, string>,
  absent: Set<string>,
) {
  const observed = new Map(stamps),
    missing = new Set(absent);
  return async () => {
    await noJournal(base);
    for (const path of missing) {
      try {
        await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      fail("The project changed while loading. Refresh to try again.");
    }
    for (const [path, value] of observed)
      if (stamp(await lstat(path, { bigint: true })) !== value)
        fail("The project changed while loading. Refresh to try again.");
    await noJournal(base);
  };
}
/** Internal trusted-root reader. Never put ProjectState or ReadScope on the wire. */
export async function readLedger<T>(
  root: string,
  project: (state: ProjectState, scope: ReadScope) => Promise<T> | T,
): Promise<T> {
  return (await readLedgerSnapshot(root, project)).value;
}
export async function readLedgerSnapshot<T>(
  root: string,
  project: (state: ProjectState, scope: ReadScope) => Promise<T> | T,
): Promise<{ value: T; revalidate: () => Promise<void> }> {
  try {
    const rootStat = await lstat(resolve(root));
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      fail("The project root must be a real directory.");
    const base = join(await realpath(resolve(root)), ".story");
    const stamps = new Map<string, string>();
    const sizes = new Map<string, number>();
    let bytes = 0;
    let count = 0;
    async function checkDir(path: string) {
      const s = await lstat(path, { bigint: true });
      if (!s.isDirectory() || s.isSymbolicLink())
        fail(
          "The project must use real ledger directories, not symbolic links.",
        );
      stamps.set(path, stamp(s));
    }
    async function text(path: string) {
      const result = await readStampedText(
        path,
        1048576,
        (size) => {
          if (bytes + size > 32 * 1024 * 1024)
            fail("This project exceeds the 32 MiB prototype limit.");
          bytes += size;
        },
        {
          limit:
            "A ledger file is not a regular file or exceeds the 1 MiB prototype limit.",
          utf8: "A ledger file contains invalid UTF-8. Repair it locally before editing.",
        },
      );
      stamps.set(path, result.stamp);
      sizes.set(path, result.bytes);
      return result.text;
    }
    const json = async (path: string) => JSON.parse(await text(path));
    const absent = new Set<string>();
    async function optionalText(name: string) {
      const path = join(base, name);
      try {
        await lstat(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        absent.add(path);
        return undefined;
      }
      return text(path);
    }
    async function files(dir: string, extension: string) {
      const path = join(base, dir);
      try {
        await checkDir(path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        absent.add(path);
        return [];
      }
      const result: string[] = [];
      for await (const entry of await opendir(path)) {
        if (++count > 10000)
          fail("This project exceeds the 10,000 entry prototype limit.");
        if (entry.name.startsWith(".") || !entry.name.endsWith(extension))
          continue;
        const full = join(path, entry.name),
          stat = await lstat(full, { bigint: true });
        if (!stat.isFile() || stat.isSymbolicLink())
          fail("The ledger must use regular files, not symbolic links.");
        stamps.set(full, stamp(stat));
        result.push(entry.name);
      }
      return result;
    }
    async function items<T>(
      dir: string,
      schema: { parse: (v: unknown) => T },
      optional = false,
    ): Promise<T[]> {
      const path = join(base, dir);
      try {
        await checkDir(path);
      } catch (error) {
        if (!optional || (error as NodeJS.ErrnoException).code !== "ENOENT")
          throw error;
        absent.add(path);
        return [];
      }
      const result: T[] = [];
      const entries = await opendir(path);
      for await (const e of entries) {
        if (++count > 10000)
          fail("This project exceeds the 10,000 entry prototype limit.");
        if (!e.name.endsWith(".json")) continue;
        const item = schema.parse(await json(join(path, e.name))) as T & {
          id: string;
        };
        if (e.name !== item.id + ".json")
          fail(
            "A ledger filename does not match its identity. Repair it locally before editing.",
          );
        result.push(item);
      }
      return result;
    }
    await checkDir(base);
    await noJournal(base);
    const config = ConfigSchema.parse(await json(join(base, "config.json")));
    if ((config.schemaVersion ?? 1) > MAX_SUPPORTED_SCHEMA_VERSION)
      fail("This ledger needs a newer Storybloq plugin.");
    const roadmap = RoadmapSchema.parse(await json(join(base, "roadmap.json")));
    if (roadmap.phases.length > 200)
      fail("This project exceeds the 200 phase prototype limit.");
    if (new Set(roadmap.phases.map((p) => p.id)).size !== roadmap.phases.length)
      fail("Duplicate phase identities need local repair.");
    const tickets = await items("tickets", TicketSchema),
      issues = await items("issues", IssueSchema),
      notes = await items("notes", NoteSchema, true);
    for (const group of [tickets, issues, notes]) {
      const ids = new Set<string>();
      for (const item of group) {
        if (item.id.length > 80)
          fail("A ledger identity exceeds the 80 character selector limit.");
        if (ids.has(item.id))
          fail("Duplicate ledger identities need local repair.");
        ids.add(item.id);
        if (item._conflicts?.length)
          fail("Resolve the ledger merge conflicts locally, then refresh.");
      }
    }
    const noteLabels = new Set<string>();
    for (const note of notes) {
      const label = displayIdOf(note).trim() || note.id;
      if (noteLabels.has(label))
        fail("Duplicate note identities need local reconciliation.");
      noteLabels.add(label);
    }
    const state = new ProjectState({
      config,
      roadmap,
      tickets,
      issues,
      notes,
      lessons: [],
      handoverFilenames: [],
    });
    const result = await project(state, {
      files,
      text: (dir, name) => text(join(base, dir, name)),
      optionalText,
      fileBytes: (dir, name) => {
        const size = sizes.get(join(base, dir, name));
        if (size === undefined)
          fail("The selected record was not read safely.");
        return size;
      },
      totalBytes: () => bytes,
    });
    // The callback may have read additional files. Publish only its final read set.
    const revalidate = snapshotProof(base, stamps, absent);
    await revalidate();
    return { value: result, revalidate };
  } catch (e) {
    if (e instanceof BoardError) throw e;
    fail(
      "Unable to read this ledger. Check local permissions, symbolic links, and JSON validity, then refresh.",
    );
  }
}
