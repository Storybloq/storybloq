import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrossNodeBlockingResolver } from "../../src/federation/cross-node-resolver.js";
import type { Ticket } from "../../src/models/ticket.js";
import type { ResolvedNode } from "../../src/federation/resolver.js";

const tmpDirs: string[] = [];

function makeTicketWithCrossRef(id: string, crossRefs: string[]): Ticket {
  return {
    id,
    title: "Test ticket",
    description: "",
    type: "task",
    status: "open",
    phase: null,
    order: 10,
    createdDate: "2026-01-01",
    completedDate: null,
    blockedBy: [],
    crossNodeBlockedBy: crossRefs,
  } as Ticket;
}

function makeTicketNoCrossRef(id: string): Ticket {
  return {
    id,
    title: "Test ticket",
    description: "",
    type: "task",
    status: "open",
    phase: null,
    order: 10,
    createdDate: "2026-01-01",
    completedDate: null,
    blockedBy: [],
  } as Ticket;
}

async function createNodeWithTickets(
  name: string,
  tickets: Array<{ id: string; status: string }>,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `fed-xnode-${name}-`));
  tmpDirs.push(dir);
  const storyDir = join(dir, ".story");
  await mkdir(join(storyDir, "tickets"), { recursive: true });
  await mkdir(join(storyDir, "issues"), { recursive: true });
  await mkdir(join(storyDir, "handovers"), { recursive: true });
  await mkdir(join(storyDir, "notes"), { recursive: true });
  await mkdir(join(storyDir, "lessons"), { recursive: true });

  await writeFile(join(storyDir, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 2, project: name, type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  await writeFile(join(storyDir, "roadmap.json"), JSON.stringify({ version: 2, phases: [], blockers: [] }));

  for (const t of tickets) {
    await writeFile(join(storyDir, "tickets", `${t.id}.json`), JSON.stringify({
      id: t.id, title: `${name} ticket`, description: "", type: "task",
      status: t.status, phase: null, order: 10, blockedBy: [],
      createdDate: "2026-01-01", completedDate: t.status === "complete" ? "2026-05-01" : null,
    }));
  }

  return dir;
}

async function createNodeWithItems(
  name: string,
  tickets: Array<{ id: string; status: string }>,
  issues: Array<{ id: string; status: string }>,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `fed-xnode-${name}-`));
  tmpDirs.push(dir);
  const storyDir = join(dir, ".story");
  await mkdir(join(storyDir, "tickets"), { recursive: true });
  await mkdir(join(storyDir, "issues"), { recursive: true });
  await mkdir(join(storyDir, "handovers"), { recursive: true });
  await mkdir(join(storyDir, "notes"), { recursive: true });
  await mkdir(join(storyDir, "lessons"), { recursive: true });

  await writeFile(join(storyDir, "config.json"), JSON.stringify({
    version: 2, schemaVersion: 2, project: name, type: "npm", language: "typescript",
    features: { tickets: true, issues: true, handovers: true, roadmap: true, reviews: true },
  }));
  await writeFile(join(storyDir, "roadmap.json"), JSON.stringify({ version: 2, phases: [], blockers: [] }));

  for (const t of tickets) {
    await writeFile(join(storyDir, "tickets", `${t.id}.json`), JSON.stringify({
      id: t.id, title: `${name} ticket`, description: "", type: "task",
      status: t.status, phase: null, order: 10, blockedBy: [],
      createdDate: "2026-01-01", completedDate: t.status === "complete" ? "2026-05-01" : null,
    }));
  }

  for (const iss of issues) {
    await writeFile(join(storyDir, "issues", `${iss.id}.json`), JSON.stringify({
      id: iss.id, title: `${name} issue`, description: "", type: "bug",
      status: iss.status, priority: "medium", relatedTickets: [],
      createdDate: "2026-01-01", resolvedDate: iss.status === "resolved" ? "2026-05-01" : null,
    }));
  }

  return dir;
}

afterEach(async () => {
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
  tmpDirs.length = 0;
});

describe("CrossNodeBlockingResolver", () => {
  describe("build + isCrossNodeBlocked", () => {
    it("returns false for ticket with no crossNodeBlockedBy", async () => {
      const ticket = makeTicketNoCrossRef("T-001");
      const resolvedNodes = new Map<string, ResolvedNode>();
      const resolver = await CrossNodeBlockingResolver.build([ticket], resolvedNodes);
      expect(resolver.isCrossNodeBlocked(ticket)).toBe(false);
    });

    it("returns false when cross-node ref points to complete remote ticket", async () => {
      const nodeDir = await createNodeWithTickets("engine", [{ id: "T-061", status: "complete" }]);
      const ticket = makeTicketWithCrossRef("T-001", ["engine:T-061"]);
      const resolvedNodes = new Map<string, ResolvedNode>([
        ["engine", { resolved: true, absolutePath: nodeDir, storyDir: join(nodeDir, ".story"), rawPath: nodeDir }],
      ]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], resolvedNodes);
      expect(resolver.isCrossNodeBlocked(ticket)).toBe(false);
    });

    it("returns true when cross-node ref points to open remote ticket", async () => {
      const nodeDir = await createNodeWithTickets("engine", [{ id: "T-061", status: "open" }]);
      const ticket = makeTicketWithCrossRef("T-001", ["engine:T-061"]);
      const resolvedNodes = new Map<string, ResolvedNode>([
        ["engine", { resolved: true, absolutePath: nodeDir, storyDir: join(nodeDir, ".story"), rawPath: nodeDir }],
      ]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], resolvedNodes);
      expect(resolver.isCrossNodeBlocked(ticket)).toBe(true);
    });

    it("returns 'unresolved' when node is inaccessible", async () => {
      const ticket = makeTicketWithCrossRef("T-001", ["broken:T-001"]);
      const resolvedNodes = new Map<string, ResolvedNode>([
        ["broken", { resolved: false, reason: "path does not exist", rawPath: "/missing" }],
      ]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], resolvedNodes);
      expect(resolver.isCrossNodeBlocked(ticket)).toBe("unresolved");
    });

    it("returns true when any cross-node ref is blocking (mixed refs)", async () => {
      const nodeDir = await createNodeWithTickets("engine", [
        { id: "T-061", status: "complete" },
        { id: "T-062", status: "open" },
      ]);
      const ticket = makeTicketWithCrossRef("T-001", ["engine:T-061", "engine:T-062"]);
      const resolvedNodes = new Map<string, ResolvedNode>([
        ["engine", { resolved: true, absolutePath: nodeDir, storyDir: join(nodeDir, ".story"), rawPath: nodeDir }],
      ]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], resolvedNodes);
      expect(resolver.isCrossNodeBlocked(ticket)).toBe(true);
    });
  });

  describe("getCrossNodeStatus", () => {
    it("returns status for a valid ref", async () => {
      const nodeDir = await createNodeWithTickets("engine", [{ id: "T-061", status: "complete" }]);
      const ticket = makeTicketWithCrossRef("T-001", ["engine:T-061"]);
      const resolvedNodes = new Map<string, ResolvedNode>([
        ["engine", { resolved: true, absolutePath: nodeDir, storyDir: join(nodeDir, ".story"), rawPath: nodeDir }],
      ]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], resolvedNodes);
      const status = resolver.getCrossNodeStatus("engine:T-061");
      expect(status).toBeDefined();
      if (status?.resolved) {
        expect(status.status).toBe("complete");
      }
    });

    it("returns undefined for unknown ref", async () => {
      const resolver = await CrossNodeBlockingResolver.build([], new Map());
      expect(resolver.getCrossNodeStatus("engine:T-999")).toBeUndefined();
    });
  });

  describe("unindexed ref safety", () => {
    it("treats refs not in statuses as unresolved", async () => {
      const resolver = await CrossNodeBlockingResolver.build([], new Map());
      const ticket = makeTicketWithCrossRef("T-001", ["engine:T-061"]);
      expect(resolver.isCrossNodeBlocked(ticket)).toBe("unresolved");
    });
  });

  // TQ-1: ISS-xxx refs
  describe("ISS-xxx cross-node refs", () => {
    it("returns true when cross-node ref points to an open remote issue", async () => {
      const nodeDir = await createNodeWithItems(
        "engine",
        [],
        [{ id: "ISS-001", status: "open" }],
      );
      const ticket = makeTicketWithCrossRef("T-001", ["engine:ISS-001"]);
      const resolvedNodes = new Map<string, ResolvedNode>([
        ["engine", { resolved: true, absolutePath: nodeDir, storyDir: join(nodeDir, ".story"), rawPath: nodeDir }],
      ]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], resolvedNodes);
      expect(resolver.isCrossNodeBlocked(ticket)).toBe(true);
    });

    it("returns false when cross-node ref points to a resolved remote issue", async () => {
      const nodeDir = await createNodeWithItems(
        "engine",
        [],
        [{ id: "ISS-001", status: "resolved" }],
      );
      const ticket = makeTicketWithCrossRef("T-001", ["engine:ISS-001"]);
      const resolvedNodes = new Map<string, ResolvedNode>([
        ["engine", { resolved: true, absolutePath: nodeDir, storyDir: join(nodeDir, ".story"), rawPath: nodeDir }],
      ]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], resolvedNodes);
      expect(resolver.isCrossNodeBlocked(ticket)).toBe(false);
    });
  });

  // TQ-2: Status normalization
  describe("status normalization", () => {
    it("remote ticket with status 'inprogress' -> getCrossNodeStatus resolved=true status='inprogress', isCrossNodeBlocked=true", async () => {
      const nodeDir = await createNodeWithTickets("engine", [{ id: "T-061", status: "inprogress" }]);
      const ticket = makeTicketWithCrossRef("T-001", ["engine:T-061"]);
      const resolvedNodes = new Map<string, ResolvedNode>([
        ["engine", { resolved: true, absolutePath: nodeDir, storyDir: join(nodeDir, ".story"), rawPath: nodeDir }],
      ]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], resolvedNodes);
      const status = resolver.getCrossNodeStatus("engine:T-061");
      expect(status).toBeDefined();
      expect(status?.resolved).toBe(true);
      if (status?.resolved) {
        expect(status.status).toBe("inprogress");
      }
      expect(resolver.isCrossNodeBlocked(ticket)).toBe(true);
    });

    it("remote ticket file with a non-ticket status ('resolved') -> unresolved, the reason names the file, isCrossNodeBlocked='unresolved'", async () => {
      const nodeDir = await createNodeWithTickets("engine", [{ id: "T-061", status: "resolved" }]);
      const ticket = makeTicketWithCrossRef("T-001", ["engine:T-061"]);
      const resolvedNodes = new Map<string, ResolvedNode>([
        ["engine", { resolved: true, absolutePath: nodeDir, storyDir: join(nodeDir, ".story"), rawPath: nodeDir }],
      ]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], resolvedNodes);
      const status = resolver.getCrossNodeStatus("engine:T-061");
      expect(status).toMatchObject({ resolved: false });
      expect((status as { reason: string }).reason).toContain("T-061.json");
      expect(resolver.isCrossNodeBlocked(ticket)).toBe("unresolved");
    });
  });

  // TQ-18: Malformed ref strings
  describe("malformed ref strings", () => {
    it("silently skips all malformed refs during build and never returns true (blocked)", async () => {
      // All five strings are rejected by the regex and never entered into statuses.
      // isCrossNodeBlocked sees refs that are not in statuses, which counts as
      // unresolved rather than blocked - the ticket is not actively blocked.
      const ticket = makeTicketWithCrossRef("T-001", [
        "Engine:T-001",   // uppercase node name - fails regex
        ":T-001",         // missing node name
        "engine:bad",     // item id not T-xxx or ISS-xxx
        "engine:",        // missing item id
        "not-a-ref",      // no colon separator
      ]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], new Map());
      const result = resolver.isCrossNodeBlocked(ticket);
      // Malformed refs are never indexed so the ticket cannot be positively blocked.
      expect(result).not.toBe(true);
    });
  });

  describe("blocked takes precedence over unresolved", () => {
    it("returns true when one ref is blocking and another is unresolved", async () => {
      const nodeDir = await createNodeWithTickets("engine", [{ id: "T-061", status: "open" }]);
      const ticket = makeTicketWithCrossRef("T-001", ["engine:T-061", "broken:T-099"]);
      const resolvedNodes = new Map<string, ResolvedNode>([
        ["engine", { resolved: true, absolutePath: nodeDir, storyDir: join(nodeDir, ".story"), rawPath: nodeDir }],
        ["broken", { resolved: false, reason: "path does not exist", rawPath: "/missing" }],
      ]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], resolvedNodes);
      expect(resolver.isCrossNodeBlocked(ticket)).toBe(true);
    });
  });

  // ISS-687: canonical-ID and reconciled-child cross-node refs
  describe("canonical-ID and displayId-fallback cross-node refs (ISS-687)", () => {
    const CANON_TICKET = "t-k7m2p9x3w4a5b6e8";
    const CANON_ISSUE = "i-k7m2p9x3w4a5b6e8";

    async function createNodeWithRawFiles(
      name: string,
      tickets: Array<{ file: string; content: Record<string, unknown> }>,
      issues: Array<{ file: string; content: Record<string, unknown> }> = [],
    ): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), `fed-xnode-${name}-`));
      tmpDirs.push(dir);
      const storyDir = join(dir, ".story");
      await mkdir(join(storyDir, "tickets"), { recursive: true });
      await mkdir(join(storyDir, "issues"), { recursive: true });
      // T-486 U2-4: the resolver now reads nodes through the real loader, so each fixture is a full, schema-valid ticket.
      const full = (c: Record<string, unknown>) => ({
        title: "engine ticket", description: "", type: "task", phase: null, order: 10, blockedBy: [],
        createdDate: "2026-01-01", completedDate: c.status === "complete" ? "2026-05-01" : null, ...c,
      });
      for (const t of tickets) await writeFile(join(storyDir, "tickets", t.file), JSON.stringify(full(t.content)));
      for (const i of issues) await writeFile(join(storyDir, "issues", i.file), JSON.stringify(i.content));
      return dir;
    }

    function nodeMap(name: string, dir: string): Map<string, ResolvedNode> {
      return new Map<string, ResolvedNode>([
        [name, { resolved: true, absolutePath: dir, storyDir: join(dir, ".story"), rawPath: dir }],
      ]);
    }

    it("resolves a canonical-ID ticket ref from tickets/ (not issues/)", async () => {
      const dir = await createNodeWithRawFiles("engine", [
        { file: `${CANON_TICKET}.json`, content: { id: CANON_TICKET, displayId: "T-061", status: "complete" } },
      ]);
      const ticket = makeTicketWithCrossRef("T-001", [`engine:${CANON_TICKET}`]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], nodeMap("engine", dir));
      expect(resolver.getCrossNodeStatus(`engine:${CANON_TICKET}`)).toEqual({ resolved: true, status: "complete" });
      expect(resolver.isCrossNodeBlocked(ticket)).toBe(false);
    });

    it("blocks on an open canonical-ID ticket ref (proves tickets/ routing)", async () => {
      const dir = await createNodeWithRawFiles("engine", [
        { file: `${CANON_TICKET}.json`, content: { id: CANON_TICKET, displayId: "T-061", status: "open" } },
      ]);
      const ticket = makeTicketWithCrossRef("T-001", [`engine:${CANON_TICKET}`]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], nodeMap("engine", dir));
      expect(resolver.isCrossNodeBlocked(ticket)).toBe(true);
    });

    it("resolves a canonical-ID issue ref from issues/", async () => {
      const dir = await createNodeWithRawFiles("engine", [], [
        { file: `${CANON_ISSUE}.json`, content: { id: CANON_ISSUE, displayId: "ISS-009", status: "open" } },
      ]);
      const ticket = makeTicketWithCrossRef("T-001", [`engine:${CANON_ISSUE}`]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], nodeMap("engine", dir));
      expect(resolver.isCrossNodeBlocked(ticket)).toBe(true);
    });

    it("resolves a display-form ref against a reconciled child via displayId fallback", async () => {
      // File is named by canonical id; the display ref T-061 must resolve by scanning content.
      const dir = await createNodeWithRawFiles("engine", [
        { file: `${CANON_TICKET}.json`, content: { id: CANON_TICKET, displayId: "T-061", status: "complete" } },
      ]);
      const ticket = makeTicketWithCrossRef("T-001", ["engine:T-061"]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], nodeMap("engine", dir));
      expect(resolver.getCrossNodeStatus("engine:T-061")).toEqual({ resolved: true, status: "complete" });
      expect(resolver.isCrossNodeBlocked(ticket)).toBe(false);
    });

    it("resolves a display ref via previousDisplayIds when the child was renumbered", async () => {
      const dir = await createNodeWithRawFiles("engine", [
        { file: `${CANON_TICKET}.json`, content: { id: CANON_TICKET, displayId: "T-067", previousDisplayIds: ["T-061"], status: "open" } },
      ]);
      const ticket = makeTicketWithCrossRef("T-001", ["engine:T-061"]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], nodeMap("engine", dir));
      expect(resolver.isCrossNodeBlocked(ticket)).toBe(true);
    });

    it("current displayId match wins over a previousDisplayIds match on another item", async () => {
      const other = "t-r4n6w8y2a3b5c7d9";
      const dir = await createNodeWithRawFiles("engine", [
        { file: `${CANON_TICKET}.json`, content: { id: CANON_TICKET, displayId: "T-061", status: "complete" } },
        { file: `${other}.json`, content: { id: other, displayId: "T-070", previousDisplayIds: ["T-061"], status: "open" } },
      ]);
      const ticket = makeTicketWithCrossRef("T-001", ["engine:T-061"]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], nodeMap("engine", dir));
      // The current displayId owner (complete) wins over the previousDisplayIds owner (open).
      expect(resolver.getCrossNodeStatus("engine:T-061")).toEqual({ resolved: true, status: "complete" });
      expect(resolver.isCrossNodeBlocked(ticket)).toBe(false);
    });
  });

  describe("multi-node fan-out", () => {
    it("resolves refs across two different nodes", async () => {
      const engineDir = await createNodeWithTickets("engine", [{ id: "T-010", status: "complete" }]);
      const cloudDir = await createNodeWithTickets("cloud", [{ id: "T-020", status: "open" }]);
      const ticket = makeTicketWithCrossRef("T-001", ["engine:T-010", "cloud:T-020"]);
      const resolvedNodes = new Map<string, ResolvedNode>([
        ["engine", { resolved: true, absolutePath: engineDir, storyDir: join(engineDir, ".story"), rawPath: engineDir }],
        ["cloud", { resolved: true, absolutePath: cloudDir, storyDir: join(cloudDir, ".story"), rawPath: cloudDir }],
      ]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], resolvedNodes);
      expect(resolver.isCrossNodeBlocked(ticket)).toBe(true);
      expect(resolver.getCrossNodeStatus("engine:T-010")).toEqual({ resolved: true, status: "complete" });
      expect(resolver.getCrossNodeStatus("cloud:T-020")).toEqual({ resolved: true, status: "open" });
    });

    it("returns false when all refs across multiple nodes are complete", async () => {
      const engineDir = await createNodeWithTickets("engine", [{ id: "T-010", status: "complete" }]);
      const cloudDir = await createNodeWithTickets("cloud", [{ id: "T-020", status: "complete" }]);
      const ticket = makeTicketWithCrossRef("T-001", ["engine:T-010", "cloud:T-020"]);
      const resolvedNodes = new Map<string, ResolvedNode>([
        ["engine", { resolved: true, absolutePath: engineDir, storyDir: join(engineDir, ".story"), rawPath: engineDir }],
        ["cloud", { resolved: true, absolutePath: cloudDir, storyDir: join(cloudDir, ".story"), rawPath: cloudDir }],
      ]);
      const resolver = await CrossNodeBlockingResolver.build([ticket], resolvedNodes);
      expect(resolver.isCrossNodeBlocked(ticket)).toBe(false);
    });
  });
});
