import { teamSetup, LOCAL_ALLOCATOR_NOTE, type SetupResult } from "../../core/team-setup.js";
import { RESOLUTION_KIND_MIN_CLI_VERSION } from "../../core/team-capabilities.js";

export interface TeamSetupOutput {
  output: string;
  exitCode: number;
}

export async function handleTeamSetup(root: string, opts: { format?: "md" | "json" }): Promise<TeamSetupOutput> {
  try {
    const result = await teamSetup(root);

    if (opts.format === "json") {
      return { output: JSON.stringify(result, null, 2), exitCode: 0 };
    }

    const lines: string[] = [
      "Team merge setup complete:",
      `  Merge driver: ${result.driverInstalled ? "installed" : "skipped"}`,
      `  .gitattributes: ${result.gitattributesWritten ? "written" : "skipped"}`,
      `  Config version: ${result.versionUpdated ? "updated" : "skipped"}`,
      `  Git root: ${result.gitRoot}`,
    ];
    // T-486: kind writes refuse until the fence admits them; say so where it was decided.
    if (result.resolutionKindFence === "deferred") {
      lines.push(`  Resolution kinds: fence not raised (this CLI is below ${RESOLUTION_KIND_MIN_CLI_VERSION}); kind writes refuse until team setup runs on a current CLI`);
    }
    // ISS-734: local-allocator collision guidance. Every teammate runs team
    // setup on their own clone, so this is the output the whole team sees.
    if (result.idAllocator === "local") {
      lines.push("", LOCAL_ALLOCATOR_NOTE);
    }
    return { output: lines.join("\n"), exitCode: 0 };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.format === "json") {
      return { output: JSON.stringify({ error: message }), exitCode: 1 };
    }
    return { output: `Error: ${message}`, exitCode: 1 };
  }
}
