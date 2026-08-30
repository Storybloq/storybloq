import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canClaim, buildClaim } from "../../src/core/claims.js";
import { gitUserEmail } from "../../src/autonomous/git-inspector.js";
import { makeTicket } from "../core/test-factories.js";
import type { Ticket } from "../../src/models/ticket.js";

describe("autonomous claim integration", () => {
  describe("gitUserEmail", () => {
    // ISS-1091: gitUserEmail(".") previously read the AMBIENT repo's git
    // config (whatever real repo vitest's cwd happens to sit in), so this
    // test only passed because the developer machine's global git config
    // has user.email set. Seed a throwaway repo with a local user.email
    // instead, same pattern as merge-driver-e2e.test.ts:14-16.
    let dir: string;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("returns a string email from git config", async () => {
      dir = mkdtempSync(join(tmpdir(), "claim-git-identity-"));
      execFileSync("git", ["init"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });

      const email = await gitUserEmail(dir);
      expect(typeof email).toBe("string");
      expect(email).toBe("test@test.com");
    });
  });

  describe("claim check at pick-ticket time", () => {
    it("allows claim on unclaimed ticket", () => {
      const ticket = makeTicket({ id: "T-001" }) as Ticket;
      const result = canClaim(ticket, "agent@ci.local", "feature/auto");
      expect(result.allowed).toBe(true);
    });

    it("rejects claim on ticket claimed by another user", () => {
      const ticket = makeTicket({
        id: "T-001",
        claim: { user: "human@example.com", branch: "feature/manual", since: "2026-05-26T00:00:00Z" },
      }) as Ticket;
      const result = canClaim(ticket, "agent@ci.local", "feature/auto");
      expect(result.allowed).toBe(false);
      expect(result.claimedBy).toBe("human@example.com");
    });

    it("allows re-claim by same identity", () => {
      const ticket = makeTicket({
        id: "T-001",
        claim: { user: "agent@ci.local", branch: "feature/auto", since: "2026-05-26T00:00:00Z" },
      }) as Ticket;
      const result = canClaim(ticket, "agent@ci.local", "feature/auto");
      expect(result.allowed).toBe(true);
    });

    it("buildClaim creates valid claim for autonomous use", () => {
      const claim = buildClaim("agent@ci.local", "feature/auto", "2026-05-26T12:00:00Z");
      expect(claim.user).toBe("agent@ci.local");
      expect(claim.branch).toBe("feature/auto");
      expect(claim.since).toBe("2026-05-26T12:00:00Z");
    });
  });
});
