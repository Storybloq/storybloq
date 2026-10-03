/**
 * ISS-865: the lock-path producers, and a structural scan that keeps every Bus lock
 * sink fed only by them. The scan is the fail-closed net for the next lock site: a
 * sink argument it cannot prove safe is a violation.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  endpointLockPath, hashKeyLockPath, legacyEndpointLockPath, legacyThreadLockPath, threadLockPath, type BusPaths,
} from "../../src/bus/paths.js";

const BUS_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "bus");
const paths = { locks: "/p/.story/bus/locks" } as BusPaths;
const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const MIXED = "0F8FAD5B-d9cb-469F-A165-70867728950E";
const BAD = ["not-a-uuid", `${UUID}/x`, `${UUID}/..`, "../x", ""];

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

describe("lock-path producers (ISS-865)", () => {
  it("spell the legacy names for lowercase and mixed-case uuids unchanged", () => {
    for (const id of [UUID, MIXED]) {
      expect(threadLockPath(paths, id)).toBe(`/p/.story/bus/locks/thread-${id}.lock`);
      for (const kind of ["endpoint", "mailbox", "mailbox-reconcile", "waiter", "waiter-guard"] as const) {
        expect(endpointLockPath(paths, kind, id)).toBe(`/p/.story/bus/locks/${kind}-${id}.lock`);
      }
      expect(legacyThreadLockPath("/p/.story/bus", id)).toBe(join("/p/.story/bus", "locks", `thread-${id}.lock`));
      expect(legacyEndpointLockPath("/p/.story/bus", id)).toBe(join("/p/.story/bus", "locks", `endpoint-${id}.lock`));
    }
    const key = "a".repeat(64);
    expect(hashKeyLockPath(paths, "auto-attach", key)).toBe(`/p/.story/bus/locks/auto-attach-${key}.lock`);
  });

  it("reject a malformed thread id, including a single-component one containment alone permits", () => {
    for (const id of BAD) {
      expect(code(() => threadLockPath(paths, id)), id).toBe("invalid_input");
      expect(code(() => legacyThreadLockPath("/p/.story/bus", id)), id).toBe("invalid_input");
    }
  });

  it("reject a malformed endpoint id, including a single-component one containment alone permits", () => {
    for (const id of BAD) {
      expect(code(() => endpointLockPath(paths, "waiter", id)), id).toBe("invalid_input");
      expect(code(() => legacyEndpointLockPath("/p/.story/bus", id)), id).toBe("invalid_input");
    }
  });

  it("reject a lock key that is not a 64-hex hash, such as a raw client task id", () => {
    for (const key of ["codex-task/../x", "a".repeat(63), "a".repeat(65), "A".repeat(64)]) {
      expect(code(() => hashKeyLockPath(paths, "auto-attach", key)), key).toBe("invalid_input");
    }
  });
});

// ---------------------------------------------------------------------------
// The structural scan. It builds a TypeScript program over src/bus (no lib, no
// module resolution) and resolves every name through the checker, so an import
// alias, a namespace import or a shadowing local is the binding it really is.

const SINKS = new Set(["withHardenedLock", "acquireHardenedLock", "tryAcquireHardenedLock"]);
const PATHS_PRODUCERS = new Set(["threadLockPath", "endpointLockPath", "legacyThreadLockPath", "legacyEndpointLockPath", "hashKeyLockPath"]);
const PATH_MODULES = new Set(["node:path", "path"]);

/**
 * The reviewed exceptions, pinned whole: each is the sha256 of the declaration as the
 * TypeScript printer emits it with comments removed. Inside a pinned declaration the
 * scan accepts its lock sinks and its id-bearing lock names, because any added write,
 * construction, return or replaced collection changes the printed tree and fails the
 * pin. A pinned file that is present must still hold its declaration.
 */
const PINS: ReadonlyArray<{ file: string; name: string; sha: string; producer?: true }> = [
  { file: "paths.ts", name: "uuidLockPathIn", sha: "ccbfbe078233a41019b4fd71333fa26bbdda8c761182b61a1e0c2b1029aaa96f" },
  { file: "paths.ts", name: "threadLockPath", sha: "30d73e1a97daa1ee6f59e526f4570a4ed22b525c68cb6a36fc4a9abf91301fd4" },
  { file: "paths.ts", name: "endpointLockPath", sha: "c60e4a00026e92fba40764ebdb441ef678d517e7da8c0288c3d95cd5b54081ca" },
  { file: "paths.ts", name: "legacyThreadLockPath", sha: "e34c7a795132e7c0db58f9c4c0e7f0dac0d6e9bed25706c57ae09c5693a4cf17" },
  { file: "paths.ts", name: "legacyEndpointLockPath", sha: "3c189a32bcf28f27e7a619754e5ee711828784678c8bf4a42912cf4f5f28a1d0" },
  { file: "paths.ts", name: "hashKeyLockPath", sha: "439ce826b437e6f3168e5251b439c97fdaa16311266f29e43fb44485459d0f34" },
  { file: "wait.ts", name: "waiterPath", sha: "7e9845407e1dbcd3c80bc4ca9a681e606e9bbeefdeb922b374837f862f246749", producer: true },
  { file: "wait.ts", name: "waiterGuardPath", sha: "27950c9e72d63fa1c9ef0ad7bca181c722e191448a1287f1b0f57f79ac8f5ea4", producer: true },
  { file: "admin.ts", name: "enumerateV1EndpointLocks", sha: "0d58f2825a8276c164949c50d9f10eb137641ada887e110804c34b9b46714710" },
  { file: "admin.ts", name: "enumerateV1ThreadLocks", sha: "6fe811c8fd2d08fbdcafba3e4772d3bb213c0613da41bc120abb337755953c0e" },
  { file: "admin.ts", name: "v1FixedChildLocks", sha: "5616857cc796d2a5667490b5ed7e1410cad996477b13e683629eeefacd19648e" },
  { file: "admin.ts", name: "withV1Locks", sha: "a5a99088b4e151a7c3f0f7910b12fce425c8346e7c9e387030bbeb324763af3d" },
  { file: "legacy-v1.ts", name: "locksDirOf", sha: "dbde55ed6dc9206075e8bd59bceec1b7cc806a715c8241f1d6d54d7c0875daac" },
  { file: "legacy-v1.ts", name: "V1_ROLES", sha: "2bb888e91e94537d3ae9bbb08c94c125628c5cf48bed9edb1466835bdc805c83" },
  { file: "legacy-v1.ts", name: "withV1MailboxLocks", sha: "e1fb80d321b1d6584d5099465c9e1c95f1e726cfce261f384736e6d9848a3945" },
];

type Fn = ts.FunctionLikeDeclaration;
const printer = ts.createPrinter({ removeComments: true });

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function enclosingFn(node: ts.Node): Fn | undefined {
  for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n) && "body" in n && n.body) return n as Fn;
  return undefined;
}

function topLevelDecl(node: ts.Node): ts.Statement | undefined {
  let n: ts.Node = node;
  while (n.parent && !ts.isSourceFile(n.parent)) n = n.parent;
  return n.parent ? (n as ts.Statement) : undefined;
}

function declName(stmt: ts.Statement): string | undefined {
  if (ts.isFunctionDeclaration(stmt)) return stmt.name?.text;
  if (ts.isVariableStatement(stmt) && stmt.declarationList.declarations.length === 1) {
    const name = stmt.declarationList.declarations[0]!.name;
    return ts.isIdentifier(name) ? name.text : undefined;
  }
  return undefined;
}

function pinSha(stmt: ts.Statement, sf: ts.SourceFile): string {
  return createHash("sha256").update(printer.printNode(ts.EmitHint.Unspecified, stmt, sf)).digest("hex");
}

function isLiteral(expr: ts.Expression): boolean {
  return ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr);
}

function strip(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
}

const isAssignOp = (k: ts.SyntaxKind) => k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;

/** Every way an identifier can be written: plain, compound or destructuring assignment, ++/--, for-in/of target. */
function isWrite(id: ts.Identifier): boolean {
  for (let n: ts.Node = id; n.parent; n = n.parent) {
    const p = n.parent;
    if (ts.isBinaryExpression(p) && isAssignOp(p.operatorToken.kind)) return p.left === n;
    if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p))
      && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) return true;
    if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === n) return !ts.isVariableDeclarationList(n);
    const passThrough = ts.isParenthesizedExpression(p) || ts.isArrayLiteralExpression(p) || ts.isObjectLiteralExpression(p)
      || ts.isSpreadElement(p) || ts.isSpreadAssignment(p) || ts.isShorthandPropertyAssignment(p)
      || (ts.isPropertyAssignment(p) && p.initializer === n);
    if (!passThrough) return false;
  }
  return false;
}

interface Parsed { readonly name: string; readonly sf: ts.SourceFile }

export function scanLockSinks(files: ReadonlyArray<{ name: string; text: string }>): string[] {
  const texts = new Map(files.map((f) => [`/bus/${f.name}`, f.text]));
  const host: ts.CompilerHost = {
    getSourceFile: (fileName, lv) => (texts.has(fileName) ? ts.createSourceFile(fileName, texts.get(fileName)!, lv, true) : undefined),
    getDefaultLibFileName: () => "/lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "/bus",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => texts.has(f),
    readFile: (f) => texts.get(f),
  };
  const program = ts.createProgram([...texts.keys()], { noLib: true, noResolve: true, types: [], target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext }, host);
  const checker = program.getTypeChecker();
  const parsed: Parsed[] = files.map((f) => ({ name: f.name, sf: program.getSourceFile(`/bus/${f.name}`)! }));
  const violations: string[] = [];
  const at = (file: string, sf: ts.SourceFile, node: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const symOf = (node: ts.Node) => checker.getSymbolAtLocation(node);
  const declOf = (node: ts.Node) => symOf(node)?.declarations?.[0];
  const fileOf = (node: ts.Node) => node.getSourceFile().fileName.slice("/bus/".length);

  // Pins: verified first; a declaration counts as pinned only while its pin holds.
  const pinned = new Set<ts.Statement>();
  for (const pin of PINS) {
    const p = parsed.find((x) => x.name === pin.file);
    if (!p) continue;
    const decls = p.sf.statements.filter((s) => declName(s) === pin.name);
    if (decls.length !== 1) { violations.push(`${pin.file}: pinned declaration ${pin.name} found ${decls.length} times`); continue; }
    const sha = pinSha(decls[0]!, p.sf);
    if (sha !== pin.sha) violations.push(`${pin.file}: pinned declaration ${pin.name} changed (sha ${sha}); re-review it before re-pinning`);
    else pinned.add(decls[0]!);
  }
  const inPinned = (node: ts.Node) => { const t = topLevelDecl(node); return t !== undefined && pinned.has(t); };

  function importOf(decl: ts.Declaration | undefined): { module: string; imported: string } | undefined {
    if (decl && ts.isImportSpecifier(decl)) {
      return { module: (decl.parent.parent.parent.moduleSpecifier as ts.StringLiteral).text, imported: (decl.propertyName ?? decl.name).text };
    }
    return undefined;
  }
  function namespaceModule(decl: ts.Declaration | undefined): string | undefined {
    return decl && ts.isNamespaceImport(decl) ? (decl.parent.parent.moduleSpecifier as ts.StringLiteral).text : undefined;
  }
  const isPathFn = (call: ts.CallExpression, names: readonly string[]) => {
    if (!ts.isIdentifier(call.expression)) return false;
    const imp = importOf(declOf(call.expression));
    return imp !== undefined && PATH_MODULES.has(imp.module) && names.includes(imp.imported);
  };
  const isProducerCall = (call: ts.CallExpression) => {
    if (!ts.isIdentifier(call.expression)) return false;
    const decl = declOf(call.expression);
    const imp = importOf(decl);
    if (imp) return imp.module === "./paths.js" && PATHS_PRODUCERS.has(imp.imported);
    return decl !== undefined && ts.isFunctionDeclaration(decl) && pinned.has(decl)
      && PINS.some((p) => p.producer && p.file === fileOf(decl) && p.name === decl.name?.text);
  };

  /** Lock-path argument positions, keyed by binding: the lock primitives, then forwarders found below. */
  const local = new Map<ts.Symbol, Set<number>>();
  const exported = new Map<string, Set<number>>(); // "<module specifier>#<export name>"
  const moduleKey = (file: string) => `./${file.replace(/\.ts$/, ".js")}`;
  function indicesFor(module: string, name: string): Set<number> | undefined {
    if (module === "./lock.js" && SINKS.has(name)) return new Set([0]);
    return exported.get(`${module}#${name}`);
  }
  /** The sink positions of a callee or reference, "unresolved" for a sink-named reference the scan cannot bind. */
  function sinkIndices(callee: ts.Expression): Set<number> | "unresolved" | undefined {
    const e = strip(callee);
    if (ts.isIdentifier(e)) {
      const sym = symOf(e);
      if (sym && local.has(sym)) return local.get(sym);
      const decl = sym?.declarations?.[0];
      const imp = importOf(decl);
      if (imp) return indicesFor(imp.module, imp.imported);
      if (decl && ts.isFunctionDeclaration(decl) && fileOf(decl) === "lock.ts" && SINKS.has(decl.name?.text ?? "")) return new Set([0]);
      return undefined;
    }
    if (ts.isPropertyAccessExpression(e)) {
      const module = ts.isIdentifier(e.expression) ? namespaceModule(declOf(e.expression)) : undefined;
      if (module !== undefined) return indicesFor(module, e.name.text);
      if (SINKS.has(e.name.text) || [...exported.keys()].some((k) => k.endsWith(`#${e.name.text}`))) return "unresolved";
      return undefined;
    }
    if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression) && SINKS.has(e.argumentExpression.text)) return "unresolved";
    return undefined;
  }

  function writtenAnywhere(sym: ts.Symbol, scope: ts.Node): ts.Identifier[] {
    const out: ts.Identifier[] = [];
    walk(scope, (n) => { if (ts.isIdentifier(n) && symOf(n) === sym && isWrite(n)) out.push(n); });
    return out;
  }

  /** The binding a forwarded parameter's function is called through, or undefined when it cannot be tracked. */
  function forwarderBinding(fn: Fn): { sym: ts.Symbol; exportName?: string } | undefined {
    if (ts.isFunctionDeclaration(fn) && fn.name) {
      const sym = symOf(fn.name);
      const isExport = fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      return sym ? { sym, exportName: isExport ? fn.name.text : undefined } : undefined;
    }
    if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && fn.parent.initializer === fn
      && ts.isIdentifier(fn.parent.name) && fn.parent.parent.flags & ts.NodeFlags.Const) {
      const sym = symOf(fn.parent.name);
      const stmt = fn.parent.parent.parent;
      const isExport = ts.isVariableStatement(stmt) && stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      return sym ? { sym, exportName: isExport ? fn.parent.name.text : undefined } : undefined;
    }
    return undefined;
  }

  /** (f) a let with no initializer, written exactly once by a plain producer assignment inside a try whose catch returns. */
  function isGuardedLet(decl: ts.VariableDeclaration, sym: ts.Symbol): boolean {
    if (decl.initializer || !(decl.parent.flags & ts.NodeFlags.Let)) return false;
    const fn = enclosingFn(decl);
    const writes = writtenAnywhere(sym, fn?.body ?? decl.getSourceFile());
    if (writes.length !== 1) return false;
    const assign = writes[0]!.parent;
    if (!ts.isBinaryExpression(assign) || assign.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
    const rhs = strip(assign.right);
    if (!ts.isCallExpression(rhs) || !isProducerCall(rhs)) return false;
    for (let n: ts.Node = assign; n !== fn && n.parent; n = n.parent) {
      if (ts.isBlock(n) && ts.isTryStatement(n.parent) && n.parent.tryBlock === n) {
        return n.parent.catchClause?.block.statements.some((s) => ts.isReturnStatement(s)) === true;
      }
    }
    return false;
  }

  /**
   * Detection only (S2): anything that may be a locks directory, spelled or aliased. Broad
   * on purpose, since it widens what counts as a construction; it never proves safety.
   */
  function mayBeLocksDir(expr: ts.Expression, depth = 0): boolean {
    const e = strip(expr);
    if (ts.isPropertyAccessExpression(e) && e.name.text === "locks") return true;
    if (ts.isIdentifier(e) && e.text === "locksDir") return true;
    if (ts.isCallExpression(e)) {
      if (ts.isIdentifier(e.expression) && e.expression.text === "locksDirOf") return true;
      if (isPathFn(e, ["join", "resolve"]) && e.arguments.length === 2 && ts.isStringLiteral(e.arguments[1]!) && e.arguments[1]!.text === "locks") return true;
    }
    if (ts.isIdentifier(e) && depth === 0) {
      const decl = declOf(e);
      return decl !== undefined && ts.isVariableDeclaration(decl) && decl.initializer !== undefined && mayBeLocksDir(decl.initializer, 1);
    }
    return false;
  }

  /** An approved locks-directory expression: X.locks, a call to the pinned locksDirOf, or join(<expr>, "locks"). */
  function isApprovedLocksDirExpr(expr: ts.Expression): boolean {
    const e = strip(expr);
    if (ts.isPropertyAccessExpression(e) && e.name.text === "locks") return true;
    if (!ts.isCallExpression(e)) return false;
    if (ts.isIdentifier(e.expression)) {
      const decl = declOf(e.expression);
      if (decl && ts.isFunctionDeclaration(decl) && decl.name?.text === "locksDirOf" && pinned.has(decl)) return true;
    }
    return isPathFn(e, ["join"]) && e.arguments.length === 2 && ts.isStringLiteral(e.arguments[1]!) && e.arguments[1]!.text === "locks";
  }

  /**
   * Proof (S1): an approved expression, or a variable bound to one through the checker
   * that is never written afterwards. A parameter, whatever its name, is not a proof.
   */
  function isProvenLocksDir(expr: ts.Expression): boolean {
    const e = strip(expr);
    if (isApprovedLocksDirExpr(e)) return true;
    if (!ts.isIdentifier(e)) return false;
    const sym = symOf(e);
    const decl = sym?.declarations?.[0];
    if (!sym || !decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name) || !decl.initializer) return false;
    if (!isApprovedLocksDirExpr(decl.initializer)) return false;
    return writtenAnywhere(sym, enclosingFn(decl)?.body ?? decl.getSourceFile()).length === 0;
  }

  /** (a) a producer call, or (b) join(<locks dir or the migration root>, <literal>) with exactly two args. */
  function isSafeValue(expr: ts.Expression): boolean {
    const e = strip(expr);
    if (ts.isConditionalExpression(e)) return isSafeValue(e.whenTrue) && isSafeValue(e.whenFalse);
    if (!ts.isCallExpression(e)) return false;
    if (isProducerCall(e)) return true;
    if (!isPathFn(e, ["join"]) || e.arguments.length !== 2 || !isLiteral(e.arguments[1]!)) return false;
    const base = strip(e.arguments[0]!);
    if (isProvenLocksDir(base)) return true;
    const decl = ts.isIdentifier(base) ? declOf(base) : undefined;
    return decl !== undefined && ts.isVariableDeclaration(decl) && fileOf(decl) === "admin.ts" && ts.isIdentifier(decl.name)
      && decl.name.text === "migrationRoot" && decl.parent.flags & ts.NodeFlags.Const
      && decl.initializer?.getText() === "join(paths.storyRoot, \"bus-migration\")";
  }

  type Verdict = { ok: true; forward?: { fn: Fn; index: number } } | { ok: false };
  function judge(arg: ts.Expression): Verdict {
    if (isSafeValue(arg)) return { ok: true };
    const e = strip(arg);
    if (!ts.isIdentifier(e)) return { ok: false };
    const sym = symOf(e);
    const decl = sym?.declarations?.[0];
    if (!sym || !decl) return { ok: false };
    // (d) a forwarded parameter: unwritten, plain, of a function whose callers can be tracked.
    if (ts.isParameter(decl) && ts.isIdentifier(decl.name) && !decl.dotDotDotToken && ts.isFunctionLike(decl.parent)) {
      const fn = decl.parent as Fn;
      if (!fn.body || writtenAnywhere(sym, fn.body).length > 0 || !forwarderBinding(fn)) return { ok: false };
      return { ok: true, forward: { fn, index: fn.parameters.indexOf(decl) } };
    }
    if (ts.isVariableDeclaration(decl)) {
      // (c) a local const, one level away from a safe value.
      if (decl.parent.flags & ts.NodeFlags.Const && !ts.isForOfStatement(decl.parent.parent) && decl.initializer && isSafeValue(decl.initializer)) return { ok: true };
      // (f) the guarded let.
      if (isGuardedLet(decl, sym)) return { ok: true };
    }
    return { ok: false };
  }

  // Discover forwarders to a fixed point: a function whose parameter k reaches a sink
  // position becomes a sink at k, and so do its callers' wrappers, across files.
  for (let changed = true; changed;) {
    changed = false;
    for (const { sf } of parsed) {
      walk(sf, (n) => {
        if (!ts.isCallExpression(n)) return;
        const idx = sinkIndices(n.expression);
        if (!idx || idx === "unresolved") return;
        for (const i of idx) {
          const arg = n.arguments[i];
          if (!arg) continue;
          const v = judge(arg);
          if (!v.ok || !v.forward) continue;
          const binding = forwarderBinding(v.forward.fn)!;
          const set = local.get(binding.sym) ?? new Set<number>();
          if (!set.has(v.forward.index)) { set.add(v.forward.index); local.set(binding.sym, set); changed = true; }
          if (binding.exportName) {
            const key = `${moduleKey(fileOf(v.forward.fn))}#${binding.exportName}`;
            const ex = exported.get(key) ?? new Set<number>();
            if (!ex.has(v.forward.index)) { ex.add(v.forward.index); exported.set(key, ex); changed = true; }
          }
        }
      });
    }
  }

  // Names that can hold a sink binding: the primitives, every forwarder, and every
  // import or namespace import that resolves to one. Only these need a binding lookup.
  const holdsSinks = (module: string) => module === "./lock.js" || [...exported.keys()].some((k) => k.startsWith(`${module}#`));
  const candidates = new Set<string>(SINKS);
  for (const sym of local.keys()) candidates.add(sym.name);
  for (const { sf } of parsed) {
    for (const stmt of sf.statements) {
      const bindings = ts.isImportDeclaration(stmt) ? stmt.importClause?.namedBindings : undefined;
      if (!bindings) continue;
      const module = (stmt.moduleSpecifier as ts.StringLiteral).text;
      if (ts.isNamespaceImport(bindings)) { if (holdsSinks(module)) candidates.add(bindings.name.text); }
      else for (const el of bindings.elements) if (indicesFor(module, (el.propertyName ?? el.name).text)) candidates.add(el.name.text);
    }
  }

  for (const { name: file, sf } of parsed) {
    walk(sf, (n) => {
      // S1: every sink position takes a proven value.
      if (ts.isCallExpression(n)) {
        const idx = sinkIndices(n.expression);
        if (idx === "unresolved") violations.push(`${at(file, sf, n)}: lock sink called through a reference the scan cannot bind: ${n.expression.getText()}`);
        else if (idx && !inPinned(n)) {
          for (const i of idx) {
            const spread = n.arguments.findIndex((a) => ts.isSpreadElement(a));
            if (spread !== -1 && spread <= i) { violations.push(`${at(file, sf, n)}: lock sink takes a spread argument: ${n.getText()}`); continue; }
            const arg = n.arguments[i];
            if (arg && !judge(arg).ok) violations.push(`${at(file, sf, n)}: lock sink ${n.expression.getText()} takes an unproven path at argument ${i}: ${arg.getText()}`);
          }
        }
      }
      // A sink binding (or a namespace holding one) used as anything but a callee.
      if (ts.isIdentifier(n) && candidates.has(n.text) && !inPinned(n)) {
        const p = n.parent;
        const declaring = (ts.isImportSpecifier(p) || ts.isNamespaceImport(p) || ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p)) && (p as { name?: ts.Node }).name === n;
        if (!declaring && !ts.isImportSpecifier(p)) {
          const module = namespaceModule(declOf(n));
          if (module !== undefined && holdsSinks(module)) {
            const head = ts.isPropertyAccessExpression(p) && p.expression === n;
            const prop = head ? indicesFor(module, (p as ts.PropertyAccessExpression).name.text) : undefined;
            if (!head || (prop && !(ts.isCallExpression(p.parent) && p.parent.expression === p))) {
              violations.push(`${at(file, sf, n)}: lock module namespace used outside a direct call: ${p.getText()}`);
            }
          } else {
            const idx = sinkIndices(n);
            const callee = ts.isCallExpression(p) && p.expression === n;
            if (idx && idx !== "unresolved" && !callee && !(ts.isPropertyAccessExpression(p) && p.name === n)) {
              violations.push(`${at(file, sf, n)}: lock sink referenced outside a direct call: ${p.getText()}`);
            }
          }
        }
      }
      // S2: an id-bearing lock name is built only inside a pinned declaration.
      let construction = false;
      if (ts.isCallExpression(n) && isPathFn(n, ["join", "resolve", "normalize"]) && n.arguments.length >= 1 && mayBeLocksDir(n.arguments[0]!)) {
        construction = n.arguments.length !== 2 || !isLiteral(n.arguments[1]!);
      }
      if (ts.isTemplateExpression(n) && n.templateSpans.some((s) => mayBeLocksDir(s.expression))) construction = true;
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken && (mayBeLocksDir(n.left) || mayBeLocksDir(n.right))) construction = true;
      if (construction && !inPinned(n)) violations.push(`${at(file, sf, n)}: id-bearing lock name built outside a pinned producer: ${n.getText()}`);
    });
  }
  return violations;
}

function busSources(): Array<{ name: string; text: string }> {
  return readdirSync(BUS_SRC).filter((f) => f.endsWith(".ts")).map((name) => ({ name, text: readFileSync(join(BUS_SRC, name), "utf-8") }));
}

const PRELUDE = [
  `import { join, resolve } from "node:path";`,
  `import { acquireHardenedLock, tryAcquireHardenedLock, withHardenedLock } from "./lock.js";`,
  `import { endpointLockPath, hashKeyLockPath, threadLockPath } from "./paths.js";`,
  "",
].join("\n");
const one = (text: string, name = "fixture.ts") => scanLockSinks([{ name, text: PRELUDE + text }]);
/** The real tree with one file's text edited; the edit must apply. */
function edited(file: string, from: string, to: string): Array<{ name: string; text: string }> {
  const sources = busSources();
  const target = sources.find((s) => s.name === file)!;
  expect(target.text.split(from).length, `${file} holds exactly one ${from}`).toBe(2);
  return sources.map((s) => (s.name === file ? { name: s.name, text: s.text.replace(from, to) } : s));
}

describe("A4: every Bus lock sink takes a proven path (ISS-865)", () => {
  it("the real src/bus tree has no violation", () => {
    expect(scanLockSinks(busSources())).toEqual([]);
  });

  it("accepts every shape the real tree uses", () => {
    expect(one(`async function f(paths, id) { return withHardenedLock(threadLockPath(paths, id), g); }`)).toEqual([]);
    expect(one(`async function f(paths) { return withHardenedLock(join(paths.locks, "threads.lock"), g); }`)).toEqual([]);
    expect(one(`async function f(paths, p, id) { const lockPath = await p ? threadLockPath(paths, id) : join(paths.locks, "threads.lock"); return withHardenedLock(lockPath, g); }`)).toEqual([]);
    expect(one(`export async function wrap(lockPath, h) { return acquireHardenedLock(lockPath, {}); }\nasync function f(paths, id) { return wrap(endpointLockPath(paths, "endpoint", id), g); }`)).toEqual([]);
    expect(one(`async function f(root, paths, key) { let lockPath; try { lockPath = hashKeyLockPath(paths, "auto-attach", key); } catch { return null; } return tryAcquireHardenedLock(lockPath, { create: false }); }`)).toEqual([]);
    expect(one(`async function f(busRoot, h) { const locksDir = join(busRoot, "locks"); return withHardenedLock(join(locksDir, "threads.lock"), h); }`)).toEqual([]);
    expect(one(`async function w(a, b) { await withHardenedLock(a, g); return acquireHardenedLock(b, {}); }\nasync function f(paths, id, key) { return w(threadLockPath(paths, id), hashKeyLockPath(paths, "k", key)); }`)).toEqual([]);
  });

  it("flags each unsafe form", () => {
    const cases: Record<string, string> = {
      alias: `async function f(paths, id) { const d = paths.locks; return withHardenedLock(join(d, \`thread-\${id}.lock\`), g); }`,
      resolve: `async function f(paths, id) { return withHardenedLock(resolve(paths.locks, \`thread-\${id}.lock\`), g); }`,
      template: `async function f(paths, id) { return withHardenedLock(\`\${paths.locks}/thread-\${id}.lock\`, g); }`,
      thirdArg: `async function f(paths, id) { return withHardenedLock(join(paths.locks, "thread", id), g); }`,
      locksDirOf: `async function f(busRoot, id) { return withHardenedLock(join(locksDirOf(busRoot), \`thread-\${id}.lock\`), g); }`,
      rawTaskId: `async function f(paths, clientTaskId) { let lockPath; try { lockPath = join(paths.locks, \`auto-attach-\${clientTaskId}.lock\`); } catch { return null; } return tryAcquireHardenedLock(lockPath, {}); }`,
      secondAssign: `async function f(paths, key, id) { let lockPath; try { lockPath = hashKeyLockPath(paths, "a", key); } catch { return null; } lockPath = join(paths.locks, \`x-\${id}.lock\`); return tryAcquireHardenedLock(lockPath, {}); }`,
      // Finding 3: forwarders are tracked per parameter index, through a wrapper chain.
      forwardedSecond: `async function w(a, b) { await withHardenedLock(a, g); return acquireHardenedLock(b, {}); }\nasync function f(paths, id, raw) { return w(threadLockPath(paths, id), String(raw)); }`,
      forwardChain: `async function w(a, b) { return acquireHardenedLock(b, {}); }\nasync function v(x, y) { return w(x, y); }\nasync function f(paths, id, raw) { return v(threadLockPath(paths, id), \`/tmp/\${raw}\`); }`,
      untrackableForward: `async function f(paths, raw) { return [raw].map((p) => withHardenedLock(p, g)); }`,
      // Finding 4: any intervening write disqualifies the binding.
      paramReassigned: `async function f(lockPath, raw) { lockPath = String(raw); return withHardenedLock(lockPath, g); }\nasync function h(paths, id) { return f(threadLockPath(paths, id), id); }`,
      compoundAfterGuard: `async function f(paths, key, suffix) { let lockPath; try { lockPath = hashKeyLockPath(paths, "a", key); } catch { return null; } lockPath += suffix; return tryAcquireHardenedLock(lockPath, {}); }`,
      destructuredParam: `async function f(lockPath, raw) { [lockPath] = [String(raw)]; return withHardenedLock(lockPath, g); }`,
      destructuredObject: `async function f(lockPath, raw) { ({ p: lockPath } = { p: String(raw) }); return withHardenedLock(lockPath, g); }`,
      // Finding 5: import aliases and namespace imports bind to the sink.
      importAlias: `import { acquireHardenedLock as acquire } from "./lock.js";\nasync function f(dir, callerPath) { return acquire(\`\${dir}/\${callerPath}.lock\`, {}); }`,
      namespaceImport: `import * as lock from "./lock.js";\nasync function f(dir, callerPath) { return lock.acquireHardenedLock(\`\${dir}/\${callerPath}.lock\`, {}); }`,
      sinkAsValue: `async function f(dir, callerPath) { const a = withHardenedLock; return a(\`\${dir}/\${callerPath}.lock\`, g); }`,
      namespaceAsValue: `import * as lock from "./lock.js";\nasync function f(dir, callerPath) { const m = lock; return m.withHardenedLock(\`\${dir}/\${callerPath}.lock\`, g); }`,
      // Round 2: a directory is proven by its binding, never by its name.
      reassignedDirAlias: `async function f(paths, input, h) { let dir = paths.locks; dir = input.directory; await withHardenedLock(join(dir, "thread.lock"), h); }`,
      paramNamedLocksDir: `async function f(locksDir, h) { return withHardenedLock(join(locksDir, "thread.lock"), h); }`,
      unboundMember: `async function f(o, dir, callerPath) { return o.withHardenedLock(\`\${dir}/\${callerPath}.lock\`, g); }`,
    };
    for (const [label, text] of Object.entries(cases)) expect(one(text).length, label).toBeGreaterThan(0);
  });

  it("holds the reviewed exceptions to their exact reviewed form", () => {
    const mutations: Array<[string, string, string]> = [
      // Every reviewed snippet retained, an unsafe path appended.
      ["admin.ts", "names.push(`thread-${entry.name}.lock`);", "names.push(`thread-${entry.name}.lock`); names.push(process.argv[2]!);"],
      ["admin.ts", "names.add(`mailbox-reconcile-${role}.lock`);", "names.add(`mailbox-reconcile-${role}.lock`); names.add(process.argv[2]!);"],
      ["legacy-v1.ts", "    join(locksDir, `mailbox-reconcile-${role}.lock`),\n", "    join(locksDir, `mailbox-reconcile-${role}.lock`),\n    process.argv[2]!,\n"],
      // The returned collection replaced.
      ["admin.ts", "return [...lockPaths].sort();", "return process.argv.slice(2);"],
      ["admin.ts", "return names.sort().map((name) => join(locksDir, name));", "return process.argv.slice(2);"],
      // The loop bound to a different source, and the enumerator's source swapped.
      ["admin.ts", "for (const lockPath of await enumerateV1ThreadLocks(busRoot)) await acquire(lockPath);", "for (const lockPath of await someOtherList(busRoot)) await acquire(lockPath);"],
      ["admin.ts", "listV1Endpoints(v1PathsFrom(busRoot))", "readUnvalidatedEndpoints(busRoot)"],
      ["legacy-v1.ts", "const V1_ROLES = [\"implementer\", \"reviewer\"] as const;", "const V1_ROLES = [\"implementer\", \"reviewer\", \"../../x\"] as const;"],
      ["legacy-v1.ts", "function locksDirOf(busRoot: string): string {\n  return join(busRoot, \"locks\");", "function locksDirOf(busRoot: string): string {\n  return busRoot;"],
      ["paths.ts", "return uuidLockPathIn(paths.locks, \"thread\", threadId, \"Invalid Bus thread id\");", "return uuidLockPathIn(process.cwd(), \"thread\", threadId, \"Invalid Bus thread id\");"],
      ["wait.ts", "return endpointLockPath(paths, \"waiter\", endpointId);", "return join(paths.locks, `waiter-${endpointId}.lock`);"],
    ];
    for (const [file, from, to] of mutations) expect(scanLockSinks(edited(file, from, to)).length, `${file}: ${to}`).toBeGreaterThan(0);
  });
});
