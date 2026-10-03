import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { BoardError } from "./errors.js";
import { fileStamp, readStampedText, createReadBudget } from "./safe-files.js";
export interface RuntimeScope {
  text(parts: string[], limit: number): Promise<string | undefined>;
  marker(parts: string[]): Promise<boolean>;
  presenceFiles(): Promise<{ names: string[]; unread: number }>;
}
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
const changed = () =>
  new BoardError(
    "Session records changed while loading. Refresh to try again.",
  );

/** Internal fixed-root scope; no ledger parsing, recovery, process probes or writes. */
export async function readRuntime<T>(
  root: string,
  checkRoot: () => Promise<void>,
  project: (scope: RuntimeScope) => Promise<T>,
): Promise<T> {
  await checkRoot();
  const stamps = new Map<string, string>(),
    absent = new Set<string>(),
    dirs = new Set<string>();
  const reserve = createReadBudget(2 * 1024 * 1024);
  function path(parts: string[]) {
    if (parts.some((p) => !p || p === "." || p === ".." || /[\/\\\0]/.test(p)))
      throw new BoardError("Invalid session record path.");
    return join(root, ".story", ...parts);
  }
  async function directory(parts: string[]) {
    for (let i = 0; i <= parts.length; i++) {
      const current = path(parts.slice(0, i));
      if (dirs.has(current)) continue;
      if (absent.has(current)) return false;
      let s;
      try {
        s = await lstat(current, { bigint: true });
      } catch (e) {
        if (!missing(e)) throw e;
        absent.add(current);
        return false;
      }
      if (!s.isDirectory() || s.isSymbolicLink())
        throw new BoardError(
          "Session directories must be real directories, not symbolic links.",
        );
      stamps.set(current, fileStamp(s));
      dirs.add(current);
    }
    return true;
  }
  async function regular(parts: string[]) {
    if (!(await directory(parts.slice(0, -1)))) return undefined;
    const full = path(parts);
    let s;
    try {
      s = await lstat(full, { bigint: true });
    } catch (e) {
      if (!missing(e)) throw e;
      absent.add(full);
      return undefined;
    }
    if (!s.isFile() || s.isSymbolicLink())
      throw new BoardError(
        "Session records must be regular files, not symbolic links.",
      );
    stamps.set(full, fileStamp(s));
    return s;
  }
  const scope: RuntimeScope = {
    async text(parts, limit) {
      const before = await regular(parts);
      if (!before) return undefined;
      const full = path(parts),
        result = await readStampedText(full, limit, reserve);
      if (result.stamp !== fileStamp(before)) throw changed();
      return result.text;
    },
    async marker(parts) {
      return !!(await regular(parts));
    },
    async presenceFiles() {
      const parts = ["telemetry", "presence"];
      if (!(await directory(parts))) return { names: [], unread: 0 };
      const names: string[] = [];
      let count = 0;
      for await (const e of await opendir(path(parts))) {
        if (++count > 2000)
          throw new BoardError(
            "The presence directory exceeds this screen's 2,000-entry limit.",
          );
        if (e.name.startsWith(".") || !e.name.endsWith(".json")) continue;
        if (Buffer.byteLength(e.name.slice(0, -5), "utf8") > 206)
          throw new BoardError(
            "A presence filename exceeds the supported identity limit.",
          );
        names.push(e.name);
      }
      names.sort();
      return {
        names: names.slice(0, 100),
        unread: Math.max(0, names.length - 100),
      };
    },
  };
  const result = await project(scope);
  for (const full of absent) {
    try {
      await lstat(full);
    } catch (e) {
      if (missing(e)) continue;
      throw e;
    }
    throw changed();
  }
  for (const [full, stamp] of stamps) {
    if (fileStamp(await lstat(full, { bigint: true })) !== stamp)
      throw changed();
  }
  await checkRoot();
  return result;
}
