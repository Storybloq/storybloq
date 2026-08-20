#!/usr/bin/env node
/**
 * ISS-1022: the `storybloq-presence` binary.
 *
 * A separate bin, not a `storybloq` subcommand, because `package.json` maps
 * exactly one bin to `dist/cli.js` and that bundle costs ~310ms per invocation
 * before any hook logic runs -- almost all of it parsing 2.4MB of unrelated
 * code. This hook fires on `PreToolUse` AND `PostToolUse`, so that cost would
 * be paid twice per tool call. The entire import graph here is `node:fs`,
 * `node:path`, `core/project-root-shared.ts` and `src/presence/*`, which is
 * what keeps the pair at ~70-100ms rather than ~700ms.
 *
 * Reaching the CLI dispatcher, the MCP server or ProjectState from here would
 * silently undo that, which is why the bundle-size assertion in
 * `test/presence/` is a gate rather than a nicety.
 *
 * EXIT CODE. Always 0. Exit 2 on a `PreToolUse` hook BLOCKS the tool call, so
 * a non-zero exit from this process must never be deliberate, and there is
 * nothing this hook can discover that justifies stopping a user's work.
 */

import * as fs from "node:fs";

import { runPresenceHook } from "../presence/handler.js";

/**
 * Hard ceiling on the hook payload.
 *
 * Deliberately larger than the 64KiB the Bus tool hook uses: a `PreToolUse`
 * payload for `Write` carries the whole file body in `tool_input.content`, and
 * refusing those would mean a session writing large files silently stopped
 * registering as alive. Anything past the ceiling is drained and discarded
 * rather than left unread, so the parent's write never fails.
 */
const MAX_STDIN_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
/**
 * Bounds the reader's own looping. Stated precisely, because it is weaker than
 * it looks in two directions.
 *
 * `readSync` on a BLOCKING pipe cannot be preempted from inside this process,
 * so ANY read -- not only the first -- can outlast this deadline if the parent
 * pauses mid-payload. Every read is therefore ultimately bounded by the
 * client's hook timeout (registered as 5s), and this value only guarantees that
 * no LOOP here keeps going past it.
 *
 * And draining an oversized payload is best-effort for the same reason: if the
 * deadline expires mid-drain the process exits and a parent still writing sees
 * EPIPE. Accepted, because the alternative is a hook that hangs, and because
 * the ceiling is set well above any real payload.
 */
const STDIN_DEADLINE_MS = 2_000;

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  try {
    Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
  } catch {
    // Unavailable here; the deadline below still bounds the loop.
  }
}

function readStdinBounded(): string | null {
  const chunks: Buffer[] = [];
  let total = 0;
  let overflowed = false;
  const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const deadline = Date.now() + STDIN_DEADLINE_MS;

  for (;;) {
    // Checked before every read and every continue, so no additional iteration
    // begins after the deadline. An in-progress blocking read is not
    // preemptible from here and remains bounded only by the client's hook
    // timeout.
    if (Date.now() >= deadline) return null;
    let n: number;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "EAGAIN") {
        sleepSync(5);
        continue;
      }
      // EOF is reported as an error on some platforms when the pipe closes.
      if (code === "EOF") break;
      return null;
    }
    if (n <= 0) break;
    if (overflowed) continue; // keep draining, best-effort, until the deadline
    total += n;
    if (total > MAX_STDIN_BYTES) {
      overflowed = true;
      continue;
    }
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }

  if (overflowed) return null;
  return Buffer.concat(chunks).toString("utf-8");
}

function main(): void {
  try {
    // TTY means a person ran this by hand; there is no hook payload to read.
    if (process.stdin.isTTY) return;
    const raw = readStdinBounded();
    if (raw === null || raw === "") return;
    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      return;
    }
    runPresenceHook(input);
  } catch {
    // Never interfere with a tool call.
  }
}

main();
process.exit(0);
