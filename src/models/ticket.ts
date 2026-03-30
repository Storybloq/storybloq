import { z } from "zod";
import {
  TICKET_STATUSES,
  TICKET_TYPES,
  DateSchema,
  TicketIdSchema,
} from "./types.js";

export const TicketSchema = z
  .object({
    id: TicketIdSchema,
    title: z.string().min(1),
    description: z.string(),
    type: z.enum(TICKET_TYPES),
    status: z.enum(TICKET_STATUSES),
    phase: z.string().nullable(),
    order: z.number().int(),
    createdDate: DateSchema,
    completedDate: DateSchema.nullable(),
    blockedBy: z.array(TicketIdSchema),
    parentTicket: TicketIdSchema.nullable().optional(),
    // Attribution fields — unused in v1, baked in to avoid future migration
    createdBy: z.string().nullable().optional(),
    assignedTo: z.string().nullable().optional(),
    lastModifiedBy: z.string().nullable().optional(),
    // ISS-027: Autonomous session ownership — set when ticket claimed as inprogress
    claimedBySession: z.string().nullable().optional(),
  })
  .passthrough();

export type Ticket = z.infer<typeof TicketSchema>;
