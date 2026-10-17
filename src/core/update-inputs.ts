import type { IssueSourceRefInput } from "../models/issue.js";

/** Canonical public update inputs, shared by handlers and typed adapters. */
export interface TicketUpdateInput {
  status?: string;
  title?: string;
  type?: string;
  phase?: string | null;
  order?: number;
  description?: string;
  blockedBy?: string[];
  crossNodeBlockedBy?: string[] | null;
  parentTicket?: string | null;
  citesRuling?: string[];
  clearCitesRulings?: boolean;
  /** T-486 U2-6: "withdrawn" closes the ticket as withdrawn rather than delivered. */
  resolutionKind?: string;
  reason?: string;
  priority?: string;
  waitingOn?: string;
}

export interface IssueUpdateInput {
  status?: string;
  title?: string;
  severity?: string;
  impact?: string;
  resolution?: string | null;
  components?: string[];
  relatedTickets?: string[];
  location?: string[];
  sourceRefs?: IssueSourceRefInput[];
  order?: number;
  phase?: string | null;
  citesRuling?: string[];
  clearCitesRulings?: boolean;
  resolutionKind?: string;
  duplicateOf?: string;
  /** A disposition value, or null to clear it with its evidence. */
  disposition?: string | null;
  dispositionReason?: string;
  dispositionRef?: string;
  priority?: string;
  waitingOn?: string;
}

export interface NoteUpdateInput {
  content?: string;
  title?: string | null;
  tags?: string[];
  clearTags?: boolean;
  status?: string;
  mode?: "replace" | "append";
  confirmReplace?: boolean;
}

/** How the caller spells the two ways past the note replace guard, for its refusal text. */
export interface NoteUpdateHatches {
  confirm: string;
  append: string;
}
