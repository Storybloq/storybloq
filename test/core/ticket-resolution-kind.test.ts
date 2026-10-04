/**
 * T-486 U2-1: the ticket withdrawal kind. The view and its corpus, the load
 * schema's leniency, the validate warnings, the ticket-status merge group,
 * the protected keys, and the write boundary, which refuses every newly
 * effective withdrawal until the setter slice (U2-6) enables it.
 *
 * The corpus at test/fixtures/resolution-kind/ticket-cases.json is shared with
 * the Mac app's tests (M1), so the case list is pinned by name.
 *
 * Every refusal asserts the file's bytes unchanged and no .txn.json left.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ticketResolutionKindView, isEffectivelyWithdrawn } from "../../src/core/resolution-kind.js";
import { TicketSchema, type Ticket } from "../../src/models/ticket.js";
import { initProject } from "../../src/core/init.js";
import {
  authoriseTicketBytes,
  deleteTicket,
  loadProject,
  prepareTicketWrite,
  resolutionWriteContextFor,
  runTransactionUnlocked,
  serializeJSON,
  withProjectLock,
  writeTicket,
  writeTicketUnlocked,
} from "../../src/core/project-loader.js";
import { ResolutionWriteContextError, TICKET_WITHDRAWAL_DISABLED } from "../../src/core/resolution-write-guard.js";
import { validateProject } from "../../src/core/validation.js";
import { threeWayMerge } from "../../src/core/merge-driver.js";
import { getMergeRules } from "../../src/core/field-classification.js";
import { teamSetup } from "../../src/core/team-setup.js";
import { handleTicketMetaSet, handleTicketUpdate } from "../../src/cli/commands/ticket.js";
import { handleResolve } from "../../src/cli/commands/conflicts.js";
import { restoreRecord } from "../../src/core/ledger-restore.js";
import { applyRepairPatches } from "../../src/cli/commands/repair.js";
import { capabilityCatalog } from "../../src/cli/commands/capability.js";
import { todayISO } from "../../src/cli/helpers.js";

interface Case {
  name: string;
  ticket: Record<string, unknown>;
  expectedKindView: unknown;
}

const CORPUS = JSON.parse(
  readFileSync(join(__dirname, "../fixtures/resolution-kind/ticket-cases.json"), "utf-8"),
) as Case[];

const byName = (name: string): Case => {
  const c = CORPUS.find((x) => x.name === name);
  if (!c) throw new Error(`corpus case missing: ${name}`);
  return c;
};

describe("T-486 U2 ticket corpus: the view", () => {
  it("carries exactly the agreed cases", () => {
    expect(CORPUS.map((c) => c.name)).toEqual([
      "effective",
      "absent",
      "reopened open",
      "reopened inprogress",
      "open with a still-matching date",
      "stale date",
      "same day re-completion (W5 residual)",
      "malformed missing reason",
      "malformed empty reason",
      "malformed bad closedOn",
      "malformed unknown kind",
      "malformed string",
      "malformed array",
      "malformed null",
      "wrong entity fixed",
      "wrong entity wontfix",
      "wrong entity duplicate",
      "wrong entity superseded",
      "wrong entity not_reproducible",
      "owner checkpoint carrying a withdrawal",
      "reserved key collision",
    ]);
  });

  for (const c of CORPUS) {
    it(`${c.name}: kind view`, () => {
      expect(ticketResolutionKindView(c.ticket)).toEqual(c.expectedKindView);
      expect(isEffectivelyWithdrawn(c.ticket)).toBe((c.expectedKindView as { state: string }).state === "effective");
    });
  }

  it("K4: every corpus ticket parses under the load schema, whatever its resolution metadata", () => {
    for (const c of CORPUS) expect(TicketSchema.safeParse(c.ticket).success, c.name).toBe(true);
  });
});

// --- boards ---------------------------------------------------------------

const saved: Record<string, string | undefined> = {};
let scratchHome: string;
let globalConfig: string;

beforeAll(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "t486-u21-home-"));
  globalConfig = join(scratchHome, "gitconfig");
  for (const k of ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "STORYBLOQ_VERSION"]) saved[k] = process.env[k];
  process.env.HOME = scratchHome;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.STORYBLOQ_VERSION = "1.16.0";
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(scratchHome, { recursive: true, force: true });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  rmSync(globalConfig, { force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

type Board = "non-team" | "ready" | "low-fence";

/** A project in a fresh git repository: plain, team-ready, or team with the fence lowered below 1.16.0. */
async function board(kind: Board, tickets: Record<string, unknown>[] = []): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "t486-u21-"));
  dirs.push(root);
  git(root, "init", "-q");
  await initProject(root, { name: "t486" });
  if (kind !== "non-team") {
    const path = join(root, ".story", "config.json");
    const config = JSON.parse(readFileSync(path, "utf-8"));
    config.team = { enabled: true };
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
    await teamSetup(root);
    if (kind === "low-fence") {
      const c = JSON.parse(readFileSync(path, "utf-8"));
      c.team.minCliVersion = "1.15.0";
      writeFileSync(path, JSON.stringify(c, null, 2) + "\n");
    }
  }
  for (const t of tickets) writeRaw(root, t);
  return root;
}

const ticketPath = (root: string, id: string) => join(root, ".story", "tickets", `${id}.json`);
/** Raw, as an old writer or a hand edit would leave it, in the writer's own format. */
const writeRaw = (root: string, t: Record<string, unknown>) => writeFileSync(ticketPath(root, String(t.id)), serializeJSON(t));
const bytes = (root: string, id: string) => readFileSync(ticketPath(root, id), "utf-8");
const readTicket = (root: string, id: string) => JSON.parse(bytes(root, id)) as Record<string, unknown>;
const noJournal = (root: string) => expect(existsSync(join(root, ".story", ".txn.json"))).toBe(false);

async function rejection(run: Promise<unknown>): Promise<Error> {
  const err = await run.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

/** Runs a write that must be refused: bytes unchanged, no journal, and the error returned. */
async function refused(root: string, id: string, run: () => Promise<unknown>): Promise<Error> {
  const before = existsSync(ticketPath(root, id)) ? bytes(root, id) : null;
  const err = await rejection(run());
  expect(existsSync(ticketPath(root, id)) ? bytes(root, id) : null).toBe(before);
  noJournal(root);
  return err;
}

const withId = (c: Case, id: string): Record<string, unknown> => ({ ...c.ticket, id });
const WITHDRAWAL = byName("effective").ticket.resolutionKind as Record<string, unknown>;
const OTHER = { ...byName("absent").ticket, id: "T-002", title: "Unrelated" };

/** The withdrawal an old writer left on a ticket it then reopened, bound to today's date. */
function reopenedToday(id = "T-001"): Record<string, unknown> {
  const today = todayISO();
  return { ...byName("absent").ticket, id, status: "open", completedDate: null, resolutionKind: { ...WITHDRAWAL, closedOn: today } };
}

// --- load and validate ------------------------------------------------------

describe("T-486 U2 load: no resolutionKind value drops a ticket (K4)", () => {
  const unusual = CORPUS.filter((c) => c.name.startsWith("malformed") || c.name.startsWith("wrong entity") || c.name === "reserved key collision");

  it("each unusual record loads with no schema_error", async () => {
    const tickets = unusual.map((c, n) => withId(c, `T-${String(n + 1).padStart(3, "0")}`));
    const root = await board("non-team", tickets);
    const { state, warnings } = await loadProject(root);
    expect(warnings.filter((w) => w.type === "schema_error")).toEqual([]);
    expect(state.tickets.map((t) => t.id).sort()).toEqual(tickets.map((t) => String(t.id)).sort());
  });
});

describe("T-486 U2 validate: why a withdrawal does not count", () => {
  const CODES = new Set(["resolution_kind_stale", "resolution_kind_malformed", "resolution_kind_wrong_entity", "reserved_key_collision"]);

  async function findingsFor(c: Case) {
    const root = await board("non-team", [withId(c, "T-001")]);
    const { state } = await loadProject(root);
    const findings = validateProject(state).findings.filter((f) => f.entity === "T-001");
    for (const f of findings) if (CODES.has(f.code)) expect(f.level, `${c.name}: ${f.code}`).toBe("warning");
    return findings;
  }
  const codesFor = async (c: Case) => (await findingsFor(c)).map((f) => f.code);

  it("no corpus case raises an error-level finding of its own", async () => {
    for (const c of CORPUS) {
      const errors = (await findingsFor(c)).filter((f) => f.level === "error" && CODES.has(f.code));
      expect(errors, c.name).toEqual([]);
    }
  });

  it("stale withdrawals warn, naming a status or date change", async () => {
    for (const name of ["reopened open", "reopened inprogress", "open with a still-matching date", "stale date"]) {
      const f = (await findingsFor(byName(name))).find((x) => x.code === "resolution_kind_stale");
      expect(f?.message, name).toBe(
        "Ticket T-001 has a withdrawal that no longer matches its completion: its status or completed date changed after it was written, for example by a client that does not know the field. It is ignored.",
      );
    }
  });

  it("a withdrawal on an owner checkpoint warns, naming the checkpoint", async () => {
    const f = (await findingsFor(byName("owner checkpoint carrying a withdrawal"))).find((x) => x.code === "resolution_kind_stale");
    expect(f?.message).toBe(
      "Ticket T-001 has a withdrawal that no longer matches its completion: the ticket is an owner checkpoint, which releases by its own resolution. It is ignored.",
    );
  });

  it("malformed and wrong-entity values warn", async () => {
    for (const c of CORPUS.filter((x) => x.name.startsWith("malformed"))) expect(await codesFor(c), c.name).toContain("resolution_kind_malformed");
    for (const kind of ["fixed", "wontfix", "duplicate", "superseded", "not_reproducible"]) {
      const f = (await findingsFor(byName(`wrong entity ${kind}`))).find((x) => x.code === "resolution_kind_wrong_entity");
      expect(f?.message).toBe(`Ticket T-001 carries the issue-only resolution kind "${kind}". It is ignored.`);
    }
  });

  it("an effective withdrawal and an absent one raise none of them", async () => {
    for (const name of ["effective", "absent", "same day re-completion (W5 residual)"]) {
      expect((await codesFor(byName(name))).filter((c) => CODES.has(c)), name).toEqual([]);
    }
  });

  it("the collision fixture warns once for each reserved key", async () => {
    const f = (await findingsFor(byName("reserved key collision"))).filter((x) => x.code === "reserved_key_collision");
    expect(f.map((x) => x.message)).toEqual([
      'Ticket T-001 stores a custom "effective" key, which collides with a reserved JSON response name.',
      'Ticket T-001 stores a custom "stored" key, which collides with a reserved JSON response name.',
    ]);
  });

  it("a deleted ticket is not reported", async () => {
    const root = await board("non-team", [{ ...withId(byName("stale date"), "T-001"), lifecycle: "deleted" }]);
    const { state } = await loadProject(root);
    expect(validateProject(state).findings.filter((f) => f.entity === "T-001" && CODES.has(f.code))).toEqual([]);
  });
});

describe("T-486 U2 collision fixture: stored keys are preserved byte for byte", () => {
  it("a load and an edit of another ticket leave the fixture's bytes unchanged", async () => {
    const root = await board("non-team", [withId(byName("reserved key collision"), "T-001"), OTHER]);
    const before = bytes(root, "T-001");
    await loadProject(root);
    expect(bytes(root, "T-001")).toBe(before);
    await handleTicketUpdate("T-002", { title: "Retitled" }, "json", root);
    expect(bytes(root, "T-001")).toBe(before);
  });

  it("an unrelated edit of the fixture itself keeps both stored values and the withdrawal", async () => {
    const c = byName("reserved key collision");
    const root = await board("non-team", [withId(c, "T-001")]);
    await handleTicketUpdate("T-001", { title: "Retitled" }, "json", root);
    const after = readTicket(root, "T-001");
    expect(after.title).toBe("Retitled");
    expect(after.effective).toStrictEqual(c.ticket.effective);
    expect(after.stored).toStrictEqual(c.ticket.stored);
    expect(after.resolutionKind).toStrictEqual(c.ticket.resolutionKind);
  });
});

// --- merge group and protected keys ----------------------------------------

describe("T-486 U2 merge: resolutionKind is in ticket-status (G1)", () => {
  it("group membership is exactly as specified, on every member", () => {
    const rules = getMergeRules("ticket");
    const members = ["status", "completedDate", "lifecycle", "ownerCheckpoint", "checkpointEvidence", "resolutionKind"];
    for (const key of members) expect(rules[key], key).toEqual({ kind: "coupled", group: "ticket-status", members });
  });

  it("X reopens while Y withdraws: one coupled conflict, never a merged withdrawal", () => {
    const base = { ...byName("absent").ticket };
    const ours = { ...base, status: "open", completedDate: null };
    const theirs = { ...base, resolutionKind: WITHDRAWAL };
    const r = threeWayMerge(base, ours, theirs, "ticket");
    expect(r.clean).toBe(false);
    expect(r.conflicts.some((c) => c.group === "ticket-status")).toBe(true);
  });
});

describe("T-486 U2 metadata protection (P1-P3)", () => {
  for (const key of ["resolutionKind", "effective", "stored"]) {
    it(`ticket meta set refuses ${key} as a protected core field`, async () => {
      const root = await board("non-team", [withId(byName("absent"), "T-001")]);
      const err = await refused(root, "T-001", () => handleTicketMetaSet("T-001", key, "x", "json", root));
      expect(err.message).toBe(`Metadata path "${key}" targets protected core field "${key}"`);
    });
  }
});

// --- write boundary ---------------------------------------------------------

describe("T-486 U2 write boundary: every newly effective withdrawal is refused before U2-6", () => {
  it.each(["non-team", "ready", "low-fence"] as const)("W6: on a %s board, ticket update restoring complete around a stale withdrawal is refused", async (kind) => {
    const root = await board(kind, [reopenedToday()]);
    const err = await refused(root, "T-001", () => handleTicketUpdate("T-001", { status: "complete" }, "json", root, true));
    expect(err.message).toBe(`Refusing the write to .story/tickets/T-001.json: ${TICKET_WITHDRAWAL_DISABLED}.`);
  });

  it("force does not bypass the boundary: an activation through ticket update with force=true is refused", async () => {
    const root = await board("non-team", [reopenedToday()]);
    const forced = await refused(root, "T-001", () => handleTicketUpdate("T-001", { status: "complete" }, "json", root, true));
    expect(forced.message).toBe(`Refusing the write to .story/tickets/T-001.json: ${TICKET_WITHDRAWAL_DISABLED}.`);
    expect(readTicket(root, "T-001").status).toBe("open");
  });

  it("W6: the same update succeeds once the withdrawal is gone (the refusal is the withdrawal, not the update)", async () => {
    const { resolutionKind: _gone, ...plain } = reopenedToday();
    const root = await board("non-team", [plain]);
    await handleTicketUpdate("T-001", { status: "complete" }, "json", root, true);
    expect(readTicket(root, "T-001").status).toBe("complete");
  });

  it("W7: ledger restore refuses a ticket outright, so it can never activate a withdrawal", async () => {
    const root = await board("non-team", [reopenedToday()]);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "reopened");
    const expectOid = git(root, "rev-parse", "HEAD");
    const reopened = bytes(root, "T-001");
    writeRaw(root, { ...reopenedToday(), status: "complete", completedDate: todayISO() });
    git(root, "add", "-A");
    git(root, "commit", "-qm", "completed");
    const fromOid = git(root, "rev-parse", "HEAD");
    writeFileSync(ticketPath(root, "T-001"), reopened);
    git(root, "add", "-A");
    git(root, "commit", "-qm", "reopened again");
    const err = await refused(root, "T-001", () =>
      restoreRecord(root, { kind: "record", path: ".story/tickets/T-001.json" }, fromOid, expectOid, { capabilityCatalog }),
    );
    expect(err.message).toContain("ledger restore does not restore tickets: it covers rulings, notes and issues only");
  });

  it("W8: storybloq resolve --use theirs to the matching completion is refused", async () => {
    const root = await board("non-team");
    const ours = reopenedToday();
    const theirs: Record<string, unknown> = { ...ours, status: "complete", completedDate: todayISO() };
    const members = ["status", "completedDate"];
    writeRaw(root, {
      ...ours,
      _conflicts: members.map((m) => ({ fieldPath: `/${m}`, field: m, kind: "coupled", group: "ticket-status", base: ours[m], ours: ours[m], theirs: theirs[m] })),
    });
    const err = await refused(root, "T-001", () => handleResolve("T-001", root, { field: "status", use: "theirs", format: "json" }));
    expect(err.message).toContain(TICKET_WITHDRAWAL_DISABLED);
  });

  it("an ordinary write of a new effective withdrawal is refused (the exported writeTicket, no loaded state: C3)", async () => {
    const root = await board("non-team", [withId(byName("absent"), "T-001")]);
    const err = await refused(root, "T-001", () => writeTicket({ ...withId(byName("effective"), "T-001") } as unknown as Ticket, root));
    expect(err.message).toBe(`Refusing the write to .story/tickets/T-001.json: ${TICKET_WITHDRAWAL_DISABLED}.`);
  });

  it("W9: a newly inserted malformed object is refused, naming the field", async () => {
    const root = await board("non-team", [withId(byName("absent"), "T-001")]);
    const err = await refused(root, "T-001", () => writeTicket({ ...withId(byName("malformed missing reason"), "T-001") } as unknown as Ticket, root));
    expect(err.message).toMatch(/^Refusing the write to \.story\/tickets\/T-001\.json: resolutionKind is not a valid withdrawal \(resolutionKind\.reason: /);
  });

  it("W9: an issue kind written onto a ticket is refused, naming it", async () => {
    const root = await board("non-team", [withId(byName("absent"), "T-001")]);
    const err = await refused(root, "T-001", () => writeTicket({ ...withId(byName("wrong entity fixed"), "T-001") } as unknown as Ticket, root));
    expect(err.message).toBe('Refusing the write to .story/tickets/T-001.json: resolutionKind.kind "fixed" is an issue kind; a ticket can only be withdrawn.');
  });

  it("W10: a newly added object with a mismatched closedOn is refused", async () => {
    const root = await board("non-team", [withId(byName("absent"), "T-001")]);
    const err = await refused(root, "T-001", () => writeTicket({ ...withId(byName("stale date"), "T-001") } as unknown as Ticket, root));
    expect(err.message).toBe("Refusing the write to .story/tickets/T-001.json: resolutionKind.closedOn 2026-02-01 is not the completedDate 2026-03-01.");
  });

  it("W10: a withdrawal added to a ticket that is not complete is refused", async () => {
    const root = await board("non-team", [withId(byName("absent"), "T-001")]);
    const err = await refused(root, "T-001", () => writeTicket({ ...withId(byName("reopened open"), "T-001") } as unknown as Ticket, root));
    expect(err.message).toBe("Refusing the write to .story/tickets/T-001.json: resolutionKind is written on a ticket whose status is open, not complete.");
  });

  it("W11: a withdrawal object added to an owner checkpoint is refused", async () => {
    const c = byName("owner checkpoint carrying a withdrawal");
    const { resolutionKind: _none, ...checkpoint } = withId(c, "T-001");
    const root = await board("non-team", [checkpoint]);
    const err = await refused(root, "T-001", () => writeTicket({ ...withId(c, "T-001") } as unknown as Ticket, root));
    expect(err.message).toBe("Refusing the write to .story/tickets/T-001.json: resolutionKind is written on an owner checkpoint, which releases by its own resolution.");
  });

  it("W12: an unrelated ticket update on pre-existing malformed metadata succeeds and keeps the slot byte for byte", async () => {
    for (const c of CORPUS.filter((x) => x.name.startsWith("malformed") || x.name.startsWith("wrong entity"))) {
      const root = await board("non-team", [withId(c, "T-001")]);
      const slot = slotText(bytes(root, "T-001"));
      await handleTicketUpdate("T-001", { title: "Retitled" }, "json", root);
      const after = bytes(root, "T-001");
      expect(JSON.parse(after).title, c.name).toBe("Retitled");
      expect(slotText(after), c.name).toBe(slot);
    }
  });

  it("W13: raw removal of the key succeeds on a low-fence board", async () => {
    const root = await board("low-fence", [withId(byName("effective"), "T-001")]);
    const { resolutionKind: _gone, ...removed } = readTicket(root, "T-001");
    await writeTicket(removed as unknown as Ticket, root);
    expect("resolutionKind" in readTicket(root, "T-001")).toBe(false);
  });

  it("deactivation passes: reopening a ticket with an effective withdrawal keeps the now-stale object", async () => {
    const root = await board("low-fence", [withId(byName("effective"), "T-001")]);
    // force: the completed-ticket ownership guard is not what this pins.
    await handleTicketUpdate("T-001", { status: "open" }, "json", root, true);
    const after = readTicket(root, "T-001");
    expect(after.status).toBe("open");
    expect(after.resolutionKind).toStrictEqual(WITHDRAWAL);
  });

  it("an unrelated edit on a ticket whose withdrawal is already effective passes (nothing newly effective)", async () => {
    const root = await board("low-fence", [withId(byName("effective"), "T-001")]);
    await handleTicketUpdate("T-001", { title: "Retitled" }, "json", root);
    expect(readTicket(root, "T-001").title).toBe("Retitled");
  });

  it("the team tombstone keeps an existing withdrawal and passes the boundary", async () => {
    const root = await board("low-fence", [withId(byName("effective"), "T-001")]);
    await deleteTicket("T-001", root);
    const after = readTicket(root, "T-001");
    expect(after.lifecycle).toBe("deleted");
    expect(after.resolutionKind).toStrictEqual(WITHDRAWAL);
  });
});

/** The serialized `resolutionKind` member of a top-level ticket object, as written. */
function slotText(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith('  "resolutionKind":'));
  if (start < 0) throw new Error("no resolutionKind slot");
  let end = start + 1;
  while (end < lines.length && !/^ {2}"|^}/.test(lines[end]!)) end++;
  return lines.slice(start, end).join("\n").replace(/,$/, "");
}

// --- the write context ------------------------------------------------------

describe("T-486 U2 the ticket write context (H1, H2)", () => {
  const plain = () => ({ ...withId(byName("absent"), "T-003"), title: "Context" }) as unknown as Ticket;

  it("a write prepared and committed under the lock's context lands", async () => {
    const root = await board("non-team");
    await withProjectLock(root, { strict: false }, () => writeTicketUnlocked(plain(), root));
    expect(readTicket(root, "T-003").title).toBe("Context");
  });

  it("outside any lock the write is refused, naming the missing context", async () => {
    const root = await board("non-team");
    const err = await refused(root, "T-003", () => writeTicketUnlocked(plain(), root));
    expect(err).toBeInstanceOf(ResolutionWriteContextError);
    expect(err.message).toMatch(/^no project lock is held for /);
  });

  it("H1: a context kept past its lock is refused at prepare", async () => {
    const root = await board("non-team");
    let kept: ReturnType<typeof resolutionWriteContextFor> | undefined;
    await withProjectLock(root, { strict: false }, async () => {
      kept = resolutionWriteContextFor(root);
    });
    const err = await refused(root, "T-003", () =>
      withProjectLock(root, { strict: false }, async () => {
        await prepareTicketWrite(plain(), root, { resolutionContext: kept });
      }),
    );
    expect(err).toBeInstanceOf(ResolutionWriteContextError);
    expect(err.message).toMatch(/^the given write context belongs to a lock that was released/);
  });

  it("H1: bytes prepared under one lock are refused when committed under the next", async () => {
    const root = await board("non-team");
    let prepared: { target: string; content: string } | undefined;
    await withProjectLock(root, { strict: false }, async () => {
      prepared = await prepareTicketWrite(plain(), root);
    });
    const err = await refused(root, "T-003", () =>
      withProjectLock(root, { strict: false }, () => runTransactionUnlocked(root, [{ op: "write", ...prepared! }])),
    );
    expect(err.message).toMatch(/prepare it again$/);
  });

  it("H2: the transaction commits only the bytes that were prepared", async () => {
    const root = await board("non-team");
    const err = await refused(root, "T-003", () =>
      withProjectLock(root, { strict: false }, async () => {
        const p = await prepareTicketWrite(plain(), root);
        await runTransactionUnlocked(root, [{ op: "write", target: p.target, content: p.content.replace("Context", "Swapped") }]);
      }),
    );
    expect(err.message).toBe("Refusing the write to .story/tickets/T-003.json: the bytes being committed are not the bytes that were prepared for it; prepare it again");
  });

  it("H2: raw ticket bytes nobody prepared are refused by the transaction", async () => {
    const root = await board("non-team");
    const err = await refused(root, "T-003", () =>
      withProjectLock(root, { strict: false }, () => runTransactionUnlocked(root, [{ op: "write", target: ticketPath(root, "T-003"), content: serializeJSON(plain()) }])),
    );
    expect(err.message).toBe(
      "Refusing the write to .story/tickets/T-003.json: nothing prepared it under this lock (ticket and issue writes go through prepareTicketWrite and prepareIssueWrite); prepare it again",
    );
  });

  it("H2: authoriseTicketBytes checks the record its bytes are, and refuses bytes that are not an object", async () => {
    const root = await board("non-team", [withId(byName("absent"), "T-001")]);
    await withProjectLock(root, { strict: false }, async () => {
      expect(() => authoriseTicketBytes(root, ticketPath(root, "T-001"), {}, "[]\n")).toThrow(
        "Refusing the write to .story/tickets/T-001.json: its bytes are not a JSON object",
      );
      expect(() => authoriseTicketBytes(root, ticketPath(root, "T-001"), readTicket(root, "T-001"), serializeJSON(withId(byName("effective"), "T-001")))).toThrow(
        TICKET_WITHDRAWAL_DISABLED,
      );
    });
    noJournal(root);
  });

  it("repair: an ordinary ticket repair goes through the boundary and commits exactly its patch", async () => {
    const original = { ...withId(byName("absent"), "T-001"), blockedBy: ["T-999"] };
    const root = await board("non-team", [original]);
    await withProjectLock(root, { strict: false }, () => applyRepairPatches(root, [{ id: "T-001", type: "ticket", set: { blockedBy: [] }, unset: [] }]));
    expect(bytes(root, "T-001")).toBe(serializeJSON({ ...original, blockedBy: [] }));
    noJournal(root);
  });

  it("repair: a ticket repair that would make a stale withdrawal effective is refused", async () => {
    const root = await board("non-team", [reopenedToday()]);
    const err = await refused(root, "T-001", () =>
      withProjectLock(root, { strict: false }, () =>
        applyRepairPatches(root, [{ id: "T-001", type: "ticket", set: { status: "complete", completedDate: todayISO() }, unset: [] }]),
      ),
    );
    expect(err.message).toBe(`Refusing the write to .story/tickets/T-001.json: ${TICKET_WITHDRAWAL_DISABLED}.`);
  });

  it("a transaction naming the same ticket twice is refused before anything is journaled", async () => {
    const root = await board("non-team");
    const err = await refused(root, "T-003", () =>
      withProjectLock(root, { strict: false }, async () => {
        const p = await prepareTicketWrite(plain(), root);
        await runTransactionUnlocked(root, [{ op: "write", ...p }, { op: "write", ...p }]);
      }),
    );
    expect(err.message).toBe("Transaction names tickets/T-003.json more than once; each ticket or issue may be written once per transaction");
  });
});
