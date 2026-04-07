/**
 * Permission request handler.
 *
 * Receives permission_request notifications from Claude Code,
 * validates fields, signs with HMAC-SHA256, and writes to
 * .story/channel-outbox/ for the Mac app to pick up.
 */
import { randomUUID } from "node:crypto";
import { createHmac } from "node:crypto";
import { writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";

const OUTBOX_DIR = "channel-outbox";

interface PermissionRequestFields {
  requestId: string;
  toolName: string;
  description: string;
  inputPreview?: string;
}

/**
 * Validates permission request fields against schema and size limits.
 * Throws if any field is invalid.
 */
export function validatePermissionRequestFields(fields: PermissionRequestFields): void {
  if (!/^[a-zA-Z0-9]{5}$/.test(fields.requestId)) {
    throw new Error(`Invalid requestId: must match /^[a-zA-Z0-9]{5}$/, got "${fields.requestId}"`);
  }
  const toolNameLen = typeof fields.toolName === "string" ? fields.toolName.length : 0;
  if (!fields.toolName || toolNameLen > 100) {
    throw new Error(`Invalid toolName: must be 1-100 chars, got ${toolNameLen}`);
  }
  const descriptionLen = typeof fields.description === "string" ? fields.description.length : 0;
  if (!fields.description || descriptionLen > 2000) {
    throw new Error(`Invalid description: must be 1-2000 chars, got ${descriptionLen}`);
  }
  if (fields.inputPreview !== undefined && fields.inputPreview.length > 5000) {
    throw new Error(`Invalid inputPreview: must be <= 5000 chars, got ${fields.inputPreview.length}`);
  }
}

/**
 * Computes HMAC-SHA256 of the canonical payload string.
 * Exported for cross-platform contract testing.
 */
export function computeHmac(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload, "utf-8").digest("hex");
}

/**
 * Writes a signed permission request file to .story/channel-outbox/.
 *
 * @param root - Project root directory
 * @param fields - Permission request fields from Claude Code
 * @param hmacKey - HMAC key for signing (from CLAUDESTORY_CHANNEL_KEY env var)
 *
 * @pending Not yet wired to MCP notification handler. The MCP server does not
 * currently register a handler for permission_request notifications from Claude Code.
 * This function is infrastructure for when Claude Code exposes that notification API.
 */
export async function writePermissionRequest(
  root: string,
  fields: PermissionRequestFields,
  hmacKey: string,
): Promise<void> {
  if (!hmacKey || hmacKey.length < 32) {
    throw new Error(`Invalid HMAC key: must be at least 32 characters, got ${hmacKey?.length ?? 0}`);
  }
  validatePermissionRequestFields(fields);

  const outboxPath = join(root, ".story", OUTBOX_DIR);
  await mkdir(outboxPath, { recursive: true });

  const nonce = randomUUID();
  const receivedAt = new Date().toISOString();

  // Build the output object
  const output: Record<string, unknown> = {
    requestId: fields.requestId,
    toolName: fields.toolName,
    description: fields.description,
    ...(fields.inputPreview !== undefined ? { inputPreview: fields.inputPreview } : {}),
    receivedAt,
    nonce,
  };

  // Canonical payload for HMAC: sorted JSON of all fields except hmac
  const canonical = JSON.stringify(output, Object.keys(output).sort());
  output.hmac = computeHmac(canonical, hmacKey);

  const data = JSON.stringify(output, null, 2);
  const safeTimestamp = receivedAt.replace(/:/g, "-");
  const filename = `${safeTimestamp}-permission_request-${nonce.slice(0, 8)}.json`;
  const finalPath = join(outboxPath, filename);
  const tmpPath = join(outboxPath, `.tmp-${nonce}.json`);

  // Atomic write: temp file + rename
  await writeFile(tmpPath, data, "utf-8");
  await rename(tmpPath, finalPath);

  process.stderr.write(`claudestory: wrote permission request ${fields.requestId} to outbox\n`);
}
