import { fencedBlock, successEnvelope } from "../../core/output-formatter.js";
import type { OutputFormat } from "../../models/types.js";
import { CliValidationError } from "../helpers.js";

const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export interface MetadataLookup {
  readonly found: boolean;
  readonly value?: unknown;
}

export function parseMetadataValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliValidationError(
      "invalid_input",
      `Metadata value must be valid JSON; wrap strings in quotes. ${detail}`,
    );
  }
}

export function parseMetadataPath(raw: string): readonly string[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new CliValidationError("invalid_input", "Metadata path is required");
  }
  const segments = trimmed.split(".");
  for (const segment of segments) {
    if (!segment) {
      throw new CliValidationError("invalid_input", `Invalid metadata path "${raw}": empty path segment`);
    }
    if (segment.trim() !== segment) {
      throw new CliValidationError("invalid_input", `Invalid metadata path "${raw}": path segments cannot start or end with whitespace`);
    }
    if (UNSAFE_PATH_SEGMENTS.has(segment)) {
      throw new CliValidationError("invalid_input", `Invalid metadata path "${raw}": "${segment}" is not allowed`);
    }
  }
  return segments;
}

export function ensureCustomMetadataPath(
  rawPath: string,
  protectedKeys: ReadonlySet<string>,
): readonly string[] {
  const segments = parseMetadataPath(rawPath);
  const rootKey = segments[0];
  if (rootKey && protectedKeys.has(rootKey)) {
    throw new CliValidationError(
      "invalid_input",
      `Metadata path "${rawPath}" targets protected core field "${rootKey}"`,
    );
  }
  return segments;
}

export function customMetadata(
  entity: Record<string, unknown>,
  protectedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entity)) {
    if (!protectedKeys.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

export function getMetadata(
  entity: Record<string, unknown>,
  rawPath: string | undefined,
  protectedKeys: ReadonlySet<string>,
): MetadataLookup {
  if (!rawPath) {
    return { found: true, value: customMetadata(entity, protectedKeys) };
  }
  const segments = ensureCustomMetadataPath(rawPath, protectedKeys);
  let cursor: unknown = entity;
  for (const segment of segments) {
    if (!isRecord(cursor) || !(segment in cursor)) {
      return { found: false };
    }
    cursor = cursor[segment];
  }
  return { found: true, value: cursor };
}

export function setMetadata<T extends Record<string, unknown>>(
  entity: T,
  rawPath: string,
  value: unknown,
  protectedKeys: ReadonlySet<string>,
): T {
  const segments = ensureCustomMetadataPath(rawPath, protectedKeys);
  const next = cloneRecord(entity);
  let cursor: Record<string, unknown> = next;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    const existing = cursor[segment];
    if (existing === undefined) {
      const created: Record<string, unknown> = {};
      cursor[segment] = created;
      cursor = created;
      continue;
    }
    if (!isRecord(existing) || Array.isArray(existing)) {
      throw new CliValidationError(
        "invalid_input",
        `Metadata path "${rawPath}" cannot traverse non-object value at "${segments.slice(0, i + 1).join(".")}"`,
      );
    }
    const cloned = cloneRecord(existing);
    cursor[segment] = cloned;
    cursor = cloned;
  }
  cursor[segments[segments.length - 1]!] = value;
  return next as T;
}

export function unsetMetadata<T extends Record<string, unknown>>(
  entity: T,
  rawPath: string,
  protectedKeys: ReadonlySet<string>,
): T {
  const segments = ensureCustomMetadataPath(rawPath, protectedKeys);
  const next = cloneRecord(entity);
  let cursor: Record<string, unknown> = next;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    const existing = cursor[segment];
    if (existing === undefined) return next as T;
    if (!isRecord(existing) || Array.isArray(existing)) return next as T;
    const cloned = cloneRecord(existing);
    cursor[segment] = cloned;
    cursor = cloned;
  }
  delete cursor[segments[segments.length - 1]!];
  return next as T;
}

export function formatMetadataValue(value: unknown, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(successEnvelope(value), null, 2);
  }
  return fencedBlock(JSON.stringify(value, null, 2), "json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value };
}
