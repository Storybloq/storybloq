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
  // S10: every writer promise is awaited inside the try under test, so each
  // catch below is one a write failure reaches at runtime.
  const LOCKED = `await withSessionLock(d, () => writeSessionSync(d, { revision: 1 }))`;

  it("an aliased import", () => {
    const r = scan(`import { writeSessionSync as wss, withSessionLock } from "./session.js";
export async function a(d: string) { try { await withSessionLock(d, () => wss(d, { revision: 1 })); } catch (e) { throw e; } }`);
    expect(r.errors).toContain("unregistered propagating user.ts#a#catch#1");
  });

  it("a rethrowing wrapper", () => {
    const r = scan(IMPORTS + `
async function wrap(d: string) { try { ${LOCKED}; } catch (e) { throw e; } }
export async function b(d: string) { await wrap(d); }`, { catches: {} });
    expect(r.errors).toContain("unregistered propagating user.ts#wrap#catch#1");
    expect(r.writers).toContain("user.ts#b");
  });

  it("a catch that swallows in one branch and rethrows in another", () => {
    const r = scan(IMPORTS + `
export async function a(d: string, soft: boolean) { try { ${LOCKED}; } catch (e) { if (soft) { livenessLog("x"); } else { throw e; } } }`);
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

  it("S1: a returned writer promise passes the catch it is returned from; an awaited one settles there", () => {
    const code = (ret: string) => IMPORTS + `
async function asyncWriter(d: string): Promise<void> { ${LOCKED}; }
async function inner(d: string): Promise<void> { try { ${ret}; } catch {} }
export async function outer(d: string) { try { await inner(d); } catch (e) { throw e; } }`;
    const returned = scan(code("return asyncWriter(d)"));
    expect(returned.found.get("user.ts#inner#catch#1")).toBe("contained");
    expect(returned.writers).toContain("user.ts#inner");
    expect(returned.errors).toEqual(["unregistered propagating user.ts#outer#catch#1"]);
    const awaited = scan(code("return await asyncWriter(d)"));
    expect(awaited.found.get("user.ts#inner#catch#1")).toBe("contained");
    expect(awaited.writers).not.toContain("user.ts#inner");
    expect(awaited.errors).toEqual([]);
  });

  // T1: a writer promise anywhere in a returned expression, with no await
  // between, passes every catch it is returned from (fail closed).
  const t1 = (ret: string) => scan(IMPORTS + `
async function asyncWriter(d: string): Promise<void> { ${LOCKED}; }
async function inner(d: string, b: boolean, p?: Promise<void>): Promise<unknown> { try { ${ret}; } catch {} return null; }
export async function outer(d: string) { try { await inner(d, true); } catch (e) { throw e; } }`);
  it.each([
    ["a conditional", "return b ? asyncWriter(d) : Promise.resolve()"],
    ["??", "return p ?? asyncWriter(d)"],
    ["||", "return p || asyncWriter(d)"],
    ["&&", "return b && asyncWriter(d)"],
    ["a comma", "return (livenessLog(\"x\"), asyncWriter(d))"],
    ["parentheses", "return (asyncWriter(d))"],
    ["as", "return asyncWriter(d) as Promise<void>"],
    ["a non-null assertion", "return asyncWriter(d)!"],
    ["satisfies", "return asyncWriter(d) satisfies Promise<void>"],
    ["a local holding the promise", "const q = asyncWriter(d); return b ? q : null"],
    ["a promise built from it", "return Promise.all([asyncWriter(d)])"],
  ])("T1: a writer promise returned through %s passes the catch", (_n, ret) => {
    const r = t1(ret);
    expect(r.writers).toContain("user.ts#inner");
    expect(r.errors).toContain("unregistered propagating user.ts#outer#catch#1");
  });

  it("T1: an awaited returned expression settles in the try", () => {
    const r = t1("return await (b ? asyncWriter(d) : Promise.resolve())");
    expect(r.found.get("user.ts#inner#catch#1")).toBe("contained");
    expect(r.writers).not.toContain("user.ts#inner");
    expect(r.errors).toEqual([]);
  });

  it.each([["any"], ["unknown"]])("return x where x: %s", (t) => {
    const r = scan(IMPORTS + `
export async function a(d: string, x: ${t}) { try { ${LOCKED}; } catch { return x; } return null; }`);
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
export async function a(d: string) { try { ${LOCKED}; } catch (e) { rethrow(e); } }`);
    expect(r.errors).toContain("unregistered propagating user.ts#a#catch#1");
  });

  it("the writer assigned to a (...a: unknown[]) => void slot", () => {
    const r = scan(IMPORTS + `
async function w(d: string) { ${LOCKED}; }
export const slot: (...a: unknown[]) => void = w as (...a: unknown[]) => void;`);
    expect(r.errors.some((e) => e.startsWith("unregistered value escape user.ts#<module>#edge#1"))).toBe(true);
  });

  it("an injected deps writer: the catch around the sink's call site needs a policy", () => {
    const r = scan(IMPORTS + `
export interface Deps { apply(d: string): Promise<void> }
async function w(d: string) { ${LOCKED}; }
export const deps: Deps = { apply: w };
export async function use(x: Deps, d: string) { try { await x.apply(d); } catch (e) { throw e; } }`,
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
async function w(d: string) { ${LOCKED}; }
function newWrapper(d: string) { return w(d); }
export async function a(d: string) { try { await newWrapper(d); } catch (e) { throw e; } }`);
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
export async function a(d: string) { try { ${LOCKED}; } catch (e) { throw e; } }`,
    { catches: { "user.ts#a#catch#1": "Z", "user.ts#gone#catch#1": "P" } });
    expect(r.errors).toContain("unknown policy Z for user.ts#a#catch#1");
    expect(r.errors).toContain("stale registry key user.ts#gone#catch#1");
  });
});

describe("ISS-958 S6 fixup: a writer constructor (the CTOR mutant survived at 9387b32c)", () => {
  it("a writer constructor reached by new is refused", () => {
    const r = scan(IMPORTS + `
export class Boot { constructor(d: string) { writeSessionSync(d, { revision: 1 }); } }
export async function make(d: string) { await withSessionLock(d, () => new Boot(d)); }`);
    expect(r.errors.some((e) => e.startsWith("writer constructor reached by new at user.ts:"))).toBe(true);
  });
});

describe("ISS-958 S9: a second primitive that writes on its own seeds discovery and the lock check", () => {
  const DURABLE = SESSION + `export function writeSessionDurableSync(dir: string, s: { revision: number }): { revision: number } { return s; }\n`;
  const durableScan = (code: string) => scanStateWrites(inMemoryProgram({ "/fx/session.ts": DURABLE, "/fx/user.ts": code }), {
    base: "/fx", rootFile: ROOT_FILE, rootName: "writeSessionSync", extraRootNames: ["writeSessionDurableSync"],
    lockName: "withSessionLock", registry: EMPTY,
  });
  const D_IMPORTS = `import { writeSessionDurableSync, withSessionLock } from "./session.js";\n`;

  it("a durable-only write under a catch is an unregistered catch", () => {
    const r = durableScan(D_IMPORTS + `
export async function a(d: string) { try { await withSessionLock(d, () => writeSessionDurableSync(d, { revision: 1 })); } catch (e) { throw e; } }`);
    expect(r.errors).toEqual(["unregistered propagating user.ts#a#catch#1"]);
    expect(r.writers).toContain("user.ts#a");
  });

  it("an unlocked durable-only write is a lock error", () => {
    const r = durableScan(D_IMPORTS + `export function bare(d: string) { writeSessionDurableSync(d, { revision: 1 }); }`);
    expect(r.errors.some((e) => e.startsWith("lock: writeSessionDurableSync at user.ts:"))).toBe(true);
  });
});

describe("ISS-958 state-write scanner: a clean program passes", () => {
  it("registered catches, a contained swallow, a registered edge, and locked writes", () => {
    const r = scan(IMPORTS + `
export interface Deps { apply(d: string): Promise<void> }
async function w(d: string) { await withSessionLock(d, () => writeSessionSync(d, { revision: 1 })); }
export const deps: Deps = { apply: w };
export async function a(d: string) { try { await w(d); } catch (e) { throw e; } }
export async function quiet(d: string) {
  let ok = true;
  try { await w(d); } catch { ok = false; livenessLog("write failed"); }
  return ok;
}
export async function soft(d: string) { try { await w(d); } catch { return failed("write failed"); } return null; }
export async function use(x: Deps, d: string) { try { await x.apply(d); } catch (e) { throw e; } }`, {
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
async function w(d: string) { await withSessionLock(d, () => writeSessionSync(d, { revision: 1 })); }
export async function a(d: string) { try { await w(d); } catch (e) { throw e; } }
export const __seamTesting = {
  run: async (d: string) => { try { await w(d); } catch (e) { throw e; } },
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
  const LOCKED = `await withSessionLock(d, () => writeSessionSync(d, { revision: 1 }))`;

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
export async function f(d: string) { try { await ow(d); } catch (e) { throw e; } }`, {}, {
      "/fx/ow.ts": IMPORTS + `export function ow(d: string): Promise<void>;
export async function ow(d: string, n?: number): Promise<void> { ${LOCKED}; }\n`,
    });
    expect(r.errors).toContain("unregistered propagating user.ts#f#catch#1");
  });

  it("a writer destructured from a dynamic import", () => {
    const r = scan(`export async function h(d: string) {
  try { const { stop } = await import("./cmd.js"); await stop(d); } catch (e) { throw e; }
}`, {}, { "/fx/cmd.ts": IMPORTS + `export async function stop(d: string) { ${LOCKED}; }\n` });
    expect(r.errors).toContain("unregistered propagating user.ts#h#catch#1");
  });

  it("a local bound to an injected writer or its default (deps.w ?? w)", () => {
    const r = scan(IMPORTS + `
async function w(d: string) { ${LOCKED}; }
export async function g(d: string, deps: { w?: (d: string) => Promise<void> }) {
  const write = deps.w ?? w;
  try { await write(d); } catch (e) { throw e; }
}`);
    expect(r.errors).toContain("unregistered propagating user.ts#g#catch#1");
    expect(r.errors).toContain("unregistered value escape user.ts#g#edge#1 (edge:w)");
  });

  it("a local bound to an inline writer arrow behind ??", () => {
    const r = scan(IMPORTS + `
export async function g(d: string, deps: { w?: (d: string) => Promise<unknown> }) {
  const write = deps.w ?? ((x: string) => withSessionLock(x, () => writeSessionSync(x, { revision: 1 })));
  try { await write(d); } catch (e) { throw e; }
}`);
    expect(r.errors).toContain("unregistered propagating user.ts#g#catch#1");
  });

  it("a writer defined inline as a deps-object member is a value escape, and its slot's call sites are reached once registered", () => {
    const core = { "/fx/core.ts": `export interface Deps { readonly norm: (d: string) => Promise<unknown> }
export async function core(d: string, deps: Deps) { try { await deps.norm(d); } catch (e) { throw e; } }\n` };
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
  const LOCKED = `await withSessionLock(d, () => writeSessionSync(d, { revision: 1 }))`;

  it("U1a: a writer closure passed to an unregistered callee is a value escape", () => {
    const r = scan(IMPORTS + `
function run(f: () => unknown) { f(); }
async function w(d: string) { ${LOCKED}; }
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
async function w(d: string) { ${LOCKED}; }
export async function a(d: string, soft: boolean) {
  let f: (d: string) => Promise<void>;
  if (soft) f = async () => {}; else f = w;
  try { await f(d); } catch (e) { throw e; }
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

  it.each([
    ["for-in", "for (f in { k: 1 }) {}", "ForInStatement"],
    ["++", "f++;", "PostfixUnaryExpression"],
  ])("U1b (R3-2): a %s write makes the use UNRESOLVED", (_n, write, kind) => {
    const r = scan(IMPORTS + `
export function a(d: string) {
  let f: (d: string) => void = () => {};
  ${write}
  try { f(d); } catch (e) { throw e; }
}`);
    expect(r.errors).toContain(`UNRESOLVED user.ts#a#f#1 (decl:${kind})`);
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
interface I { m(): Promise<void>; n(): void }
async function w(d: string) { ${LOCKED}; }
export class W implements I { async m() { await w("d"); } n() {} }
export async function run(x: I) { try { await x.m(); } catch (e) { throw e; } }
export function other(x: I) { try { x.n(); } catch (e) { throw e; } }`);
    expect(r.errors).toContain("unregistered propagating user.ts#run#catch#1");
    expect(r.errors.filter((e) => e.includes("#other#"))).toEqual([]);
  });

  it("U2: an object-literal key whose value is a writer puts its name in N", () => {
    const r = scan(IMPORTS + `
interface I { k(d: string): Promise<void> }
async function w(d: string) { ${LOCKED}; }
export const o = { k: w };
export async function run(x: I) { try { await x.k("d"); } catch (e) { throw e; } }`);
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
async function w(d: string) { ${LOCKED}; }
export function a(o: object) { Object.defineProperty(o, "m", { value: w }); }`);
    expect(r.errors).toContain("unregistered value escape user.ts#a#edge#1 (edge:w)");
  });
});

describe("ISS-958 S6 addendum: member reads (A1) and accessors (A2)", () => {
  const LOCKED = `await withSessionLock(d, () => writeSessionSync(d, { revision: 1 }))`;
  const W = IMPORTS + `
interface I { m(): Promise<void> }
async function w(d: string) { ${LOCKED}; }
class W implements I { async m() { await w("d"); } }
`;

  it("A1: a parameter binding pattern reaches the catch", () => {
    const r = scan(W + `async function run({ m }: I) { try { await m(); } catch {} }
export function go() { run(new W()); }`);
    expect(r.found.get("user.ts#run#catch#1")).toBe("contained");
  });

  it("A1: an alias of a destructured member reaches the catch", () => {
    const r = scan(W + `async function run({ m }: I) { const g = m; try { await g(); } catch (e) { throw e; } }
export function go() { run(new W()); }`);
    expect(r.errors).toContain("unregistered propagating user.ts#run#catch#1");
  });

  it("A1: a non-call property read reaches the catch", () => {
    const r = scan(W + `export async function run(x: I) { const f = x.m; try { await f(); } catch (e) { throw e; } }`);
    expect(r.errors).toContain("unregistered propagating user.ts#run#catch#1");
  });

  it("A1: an assignment pattern reaches the catch", () => {
    const r = scan(W + `export async function run(x: I) { let m: () => Promise<void>; ({ m } = x); try { await m(); } catch (e) { throw e; } }`);
    expect(r.errors).toContain("unregistered propagating user.ts#run#catch#1");
  });

  it("A1: a for-of pattern reaches the catch", () => {
    const r = scan(W + `export async function run(xs: I[]) { for (const { m } of xs) { try { await m(); } catch (e) { throw e; } } }`);
    expect(r.errors).toContain("unregistered propagating user.ts#run#catch#1");
  });

  it("S2: an assignment-form for-of pattern reaches the catch", () => {
    const r = scan(W + `export async function run(xs: I[]) { let f = async () => {}; for ({ m: f } of xs) { try { await f(); } catch (e) { throw e; } } }`);
    expect(r.errors).toContain("unregistered propagating user.ts#run#catch#1");
  });

  it.each([
    ["a nested assignment pattern", "export async function run(x: { inner: I }) { let f = async () => {}; ({ inner: { m: f } } = x); try { await f(); } catch (e) { throw e; } }"],
    ["a for-of identifier target", `export async function run() { let f: (d: string) => Promise<void> = async () => {}; for (f of [w]) { try { await f("d"); } catch (e) { throw e; } } }`],
    ["an array assignment pattern", `export async function run() { let f: (d: string) => Promise<void> = async () => {}; [f] = [w]; try { await f("d"); } catch (e) { throw e; } }`],
    ["a ??= write (R3-2)", `export async function run() { let f: ((d: string) => Promise<void>) | undefined; f ??= w; try { await f("d"); } catch (e) { throw e; } }`],
    ["a ||= write (R3-2)", `export async function run(g: ((d: string) => Promise<void>) | null) { let f = g; f ||= w; try { await f("d"); } catch (e) { throw e; } }`],
    ["a shorthand default in a pattern (R3-2)", `export async function run(o: { f?: (d: string) => Promise<void> }) { let f: ((d: string) => Promise<void>) | undefined; ({ f = w } = o); try { await f("d"); } catch (e) { throw e; } }`],
    ["a named default in a pattern (R3-2)", `export async function run(o: { g?: (d: string) => Promise<void> }) { let f: ((d: string) => Promise<void>) | undefined; ({ g: f = w } = o); try { await f("d"); } catch (e) { throw e; } }`],
  ])("S2: %s reaches the catch", (_n, code) => {
    expect(scan(W + code).errors).toContain("unregistered propagating user.ts#run#catch#1");
  });

  it("S2: a computed key in an assignment pattern is UNRESOLVED", () => {
    const r = scan(W + `export async function run(x: I, k: "m") { let f = async () => {}; ({ [k]: f } = x); try { await f(); } catch (e) { throw e; } }`);
    expect(r.errors).toContain("UNRESOLVED user.ts#run#f#1 (pattern-member)");
  });

  // S2: a rebind the scan cannot name fails closed through every route the
  // callee check follows, even when the callee's declared signature is concrete.
  it("S2: a local alias of a computed-key rebind is UNRESOLVED", () => {
    const r = scan(W + `export async function run(x: I, k: "m", h?: () => Promise<void>) { let f = async () => {}; ({ [k]: f } = x); const g = f; try { await g(); } catch (e) { throw e; } }`);
    expect(r.errors).toContain("UNRESOLVED user.ts#run#g#1 (pattern-member)");
  });

  it("S2: a ?? alias of a computed-key rebind is UNRESOLVED", () => {
    const r = scan(W + `export async function run(x: I, k: "m", h?: () => Promise<void>) { let f = async () => {}; ({ [k]: f } = x); const g = h ?? f; try { await g(); } catch (e) { throw e; } }`);
    expect(r.errors).toContain("UNRESOLVED user.ts#run#g#1 (pattern-member)");
  });

  it("S2: a || alias of a computed-key rebind is UNRESOLVED", () => {
    const r = scan(W + `export async function run(x: I, k: "m", h?: () => Promise<void>) { let f = async () => {}; ({ [k]: f } = x); const g = h || f; try { await g(); } catch (e) { throw e; } }`);
    expect(r.errors).toContain("UNRESOLVED user.ts#run#g#1 (pattern-member)");
  });

  it("S2: a && alias of a computed-key rebind is UNRESOLVED", () => {
    const r = scan(W + `export async function run(x: I, k: "m", h?: () => Promise<void>) { let f = async () => {}; ({ [k]: f } = x); const g = (h && f)!; try { await g(); } catch (e) { throw e; } }`);
    expect(r.errors).toContain("UNRESOLVED user.ts#run#g#1 (pattern-member)");
  });

  it("S2: a ?: alias of a computed-key rebind is UNRESOLVED", () => {
    const r = scan(W + `export async function run(x: I, k: "m", h?: () => Promise<void>) { let f = async () => {}; ({ [k]: f } = x); const g = k === "m" ? h! : f; try { await g(); } catch (e) { throw e; } }`);
    expect(r.errors).toContain("UNRESOLVED user.ts#run#g#1 (pattern-member)");
  });

  it("S2: a bound alias of a computed-key rebind is UNRESOLVED", () => {
    const r = scan(W + `export async function run(x: I, k: "m", h?: () => Promise<void>) { let f = async () => {}; ({ [k]: f } = x); const g = f.bind(null); try { await g(); } catch (e) { throw e; } }`);
    expect(r.errors).toContain("UNRESOLVED user.ts#run#g#1 (pattern-member)");
  });

  it("S2: an object property of a computed-key rebind is UNRESOLVED", () => {
    const r = scan(W + `export async function run(x: I, k: "m", h?: () => Promise<void>) { let f = async () => {}; ({ [k]: f } = x); const o = { m: f }; try { await o.m(); } catch (e) { throw e; } }`);
    expect(r.errors).toContain("UNRESOLVED user.ts#run#o.m#1 (pattern-member)");
  });

  it("S2: a shorthand object property of a computed-key rebind is UNRESOLVED", () => {
    const r = scan(W + `export async function run(x: I, k: "m", h?: () => Promise<void>) { let f = async () => {}; ({ [k]: f } = x); const o = { f }; try { await o.f(); } catch (e) { throw e; } }`);
    expect(r.errors).toContain("UNRESOLVED user.ts#run#o.f#1 (pattern-member)");
  });

  it("S2: an iterated array element of a computed-key rebind is UNRESOLVED", () => {
    const r = scan(W + `export async function run(x: I, k: "m", h?: () => Promise<void>) { let f = async () => {}; ({ [k]: f } = x); for (const g of [h!, f]) { try { await g(); } catch (e) { throw e; } } }`);
    expect(r.errors).toContain("UNRESOLVED user.ts#run#g#1 (pattern-member)");
  });

  it("S2: a named member of a rebound source of a computed-key rebind is UNRESOLVED", () => {
    const r = scan(W + `export async function run(x: I, k: "m", h?: () => Promise<void>) { let f = async () => {}; ({ [k]: f } = x); const src = { m: f }; let g = h!; ({ m: g } = src); try { await g(); } catch (e) { throw e; } }`);
    expect(r.errors).toContain("UNRESOLVED user.ts#run#g#1 (pattern-member)");
  });

  it("S2: a field holding a computed-key rebind is UNRESOLVED", () => {
    const r = scan(W + `export class C { f = async () => {}; async run(x: I, k: "m") { ({ [k]: this.f } = x); try { await this.f(); } catch (e) { throw e; } } }`);
    expect(r.errors).toContain("UNRESOLVED user.ts#C.run#this.f#1 (pattern-member)");
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
    const r = scan(W + `interface P { m: () => Promise<void> }
export async function run(x: P) { const f = x.m; try { await f(); } catch (e) { throw e; } }`);
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
    const r = scan(IMPORTS + `async function w(d: string) { ${LOCKED}; }
export class A { get g() { w("d"); return () => {}; } }`);
    expect(r.errors.some((e) => e.startsWith("writer-bearing accessor user.ts#A.g"))).toBe(true);
  });

  it("A2: a standalone getter read is refused", () => {
    const r = scan(IMPORTS + `async function w(d: string) { ${LOCKED}; }
export const o = { get v() { w("d"); return 1; } };
export function read() { return o.v; }`);
    expect(r.errors.some((e) => e.startsWith("writer-bearing accessor user.ts#v"))).toBe(true);
  });

  it("A2: a setter assignment is refused", () => {
    const r = scan(IMPORTS + `async function w(d: string) { ${LOCKED}; }
export class B { set s(x: number) { w("d"); } }
export function put(b: B) { b.s = 1; }`);
    expect(r.errors.some((e) => e.startsWith("writer-bearing accessor user.ts#B.s"))).toBe(true);
  });
});

describe("ISS-958 S6 addendum: the lock contract (L1, A3, A5 to A7)", () => {
  it("a clean lock program passes: awaited, returned, for-of awaited, a plain for-of write, awaited IIFE, stage dispatch", () => {
    const r = inLock(`await ctx.drainDeferrals();
    for (const i of items) { await ctx.step(i); }
    for (const i of items) { ctx.writeState({ revision: i }); }
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

  it("S3: an async closure behind a () => void local must still complete", () => {
    const body = (call: string) => `const f: () => void = async () => { await pause(); writeSessionSync(d, { revision: 1 }); };\n    ${call}`;
    const bare = lifetime(inLock(body("f();")).errors);
    expect(bare).toHaveLength(1);
    expect(bare[0]).toMatch(/^lock-lifetime: user\.ts#f called at user\.ts:\d+ is neither awaited nor returned in a contract function$/);
    expect(inLock(body("await f();")).errors).toEqual([]);
  });

  // R3-1: no callee is credited with invoking a closure synchronously, the array methods included.
  const SYNC_WRITE = "items.forEach(() => writeSessionSync(d, { revision: 1 }));";
  const lockedDirect = (r: { errors: string[] }) => r.errors.some((e) => e.startsWith("lock: writeSessionSync at user.ts:"));
  it.each([
    ["a custom forEach", "fake.forEach"],
    ["the array forEach", "items.forEach"],
  ])("R3-1: a closure passed to %s is a closure passed to a callee", (_n, callee) => {
    const FAKE = "const fake = { forEach(cb: () => void) { setTimeout(cb, 0); } };\n";
    const viaCtx = inLock(`${callee}(() => ctx.writeState({ revision: 1 }));`, FAKE);
    expect(lifetime(viaCtx.errors).some((e) => e.startsWith("lock-lifetime: context captured by a function that may run outside the lock"))).toBe(true);
    expect(lockedDirect(inLock(`${callee}(() => writeSessionSync(d, { revision: 1 }));`, FAKE))).toBe(true);
  });

  it.each([
    ["map", "const out = items.map(() => writeSessionSync(d, { revision: 1 }));"],
    ["filter", "const out = items.filter(() => writeSessionSync(d, { revision: 1 }).revision > 0);"],
    ["some", "const out = items.some(() => writeSessionSync(d, { revision: 1 }).revision > 0);"],
    ["reduce", "const out = items.reduce((a) => a + writeSessionSync(d, { revision: 1 }).revision, 0);"],
    ["sort", "items.sort(() => writeSessionSync(d, { revision: 1 }).revision);"],
  ])("R3-1: a writer closure passed to the array method %s with no src patch anywhere is refused", (_n, body) => {
    expect(lockedDirect(inLock(body))).toBe(true);
  });

  it("R3-1: a context read hoisted out of the callback passes; unhoisted it errors and names the remedy", () => {
    expect(inLock("const names = ctx.dir;\n    const out = items.map((i) => `${names}${i}`).join(\",\");").errors).toEqual([]);
    const unhoisted = lifetime(inLock("const out = items.map((i) => `${ctx.dir}${i}`).join(\",\");").errors);
    expect(unhoisted).toContainEqual(expect.stringMatching(
      /^lock-lifetime: context captured by a function that may run outside the lock at user\.ts:\d+; hoist the read out of the callback, or await the work under the lock$/));
    expect(unhoisted).toContainEqual(expect.stringMatching(
      /^lock-lifetime: contract closure at user\.ts:\d+ is passed or stored, not invoked in place; hoist the context reads out of the callback, or await the work under the lock$/));
  });

  // Codex round 3, V1 to V3 verbatim: each defeated the withdrawn credit's guard; with no credit the write is refused anyway.
  const LATER = "type Disguised = { forEach: (cb: () => void) => void };\nconst later = (cb: () => void) => { setTimeout(cb, 0); };\n";
  it.each([
    ["V1 a property holding the array", "export function patch(items: number[]) { const box = { value: items as unknown as Disguised }; box.value.forEach = later; }\n"],
    ["V1 an arrow returning the array", "export function patch(items: number[]) { const get = () => items as unknown as Disguised; get().forEach = later; }\n"],
    ["V2 an assignment-form loop", "export function patch(items: number[]) { const delayed: number[][\"forEach\"] = (cb) => { setTimeout(() => cb(1, 0, items), 0); }; for (items.forEach of [delayed]) {} }\n"],
    ["V3 an aliased Object.assign", "export function patch(items: number[]) { const assign = Object.assign; assign(items, { forEach: later }); }\n"],
  ])("R3-1: %s that replaces forEach: the forEach write is refused", (_n, top) => {
    expect(lockedDirect(inLock(SYNC_WRITE, LATER + top))).toBe(true);
  });

  // T4: suspension is not read from an erased signature.
  const ASYNC_BODY = "{ await pause(); writeSessionSync(d, { revision: 1 }); }";
  it("T4: a contract callee whose overload is void and whose implementation is async must complete", () => {
    const top = "function w(ctx: StageContext): void;\nasync function w(ctx: StageContext) { await pause(); ctx.writeState({ revision: 1 }); }\n";
    expect(lifetime(inLock("w(ctx);", top).errors)).toEqual([
      expect.stringMatching(/^lock-lifetime: user\.ts#w called at user\.ts:\d+ is neither awaited nor returned in a contract function$/),
    ]);
    expect(inLock("await w(ctx);", top).errors).toEqual([]);
  });

  it("T4: Codex's overload counterexample: a local writer that is no contract function is refused at its write", () => {
    const r = inLock(`function w(): void;\n    async function w() ${ASYNC_BODY}\n    w();`);
    expect(r.errors).toEqual([expect.stringMatching(/^lock: writeSessionSync at user\.ts:\d+ is not inside withSessionLock or a lock-held function$/)]);
  });

  it.each([
    ["as", `((async () => ${ASYNC_BODY}) as () => void)();`],
    ["an angle-bracket assertion", `(<() => void>(async () => ${ASYNC_BODY}))();`],
  ])("T4: an async closure cast to () => void through %s and called must complete", (_n, body) => {
    expect(lifetime(inLock(body).errors).some((e) => e.includes("called at user.ts:") && e.endsWith("is neither awaited nor returned in a contract function"))).toBe(true);
  });

  // A1: a bodyless interface member resolves to every src provider, each scanned as an ordinary callee.
  const TYPES_SKIP = TYPES.replace("export interface WorkflowStage { enter(ctx: StageContext): Promise<void> }",
    "export interface WorkflowStage { enter(ctx: StageContext): Promise<void>; skip?(ctx: StageContext): void }");
  const inLockSkip = (body: string, top: string) => lockScan(LOCK_IMPORTS + top + `
export async function run(d: string, items: number[], stage: WorkflowStage) {
  await withSessionLock(d, async () => {
    const ctx = new StageContext(d);
    ${body}
  });
}`, { contextConstructions: ["user.ts#run#new#1"] }, { "/fx/types.ts": TYPES_SKIP });
  const SKIP_SYNC = "export class A implements WorkflowStage { async enter(ctx: StageContext) {} skip(ctx: StageContext) { ctx.writeState({ revision: 1 }); } }\n"
    + "export class B implements WorkflowStage { async enter(ctx: StageContext) {} skip(ctx: StageContext): void {} }\n";

  // R4-3 / R4-2 pen ruling: a type is A1-sensitive only as an owner whose providers the scan enumerated.
  const R4_ASSERTED = /^UNRESOLVED assertion at user\.ts:\d+ \(asserted into a sensitive type\)$/;
  const PLAIN = "export interface Plain { f(): void }\nexport const p = JSON.parse(\"{}\") as Plain;\n";
  it("R4-3: an assertion into an interface the scan resolves no provider for passes, though it has a callable member", () => {
    expect(inLockSkip("stage.skip?.(ctx);", SKIP_SYNC + PLAIN).errors.filter((e) => R4_ASSERTED.test(e))).toEqual([]);
  });
  it("R4-3: an assertion into a resolved owner (WorkflowStage) is UNRESOLVED", () => {
    const r = inLockSkip("stage.skip?.(ctx);", SKIP_SYNC + "export const forged = JSON.parse(\"{}\") as WorkflowStage;\n");
    expect(r.errors.filter((e) => R4_ASSERTED.test(e))).toHaveLength(1);
  });
  it("R4-2: a Proxy over a type the scan resolves no provider for, with a get trap, passes", () => {
    const r = inLockSkip("stage.skip?.(ctx);", SKIP_SYNC + PLAIN + "export const q = new Proxy(p, { get() { return () => {}; } });\n");
    expect(r.errors.filter((e) => e.startsWith("UNRESOLVED Proxy at"))).toEqual([]);
  });
  const skipLifetime = (r: { errors: string[] }) => lifetime(r.errors).filter((e) =>
    /^lock-lifetime: WorkflowStage\.skip called at user\.ts:\d+ is neither awaited nor returned in a contract function$/.test(e));
  it("A1: synchronous providers only: the call passes and the providers are listed by file and line", () => {
    const r = inLockSkip("stage.skip?.(ctx);", SKIP_SYNC);
    expect(r.errors).toEqual([]);
    expect(r.memberProviders["types.ts#WorkflowStage.skip"]).toEqual([expect.stringMatching(/^user\.ts:\d+$/), expect.stringMatching(/^user\.ts:\d+$/)]);
  });

  it.each([
    ["a class method", "export class C implements WorkflowStage { async enter(ctx: StageContext) {} async skip(ctx: StageContext) { await pause(); ctx.writeState({ revision: 2 }); } }\n"],
    ["a typed object literal", "export const C: WorkflowStage = { enter: async () => {}, async skip(ctx: StageContext) { await pause(); ctx.writeState({ revision: 2 }); } };\n"],
    ["a property assignment", "export function patch(s: WorkflowStage) { s.skip = async (ctx: StageContext) => { await pause(); ctx.writeState({ revision: 2 }); }; }\n"],
  ])("A1: one detaching provider among several, %s, is caught at the call site", (_n, extra) => {
    expect(skipLifetime(inLockSkip("stage.skip?.(ctx);", SKIP_SYNC + extra))).toHaveLength(1);
  });

  it("A1: a provider supplied through an assertion is UNRESOLVED and the call may suspend", () => {
    const r = inLockSkip("stage.skip?.(ctx);", SKIP_SYNC + "export const C = { enter: async (ctx: StageContext) => {}, skip: (ctx: StageContext) => {} } as WorkflowStage;\n");
    expect(r.errors.some((e) => /^UNRESOLVED provider types\.ts#WorkflowStage\.skip at user\.ts:\d+ \(asserted provider\)$/.test(e))).toBe(true);
    expect(skipLifetime(r)).toHaveLength(1);
  });

  it("A1: a member with no provider in src may suspend", () => {
    expect(skipLifetime(inLockSkip("stage.skip?.(ctx);", ""))).toHaveLength(1);
  });

  // R3-2: provider discovery reads the one write enumerator.
  const DETACH = "async (ctx: StageContext) => { await pause(); ctx.writeState({ revision: 2 }); }";
  it.each([
    ["an assignment-form for-of initializer", `export function patch(s: WorkflowStage) { for (s.skip of [${DETACH}]) {} }\n`],
    ["a compound ??= write", `export function patch(s: WorkflowStage) { s.skip ??= ${DETACH}; }\n`],
    ["a destructuring assignment", `export function patch(s: WorkflowStage) { ({ f: s.skip } = { f: ${DETACH} }); }\n`],
    ["a nested destructuring assignment", `export function patch(s: WorkflowStage) { ({ a: [s.skip] } = { a: [${DETACH}] }); }\n`],
    ["an aliased Object.assign", `export function patch(s: WorkflowStage) { const assign = Object.assign; assign(s, { skip: ${DETACH} }); }\n`],
    ["a destructured copy of Object.assign", `export function patch(s: WorkflowStage) { const { assign: put } = Object; put(s, { skip: ${DETACH} }); }\n`],
  ])("R3-2: a detaching provider supplied through %s is caught at the call site", (_n, extra) => {
    expect(skipLifetime(inLockSkip("stage.skip?.(ctx);", SKIP_SYNC + extra))).toHaveLength(1);
  });

  it("R3-2 (Codex V5 verbatim): a provider assigned by a for-of over a named closure is UNRESOLVED and the call may suspend", () => {
    const r = inLockSkip("stage.skip?.(ctx);", SKIP_SYNC + `const later = ${DETACH};\nexport function patch() { const stage: WorkflowStage = new A(); for (stage.skip of [later]) {} }\n`);
    expect(r.errors.some((e) => /^UNRESOLVED provider types\.ts#WorkflowStage\.skip at user\.ts:\d+ \(provider without a body in src\)$/.test(e))).toBe(true);
    expect(skipLifetime(r)).toHaveLength(1);
  });

  it.each([
    ["++", "s.skip++;"],
    ["--", "--s.skip;"],
    ["delete", "delete s.skip;"],
    ["+=", "s.skip += 1;"],
  ])("R3-2: a %s write to a provider member is UNRESOLVED", (form, stmt) => {
    const r = inLockSkip("stage.skip?.(ctx);", SKIP_SYNC + `export function patch(s: WorkflowStage) { ${stmt} }\n`);
    expect(r.errors).toContainEqual(expect.stringMatching(new RegExp(`^UNRESOLVED provider types\\.ts#WorkflowStage\\.skip at user\\.ts:\\d+ \\(${form.replace(/[+]/g, "\\+")} write\\)$`)));
    expect(skipLifetime(r)).toHaveLength(1);
  });

  it("R3-2: a reflective write on a stage with no literal source is UNRESOLVED", () => {
    const r = inLockSkip("stage.skip?.(ctx);", SKIP_SYNC + "export function patch(s: WorkflowStage) { Reflect.set(s, \"skip\", 1); }\n");
    expect(r.errors.some((e) => /^UNRESOLVED provider types\.ts#WorkflowStage\.skip at user\.ts:\d+ \(reflective write\)$/.test(e))).toBe(true);
  });

  // A2: a guarded test-seam slot behind a local default is credited synchronous; a src supply is refused.
  const TAKEOVER = `export interface TDeps { readonly writeState?: (s: { revision: number }) => { revision: number } }\n`;
  const SEAM_BODY = (deps: string) => `const deps: TDeps = ${deps};
    const writeState = deps.writeState ?? ((s: { revision: number }) => { ctx.writeState(s); return s; });
    writeState({ revision: 1 });`;
  const SEAM_REG = { testSeamSlots: { "user.ts#TDeps.writeState": "tests only" }, edges: { "user.ts#x#edge#1": "user.ts#TDeps.writeState" } };
  it("A2: an unsupplied writeState seam passes as a test-seam slot and fails closed unregistered", () => {
    const r = inLock(SEAM_BODY("{}"), TAKEOVER, SEAM_REG);
    expect(lifetime(r.errors)).toEqual([]);
    expect(r.errors.some((e) => e.includes("test-seam slot"))).toBe(false);
    expect(lifetime(inLock(SEAM_BODY("{}"), TAKEOVER).errors)).toEqual([
      expect.stringMatching(/ called at user\.ts:\d+ is neither awaited nor returned in a contract function$/),
    ]);
  });

  it("A2: a writeState provider in src that detaches is caught", () => {
    const r = inLock(SEAM_BODY("{ writeState: (s) => { void (async () => { await pause(); ctx.writeState(s); })(); return s; } }"), TAKEOVER, SEAM_REG);
    expect(r.errors.some((e) => /^test-seam slot user\.ts#TDeps\.writeState is supplied in src at user\.ts:\d+$/.test(e))).toBe(true);
  });

  it("T4: an async closure returned by a getter and called under the lock is refused at its write", () => {
    const r = inLock(`const o = { get w() { return async () => ${ASYNC_BODY}; } };\n    o.w();`);
    expect(r.errors.some((e) => /^lock: writeSessionSync at user\.ts:\d+ is not inside withSessionLock or a lock-held function$/.test(e))).toBe(true);
  });

  it("T4: a callee the scan cannot resolve is held to the completion form under the lock", () => {
    const r = inLock(`const g = async () => ${ASYNC_BODY};\n    (g.bind(null) as () => void)();`);
    expect(lifetime(r.errors).some((e) => e.startsWith("lock-lifetime: <unresolved callee g.bind(null)> called at user.ts:"))).toBe(true);
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

  it.each([
    ["??= to a module binding", "saved ??= ctx;", "let saved: StageContext | undefined;\n", "stored to a module-level binding"],
    ["||= to a field", "holder.c ||= ctx;", "const holder: { c?: StageContext } = {};\n", "stored to a field or a container"],
    ["the source of a destructuring assignment", "let dir = \"\";\n    ({ dir } = ctx);", "", "stored to a field or a container"],
  ])("A3b (R3-2): the context written by %s is refused", (_n, body, top, why) => {
    expect(lifetime(inLock(body, top).errors).some((e) => e.includes(why))).toBe(true);
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

  it("S4: a context returned out of the lock callback, and a context-holding function called outside the lock, are refused", () => {
    const r = lockScan(LOCK_IMPORTS + `
function helper(ctx: StageContext) { ctx.writeState({ revision: 1 }); }
export async function run(d: string, stage: WorkflowStage) {
  const ctx = await withSessionLock(d, () => new StageContext(d));
  helper(ctx);
  await stage.enter(ctx);
}`, { contextConstructions: ["user.ts#run#new#1"] });
    expect(lifetime(r.errors).some((e) => e.includes("returned across the lock-entry boundary"))).toBe(true);
    expect(r.errors.some((e) => e.startsWith("lock: context-holding function user.ts#helper called at user.ts:") && e.includes("from user.ts#run,"))).toBe(true);
    expect(r.errors.some((e) => e.startsWith("lock: context-holding function WorkflowStage.enter called at user.ts:"))).toBe(true);
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

describe("ISS-958 S7: the lock entry's release is the one tied to its acquisition", () => {
  const BODY = "  const release = acquire(dir);\n  try { return await fn(); } finally { release(); }\n";
  const entryScan = (body: string) => {
    expect(SESSION).toContain(BODY);
    const program = inMemoryProgram({ "/fx/session.ts": SESSION.replace(BODY, body), "/fx/user.ts": "export {};\n" });
    return scanStateWrites(program, { base: "/fx", rootFile: ROOT_FILE, rootName: "writeSessionSync", lockName: "withSessionLock", registry: EMPTY });
  };
  const entryErrors = (body: string) => entryScan(body).errors.filter((e) => e.startsWith("lock-lifetime: lock entry"));

  it("the fixture shape and the production shape (a let acquired inside the try, released under a presence test) pass", () => {
    expect(entryErrors(BODY)).toEqual([]);
    expect(entryErrors(`  let release: (() => void) | undefined;
  try { release = acquire(dir); return await fn(); } finally { if (release) { try { release(); } catch { /* ignore */ } } }
`)).toEqual([]);
  });

  it("a release called before the callback, with an unrelated call in the finally, fails", () => {
    expect(entryErrors(`  const release = acquire(dir);
  try { release(); return await fn(); } finally { livenessLog("done"); }
`)).toEqual(["lock-lifetime: lock entry session.ts#withSessionLock does not release in the finally of the try that awaits its callback"]);
  });

  it("the finally release replaced by an unrelated call fails", () => {
    expect(entryErrors(`  const release = acquire(dir);
  try { return await fn(); } finally { livenessLog("released"); }
`)).toEqual(["lock-lifetime: lock entry session.ts#withSessionLock does not release in the finally of the try that awaits its callback"]);
  });

  it("a release also called early, or passed on, fails", () => {
    const early = entryErrors(`  const release = acquire(dir);
  try { release(); return await fn(); } finally { release(); }
`);
    expect(early).toHaveLength(1);
    expect(early[0]).toMatch(/^lock-lifetime: lock entry session\.ts#withSessionLock uses its release release outside the finally at session\.ts:/);
    const passed = entryErrors(`  const release = acquire(dir);
  setTimeout(release, 0);
  try { return await fn(); } finally { release(); }
`);
    expect(passed).toHaveLength(1);
    expect(passed[0]).toContain("uses its release release outside the finally");
  });

  it("T2: a second acquisition, with the session lock released early and the other released in the finally, fails", () => {
    expect(entryErrors(`  const release = acquire(dir);
  const cleanup = acquire("other");
  release();
  try { return await fn(); } finally { cleanup(); }
`)).toEqual(["lock-lifetime: lock entry session.ts#withSessionLock must make exactly one acquisition before its callback, found 2"]);
  });

  it("T2: a lock target not derived from the entry's parameters fails", () => {
    const e = entryErrors(`  const release = acquire("other");
  try { return await fn(); } finally { release(); }
`);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatch(/^lock-lifetime: lock entry session\.ts#withSessionLock acquires a lock target not derived from its parameters at session\.ts:/);
  });

  it("T2: a pinned acquisition is taken by that callee only", () => {
    const pinned = (body: string) => {
      const program = inMemoryProgram({ "/fx/session.ts": SESSION.replace(BODY, body), "/fx/user.ts": "export {};\n" });
      return scanStateWrites(program, { base: "/fx", rootFile: ROOT_FILE, rootName: "writeSessionSync", lockName: "withSessionLock", registry: EMPTY,
        lockAcquisitions: { "session.ts#withSessionLock": { module: "session.ts", name: "acquire" } } }).errors.filter((x) => x.startsWith("lock-lifetime: lock entry"));
    };
    expect(pinned(BODY)).toEqual([]);
    const other = pinned("  const take = (p: string) => acquire(p);\n  const release = take(dir);\n  try { return await fn(); } finally { release(); }\n");
    expect(other).toHaveLength(1);
    expect(other[0]).toMatch(/^lock-lifetime: lock entry session\.ts#withSessionLock acquires by take at session\.ts:\d+, not the pinned session\.ts#acquire$/);
  });

  it("a release that is not the acquisition's result fails", () => {
    expect(entryErrors(`  acquire(dir);
  const release = () => {};
  try { return await fn(); } finally { release(); }
`)).toEqual(["lock-lifetime: lock entry session.ts#withSessionLock does not release in the finally of the try that awaits its callback"]);
  });

  // R3-2, self-found: the release identity read only `=` writes, so a loop or logical write replaced the release unseen.
  it.each([
    ["an assignment-form for-of", "  let release = acquire(dir);\n  for (release of [() => {}]) {}\n  try { return await fn(); } finally { release(); }\n"],
    ["??=", "  let release: (() => void) | undefined = acquire(dir);\n  release ??= () => {};\n  try { return await fn(); } finally { release(); }\n"],
    ["a destructuring assignment", "  let release = acquire(dir);\n  [release] = [() => {}];\n  try { return await fn(); } finally { release(); }\n"],
  ])("a release replaced by %s is not the acquisition", (_n, body) => {
    expect(entryErrors(body)).toEqual(["lock-lifetime: lock entry session.ts#withSessionLock does not release in the finally of the try that awaits its callback"]);
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

describe("ISS-958 S6 fixup: a guarded slot's provider is checked wherever it flows", () => {
  const TOP = `export interface Deps { withLockX?: (fn: () => Promise<void>) => Promise<void> }
export async function take(d: string, ctx: StageContext, deps: Deps) {
  const under = deps.withLockX ?? (async (fn: () => Promise<void>) => { await withProjectLock(d, async () => fn()); });
  await under(async () => { ctx.writeState({ revision: 1 }); });
}
`;
  const LISTED = { ...PRIM, injectedCallbackSlots: { "user.ts#Deps.withLockX": "tests only" } };
  const supplied = (r: { errors: string[] }) =>
    r.errors.filter((e) => e.startsWith("injected awaited-callback slot user.ts#Deps.withLockX is supplied in src at"));

  it.each([
    ["an inferred provider passed as the dependency", "const provider = { withLockX: async (fn: () => Promise<void>) => { void fn(); } };\n    await take(d, ctx, provider);"],
    ["a property assignment", "const deps: Deps = {};\n    deps.withLockX = async (fn) => { void fn(); };\n    await take(d, ctx, deps);"],
    ["a spread", "const extra = { withLockX: async (fn: () => Promise<void>) => { void fn(); } };\n    await take(d, ctx, { ...extra });"],
  ])("%s is a supply", (_n, body) => {
    expect(supplied(add2Scan(body, TOP, LISTED))).toHaveLength(1);
  });

  // T5: computed, accessor and spread members, element-access, destructuring and reflective writes.
  const P = "async (fn: () => Promise<void>) => { void fn(); }";
  const mayBe = (r: { errors: string[] }, why: string) =>
    r.errors.filter((e) => e.startsWith("injected awaited-callback slot user.ts#Deps.withLockX may be supplied in src at") && e.endsWith(`(${why})`));
  it.each([
    ["a constant computed key", `const deps: Deps = { ["withLockX"]: ${P} };\n    await take(d, ctx, deps);`],
    ["a computed method", "const deps: Deps = { [\"withLockX\"](fn: () => Promise<void>) { void fn(); return Promise.resolve(); } };\n    await take(d, ctx, deps);"],
    ["a getter", `const deps: Deps = { get withLockX() { return ${P}; } };\n    await take(d, ctx, deps);`],
    ["a spread literal", `await take(d, ctx, { ...{ withLockX: ${P} } });`],
    ["a constant element-access write", `const deps: Deps = {};\n    deps["withLockX"] = ${P};\n    await take(d, ctx, deps);`],
    ["a destructuring-assignment target", `const deps: Deps = {};\n    const src = { p: ${P} };\n    ({ p: deps.withLockX } = src);\n    await take(d, ctx, deps);`],
    ["a class instance", `class Impl { async withLockX(fn: () => Promise<void>) { void fn(); } }\n    await take(d, ctx, new Impl());`],
  ])("T5: %s is a supply", (_n, body) => {
    expect(supplied(add2Scan(body, TOP, LISTED))).toHaveLength(1);
  });

  it("T5: a computed key the checker cannot reduce may supply the slot", () => {
    expect(mayBe(add2Scan(`const k: string = "withLockX";\n    const deps: Deps = { [k]: ${P} };\n    await take(d, ctx, deps);`, TOP, LISTED), "computed key")).toHaveLength(1);
    expect(mayBe(add2Scan(`const deps: Deps = {};\n    const k: string = "withLockX";\n    (deps as Deps & Record<string, unknown>)[k] = 1;\n    await take(d, ctx, deps);`, TOP, LISTED), "computed key")).toHaveLength(1);
  });

  it.each([
    ["Object.assign", `const deps: Deps = {};\n    Object.assign(deps, { withLockX: ${P} });\n    await take(d, ctx, deps);`],
    ["Object.defineProperty", "const deps: Deps = {};\n    Object.defineProperty(deps, \"withLockX\", { value: 1 });\n    await take(d, ctx, deps);"],
  ])("T5: %s on the dependency may supply the slot", (_n, body) => {
    expect(mayBe(add2Scan(body, TOP, LISTED), "reflective write")).toHaveLength(1);
  });

  // R3-2: one fixture per write form the enumerator covers. Each body writes the slot once and passes the dependency on.
  const SLOT_FORMS: Array<[string, string]> = [
    ["=", `deps.withLockX = ${P};`],
    ["+= (an arithmetic compound)", "deps.withLockX += 1;"],
    ["??=", `deps.withLockX ??= ${P};`],
    ["||=", `deps.withLockX ||= ${P};`],
    ["&&=", `deps.withLockX &&= ${P};`],
    ["object destructuring", `({ p: deps.withLockX } = { p: ${P} });`],
    ["array destructuring", `[deps.withLockX] = [${P}];`],
    ["nested destructuring", `({ a: { p: deps.withLockX } } = { a: { p: ${P} } });`],
    ["a destructuring default", `({ p: deps.withLockX = ${P} } = {});`],
    ["an object rest", "({ ...deps.withLockX } = { q: 1 });"],
    ["an array rest", "[...deps.withLockX] = [1];"],
    ["an assignment-form for-of (Codex V4 verbatim)", `const detach = ${P};\n    for (deps.withLockX of [detach]) {}`],
    ["an assignment-form for-of pattern", `for ({ p: deps.withLockX } of [{ p: ${P} }]) {}`],
    ["an assignment-form for-in", "for (deps.withLockX in { k: 1 }) {}"],
    ["postfix ++", "deps.withLockX++;"],
    ["prefix --", "--deps.withLockX;"],
    ["delete", "delete deps.withLockX;"],
    ["a whole-object assignment", `deps = { withLockX: ${P} };`],
    ["a whole-object ??=", `let other: Deps | undefined;\n    other ??= { withLockX: ${P} };\n    deps = other;`],
  ];
  it.each(SLOT_FORMS)("R3-2: a %s write is a supply", (_n, write) => {
    expect(supplied(add2Scan(`let deps: Deps = {};\n    ${write}\n    await take(d, ctx, deps);`, TOP, LISTED))).toHaveLength(1);
  });

  const unresolvedRef = (r: { errors: string[] }, fn: string) =>
    r.errors.filter((e) => e.startsWith(`UNRESOLVED reflective writer reference ${fn} at user.ts:`));
  it.each([
    ["Object.defineProperties", "Object.defineProperties(deps, { withLockX: { value: 1 } });"],
    ["Object.setPrototypeOf", `Object.setPrototypeOf(deps, { withLockX: ${P} });`],
    ["Reflect.set", "Reflect.set(deps, \"withLockX\", 1);"],
    ["Reflect.defineProperty", "Reflect.defineProperty(deps, \"withLockX\", { value: 1 });"],
    ["Reflect.setPrototypeOf", `Reflect.setPrototypeOf(deps, { withLockX: ${P} });`],
    ["__proto__", `deps.__proto__ = { withLockX: ${P} };`],
    ["__defineGetter__", "deps.__defineGetter__(\"withLockX\", () => 1);"],
  ])("R3-2: %s on the dependency may supply the slot", (_n, write) => {
    const r = add2Scan(`const deps: Deps = {};\n    ${write}\n    await take(d, ctx, deps);`, TOP, LISTED);
    expect(mayBe(r, "reflective write")).toHaveLength(1);
    expect(r.errors.filter((e) => e.startsWith("UNRESOLVED reflective"))).toEqual([]);
  });

  it.each([
    ["an alias", "const assign = Object.assign;\n    assign(deps, { withLockX: 1 });", "Object.assign"],
    ["a destructured copy", "const { defineProperty: def } = Object;\n    def(deps, \"withLockX\", { value: 1 });", "Object.defineProperty"],
    ["a destructuring-assignment copy", "let set: typeof Reflect.set;\n    ({ set } = Reflect);\n    set(deps, \"withLockX\", 1);", "Reflect.set"],
    ["a renamed destructuring-assignment copy", "let put: typeof Object.assign;\n    ({ assign: put } = Object);\n    put(deps, { withLockX: 1 });", "Object.assign"],
  ])("R3-2: a reflective writer reached through %s is resolved by identity: the call may supply, the copy is UNRESOLVED", (_n, write, fn) => {
    const r = add2Scan(`const deps: Deps = {};\n    ${write}\n    await take(d, ctx, deps);`, TOP, LISTED);
    expect(mayBe(r, "reflective write")).toHaveLength(1);
    expect(unresolvedRef(r, fn).length).toBeGreaterThan(0);
  });

  it.each([
    ["stored in an array", "const fns = [Object.assign];", "Object.assign"],
    ["passed on", "const call = (f: unknown) => f;\n    call(Reflect.defineProperty);", "Reflect.defineProperty"],
    ["bound", "const b = Object.setPrototypeOf.bind(null);", "Object.setPrototypeOf"],
    ["returned", "const get = () => Object.defineProperties;", "Object.defineProperties"],
    ["copied to a local with its own type", "const put: (o: object, ...s: object[]) => object = Object.assign;", "Object.assign"],
  ])("R3-2: a reflective writer %s, not called, is UNRESOLVED program-wide", (_n, stmt, fn) => {
    expect(unresolvedRef(add2Scan(stmt), fn).length).toBeGreaterThan(0);
  });

  // R4-1 (Codex round 4, W1): a prototype write supplies the slot in every form, judged by its target.
  const TOP_PROTO = TOP.replace("withLockX?:", "__proto__?: object; withLockX?:");
  const PROTO = `{ withLockX: ${P} }`;
  it.each([
    ["a literal element key (W1 verbatim)", `deps["__proto__"] = ${PROTO};`],
    ["a destructuring target (W1 verbatim)", `({ p: deps.__proto__ } = { p: ${PROTO} });`],
    ["a loop target", `for (deps.__proto__ of [${PROTO}]) {}`],
    ["a constant key", `const k = "__proto__";\n    deps[k] = ${PROTO};`],
    ["a ??= write", `deps.__proto__ ??= ${PROTO};`],
    ["Reflect.set with the key", `Reflect.set(deps, "__proto__", ${PROTO});`],
  ])("R4-1: a prototype write through %s may supply the slot", (_n, write) => {
    expect(mayBe(add2Scan(`const deps: Deps = {};\n    ${write}\n    await take(d, ctx, deps);`, TOP_PROTO, LISTED), "reflective write")).toHaveLength(1);
  });

  const protoUnknown = (r: { errors: string[] }) =>
    r.errors.filter((e) => /^UNRESOLVED prototype mutation at user\.ts:\d+ \(computed key on a sensitive type\)$/.test(e));
  it("R4-1: a computed key the checker cannot reduce is UNRESOLVED on a sensitive receiver and silent on another", () => {
    expect(protoUnknown(add2Scan(`const deps: Deps = {};\n    const k: string = JSON.parse("\\"__proto__\\"");\n    deps[k] = ${PROTO};\n    await take(d, ctx, deps);`, TOP, LISTED))).toHaveLength(1);
    expect(protoUnknown(add2Scan("const m: Record<string, number> = {};\n    const k: string = JSON.parse(\"\\\"a\\\"\");\n    m[k] = 1;", TOP, LISTED))).toEqual([]);
  });

  it("R4-1: a literal-typed key is reduced: a union is read member by member and a symbol is never __proto__", () => {
    const at = (write: string) => add2Scan(`const deps: Deps = {};\n    ${write}\n    await take(d, ctx, deps);`, TOP_PROTO, LISTED);
    const without = at("const put = (k: \"a\" | \"b\") => { deps[k] = 1; };\n    put(\"a\");");
    expect(protoUnknown(without)).toEqual([]);
    expect(mayBe(without, "reflective write")).toEqual([]);
    expect(mayBe(at(`const put = (k: "a" | "__proto__") => { deps[k] = ${PROTO}; };\n    put("a");`), "reflective write")).toHaveLength(1);
    const sym = at("const K = Symbol(\"k\");\n    deps[K] = 1;");
    expect(protoUnknown(sym)).toEqual([]);
    expect(mayBe(sym, "reflective write")).toEqual([]);
  });

  // R4-2 (W2): a proxy is judged by its own static result type, so a later flow into Deps is caught where it is built.
  const proxyWhy = (r: { errors: string[] }) =>
    r.errors.filter((e) => /^UNRESOLVED Proxy at user\.ts:\d+ \(target, flow or result type owns a guarded, provider, contract or lock member, or is untyped\)$/.test(e));
  const DETACH_PROXY = `new Proxy({}, { get() { return detach; } })`;
  it.each([
    ["assigned to a typed local (W2 verbatim)", `const detach = ${P};\n    const proxy = ${DETACH_PROXY};\n    const deps: Deps = proxy;\n    await take(d, ctx, deps);`],
    ["assigned later", `const detach = ${P};\n    let deps: Deps = {};\n    const proxy = ${DETACH_PROXY};\n    deps = proxy;\n    await take(d, ctx, deps);`],
    ["returned from a function", `const detach = ${P};\n    const mk = () => ${DETACH_PROXY};\n    await take(d, ctx, mk());`],
  ])("R4-2: a proxy %s is UNRESOLVED at its construction", (_n, body) => {
    expect(proxyWhy(add2Scan(body, TOP, LISTED))).toHaveLength(1);
  });

  // R4-3: an assertion into a sensitive type, from another type, is the same hole by another route.
  const asserted = (r: { errors: string[] }) =>
    r.errors.filter((e) => /^UNRESOLVED assertion at user\.ts:\d+ \(asserted into a sensitive type\)$/.test(e));
  it.each([
    ["JSON.parse as Deps", "const deps = JSON.parse(\"{}\") as Deps;\n    await take(d, ctx, deps);"],
    ["a double as", "const x: object = {};\n    const deps = x as unknown as Deps;\n    await take(d, ctx, deps);"],
    ["an angle-bracket assertion", "const x: object = {};\n    const deps = <Deps>x;\n    await take(d, ctx, deps);"],
    ["an assertion inside a return", "const mk = (x: object) => { return x as Deps; };\n    await take(d, ctx, mk({}));"],
    ["an assertion into Deps[]", "const x: object[] = [];\n    const all = x as Deps[];\n    await take(d, ctx, all[0]!);"],
    ["an assertion into a union holding Deps", "const x: object = {};\n    const one = x as Deps | undefined;\n    if (one) await take(d, ctx, one);"],
  ])("R4-3: %s is UNRESOLVED", (_n, body) => {
    expect(asserted(add2Scan(body, TOP, LISTED))).toHaveLength(1);
  });

  it("R4-3: a same-type assertion, as const, a non-null assertion and satisfies are not assertions into a sensitive type", () => {
    const r = add2Scan("const a: Deps = {};\n    const b = a as Deps;\n    const c = { n: 1 } as const;\n    const e: Deps | undefined = a;\n    const f = e!;\n    const s = {} satisfies Deps;\n    await take(d, ctx, b);\n    void c; void f; void s;", TOP, LISTED);
    expect(asserted(r)).toEqual([]);
  });

  it("forwarding the dependency it was given is not a supply; an untyped provider fails closed", () => {
    const fwd = TOP + "export async function relay(d: string, ctx: StageContext, deps: Deps) { await take(d, ctx, deps); }\n";
    expect(add2Scan("await relay(d, ctx, {});", fwd, LISTED).errors).toEqual([]);
    const untyped = add2Scan(`await take(d, ctx, JSON.parse("{}"));`, TOP, LISTED);
    expect(untyped.errors.some((e) => e.startsWith("injected awaited-callback slot user.ts#Deps.withLockX may be supplied in src at")
      && e.endsWith("(untyped provider)"))).toBe(true);
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

  it("R-b: a direct call does not license another, non-call reference (the RB mutant survived at 9387b32c)", () => {
    const r = add2Scan(`const publish = (n: number) => { ctx.writeState({ revision: n }); };
    publish(1);
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

  const LEAF = "async () => { await withSessionLock(d, () => writeSessionSync(d, { revision: 1 })); return 1; }";
  const chainCode = (outerBody: string, innerBody = "return await als.run(1, fn);", entry = `await outer(${LEAF});`) => IMPORTS + `import { AsyncLocalStorage } from "node:async_hooks";
const als = new AsyncLocalStorage<number>();
const alsFn = new AsyncLocalStorage<() => Promise<number>>();
async function inner(fn: () => Promise<number>): Promise<number> { ${innerBody} }
async function outer(fn: () => Promise<number>): Promise<number> { ${outerBody} }
async function other(fn: () => Promise<number>): Promise<number> { return await outer(fn); }
export async function go(d: string) { ${entry} }`;
  const CHAIN = {
    edges: { "user.ts#go#edge#1": "outer -> inner -> AsyncLocalStorage.run(callback)" },
    unfollowedSinkChains: { "user.ts#go#edge#1": [{ fn: "user.ts#outer", param: "fn" }, { fn: "user.ts#inner", param: "fn" }] },
  };
  const ALS = { "/fx/als.d.ts": NODE_ALS };
  const chainErrors = (r: { errors: string[] }) => r.errors.filter((e) => e.startsWith("unfollowed sink chain"));
  const GOOD_OUTER = "const v = await inner(async () => fn()); return v;";

  it("a verified chain passes, its leaf writing under the awaited session lock", () => {
    expect(scan(chainCode(GOOD_OUTER), CHAIN, ALS).errors).toEqual([]);
  });

  it("a catch around the forward fails", () => {
    const r = scan(chainCode("try { return await inner(async () => fn()); } catch { return 0; }"), CHAIN, ALS);
    expect(chainErrors(r).some((e) => e.includes("a catch at user.ts:") && e.includes("encloses fn in user.ts#outer"))).toBe(true);
  });

  it("a hop that neither awaits nor returns fails, and a hop forwarding elsewhere fails", () => {
    const voided = scan(chainCode("void inner(async () => fn()); return 0;"), CHAIN, ALS);
    expect(chainErrors(voided).some((e) => e.includes("does not await or return"))).toBe(true);
    const elsewhere = scan(chainCode("return await fn();"), CHAIN, ALS);
    expect(chainErrors(elsewhere).some((e) => e.includes("forwards fn to fn, not user.ts#inner(fn)"))).toBe(true);
  });

  it("S8: a return overridden by a finally is not completion", () => {
    const r = scan(chainCode("try { return inner(async () => fn()); } finally { void 0; }"), CHAIN, ALS);
    expect(chainErrors(r)).toEqual([expect.stringMatching(/^unfollowed sink chain user\.ts#go#edge#1: user\.ts#outer does not await or return the call that uses fn at user\.ts:/)]);
  });

  it("S8: the terminal hop must hand the callback to AsyncLocalStorage.run in its callback slot", () => {
    const scheduler = scan(chainCode(GOOD_OUTER, "return await Promise.resolve().then(fn);"), CHAIN, ALS);
    expect(chainErrors(scheduler)).toEqual(["unfollowed sink chain user.ts#go#edge#1: user.ts#inner forwards fn to Promise.resolve().then, not AsyncLocalStorage.run(callback)"]);
    const storeSlot = scan(chainCode(GOOD_OUTER, "return await alsFn.run(fn, async () => 1);"), CHAIN, ALS);
    expect(chainErrors(storeSlot)).toEqual(["unfollowed sink chain user.ts#go#edge#1: user.ts#inner forwards fn to alsFn.run, not AsyncLocalStorage.run(callback)"]);
  });

  it("S8: the registered edge must enter the first pinned hop", () => {
    const r = scan(chainCode(GOOD_OUTER, undefined, `await other(${LEAF});`), CHAIN, ALS);
    expect(chainErrors(r)).toContain("unfollowed sink chain user.ts#go#edge#1: the edge does not enter user.ts#outer(fn)");
  });
});

describe("ISS-958 S6 fixup 3: code and objects the scan cannot see are UNRESOLVED", () => {
  const unresolved = (r: { errors: string[] }, re: RegExp) => r.errors.filter((e) => re.test(e));
  it.each([
    ["eval", "export function run(s: string) { return eval(s); }\n", /^UNRESOLVED eval reference at user\.ts:\d+$/],
    ["an eval alias", "const ev = eval;\nexport function run(s: string) { return ev(s); }\n", /^UNRESOLVED eval reference at user\.ts:\d+$/],
    ["new Function", "export const f = new Function(\"return 1\");\n", /^UNRESOLVED the Function constructor reference at user\.ts:\d+$/],
    ["a Function call", "export const f = Function(\"return 1\");\n", /^UNRESOLVED the Function constructor reference at user\.ts:\d+$/],
    ["Reflect.construct", "class K {}\nexport const k = Reflect.construct(K, []);\n", /^UNRESOLVED Reflect\.construct reference at user\.ts:\d+$/],
    ["Proxy.revocable", "export const p = Proxy.revocable({}, {});\n", /^UNRESOLVED Proxy reference at user\.ts:\d+$/],
    ["a Proxy alias", "const P = Proxy;\nexport const p = new P({}, {});\n", /^UNRESOLVED Proxy reference at user\.ts:\d+$/],
    ["a class decorator", "const dec = (t: unknown, c: unknown) => {};\n@dec\nclass K {}\nexport { K };\n", /^UNRESOLVED decorator at user\.ts:\d+$/],
    ["a method decorator", "const dec = (t: unknown, c: unknown) => {};\nexport class K { @dec m() {} }\n", /^UNRESOLVED decorator at user\.ts:\d+$/],
  ])("%s is UNRESOLVED", (_n, code, re) => {
    expect(unresolved(scan(IMPORTS + code), re).length).toBeGreaterThan(0);
  });

  // Pen ruling on Proxy, option (a) with condition (3). The first shape is src/mcp/strict-schemas.ts: a get trap wrapping registerTool.
  const PROXY = (target: string, handler: string, ret: string) => `export function wrap(s: ${target}): ${ret} {
  return new Proxy(s, ${handler});
}
`;
  const GET = "{ get(t, p, r): unknown { return Reflect.get(t, p, r); } }";
  const proxyErrors = (r: { errors: string[] }) => r.errors.filter((e) => e.startsWith("UNRESOLVED Proxy"));
  it("a get-trap-only Proxy over a type with no guarded, provider, contract or lock member passes (the strict-schemas shape)", () => {
    const top = "export class Server { registerTool(name: string, config: object): unknown { return name; } }\n";
    expect(proxyErrors(inLock("", top + PROXY("Server", GET, "Server")))).toEqual([]);
  });

  // R4 pen ruling: WorkflowStage is sensitive as an owner whose providers the scan enumerates (A1), so the owned
  // rows call its bodyless member under the lock, as the A1 fixtures do.
  const OWNED = TYPES.replace("export interface WorkflowStage { enter(ctx: StageContext): Promise<void> }",
    "export interface WorkflowStage { enter(ctx: StageContext): Promise<void>; skip?(ctx: StageContext): void }");
  const ENTER = "stage.skip?.(ctx);";
  const inLockOwned = (body: string, top: string) => lockScan(LOCK_IMPORTS + top + `
export async function run(d: string, items: number[], stage: WorkflowStage) {
  await withSessionLock(d, async () => {
    const ctx = new StageContext(d);
    ${body}
  });
}`, { contextConstructions: ["user.ts#run#new#1"] }, { "/fx/types.ts": OWNED });
  it("a get-trap Proxy over a WorkflowStage the scan resolves no provider for passes", () => {
    expect(proxyErrors(inLock("", PROXY("WorkflowStage", GET, "WorkflowStage")))).toEqual([]);
  });

  it.each([
    ["a get trap over a WorkflowStage", PROXY("WorkflowStage", GET, "WorkflowStage"), "target, flow or result type owns a guarded, provider, contract or lock member, or is untyped", ENTER],
    ["a get trap over the context", PROXY("StageContext", GET, "StageContext"), "target, flow or result type owns a guarded, provider, contract or lock member, or is untyped"],
    ["a get trap flowing into a WorkflowStage", "export class Impl { async enter(): Promise<void> {} }\n" + PROXY("Impl", GET, "WorkflowStage"), "target, flow or result type owns a guarded, provider, contract or lock member, or is untyped", ENTER],
    ["an untyped target", PROXY("any", GET, "unknown"), "target, flow or result type owns a guarded, provider, contract or lock member, or is untyped"],
    ["a set trap", PROXY("{ a: number }", "{ set(t, p, v): boolean { return Reflect.set(t, p, v); } }", "{ a: number }"), "handler member set may write"],
    ["a defineProperty trap", PROXY("{ a: number }", "{ defineProperty(): boolean { return false; } }", "{ a: number }"), "handler member defineProperty may write"],
    ["a non-literal handler", "const h: ProxyHandler<{ a: number }> = {};\n" + PROXY("{ a: number }", "h", "{ a: number }"), "handler is not an object literal"],
  ])("a Proxy with %s is UNRESOLVED", (_n, top, why, body = "") => {
    expect(proxyErrors(body ? inLockOwned(body, top) : inLock("", top))).toEqual([expect.stringMatching(new RegExp(`^UNRESOLVED Proxy at user\\.ts:\\d+ \\(${why}\\)$`))]);
  });
});
