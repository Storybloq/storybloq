/**
 * T-502: resolve `healthCheck` from `.story/config.json`.
 *
 * Read the way every other hot-path config block is read: bounded, tolerant,
 * and never throwing. An unreadable or malformed file resolves to the
 * defaults (every check on) rather than silencing the command -- the command
 * exists to TELL the user things, and a config we cannot parse is not consent
 * to stay quiet. A non-boolean toggle falls back for that key alone.
 */

import { join } from "node:path";
import { readBoundedFile } from "../bounded-read.js";
import { HEALTH_CHECK_IDS, HEALTH_CONFIG_KEY, type HealthCheckConfig, type HealthCheckId } from "./types.js";

export function resolveHealthCheckConfig(rawBlock: unknown): HealthCheckConfig {
  const block = rawBlock && typeof rawBlock === "object" && !Array.isArray(rawBlock)
    ? (rawBlock as Record<string, unknown>)
    : {};
  const rawChecks = block.checks && typeof block.checks === "object" && !Array.isArray(block.checks)
    ? (block.checks as Record<string, unknown>)
    : {};
  const checks = {} as Record<HealthCheckId, boolean>;
  for (const id of HEALTH_CHECK_IDS) {
    const value = rawChecks[HEALTH_CONFIG_KEY[id]];
    checks[id] = value === false ? false : true;
  }
  return { enabled: block.enabled === false ? false : true, checks };
}

export function readHealthCheckConfig(ledgerRoot: string | null): HealthCheckConfig {
  if (ledgerRoot === null) return resolveHealthCheckConfig(null);
  try {
    const body = readBoundedFile(join(ledgerRoot, ".story", "config.json"));
    if (body === null) return resolveHealthCheckConfig(null);
    const parsed = JSON.parse(body) as Record<string, unknown> | null;
    return resolveHealthCheckConfig(parsed?.healthCheck);
  } catch {
    return resolveHealthCheckConfig(null);
  }
}
