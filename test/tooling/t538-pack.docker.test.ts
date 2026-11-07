// T-538 S5b-0 commit 4: the pack profiles on real containers, read back by the real reader (plan section 9,
// the M2 layouts). The helper is created by production's own packCreateArgs. A plain run skips this with
// a named reason; the shipping gate sets STORYBLOQ_REQUIRE_DOCKER=1. Always under box run. No model and no
// credential: the "credential" here is a fake string written by the test.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blockedBy } from "../../scripts/onboarding-eval-assertion-deps.js";
import { containerNames, packCreateArgs } from "../../scripts/onboarding-eval-container.js";
import { finalDir, linkViolations, parsePackRecords, type PackProfile, type PackRecords, readArchive, type Extraction } from "../../scripts/onboarding-eval-reader.js";

const IMAGE = process.env.T538_IMAGE ?? "";
const PROXY_IMAGE = process.env.T538_PROXY_IMAGE ?? "";
const REQUIRED = process.env.STORYBLOQ_REQUIRE_DOCKER === "1";
const docker = (args: readonly string[], input?: string): { status: number | null; stdout: Buffer; stderr: Buffer } => {
  const r = spawnSync("docker", args, { timeout: 240_000, maxBuffer: 512 * 1048576, ...(input !== undefined ? { input } : {}) });
  return { status: r.status, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr ?? Buffer.alloc(0) };
};
const usable = docker(["version", "--format", "{{.Server.Version}}"]).status === 0 && IMAGE !== "" && PROXY_IMAGE !== "";
const skipReason = "docker tests skipped: no usable engine, or T538_IMAGE and T538_PROXY_IMAGE are not set";
if (!usable && !REQUIRED) console.log(skipReason);

describe.runIf(REQUIRED && !usable)("the docker gate for the pack", () => {
  it("fails when the shipping gate requires docker and it is not usable", () => { expect.fail(skipReason); });
});

const must = (args: readonly string[], input?: string): string => {
  const r = docker(args, input);
  if (r.status !== 0) throw new Error(`docker ${args[0]} failed: ${r.stderr.toString().slice(0, 400)}`);
  return r.stdout.toString().trim();
};
const SUITE = `c4${process.pid}`;
const used: string[] = [];
const scratch = mkdtempSync(join(tmpdir(), "t538-pk-"));
const SENTINEL = "SENTINEL-UNTOUCHED\n";
writeFileSync(join(scratch, "sentinel.txt"), SENTINEL);
afterAll(() => {
  for (const id of used) {
    const f = `label=cpm-t538-attempt=${id}`;
    const ps = docker(["ps", "-aq", "--filter", f]).stdout.toString().trim().split("\n").filter(Boolean);
    if (ps.length > 0) docker(["rm", "-fv", ...ps]);
    const vs = docker(["volume", "ls", "-q", "--filter", f]).stdout.toString().trim().split("\n").filter(Boolean);
    if (vs.length > 0) docker(["volume", "rm", ...vs]);
  }
  rmSync(scratch, { recursive: true, force: true });
}, 120_000);

/** A labelled volume for one layout, written by a throwaway container of `image` running `script`. */
function layout(id: string, image: string, target: string, user: string, script: string): string {
  used.push(id);
  const volume = containerNames(id).attemptVolume;
  must(["volume", "create", "--label", `cpm-t538-attempt=${id}`, volume]);
  must(["run", "-i", "--rm", "--label", `cpm-t538-attempt=${id}`, "--network", "none", "--user", user, "--entrypoint", "bash",
    "--mount", `type=volume,source=${volume},target=${target}`, image, "-s"], script);
  return volume;
}
interface Packed { readonly exit: number | null; readonly records: PackRecords; readonly x: Extraction; readonly host: string }
/** Production's helper over the volume, then the host reader over its stdout and stderr. */
async function pack(id: string, image: string, volume: string, target: string, profile: PackProfile): Promise<Packed> {
  const helper = must(packCreateArgs(id, image, volume, target, profile));
  const run = docker(["start", "-a", helper]);
  const exit = Number(must(["inspect", helper, "--format", "{{.State.ExitCode}}"]));
  must(["rm", "-fv", helper]);
  const records = parsePackRecords(run.stderr);
  if ("refused" in records) throw new Error(`records refused: ${records.refused}: ${run.stderr.toString().slice(0, 300)}`);
  const host = join(scratch, `${id}-${profile}`);
  mkdirSync(join(host, "raw"), { recursive: true });
  const tarPath = join(host, "raw", `${profile}.tar`);
  writeFileSync(tarPath, run.stdout);
  const x = await readArchive({ tarPath, hostRoot: host, profile, attempt: 1, records });
  return { exit, records, x, host };
}
const nm = (x: Extraction, path: string) => x.notMaterialized.find((n) => n.path === path);

const NORMAL = String.raw`set -e
cd /vol/att; mkdir -p project/.story/tickets project/src store/rec/SR-1 global eval-events reviewers/launches home/.codex/sessions/2026
printf '{"auth":"FAKE-NOT-A-CREDENTIAL"}' > home/.codex/auth.json
echo '{}' > project/.story/tickets/t.json; echo a > project/src/a.ts; echo r > store/rec/SR-1/record.json; echo e > eval-events/events.jsonl; echo s > home/.codex/sessions/2026/r.jsonl
mkdir -p project/node_modules/x project/deep/node_modules/y project/.venv/z; echo big > project/node_modules/x/f; echo y > project/deep/node_modules/y/f
ln -s /etc/passwd project/link-out; ln -s link-out project/link-chain; ln -s ../../../../etc/shadow project/src/link-rel; ln -s loop2 project/loop1; ln -s loop1 project/loop2; ln -s src project/inside
ln project/src/a.ts project/src/hard-a.ts; mkfifo project/fifo; python3 -c "import socket;s=socket.socket(socket.AF_UNIX);s.bind('project/sock')"
python3 -c "open(b'project/bad-\xff-name','w').write('x')"; touch project/Case project/case
L=$(printf 'd%.0s' $(seq 1 90)); mkdir -p project/$L/$L/$L; echo long > project/$L/$L/$L/long-file-name
echo su > project/setuid; chmod 4755 project/setuid; echo z > project/zero-mode; chmod 000 project/zero-mode; mkdir project/zero-dir; echo in > project/zero-dir/f; chmod 000 project/zero-dir
T=$(printf "t%.0s" $(seq 1 300)); ln -s /$T project/long-link
`;

describe.runIf(usable)("the attempt profile through production's helper", () => {
  let normal: Packed;
  beforeAll(async () => { normal = await pack(`${SUITE}n`, IMAGE, layout(`${SUITE}n`, IMAGE, "/vol/att", "eval", NORMAL), "/vol/att", "attempt"); }, 240_000);

  it("an empty volume: every root missing, an empty archive, complete", async () => {
    const p = await pack(`${SUITE}e`, IMAGE, layout(`${SUITE}e`, IMAGE, "/vol/att", "eval", "true\n"), "/vol/att", "attempt");
    expect(p.exit).toBe(0);
    expect([p.x.complete, p.x.counts.entries]).toEqual([true, 1]);
    expect(p.x.rootsMissing).toEqual(["store", "global", "eval-events", "reviewers", "home/.codex/sessions"]);
  }, 240_000);
  it("a partial volume: project only, its files read back, the rest named missing", async () => {
    const p = await pack(`${SUITE}p`, IMAGE, layout(`${SUITE}p`, IMAGE, "/vol/att", "eval", "mkdir -p /vol/att/project/.story/tickets /vol/att/project/empty; echo '{}' > /vol/att/project/.story/tickets/t.json\n"), "/vol/att", "attempt");
    expect([p.exit, p.x.complete]).toEqual([0, true]);
    expect(readFileSync(join(finalDir(p.host, "attempt"), "project/.story/tickets/t.json"), "utf8")).toBe("{}\n");
    expect(lstatSync(join(finalDir(p.host, "attempt"), "project/empty")).isDirectory()).toBe(true);
    expect(p.x.rootsMissing).toEqual(["store", "global", "eval-events", "reviewers", "home/.codex/sessions"]);
  }, 240_000);
  it("the normal hostile volume reads complete, with every root present", () => {
    expect([normal.exit, normal.x.complete, normal.x.rootsMissing, normal.x.errors]).toEqual([0, true, [], []]);
    expect(readFileSync(join(finalDir(normal.host, "attempt"), "store/rec/SR-1/record.json"), "utf8")).toBe("r\n");
  });
  it("a credential with no other name gives no A record", () => {
    expect([normal.records.aliases, normal.x.aliases]).toEqual([[], []]);
  });
  it("another name for the credential is an A record, and nothing is published", async () => {
    const id = `${SUITE}a`;
    const p = await pack(id, IMAGE, layout(id, IMAGE, "/vol/att", "eval", "mkdir -p /vol/att/project /vol/att/home/.codex; printf FAKE > /vol/att/home/.codex/auth.json; ln /vol/att/home/.codex/auth.json /vol/att/project/innocent-name.txt\n"), "/vol/att", "attempt");
    expect(p.records.aliases).toEqual(["/vol/att/project/innocent-name.txt"]);
    expect([p.x.complete, p.x.aliases]).toEqual([false, ["/vol/att/project/innocent-name.txt"]]);
    expect(existsSync(finalDir(p.host, "attempt"))).toBe(false);
  }, 240_000);
  it("links: kept as metadata, judged from the archive, never created; escapes are violations", () => {
    const x = normal.x;
    expect([nm(x, "project/link-out")?.escapes, nm(x, "project/link-chain")?.escapes, nm(x, "project/src/link-rel")?.escapes, nm(x, "project/loop1")?.escapes, nm(x, "project/inside")?.escapes, nm(x, "project/long-link")?.escapes])
      .toEqual(["escapes", "escapes", "escapes", "unknown", "inside", "escapes"]);
    expect(nm(x, "project/long-link")?.target).toBe(`/${"t".repeat(300)}`);
    for (const p of ["project/link-out", "project/inside", "project/loop1"]) expect(existsSync(join(finalDir(normal.host, "attempt"), p))).toBe(false);
    expect(linkViolations(x).map((n) => n.path)).toEqual(expect.arrayContaining(["project/link-out", "project/link-chain", "project/src/link-rel", "project/loop1", "project/loop2", "project/long-link"]));
    expect(linkViolations(x).map((n) => n.path)).not.toContain("project/inside");
  });
  it("a hard link pair: one name written, the other listed", () => {
    const hard = normal.x.notMaterialized.filter((n) => n.class === "hardlink").map((n) => [n.path, n.target].sort());
    expect(hard).toContainEqual(["project/src/a.ts", "project/src/hard-a.ts"]);
  });
  it("a FIFO and a socket are special; a bad name is refused; a case pair collides; dependency folders are omitted", () => {
    const x = normal.x;
    expect([nm(x, "project/fifo")?.class, nm(x, "project/sock")?.class]).toEqual(["special", "special"]);
    expect(x.notMaterialized.filter((n) => n.class === "refused-name")).toHaveLength(1);
    expect(x.notMaterialized.filter((n) => n.class === "collision").map((n) => n.path).sort()).toEqual(["project/Case", "project/case"]);
    expect([...x.omitted].sort()).toEqual(["project/.venv", "project/deep/node_modules", "project/node_modules"]);
    for (const o of x.omitted) expect(existsSync(join(finalDir(normal.host, "attempt"), o)), o).toBe(false);
    expect(blockedBy([{ tree: "project" }], x)).toMatch(/^evidence-blocked: /);
    expect(blockedBy([{ file: "eval-events/events.jsonl" }], x)).toBeNull();
  });
  it("modes: setuid and unreadable files are written 0600, the unreadable folder's file read through", () => {
    const f = finalDir(normal.host, "attempt");
    expect(lstatSync(join(f, "project/setuid")).mode & 0o7777).toBe(0o600);
    expect(lstatSync(join(f, "project/zero-mode")).mode & 0o7777).toBe(0o600);
    expect(readFileSync(join(f, "project/zero-dir/f"), "utf8")).toBe("in\n");
    const L = "d".repeat(90);
    expect(readFileSync(join(f, `project/${L}/${L}/${L}/long-file-name`), "utf8")).toBe("long\n");
  });
  it("nothing outside the host root was touched", () => {
    expect(readFileSync(join(scratch, "sentinel.txt"), "utf8")).toBe(SENTINEL);
  });
  it("a root that is a dangling link is present as a link, not missing", async () => {
    const p = await pack(`${SUITE}l`, IMAGE, layout(`${SUITE}l`, IMAGE, "/vol/att", "eval", "mkdir -p /vol/att/project; ln -s /nonexistent /vol/att/store\n"), "/vol/att", "attempt");
    expect(p.x.rootsMissing).not.toContain("store");
    expect(nm(p.x, "store")).toEqual({ path: "store", class: "symlink", target: "/nonexistent", escapes: "escapes" });
    expect(linkViolations(p.x).map((n) => n.path)).toEqual(["store"]);
  }, 240_000);
  it("an alias scan that cannot finish fails the pack, with its reason", () => {
    const id = `${SUITE}n`;
    const volume = containerNames(id).attemptVolume;
    // The production script under a find that fails only for the alias scan; not production's launch.
    const r = docker(["run", "--rm", "--label", `cpm-t538-attempt=${id}`, "--network", "none", "--user", "0", "--entrypoint", "bash",
      "--mount", `type=volume,source=${volume},target=/vol/att,readonly`, IMAGE, "-c",
      "mkdir /shim; printf '#!/bin/sh\\ncase \"$*\" in *-samefile*) echo boom >&2; exit 3;; esac\\nexec /usr/bin/find \"$@\"\\n' > /shim/find; chmod 755 /shim/find; PATH=/shim:$PATH sh /opt/eval/pack.sh attempt > /dev/null"]);
    expect(r.status).not.toBe(0);
    const rec = parsePackRecords(r.stderr);
    expect("refused" in rec ? rec.refused : rec.errors.join()).toMatch(/boom.*alias scan did not finish/);
    expect("refused" in rec ? [] : rec.aliases).toEqual([]);
  }, 240_000);
});

describe.runIf(usable)("the judge, live and proxy profiles", () => {
  it("judge: its roots only", async () => {
    const id = `${SUITE}j`;
    const p = await pack(id, IMAGE, layout(id, IMAGE, "/vol/att", "eval", "mkdir -p /vol/att/out /vol/att/home/.codex/sessions /vol/att/project; echo v > /vol/att/out/verdict.json; printf FAKE > /vol/att/home/.codex/auth.json\n"), "/vol/att", "judge");
    expect([p.exit, p.x.complete, p.x.rootsMissing, p.x.aliases]).toEqual([0, true, [], []]);
    expect(readFileSync(join(finalDir(p.host, "judge"), "out/verdict.json"), "utf8")).toBe("v\n");
    expect(existsSync(join(finalDir(p.host, "judge"), "project"))).toBe(false);
  }, 240_000);
  it("judge: an alias of the credential under out/ is an A record, and nothing is published", async () => {
    const id = `${SUITE}k`;
    const p = await pack(id, IMAGE, layout(id, IMAGE, "/vol/att", "eval", "mkdir -p /vol/att/out /vol/att/home/.codex; printf FAKE > /vol/att/home/.codex/auth.json; ln /vol/att/home/.codex/auth.json /vol/att/out/copy\n"), "/vol/att", "judge");
    expect([p.records.aliases, p.x.complete, p.x.aliases]).toEqual([["/vol/att/out/copy"], false, ["/vol/att/out/copy"]]);
    expect(existsSync(finalDir(p.host, "judge"))).toBe(false);
  }, 240_000);
  it("live: the fake credential hard-linked into .story is an A record, and nothing is published", async () => {
    const id = `${SUITE}w`;
    const p = await pack(id, IMAGE, layout(id, IMAGE, "/vol/att", "eval", "mkdir -p /vol/att/project/.story /vol/att/home/.codex; printf FAKE > /vol/att/home/.codex/auth.json; ln /vol/att/home/.codex/auth.json /vol/att/project/.story/notes.json\n"), "/vol/att", "live");
    expect([p.records.aliases, p.x.complete, p.x.aliases]).toEqual([["/vol/att/project/.story/notes.json"], false, ["/vol/att/project/.story/notes.json"]]);
    expect(existsSync(finalDir(p.host, "live"))).toBe(false);
  }, 240_000);
  it("live: a credential path that cannot be checked fails the pack closed", async () => {
    const id = `${SUITE}c`;
    const p = await pack(id, IMAGE, layout(id, IMAGE, "/vol/att", "eval", "mkdir -p /vol/att/project/.story /vol/att/home; echo x > /vol/att/home/.codex\n"), "/vol/att", "live");
    expect(p.exit).toBe(70);
    expect(p.records.errors.join()).toMatch(/the credential could not be checked: .*Not a directory/);
    expect(p.x.complete).toBe(false);
    expect(existsSync(finalDir(p.host, "live"))).toBe(false);
  }, 240_000);
  it("live: the project's .story only, read from the project folder", async () => {
    const id = `${SUITE}v`;
    const p = await pack(id, IMAGE, layout(id, IMAGE, "/vol/att", "eval", "mkdir -p /vol/att/project/.story/tickets /vol/att/project/src; echo t > /vol/att/project/.story/tickets/t.json; echo s > /vol/att/project/src/s\n"), "/vol/att", "live");
    expect([p.exit, p.x.complete, p.x.rootsMissing]).toEqual([0, true, []]);
    expect(readFileSync(join(finalDir(p.host, "live"), ".story/tickets/t.json"), "utf8")).toBe("t\n");
    expect(existsSync(join(finalDir(p.host, "live"), "src"))).toBe(false);
  }, 240_000);
  it("proxy: the proxy image carries the same script and packs its log", async () => {
    const id = `${SUITE}x`;
    const p = await pack(id, PROXY_IMAGE, layout(id, PROXY_IMAGE, "/vol/proxy", "0", "mkdir -p /vol/proxy/log; echo '{\"ok\":1}' > /vol/proxy/log/proxy.jsonl\n"), "/vol/proxy", "proxy");
    expect([p.exit, p.x.complete, p.x.rootsMissing]).toEqual([0, true, []]);
    expect(readFileSync(join(finalDir(p.host, "proxy"), "log/proxy.jsonl"), "utf8")).toBe("{\"ok\":1}\n");
  }, 240_000);
  it("an unknown profile is refused by the script with a record", async () => {
    const id = `${SUITE}u`;
    const volume = layout(id, IMAGE, "/vol/att", "eval", "true\n");
    const helper = must(packCreateArgs(id, IMAGE, volume, "/vol/att", "bogus"));
    const run = docker(["start", "-a", helper]);
    expect(Number(must(["inspect", helper, "--format", "{{.State.ExitCode}}"]))).toBe(64);
    expect(parsePackRecords(run.stderr)).toEqual({ missing: [], omitted: [], sockets: [], errors: ["unknown profile"], aliases: [] });
  }, 240_000);
});
