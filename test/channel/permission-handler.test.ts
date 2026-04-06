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
import { writePermissionRequest, validatePermissionRequestFields } from "../../src/channel/permission-handler.js";

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
