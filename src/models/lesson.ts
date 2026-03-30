import { z } from "zod";
import { LESSON_STATUSES, LESSON_SOURCES, DateSchema, LessonIdSchema } from "./types.js";

export const LessonSchema = z
  .object({
    id: LessonIdSchema,
    title: z.string().min(1, "Title cannot be empty"),
    content: z.string().refine((v) => v.trim().length > 0, "Content cannot be empty"),
    context: z.string(),
    source: z.enum(LESSON_SOURCES),
    tags: z.array(z.string()),
    reinforcements: z.number().int().min(0),
    lastValidated: DateSchema,
    createdDate: DateSchema,
    updatedDate: DateSchema,
    supersedes: LessonIdSchema.nullable(),
    status: z.enum(LESSON_STATUSES),
  })
  .passthrough();

export type Lesson = z.infer<typeof LessonSchema>;
