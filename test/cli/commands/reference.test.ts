import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, MCP_TOOLS, handleReference } from "../../../src/cli/commands/reference.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..", "..");

describe("reference command", () => {
  it("handleReference md format produces output", () => {
    const output = handleReference("md");
    expect(output).toContain("# claudestory Reference");
    expect(output).toContain("## CLI Commands");
    expect(output).toContain("## MCP Tools");
    expect(output).toContain("## Common Workflows");
    expect(output).toContain("## Troubleshooting");
  });

  it("handleReference json format produces valid JSON", () => {
    const output = handleReference("json");
    const parsed = JSON.parse(output);
    expect(parsed.version).toBe(1);
    expect(parsed.data.commands).toHaveLength(COMMANDS.length);
    expect(parsed.data.mcpTools).toHaveLength(MCP_TOOLS.length);
  });

  it("COMMANDS registry covers all expected commands", () => {
    const names = COMMANDS.map((c) => c.name);
    // Core commands
    expect(names).toContain("init");
    expect(names).toContain("status");
    expect(names).toContain("validate");
    expect(names).toContain("snapshot");
    expect(names).toContain("recap");
    expect(names).toContain("export");
    expect(names).toContain("reference");
    expect(names).toContain("setup-skill");
    // Ticket subcommands
    expect(names).toContain("ticket list");
    expect(names).toContain("ticket get");
    expect(names).toContain("ticket next");
    expect(names).toContain("ticket create");
    expect(names).toContain("ticket update");
    expect(names).toContain("ticket delete");
    // Issue subcommands
    expect(names).toContain("issue list");
    expect(names).toContain("issue get");
    expect(names).toContain("issue create");
    expect(names).toContain("issue update");
    expect(names).toContain("issue delete");
    // Phase subcommands
    expect(names).toContain("phase list");
    expect(names).toContain("phase current");
    expect(names).toContain("phase tickets");
    expect(names).toContain("phase create");
    expect(names).toContain("phase rename");
    expect(names).toContain("phase move");
    expect(names).toContain("phase delete");
    // Handover subcommands
    expect(names).toContain("handover list");
    expect(names).toContain("handover latest");
    expect(names).toContain("handover get");
    expect(names).toContain("handover create");
    // Blocker subcommands
    expect(names).toContain("blocker list");
    expect(names).toContain("blocker add");
    expect(names).toContain("blocker clear");
  });

  it("MCP_TOOLS registry covers all expected tools", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(names).toContain("claudestory_status");
    expect(names).toContain("claudestory_phase_list");
    expect(names).toContain("claudestory_phase_current");
    expect(names).toContain("claudestory_phase_tickets");
    expect(names).toContain("claudestory_ticket_list");
    expect(names).toContain("claudestory_ticket_get");
    expect(names).toContain("claudestory_ticket_next");
    expect(names).toContain("claudestory_ticket_blocked");
    expect(names).toContain("claudestory_issue_list");
    expect(names).toContain("claudestory_issue_get");
    expect(names).toContain("claudestory_handover_list");
    expect(names).toContain("claudestory_handover_latest");
    expect(names).toContain("claudestory_handover_get");
    expect(names).toContain("claudestory_handover_create");
    expect(names).toContain("claudestory_blocker_list");
    expect(names).toContain("claudestory_validate");
    expect(names).toContain("claudestory_recap");
    expect(names).toContain("claudestory_snapshot");
    expect(names).toContain("claudestory_export");
    expect(names).toContain("claudestory_lesson_list");
    expect(names).toContain("claudestory_lesson_get");
    expect(names).toContain("claudestory_lesson_digest");
    expect(names).toContain("claudestory_lesson_create");
    expect(names).toContain("claudestory_lesson_update");
    expect(names).toContain("claudestory_lesson_reinforce");
  });

  it("reference.md matches handleReference output (drift detection)", () => {
    const refPath = join(PROJECT_ROOT, "src", "skill", "reference.md");
    const onDisk = readFileSync(refPath, "utf-8");
    const generated = handleReference("md") + "\n";
    expect(onDisk).toBe(generated);
  });

  it("every command has a usage string", () => {
    for (const cmd of COMMANDS) {
      expect(cmd.usage).toBeTruthy();
      expect(cmd.usage).toContain("claudestory");
    }
  });

  it("every MCP tool has a description", () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.description).toBeTruthy();
      expect(tool.name).toMatch(/^claudestory_/);
    }
  });
});
