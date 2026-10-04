/**
 * ISS-958 section 6: the scanner's own failing cases. Each fixture is a tiny
 * in-memory program with one defect the scanner must refuse; the last one is
 * a clean program it must pass. EN1-EN8 mutate the scanner itself and must
 * turn at least one of these RED.
 */
import { describe, expect, it } from "vitest";
import { inMemoryProgram, scanStateWrites, type ScannerRegistry } from "./_state-write-scanner.js";

const ROOT_FILE = "session.ts";
const SESSION = `
export function writeSessionSync(dir: string, s: { revision: number }): { revision: number } { return s; }
function acquire(dir: string): () => void { return () => {}; }
export async function withSessionLock<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  const release = acquire(dir);
  try { return await fn(); } finally { release(); }
}
export function livenessLog(msg: string): void {}
export interface Failed { readonly kind: "failed"; readonly why: string }
export function failed(why: string): Failed { return { kind: "failed", why }; }
`;

const EMPTY: ScannerRegistry = {
  catches: {},
  edges: {},
  lockHeldByContract: [],
  sinks: ["session.ts#livenessLog", "process.stderr.write", "console.error"],
  results: ["session.ts#failed"],
  testOnlyExports: [],
};

function scan(code: string, registry: Partial<ScannerRegistry> = {}, extra: Record<string, string> = {}) {
  const program = inMemoryProgram({ "/fx/session.ts": SESSION, "/fx/user.ts": code, ...extra });
  return scanStateWrites(program, {
    base: "/fx",
    rootFile: ROOT_FILE,
    rootName: "writeSessionSync",
    lockName: "withSessionLock",
    registry: { ...EMPTY, ...registry },
  });
}

const IMPORTS = `import { writeSessionSync, withSessionLock, livenessLog, failed } from "./session.js";\n`;

describe("ISS-958 state-write scanner: each plan fixture is refused", () => {
  const LOCKED = `withSessionLock(d, () => writeSessionSync(d, { revision: 1 }))`;

  it("an aliased import", () => {
    const r = scan(`import { writeSessionSync as wss, withSessionLock } from "./session.js";
export function a(d: string) { try { withSessionLock(d, () => wss(d, { revision: 1 })); } catch (e) { throw e; } }`);
    expect(r.errors).toContain("unregistered propagating user.ts#a#catch#1");
  });

  it("a rethrowing wrapper", () => {
    const r = scan(IMPORTS + `
function wrap(d: string) { try { ${LOCKED}; } catch (e) { throw e; } }
export function b(d: string) { wrap(d); }`, { catches: {} });
    expect(r.errors).toContain("unregistered propagating user.ts#wrap#catch#1");
    expect(r.writers).toContain("user.ts#b");
  });

  it("a catch that swallows in one branch and rethrows in another", () => {
    const r = scan(IMPORTS + `
export function a(d: string, soft: boolean) { try { ${LOCKED}; } catch (e) { if (soft) { livenessLog("x"); } else { throw e; } } }`);
    expect(r.errors).toContain("unregistered propagating user.ts#a#catch#1");
  });

  it("return Promise.reject(err) in an async catch", () => {
    const r = scan(IMPORTS + `
export async function a(d: string): Promise<number> { try { ${LOCKED}; } catch (e) { return Promise.reject(e); } return 1; }`);
    expect(r.errors).toContain("unregistered propagating user.ts#a#catch#1");
  });

  it("the saved-rejected-promise case reaches the unregistered outer catch", () => {
    const r = scan(IMPORTS + `
async function asyncWriter(d: string): Promise<void> { ${LOCKED}; }
async function inner(d: string): Promise<unknown> { let p: Promise<void> | undefined; try { p = asyncWriter(d); await p; } catch { return p; } return null; }
export async function outer(d: string) { try { await inner(d); } catch (e) { throw e; } }`,
    { catches: { "user.ts#inner#catch#1": "P" } });
    expect(r.found.get("user.ts#inner#catch#1")).toBe("propagating");
    expect(r.errors).toEqual(["unregistered propagating user.ts#outer#catch#1"]);
  });

  it.each([["any"], ["unknown"]])("return x where x: %s", (t) => {
    const r = scan(IMPORTS + `
export function a(d: string, x: ${t}) { try { ${LOCKED}; } catch { return x; } return null; }`);
    expect(r.errors).toContain("unregistered propagating user.ts#a#catch#1");
  });

  it("a RESULT-allowlisted helper whose declared return type is Promise<...>", () => {
    const r = scan(IMPORTS + `
export async function asyncFailed(why: string): Promise<{ kind: "failed"; why: string }> { return { kind: "failed", why }; }`,
    { results: ["session.ts#failed", "user.ts#asyncFailed"] });
    expect(r.errors).toContain("RESULT helper user.ts#asyncFailed may return a thenable or an unresolved type");
  });

  it("a catch calling a helper that throws err", () => {
    const r = scan(IMPORTS + `
function rethrow(e: unknown): never { throw e; }
export function a(d: string) { try { ${LOCKED}; } catch (e) { rethrow(e); } }`);
    expect(r.errors).toContain("unregistered propagating user.ts#a#catch#1");
  });

  it("the writer assigned to a (...a: unknown[]) => void slot", () => {
    const r = scan(IMPORTS + `
function w(d: string) { ${LOCKED}; }
export const slot: (...a: unknown[]) => void = w as (...a: unknown[]) => void;`);
    expect(r.errors.some((e) => e.startsWith("unregistered value escape user.ts#<module>#edge#1"))).toBe(true);
  });

  it("an injected deps writer: the catch around the sink's call site needs a policy", () => {
    const r = scan(IMPORTS + `
export interface Deps { apply(d: string): void }
function w(d: string) { ${LOCKED}; }
export const deps: Deps = { apply: w };
export function use(x: Deps, d: string) { try { x.apply(d); } catch (e) { throw e; } }`,
    { edges: { "user.ts#<module>#edge#1": "user.ts#Deps.apply" } });
    expect(r.errors).toEqual(["unregistered propagating user.ts#use#catch#1"]);
  });

  it("an unregistered promise .catch", () => {
    const r = scan(IMPORTS + `
async function w(d: string) { ${LOCKED}; }
export function h(d: string) { void w(d).catch(() => undefined); }`);
    expect(r.errors).toContain("unregistered handler user.ts#h#promise#1");
  });

  it("a new wrapper function makes its callers' catches reachable", () => {
    const r = scan(IMPORTS + `
function w(d: string) { ${LOCKED}; }
function newWrapper(d: string) { return w(d); }
export function a(d: string) { try { newWrapper(d); } catch (e) { throw e; } }`);
    expect(r.writers).toContain("user.ts#newWrapper");
    expect(r.errors).toContain("unregistered propagating user.ts#a#catch#1");
  });

  it("a direct writer call outside any lock", () => {
    const r = scan(IMPORTS + `
export function bare(d: string) { writeSessionSync(d, { revision: 1 }); }`);
    expect(r.errors.some((e) => e.startsWith("lock: writeSessionSync at user.ts:"))).toBe(true);
  });

  it("a stale key and an unknown policy both fail", () => {
    const r = scan(IMPORTS + `
export function a(d: string) { try { ${LOCKED}; } catch (e) { throw e; } }`,
    { catches: { "user.ts#a#catch#1": "Z", "user.ts#gone#catch#1": "P" } });
    expect(r.errors).toContain("unknown policy Z for user.ts#a#catch#1");
    expect(r.errors).toContain("stale registry key user.ts#gone#catch#1");
  });
});

describe("ISS-958 state-write scanner: a clean program passes", () => {
  it("registered catches, a contained swallow, a registered edge, and locked writes", () => {
    const r = scan(IMPORTS + `
export interface Deps { apply(d: string): void }
function w(d: string) { withSessionLock(d, () => writeSessionSync(d, { revision: 1 })); }
export const deps: Deps = { apply: w };
export function a(d: string) { try { w(d); } catch (e) { throw e; } }
export function quiet(d: string) {
  let ok = true;
  try { w(d); } catch { ok = false; livenessLog("write failed"); }
  return ok;
}
export function soft(d: string) { try { w(d); } catch { return failed("write failed"); } return null; }
export function use(x: Deps, d: string) { try { x.apply(d); } catch (e) { throw e; } }`, {
      catches: { "user.ts#a#catch#1": "P", "user.ts#use#catch#1": "R" },
      edges: { "user.ts#<module>#edge#1": "user.ts#Deps.apply" },
    });
    expect(r.errors).toEqual([]);
    expect(r.found.get("user.ts#quiet#catch#1")).toBe("contained");
    expect(r.found.get("user.ts#soft#catch#1")).toBe("contained");
  });
});

describe("ISS-958 state-write scanner: test-only exports (guide.ts __recoveryTesting)", () => {
  const SEAM = IMPORTS + `
function w(d: string) { withSessionLock(d, () => writeSessionSync(d, { revision: 1 })); }
export function a(d: string) { try { w(d); } catch (e) { throw e; } }
export const __seamTesting = {
  run: (d: string) => { try { w(d); } catch (e) { throw e; } },
  ref: w,
};`;
  const REG = { catches: { "user.ts#a#catch#1": "P" }, testOnlyExports: ["user.ts#__seamTesting"] };

  it("code inside a declared test-only export is not a writer path and needs no key", () => {
    const r = scan(SEAM, REG);
    expect(r.errors).toEqual([]);
    expect(r.writers).not.toContain("user.ts#run");
    expect([...r.found.keys()].filter((k) => k.includes("#run#") || k.includes("#edge#"))).toEqual([]);
  });

  it("undeclared, the same seam is a writer path with an unregistered catch and value escape", () => {
    const r = scan(SEAM, { catches: REG.catches });
    expect(r.errors).toContain("unregistered propagating user.ts#run#catch#1");
    expect(r.errors.some((e) => e.startsWith("unregistered value escape user.ts#<module>#edge#"))).toBe(true);
  });

  it("a src file that references the test-only export is refused", () => {
    const r = scan(SEAM, REG, {
      "/fx/other.ts": `import { __seamTesting } from "./user.js";\nexport function prod(d: string) { __seamTesting.run(d); }\n`,
    });
    expect(r.errors.some((e) => e.startsWith("test-only export user.ts#__seamTesting is referenced from src at other.ts:"))).toBe(true);
  });

  it("a declared test-only export that no longer exists is stale", () => {
    const r = scan(IMPORTS + `export const notIt = 1;`, { testOnlyExports: ["user.ts#__seamTesting"] });
    expect(r.errors).toContain("stale test-only export user.ts#__seamTesting (no exported const with an initializer)");
  });
});

describe("ISS-958 state-write scanner: constructs the draft missed on real src", () => {
  const LOCKED = `withSessionLock(d, () => writeSessionSync(d, { revision: 1 }))`;

  it("a class member reached from another module through its instance type (a transient symbol)", () => {
    const r = scan(`import type { Ctx } from "./ctx.js";
export function f(ctx: Ctx) { try { ctx.writeState({ revision: 1 }); } catch (e) { throw e; } }`,
    { lockHeldByContract: ["ctx.ts#Ctx.writeState"] },
    { "/fx/ctx.ts": `import { writeSessionSync } from "./session.js";
export class Ctx { writeState(s: { revision: number }) { return writeSessionSync("d", s); } }\n` });
    expect(r.errors).toContain("unregistered propagating user.ts#f#catch#1");
  });

  it("an overloaded writer: the overload signature and the implementation are one writer", () => {
    const r = scan(`import { ow } from "./ow.js";
export function f(d: string) { try { ow(d); } catch (e) { throw e; } }`, {}, {
      "/fx/ow.ts": IMPORTS + `export function ow(d: string): void;
export function ow(d: string, n?: number): void { ${LOCKED}; }\n`,
    });
    expect(r.errors).toContain("unregistered propagating user.ts#f#catch#1");
  });

  it("a writer destructured from a dynamic import", () => {
    const r = scan(`export async function h(d: string) {
  try { const { stop } = await import("./cmd.js"); stop(d); } catch (e) { throw e; }
}`, {}, { "/fx/cmd.ts": IMPORTS + `export function stop(d: string) { ${LOCKED}; }\n` });
    expect(r.errors).toContain("unregistered propagating user.ts#h#catch#1");
  });

  it("a local bound to an injected writer or its default (deps.w ?? w)", () => {
    const r = scan(IMPORTS + `
function w(d: string) { ${LOCKED}; }
export function g(d: string, deps: { w?: (d: string) => void }) {
  const write = deps.w ?? w;
  try { write(d); } catch (e) { throw e; }
}`);
    expect(r.errors).toContain("unregistered propagating user.ts#g#catch#1");
    expect(r.errors).toContain("unregistered value escape user.ts#g#edge#1 (edge:w)");
  });

  it("a local bound to an inline writer arrow behind ??", () => {
    const r = scan(IMPORTS + `
export function g(d: string, deps: { w?: (d: string) => void }) {
  const write = deps.w ?? ((x: string) => withSessionLock(x, () => writeSessionSync(x, { revision: 1 })));
  try { write(d); } catch (e) { throw e; }
}`);
    expect(r.errors).toContain("unregistered propagating user.ts#g#catch#1");
  });

  it("a writer defined inline as a deps-object member is a value escape, and its slot's call sites are reached once registered", () => {
    const core = { "/fx/core.ts": `export interface Deps { readonly norm: (d: string) => void }
export function core(d: string, deps: Deps) { try { deps.norm(d); } catch (e) { throw e; } }\n` };
    const code = IMPORTS + `import { core } from "./core.js";
export function entry(d: string) { core(d, { norm: (x) => withSessionLock(x, () => writeSessionSync(x, { revision: 1 })) }); }`;
    const unregistered = scan(code, {}, core);
    expect(unregistered.errors).toContain("unregistered value escape user.ts#entry#edge#1 (edge:norm)");
    const registered = scan(code, { edges: { "user.ts#entry#edge#1": "core.ts#Deps.norm" } }, core);
    expect(registered.errors).toEqual(["unregistered propagating core.ts#core#catch#1"]);
  });

  it("a promise chained on a writer callback: the catch around its await, and a handler on it", () => {
    const r = scan(IMPORTS + `
export async function q(d: string, prev: Promise<void>) {
  const current = prev.then(async () => ${LOCKED});
  current.then(() => {}, () => {});
  try { await current; } catch (e) { throw e; }
}`);
    expect(r.errors).toContain("unregistered propagating user.ts#q#catch#1");
    expect(r.errors).toContain("unregistered handler user.ts#q#promise#1");
  });
});

// ---- the S6 scanner addendum (U1 to U3, L1, A1 to A7) ------------------------------

const TYPES = `import { writeSessionSync } from "./session.js";
export class StageContext {
  constructor(readonly dir: string) {}
  writeState(s: { revision: number }) { return writeSessionSync(this.dir, s); }
  async drainDeferrals(): Promise<void> {}
  async step(i: number): Promise<void> { this.writeState({ revision: i }); }
}
export interface WorkflowStage { enter(ctx: StageContext): Promise<void> }
`;
const LOCK_IMPORTS = `import { withSessionLock, writeSessionSync } from "./session.js";
import { StageContext, type WorkflowStage } from "./types.js";
async function pause() {}
`;
const CTX_REG: Partial<ScannerRegistry> = { lockHeldByContract: ["types.ts#StageContext.writeState"] };

function lockScan(code: string, registry: Partial<ScannerRegistry> = {}, extra: Record<string, string> = {}) {
  const program = inMemoryProgram({ "/fx/session.ts": SESSION, "/fx/types.ts": TYPES, "/fx/user.ts": code, ...extra });
  return scanStateWrites(program, {
    base: "/fx",
    rootFile: ROOT_FILE,
    rootName: "writeSessionSync",
    lockName: "withSessionLock",
    registry: { ...EMPTY, ...CTX_REG, ...registry },
    lockContext: { file: "types.ts", className: "StageContext", stageInterface: "WorkflowStage" },
  });
}
/** BODY runs inside a lock callback that has built `ctx`; construction `user.ts#run#new#1` is registered. */
function inLock(body: string, top = "", registry: Partial<ScannerRegistry> = {}) {
  return lockScan(LOCK_IMPORTS + top + `
export async function run(d: string, items: number[], stage: WorkflowStage) {
  await withSessionLock(d, async () => {
    const ctx = new StageContext(d);
    ${body}
  });
}`, { contextConstructions: ["user.ts#run#new#1"], ...registry });
}
const lifetime = (errors: string[]) => errors.filter((e) => e.startsWith("lock-lifetime"));

describe("ISS-958 S6 addendum: unresolved callees and the name rule (U1 to U3)", () => {
  const LOCKED = `withSessionLock(d, () => writeSessionSync(d, { revision: 1 }))`;

  it("U1a: a writer closure passed to an unregistered callee is a value escape", () => {
    const r = scan(IMPORTS + `
function run(f: () => void) { f(); }
function w(d: string) { ${LOCKED}; }
export function a(d: string) { run(() => w(d)); }`);
    expect(r.errors).toContain("unregistered value escape user.ts#a#edge#1 (edge:<closure>)");
  });

  it("U1a: a call through a parameter is not UNRESOLVED", () => {
    const r = scan(IMPORTS + `
export function a(f: () => void) { try { f(); } catch (e) { throw e; } }`);
    expect(r.errors).toEqual([]);
  });

  it("U1b: a let with no initializer resolves through its assignments", () => {
    const r = scan(IMPORTS + `
function w(d: string) { ${LOCKED}; }
export function a(d: string, soft: boolean) {
  let f: (d: string) => void;
  if (soft) f = () => {}; else f = w;
  try { f(d); } catch (e) { throw e; }
}`);
    expect(r.errors).toContain("unregistered propagating user.ts#a#catch#1");
  });

  it("U1b: an unresolvable assignment makes the use UNRESOLVED", () => {
    const r = scan(IMPORTS + `
declare function pick(): (d: string) => void;
export function a(d: string) {
  let f: (d: string) => void = () => {};
  f = pick();
  try { f(d); } catch (e) { throw e; }
}`);
    expect(r.errors).toContain("UNRESOLVED user.ts#a#f#1 (call-result)");
  });

  it("U1c: a call result and an element access stay UNRESOLVED", () => {
    const r = scan(IMPORTS + `
declare function getFn(): (d: string) => void;
export function a(d: string, fs: Array<(d: string) => void>) {
  try { getFn()(d); fs[0]!(d); } catch (e) { throw e; }
}`);
    expect(r.errors).toContain("UNRESOLVED user.ts#a#getFn()#1 (call-result)");
    expect(r.errors).toContain("UNRESOLVED user.ts#a#fs[0]!#1 (element-access)");
  });

  it("U2: an interface member call whose name is a writer's is a writer call; another name is not", () => {
    const r = scan(IMPORTS + `
interface I { m(): void; n(): void }
function w(d: string) { ${LOCKED}; }
export class W implements I { m() { w("d"); } n() {} }
export function run(x: I) { try { x.m(); } catch (e) { throw e; } }
export function other(x: I) { try { x.n(); } catch (e) { throw e; } }`);
    expect(r.errors).toContain("unregistered propagating user.ts#run#catch#1");
    expect(r.errors.filter((e) => e.includes("#other#"))).toEqual([]);
  });

  it("U2: an object-literal key whose value is a writer puts its name in N", () => {
    const r = scan(IMPORTS + `
interface I { k(d: string): void }
function w(d: string) { ${LOCKED}; }
export const o = { k: w };
export function run(x: I) { try { x.k("d"); } catch (e) { throw e; } }`);
    expect(r.errors).toContain("unregistered propagating user.ts#run#catch#1");
  });

  it("U2: a computed member call is UNRESOLVED", () => {
    const r = scan(IMPORTS + `
interface I { m(): void }
export function run(x: I, k: "m") { try { x[k](); } catch (e) { throw e; } }`);
    expect(r.errors).toContain("UNRESOLVED user.ts#run#x[k]#1 (element-access)");
  });

  it("U3: an any-typed receiver is UNRESOLVED", () => {
    const r = scan(IMPORTS + `
export function run(x: any) { try { x.m(); } catch (e) { throw e; } }`);
    expect(r.errors).toContain("UNRESOLVED user.ts#run#x.m#1 (untyped)");
  });

  it("rule 3: Object.defineProperty with a writer value is a value escape", () => {
    const r = scan(IMPORTS + `
function w(d: string) { ${LOCKED}; }
export function a(o: object) { Object.defineProperty(o, "m", { value: w }); }`);
    expect(r.errors).toContain("unregistered value escape user.ts#a#edge#1 (edge:w)");
  });
});

describe("ISS-958 S6 addendum: member reads (A1) and accessors (A2)", () => {
  const LOCKED = `withSessionLock(d, () => writeSessionSync(d, { revision: 1 }))`;
  const W = IMPORTS + `
interface I { m(): void }
function w(d: string) { ${LOCKED}; }
class W implements I { m() { w("d"); } }
`;

  it("A1: a parameter binding pattern reaches the catch", () => {
    const r = scan(W + `function run({ m }: I) { try { m(); } catch {} }
export function go() { run(new W()); }`);
    expect(r.found.get("user.ts#run#catch#1")).toBe("contained");
  });

  it("A1: an alias of a destructured member reaches the catch", () => {
    const r = scan(W + `function run({ m }: I) { const g = m; try { g(); } catch (e) { throw e; } }
export function go() { run(new W()); }`);
    expect(r.errors).toContain("unregistered propagating user.ts#run#catch#1");
  });

  it("A1: a non-call property read reaches the catch", () => {
    const r = scan(W + `export function run(x: I) { const f = x.m; try { f(); } catch (e) { throw e; } }`);
    expect(r.errors).toContain("unregistered propagating user.ts#run#catch#1");
  });

  it("A1: an assignment pattern reaches the catch", () => {
    const r = scan(W + `export function run(x: I) { let m: () => void; ({ m } = x); try { m(); } catch (e) { throw e; } }`);
    expect(r.errors).toContain("unregistered propagating user.ts#run#catch#1");
  });

  it("A1: a for-of pattern reaches the catch", () => {
    const r = scan(W + `export function run(xs: I[]) { for (const { m } of xs) { try { m(); } catch (e) { throw e; } } }`);
    expect(r.errors).toContain("unregistered propagating user.ts#run#catch#1");
  });

  it("A1: a rest element over a type with a member in N is UNRESOLVED", () => {
    const r = scan(W + `export function run(x: I & { z: number }) { const { z, ...rest } = x; return [z, rest]; }`);
    expect(r.errors.some((e) => e.startsWith("UNRESOLVED user.ts#run#...rest#1 (rest-binding)"))).toBe(true);
  });

  it("A1: a data member whose name is in N is not a writer read", () => {
    const r = scan(W + `interface D { m: { n: number } }
export function run(x: D) { const f = x.m; try { return f.n; } catch (e) { throw e; } }
export function pass(x: D, k: (v: unknown) => void) { k(x.m); }`);
    expect(r.errors).toEqual([]);
    expect(r.found.has("user.ts#run#catch#1")).toBe(false);
  });

  it("A1: a function-typed property named in N is still a writer read", () => {
    const r = scan(W + `interface P { m: () => void }
export function run(x: P) { const f = x.m; try { f(); } catch (e) { throw e; } }`);
    expect(r.errors).toContain("unregistered propagating user.ts#run#catch#1");
  });

  it("A1: an unknown-typed property named in N is still a writer read", () => {
    const r = scan(W + `interface Q { m: unknown }
export function run(x: Q, k: (v: unknown) => void) { k(x.m); }`);
    expect(r.errors.some((e) => e.startsWith("unregistered value escape user.ts#run#edge#1"))).toBe(true);
  });

  it.each([
    ["any", "any"],
    ["a union of data and a function", "{ n: number } | (() => void)"],
    ["Function", "Function"],
    ["object", "object"],
    ["{}", "{}"],
  ])("A1: a member in N typed %s is still classified (fail closed)", (_n, type) => {
    const r = scan(W + `interface Q { m: ${type} }
export function run(x: Q, k: (v: unknown) => void) { k(x.m); }`);
    expect(r.errors.some((e) => e.startsWith("unregistered value escape user.ts#run#edge#1"))).toBe(true);
  });

  it("A1: a data member in N cast to a callable and called is UNRESOLVED", () => {
    const r = scan(W + `interface D { m: { n: number } }
export function run(x: D) { try { (x.m as unknown as () => void)(); } catch (e) { throw e; } }`);
    expect(r.errors.some((e) => e.startsWith("UNRESOLVED user.ts#run#") && e.endsWith("(cast-data-member)"))).toBe(true);
  });

  it("A1: a data member in N cast to a callable and passed on is a value escape", () => {
    const r = scan(W + `interface D { m: { n: number } }
export function run(x: D, k: (v: unknown) => void) { k(x.m as unknown as () => void); }`);
    expect(r.errors.some((e) => e.startsWith("unregistered value escape user.ts#run#edge#1"))).toBe(true);
  });

  it("A2: a getter that writes and returns a function is refused", () => {
    const r = scan(IMPORTS + `function w(d: string) { ${LOCKED}; }
export class A { get g() { w("d"); return () => {}; } }`);
    expect(r.errors.some((e) => e.startsWith("writer-bearing accessor user.ts#A.g"))).toBe(true);
  });

  it("A2: a standalone getter read is refused", () => {
    const r = scan(IMPORTS + `function w(d: string) { ${LOCKED}; }
export const o = { get v() { w("d"); return 1; } };
export function read() { return o.v; }`);
    expect(r.errors.some((e) => e.startsWith("writer-bearing accessor user.ts#v"))).toBe(true);
  });

  it("A2: a setter assignment is refused", () => {
    const r = scan(IMPORTS + `function w(d: string) { ${LOCKED}; }
export class B { set s(x: number) { w("d"); } }
export function put(b: B) { b.s = 1; }`);
    expect(r.errors.some((e) => e.startsWith("writer-bearing accessor user.ts#B.s"))).toBe(true);
  });
});

describe("ISS-958 S6 addendum: the lock contract (L1, A3, A5 to A7)", () => {
  it("a clean lock program passes: awaited, returned, for-of awaited, sync forEach, awaited IIFE, stage dispatch", () => {
    const r = inLock(`await ctx.drainDeferrals();
    for (const i of items) { await ctx.step(i); }
    items.forEach((i) => ctx.writeState({ revision: i }));
    await (async () => { await pause(); ctx.writeState({ revision: 1 }); })();
    await stage.enter(ctx);`, `
export class S implements WorkflowStage { async enter(ctx: StageContext) { return ctx.drainDeferrals(); } }
export function inner(d: string) { return withSessionLock(d, () => handleInner(d)); }
function handleInner(d: string) { return d.length; }
`);
    expect(r.errors).toEqual([]);
    expect(r.constructions).toEqual(["user.ts#run#new#1"]);
  });

  it("the guide chain shape passes with its registered edge and handler", () => {
    const r = lockScan(LOCK_IMPORTS + `
let chain: Promise<void> = Promise.resolve();
export function guide(d: string) {
  const current = chain.then(() => withSessionLock(d, async () => { const ctx = new StageContext(d); ctx.writeState({ revision: 1 }); }));
  chain = current.catch(() => {});
  return current;
}`, {
      contextConstructions: ["user.ts#guide#new#1"],
      edges: { "user.ts#guide#edge#1": "user.ts#guide(chain)" },
      catches: { "user.ts#guide#promise#1": "K" },
    });
    expect(r.errors).toEqual([]);
  });

  it.each([
    ["Promise.allSettled", "await Promise.allSettled([ctx.drainDeferrals()]);"],
    ["Promise.all", "await Promise.all([ctx.drainDeferrals()]);"],
    ["a promise local", "const p = ctx.drainDeferrals(); await p;"],
    ["void", "void ctx.drainDeferrals();"],
    ["a bare statement", "ctx.drainDeferrals();"],
    ["then", "await ctx.drainDeferrals().then(() => 1);"],
    ["an un-awaited IIFE", "(async () => { await pause(); ctx.writeState({ revision: 1 }); })();"],
  ])("A6: %s under the lock is a lock-lifetime error", (_n, body) => {
    expect(lifetime(inLock(body).errors).length).toBeGreaterThan(0);
  });

  it("A6: return inside a try with a finally is a lock-lifetime error", () => {
    const r = inLock("await stage.enter(ctx);", `
export class S implements WorkflowStage { async enter(ctx: StageContext) { try { return ctx.drainDeferrals(); } finally { void 0; } } }
`);
    expect(lifetime(r.errors).some((e) => e.includes("StageContext.drainDeferrals"))).toBe(true);
  });

  it.each([
    ["forEach(async)", "items.forEach(async () => { ctx.writeState({ revision: 1 }); });"],
    ["map(async) discarded", "items.map(async (i) => { await ctx.step(i); });"],
    ["map(async) in Promise.all", "await Promise.all(items.map(async (i) => { await ctx.step(i); }));"],
    ["setTimeout", "setTimeout(() => ctx.writeState({ revision: 1 }), 0);"],
    ["forEach returning a thenable", "items.forEach((i) => { ctx.writeState({ revision: i }); return pause(); });"],
  ])("A6: a contract closure %s is a lock-lifetime error", (_n, body) => {
    expect(lifetime(inLock(body).errors).length).toBeGreaterThan(0);
  });

  it("A3b: a stage class field holding the context is refused", () => {
    const r = inLock("await stage.enter(ctx);", `
export class S implements WorkflowStage { saved?: StageContext; async enter(ctx: StageContext) { this.saved = ctx; } }
`);
    expect(lifetime(r.errors).some((e) => e.includes("class field saved holds a context"))).toBe(true);
    expect(lifetime(r.errors).some((e) => e.includes("stored to a field or a container"))).toBe(true);
  });

  it("A3b: the context pushed into a container is refused", () => {
    const r = inLock("held.push(ctx);", "const held: StageContext[] = [];\n");
    expect(lifetime(r.errors).some((e) => e.includes("passed where the parameter is not a context"))).toBe(true);
  });

  it("A3b: the context stored to a module binding is refused", () => {
    const r = inLock("saved = ctx;", "let saved: StageContext | undefined;\n");
    expect(lifetime(r.errors).some((e) => e.includes("stored to a module-level binding"))).toBe(true);
  });

  it("A3b: the context returned from a function that does not construct it is refused", () => {
    const r = inLock("keep(ctx);", "function keep(c: StageContext) { return c; }\n");
    expect(lifetime(r.errors).some((e) => e.includes("returned from a function that is not a construction site"))).toBe(true);
  });

  it("L1a: a construction outside the lock, and an unregistered or stale construction, are refused", () => {
    const r = lockScan(LOCK_IMPORTS + `export function bare(d: string) { return new StageContext(d); }`,
      { contextConstructions: ["user.ts#gone#new#1"] });
    expect(r.errors.some((e) => e.startsWith("lock-lifetime: context constructed at user.ts:"))).toBe(true);
    expect(r.errors).toContain("unregistered context construction user.ts#bare#new#1");
    expect(r.errors).toContain("stale context construction user.ts#gone#new#1");
  });

  it("L1: a tier 1 function called from an unheld function is refused; tier 3 admits it with its caller", () => {
    const top = `function helper(d: string) { new StageContext(d).writeState({ revision: 1 }); }
`;
    const code = LOCK_IMPORTS + top + `export async function run(d: string) { await withSessionLock(d, async () => { helper(d); }); }`;
    // helper builds a context outside the lock callback: refused until tier 3 lists it.
    const bare = lockScan(code, { contextConstructions: ["user.ts#helper#new#1"] });
    expect(bare.errors.some((e) => e.startsWith("lock: lock-held function types.ts#StageContext.writeState"))).toBe(true);
    const listed = lockScan(code, { contextConstructions: ["user.ts#helper#new#1"], lockHeldViaCaller: { "user.ts#helper": "user.ts#run" } });
    expect(listed.errors).toEqual([]);
    expect(listed.tiers.viaCaller).toEqual(["user.ts#helper"]);
    const wrongHolder = lockScan(code, { contextConstructions: ["user.ts#helper#new#1"], lockHeldViaCaller: { "user.ts#helper": "user.ts#elsewhere" } });
    expect(wrongHolder.errors).toContain("via-caller user.ts#helper names user.ts#elsewhere, which does not call it");
  });

  it("L1: a tier 1 function called through a local alias is checked like a direct call", () => {
    const top = `function helper(d: string) { new StageContext(d).writeState({ revision: 1 }); }
`;
    const code = LOCK_IMPORTS + top + `export function loose(d: string, alt?: (d: string) => void) { const h = alt ?? helper; h(d); }`;
    const r = lockScan(code, { contextConstructions: ["user.ts#helper#new#1"], lockHeldViaCaller: { "user.ts#helper": "user.ts#loose" },
      edges: { "user.ts#loose#edge#1": "user.ts#loose(alt)" } });
    expect(r.errors.some((e) => e.startsWith("lock: lock-held function user.ts#helper called at user.ts:") && e.includes("from user.ts#loose"))).toBe(true);
  });

  it("L1a: a tier 3 function held only for its construction is not stale", () => {
    const code = LOCK_IMPORTS + `async function use(ctx: StageContext) { await ctx.step(1); }
async function build(d: string) { await use(new StageContext(d)); }
export async function run(d: string) { await withSessionLock(d, async () => { await build(d); }); }`;
    const listed = lockScan(code, { contextConstructions: ["user.ts#build#new#1"], lockHeldViaCaller: { "user.ts#build": "user.ts#run" } });
    expect(listed.errors).toEqual([]);
    expect(listed.tiers.viaCaller).toEqual(["user.ts#build"]);
    const bare = lockScan(code, { contextConstructions: ["user.ts#build#new#1"] });
    expect(bare.errors.some((e) => e.startsWith("lock-lifetime: context constructed at user.ts:"))).toBe(true);
  });

  it("A7: the lock entry is verified to await its callback inside a try that releases in finally", () => {
    const bad = `export function withSessionLock<T>(dir: string, fn: () => T): T { return fn(); }
export function writeSessionSync(dir: string, s: { revision: number }) { return s; }\n`;
    const program = inMemoryProgram({ "/fx/session.ts": bad, "/fx/user.ts": "export {};\n" });
    const r = scanStateWrites(program, { base: "/fx", rootFile: ROOT_FILE, rootName: "writeSessionSync", lockName: "withSessionLock", registry: EMPTY });
    expect(r.errors).toContain("lock-lifetime: lock entry session.ts#withSessionLock does not await its callback at session.ts:1");
  });
});

// ---- the S6 scanner addendum 2 (R-a to R-e) ----------------------------------------

const NODE_ALS = `declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> { run<R>(store: T, callback: () => R): R; getStore(): T | undefined; }
}
declare module "fake-als" {
  export class AsyncLocalStorage<T> { run<R>(store: T, callback: () => R): R; }
}
`;
/** The production chain: primitive -> internal -> lock helper -> AsyncLocalStorage.run with release in finally. */
function projectChain(runLine: string, alsModule = "node:async_hooks") {
  return `import { AsyncLocalStorage } from "${alsModule}";
const als = new AsyncLocalStorage<number>();
function acquireP(): number { return 1; }
function releaseP(h: number): void {}
async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const handle = acquireP();
  try { ${runLine} } finally { releaseP(handle); }
}
async function internal(handler: (r: number) => Promise<void>): Promise<void> {
  await withLock(async () => { const r = 1; await handler(r); });
}
export async function withProjectLock(d: string, handler: (r: number) => Promise<void>): Promise<void> {
  return internal(handler);
}
`;
}
const GOOD_CHAIN = projectChain("return await als.run(handle, fn);");
const PRIM = { awaitedCallbackPrimitives: ["project.ts#withProjectLock"] };
const PROJECT_IMPORT = `import { withProjectLock } from "./project.js";\n`;
function add2Scan(body: string, top = "", registry: Partial<ScannerRegistry> = {}, project = GOOD_CHAIN) {
  const program = inMemoryProgram({
    "/fx/session.ts": SESSION, "/fx/types.ts": TYPES, "/fx/project.ts": project, "/fx/als.d.ts": NODE_ALS,
    "/fx/user.ts": LOCK_IMPORTS + PROJECT_IMPORT + top + `
export async function run(d: string, items: number[], stage: WorkflowStage) {
  await withSessionLock(d, async () => {
    const ctx = new StageContext(d);
    ${body}
  });
}`,
  });
  return scanStateWrites(program, {
    base: "/fx", rootFile: ROOT_FILE, rootName: "writeSessionSync", lockName: "withSessionLock",
    registry: { ...EMPTY, ...CTX_REG, contextConstructions: ["user.ts#run#new#1"], ...registry },
    lockContext: { file: "types.ts", className: "StageContext", stageInterface: "WorkflowStage" },
  });
}
const WRITE_UNDER_PROJECT = "await withProjectLock(d, async () => { ctx.writeState({ revision: 1 }); });";

describe("ISS-958 S6 addendum 2: awaited-callback primitives (R-a, R-a1)", () => {
  it("the full production chain verifies and its callback inherits the lock", () => {
    const r = add2Scan(WRITE_UNDER_PROJECT, "", PRIM);
    expect(r.errors).toEqual([]);
    expect(r.chainMembers).toEqual(["project.ts#internal", "project.ts#withLock"]);
  });

  it("unpinned, the same callback is an async contract closure passed to a callee", () => {
    expect(lifetime(add2Scan(WRITE_UNDER_PROJECT).errors).length).toBeGreaterThan(0);
  });

  it("an unpinned with*Lock callee is not admitted by its name", () => {
    const r = add2Scan("await withOtherLock(d, async () => { ctx.writeState({ revision: 1 }); });",
      "async function withOtherLock(d: string, fn: () => Promise<void>) { void fn(); }\n", PRIM);
    expect(lifetime(r.errors).length).toBeGreaterThan(0);
  });

  it("the primitive call itself must be awaited or returned", () => {
    const r = add2Scan("void withProjectLock(d, async () => { ctx.writeState({ revision: 1 }); });", "", PRIM);
    expect(lifetime(r.errors).some((e) => e.includes("awaited-callback withProjectLock"))).toBe(true);
  });

  it.each([
    ["the run result discarded", "als.run(handle, fn); return undefined as T;"],
    ["run returned un-awaited inside the releasing try", "return als.run(handle, fn);"],
  ])("the pin is rejected when %s", (_n, line) => {
    const r = add2Scan(WRITE_UNDER_PROJECT, "", PRIM, projectChain(line));
    expect(r.errors.some((e) => e.startsWith("lock-lifetime: awaited-callback primitive project.ts#withProjectLock rejected"))).toBe(true);
  });

  it("the pin is rejected when the handler is not awaited in the internal hop", () => {
    const r = add2Scan(WRITE_UNDER_PROJECT, "", PRIM, GOOD_CHAIN.replace("await handler(r);", "void handler(r);"));
    expect(r.errors.some((e) => e.startsWith("lock-lifetime: awaited-callback primitive project.ts#withProjectLock rejected"))).toBe(true);
  });

  it("a run method on a class that is not Node's AsyncLocalStorage is library-mediated and rejects the pin", () => {
    const r = add2Scan(WRITE_UNDER_PROJECT, "", PRIM, projectChain("return await als.run(handle, fn);", "fake-als"));
    expect(r.errors.some((e) => e.includes("rejected") && e.includes("library-mediated"))).toBe(true);
  });

  it("an injected slot listed with its reason passes; a src supplier of it is refused; unlisted it is refused", () => {
    const top = `export interface Deps { readonly withLockX?: (fn: () => Promise<void>) => Promise<void> }
export async function take(d: string, ctx: StageContext, deps: Deps) {
  const under = deps.withLockX ?? (async (fn: () => Promise<void>) => { await withProjectLock(d, async () => fn()); });
  await under(async () => { ctx.writeState({ revision: 1 }); });
}
`;
    const listed = { ...PRIM, injectedCallbackSlots: { "user.ts#Deps.withLockX": "tests only" } };
    expect(add2Scan("await take(d, ctx, {});", top, listed).errors).toEqual([]);
    const supplied = add2Scan("await take(d, ctx, { withLockX: async (fn) => fn() });", top, listed);
    expect(supplied.errors.some((e) => e.startsWith("injected awaited-callback slot user.ts#Deps.withLockX is supplied in src at"))).toBe(true);
    expect(lifetime(add2Scan("await take(d, ctx, {});", top, PRIM).errors).length).toBeGreaterThan(0);
    expect(add2Scan("await take(d, ctx, {});", "export {};\n", listed).errors).toContain("stale injected awaited-callback slot user.ts#Deps.withLockX");
  });
});

describe("ISS-958 S6 addendum 2: local functions (R-b), edge callbacks (R-c), in-place ?? (R-d), context params (R-e)", () => {
  it("R-b: a const closure called directly under the lock inherits it", () => {
    const r = add2Scan(`const publish = (n: number) => ctx.writeState({ revision: n });
    publish(1);
    const raw = () => writeSessionSync(d, { revision: 2 });
    raw();`);
    expect(r.errors).toEqual([]);
  });

  it("R-b: a non-call reference is the stored error", () => {
    const r = add2Scan(`const publish = (n: number) => { ctx.writeState({ revision: n }); };
    items.forEach(publish);`);
    expect(lifetime(r.errors).some((e) => e.includes("contract closure publish") && e.includes("other than by a direct call"))).toBe(true);
  });

  it("R-b: a call site outside the lock is refused there", () => {
    const r = add2Scan("", `export function free(d: string) { const w = () => writeSessionSync(d, { revision: 1 }); w(); }\n`);
    expect(r.errors.some((e) => e.startsWith("lock: writeSessionSync at user.ts:"))).toBe(true);
  });

  it("R-b: an async local function must be awaited or returned at each call", () => {
    const ok = add2Scan("const a = async () => { await ctx.step(1); };\n    await a();");
    expect(ok.errors).toEqual([]);
    const bad = add2Scan("const a = async () => { await ctx.step(1); };\n    void a();");
    expect(lifetime(bad.errors).length).toBeGreaterThan(0);
  });

  const EACH = `async function eachAsync(n: number, cb: (i: number) => void): Promise<void> { await pause(); cb(n); }
async function later(n: number, cb: (i: number) => void): Promise<void> { setTimeout(() => cb(n), 0); }
`;
  it("R-c: a registered sync callback to a function calling it directly passes", () => {
    const r = add2Scan("await eachAsync(1, (i) => { ctx.writeState({ revision: i }); });", EACH,
      { edges: { "user.ts#run#edge#1": "user.ts#eachAsync(cb)" } });
    expect(r.errors).toEqual([]);
  });

  it("R-c: the callee call must complete, and a callee calling the slot from a nested closure is refused", () => {
    const voided = add2Scan("void eachAsync(1, (i) => { ctx.writeState({ revision: i }); });", EACH,
      { edges: { "user.ts#run#edge#1": "user.ts#eachAsync(cb)" } });
    expect(lifetime(voided.errors).length).toBeGreaterThan(0);
    const nested = add2Scan("await later(1, (i) => { ctx.writeState({ revision: i }); });", EACH,
      { edges: { "user.ts#run#edge#1": "user.ts#later(cb)" } });
    expect(lifetime(nested.errors).length).toBeGreaterThan(0);
  });

  it("R-d: a closure invoked in place through ?? inherits the lock and must complete", () => {
    const top = "const maybe: (() => Promise<void>) | undefined = undefined;\n";
    expect(add2Scan("await (maybe ?? (async () => { await ctx.step(1); }))();", top).errors).toEqual([]);
    expect(lifetime(add2Scan("(maybe ?? (async () => { await ctx.step(1); }))();", top).errors).length).toBeGreaterThan(0);
  });

  it("R-e: the context passed to a listed structural parameter passes; unlisted it is refused; the parameter is retained like the context", () => {
    const top = `interface Host { writeState(s: { revision: number }): unknown; readonly dir: string }
function prep(host: Host) { host.writeState({ revision: 1 }); }
let saved: Host | undefined;
function keepHost(host: Host) { saved = host; }
`;
    expect(add2Scan("prep(ctx);", top, { contextParams: ["user.ts#prep(host)"] }).errors).toEqual([]);
    expect(lifetime(add2Scan("prep(ctx);", top).errors).some((e) => e.includes("passed where the parameter is not a context"))).toBe(true);
    const kept = add2Scan("keepHost(ctx);", top, { contextParams: ["user.ts#keepHost(host)"] });
    expect(lifetime(kept.errors).some((e) => e.includes("stored to a module-level binding"))).toBe(true);
    expect(add2Scan("prep(ctx);", top, { contextParams: ["user.ts#prep(host)", "user.ts#gone(h)"] }).errors)
      .toContain("stale context-carrying parameter user.ts#gone(h)");
  });
});

// ---- the S6 scanner addendum 3 (R-f to R-j1) ----------------------------------------

describe("ISS-958 S6 addendum 3: rejected wrappers (R-f), bound writers (R-h, R-h1), test-seam slots (R-j1)", () => {
  const QUEUE = "const queue: Array<() => void> = [];\n";
  it("R-f: a rejected wrapper whose callback carries nothing is silent", () => {
    const r = add2Scan("const wrap = (fn: () => void) => { queue.push(fn); };\n    wrap(() => { void 0; });", QUEUE);
    expect(r.errors).toEqual([]);
  });

  it("R-f: a rejected wrapper gives no credit, so a callback capturing the context still fails", () => {
    const r = add2Scan("const wrap = (fn: () => void) => { queue.push(fn); };\n    wrap(() => { ctx.writeState({ revision: 1 }); });", QUEUE);
    expect(lifetime(r.errors).some((e) => e.startsWith("lock-lifetime: context captured by a function that may run outside the lock"))).toBe(true);
    expect(r.errors.some((e) => e.includes("awaited-callback wrapper"))).toBe(false);
  });

  const SLOT = "{ readonly dir: string; writeState: (s: { revision: number }) => unknown }";
  const ACC = `function acc(o: ${SLOT}): void { o.writeState({ revision: o.dir.length }); }\n`;
  const ACC_KEEP = `let kept: unknown;\nfunction accKeep(o: ${SLOT}): void { kept = o.writeState; }\n`;
  const ACC_ASYNC = `async function accAsync(o: ${SLOT}): Promise<void> { o.writeState({ revision: 1 }); }\n`;
  const EDGE = { edges: { "user.ts#run#edge#1": "user.ts#<anon>.writeState" } };
  const BOUND = "{ dir: d, writeState: ctx.writeState.bind(ctx) }";

  it("R-h: the production bind shape passes with its edge registered and fails without it", () => {
    expect(add2Scan(`acc(${BOUND});`, ACC, EDGE).errors).toEqual([]);
    const bare = add2Scan(`acc(${BOUND});`, ACC);
    expect(lifetime(bare.errors).some((e) => e.includes("passed where the parameter is not a context"))).toBe(true);
  });

  it("R-h: a bind whose thisArg is another context fails", () => {
    const top = ACC + `export function two(a: StageContext, b: StageContext) { acc({ dir: a.dir, writeState: a.writeState.bind(b) }); }\n`;
    const r = add2Scan("", top, { edges: { "user.ts#two#edge#1": "user.ts#<anon>.writeState" } });
    expect(lifetime(r.errors).some((e) => e.includes("passed where the parameter is not a context"))).toBe(true);
  });

  it("R-h1: a synchronous receiver that stores the slot fails", () => {
    const r = add2Scan(`accKeep(${BOUND});`, ACC_KEEP, EDGE);
    expect(lifetime(r.errors).some((e) => e.includes("passed where the parameter is not a context"))).toBe(true);
  });

  it("R-h1: an async receiver must complete; awaited it passes", () => {
    expect(add2Scan(`await accAsync(${BOUND});`, ACC_ASYNC, EDGE).errors).toEqual([]);
    const voided = add2Scan(`void accAsync(${BOUND});`, ACC_ASYNC, EDGE);
    expect(voided.errors.some((e) => e.startsWith("lock-lifetime: edge receiver user.ts#accAsync called at user.ts:"))).toBe(true);
  });

  const SEAM = `export interface CDeps { readonly apply?: (d: string) => unknown }
export function commit(d: string, deps: CDeps) { const apply = deps.apply ?? ((x: string) => 0); return apply(d); }
`;
  const SEAMS = { testSeamSlots: { "user.ts#CDeps.apply": "tests only" } };
  it("R-j1: a test-seam slot supplied by src is refused; unsupplied it is silent; unnamed by an edge it is stale", () => {
    const supplied = add2Scan("commit(d, { apply: (x) => x });", SEAM, SEAMS);
    expect(supplied.errors.some((e) => e.startsWith("test-seam slot user.ts#CDeps.apply is supplied in src at"))).toBe(true);
    const quiet = add2Scan("commit(d, {});", SEAM, { ...SEAMS, edges: { "user.ts#x#edge#1": "user.ts#CDeps.apply" } });
    expect(quiet.errors.some((e) => e.includes("test-seam slot"))).toBe(false);
    expect(add2Scan("commit(d, {});", SEAM, SEAMS).errors).toContain("stale test-seam slot user.ts#CDeps.apply: no registered edge names it");
  });
});

describe("ISS-958 S6 staged-slot rulings: param slots passed on, not-followed sink chains", () => {
  it("a registered param slot passed on to another callee is a value escape", () => {
    const r = scan(IMPORTS + `function relay(cb: () => void) { other(cb); }
function other(f: () => void) { f(); }
export function a(d: string) { relay(() => writeSessionSync(d, { revision: 1 })); }`, { edges: { "user.ts#a#edge#1": "user.ts#relay(cb)" } });
    expect(r.errors).toContain("unregistered value escape user.ts#relay#edge#1 (edge:cb)");
  });

  const chainCode = (outerBody: string) => IMPORTS + `import { AsyncLocalStorage } from "node:async_hooks";
const als = new AsyncLocalStorage<number>();
async function inner(fn: () => Promise<number>): Promise<number> { return await als.run(1, fn); }
async function outer(fn: () => Promise<number>): Promise<number> { ${outerBody} }
export async function go(d: string) { await outer(async () => { writeSessionSync(d, { revision: 1 }); return 1; }); }`;
  const CHAIN = {
    edges: { "user.ts#go#edge#1": "outer -> inner -> AsyncLocalStorage.run(callback)" },
    unfollowedSinkChains: { "user.ts#go#edge#1": [{ fn: "user.ts#outer", param: "fn" }, { fn: "user.ts#inner", param: "fn" }] },
  };
  const ALS = { "/fx/als.d.ts": NODE_ALS };
  const chainErrors = (r: { errors: string[] }) => r.errors.filter((e) => e.startsWith("unfollowed sink chain"));

  it("a verified chain passes", () => {
    expect(chainErrors(scan(chainCode("const v = await inner(async () => fn()); return v;"), CHAIN, ALS))).toEqual([]);
  });

  it("a catch around the forward fails", () => {
    const r = scan(chainCode("try { return await inner(async () => fn()); } catch { return 0; }"), CHAIN, ALS);
    expect(chainErrors(r).some((e) => e.includes("a catch at user.ts:") && e.includes("encloses fn in user.ts#outer"))).toBe(true);
  });

  it("a hop that neither awaits nor returns fails, and a hop forwarding elsewhere fails", () => {
    const voided = scan(chainCode("void inner(async () => fn()); return 0;"), CHAIN, ALS);
    expect(chainErrors(voided).some((e) => e.includes("does not await or return"))).toBe(true);
    const elsewhere = scan(chainCode("return await fn();"), CHAIN, ALS);
    expect(chainErrors(elsewhere).some((e) => e.includes("forwards fn to fn, not user.ts#inner"))).toBe(true);
  });
});
