export const columns = ["open", "inProgress", "done"] as const;
export type Column = (typeof columns)[number];
export interface Card {
  key: string;
  id: string;
  displayId: string;
  title: string;
  blocked: boolean;
  kind: "tickets" | "issues";
  severity: string | null;
  description: string;
  tags: string[];
  phaseKey: string | null;
}
export interface BoardPhase {
  key: string;
  name: string;
  label: string;
  status: string;
  current: boolean;
}
export interface Overview {
  isOrchestrator?: boolean;
  project: string;
  loadedAt: string;
  phases: BoardPhase[];
  hasUnphased: boolean;
  summary: {
    total: number;
    complete: number;
    blocked: number;
    openIssues: number;
    severity: Record<string, number>;
  };
  currentPhase: { id: string; name: string; status: string } | null;
  columns: Record<Column, { items: Card[]; total: number; offset: number }>;
  limit: number;
}
export interface OverviewQuery {
  kind: "all" | "tickets" | "issues";
  query: string;
  phase: string;
  open: number;
  inProgress: number;
  done: number;
  limit: number;
}
export const initialQuery: OverviewQuery = {
  kind: "all",
  query: "",
  phase: "all",
  open: 0,
  inProgress: 0,
  done: 0,
  limit: 6,
};
