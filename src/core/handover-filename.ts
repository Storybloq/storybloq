import { randomBytes } from "node:crypto";
import { localDateOf } from "./local-date.js";

/**
 * The date `handover create` puts in a filename for `now`: the UTC date in
 * team mode, the local date otherwise. ISS-1499 slice B: the recent-lines
 * window's cutoff uses the same rule.
 */
export function handoverFilenameDate(now: Date, team: boolean): string {
  if (!team) return localDateOf(now);
  return [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function generateTeamHandoverFilename(slug: string): string {
  const now = new Date();
  const date = handoverFilenameDate(now, true);
  const time = [
    String(now.getUTCHours()).padStart(2, "0"),
    String(now.getUTCMinutes()).padStart(2, "0"),
    String(now.getUTCSeconds()).padStart(2, "0"),
  ].join("");
  const entropy = randomBytes(4).toString("hex");
  return `${date}-${time}-${entropy}-${slug}.md`;
}
