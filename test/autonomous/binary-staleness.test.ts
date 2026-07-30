/**
 * The staleness note fires only on POSITIVE evidence, and lands on every
 * lookup-failure surface (ISS-906).
 *
 * A stale MCP server misreports sessions in exactly the shapes
 * describeSessionLookupFailure names -- "not found" for a session that exists
 * -- and that diagnosis substitution has cost real time in three recorded
 * incidents. The note is server-relative by ruling: startup fingerprint vs
 * disk at error time, because the session-relative probe needs bytes that the
 * annotated paths do not have.
 *
 * Under vitest computeBinaryFingerprint resolves against <repo>/src and
 * returns null (liveness.test.ts:194-201), so the real probe can never
 * establish staleness here -- which is itself the correct production behavior
 * for an uncapturable binary, and why these tests seed the module through its
 * test seam instead of mocking the module graph.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  describeBinaryStaleness,
  withStalenessNote,
  captureStartupFingerprint,
  __testing,
} from "../../src/autonomous/binary-staleness.js";
import { describeSessionLookupFailure } from "../../src/autonomous/session.js";
import { registerAllTools } from "../../src/mcp/tools.js";
import { initProject } from "../../src/core/init.js";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoots: string[] = [];

const NOTE = "Server binary is stale (fingerprint mismatch); restart the client.";

afterEach(async () => {
  __testing.reset();
  await Promise.all(tmpRoots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe("describeBinaryStaleness establishes, never guesses (ISS-906)", () => {
  it("is silent when the startup capture never ran -- CLI processes never emit the note", () => {
    __testing.setDiskProbe(() => ({ sha256: "bbb" }));
    expect(describeBinaryStaleness()).toBeNull();
  });

  it("is silent when the startup capture could not resolve a binary", () => {
    __testing.setStartupFingerprint(null);
    __testing.setDiskProbe(() => ({ sha256: "bbb" }));
    expect(describeBinaryStaleness()).toBeNull();
  });

  it("is silent when the DISK side cannot be established -- null never fires the note", () => {
    __testing.setStartupFingerprint({ sha256: "aaa" });
    __testing.setDiskProbe(() => null);
    expect(describeBinaryStaleness()).toBeNull();
  });

  it("is silent when the hashes match -- a fresh server gets no warning", () => {
    __testing.setStartupFingerprint({ sha256: "aaa" });
    __testing.setDiskProbe(() => ({ sha256: "aaa" }));
    expect(describeBinaryStaleness()).toBeNull();
  });

  it("names the remedy exactly when both sides are established and differ", () => {
    __testing.setStartupFingerprint({ sha256: "aaa" });
    __testing.setDiskProbe(() => ({ sha256: "bbb" }));
    expect(describeBinaryStaleness()).toBe(NOTE);
  });

  it("captureStartupFingerprint under vitest resolves to null and therefore stays silent", () => {
    // The real capture path, not the seam: computeBinaryFingerprint returns
    // null here, and null must mean silence even against a mismatching disk.
    captureStartupFingerprint();
    __testing.setDiskProbe(() => ({ sha256: "bbb" }));
    expect(describeBinaryStaleness()).toBeNull();
  });
});

describe("withStalenessNote composes, never rewrites", () => {
  it("returns the base byte-identical when staleness is not established", () => {
    const base = "Session 123 not found";
    expect(withStalenessNote(base)).toBe(base);
  });

  it("appends exactly one sentence when it is", () => {
    __testing.setStartupFingerprint({ sha256: "aaa" });
    __testing.setDiskProbe(() => ({ sha256: "bbb" }));
    expect(withStalenessNote("Session 123 not found")).toBe(`Session 123 not found ${NOTE}`);
  });
});

describe("every lookup-failure shape carries the note when staleness is established", () => {
  const stale = () => {
    __testing.setStartupFingerprint({ sha256: "aaa" });
    __testing.setDiskProbe(() => ({ sha256: "bbb" }));
  };

  it("missing: 'not found' keeps its base text AND gains the note -- the exact incident shape", () => {
    stale();
    const msg = describeSessionLookupFailure("s-1", { kind: "missing" });
    // The stale-server incident presents as exactly this pair: a session that
    // exists reported not-found. Both halves must be present -- the base is
    // never replaced (ISS-897's texts are load-bearing), the note is appended.
    expect(msg).toContain("Session s-1 not found");
    expect(msg.endsWith(NOTE)).toBe(true);
  });

  it("unreadable/schema: the field-naming text survives, the note appends", () => {
    stale();
    const msg = describeSessionLookupFailure("s-2", {
      kind: "unreadable",
      reason: "schema",
      issues: [{ path: "startedAt", expected: "string", received: "null", message: "m" }],
      issueCount: 1,
    });
    expect(msg).toContain("startedAt expected string, received null");
    expect(msg.endsWith(NOTE)).toBe(true);
  });

  it("version-skew: composes with, not duplicates, the schema-skew restart remedy", () => {
    stale();
    const msg = describeSessionLookupFailure("s-3", {
      kind: "version-skew",
      writerVersion: 9,
      readerVersion: 1,
    });
    // Two DIFFERENT kinds in one message family: the branch's own restart
    // remedy is about schema skew, the appended note about binary skew. Both
    // appear; neither replaces the other.
    expect(msg).toContain("Restart your AI client to reload the updated");
    expect(msg.endsWith(NOTE)).toBe(true);
  });

  it("without established staleness the messages are byte-identical to their base", () => {
    const before = describeSessionLookupFailure("s-4", { kind: "missing" });
    expect(before).toBe("Session s-4 not found");
    expect(before).not.toContain("stale");
  });
});

describe("the mcp/tools.ts session surfaces carry the note too", () => {
  /**
   * register/unregister_subprocess read sessions through readSessionResilient
   * and answer a bare "Error: session not found or corrupt"; session_report
   * builds its own per-shape failure texts through handleSessionReport and
   * returns them at the MCP boundary. Both are the exact strings a stale
   * server emits for a session that exists. Driven through the real registrar
   * with a fake server, per this repo's harness pattern.
   */
  const registerFixture = async () => {
    const root = await mkdtemp(join(tmpdir(), "storybloq-stale-mcp-"));
    tmpRoots.push(root);
    await initProject(root, { name: "stale-fixture" });
    await mkdir(join(root, ".story", "sessions"), { recursive: true });

    const tools = new Map<string, { handler: (args: Record<string, unknown>) => unknown }>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: (args: Record<string, unknown>) => unknown) => {
        tools.set(name, { handler });
        return { remove: () => tools.delete(name) };
      },
      sendToolListChanged: () => {},
    } as unknown as never;
    registerAllTools(server, root);
    return tools;
  };

  it("register_subprocess names the stale server when staleness is established", async () => {
    const tools = await registerFixture();

    __testing.setStartupFingerprint({ sha256: "aaa" });
    __testing.setDiskProbe(() => ({ sha256: "bbb" }));

    const result = (await tools.get("storybloq_register_subprocess")!.handler({
      pid: 4242,
      cmd: "vitest",
      category: "test",
      sessionId: "99999999-9999-9999-9999-999999999999",
    })) as { content: Array<{ text: string }>; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Error: session not found or corrupt");
    expect(result.content[0]!.text).toContain(NOTE);

    // And silence without establishment: same call, seam reset.
    __testing.reset();
    const quiet = (await tools.get("storybloq_register_subprocess")!.handler({
      pid: 4242,
      cmd: "vitest",
      category: "test",
      sessionId: "99999999-9999-9999-9999-999999999999",
    })) as { content: Array<{ text: string }> };
    expect(quiet.content[0]!.text).toBe("Error: session not found or corrupt");
  });

  it("session_report appends the note to a lookup failure, and only then", async () => {
    const tools = await registerFixture();
    const missingId = "99999999-9999-9999-9999-999999999999";

    __testing.setStartupFingerprint({ sha256: "aaa" });
    __testing.setDiskProbe(() => ({ sha256: "bbb" }));
    const result = (await tools.get("storybloq_session_report")!.handler({
      sessionId: missingId,
    })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(`Session ${missingId} not found`);
    expect(result.content[0]!.text.endsWith(NOTE)).toBe(true);

    // Byte-identical without establishment -- the CLI-owned text is untouched.
    __testing.reset();
    const quiet = (await tools.get("storybloq_session_report")!.handler({
      sessionId: missingId,
    })) as { content: Array<{ text: string }> };
    expect(quiet.content[0]!.text).not.toContain(NOTE);
    expect(quiet.content[0]!.text).toContain(`Session ${missingId} not found`);

    // invalid_input is EXCLUDED: a malformed id is caller error, not skew.
    __testing.setStartupFingerprint({ sha256: "aaa" });
    __testing.setDiskProbe(() => ({ sha256: "bbb" }));
    const invalid = (await tools.get("storybloq_session_report")!.handler({
      sessionId: "not-a-uuid",
    })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0]!.text).not.toContain(NOTE);
  });
});
