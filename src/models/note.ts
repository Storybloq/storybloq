import { z } from "zod";
import { NOTE_STATUSES, DateSchema, NoteIdSchema } from "./types.js";

export const NoteSchema = z
  .object({
    id: NoteIdSchema,
    title: z.string().nullable().optional().transform((v) => v ?? null),
    content: z.string().refine((v) => v.trim().length > 0, "Content cannot be empty"),
    tags: z.array(z.string()).nullable().optional().default([]).transform((tags) =>
      (tags ?? [])
        .map((t) => t.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, ""))
        .filter((t) => t.length > 0)
        .filter((t, i, a) => a.indexOf(t) === i),
    ),
    status: z.enum(NOTE_STATUSES),
    createdDate: DateSchema,
    updatedDate: DateSchema,
  })
  .passthrough();

export type Note = z.infer<typeof NoteSchema>;
