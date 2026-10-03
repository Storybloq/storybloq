import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./fixture.js";
import { readRuntime } from "../src/runtime-reader.js";

test("internal runtime scope reserves its aggregate budget before the next allocation", async () => {
  const f = await fixture();
  const original = Buffer.alloc;
  try {
    await mkdir(join(f.root, ".story/budget"));
    for (let i = 0; i < 5; i++)
      await writeFile(
        join(f.root, ".story/budget", String(i)),
        "x".repeat(512 * 1024),
      );
    let allocations = 0;
    Buffer.alloc = function (...args: Parameters<typeof original>) {
      if (args[0] === 512 * 1024 + 1) allocations++;
      return original(...args);
    } as typeof original;
    await assert.rejects(
      readRuntime(
        f.root,
        async () => {},
        async (scope) => {
          for (let i = 0; i < 5; i++)
            await scope.text(["budget", String(i)], 512 * 1024);
        },
      ),
      /size limit/,
    );
    assert.equal(
      allocations,
      4,
      "the fifth over-budget file must never allocate its read buffer",
    );
  } finally {
    Buffer.alloc = original;
    await f.cleanup();
  }
});
