/**
 * ISS-1432 N1: `loadProjectNoRecover` reads a board with a valid pending
 * transaction journal and never recovers it: the journal and the file it
 * would rewrite stay byte-identical, and the state still loads.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { cleanupTempDirs, isolateGit } from "../mcp/board-git-fixtures.js";
import { loadProjectNoRecover } from "../../src/core/project-loader.js";
import { bytes, fixture, writePendingJournal } from "./land-fixtures.js";

let restoreGit: () => void;
beforeEach(() => { restoreGit = isolateGit(); });
afterEach(() => { restoreGit(); cleanupTempDirs(); });

describe("loadProjectNoRecover (ISS-1432 N1)", () => {
  it("N1: a pending journal is left alone and the state loads", async () => {
    const fx = await fixture();
    const journal = writePendingJournal(fx.board, fx.issue.path);
    const temp = `${fx.issue.path}.4242.tmp`;
    const before = [bytes(journal), bytes(fx.issue.path), bytes(temp)];
    const { state } = await loadProjectNoRecover(fx.board);
    expect(state.issueByID(fx.issue.id)?.title).toBe("Land here");
    expect(state.ticketByID(fx.ticket.id)).toBeDefined();
    expect(existsSync(journal)).toBe(true);
    expect([bytes(journal), bytes(fx.issue.path), bytes(temp)]).toEqual(before);
  });
});
