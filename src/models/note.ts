import { z } from "zod";
import { NOTE_STATUSES, DateSchema, NoteIdSchema } from "./types.js";

export const NoteSchema = z
  .object({
    id: NoteIdSchema,
    title: z.string().nullable(),
    content: z.string().refine((v) => v.trim().length > 0, "Content cannot be empty"),
    tags: z.array(z.string()),
    status: z.enum(NOTE_STATUSES),
    createdDate: DateSchema,
    updatedDate: DateSchema,
  })
  .passthrough();

export type Note = z.infer<typeof NoteSchema>;
