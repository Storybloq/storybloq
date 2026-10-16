import { constants, type BigIntStats } from "node:fs";
import { isUtf8 } from "node:buffer";
import { open } from "node:fs/promises";
import { BoardError } from "./errors.js";

export const fileStamp = (s: BigIntStats) =>
  `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
export function createReadBudget(limit: number) {
  let reserved = 0;
  return (bytes: number) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || reserved + bytes > limit)
      throw new BoardError("This read exceeds the project size limit.");
    reserved += bytes;
  };
}
/** Regular no-follow UTF-8 read. Reserve input bytes before allocating, plus one growth sentinel. */
export async function readStampedText(
  path: string,
  limit: number,
  reserve: (bytes: number) => void,
  messages?: { limit: string; utf8: string },
) {
  const h = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await h.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limit))
      throw new BoardError(
        messages?.limit ??
          "A project file is not regular or exceeds this screen's size limit.",
      );
    const size = Number(before.size);
    reserve(size);
    const buffer = Buffer.alloc(size + 1);
    const { bytesRead } = await h.read(buffer, 0, buffer.length, 0),
      after = await h.stat({ bigint: true });
    if (
      fileStamp(before) !== fileStamp(after) ||
      BigInt(bytesRead) !== before.size
    )
      throw new BoardError(
        "The project changed while loading. Refresh to try again.",
      );
    const content = buffer.subarray(0, bytesRead);
    if (!isUtf8(content))
      throw new BoardError(
        messages?.utf8 ??
          "A project file contains invalid UTF-8. Repair it locally, then refresh.",
      );
    return {
      text: content.toString("utf8"),
      bytes: bytesRead,
      stamp: fileStamp(after),
    };
  } finally {
    await h.close();
  }
}
