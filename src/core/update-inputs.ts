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
}
