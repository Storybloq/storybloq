/**
 * ISS-1004: enumerations that refuse unknown names must tolerate the Bus's own
 * durable-write staging file (`<target>.tmp.<pid>.<uuid>`) and nothing broader.
 * A concurrent endpoint write otherwise fails an unrelated operation with
 * `corrupt`, and the race self-heals before any doctor run can see it.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initProject } from "../../src/core/init.js";
import { canonicalHash } from "../../src/bus/canonical.js";
import { busDoctor, evaluateV1Drain, initializeBus, listV1Endpoints, pollBus, sendBusMessage, v1PathsFrom } from "../../src/bus/index.js";
import { __testing, durableTempTarget } from "../../src/bus/io.js";
import { assertBusLayout, busLayoutFindings, resolveBusPaths } from "../../src/bus/paths.js";
import { createBusFixture, type BusFixture } from "./helpers.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fx(): Promise<BusFixture> {
  const value = await createBusFixture("bus-durable-temp");
  roots.push(value.root);
  return value;
}

const busDir = (root: string, ...parts: string[]) => join(root, ".story", "bus", ...parts);
const temp = (target: string) => `${target}.tmp.${process.pid}.${randomUUID()}`;
const hex64 = () => createHash("sha256").update(randomUUID()).digest("hex");
const HYPHENS_36 = "-".repeat(36);

/** Holds a real writeDurableTemp staging file open until the returned release runs. */
async function heldTemp(target: string): Promise<{ name: string; release: () => Promise<void> }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => { opened = resolve; });
  const done = __testing.writeDurableTemp(target, "{}", async (handle) => {
    opened();
    await gate;
    await handle.writeFile("{}", "utf-8");
  });
  await ready;
  const name = (await readdir(join(target, ".."))).find((entry) => entry.startsWith(`${basename(target)}.tmp.`));
  expect(name).toBeDefined();
  return {
    name: name!,
    release: async () => {
      release();
      const written = await done;
      await rm(written, { force: true });
    },
  };
}

function reviewSend(value: BusFixture) {
  return sendBusMessage(value.root, {
    endpointId: value.reviewer.endpointId,
    clientTaskId: value.reviewerTaskId,
    threadKind: "question",
    messageKind: "question",
    severity: "medium",
    body: "Verify the staging boundary",
    refs: { ciRun: "ci-staging" },
    idempotencyKey: "staging-question-1",
  });
}

describe("durable-write staging files during enumeration (ISS-1004)", () => {
  it("H1: the helper reads the target back from a name the real writer produced", async () => {
    const value = await fx();
    const target = busDir(value.root, "endpoints", `${value.reviewer.endpointId}.json`);
    const held = await heldTemp(target);
    try {
      expect(durableTempTarget(held.name)).toBe(`${value.reviewer.endpointId}.json`);
      expect(durableTempTarget(`${value.reviewer.endpointId}.json`)).toBeNull();
    } finally {
      await held.release();
    }
  });

  it("E1: a held-open endpoint write leaves the layout valid and doctor healthy", async () => {
    const value = await fx();
    const paths = await resolveBusPaths(value.root, false);
    const held = await heldTemp(busDir(value.root, "endpoints", `${value.reviewer.endpointId}.json`));
    try {
      await expect(assertBusLayout(paths)).resolves.toBeUndefined();
      expect(await busLayoutFindings(paths)).toEqual([]);
      const doctor = await busDoctor(value.root);
      expect(doctor.findings).toEqual([]);
      expect(doctor.healthy).toBe(true);
    } finally {
      await held.release();
    }
  });

  it("E2: a staging file in endpoints/ does not fail a real poll and stays ignored on disk", async () => {
    const value = await fx();
    const name = temp(`${value.reviewer.endpointId}.json`);
    await writeFile(busDir(value.root, "endpoints", name), "{}", "utf-8");
    const polled = await pollBus(value.root, { endpointId: value.implementer.endpointId, clientTaskId: value.implementerTaskId });
    expect(Array.isArray(polled.messages)).toBe(true);
    expect((await lstat(busDir(value.root, "endpoints", name))).isFile()).toBe(true);
  });

  const failClosed: Array<[string, (value: BusFixture, dir: string) => Promise<string>]> = [
    ["a symlink named <uuid>.json", async (value, dir) => {
      const decoy = join(value.root, ".story", "decoy.json");
      await writeFile(decoy, "{}", "utf-8");
      const name = `${randomUUID()}.json`;
      await symlink(decoy, join(dir, name));
      return name;
    }],
    ["a symlink with the staging shape", async (value, dir) => {
      const decoy = join(value.root, ".story", "decoy.json");
      await writeFile(decoy, "{}", "utf-8");
      const name = temp(`${value.reviewer.endpointId}.json`);
      await symlink(decoy, join(dir, name));
      return name;
    }],
    ["a directory with the staging shape", async (value, dir) => {
      const name = temp(`${value.reviewer.endpointId}.json`);
      await mkdir(join(dir, name));
      return name;
    }],
    ["a dot-prefixed record name", async (_value, dir) => {
      const name = `.${randomUUID()}.json`;
      await writeFile(join(dir, name), "{}", "utf-8");
      return name;
    }],
    ["a dot-prefixed staging name", async (_value, dir) => {
      const name = temp(`.${randomUUID()}.json`);
      await writeFile(join(dir, name), "{}", "utf-8");
      return name;
    }],
    ["a 36-character non-UUID stem", async (_value, dir) => {
      const name = `${HYPHENS_36}.json`;
      await writeFile(join(dir, name), "{}", "utf-8");
      return name;
    }],
    ["a non-UUID stem with the staging shape", async (_value, dir) => {
      const name = temp(`${HYPHENS_36}.json`);
      await writeFile(join(dir, name), "{}", "utf-8");
      return name;
    }],
    ["a loose .tmp. suffix", async (value, dir) => {
      const name = `${value.reviewer.endpointId}.json.tmp.x`;
      await writeFile(join(dir, name), "{}", "utf-8");
      return name;
    }],
    ["a staging suffix whose uuid is not a UUID", async (value, dir) => {
      const name = `${value.reviewer.endpointId}.json.tmp.12.${HYPHENS_36}`;
      await writeFile(join(dir, name), "{}", "utf-8");
      return name;
    }],
    ["a staging name with trailing text", async (value, dir) => {
      const name = `${temp(`${value.reviewer.endpointId}.json`)}.extra`;
      await writeFile(join(dir, name), "{}", "utf-8");
      return name;
    }],
  ];

  it.each(failClosed)("E3: %s still reports and fails the layout closed", async (_label, place) => {
    const value = await fx();
    const paths = await resolveBusPaths(value.root, false);
    const name = await place(value, busDir(value.root, "endpoints"));
    const findings = await busLayoutFindings(paths);
    expect(findings).toEqual([`layout: ${join(paths.endpoints, name)} is not a regular <uuid>.json endpoint record`]);
    await expect(assertBusLayout(paths)).rejects.toMatchObject({ code: "corrupt" });
  });

  async function receiptDir(value: BusFixture): Promise<string> {
    await reviewSend(value);
    const dir = busDir(value.root, "idempotency", value.reviewer.endpointId);
    expect((await readdir(dir)).some((name) => name.endsWith(".json"))).toBe(true);
    return dir;
  }
  const receiptFindings = async (root: string) => (await busDoctor(root)).findings.filter((finding) => finding.startsWith("receipt "));

  it("R1: a receipt staging file is not a doctor finding", async () => {
    const value = await fx();
    const dir = await receiptDir(value);
    await writeFile(join(dir, temp(`${hex64()}.json`)), "{}", "utf-8");
    expect(await receiptFindings(value.root)).toEqual([]);
  });

  it("R2: a staging-shaped symlink and a loose suffix in a receipt dir still report", async () => {
    const value = await fx();
    const dir = await receiptDir(value);
    const decoy = join(value.root, ".story", "decoy.json");
    await writeFile(decoy, "{}", "utf-8");
    const link = temp(`${hex64()}.json`);
    await symlink(decoy, join(dir, link));
    const loose = `${hex64()}.json.tmp.x`;
    await writeFile(join(dir, loose), "{}", "utf-8");
    const findings = await receiptFindings(value.root);
    expect(findings.some((finding) => finding.includes(link))).toBe(true);
    expect(findings.some((finding) => finding.includes(loose))).toBe(true);
  });

  it("R3: a valid staging suffix on an invalid receipt target still reports", async () => {
    const value = await fx();
    const dir = await receiptDir(value);
    const dotted = temp(`.${hex64()}.json`);
    const short = temp(`${hex64().slice(1)}.json`);
    await writeFile(join(dir, dotted), "{}", "utf-8");
    await writeFile(join(dir, short), "{}", "utf-8");
    const findings = await receiptFindings(value.root);
    expect(findings.some((finding) => finding.includes(dotted))).toBe(true);
    expect(findings.some((finding) => finding.includes(short))).toBe(true);
  });

  async function refusedDir(value: BusFixture): Promise<string> {
    const dir = busDir(value.root, "refused");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  const refusedFindings = async (root: string) => (await busDoctor(root)).findings.filter((finding) => finding.startsWith("refused: "));

  it("F1: a refused-artifact staging file is not a doctor finding", async () => {
    const value = await fx();
    await writeFile(join(await refusedDir(value), temp(`${hex64()}.json`)), "{}", "utf-8");
    expect(await refusedFindings(value.root)).toEqual([]);
  });

  it("F2: a staging-shaped symlink and a loose suffix in refused/ still report", async () => {
    const value = await fx();
    const decoy = join(value.root, ".story", "decoy.json");
    await writeFile(decoy, "{}", "utf-8");
    const link = temp(`${hex64()}.json`);
    await symlink(decoy, join(await refusedDir(value), link));
    const loose = `${hex64()}.json.tmp.x`;
    await writeFile(join(await refusedDir(value), loose), "{}", "utf-8");
    const findings = await refusedFindings(value.root);
    expect(findings.some((finding) => finding.includes(link))).toBe(true);
    expect(findings.some((finding) => finding.includes(loose))).toBe(true);
  });

  it("F3: a valid staging suffix on an invalid artifact target still reports", async () => {
    const value = await fx();
    const dotted = temp(`.${hex64()}.json`);
    const short = temp(`${hex64().slice(1)}.json`);
    await writeFile(join(await refusedDir(value), dotted), "{}", "utf-8");
    await writeFile(join(await refusedDir(value), short), "{}", "utf-8");
    const findings = await refusedFindings(value.root);
    expect(findings.some((finding) => finding.includes(dotted))).toBe(true);
    expect(findings.some((finding) => finding.includes(short))).toBe(true);
  });
});

// A minimal, clean v1 runtime: one endpoint, no threads, no mail.
async function v1Runtime(): Promise<{ root: string; busRoot: string; endpointId: string; taskId: string }> {
  const root = await mkdtemp(join(tmpdir(), "bus-v1-temp-"));
  roots.push(root);
  await initProject(root, { name: "bus-v1-temp" });
  const configPath = join(root, ".story", "config.json");
  const config = JSON.parse(await readFile(configPath, "utf-8"));
  config.features = { ...(config.features ?? {}), bus: true };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  await writeFile(join(root, ".story", ".gitignore"), "bus/\nbus-migration/\n", "utf-8");
  const busRoot = join(root, ".story", "bus");
  for (const dir of ["threads", "endpoints", "succession", "locks", "mailboxes/implementer/pending", "mailboxes/reviewer/pending"]) {
    await mkdir(join(busRoot, dir), { recursive: true, mode: 0o700 });
  }
  const now = new Date().toISOString();
  await writeFile(join(busRoot, "instance.json"), JSON.stringify({
    schema: "storybloq-bus-instance/v1", instanceId: randomUUID(), projectRootHash: canonicalHash(await realpath(root)), createdAt: now,
  }, null, 2) + "\n", "utf-8");
  const endpointId = randomUUID();
  const taskId = "codex-task-temp";
  await writeFile(join(busRoot, "endpoints", `${endpointId}.json`), JSON.stringify({
    schema: "storybloq-bus-endpoint/v1", endpointId, role: "implementer", client: "codex", surface: "codex_desktop", clientTaskId: taskId,
    processRef: null, state: "unknown", joinedAt: now, lastSeenAt: now, wakePolicy: "never", lastPolledMailboxSeq: 0, lastBlockedMailboxSeq: 0,
    retiredAt: null, retiredReason: null,
  }, null, 2) + "\n", "utf-8");
  return { root, busRoot, endpointId, taskId };
}

async function treeBytes(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const full = join(entry.parentPath, entry.name);
    out[full] = entry.isFile() ? (await readFile(full)).toString("base64") : entry.isDirectory() ? "<dir>" : "<other>";
  }
  return out;
}

describe("v1 endpoint staging files (ISS-1004)", () => {
  it("L1: a default-mode listV1Endpoints ignores an endpoint staging file", async () => {
    const v1 = await v1Runtime();
    await writeFile(join(v1.busRoot, "endpoints", temp(`${v1.endpointId}.json`)), "{}", "utf-8");
    const scan = await listV1Endpoints(v1PathsFrom(v1.busRoot));
    expect(scan.findings).toEqual([]);
    expect(scan.endpoints.map((endpoint) => endpoint.endpointId)).toEqual([v1.endpointId]);
  });

  it("L2: strictTemps reports the same staging file", async () => {
    const v1 = await v1Runtime();
    const name = temp(`${v1.endpointId}.json`);
    await writeFile(join(v1.busRoot, "endpoints", name), "{}", "utf-8");
    const scan = await listV1Endpoints(v1PathsFrom(v1.busRoot), { strictTemps: true });
    expect(scan.findings).toEqual([`endpoint ${name}: not a regular <uuid>.json file`]);
  });

  it("L3: a staging-shaped symlink reports in both modes", async () => {
    const v1 = await v1Runtime();
    const decoy = join(v1.root, ".story", "decoy.json");
    await writeFile(decoy, "{}", "utf-8");
    const name = temp(`${v1.endpointId}.json`);
    await symlink(decoy, join(v1.busRoot, "endpoints", name));
    for (const opts of [{}, { strictTemps: true }]) {
      expect((await listV1Endpoints(v1PathsFrom(v1.busRoot), opts)).findings).toEqual([`endpoint ${name}: not a regular <uuid>.json file`]);
    }
  });

  it("L4: a valid staging suffix on a regex-shaped but invalid UUID target reports in default mode", async () => {
    const v1 = await v1Runtime();
    const name = temp(`${HYPHENS_36}.json`);
    await writeFile(join(v1.busRoot, "endpoints", name), "{}", "utf-8");
    expect((await listV1Endpoints(v1PathsFrom(v1.busRoot))).findings).toEqual([`endpoint ${name}: not a regular <uuid>.json file`]);
  });

  it("D1: a default-mode evaluateV1Drain resolves with an endpoint staging file present", async () => {
    const v1 = await v1Runtime();
    await writeFile(join(v1.busRoot, "endpoints", temp(`${v1.endpointId}.json`)), "{}", "utf-8");
    await expect(evaluateV1Drain(v1PathsFrom(v1.busRoot))).resolves.toMatchObject({ shipBlockers: [] });
  });

  it("D2: a strict evaluateV1Drain rejects corrupt and names the staging file", async () => {
    const v1 = await v1Runtime();
    const name = temp(`${v1.endpointId}.json`);
    await writeFile(join(v1.busRoot, "endpoints", name), "{}", "utf-8");
    await expect(evaluateV1Drain(v1PathsFrom(v1.busRoot), { strictTemps: true }))
      .rejects.toMatchObject({ code: "corrupt", message: expect.stringContaining(name) });
  });

  it("D3: the migration refuses an endpoint staging file even with forceArchive and archives nothing", async () => {
    const v1 = await v1Runtime();
    const name = temp(`${v1.endpointId}.json`);
    await writeFile(join(v1.busRoot, "endpoints", name), "{}", "utf-8");
    const before = await treeBytes(v1.busRoot);
    await expect(initializeBus(v1.root, { callerTaskId: v1.taskId, forceArchive: true }))
      .rejects.toMatchObject({ code: "corrupt", message: expect.stringContaining(name) });
    expect(await treeBytes(v1.busRoot)).toEqual(before);
    await expect(lstat(join(v1.busRoot, "archive"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(v1.root, ".story", "bus-migration", "v1"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
