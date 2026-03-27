import {
  withProjectLock,
  writeLessonUnlocked,
  deleteLessonUnlocked,
} from "../../core/project-loader.js";
import { nextLessonID } from "../../core/id-allocation.js";
import { buildLessonDigest } from "../../core/lessons.js";
import {
  formatLessonList,
  formatLesson,
  formatLessonDigest,
  formatLessonCreateResult,
  formatLessonUpdateResult,
  formatLessonReinforceResult,
  formatLessonDeleteResult,
  formatError,
  ExitCode,
} from "../../core/output-formatter.js";
import {
  LESSON_STATUSES,
  LESSON_SOURCES,
  type LessonStatus,
  type LessonSource,
  type OutputFormat,
} from "../../models/types.js";
import type { Lesson } from "../../models/lesson.js";
import {
  todayISO,
  normalizeTags,
  CliValidationError,
} from "../helpers.js";
import type { CommandContext, CommandResult } from "../types.js";

// Re-export for register.ts
export { LESSON_STATUSES, LESSON_SOURCES };

// --- Read Handlers ---

export function handleLessonList(
  filters: { status?: string; tag?: string; source?: string },
  ctx: CommandContext,
): CommandResult {
  let lessons = [...ctx.state.lessons];

  if (filters.status) {
    if (!LESSON_STATUSES.includes(filters.status as LessonStatus)) {
      throw new CliValidationError(
        "invalid_input",
        `Unknown lesson status "${filters.status}": must be one of ${LESSON_STATUSES.join(", ")}`,
      );
    }
    lessons = lessons.filter((l) => l.status === filters.status);
  }
  if (filters.source) {
    if (!LESSON_SOURCES.includes(filters.source as LessonSource)) {
      throw new CliValidationError(
        "invalid_input",
        `Unknown lesson source "${filters.source}": must be one of ${LESSON_SOURCES.join(", ")}`,
      );
    }
    lessons = lessons.filter((l) => l.source === filters.source);
  }
  if (filters.tag) {
    const normalized = normalizeTags([filters.tag]);
    if (normalized.length === 0) {
      lessons = [];
    } else {
      const tag = normalized[0]!;
      lessons = lessons.filter((l) => l.tags.includes(tag));
    }
  }

  // Sort by reinforcements desc, then updatedDate desc
  lessons.sort((a, b) => {
    if (b.reinforcements !== a.reinforcements) return b.reinforcements - a.reinforcements;
    const dateCmp = b.updatedDate.localeCompare(a.updatedDate);
    if (dateCmp !== 0) return dateCmp;
    return a.id.localeCompare(b.id);
  });

  return { output: formatLessonList(lessons, ctx.format) };
}

export function handleLessonGet(
  id: string,
  ctx: CommandContext,
): CommandResult {
  const lesson = ctx.state.lessonByID(id);
  if (!lesson) {
    return {
      output: formatError("not_found", `Lesson ${id} not found`, ctx.format),
      exitCode: ExitCode.USER_ERROR,
      errorCode: "not_found",
    };
  }
  return { output: formatLesson(lesson, ctx.format) };
}

export function handleLessonDigest(
  ctx: CommandContext,
): CommandResult {
  const digest = buildLessonDigest(ctx.state.lessons);
  return { output: formatLessonDigest(digest, ctx.format) };
}

// --- Write Handlers ---

export async function handleLessonCreate(
  args: {
    title: string;
    content: string;
    context: string;
    source: string;
    tags?: string[];
    supersedes?: string | null;
  },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  if (!args.title.trim()) {
    throw new CliValidationError("invalid_input", "Lesson title cannot be empty");
  }
  if (!args.content.trim()) {
    throw new CliValidationError("invalid_input", "Lesson content cannot be empty");
  }
  if (!LESSON_SOURCES.includes(args.source as LessonSource)) {
    throw new CliValidationError(
      "invalid_input",
      `Unknown lesson source "${args.source}": must be one of ${LESSON_SOURCES.join(", ")}`,
    );
  }

  let createdLesson: Lesson | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const id = nextLessonID(state.lessons);
    const today = todayISO();
    const tags = args.tags ? normalizeTags(args.tags) : [];

    // Validate supersedes target exists
    if (args.supersedes) {
      const target = state.lessonByID(args.supersedes);
      if (!target) {
        throw new CliValidationError(
          "not_found",
          `Supersedes target ${args.supersedes} not found`,
        );
      }
    }

    const lesson: Lesson = {
      id,
      title: args.title,
      content: args.content,
      context: args.context,
      source: args.source as LessonSource,
      tags,
      reinforcements: 0,
      lastValidated: today,
      createdDate: today,
      updatedDate: today,
      supersedes: args.supersedes ?? null,
      status: "active",
    };

    await writeLessonUnlocked(lesson, root);

    // Auto-supersede target if specified
    if (args.supersedes) {
      const target = state.lessonByID(args.supersedes);
      if (target && target.status !== "superseded") {
        const updated: Lesson = {
          ...target,
          status: "superseded",
          updatedDate: today,
        };
        await writeLessonUnlocked(updated, root);
      }
    }

    createdLesson = lesson;
  });

  if (!createdLesson) throw new Error("Lesson not created");
  return { output: formatLessonCreateResult(createdLesson, format) };
}

export async function handleLessonUpdate(
  id: string,
  updates: {
    title?: string;
    content?: string;
    context?: string;
    tags?: string[];
    clearTags?: boolean;
    status?: string;
  },
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  if (updates.title !== undefined && !updates.title.trim()) {
    throw new CliValidationError("invalid_input", "Lesson title cannot be empty");
  }
  if (updates.content !== undefined && !updates.content.trim()) {
    throw new CliValidationError("invalid_input", "Lesson content cannot be empty");
  }
  if (updates.status && !LESSON_STATUSES.includes(updates.status as LessonStatus)) {
    throw new CliValidationError(
      "invalid_input",
      `Unknown lesson status "${updates.status}": must be one of ${LESSON_STATUSES.join(", ")}`,
    );
  }

  let updatedLesson: Lesson | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const existing = state.lessonByID(id);
    if (!existing) {
      throw new CliValidationError("not_found", `Lesson ${id} not found`);
    }

    const tagsUpdate: Partial<Lesson> = {};
    if (updates.clearTags) {
      tagsUpdate.tags = [];
    } else if (updates.tags !== undefined) {
      tagsUpdate.tags = normalizeTags(updates.tags);
    }

    const lesson: Lesson = {
      ...existing,
      ...(updates.title !== undefined && { title: updates.title }),
      ...(updates.content !== undefined && { content: updates.content }),
      ...(updates.context !== undefined && { context: updates.context }),
      ...tagsUpdate,
      ...(updates.status !== undefined && { status: updates.status as LessonStatus }),
      updatedDate: todayISO(),
    };

    await writeLessonUnlocked(lesson, root);
    updatedLesson = lesson;
  });

  if (!updatedLesson) throw new Error("Lesson not updated");
  return { output: formatLessonUpdateResult(updatedLesson, format) };
}

export async function handleLessonReinforce(
  id: string,
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  let reinforcedLesson: Lesson | undefined;

  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const existing = state.lessonByID(id);
    if (!existing) {
      throw new CliValidationError("not_found", `Lesson ${id} not found`);
    }

    const today = todayISO();
    const lesson: Lesson = {
      ...existing,
      reinforcements: existing.reinforcements + 1,
      lastValidated: today,
      updatedDate: today,
    };

    await writeLessonUnlocked(lesson, root);
    reinforcedLesson = lesson;
  });

  if (!reinforcedLesson) throw new Error("Lesson not reinforced");
  return { output: formatLessonReinforceResult(reinforcedLesson, format) };
}

export async function handleLessonDelete(
  id: string,
  format: OutputFormat,
  root: string,
): Promise<CommandResult> {
  // Check for supersedes references and delete atomically under the same lock
  await withProjectLock(root, { strict: true }, async ({ state }) => {
    const existing = state.lessonByID(id);
    if (!existing) {
      throw new CliValidationError("not_found", `Lesson ${id} not found`);
    }
    const referencing = state.lessons.filter((l) => l.supersedes === id);
    if (referencing.length > 0) {
      throw new CliValidationError(
        "conflict",
        `Cannot delete ${id}: referenced by ${referencing.map((l) => l.id).join(", ")} via supersedes`,
      );
    }
    // Delete under the same lock
    await deleteLessonUnlocked(id, root);
  });

  return { output: formatLessonDeleteResult(id, format) };
}
