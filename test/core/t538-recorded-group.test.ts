/**
 * T-538 commit 4: a group known only by its recorded id (the eval driver's sweep and its restart recovery) is
 * signalled and probed through process-group.ts, so scripts/ holds no negative-pid kill.
 */
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { processGroupSeams, recordedGroupAlive, signalRecordedGroup } from "../../src/core/process-group.js";

const seams = { probe: processGroupSeams.probe, send: processGroupSeams.send };
afterEach(() => { processGroupSeams.probe = seams.probe; processGroupSeams.send = seams.send; });

const eperm = (): never => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); };

async function until(f: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (f()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return f();
}

describe.skipIf(process.platform === "win32")("T-538 commit 4: a recorded group with no child handle", () => {
  it("signalRecordedGroup reaches a real group, and recordedGroupAlive then reports it gone", async () => {
    const child = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    const pgid = child.pid!;
    try {
      expect(recordedGroupAlive(pgid)).toBe(true);
      signalRecordedGroup(pgid, "SIGKILL");
      expect(await until(() => !recordedGroupAlive(pgid), 3000)).toBe(true);
      expect(() => signalRecordedGroup(pgid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    } finally { try { process.kill(pgid, "SIGKILL"); } catch { /* gone */ } }
  });

  it("both go through processGroupSeams: 0 is the probe, any other signal the send", () => {
    const seen: string[] = [];
    processGroupSeams.probe = (g) => { seen.push(`probe ${g}`); };
    processGroupSeams.send = (g, s) => { seen.push(`send ${g} ${s}`); };
    signalRecordedGroup(4242, 0);
    signalRecordedGroup(4242, "SIGKILL");
    expect(recordedGroupAlive(4242)).toBe(true);
    expect(seen).toEqual(["probe 4242", "send 4242 SIGKILL", "probe 4242"]);
  });

  it("an EPERM answer counts as a group that may still exist, and the signal's EPERM is thrown, not swallowed", () => {
    processGroupSeams.probe = eperm;
    processGroupSeams.send = eperm;
    expect(recordedGroupAlive(4242)).toBe(true);
    expect(() => signalRecordedGroup(4242, "SIGKILL")).toThrow(expect.objectContaining({ code: "EPERM" }));
  });

  it.each([0, 1, -5, 1.5, Number.NaN])("the id %s is refused before anything is sent", (pgid) => {
    const seen: number[] = [];
    processGroupSeams.probe = (g) => { seen.push(g); };
    processGroupSeams.send = (g) => { seen.push(g); };
    expect(() => signalRecordedGroup(pgid, "SIGKILL")).toThrow(/not a recorded process group id/);
    expect(() => recordedGroupAlive(pgid)).toThrow(/not a recorded process group id/);
    expect(seen).toEqual([]);
  });
});
