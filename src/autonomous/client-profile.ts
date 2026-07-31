export type StorybloqClient = "claude" | "codex";

export interface StorybloqClientProfile {
  readonly id: StorybloqClient;
  readonly displayName: string;
  readonly storyCommand: "/story" | "$story";
}

export interface OwnerTask {
  readonly client: StorybloqClient;
  readonly id: string;
  readonly boundAt: string;
}

export const CLIENT_TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const CLIENT_PROFILES: Readonly<Record<StorybloqClient, StorybloqClientProfile>> = {
  claude: {
    id: "claude",
    displayName: "Claude Code",
    storyCommand: "/story",
  },
  codex: {
    id: "codex",
    displayName: "Codex",
    storyCommand: "$story",
  },
};

export function resolveStorybloqClient(value: string | null | undefined): StorybloqClient {
  return value === "codex" ? "codex" : "claude";
}

export function currentStorybloqClient(): StorybloqClient {
  return resolveStorybloqClient(process.env.STORYBLOQ_CLIENT);
}

export function storybloqClientProfile(client = currentStorybloqClient()): StorybloqClientProfile {
  return CLIENT_PROFILES[client];
}

export function normalizeClientTaskId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return CLIENT_TASK_ID_PATTERN.test(trimmed) ? trimmed : null;
}

export function currentClientTaskId(explicitTaskId?: string | null): string | null {
  const client = currentStorybloqClient();
  const environmentTaskId = client === "codex"
    ? process.env.CODEX_THREAD_ID
    : process.env.CLAUDE_CODE_SESSION_ID;

  // Hook-provided identity is request-scoped and therefore more precise than
  // the environment inherited by a potentially long-lived MCP process.
  const preferred = explicitTaskId ?? environmentTaskId;
  return normalizeClientTaskId(preferred);
}

export function ownerTaskForCurrentClient(
  explicitTaskId?: string | null,
  boundAt = new Date().toISOString(),
): OwnerTask | null {
  const id = currentClientTaskId(explicitTaskId);
  if (!id) return null;
  return { client: currentStorybloqClient(), id, boundAt };
}

export function ownerTaskForClient(
  client: StorybloqClient,
  taskId: string | null | undefined,
  boundAt = new Date().toISOString(),
): OwnerTask | null {
  const id = normalizeClientTaskId(taskId);
  return id ? { client, id, boundAt } : null;
}

/**
 * Read an `ownerTask` off untrusted JSON, or null.
 *
 * PRESENT but unusable is not the same as ABSENT (ISS-897), and every caller
 * must decide for itself what an unreadable owner means. What no caller may do
 * is treat a malformed record as a USABLE identity: a truthy `{}` compares
 * unequal to every real task, so an identity-bound succession check would read
 * it as "the owner is not among the live clients" and conclude the owner is
 * gone, when nothing about the owner was ever established.
 *
 * Canonical here rather than inline at each call site, because a predicate that
 * decides whether one task may take over another's session is not something to
 * keep two copies of.
 */
export function normalizeOwnerTask(raw: unknown): OwnerTask | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = normalizeClientTaskId(typeof record.id === "string" ? record.id : null);
  if (id === null) return null;
  if (record.client !== "claude" && record.client !== "codex") return null;
  if (typeof record.boundAt !== "string") return null;
  return { client: record.client, id, boundAt: record.boundAt };
}

export function isSameOwnerTask(
  owner: OwnerTask | null | undefined,
  candidate: OwnerTask | null | undefined,
): boolean {
  return !!owner && !!candidate && owner.client === candidate.client && owner.id === candidate.id;
}

/**
 * Project canonical task ownership into the legacy Claude-only telemetry field.
 * Ownerless sessions preserve their compatibility value until recovery binds
 * an owner; known Codex ownership must never point at a stale Claude task.
 */
export function legacyClaudeSessionIdForOwner(
  owner: OwnerTask | null | undefined,
  ownerlessFallback: string | null | undefined,
): string | null | undefined {
  if (!owner) return ownerlessFallback;
  return owner.client === "claude" ? owner.id : null;
}
