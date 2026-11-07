import type { ProjectState } from "./project-state.js";
import { assertAllocatableIdNumber, maxSequentialNumber, readIdNumber } from "./id-allocation.js";

export interface AllocationResult {
  displayId: string;
  reserved: boolean;
}

export interface Reservation {
  displayId: string;
  refName: string;
  ownerId: string | null;
}

type ReservableType = "ticket" | "issue" | "note" | "lesson";

const NUMERIC_REGEX: Record<ReservableType, RegExp> = {
  ticket: /^T-(\d+)/,
  issue: /^ISS-(\d+)/,
  note: /^N-(\d+)/,
  lesson: /^L-(\d+)/,
};

export function allocateDisplayId(
  type: ReservableType,
  state: ProjectState,
): AllocationResult {
  const allocator = state.config.team?.idAllocator;

  if (allocator === "git-refs") {
    throw new Error(
      "git-refs allocation requires a remote. Use reserveDisplayId() for async allocation, or set team.idAllocator to \"local\".",
    );
  }

  const displayId = localNextId(type, state);
  return { displayId, reserved: false };
}

function localNextId(type: ReservableType, state: ProjectState): string {
  const next = localMaxNum(type, state) + 1;
  return `${typeToPrefix(type)}-${String(next).padStart(3, "0")}`;
}

export async function reserveDisplayId(
  root: string,
  type: ReservableType,
  state: ProjectState,
  ownerId?: string,
): Promise<AllocationResult> {
  const remote = state.config.team?.idAllocatorRemote ?? "origin";
  const prefix = typeToPrefix(type);
  const refNamespace = `refs/storybloq/ids/${type}s`;

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  try {
    await execFileAsync("git", [
      "fetch", remote, `+${refNamespace}/*:${refNamespace}/*`,
    ], { cwd: root, timeout: 15000 });
  } catch {
    throw new Error(
      `Cannot reach remote "${remote}" for git-refs ID allocation. ` +
      `Check network connectivity and ref-push permissions, or set team.idAllocator to "local".`,
    );
  }

  const { stdout } = await execFileAsync("git", [
    "for-each-ref", "--format=%(refname)", refNamespace,
  ], { cwd: root, timeout: 5000 });

  const existingRefs = stdout.split("\n").filter((l) => l.trim().length > 0);
  const existingNums = new Set<number>();
  const numRegex = new RegExp(`^${refNamespace}/${prefix}-(\\d+)$`);
  for (const refName of existingRefs) {
    const match = refName.match(numRegex);
    if (match?.[1]) existingNums.add(readIdNumber(match[1], `${prefix}-${match[1]}`));
  }

  let next = Math.max(localMaxNum(type, state), ...existingNums) + 1;

  for (let attempt = 0; attempt < 5; attempt++) {
    // ISS-1452: a lost race moves next on, so every candidate is checked before it is published.
    assertAllocatableIdNumber(next);
    const displayId = `${prefix}-${String(next).padStart(3, "0")}`;
    const refName = `${refNamespace}/${displayId}`;
    const payload = JSON.stringify({
      type,
      displayId,
      ownerId: ownerId ?? null,
      reservedAt: new Date().toISOString(),
    });
    const { writeFile, rm, mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmpDir = await mkdtemp(join(tmpdir(), "storybloq-reservation-"));
    const payloadPath = join(tmpDir, "payload.json");
    await writeFile(payloadPath, payload, "utf-8");
    const { stdout: objectStdout } = await execFileAsync("git", ["hash-object", "-w", payloadPath], {
      cwd: root,
      timeout: 5000,
    });
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    const objectId = objectStdout.trim();

    try {
      await execFileAsync("git", ["push", remote, `${objectId}:${refName}`], { cwd: root, timeout: 15000 });
      return { displayId, reserved: true };
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? "";
      if (
        stderr.includes("already exists") ||
        stderr.includes("failed to push some refs") ||
        stderr.includes("fetch first") ||
        stderr.includes("stale info")
      ) {
        next++;
        continue;
      }
      throw new Error(
        `Failed to push reservation ref "${refName}" to remote "${remote}". ` +
        `${stderr || (err instanceof Error ? err.message : String(err))}`,
      );
    }
  }

  throw new Error(`Failed to reserve ${type} display ID after 5 attempts on remote "${remote}".`);
}

function typeToPrefix(type: ReservableType): string {
  switch (type) {
    case "ticket": return "T";
    case "issue": return "ISS";
    case "note": return "N";
    case "lesson": return "L";
  }
}

function localMaxNum(type: ReservableType, state: ProjectState): number {
  const collection = type === "ticket" ? state.tickets : type === "issue" ? state.issues : type === "note" ? state.notes : state.lessons;
  return maxSequentialNumber(collection, NUMERIC_REGEX[type]);
}

export async function listReservations(
  root: string,
  type: ReservableType,
  state: ProjectState,
): Promise<Reservation[]> {
  const remote = state.config.team?.idAllocatorRemote ?? "origin";
  const refNamespace = `refs/storybloq/ids/${type}s`;

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  try {
    await execFileAsync("git", [
      "fetch", remote, `+${refNamespace}/*:${refNamespace}/*`,
    ], { cwd: root, timeout: 15000 });
  } catch (err) {
    throw new Error(
      `Cannot reach remote "${remote}" for listing reservations. ` +
      `Check network connectivity and ref-fetch permissions. ` +
      `${(err instanceof Error ? err.message : String(err))}`,
    );
  }

  const { stdout } = await execFileAsync("git", [
    "for-each-ref", "--format=%(refname) %(objectname)", refNamespace,
  ], { cwd: root, timeout: 5000 });

  const reservations: Reservation[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [refName, objectId] = trimmed.split(/\s+/, 2);
    if (!refName) continue;
    const displayId = refName.replace(`${refNamespace}/`, "");
    let ownerId: string | null = null;
    if (objectId) {
      try {
        const { stdout: payload } = await execFileAsync("git", ["cat-file", "-p", objectId], { cwd: root, timeout: 5000 });
        const parsed = JSON.parse(payload) as { ownerId?: unknown };
        ownerId = typeof parsed.ownerId === "string" ? parsed.ownerId : null;
      } catch {
        ownerId = null;
      }
    }
    reservations.push({ displayId, refName, ownerId });
  }
  return reservations;
}
