import { describe, it, expect } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initProject } from "../../src/core/init.js";
import {
  handleTicketCreate,
  handleTicketUpdate,
} from "../../src/cli/commands/ticket.js";
import {
  handleIssueCreate,
  handleIssueUpdate,
} from "../../src/cli/commands/issue.js";
import {
  createCheckpoint,
  retireCheckpoint,
} from "../../src/core/checkpoint-lifecycle.js";
import { parseOwnerCheckpoint } from "../../src/core/owner-checkpoint.js";
import { CHECKPOINT_SCHEMA_VERSION } from "../../src/core/errors.js";

async function project(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "story-write-hook-"));
  try {
    await initProject(root, { name: "Write hooks" });
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function newTicket(root: string, blockedBy: string[] = []) {
  const r = await handleTicketCreate(
    {
      title: "Original",
      description: "Authored body",
      type: "task",
      phase: "p0",
      blockedBy,
    },
    "json",
    root,
  );
  return JSON.parse(r.output).data.id as string;
}
describe("trusted update hooks", () => {
  it("a rejected locked precondition leaves ticket and issue bytes unchanged", async () =>
    project(async (root) => {
      const ticket = await newTicket(root);
      const result = await handleIssueCreate(
        {
          title: "Original issue",
          severity: "high",
          impact: "Impact",
          components: [],
          location: [],
          relatedTickets: [],
          phase: null,
        },
        "json",
        root,
      );
      const issue = JSON.parse(result.output).data.id;
      for (const [kind, id] of [
        ["tickets", ticket],
        ["issues", issue],
      ]) {
        const path = join(root, ".story", kind, id + ".json"),
          before = await readFile(path, "utf8");
        const hooks = {
          precondition: async (existing: any, state: any) => {
            expect(existing.title).toMatch(/Original/);
            expect(state.config.project).toBe("Write hooks");
            throw new Error("Rejected precondition");
          },
        };
        const action =
          kind === "tickets"
            ? (handleTicketUpdate as any)(
                id,
                { title: "Changed" },
                "json",
                root,
                false,
                hooks,
              )
            : (handleIssueUpdate as any)(
                id,
                { title: "Changed" },
                "json",
                root,
                hooks,
              );
        await expect(action).rejects.toThrow("Rejected precondition");
        expect(await readFile(path, "utf8")).toBe(before);
      }
    }));
  it("final serialized ticket and issue validation runs before persistence", async () =>
    project(async (root) => {
      const ticket = await newTicket(root);
      const result = await handleIssueCreate(
        {
          title: "Original issue",
          severity: "high",
          impact: "Impact",
          components: [],
          location: [],
          relatedTickets: [],
          phase: null,
        },
        "json",
        root,
      );
      const issue = JSON.parse(result.output).data.id;
      for (const [kind, id] of [
        ["tickets", ticket],
        ["issues", issue],
      ]) {
        const path = join(root, ".story", kind, id + ".json"),
          before = await readFile(path, "utf8");
        const hooks = {
          validatePreparedContent: (content: string) => {
            expect(JSON.parse(content).title).toBe("Changed");
            expect(content.endsWith("\n")).toBe(true);
            throw new Error("Prepared content refused");
          },
        };
        const action =
          kind === "tickets"
            ? (handleTicketUpdate as any)(
                id,
                { title: "Changed" },
                "json",
                root,
                false,
                hooks,
              )
            : (handleIssueUpdate as any)(
                id,
                { title: "Changed" },
                "json",
                root,
                hooks,
              );
        await expect(action).rejects.toThrow("Prepared content refused");
        expect(await readFile(path, "utf8")).toBe(before);
      }
    }));
  it("completion validation sees final checkpoint evidence and can refuse it without writing", async () =>
    project(async (root) => {
      const configPath = join(root, ".story/config.json"),
        config = JSON.parse(await readFile(configPath, "utf8"));
      await writeFile(
        configPath,
        JSON.stringify({ ...config, schemaVersion: CHECKPOINT_SCHEMA_VERSION }),
      );
      const cp = await createCheckpoint(root, {
        title: "Decision",
        description: "",
        phase: "p0",
        owner: "owner",
        content: { kind: "decision", question: "Ship?", evidenceRefs: [] },
        actor: "owner@example.test",
      });
      const parsed = parseOwnerCheckpoint(cp);
      if (parsed.kind !== "ok") throw new Error("Invalid fixture checkpoint");
      await retireCheckpoint(
        root,
        cp.id,
        {
          generation: parsed.checkpoint.generation,
          revision: parsed.checkpoint.revision,
          digest: parsed.checkpoint.digest,
        },
        "Retired",
        "owner@example.test",
      );
      const id = await newTicket(root, [cp.id]),
        path = join(root, ".story/tickets", id + ".json"),
        before = await readFile(path, "utf8");
      const action = (handleTicketUpdate as any)(
        id,
        { status: "complete" },
        "json",
        root,
        false,
        {
          validatePreparedContent: (content: string) => {
            const candidate = JSON.parse(content);
            expect(candidate.status).toBe("complete");
            expect(candidate.checkpointEvidence[0].checkpoint).toBe(cp.id);
            throw new Error("Evidence grew beyond bound");
          },
        },
      );
      await expect(action).rejects.toThrow("Evidence grew beyond bound");
      expect(await readFile(path, "utf8")).toBe(before);
    }));
});
