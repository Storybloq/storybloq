/**
 * T-538 commit 3 (plan v5 6.1): the fault schedule. `--fault-schedule <session>=<id>:<selector>[,...]` arms one
 * entry per session; `--fault <sel>` is `1=f1:<sel>`. Entries arm sessions 1 to k with no gap; the attempt then
 * has exactly k + 1 sessions, the last unarmed.
 */
import { existsSync } from "node:fs";

export interface ScheduleEntry {
  readonly session: number;
  readonly id: string;
  readonly selector: string;
}

/** One entry as `HarnessFacts.schedule` records it: whether its own marker existed after its session. */
export interface ScheduleFact extends ScheduleEntry {
  readonly fired: boolean;
}

const ID = /^[A-Za-z0-9_-]{1,32}$/;
/** A point, a point ending in `:*`, or either with `#n`. */
const SELECTOR = /^[a-z][a-z0-9:_.\/-]*(:\*)?(#[1-9][0-9]*)?$/i;

export function parseSchedule(text: string): readonly ScheduleEntry[] {
  if (text.trim() === "") throw new Error("--fault-schedule is empty");
  const entries = text.split(",").map((part) => {
    const m = /^([1-9][0-9]*)=([^:]+):(.+)$/.exec(part.trim());
    if (m === null) throw new Error(`--fault-schedule entry ${part} is not <session>=<id>:<selector>`);
    const [, session, id, selector] = m;
    if (!ID.test(id!)) throw new Error(`--fault-schedule id ${id} is not an id`);
    if (!SELECTOR.test(selector!)) throw new Error(`--fault-schedule selector ${selector} is not a point, point:* or point#n`);
    return { session: Number(session), id: id!, selector: selector! };
  });
  return checkSchedule(entries);
}

/** Refuses two entries sharing an id or a session, and sessions that are not exactly 1 to k. Returns the entries in session order. */
export function checkSchedule(entries: readonly ScheduleEntry[]): readonly ScheduleEntry[] {
  const ids = new Set(entries.map((e) => e.id));
  if (ids.size !== entries.length) throw new Error("--fault-schedule: two entries share an id");
  const sessions = new Set(entries.map((e) => e.session));
  if (sessions.size !== entries.length) throw new Error("--fault-schedule: two entries share a session");
  const sorted = [...entries].sort((a, b) => a.session - b.session);
  sorted.forEach((e, i) => {
    if (e.session !== i + 1) throw new Error(`--fault-schedule: the armed sessions must be 1 to ${entries.length} with no gap`);
  });
  return sorted;
}

/** The schedule a run takes from its two flags; null when neither is given. */
export function scheduleFor(fault: string | null, schedule: string | null): readonly ScheduleEntry[] | null {
  if (fault !== null && schedule !== null) throw new Error("--fault and --fault-schedule are exclusive");
  if (schedule !== null) return parseSchedule(schedule);
  // `--fault <sel>` is the one-entry schedule `1=f1:<sel>`: its own id, so it leaves a fired record and a kill snapshot too.
  if (fault !== null) return checkSchedule([{ session: 1, id: "f1", selector: fault }]);
  return null;
}

/** The entry armed in a session, if any. */
export const armedIn = (schedule: readonly ScheduleEntry[] | null, session: number): ScheduleEntry | null => schedule?.find((e) => e.session === session) ?? null;

/** An entry's marker beside the events log. */
export const firedMarker = (events: string, id: string): string => `${events}.fired.${id}`;
/** An entry's kill snapshot beside the events log. */
export const killSnapshot = (events: string, id: string): string => `${events}.kill.${id}.json`;

export const scheduleFact = (e: ScheduleEntry, events: string): ScheduleFact => ({ ...e, fired: existsSync(firedMarker(events, e.id)) });

/** A selector's point and occurrence: `point` or `point#n` (n from 1). */
export function parseSelector(selector: string): { readonly point: string; readonly nth: number } {
  const m = /^(.*)#([1-9][0-9]*)$/.exec(selector);
  return m ? { point: m[1]!, nth: Number(m[2]) } : { point: selector, nth: 1 };
}

/** Whether a point matches a selector's point: equal, or, for a point ending in `:*`, any longer point with that prefix. */
export function pointMatches(selectorPoint: string, point: string): boolean {
  if (!selectorPoint.endsWith(":*")) return point === selectorPoint;
  const prefix = selectorPoint.slice(0, -1);
  return point.length > prefix.length && point.startsWith(prefix);
}
