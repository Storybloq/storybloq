import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests for the permission handler (MCP -> Mac outbox writer).
 *
 * These test the writePermissionRequest function that the MCP notification
 * handler calls when Claude Code sends a permission_request notification.
 * The function writes a signed JSON file to .story/channel-outbox/.
 */

// Import will fail until implementation exists -- that's the TDD point.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { writePermissionRequest, validatePermissionRequestFields, computeHmac } from "../../src/channel/permission-handler.js";
import { createHmac } from "node:crypto";

describe("writePermissionRequest", () => {
  let tempDir: string;
  let outboxDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "perm-handler-test-"));
    outboxDir = join(tempDir, ".story", "channel-outbox");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("writes a signed JSON file to the outbox directory", async () => {
    const hmacKey = "test-hmac-key-32-bytes-long-xxxx";
    await writePermissionRequest(
      tempDir,
      {
        requestId: "aBc12",
        toolName: "Bash",
        description: "Execute rm -rf /tmp/test",
        inputPreview: "rm -rf /tmp/test",
      },
      hmacKey,
    );

    const files = await readdir(outboxDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/\.json$/);

    const content = JSON.parse(await readFile(join(outboxDir, files[0]), "utf-8"));
    expect(content.requestId).toBe("aBc12");
    expect(content.toolName).toBe("Bash");
    expect(content.description).toBe("Execute rm -rf /tmp/test");
    expect(content.inputPreview).toBe("rm -rf /tmp/test");
    expect(content.nonce).toBeDefined();
    expect(content.hmac).toBeDefined();
    expect(typeof content.hmac).toBe("string");
    expect(content.receivedAt).toBeDefined();
  });

  it("creates outbox directory if it does not exist", async () => {
    const hmacKey = "test-hmac-key-32-bytes-long-xxxx";
    await writePermissionRequest(
      tempDir,
      {
        requestId: "aBc12",
        toolName: "Write",
        description: "Write file",
      },
      hmacKey,
    );

    const files = await readdir(outboxDir);
    expect(files.length).toBe(1);
  });

  it("includes a unique nonce per request", async () => {
    const hmacKey = "test-hmac-key-32-bytes-long-xxxx";
    await writePermissionRequest(tempDir, { requestId: "aBc12", toolName: "A", description: "A" }, hmacKey);
    await writePermissionRequest(tempDir, { requestId: "dEf34", toolName: "B", description: "B" }, hmacKey);

    const files = (await readdir(outboxDir)).sort();
    const content1 = JSON.parse(await readFile(join(outboxDir, files[0]), "utf-8"));
    const content2 = JSON.parse(await readFile(join(outboxDir, files[1]), "utf-8"));
    expect(content1.nonce).not.toBe(content2.nonce);
  });

  it("produces different HMAC for different payloads", async () => {
    const hmacKey = "test-hmac-key-32-bytes-long-xxxx";
    await writePermissionRequest(tempDir, { requestId: "aBc12", toolName: "A", description: "A" }, hmacKey);
    await writePermissionRequest(tempDir, { requestId: "dEf34", toolName: "B", description: "B" }, hmacKey);

    const files = (await readdir(outboxDir)).sort();
    const content1 = JSON.parse(await readFile(join(outboxDir, files[0]), "utf-8"));
    const content2 = JSON.parse(await readFile(join(outboxDir, files[1]), "utf-8"));
    expect(content1.hmac).not.toBe(content2.hmac);
  });

  it("omits inputPreview when not provided", async () => {
    const hmacKey = "test-hmac-key-32-bytes-long-xxxx";
    await writePermissionRequest(
      tempDir,
      { requestId: "aBc12", toolName: "Edit", description: "Edit file" },
      hmacKey,
    );

    const files = await readdir(outboxDir);
    const content = JSON.parse(await readFile(join(outboxDir, files[0]), "utf-8"));
    expect(content.inputPreview).toBeUndefined();
  });
});

describe("HMAC cross-platform contract", () => {
  // This test verifies that the canonical JSON + HMAC computation produces a known output.
  // The Swift side (PermissionOutboxWatcher) must produce the same HMAC for the same input.
  // If this test changes, the Swift verification MUST be updated to match.
  it("produces deterministic HMAC for a known canonical payload", () => {
    const key = "test-hmac-key-32-bytes-long-xxxx";
    // Canonical JSON: keys sorted alphabetically, no extra whitespace (JSON.stringify with sorted keys)
    const canonical = JSON.stringify(
      {
        description: "Execute rm -rf /tmp/test",
        nonce: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        receivedAt: "2026-01-01T00:00:00.000Z",
        requestId: "aBc12",
        toolName: "Bash",
      },
      // Keys already in sorted order above; JSON.stringify preserves insertion order
    );

    const hmac = computeHmac(canonical, key);

    // Hardcoded golden value: if TS or Swift changes canonical format, this test MUST fail.
    // The Swift side must produce this exact HMAC for the same input.
    const goldenHmac = "c87d8cd56335540050d07cdb58a8332aaa90ed68fb1d8d6420b09d8e584a536b";
    expect(hmac).toBe(goldenHmac);

    // Verify canonical format is sorted-key JSON with no whitespace
    expect(canonical).toBe(
      '{"description":"Execute rm -rf /tmp/test","nonce":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","receivedAt":"2026-01-01T00:00:00.000Z","requestId":"aBc12","toolName":"Bash"}',
    );

    expect(hmac.length).toBe(64); // SHA-256 hex = 64 chars
  });

  it("produces deterministic HMAC for a known canonical payload with inputPreview", () => {
    const key = "test-hmac-key-32-bytes-long-xxxx";
    const canonical = JSON.stringify({
      description: "Execute rm -rf /tmp/test",
      inputPreview: "rm -rf /tmp/test",
      nonce: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      receivedAt: "2026-01-01T00:00:00.000Z",
      requestId: "aBc12",
      toolName: "Bash",
    });

    const hmac = computeHmac(canonical, key);

    // Golden value: if TS or Swift changes canonical format, this test MUST fail.
    // The Swift side must produce this exact HMAC for the same input.
    const goldenHmac = "80fa24b1abda9098878c4dec0828893ca77a2f4283242b67cd02d4c164151e98";
    expect(hmac).toBe(goldenHmac);

    // Verify inputPreview is present in canonical
    expect(canonical).toContain('"inputPreview":"rm -rf /tmp/test"');
  });

  it("uses sorted keys for canonical JSON matching Swift JSONSerialization .sortedKeys", () => {
    const key = "contract-test-key-at-least-32-ch";
    // Deliberately unsorted input; the canonical format must sort them
    const fields: Record<string, unknown> = {
      toolName: "Write",
      requestId: "xYz99",
      description: "Write file",
      receivedAt: "2026-06-15T12:00:00.000Z",
      nonce: "11111111-2222-3333-4444-555555555555",
    };

    // Build canonical the same way permission-handler.ts does
    const sortedCanonical = JSON.stringify(fields, Object.keys(fields).sort());

    // Verify keys are sorted
    const parsed = JSON.parse(sortedCanonical);
    const keys = Object.keys(parsed);
    expect(keys).toEqual([...keys].sort());

    // HMAC must be deterministic
    const hmac1 = computeHmac(sortedCanonical, key);
    const hmac2 = computeHmac(sortedCanonical, key);
    expect(hmac1).toBe(hmac2);
  });
});

describe("validatePermissionRequestFields", () => {
  it("accepts valid fields", () => {
    expect(() =>
      validatePermissionRequestFields({
        requestId: "aBc12",
        toolName: "Bash",
        description: "Execute command",
      }),
    ).not.toThrow();
  });

  it("rejects requestId that does not match /^[a-zA-Z0-9]{5}$/", () => {
    expect(() =>
      validatePermissionRequestFields({
        requestId: "toolong123",
        toolName: "Bash",
        description: "x",
      }),
    ).toThrow();
  });

  it("rejects empty requestId", () => {
    expect(() =>
      validatePermissionRequestFields({
        requestId: "",
        toolName: "Bash",
        description: "x",
      }),
    ).toThrow();
  });

  it("rejects toolName exceeding 100 chars", () => {
    expect(() =>
      validatePermissionRequestFields({
        requestId: "aBc12",
        toolName: "x".repeat(101),
        description: "x",
      }),
    ).toThrow();
  });

  it("rejects description exceeding 2000 chars", () => {
    expect(() =>
      validatePermissionRequestFields({
        requestId: "aBc12",
        toolName: "Bash",
        description: "x".repeat(2001),
      }),
    ).toThrow();
  });

  it("rejects inputPreview exceeding 5000 chars", () => {
    expect(() =>
      validatePermissionRequestFields({
        requestId: "aBc12",
        toolName: "Bash",
        description: "x",
        inputPreview: "x".repeat(5001),
      }),
    ).toThrow();
  });

  it("accepts inputPreview within limit", () => {
    expect(() =>
      validatePermissionRequestFields({
        requestId: "aBc12",
        toolName: "Bash",
        description: "x",
        inputPreview: "x".repeat(5000),
      }),
    ).not.toThrow();
  });
});
