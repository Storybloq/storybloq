/**
 * ISS-1383 S1: selftest stamps its scratch entities with the local date.
 * The selftest hard-deletes all four entities before it returns, so the
 * dates are captured at the moment of each creation write: the four
 * create-only writers are wrapped by spies that record a copy of the entity
 * and then forward to the real writer, so the selftest still runs end to end.
 * The later update writes go through the locking writers, which are not
 * wrapped, so they cannot overwrite a captured record.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const captured = vi.hoisted(() => ({ creates: [] as Array<{ type: string; entity: Record<string, unknown> }> }));
vi.mock("../../../src/core/project-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/core/project-loader.js")>();
  const wrap = <F extends (...args: any[]) => any>(type: string, real: F) =>
    (async (entity: Record<string, unknown>, root: string, options?: { createOnly?: boolean }) => {
      if (options?.createOnly === true) captured.creates.push({ type, entity: structuredClone(entity) });
      return real(entity, root, options);
    }) as unknown as F;
  return {
    ...actual,
    writeTicketUnlocked: wrap("ticket", actual.writeTicketUnlocked),
    writeIssueUnlocked: wrap("issue", actual.writeIssueUnlocked),
    writeNoteUnlocked: wrap("note", actual.writeNoteUnlocked),
    writeLessonUnlocked: wrap("lesson", actual.writeLessonUnlocked),
  };
});

import { handleSelftest } from "../../../src/cli/commands/selftest.js";
import { initProject } from "../../../src/core/init.js";

const LOCAL = "2026-03-09";
const dirs: string[] = [];
beforeEach(() => {
  captured.creates.length = 0;
  vi.stubEnv("TZ", "America/Los_Angeles");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-10T05:30:00.000Z"));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("ISS-1383 S1: selftest creation dates", () => {
  it("each of the four scratch entities is created once, stamped with the local date", async () => {
    const dir = await mkdtemp(join(tmpdir(), "selftest-date-"));
    dirs.push(dir);
    await initProject(dir, { name: "test" });
    const result = await handleSelftest(dir, "json");
    expect(JSON.parse(result.output).data.failed).toBe(0);

    const of = (type: string) => captured.creates.filter((c) => c.type === type).map((c) => c.entity);
    for (const type of ["ticket", "issue", "note", "lesson"]) expect(of(type), type).toHaveLength(1);
    expect(of("ticket")[0]!.createdDate).toBe(LOCAL);
    expect(of("issue")[0]!.discoveredDate).toBe(LOCAL);
    expect([of("note")[0]!.createdDate, of("note")[0]!.updatedDate]).toEqual([LOCAL, LOCAL]);
    const lesson = of("lesson")[0]!;
    expect([lesson.createdDate, lesson.updatedDate, lesson.lastValidated]).toEqual([LOCAL, LOCAL, LOCAL]);
  });
});
