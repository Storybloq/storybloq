import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import canonicalize from "canonicalize";
import {
  TICKET_ID_REGEX,
  ISSUE_ID_REGEX,
  NOTE_ID_REGEX,
} from "../../src/models/types.js";
import { BoardError } from "./errors.js";
import type { RootAccess } from "./federation.js";

export class EditError extends BoardError {
  constructor(
    public readonly code: "conflict" | "invalid_input" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}
/** Canonical loader fills the display ID on legacy items before invoking hooks. */
export function recordRevision(item: { id: string; displayId?: string }) {
  const legacy =
    TICKET_ID_REGEX.test(item.id) ||
    ISSUE_ID_REGEX.test(item.id) ||
    NOTE_ID_REGEX.test(item.id);
  const normalized =
    legacy && item.displayId == null ? { ...item, displayId: item.id } : item;
  const text = canonicalize(normalized);
  if (typeof text !== "string")
    throw new EditError("unavailable", "This record cannot be edited safely.");
  return createHash("sha256").update(text).digest("hex");
}
export function createRootCheck(
  root: string,
  access: Promise<RootAccess>,
  message = "The local project connection changed. Reconnect before editing.",
) {
  return async () => {
    const fixed = (await access).fixed,
      stat = await lstat(resolve(root), { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      `${stat.dev}:${stat.ino}` !== fixed.identity ||
      (await realpath(root)) !== fixed.canonical
    )
      throw new EditError("unavailable", message);
  };
}
export function validateEditSize(
  content: string,
  originalBytes: number,
  totalBytes: number,
) {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > 1048576 || totalBytes - originalBytes + bytes > 32 * 1024 * 1024)
    throw new EditError(
      "invalid_input",
      "This edit exceeds the project size limit. Shorten the editable text and try again.",
    );
}
