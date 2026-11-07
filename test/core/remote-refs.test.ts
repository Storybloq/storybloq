import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigSchema } from "../../src/models/config.js";
import { allocateDisplayId, listReservations, reserveDisplayId } from "../../src/core/remote-refs.js";
import { makeTicket, makeState, minimalConfig } from "../core/test-factories.js";
import { git as fixtureGit } from "../helpers/git-fixture.js";

describe("config schema idAllocator", () => {
  it("accepts idAllocator: git-refs", () => {
    const config = { ...minimalConfig, team: { idAllocator: "git-refs" } };
    expect(() => ConfigSchema.parse(config)).not.toThrow();
  });

  it("accepts idAllocator: local", () => {
    const config = { ...minimalConfig, team: { idAllocator: "local" } };
    expect(() => ConfigSchema.parse(config)).not.toThrow();
  });

  it("accepts idAllocatorRemote", () => {
    const config = { ...minimalConfig, team: { idAllocator: "git-refs", idAllocatorRemote: "upstream" } };
    expect(() => ConfigSchema.parse(config)).not.toThrow();
  });
});

describe("allocateDisplayId", () => {
  it("with local mode returns local ID", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-001" }), makeTicket({ id: "t-canonical", displayId: "T-042" })],
      config: { ...minimalConfig, team: { idAllocator: "local" } },
    });
    const result = allocateDisplayId("ticket", state);
    expect(result.displayId).toBe("T-043");
    expect(result.reserved).toBe(false);
  });

  it("with undefined allocator defaults to local", () => {
    const state = makeState({
      tickets: [makeTicket({ id: "T-005" })],
    });
    const result = allocateDisplayId("ticket", state);
    expect(result.displayId).toBe("T-006");
    expect(result.reserved).toBe(false);
  });

  it("returns correct next ID for issues", () => {
    const state = makeState({
      issues: [],
    });
    const result = allocateDisplayId("issue", state);
    expect(result.displayId).toBe("ISS-001");
  });

  it("returns correct next ID for notes", () => {
    const state = makeState({ notes: [] });
    const result = allocateDisplayId("note", state);
    expect(result.displayId).toBe("N-001");
  });

  it("returns correct next ID for lessons", () => {
    const state = makeState({ lessons: [] });
    const result = allocateDisplayId("lesson", state);
    expect(result.displayId).toBe("L-001");
  });
});

describe("reserveDisplayId", () => {
  function createRepoWithRemote(): { root: string; remote: string } {
    const dir = mkdtempSync(join(tmpdir(), "story-remote-refs-"));
    const remote = join(dir, "remote.git");
    const root = join(dir, "work");
    // ISS-1220: the first two had NO cwd, so they inherited process.cwd() --
    // the real checkout. Both now run against an explicit fixture root.
    fixtureGit(dir, ["init", "--bare", remote]);
    fixtureGit(dir, ["init", root]);
    fixtureGit(root, ["config", "user.email", "test@test.com"]);
    fixtureGit(root, ["config", "user.name", "Test"]);
    fixtureGit(root, ["commit", "--allow-empty", "-m", "init"]);
    fixtureGit(root, ["remote", "add", "origin", remote]);
    return { root, remote };
  }

  it("pushes owner payloads to refs/storybloq and lists them", async () => {
    const { root } = createRepoWithRemote();
    const state = makeState({
      tickets: [],
      config: { ...minimalConfig, team: { enabled: true, idAllocator: "git-refs" } },
    });

    const reserved = await reserveDisplayId(root, "ticket", state, "t-owner0000000001");
    const refs = await listReservations(root, "ticket", state);

    expect(reserved).toEqual({ displayId: "T-001", reserved: true });
    expect(refs).toEqual([
      expect.objectContaining({
        displayId: "T-001",
        refName: "refs/storybloq/ids/tickets/T-001",
        ownerId: "t-owner0000000001",
      }),
    ]);
  });

  describe("at the safe integer limit (ISS-1452)", () => {
    const LIMIT = Number.MAX_SAFE_INTEGER;
    const stateAt = (number: number) => makeState({
      tickets: [makeTicket({ id: "t-canonical0000001", displayId: `T-${number}` })],
      config: { ...minimalConfig, team: { enabled: true, idAllocator: "git-refs" } },
    });
    const remoteRefs = (remote: string) => fixtureGit(remote, ["for-each-ref", "--format=%(refname)"]).trim();

    /** Every push is rejected and logged, the way a lost race reaches the retry loop. */
    function rejectEveryPush(remote: string): string {
      const log = join(remote, "attempted-refs.log");
      const hook = join(remote, "hooks", "pre-receive");
      writeFileSync(hook, `#!/bin/sh\nwhile read old new ref; do echo "$ref" >> "${log}"; done\nexit 1\n`);
      chmodSync(hook, 0o755);
      return log;
    }

    it("a maximum just below the limit reserves the limit", async () => {
      const { root } = createRepoWithRemote();
      await expect(reserveDisplayId(root, "ticket", stateAt(LIMIT - 1))).resolves.toEqual({ displayId: `T-${LIMIT}`, reserved: true });
    });

    it("a lost race at the limit never pushes a number past it", async () => {
      const { root, remote } = createRepoWithRemote();
      const log = rejectEveryPush(remote);
      await expect(reserveDisplayId(root, "ticket", stateAt(LIMIT - 1))).rejects.toMatchObject({ code: "conflict" });
      expect(readFileSync(log, "utf-8").trim().split("\n")).toEqual([`refs/storybloq/ids/tickets/T-${LIMIT}`]);
      expect(remoteRefs(remote)).toBe("");
    });

    it("a local maximum at the limit refuses before any push", async () => {
      const { root, remote } = createRepoWithRemote();
      const log = rejectEveryPush(remote);
      await expect(reserveDisplayId(root, "ticket", stateAt(LIMIT))).rejects.toMatchObject({ code: "conflict" });
      expect(existsSync(log)).toBe(false);
    });

    it.each([String(LIMIT), "9223372036854775807"])("a reservation on the remote numbered %s refuses before any push", async (number) => {
      const { root, remote } = createRepoWithRemote();
      fixtureGit(root, ["push", "origin", `HEAD:refs/storybloq/ids/tickets/T-${number}`]);
      const before = remoteRefs(remote);
      const log = rejectEveryPush(remote);
      await expect(reserveDisplayId(root, "ticket", stateAt(1))).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining(`T-${number}`),
      });
      expect(existsSync(log)).toBe(false);
      expect(remoteRefs(remote)).toBe(before);
    });
  });
});
