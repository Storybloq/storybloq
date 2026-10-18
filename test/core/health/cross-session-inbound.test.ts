import { describe, it, expect } from "vitest";
import { checkCrossSessionInbound, managedSettingsPath } from "../../../src/core/health/cross-session-inbound.js";
import { ctxFor, stubDeps, HOME, PROJECT, type FileMap } from "./stub-deps.js";
import type { HealthCheck, HealthRead } from "../../../src/core/health/types.js";

const MANAGED = managedSettingsPath("darwin");
const USER = `${HOME}/.claude/settings.json`;
const PROJECT_FILE = `${PROJECT}/.claude/settings.json`;
const LOCAL = `${PROJECT}/.claude/settings.local.json`;
const UNREADABLE: HealthRead = { kind: "indeterminate", reason: "EACCES" };

/** A fixture is one value (or nothing) per layer. */
interface Fixture {
  managed?: unknown;
  user?: unknown;
  project?: unknown;
  local?: unknown;
}

const PATHS: Record<keyof Fixture, string> = { managed: MANAGED, user: USER, project: PROJECT_FILE, local: LOCAL };

function filesFor(fixture: Fixture): FileMap {
  const files: FileMap = {};
  for (const key of Object.keys(PATHS) as Array<keyof Fixture>) {
    const value = fixture[key];
    if (value === undefined) continue;
    files[PATHS[key]] = JSON.stringify({ crossSessionInbound: value });
  }
  return files;
}

function run(fixture: Fixture, platform = "darwin"): Promise<HealthCheck> {
  return checkCrossSessionInbound(ctxFor(), stubDeps({ files: filesFor(fixture), platform }));
}

/**
 * The remediation guarantee: applying the check's own steps to the fixture and
 * re-resolving must yield ok. The admin step is applied as "managed becomes
 * accept", which is exactly what the step asks the admin to do.
 */
function applySteps(fixture: Fixture, message: string): Fixture {
  const next: Fixture = { ...fixture };
  if (message.includes("Add `\"crossSessionInbound\": \"accept\"` to ~/.claude/settings.json.")) next.user = "accept";
  if (/Change crossSessionInbound from \w+ to accept in ~\/\.claude\/settings\.json\./.test(message)) next.user = "accept";
  if (message.includes("ask your admin to change it to accept")) next.managed = "accept";
  if (message.includes("Set crossSessionInbound to accept in ~/.claude/settings.json")) next.user = "accept";
  if (message.includes("Set crossSessionInbound to accept in .claude/settings.json ")) next.project = "accept";
  if (message.includes("Set crossSessionInbound to accept in .claude/settings.local.json ")) next.local = "accept";
  if (message.includes("Remove crossSessionInbound from .claude/settings.json or set it to accept there.")) delete next.project;
  if (message.includes("Remove crossSessionInbound from .claude/settings.local.json or set it to accept there.")) delete next.local;
  return next;
}

const CAVEAT =
  "A session started with a --settings flag can replace the user value but not a managed one, and repository files only ever tighten.";
const OPENER_UNSET =
  "Claude Code's crossSessionInbound setting is not set in your settings files, so a session that runs without permission prompts holds messages from your other sessions for manual review, and pen/worker messaging stalls.";
const OPENER_HOLD =
  "Claude Code's crossSessionInbound settings files resolve to hold, so messages from your other sessions are held for manual review, and pen/worker messaging stalls.";
const OPENER_REFUSE =
  "Claude Code's crossSessionInbound settings files resolve to refuse, so messages from your other sessions are rejected, and pen/worker messaging cannot work.";
const ADD_TO_USER = 'Add `"crossSessionInbound": "accept"` to ~/.claude/settings.json.';

describe("T-502 cross-session-inbound: accept outcomes", () => {
  it("is ok with a user accept and names the source", async () => {
    const check = await run({ user: "accept" });
    expect(check.status).toBe("ok");
    expect(check.detail).toMatchObject({ source: "user", scope: "settings-files", effective: "accept" });
  });

  it("is ok with a managed accept", async () => {
    const check = await run({ managed: "accept" });
    expect(check.status).toBe("ok");
    expect(check.detail.source).toBe("managed");
  });

  // Mutant (c): comparing repository layers against accept instead of the base
  // makes managed-accept-plus-local-hold report ok.
  it("a managed accept does not survive a local hold", async () => {
    const check = await run({ managed: "accept", local: "hold" });
    expect(check.status).toBe("advise");
    expect(check.detail.kind).toBe("hold");
    expect(check.message).toContain("Remove crossSessionInbound from .claude/settings.local.json");
  });

  // A stronger base with a WEAKER repository layer: the effective value must
  // stay at the base's rank. A fixture whose base is already accept cannot
  // catch an implementation that loosens the base to the repository value.
  it("a repository layer never loosens a stronger base", async () => {
    const userRefuse = await run({ user: "refuse", local: "hold" });
    expect(userRefuse.detail.effective).toBe("refuse");
    expect(userRefuse.detail.kind).toBe("refuse");

    const managedRefuse = await run({ managed: "refuse", project: "accept" });
    expect(managedRefuse.detail.effective).toBe("refuse");
    expect(managedRefuse.detail.kind).toBe("refuse");

    const managedRefuseAcceptLocal = await run({ managed: "refuse", local: "accept" });
    expect(managedRefuseAcceptLocal.detail.effective).toBe("refuse");
  });

  it("records a shadowed user value and offers no user step", async () => {
    const check = await run({ managed: "accept", user: "hold" });
    expect(check.status).toBe("ok");
    expect(check.detail.shadowedUser).toBe("hold");
    expect(check.message).not.toContain("~/.claude/settings.json");
  });
});

describe("T-502 cross-session-inbound: unset base", () => {
  // Mutant (i): substituting accept for an unset base before the outcome
  // branch makes this report ok.
  it("advises the unset kind with only the add-to-user step", async () => {
    const check = await run({});
    expect(check.status).toBe("advise");
    expect(check.detail.kind).toBe("unset");
    expect(check.message).toBe([OPENER_UNSET, ADD_TO_USER, CAVEAT].join(" "));
  });

  it("a repository accept cannot create a base", async () => {
    const check = await run({ project: "accept" });
    expect(check.detail.kind).toBe("unset");
    expect(check.message).toBe([OPENER_UNSET, ADD_TO_USER, CAVEAT].join(" "));
  });

  it("an unset base plus a local hold renders the hold opener with both steps", async () => {
    const check = await run({ local: "hold" });
    expect(check.detail.kind).toBe("hold");
    expect(check.message).toBe(
      [OPENER_HOLD, ADD_TO_USER, "Remove crossSessionInbound from .claude/settings.local.json or set it to accept there.", CAVEAT].join(" "),
    );
  });

  // Mutant (l): choosing the unset opener whenever the base is null reddens this.
  it("an unset base plus a local refuse renders the REFUSE opener", async () => {
    const check = await run({ local: "refuse" });
    expect(check.detail.kind).toBe("refuse");
    expect(check.message.startsWith(OPENER_REFUSE)).toBe(true);
    expect(check.message).toContain(ADD_TO_USER);
  });

  it("an unset base plus an invalid local renders hold with the set-to-accept step naming the raw value", async () => {
    const check = await run({ local: 42 });
    expect(check.detail.kind).toBe("hold");
    expect(check.message).toContain(
      "Set crossSessionInbound to accept in .claude/settings.local.json (its current value 42 is not one of accept, hold, refuse; hold and refuse are valid but keep messages from being delivered).",
    );
    expect(check.message).toContain(ADD_TO_USER);
  });
});

describe("T-502 cross-session-inbound: user and repository restrictions", () => {
  it("advises hold with the user change step", async () => {
    const check = await run({ user: "hold" });
    expect(check.detail.kind).toBe("hold");
    expect(check.message).toBe([OPENER_HOLD, "Change crossSessionInbound from hold to accept in ~/.claude/settings.json.", CAVEAT].join(" "));
  });

  it("advises refuse for a user refuse", async () => {
    const check = await run({ user: "refuse" });
    expect(check.detail.kind).toBe("refuse");
    expect(check.message).toContain("Change crossSessionInbound from refuse to accept in ~/.claude/settings.json.");
  });

  it("advises refuse for a project refuse under a user accept, naming the project file", async () => {
    const check = await run({ user: "accept", project: "refuse" });
    expect(check.detail.kind).toBe("refuse");
    expect(check.message).toContain("Remove crossSessionInbound from .claude/settings.json or set it to accept there.");
    expect(check.message).not.toContain("Change crossSessionInbound");
  });

  it("emits both repository steps when both layers restrict", async () => {
    const check = await run({ user: "accept", project: "hold", local: "hold" });
    expect(check.message).toContain("Remove crossSessionInbound from .claude/settings.json or set it to accept there.");
    expect(check.message).toContain("Remove crossSessionInbound from .claude/settings.local.json or set it to accept there.");
  });

  // Mutant (h): rendering only the winning restriction reddens this.
  it("emits both the user step and the project step when both restrict", async () => {
    const check = await run({ user: "hold", project: "refuse" });
    expect(check.detail.kind).toBe("refuse");
    expect(check.message).toContain("Change crossSessionInbound from hold to accept in ~/.claude/settings.json.");
    expect(check.message).toContain("Remove crossSessionInbound from .claude/settings.json or set it to accept there.");
  });

  it("advises hold with the user set-to-accept step for an invalid user value", async () => {
    const check = await run({ user: "yes" });
    expect(check.detail.kind).toBe("hold");
    expect(check.message).toContain(
      'Set crossSessionInbound to accept in ~/.claude/settings.json (its current value "yes" is not one of accept, hold, refuse; hold and refuse are valid but keep messages from being delivered).',
    );
  });

  it("advises with a repository set-to-accept step for an invalid local value under a user accept", async () => {
    const check = await run({ user: "accept", local: "maybe" });
    expect(check.message).toContain('Set crossSessionInbound to accept in .claude/settings.local.json (its current value "maybe"');
    expect(check.message).not.toContain("~/.claude/settings.json");
  });
});

describe("T-502 cross-session-inbound: managed base", () => {
  it("advises refuse with the admin step and no file edit", async () => {
    const check = await run({ managed: "refuse" });
    expect(check.detail.kind).toBe("refuse");
    expect(check.message).toBe([
      OPENER_REFUSE,
      "Your organization's managed settings set crossSessionInbound to refuse; ask your admin to change it to accept (nothing in your own files can override it).",
      CAVEAT,
    ].join(" "));
  });

  it("names the raw value in the admin step for an invalid managed value", async () => {
    const check = await run({ managed: true });
    expect(check.message).toContain("managed settings set crossSessionInbound to true; ask your admin");
  });

  it("emits the admin step plus the local step, and never a user step, for managed hold with an invalid user and a local refuse", async () => {
    const fixture: Fixture = { managed: "hold", user: "nope", local: "refuse" };
    const check = await run(fixture);
    expect(check.detail.kind).toBe("refuse");
    expect(check.message).toBe([
      OPENER_REFUSE,
      "Your organization's managed settings set crossSessionInbound to hold; ask your admin to change it to accept (nothing in your own files can override it).",
      "Remove crossSessionInbound from .claude/settings.local.json or set it to accept there.",
      CAVEAT,
    ].join(" "));
    expect(check.detail.shadowedUser).toBe('"nope"');

    // Mutant (k): deriving the user step from the user layer instead of the
    // selected base adds a user step here.
    expect(check.message).not.toContain("~/.claude/settings.json");

    const repaired = await run(applySteps(fixture, check.message));
    expect(repaired.status).toBe("ok");
  });

  it("emits the admin step plus the local step for managed hold with a local refuse", async () => {
    const check = await run({ managed: "hold", local: "refuse" });
    expect(check.message).toContain("ask your admin");
    expect(check.message).toContain(".claude/settings.local.json");
  });
});

describe("T-502 cross-session-inbound: remediation guarantee", () => {
  const fixtures: Fixture[] = [
    {},
    { project: "accept" },
    { local: "hold" },
    { local: "refuse" },
    { local: 42 },
    { user: "hold" },
    { user: "refuse" },
    { user: "yes" },
    { user: "accept", project: "refuse" },
    { user: "accept", project: "hold", local: "hold" },
    { user: "hold", project: "refuse" },
    { user: "accept", local: "maybe" },
    { managed: "refuse" },
    { managed: true },
    { managed: "hold", user: "nope", local: "refuse" },
    { managed: "hold", local: "refuse" },
    { managed: "accept", local: "hold" },
    { user: "refuse", local: "hold" },
    { managed: "refuse", project: "accept" },
  ];

  for (const fixture of fixtures) {
    it(`applying the steps for ${JSON.stringify(fixture)} re-resolves to ok`, async () => {
      const check = await run(fixture);
      expect(check.status).toBe("advise");
      const repaired = await run(applySteps(fixture, check.message));
      expect(repaired.status).toBe("ok");
    });

    it(`no step for ${JSON.stringify(fixture)} names a shadowed layer`, async () => {
      const check = await run(fixture);
      const managedIsBase = fixture.managed !== undefined;
      if (managedIsBase) expect(check.message).not.toContain("~/.claude/settings.json");
    });
  }
});

describe("T-502 cross-session-inbound: evidence and platform", () => {
  for (const layer of ["managed", "user", "project", "local"] as const) {
    it(`skips when the ${layer} layer is unreadable, naming the path`, async () => {
      const files = filesFor({ user: "refuse", project: "hold" });
      files[PATHS[layer]] = UNREADABLE;
      const check = await checkCrossSessionInbound(ctxFor(), stubDeps({ files }));
      expect(check.status).toBe("skip");
      expect(check.detail.reason).toBe(`unreadable: ${PATHS[layer]}`);
      expect(check.advice).toBeNull();
    });
  }

  it("treats unparseable JSON and a non-object document as unreadable", async () => {
    for (const text of ["{ not json", "[1,2,3]"]) {
      const check = await checkCrossSessionInbound(ctxFor(), stubDeps({ files: { [USER]: text } }));
      expect(check.status).toBe("skip");
      expect(check.detail.reason).toBe(`unreadable: ${USER}`);
    }
  });

  it("uses the linux and win32 managed settings paths", async () => {
    for (const [platform, path] of [["linux", "/etc/claude-code/managed-settings.json"], ["win32", "C:\\ProgramData\\ClaudeCode\\managed-settings.json"]] as const) {
      expect(managedSettingsPath(platform)).toBe(path);
      const check = await checkCrossSessionInbound(
        ctxFor(),
        stubDeps({ platform, files: { [path]: JSON.stringify({ crossSessionInbound: "refuse" }) } }),
      );
      expect(check.detail.kind).toBe("refuse");
    }
  });

  it("reads the project layers of an invocation directory with no .story/", async () => {
    const check = await checkCrossSessionInbound(
      ctxFor({ ledgerRoot: null }),
      stubDeps({ files: { [LOCAL]: JSON.stringify({ crossSessionInbound: "hold" }) } }),
    );
    expect(check.detail.kind).toBe("hold");
    expect(check.detail.projectDir).toBe(PROJECT);
  });

  it("skips under the Codex client", async () => {
    const check = await checkCrossSessionInbound(ctxFor({ client: "codex" }), stubDeps());
    expect(check.status).toBe("skip");
    expect(check.detail.reason).toBe("not applicable to Codex");
  });

  it("pins detail.scope on every outcome", async () => {
    for (const fixture of [{ user: "accept" }, {}, { user: "hold" }] as Fixture[]) {
      expect((await run(fixture)).detail.scope).toBe("settings-files");
    }
  });
});

describe("cross-session-inbound reads Claude's config dir (ISS-1270)", () => {
  const over = { claudeConfigDir: "/cfg", claudeSettingsDisplay: "/cfg/settings.json" };

  it("reads the user layer from the override, not HOME", async () => {
    const files: FileMap = { "/cfg/settings.json": JSON.stringify({ crossSessionInbound: "accept" }), [USER]: JSON.stringify({ crossSessionInbound: "refuse" }) };
    const check = await checkCrossSessionInbound(ctxFor(), stubDeps({ files, ...over }));
    expect(check.status).toBe("ok");
  });

  it("names the override's file in the user steps", async () => {
    const unset = await checkCrossSessionInbound(ctxFor(), stubDeps({ files: {}, ...over }));
    expect(unset.message).toContain('Add `"crossSessionInbound": "accept"` to /cfg/settings.json.');
    const hold = await checkCrossSessionInbound(ctxFor(), stubDeps({ files: { "/cfg/settings.json": JSON.stringify({ crossSessionInbound: "hold" }) }, ...over }));
    expect(hold.message).toContain("Change crossSessionInbound from hold to accept in /cfg/settings.json.");
    const bad = await checkCrossSessionInbound(ctxFor(), stubDeps({ files: { "/cfg/settings.json": JSON.stringify({ crossSessionInbound: "nope" }) }, ...over }));
    expect(bad.message).toContain("Set crossSessionInbound to accept in /cfg/settings.json");
  });
});
