import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeConfig, writeRoadmap, loadProject } from "./project-loader.js";
import { ProjectLoaderError, CURRENT_SCHEMA_VERSION, INTEGRITY_WARNING_TYPES } from "./errors.js";
import type { Config } from "../models/config.js";
import type { Roadmap } from "../models/roadmap.js";

export interface InitOptions {
  name: string;
  force?: boolean;
  type?: string;
  language?: string;
}

export interface InitResult {
  readonly root: string;
  readonly created: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Scaffolds a new .story/ directory structure.
 * Refuses if .story/ already exists unless force is true.
 * Force mode overwrites config.json + roadmap.json only — preserves existing data files.
 */
export async function initProject(
  root: string,
  options: InitOptions,
): Promise<InitResult> {
  const absRoot = resolve(root);
  const wrapDir = join(absRoot, ".story");

  // Check if already exists
  let exists = false;
  try {
    const s = await stat(wrapDir);
    if (s.isDirectory()) exists = true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ProjectLoaderError(
        "io_error",
        `Cannot check .story/ directory: ${(err as Error).message}`,
        err,
      );
    }
  }

  if (exists && !options.force) {
    throw new ProjectLoaderError(
      "conflict",
      ".story/ already exists. Use --force to overwrite config and roadmap.",
    );
  }

  // Create directories
  await mkdir(join(wrapDir, "tickets"), { recursive: true });
  await mkdir(join(wrapDir, "issues"), { recursive: true });
  await mkdir(join(wrapDir, "handovers"), { recursive: true });
  await mkdir(join(wrapDir, "notes"), { recursive: true });

  const created: string[] = [
    ".story/config.json",
    ".story/roadmap.json",
    ".story/tickets/",
    ".story/issues/",
    ".story/handovers/",
    ".story/notes/",
  ];

  // Today's date
  const today = new Date().toISOString().slice(0, 10);

  const config: Config = {
    version: 2,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    project: options.name,
    type: options.type ?? "generic",
    language: options.language ?? "unknown",
    features: {
      tickets: true,
      issues: true,
      handovers: true,
      roadmap: true,
      reviews: true,
    },
  };

  const roadmap: Roadmap = {
    title: options.name,
    date: today,
    phases: [
      {
        id: "p0",
        label: "PHASE 0",
        name: "Setup",
        description: "Initial project setup.",
      },
    ],
    blockers: [],
  };

  await writeConfig(config, absRoot);
  await writeRoadmap(roadmap, absRoot);

  // Validate existing data files when force-reinitializing.
  // Uses loadProject (permissive) — catches both JSON parse errors AND Zod schema
  // violations, matching exactly what strict mode will reject on future writes.
  const warnings: string[] = [];
  if (options.force && exists) {
    try {
      const { warnings: loadWarnings } = await loadProject(absRoot);
      for (const w of loadWarnings) {
        if ((INTEGRITY_WARNING_TYPES as readonly string[]).includes(w.type)) {
          warnings.push(`${w.file}: ${w.message}`);
        }
      }
    } catch {
      // loadProject may throw on critical file errors (config/roadmap) —
      // we just wrote those, so this shouldn't happen, but don't let
      // validation failures block init.
    }
  }

  return {
    root: absRoot,
    created,
    warnings,
  };
}
