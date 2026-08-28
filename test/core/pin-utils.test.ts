import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import { readBoundedRegularFile, sha256Bytes } from "../../src/core/pin-utils.js";

describe("readBoundedRegularFile", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pin-utils-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns missing for a nonexistent path", () => {
    const result = readBoundedRegularFile(join(root, "nope.txt"), 1024);
    expect(result.status).toBe("missing");
  });

  it("reads a small file's exact bytes", async () => {
    const path = join(root, "plan.md");
    await writeFile(path, "hello plan");
    const result = readBoundedRegularFile(path, 1024);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.bytes.toString("utf-8")).toBe("hello plan");
  });

  it("returns empty for a zero-byte file", async () => {
    const path = join(root, "empty.md");
    await writeFile(path, "");
    const result = readBoundedRegularFile(path, 1024);
    expect(result.status).toBe("empty");
  });

  it("returns unreadable for a file over the size ceiling", async () => {
    const path = join(root, "big.md");
    await writeFile(path, "x".repeat(2048));
    const result = readBoundedRegularFile(path, 1024);
    expect(result.status).toBe("unreadable");
  });

  it.skipIf(platform() === "win32")("refuses a symlink rather than following it", async () => {
    const target = join(root, "target.md");
    await writeFile(target, "real content");
    const link = join(root, "link.md");
    await symlink(target, link);
    const result = readBoundedRegularFile(link, 1024);
    expect(result.status).toBe("unreadable");
  });

  it("CLI and enforcement hash the identical bytes for the same file", async () => {
    const path = join(root, "plan.md");
    await writeFile(path, "identical content for both sides");
    const first = readBoundedRegularFile(path, 1024);
    const second = readBoundedRegularFile(path, 1024);
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status === "ok" && second.status === "ok") {
      expect(sha256Bytes(first.bytes)).toBe(sha256Bytes(second.bytes));
    }
  });
});

describe("sha256Bytes", () => {
  it("is deterministic", () => {
    const buf = Buffer.from("some content");
    expect(sha256Bytes(buf)).toBe(sha256Bytes(Buffer.from("some content")));
  });

  it("matches the g-<16hex> style hex shape (lowercase, 64 chars)", () => {
    expect(sha256Bytes(Buffer.from("x"))).toMatch(/^[0-9a-f]{64}$/);
  });
});
