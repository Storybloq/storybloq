/**
 * T-481 D2a: the issue status image, shared by the CLI update, the issue pick
 * and the pending-mutation classifier, so the pick's marker, its write, its
 * replay and the classifier's prediction are one function.
 */
import type { Issue } from "../models/issue.js";
import type { IssueStatus } from "../models/types.js";
import { localDateOf } from "./local-date.js";

/**
 * T-481 D2a: what a status-only update does to an issue, exactly as
 * `handleIssueUpdate` applies it: the status, `resolvedDate` set on entering
 * resolved and cleared on leaving it, and a stored `resolutionKind` dropped
 * when the status changes (`applyResolutionKind` with no kind; `applyDisposition`
 * with no disposition returns the issue unchanged). The issue pick fingerprints
 * and writes this image, so its marker describes the write that happens.
 */
export function issueStatusImage(existing: Issue, status: IssueStatus): Issue {
  if (status === existing.status) return existing;
  const changed: Issue = {
    ...existing,
    status,
    ...(status === "resolved" && { resolvedDate: localDateOf(new Date()) }),
    ...(existing.status === "resolved" && { resolvedDate: null }),
  };
  if (!Object.prototype.hasOwnProperty.call(changed, "resolutionKind")) return changed;
  const { resolutionKind: _dropped, ...rest } = changed as Issue & { resolutionKind?: unknown };
  return rest as Issue;
}
