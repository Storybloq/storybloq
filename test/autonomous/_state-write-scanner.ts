/**
 * ISS-958 section 6: the fail-closed state-write enforcement scanner.
 *
 * It builds the set of functions that can throw a state write's error out to
 * their caller (the writer set), starting from `writeSessionSync`, and then
 * demands that every catch such an error can reach, every promise handler on
 * such a call, and every place a writer escapes as a VALUE is declared in the
 * registry (src/autonomous/state-write-policy.ts) with a policy. A call a catch
 * can reach whose callee it cannot resolve is reported UNRESOLVED and must be
 * reviewed. It also enforces the lock contract: who may call a lock-held
 * function, where the lock-scoped context may be built and kept, and that work
 * started under the lock completes under it. Anything it cannot prove harmless
 * counts against the code.
 *
 * Test-only: it imports the TypeScript compiler, which production never loads.
 */
import ts from "typescript";
import path from "node:path";

export const POLICIES = ["P", "A", "R", "K", "T", "TC", "TR", "OC", "B"] as const;
export type Policy = (typeof POLICIES)[number];

export interface ScannerRegistry {
  /** `file#enclosingFn#kind#ordinal` -> policy, for catches and promise handlers. */
  readonly catches: Readonly<Record<string, string>>;
  /** `file#enclosingFn#edge#ordinal` -> the slot it feeds: `file#Container.member` or `file#fn(param)`. */
  readonly edges: Readonly<Record<string, string>>;
  /** Tier 1: `file#fn` that hold the session lock by contract (their callers are checked). */
  readonly lockHeldByContract: readonly string[];
  /** Non-throwing loggers a contained catch may call: `file#fn` or a global path like `process.stderr.write`. */
  readonly sinks: readonly string[];
  /** Result helpers a contained catch may return: `file#fn`. */
  readonly results: readonly string[];
  /**
   * `file#name` of exported test seams (for example guide.ts `__recoveryTesting`).
   * Code inside such an export's initializer is not a writer path: it is
   * skipped by every rule, and in exchange no src file may reference the
   * export at all, so production can never reach a writer through it.
   */
  readonly testOnlyExports: readonly string[];
  /**
   * Reviewed UNRESOLVED sites, `file#fn#callee#ordinal` -> why the callee
   * cannot carry a state write. Exact set: an unlisted site and a stale entry both fail.
   */
  readonly unresolved?: Readonly<Record<string, string>>;
  /**
   * Tier 3: `file#fn` that call a lock-held function, hold the lock because
   * their caller does, and are neither tier 1 nor tier 2 -> that caller,
   * `file#fn`. Exact set: an unlisted function and a stale entry both fail.
   */
  readonly lockHeldViaCaller?: Readonly<Record<string, string>>;
  /** `file#fn#new#ordinal` of every lock-context construction. Exact set. */
  readonly contextConstructions?: readonly string[];
  /**
   * `file#fn` of the lock-entry primitives: the one place a promise-returning
   * closure under the lock may be passed as a value. Each is verified to await
   * its callback once, with the release in the finally. Defaults to the lock helper.
   */
  readonly lockEntries?: readonly string[];
  /**
   * Addendum 2 R-a: `file#fn` of AWAITED-CALLBACK PRIMITIVES (not lock
   * entries). A closure passed as such a primitive's callback runs in the call
   * site's lock region; each is verified along its whole delegation chain.
   */
  readonly awaitedCallbackPrimitives?: readonly string[];
  /** R-a: injected awaited-callback slots, `file#Type.member` -> why only tests supply it. Exact set. */
  readonly injectedCallbackSlots?: Readonly<Record<string, string>>;
  /** R-e: CONTEXT-CARRYING PARAMETERS, `file#fn(param)`: treated as the context inside the function. Exact set. */
  readonly contextParams?: readonly string[];
  /** Addendum 3 R-j1: injected test-seam slots, `file#Type.member` -> why only tests supply it. Each is a registered edge's slot. */
  readonly testSeamSlots?: Readonly<Record<string, string>>;
  /**
   * Pen ruling on the staged slot: a NOT-followed src-receiver sink, edge key ->
   * its chain of `{ fn: "file#fn", param }` hops. Each hop is verified on src: no
   * try with a catch encloses the slot's use, and the use is awaited or returned.
   */
  readonly unfollowedSinkChains?: Readonly<Record<string, readonly { readonly fn: string; readonly param: string }[]>>;
}

export interface ScanOptions {
  /** Directory keys are made relative to. */
  readonly base: string;
  /** File (relative to base) that declares the root writer and the lock helper. */
  readonly rootFile: string;
  readonly rootName: string;
  /**
   * S9: further primitives in rootFile that write the state file on their own
   * (not through rootName). Each seeds discovery and the direct-writer lock
   * check like rootName.
   */
  readonly extraRootNames?: readonly string[];
  /**
   * T2: per lock entry (file#name), the acquisition it must make: the callee's
   * name and the module (a src file, or a package directory) declaring it.
   * Unlisted, the entry's single callable-returning call is the acquisition.
   */
  readonly lockAcquisitions?: Readonly<Record<string, { readonly module: string; readonly name: string }>>;
  /** Name of the lock helper whose callback holds the session lock. */
  readonly lockName: string;
  readonly registry: ScannerRegistry;
  /**
   * The lock-scoped context (tier 2): a function holds the lock by the context
   * contract when it is a method of the context class or of a class that
   * implements the stage interface, or takes a parameter of the context type.
   */
  readonly lockContext?: { readonly file: string; readonly className: string; readonly stageInterface: string };
  /** R5-1: the most types one reachability query may visit before it answers as reaching (default 5000). */
  readonly reachBudget?: number;
}

export interface ScanResult {
  readonly errors: string[];
  /** Every key the scan required, with what it found there. */
  readonly found: Map<string, string>;
  /** Where each key sits, `file:line`, for reports (never for matching). */
  readonly sites: Map<string, string>;
  /** Calls, awaits and handlers a catch can reach whose callee is unresolved: key -> construct. */
  readonly unresolved: Map<string, string>;
  readonly writers: string[];
  /** Tier 2 functions the structural rule admitted, and tier 3 functions that needed a listing. */
  readonly tiers: { readonly structural: string[]; readonly viaCaller: string[] };
  /** Lock-context construction keys. */
  readonly constructions: string[];
  /** Functions an awaited-callback primitive's verified chain delegates through. */
  readonly chainMembers: string[];
  /** Report aid: call sites of functions that need a lock holder. */
  readonly holderHints: string[];
  /** Report aid (A1): each bodyless interface member called under the lock, with its src providers by `file:line`. */
  readonly memberProviders: Record<string, string[]>;
  /**
   * Report aid (R5-1): the reachability visit budget, the most visits one query used, the queries that exhausted
   * it (each answered as reaching), and for every flagged assertion and Proxy the path to the sensitive type.
   */
  readonly reach: { budget: number; maxVisits: number; exhausted: string[]; paths: Record<string, string> };
}

type Fn = ts.FunctionLikeDeclaration;
type Closure = ts.ArrowFunction | ts.FunctionExpression;

/** Each node's source file, cached: getSourceFile walks the parent chain (ISS-1401). */
const fileOf = new WeakMap<ts.Node, ts.SourceFile>();
const sourceOf = (n: ts.Node): ts.SourceFile => fileOf.get(n) ?? (fileOf.set(n, n.getSourceFile()), fileOf.get(n)!);
/** n lies inside b: the same source file and b's span (offsets alone match across files). */
const within = (n: ts.Node, b: ts.Node): boolean => n.pos >= b.pos && n.end <= b.end && sourceOf(n) === sourceOf(b);

export function scanStateWrites(program: ts.Program, opts: ScanOptions): ScanResult {
  const checker = program.getTypeChecker();
  const errors: string[] = [];
  const found = new Map<string, string>();
  const sites = new Map<string, string>();
  const files = program.getSourceFiles().filter((f) => !f.isDeclarationFile && !f.fileName.includes("/node_modules/"));
  const fileSet = new Set(files);
  const rel = (sf: ts.SourceFile) => path.relative(opts.base, sf.fileName).split(path.sep).join("/");
  const lineOf = (n: ts.Node) => n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const where = (n: ts.Node) => `${rel(n.getSourceFile())}:${lineOf(n)}`;
  const external = (d: ts.Node) => !fileSet.has(d.getSourceFile());

  const resolve = (s: ts.Symbol | undefined): ts.Symbol | undefined =>
    s && (s.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(s) : s;

  // ---- naming ---------------------------------------------------------------

  /** The nearest NAMED function-like ancestor; anonymous callbacks belong to it. */
  function namedFn(n: ts.Node): { node: ts.Node | null; name: string } {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      const name = fnName(p);
      if (name) return { node: p, name };
    }
    return { node: null, name: "<module>" };
  }

  function fnName(p: ts.Node): string | null {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
    if ((ts.isMethodDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)) && p.name) {
      const cls = p.parent;
      const owner = ts.isClassLike(cls) && cls.name ? cls.name.text + "." : "";
      return owner + p.name.getText();
    }
    if (ts.isConstructorDeclaration(p)) {
      const cls = p.parent;
      return (ts.isClassLike(cls) && cls.name ? cls.name.text : "<class>") + ".constructor";
    }
    if (isClosure(p)) {
      const parent = p.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
      if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) return parent.name.getText();
    }
    return null;
  }

  function isClosure(n: ts.Node): n is Closure {
    return ts.isArrowFunction(n) || ts.isFunctionExpression(n);
  }

  /**
   * The declaration node a named function stands for. Writers are keyed by
   * DECLARATION, never by symbol: a member reached from another module can
   * resolve to a transient symbol that is not identical to the declared one,
   * and symbol identity silently misses it (ISS-958 S6, ctx.writeState).
   */
  function declOfFn(p: ts.Node): ts.Node | undefined {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return canon(p);
    if (ts.isConstructorDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p)) return p;
    if (isClosure(p)) {
      const parent = p.parent;
      if ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.name) {
        return parent;
      }
    }
    return undefined;
  }

  /** Overloads share one identity: the declared symbol's first declaration. */
  function canon(d: ts.Node): ts.Node {
    if ((ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) && d.name) {
      const s = checker.getSymbolAtLocation(d.name);
      const v = s?.valueDeclaration ?? s?.declarations?.[0];
      if (v) return v;
    }
    return d;
  }

  /**
   * The declaration a referenced symbol stands for: through import aliases,
   * through destructuring (a binding in a declaration, a parameter or a
   * for-of resolves via the type it destructures to the member it reads), and
   * through transient copies (their valueDeclaration is the declared node).
   */
  function declOf(sym: ts.Symbol | undefined, depth = 0): ts.Node | undefined {
    const s = resolve(sym);
    const d = s?.valueDeclaration ?? s?.declarations?.[0];
    if (!d || depth > 8) return d;
    if (ts.isBindingElement(d) && ts.isObjectBindingPattern(d.parent) && !d.dotDotDotToken) {
      const nameNode = d.propertyName ?? d.name;
      if (!ts.isIdentifier(nameNode) && !ts.isStringLiteral(nameNode)) return d;
      const prop = nameNode.text;
      const owner = d.parent.parent;
      const fromInit = ts.isVariableDeclaration(owner) && owner.initializer
        ? checker.getTypeAtLocation(owner.initializer).getProperty(prop) : undefined;
      const from = fromInit ?? checker.getTypeAtLocation(d.parent).getProperty(prop);
      return from ? declOf(from, depth + 1) : d;
    }
    return canon(d);
  }

  const memberName = (d: ts.Node): string | null =>
    (ts.isPropertySignature(d) || ts.isMethodSignature(d) || ts.isPropertyDeclaration(d) || ts.isPropertyAssignment(d)
      || ts.isMethodDeclaration(d) || ts.isGetAccessor(d) || ts.isSetAccessor(d) || ts.isShorthandPropertyAssignment(d))
      && d.name && !ts.isComputedPropertyName(d.name) ? d.name.getText().replace(/^["']|["']$/g, "") : null;
  /** An interface or type-literal member: reached only through whatever satisfies it structurally. */
  const typeOnlyMember = (d: ts.Node | undefined): d is ts.PropertySignature | ts.MethodSignature =>
    !!d && !external(d) && (ts.isPropertySignature(d) || ts.isMethodSignature(d));

  /**
   * A type that a call could go through: a call signature on it or any union
   * member, or a type the checker cannot narrow (any, unknown, a type
   * parameter). A data member such as `report: ScanReport` is never a callee,
   * so the U2 name rule does not classify it.
   */
  function mayBeCallable(t: ts.Type): boolean {
    // Fail closed: only a provably non-callable type counts as data.
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter | ts.TypeFlags.NonPrimitive
      | ts.TypeFlags.Index | ts.TypeFlags.IndexedAccess | ts.TypeFlags.Conditional | ts.TypeFlags.Substitution)) return true;
    if (t.isUnionOrIntersection()) return t.types.some(mayBeCallable);
    if (t.getCallSignatures().length > 0) return true;
    const name = t.getSymbol()?.name;
    if (name === "Function" || name === "CallableFunction" || name === "NewableFunction") return true;
    // `{}` and other empty object types admit any function.
    if ((t.flags & ts.TypeFlags.Object) && t.getProperties().length === 0 && t.getConstructSignatures().length === 0
      && !checker.getIndexInfosOfType(t).length) return true;
    return false;
  }
  /** A member in N that the name rule skips because its type is provably data. */
  const dataMemberInN = (d: ts.Node | undefined): boolean => {
    if (!typeOnlyMember(d) || ts.isMethodSignature(d)) return false;
    const m = memberName(d);
    return !!m && N.has(m) && !mayBeCallable(checker.getTypeAtLocation(d));
  };
  const namedMember = (d: ts.Node | undefined): boolean => {
    if (!typeOnlyMember(d)) return false;
    const m = memberName(d);
    if (!m || !N.has(m)) return false;
    return ts.isMethodSignature(d) || mayBeCallable(checker.getTypeAtLocation(d));
  };

  /** `file#fn#kind#ordinal`, ordinal counted per (file, fn, kind) in source order. */
  const ordinals = new Map<ts.Node, string>();
  function keyOf(n: ts.Node, kind: string): string {
    const k = ordinals.get(n);
    if (k) return k;
    throw new Error(`scanner: no key for ${kind} at ${where(n)}`);
  }

  for (const sf of files) {
    const counts = new Map<string, number>();
    const visit = (n: ts.Node): void => {
      let kind: string | null = null;
      if (ts.isCatchClause(n)) kind = "catch";
      else if (isPromiseHandlerCall(n)) kind = "promise";
      if (kind) {
        const base = `${rel(sf)}#${namedFn(n).name}#${kind}`;
        const next = (counts.get(base) ?? 0) + 1;
        counts.set(base, next);
        ordinals.set(n, `${base}#${next}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  function isPromiseHandlerCall(n: ts.Node): n is ts.CallExpression {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return false;
    const m = n.expression.name.text;
    return m === "catch" || (m === "then" && n.arguments.length >= 2);
  }

  // ---- root, sinks, results --------------------------------------------------

  const rootSf = files.find((f) => rel(f) === opts.rootFile);
  if (!rootSf) throw new Error(`scanner: root file ${opts.rootFile} not in the program`);
  /** Each root writer declaration, by name. */
  const roots = new Map<ts.Node, string>();
  for (const name of [opts.rootName, ...(opts.extraRootNames ?? [])]) {
    let hit: ts.Node | undefined;
    rootSf.forEachChild((n) => {
      if (!hit && ts.isFunctionDeclaration(n) && n.name?.text === name) hit = canon(n);
    });
    if (!hit) throw new Error(`scanner: root ${name} not declared in ${opts.rootFile}`);
    roots.set(hit, name);
  }

  /** `file#fn` for a resolved project function symbol, or a dotted global path. */
  function symbolKey(callee: ts.Expression): string | null {
    const s = resolve(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(callee) ? callee.name : callee));
    const decl = s?.valueDeclaration ?? s?.declarations?.[0];
    if (decl && fileSet.has(decl.getSourceFile())) {
      const name = fnName(decl) ?? (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) ? decl.name.text : null);
      if (name) return `${rel(decl.getSourceFile())}#${name}`;
      return null;
    }
    return callee.getText().replace(/\s+/g, "");
  }

  /** `file#Container.member` for an injected slot (interface or type-literal member). */
  function slotKey(callee: ts.Expression): string | null {
    if (!ts.isPropertyAccessExpression(callee)) return null;
    const s = checker.getSymbolAtLocation(callee.name);
    const decl = s?.declarations?.[0];
    if (!decl || !(ts.isPropertySignature(decl) || ts.isMethodSignature(decl) || ts.isPropertyDeclaration(decl))) return null;
    let owner: ts.Node | undefined = decl.parent;
    if (ts.isTypeLiteralNode(owner)) owner = owner.parent;
    const name = owner && (ts.isInterfaceDeclaration(owner) || ts.isTypeAliasDeclaration(owner) || ts.isClassLike(owner)) && owner.name
      ? owner.name.text : "<anon>";
    return `${rel(decl.getSourceFile())}#${name}.${decl.name.getText()}`;
  }

  /** `file#fn(param)` for a parameter of a named function. */
  function paramSlot(p: ts.ParameterDeclaration): string | null {
    const fn = p.parent;
    const name = fnName(fn);
    if (!name || !ts.isIdentifier(p.name)) return null;
    return `${rel(fn.getSourceFile())}#${name}(${p.name.text})`;
  }

  const sinkSet = new Set(opts.registry.sinks);
  const resultSet = new Set(opts.registry.results);
  const edgeSinks = new Set(Object.values(opts.registry.edges));

  // RESULT helpers are checked once by their declared return type.
  for (const sf of files) {
    sf.forEachChild(function visit(n): void {
      const name = fnName(n);
      if (name && resultSet.has(`${rel(sf)}#${name}`)) {
        const sig = checker.getSignatureFromDeclaration(n as Fn);
        if (!sig || !nonThenable(checker.getReturnTypeOfSignature(sig))) {
          errors.push(`RESULT helper ${rel(sf)}#${name} may return a thenable or an unresolved type`);
        }
      }
      ts.forEachChild(n, visit);
    });
  }

  // ---- type predicates -------------------------------------------------------

  function nonThenable(t: ts.Type): boolean {
    const parts = t.isUnion() ? t.types : [t];
    for (const p of parts) {
      if (p.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return false;
      const then = checker.getPropertyOfType(p, "then");
      if (then) {
        const tt = checker.getTypeOfSymbol(then);
        if (tt.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
        if (checker.getSignaturesOfType(checker.getNonNullableType(tt), ts.SignatureKind.Call).length > 0) return false;
      }
    }
    return true;
  }

  /** A promise, an array or tuple of promises, or a type the checker cannot rule out. */
  function holdsPromise(t: ts.Type): boolean {
    if (!nonThenable(t)) return true;
    const parts = t.isUnion() ? t.types : [t];
    return parts.some((p) => (checker.isArrayType(p) || checker.isTupleType(p))
      && checker.getTypeArguments(p as ts.TypeReference).some((a) => !nonThenable(a)));
  }

  // ---- containment (rule 4) --------------------------------------------------

  function containingFunction(n: ts.Node): Fn | undefined {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isFunctionLike(p) && (p as Fn).body) return p as Fn;
    }
    return undefined;
  }

  function simpleValue(e: ts.Expression): boolean {
    e = skipParens(e);
    if (ts.isStringLiteral(e) || ts.isNumericLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
    if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isIdentifier(e)) return true;
    if (ts.isPropertyAccessExpression(e)) return simpleValue(e.expression);
    if (ts.isObjectLiteralExpression(e)) {
      return e.properties.every((p) =>
        (ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && simpleValue(p.initializer))
        || ts.isShorthandPropertyAssignment(p));
    }
    if (ts.isArrayLiteralExpression(e)) return e.elements.every((x) => !ts.isSpreadElement(x) && simpleValue(x));
    return false;
  }

  function skipParens(e: ts.Expression): ts.Expression {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    return e;
  }

  function skipOuter(e: ts.Expression): ts.Expression {
    for (;;) {
      e = skipParens(e);
      if (ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
      else return e;
    }
  }

  /** The outermost node a value flows through before its consumer: parentheses and assertions are transparent. */
  function outerOf(n: ts.Node): ts.Node {
    let c: ts.Node = n;
    while (c.parent && (ts.isParenthesizedExpression(c.parent) || ts.isAsExpression(c.parent) || ts.isNonNullExpression(c.parent)
      || ts.isSatisfiesExpression(c.parent) || ts.isTypeAssertionExpression(c.parent))) c = c.parent;
    return c;
  }
  const consumerOf = (n: ts.Node): ts.Node => outerOf(n).parent!;

  function hasCallOrAwait(n: ts.Node): boolean {
    let hit = false;
    const v = (x: ts.Node): void => {
      if (hit) return;
      if (ts.isCallExpression(x) || ts.isAwaitExpression(x) || ts.isNewExpression(x)) { hit = true; return; }
      if (ts.isFunctionLike(x)) return;
      ts.forEachChild(x, v);
    };
    v(n);
    return hit;
  }

  function containedStatement(s: ts.Statement, fn: Fn | undefined): boolean {
    if (ts.isBlock(s)) return s.statements.every((x) => containedStatement(x, fn));
    if (ts.isIfStatement(s)) {
      return !hasCallOrAwait(s.expression)
        && containedStatement(s.thenStatement, fn)
        && (!s.elseStatement || containedStatement(s.elseStatement, fn));
    }
    if (ts.isEmptyStatement(s)) return true;
    if (ts.isExpressionStatement(s)) {
      const e = skipParens(s.expression);
      // (a) a sink call, every argument free of calls and awaits
      if (ts.isCallExpression(e)) {
        const k = symbolKey(e.expression);
        return !!k && sinkSet.has(k) && e.arguments.every((a) => !hasCallOrAwait(a));
      }
      // (b) assignment to a local `let` of the enclosing function
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(e.left)) {
        const sym = checker.getSymbolAtLocation(e.left);
        const decl = sym?.valueDeclaration;
        if (!decl || !ts.isVariableDeclaration(decl)) return false;
        const list = decl.parent;
        if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Let)) return false;
        if (containingFunction(decl) !== fn) return false;
        return simpleValue(e.right);
      }
      return false;
    }
    if (ts.isReturnStatement(s)) {
      // (c)
      if (!s.expression) return true;
      const e = skipParens(s.expression);
      const literal = ts.isStringLiteral(e) || ts.isNumericLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)
        || e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword
        || (ts.isIdentifier(e) && e.text === "undefined");
      let shapeOk = literal || ts.isIdentifier(e);
      if (!shapeOk && ts.isCallExpression(e)) {
        const k = symbolKey(e.expression);
        shapeOk = !!k && resultSet.has(k) && e.arguments.every((a) => !ts.isAwaitExpression(skipParens(a)));
      }
      if (!shapeOk) return false;
      if (!nonThenable(checker.getTypeAtLocation(e))) return false;
      if (fn && (ts.getCombinedModifierFlags(fn as ts.Declaration) & ts.ModifierFlags.Async)) {
        const sig = checker.getSignatureFromDeclaration(fn);
        if (!sig) return false;
        const awaited = checker.getAwaitedType(checker.getReturnTypeOfSignature(sig));
        if (!awaited || !nonThenable(awaited)) return false;
      }
      return true;
    }
    return false;
  }

  function contained(c: ts.CatchClause): boolean {
    const fn = containingFunction(c);
    // (d) is the empty block: `every` over no statements.
    return c.block.statements.every((s) => containedStatement(s, fn));
  }

  // ---- collection --------------------------------------------------------------

  // Test-only exports: located first, so their initializers can be skipped.
  const testOnly = new Map<string, { decl: ts.VariableDeclaration; symbol: ts.Symbol }>();
  for (const key of opts.registry.testOnlyExports) {
    const [file, name] = key.split("#");
    const sf = files.find((f) => rel(f) === file);
    let hit: ts.VariableDeclaration | undefined;
    sf?.statements.forEach((st) => {
      if (!ts.isVariableStatement(st)) return;
      if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return;
      if (!(st.declarationList.flags & ts.NodeFlags.Const)) return;
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) hit = d;
      }
    });
    const symbol = hit ? checker.getSymbolAtLocation(hit.name) : undefined;
    if (!hit || !symbol) errors.push(`stale test-only export ${key} (no exported const with an initializer)`);
    else testOnly.set(key, { decl: hit, symbol });
  }
  const testOnlyInits = new Set<ts.Node>([...testOnly.values()].map((t) => t.decl.initializer!));

  const writers = new Set<ts.Node>(roots.keys());
  /** Anonymous closures an escaping writer error leaves through (U1a). */
  const writerClosures = new Set<ts.Node>();
  const calls: ts.CallExpression[] = [];
  const news: ts.NewExpression[] = [];
  const refs: ts.Identifier[] = [];
  const vars: ts.VariableDeclaration[] = [];
  const props: ts.PropertyDeclaration[] = [];
  const awaits: ts.AwaitExpression[] = [];
  const closures: Closure[] = [];
  const objMembers: ts.ObjectLiteralElementLike[] = [];
  const thisRefs: ts.Node[] = [];
  /** The assignment operators whose result is the right operand's value: `=` and the logical ones. */
  const assignOps = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken]);
  /** R3-2: every syntactic write (an assignment of any operator, an assignment-form loop, `++`, `--`, `delete`), enumerated once below. */
  const writeNodes: ts.Node[] = [];
  const decorators: ts.Decorator[] = [];
  for (const sf of files) {
    const v = (n: ts.Node): void => {
      if (testOnlyInits.has(n)) return;
      if (ts.isCallExpression(n)) calls.push(n);
      if (ts.isNewExpression(n)) news.push(n);
      if (ts.isIdentifier(n)) refs.push(n);
      if (n.kind === ts.SyntaxKind.ThisKeyword) thisRefs.push(n);
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) vars.push(n);
      if (ts.isPropertyDeclaration(n)) props.push(n);
      if (ts.isAwaitExpression(n)) awaits.push(n);
      if (isClosure(n)) closures.push(n);
      if (ts.isObjectLiteralExpression(n)) objMembers.push(...n.properties);
      if (ts.isDecorator(n)) decorators.push(n);
      if ((ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
        || ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && !ts.isVariableDeclarationList(n.initializer))
        || ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
          && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken))
        || ts.isDeleteExpression(n)) writeNodes.push(n);
      ts.forEachChild(n, v);
    };
    v(sf);
  }
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]); };
  const targetDecl = (e: ts.Expression): ts.Node | undefined => {
    e = skipOuter(e);
    if (ts.isIdentifier(e)) return declOf(checker.getSymbolAtLocation(e));
    if (ts.isPropertyAccessExpression(e)) return declOf(checker.getSymbolAtLocation(e.name));
    return undefined;
  };

  // ---- the write-target enumerator (R3-2) ---------------------------------------------

  /**
   * What a write's target receives: a value; a member of the destructured
   * type (undefined when the scan cannot name it); an element of an iterated
   * value; or something opaque (an arithmetic result, a key string, a deletion).
   */
  type WriteFrom = { readonly kind: "value"; readonly expr: ts.Expression }
    | { readonly kind: "member"; readonly member: ts.Symbol | undefined }
    | { readonly kind: "iterated"; readonly expr: ts.Expression }
    | { readonly kind: "opaque" };
  /**
   * One write. The target is an identifier, a property access or an element
   * access, outer syntax skipped; `decl` is set where the target expression
   * cannot name its binding (a shorthand pattern member).
   */
  interface WriteSite { readonly target: ts.Expression; readonly decl?: ts.Node; readonly from: WriteFrom; readonly form: string; readonly at: ts.Node }
  /** A reflective write: its receiver, and the values whose members it copies in (assign and the prototype setters). */
  interface ReflectiveWrite { readonly at: ts.Node; readonly fn: string; readonly receiver: ts.Expression | undefined; readonly sources: readonly ts.Expression[] }
  /**
   * The one place writes are found. Every write-sensitive check (local value
   * flow, release identity, guarded-slot supply, provider discovery, the
   * escape and retention tests) reads these lists and walks no assignment of
   * its own.
   */
  const writeSites: WriteSite[] = [];
  const reflectiveWrites: ReflectiveWrite[] = [];
  /** The right operand of every `=`, `??=`, `||=` and `&&=`, a pattern's source included: a flow into the target's type. */
  const assignedValues: ts.Expression[] = [];
  /** The source of each top-level destructuring assignment, outer syntax skipped. */
  const patternSources = new Set<ts.Node>();
  /** An assignment pattern, at any depth. `src` is the value destructured when it is in hand (the top level only). */
  function patternSites(pat: ts.Expression, src: ts.Expression | null, type: ts.Type | undefined, form: string): void {
    pat = skipOuter(pat);
    const anyType = !type || !!(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
    const memberType = (m: ts.Symbol | undefined, at: ts.Node) => m ? checker.getTypeOfSymbolAtLocation(m, at) : undefined;
    const leaf = (e: ts.Expression, member: ts.Symbol | undefined, at: ts.Node): void => {
      e = skipOuter(e);
      // `{ m: f = d }`: the default is its own `=` write; the target is its left.
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) e = skipOuter(e.left);
      if (ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e)) { patternSites(e, null, member ? memberType(member, at) : undefined, form); return; }
      writeSites.push({ target: e, from: { kind: "member", member }, form, at });
    };
    if (ts.isObjectLiteralExpression(pat)) {
      for (const p of pat.properties) {
        if (ts.isSpreadAssignment(p)) {
          // A rest receives every member.
          const all = anyType ? [] : type!.getProperties();
          if (all.length === 0) writeSites.push({ target: skipOuter(p.expression), from: { kind: "member", member: undefined }, form, at: p });
          for (const m of all) writeSites.push({ target: skipOuter(p.expression), from: { kind: "member", member: m }, form, at: p });
          continue;
        }
        if (ts.isShorthandPropertyAssignment(p)) {
          const decl = declOf(checker.getShorthandAssignmentValueSymbol(p));
          writeSites.push({ target: p.name, decl, from: { kind: "member", member: anyType ? undefined : type!.getProperty(p.name.text) }, form, at: p });
          if (p.objectAssignmentInitializer) writeSites.push({ target: p.name, decl, from: { kind: "value", expr: p.objectAssignmentInitializer }, form: "default", at: p });
          continue;
        }
        if (!ts.isPropertyAssignment(p)) continue; // a method or an accessor is no pattern member
        const named = !ts.isComputedPropertyName(p.name);
        leaf(p.initializer, named && !anyType ? type!.getProperty(p.name.getText().replace(/^["']|["']$/g, "")) : undefined, p);
      }
      return;
    }
    if (ts.isArrayLiteralExpression(pat)) {
      const el = anyType ? undefined : checker.getIndexTypeOfType(type!, ts.IndexKind.Number);
      for (const x of pat.elements) {
        if (ts.isOmittedExpression(x)) continue;
        const e = ts.isSpreadElement(x) ? x.expression : x;
        const inner = skipOuter(ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken ? e.left : e);
        if (ts.isObjectLiteralExpression(inner) || ts.isArrayLiteralExpression(inner)) { patternSites(inner, null, ts.isSpreadElement(x) ? type : el, form); continue; }
        writeSites.push({ target: inner, from: src ? { kind: "iterated", expr: src } : { kind: "member", member: undefined }, form, at: x });
      }
      return;
    }
    writeSites.push({ target: pat, from: src ? { kind: "value", expr: src } : { kind: "member", member: undefined }, form, at: pat });
  }
  for (const n of writeNodes) {
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      const left = skipOuter(n.left);
      if (assignOps.has(op)) assignedValues.push(n.right);
      if (op === ts.SyntaxKind.EqualsToken && (ts.isObjectLiteralExpression(left) || ts.isArrayLiteralExpression(left))) {
        // `({ m } = x)`, `({ m: alias } = x)`, `({ a: { m } } = x)`, `[f] = xs`: the targets receive x's members or xs's elements.
        patternSources.add(skipOuter(n.right));
        patternSites(left, n.right, checker.getTypeAtLocation(n.right), "destructuring");
        continue;
      }
      writeSites.push({ target: left, from: assignOps.has(op) ? { kind: "value", expr: n.right } : { kind: "opaque" }, form: ts.tokenToString(op)!, at: n });
    } else if (ts.isForOfStatement(n) || ts.isForInStatement(n)) {
      // S2: `for (f of xs)` and `for ({ m: f } of xs)` receive an element of xs, or its members; `for (k in o)` binds a key string.
      const target = skipOuter(n.initializer as ts.Expression);
      const form = ts.isForOfStatement(n) ? "for-of" : "for-in";
      if (ts.isObjectLiteralExpression(target) || ts.isArrayLiteralExpression(target)) {
        const t = ts.isForOfStatement(n) ? checker.getTypeAtLocation(n.expression) : undefined;
        const anyT = !t || !!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
        patternSites(target, null, anyT ? undefined : checker.getIndexTypeOfType(t, ts.IndexKind.Number), form);
      } else {
        writeSites.push({ target, from: ts.isForOfStatement(n) ? { kind: "iterated", expr: n.expression } : { kind: "opaque" }, form, at: n });
      }
    } else if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) {
      writeSites.push({ target: skipOuter(n.operand), from: { kind: "opaque" }, form: n.operator === ts.SyntaxKind.PlusPlusToken ? "++" : "--", at: n });
    } else if (ts.isDeleteExpression(n)) {
      writeSites.push({ target: skipOuter(n.expression), from: { kind: "opaque" }, form: "delete", at: n });
    }
  }
  /**
   * Whether an element access may write `__proto__`, judged by its key's type (so a constant counts): "__proto__"
   * when the key is, or is a union holding, that literal; null when every member is another string literal, a
   * number literal or a symbol (a symbol is never the string "__proto__"); "*" when the checker cannot reduce it.
   */
  const elementKey = (k: ts.Expression): string | null => {
    const t = checker.getTypeAtLocation(k);
    const parts = t.isUnion() ? t.types : [t];
    if (parts.some((p) => p.isStringLiteral() && p.value === "__proto__")) return "__proto__";
    return parts.every((p) => p.isStringLiteral() || p.isNumberLiteral() || (p.flags & ts.TypeFlags.ESSymbolLike)) ? null : "*";
  };
  /**
   * R4-1: prototype mutation is a property of the write target, not of the
   * syntax. Every enumerated write whose target names `__proto__` (a dot or a
   * literal element key, under any operator, pattern or loop) replaces the
   * receiver's prototype; its value, when it has one, supplies the members.
   * A computed key the checker cannot reduce is held for the sensitive-type
   * test below.
   */
  const protoUnknownKeys: ts.ElementAccessExpression[] = [];
  for (const s of writeSites) {
    const t = s.target;
    let receiver: ts.Expression | undefined;
    if (ts.isPropertyAccessExpression(t) && t.name.text === "__proto__") receiver = t.expression;
    else if (ts.isElementAccessExpression(t)) {
      const k = elementKey(t.argumentExpression);
      if (k === "__proto__") receiver = t.expression;
      else if (k === "*") protoUnknownKeys.push(t);
    }
    if (receiver) reflectiveWrites.push({ at: s.at, fn: "__proto__", receiver, sources: s.from.kind === "value" ? [s.from.expr] : [] });
  }
  /**
   * The default-library identity of what an expression evaluates to, by the
   * symbol of its type: `ObjectConstructor.assign`, `Reflect.set`, `eval`,
   * `ProxyConstructor`. Aliases, destructured copies and typed copies resolve
   * like the original; anything outside the default library is null.
   */
  function libIdentity(e: ts.Node): string | null {
    return libTypeIdentity(checker.getTypeAtLocation(e));
  }
  function libTypeIdentity(t: ts.Type): string | null {
    const decls = t.getSymbol()?.declarations ?? [];
    const d = decls[0];
    if (!d || !decls.every((x) => program.isSourceFileDefaultLibrary(x.getSourceFile()))) return null;
    if (!ts.isInterfaceDeclaration(d) && !ts.isFunctionDeclaration(d) && !ts.isMethodSignature(d)) return null;
    const name = d.name?.getText();
    if (!name) return null;
    if (ts.isInterfaceDeclaration(d)) return name;
    if (ts.isInterfaceDeclaration(d.parent)) return `${d.parent.name.text}.${name}`;
    if (ts.isModuleBlock(d.parent)) return `${d.parent.parent.name.getText()}.${name}`;
    return name;
  }
  const REFLECTIVE_WRITERS = new Map([["ObjectConstructor.assign", "Object.assign"], ["ObjectConstructor.defineProperty", "Object.defineProperty"],
    ["ObjectConstructor.defineProperties", "Object.defineProperties"], ["ObjectConstructor.setPrototypeOf", "Object.setPrototypeOf"],
    ["Reflect.set", "Reflect.set"], ["Reflect.defineProperty", "Reflect.defineProperty"], ["Reflect.setPrototypeOf", "Reflect.setPrototypeOf"]]);
  /** Default-library values that run code or build objects the scan cannot see: any reference is UNRESOLVED. */
  const OPAQUE_LIB = new Map([["eval", "eval"], ["FunctionConstructor", "the Function constructor"], ["Reflect.construct", "Reflect.construct"]]);
  /** The names a reflective writer or an opaque value is reached by; an alias is caught at the reference it copies. */
  const LIB_NAMES = new Set(["assign", "defineProperty", "defineProperties", "setPrototypeOf", "set", "construct", "eval", "Function", "Proxy", "revocable"]);
  /** The direct callee (or `new` target) of a call, through parentheses and assertions. */
  const directCall = (e: ts.Node): ts.CallExpression | ts.NewExpression | undefined => {
    const o = outerOf(e);
    const p = o.parent;
    return p && (ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === o ? p : undefined;
  };
  const libRefs = new Set<ts.Node>();
  for (const id of refs) {
    if (!LIB_NAMES.has(id.text) || inTypePosition(id)) continue;
    const parent = id.parent;
    // The member of an access (`Object.assign`, `Reflect.set`) stands for the access; a declaration's own name is no reference.
    if (ts.isPropertyAccessExpression(parent) && parent.name === id) libRefs.add(parent);
    else if (!(ts.isPropertyAccessExpression(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent) || ts.isMethodDeclaration(parent)
      || ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent)
      || ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) || (parent as ts.NamedDeclaration).name !== id) libRefs.add(id);
  }
  // An element access, a destructured copy and a callee can reach a writer by any name.
  for (const sf of files) {
    sf.forEachChild(function visit(n): void {
      if (testOnlyInits.has(n)) return;
      if (ts.isElementAccessExpression(n)) libRefs.add(n);
      if (ts.isBindingElement(n) && !n.dotDotDotToken) libRefs.add(n.name);
      ts.forEachChild(n, visit);
    });
  }
  for (const c of calls) libRefs.add(c.expression);
  for (const e of libRefs) {
    const id = libIdentity(e);
    if (!id) continue;
    const fn = REFLECTIVE_WRITERS.get(id);
    const call = directCall(e);
    if (fn) {
      if (call && ts.isCallExpression(call)) {
        const [receiver, ...rest] = call.arguments;
        reflectiveWrites.push({ at: call, fn, receiver, sources: fn === "Object.assign" ? rest : fn.endsWith("setPrototypeOf") ? rest.slice(0, 1) : [] });
      } else errors.push(`UNRESOLVED reflective writer reference ${fn} at ${where(e)}`);
      continue;
    }
    const opaque = OPAQUE_LIB.get(id);
    if (opaque) { errors.push(`UNRESOLVED ${opaque} reference at ${where(e)}`); continue; }
    if (id === "ProxyConstructor" && !(call && ts.isNewExpression(call))) errors.push(`UNRESOLVED Proxy reference at ${where(e)}`);
  }
  // __defineGetter__ and __defineSetter__ have no library declaration: their name is the only identity.
  for (const c of calls) {
    const callee = skipOuter(c.expression);
    if (ts.isPropertyAccessExpression(callee) && (callee.name.text === "__defineGetter__" || callee.name.text === "__defineSetter__")) {
      reflectiveWrites.push({ at: c, fn: callee.name.text, receiver: callee.expression, sources: [] });
    }
  }
  // A destructuring assignment that copies a writer out (`({ assign: a } = Object)`) is a reference that is not a call.
  for (const s of writeSites) {
    if (s.from.kind !== "member" || !s.from.member) continue;
    const id = libTypeIdentity(checker.getTypeOfSymbolAtLocation(s.from.member, s.at));
    const fn = id && REFLECTIVE_WRITERS.get(id);
    if (fn) errors.push(`UNRESOLVED reflective writer reference ${fn} at ${where(s.at)}`);
    else if (id && OPAQUE_LIB.has(id)) errors.push(`UNRESOLVED ${OPAQUE_LIB.get(id)} reference at ${where(s.at)}`);
  }
  for (const d of decorators) errors.push(`UNRESOLVED decorator at ${where(d)}`);
  /** Each write site by the node naming its target (the identifier, or the member name of an access), for the escape and release tests. */
  const writesByName = new Map<ts.Node, WriteSite[]>();
  for (const s of writeSites) {
    const t = s.target;
    push(writesByName, ts.isPropertyAccessExpression(t) ? t.name : t, s);
  }
  /** Each value-form write by its value expression, outer syntax skipped (the retention test). */
  const writeOfValue = new Map<ts.Node, WriteSite>();
  for (const s of writeSites) if (s.from.kind === "value") writeOfValue.set(skipOuter(s.from.expr), s);
  const siteDecl = (s: WriteSite): ts.Node | undefined => s.decl ?? targetDecl(s.target);

  /** decl -> every value assigned to it after its declaration (U1b). */
  const assigned = new Map<ts.Node, ts.Expression[]>();
  /** decl -> the source members it receives through an assignment pattern (A1). */
  const assignedMembers = new Map<ts.Node, ts.Node[]>();
  /** decl -> the expressions whose elements it receives through an array pattern or a for-of target (S2). */
  const assignedIterated = new Map<ts.Node, ts.Expression[]>();
  /** Pattern positions whose source member the scan cannot name (a computed key, an unknown type): UNRESOLVED (S2). */
  const unknownPatternMembers = new Set<ts.Node>();
  /** decl -> each write whose value is opaque to it (an arithmetic result, a key string, a deletion). */
  const assignedOpaque = new Map<ts.Node, ts.Node[]>();
  for (const s of writeSites) {
    const d = siteDecl(s);
    if (!d) continue;
    if (s.from.kind === "value") push(assigned, d, s.from.expr);
    else if (s.from.kind === "iterated") push(assignedIterated, d, s.from.expr);
    else if (s.from.kind === "opaque") push(assignedOpaque, d, s.at);
    else {
      const md = s.from.member ? declOf(s.from.member) : undefined;
      if (md) push(assignedMembers, d, md);
      else { push(assignedMembers, d, s.at); unknownPatternMembers.add(s.at); }
    }
  }

  // A test-only export is referenced by tests alone: any src reference other
  // than its own declaration name is a production path into it.
  const testOnlyDecls = new Map<ts.Node, string>([...testOnly].map(([key, t]) => [t.decl, key] as const));
  for (const id of refs) {
    const d = declOf(checker.getSymbolAtLocation(id));
    const key = d && testOnlyDecls.get(d);
    if (!key) continue;
    if (id === testOnly.get(key)!.decl.name) continue;
    errors.push(`test-only export ${key} is referenced from src at ${where(id)}`);
  }

  // ---- writer classification -------------------------------------------------------

  /**
   * U2: every NAME under which a writer is reachable as a member. A call or a
   * read through an interface or type-literal member with one of these names
   * is a writer: a conservative stand-in for structural satisfaction.
   */
  let N = new Set<string>();
  function computeN(): Set<string> {
    const n = new Set<string>();
    for (const d of writers) {
      const name = memberName(d);
      if (name) n.add(name);
    }
    for (const p of objMembers) {
      if (ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && valueIsWriter(p.initializer)) {
        n.add(p.name.getText().replace(/^["']|["']$/g, ""));
      }
      if (ts.isShorthandPropertyAssignment(p)) {
        const d = declOf(checker.getShorthandAssignmentValueSymbol(p));
        if (d && writers.has(d)) n.add(p.name.text);
      }
    }
    for (const slot of edgeSinks) {
      const m = /\.([^.#()]+)$/.exec(slot);
      if (m) n.add(m[1]!);
    }
    return n;
  }

  /** The values a local or field takes: its initializer, every assignment, and a for-of source (U1b). */
  function sourcesOf(d: ts.Node): { exprs: ts.Expression[]; members: ts.Node[]; iterated: ts.Expression[] } {
    const exprs: ts.Expression[] = [];
    const iterated: ts.Expression[] = [];
    if ((ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d)) && d.initializer) exprs.push(d.initializer);
    if (ts.isVariableDeclaration(d) && ts.isVariableDeclarationList(d.parent) && ts.isForOfStatement(d.parent.parent)) {
      iterated.push(d.parent.parent.expression);
    }
    exprs.push(...(assigned.get(d) ?? []));
    iterated.push(...(assignedIterated.get(d) ?? []));
    // An opaque write (an arithmetic result, a key string, a deletion) is a source the scan cannot follow (R3-2).
    return { exprs, members: [...(assignedMembers.get(d) ?? []), ...(assignedOpaque.get(d) ?? [])], iterated };
  }

  /** A declaration that stands for a writer: in the set, an interface member named in N, or a registered slot. */
  function declIsWriter(d: ts.Node | undefined): boolean {
    if (!d) return false;
    if (writers.has(d)) return true;
    if (typeOnlyMember(d)) return namedMember(d);
    if (ts.isParameter(d)) { const s = paramSlot(d); return !!s && edgeSinks.has(s); }
    return false;
  }

  /** The value of e may be a writer, a writer closure, or a promise built from one. */
  function valueIsWriter(e: ts.Expression): boolean {
    e = skipOuter(e);
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken) {
        return valueIsWriter(e.left) || valueIsWriter(e.right);
      }
      if (op === ts.SyntaxKind.CommaToken) return valueIsWriter(e.right);
      return false;
    }
    if (ts.isConditionalExpression(e)) return valueIsWriter(e.whenTrue) || valueIsWriter(e.whenFalse);
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "bind") {
      return valueIsWriter(e.expression.expression);
    }
    // A promise built from a writer settles with its error wherever it is awaited.
    if (ts.isCallExpression(e) || ts.isNewExpression(e)) {
      if (!holdsPromise(checker.getTypeAtLocation(e))) return false;
      return subtreeHas(e, (x) => (ts.isCallExpression(x) && isWriterCall(x)) || (ts.isIdentifier(x) && isWriterLocal(x))
        || (isClosure(x) && writerClosures.has(x)));
    }
    if (ts.isArrayLiteralExpression(e)) {
      return e.elements.some((x) => !ts.isOmittedExpression(x) && valueIsWriter(ts.isSpreadElement(x) ? x.expression : x));
    }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
      return declIsWriter(declOf(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e)));
    }
    if (isClosure(e)) return writerClosures.has(e) || writers.has(e.parent);
    return false;
  }

  function subtreeHas(n: ts.Node, hit: (x: ts.Node) => boolean): boolean {
    let got = false;
    const v = (x: ts.Node): void => {
      if (got) return;
      if (hit(x)) { got = true; return; }
      ts.forEachChild(x, v);
    };
    v(n);
    return got;
  }

  const isWriterLocal = (id: ts.Identifier): boolean => {
    const d = declOf(checker.getSymbolAtLocation(id));
    return !!d && (ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d)) && writers.has(d);
  };
  const calleeDecl = (c: ts.CallExpression): ts.Node | undefined => {
    const e = skipOuter(c.expression);
    return declOf(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e));
  };
  const isWriterCall = (c: ts.CallExpression): boolean => {
    if (declIsWriter(calleeDecl(c))) return true;
    const e = skipOuter(c.expression);
    if (isClosure(e) && writerClosures.has(e)) return true;
    const slot = slotKey(e);
    return !!slot && edgeSinks.has(slot);
  };
  /** `await x` where `x` is a writer-carrying local or field, or a writer-classified binding or slot. */
  const isWriterAwait = (a: ts.AwaitExpression): boolean => {
    const e = skipOuter(a.expression);
    if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return false;
    return declIsWriter(declOf(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e)));
  };

  /**
   * Walk outward from a writer call to the enclosing NAMED function, through
   * anonymous callbacks. Every catch a synchronous throw passes is reached
   * (and is recorded); a contained one stops it. A returned promise's
   * rejection passes the function's catches unreached (S1). Returns whether the error escapes, and
   * marks each anonymous closure it leaves as a writer closure (U1a).
   */
  function escapes(c: ts.Node, record: boolean): boolean {
    // S1: a returned writer promise rejects after the function has left every
    // try it was returned from, so a catch there sees only a synchronous throw:
    // it is reached, but it cannot contain the rejection. A promise awaited
    // inside the try settles there (the await is then its own site).
    let rejection = ts.isCallExpression(c) && inReturnedValue(c) && holdsPromise(checker.getTypeAtLocation(c));
    let sync = true;
    for (let child: ts.Node = c, p = c.parent; p; child = p, p = p.parent) {
      if (sync && ts.isTryStatement(p) && p.tryBlock === child && p.catchClause) {
        const isContained = contained(p.catchClause);
        if (record) {
          found.set(keyOf(p.catchClause, "catch"), isContained ? "contained" : "propagating");
          sites.set(keyOf(p.catchClause, "catch"), where(p.catchClause));
        }
        if (isContained) sync = false;
        if (!sync && !rejection) return false;
      }
      if (fnName(p)) return true;
      if (isClosure(p) && !record) writerClosures.add(p);
      // Leaving a closure, its returned rejection is the closure's settled
      // result, carried outward as before.
      if (ts.isFunctionLike(p)) { sync = sync || rejection; rejection = false; }
    }
    return true;
  }

  /** `return x` or an expression-bodied arrow's `x`. */
  const returnsValue = (n: ts.Node): boolean => {
    const c = consumerOf(n);
    return ts.isReturnStatement(c) || (isClosure(c) && c.body === outerOf(n));
  };
  /**
   * T1: n sits anywhere in a returned expression (a return operand or an
   * expression body) with no await and no function between: its promise may
   * become, or settle, the function's result, so it fails closed as returned.
   */
  const returnedOperandParents = (p: ts.Node): boolean => ts.isExpression(p) || ts.isPropertyAssignment(p)
    || ts.isShorthandPropertyAssignment(p) || ts.isSpreadAssignment(p) || ts.isTemplateSpan(p) || ts.isComputedPropertyName(p);
  function inReturnedValue(n: ts.Node): boolean {
    for (let child: ts.Node = n, p = n.parent; p; child = p, p = p.parent) {
      if (ts.isReturnStatement(p)) return true;
      if (isClosure(p)) return p.body === child;
      if (ts.isFunctionLike(p) || ts.isAwaitExpression(p) || !returnedOperandParents(p)) return false;
    }
    return false;
  }
  const returnRefs = refs.filter((id) => inReturnedValue(id));

  let grew = true;
  while (grew) {
    grew = false;
    N = computeN();
    const before = writerClosures.size;
    for (const c of calls) {
      if (!isWriterCall(c)) continue;
      if (!escapes(c, false)) continue;
      const owner = namedFn(c).node;
      const d = owner ? declOfFn(owner) : undefined;
      if (d && !writers.has(d)) { writers.add(d); grew = true; }
    }
    for (const a of awaits) {
      if (!isWriterAwait(a) || !escapes(a, false)) continue;
      const owner = namedFn(a).node;
      const d = owner ? declOfFn(owner) : undefined;
      if (d && !writers.has(d)) { writers.add(d); grew = true; }
    }
    // A local or field bound to a writer, a writer closure, a writer-classified
    // member, or a promise built from one is a writer: calls and awaits
    // through it are writer sites, and passing it on is a value escape.
    for (const d of [...vars, ...props]) {
      if (writers.has(d)) continue;
      const { exprs, members, iterated } = sourcesOf(d);
      if (exprs.some((e) => valueIsWriter(e)) || members.some((m) => declIsWriter(m)) || iterated.some((e) => valueIsWriter(e))) {
        writers.add(d);
        grew = true;
      }
    }
    // U1b: a function returning a writer promise settles with its error at the caller.
    for (const id of returnRefs) {
      if (!isWriterLocal(id) || !holdsPromise(checker.getTypeAtLocation(id))) continue;
      const owner = namedFn(id).node;
      const d = owner ? declOfFn(owner) : undefined;
      if (d && !writers.has(d)) { writers.add(d); grew = true; }
    }
    if (writerClosures.size !== before || computeN().size !== N.size) grew = true;
  }

  // A2: a writer-bearing accessor runs implicitly at a read or an assignment,
  // which no rule models, so it is refused outright.
  for (const d of writers) {
    if (ts.isGetAccessor(d) || ts.isSetAccessor(d)) errors.push(`writer-bearing accessor ${rel(d.getSourceFile())}#${fnName(d)} at ${where(d)}`);
  }

  // ---- coverage ------------------------------------------------------------------

  for (const c of calls) {
    if (isWriterCall(c)) escapes(c, true);
  }
  for (const a of awaits) {
    if (isWriterAwait(a)) escapes(a, true);
  }
  for (const c of calls) {
    if (!isPromiseHandlerCall(c)) continue;
    const recv = (c.expression as ts.PropertyAccessExpression).expression;
    const reaches = subtreeHas(recv, (n) => (ts.isCallExpression(n) && isWriterCall(n))
      || (ts.isIdentifier(n) && isWriterLocal(n)));
    if (reaches) { found.set(keyOf(c, "promise"), "handler"); sites.set(keyOf(c, "promise"), where(c)); }
  }

  // ---- UNRESOLVED (fail closed) ------------------------------------------------
  //
  // U1: a call through a parameter, a function-typed local or field, or a
  // FunctionType value is resolved: a writer reaches one only as a value,
  // which is an edge (rule 3), or through a member name in N (U2, A1). Locals
  // resolve through their initializer and every assignment; a value returned
  // from a call, read by element access, or from outside src stays UNRESOLVED.

  const CONCRETE = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.ArrowFunction,
    ts.SyntaxKind.FunctionExpression, ts.SyntaxKind.Constructor,
  ]);

  /** null when a function value is resolved; else the construct. */
  function unresolvedValue(e: ts.Expression, seen: Set<ts.Node>): string | null {
    e = skipOuter(e);
    if (isClosure(e)) return null;
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken) {
        return unresolvedValue(e.left, seen) ?? unresolvedValue(e.right, seen);
      }
      return "local-other";
    }
    if (ts.isConditionalExpression(e)) return unresolvedValue(e.whenTrue, seen) ?? unresolvedValue(e.whenFalse, seen);
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "bind") {
      return unresolvedValue(e.expression.expression, seen);
    }
    if (ts.isArrayLiteralExpression(e)) {
      for (const x of e.elements) {
        if (ts.isOmittedExpression(x)) continue;
        const u = unresolvedValue(ts.isSpreadElement(x) ? x.expression : x, seen);
        if (u) return u;
      }
      return null;
    }
    if (ts.isCallExpression(e) || ts.isAwaitExpression(e)) return "call-result";
    if (ts.isElementAccessExpression(e)) return "element-access";
    if (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === "undefined")) return null;
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
      return unresolvedDecl(declOf(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e)), seen);
    }
    return "local-other";
  }

  function unresolvedDecl(d: ts.Node | undefined, seen: Set<ts.Node>): string | null {
    if (!d) return "untyped";
    if (external(d)) return "outside-src";
    if (CONCRETE.has(d.kind) || ts.isParameter(d) || typeOnlyMember(d)) return null;
    if (ts.isBindingElement(d)) {
      if (d.dotDotDotToken) return "rest-binding";
      const nameNode = d.propertyName ?? d.name;
      return ts.isComputedPropertyName(nameNode) ? "computed-binding" : "binding";
    }
    if (ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d) || ts.isPropertyAssignment(d)) {
      if (seen.has(d)) return null;
      seen.add(d);
      if (ts.isPropertyAssignment(d)) return unresolvedValue(d.initializer, seen);
      const { exprs, members, iterated } = sourcesOf(d);
      if (exprs.length === 0 && members.length === 0 && iterated.length === 0) return "no-source";
      for (const x of [...exprs, ...iterated]) { const u = unresolvedValue(x, seen); if (u) return u; }
      for (const m of members) { const u = unresolvedDecl(m, seen); if (u) return u; }
      return null;
    }
    return `decl:${ts.SyntaxKind[d.kind]}`;
  }

  /**
   * S2: whether a value may hold a pattern member the scan cannot name. It
   * follows every route unresolvedValue and unresolvedDecl follow (locals,
   * fields, iterated sources, members, object properties, ?? || &&, ?:, bind,
   * array literals) and every one, not only the first unresolved, so a rebind
   * fails closed even when the callee's declared signature is concrete.
   */
  function valueRebindsUnknown(e: ts.Expression, seen: Set<ts.Node>): boolean {
    e = skipOuter(e);
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken) {
        return valueRebindsUnknown(e.left, seen) || valueRebindsUnknown(e.right, seen);
      }
      return false;
    }
    if (ts.isConditionalExpression(e)) return valueRebindsUnknown(e.whenTrue, seen) || valueRebindsUnknown(e.whenFalse, seen);
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "bind") {
      return valueRebindsUnknown(e.expression.expression, seen);
    }
    if (ts.isArrayLiteralExpression(e)) {
      return e.elements.some((x) => !ts.isOmittedExpression(x) && valueRebindsUnknown(ts.isSpreadElement(x) ? x.expression : x, seen));
    }
    if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return false;
    return declRebindsUnknown(declOf(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e)), seen);
  }

  function declRebindsUnknown(d: ts.Node | undefined, seen: Set<ts.Node>): boolean {
    if (!d || seen.has(d)) return false;
    seen.add(d);
    if (unknownPatternMembers.has(d)) return true;
    if (ts.isPropertyAssignment(d)) return valueRebindsUnknown(d.initializer, seen);
    if (ts.isShorthandPropertyAssignment(d)) return declRebindsUnknown(declOf(checker.getShorthandAssignmentValueSymbol(d)), seen);
    if (!ts.isVariableDeclaration(d) && !ts.isPropertyDeclaration(d)) return false;
    const { exprs, members, iterated } = sourcesOf(d);
    return members.some((m) => declRebindsUnknown(m, seen)) || [...exprs, ...iterated].some((x) => valueRebindsUnknown(x, seen));
  }

  /** null when the callee is resolved (a writer, a concrete or U1-resolved function, or external); else the construct. */
  function unresolvedCallee(c: ts.CallExpression): string | null {
    if (isWriterCall(c)) return null;
    if (c.expression.kind === ts.SyntaxKind.ImportKeyword || c.expression.kind === ts.SyntaxKind.SuperKeyword) return null;
    // A local or field rebound, directly or through an alias, from a member the
    // scan cannot name fails closed, whatever its declared initializer resolves to.
    const callee = skipOuter(c.expression);
    if (valueRebindsUnknown(callee, new Set())) return "pattern-member";
    const sig = checker.getResolvedSignature(c)?.declaration;
    if (sig && external(sig)) return null;
    if (sig && CONCRETE.has(sig.kind)) return null;
    const e = skipOuter(c.expression);
    if (ts.isElementAccessExpression(e)) return "element-access";
    if (ts.isCallExpression(e)) return "call-result";
    const d = declOf(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e));
    if (!d) return sig ? null : "untyped";
    // A data member in N called after a cast or assertion: never silently a non-writer.
    if (dataMemberInN(d)) return "cast-data-member";
    return unresolvedDecl(d, new Set());
  }

  /** The first catch an error at n meets before leaving its named function. */
  function firstCatch(n: ts.Node): ts.CatchClause | undefined {
    for (let child: ts.Node = n, p = n.parent; p; child = p, p = p.parent) {
      if (ts.isTryStatement(p) && p.tryBlock === child && p.catchClause) return p.catchClause;
      if (fnName(p)) return undefined;
    }
    return undefined;
  }

  /** null when an awaited (or handled) promise value is resolved; else the construct. */
  function unresolvedPromise(e: ts.Expression): string | null {
    e = skipOuter(e);
    if (ts.isCallExpression(e)) return unresolvedCallee(e);
    if (ts.isNewExpression(e)) return null;
    if (!holdsPromise(checker.getTypeAtLocation(e))) return null;
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
      const d = declOf(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e));
      if (!d) return "promise-untyped";
      if (external(d) || ts.isParameter(d) || declIsWriter(d)) return null;
      if (typeOnlyMember(d)) return "promise-property";
      if (ts.isBindingElement(d)) return "promise-binding";
      if (ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d)) {
        const { exprs, iterated } = sourcesOf(d);
        for (const x of [...exprs, ...iterated]) {
          let inner: string | null = null;
          subtreeHas(x, (n) => {
            if (ts.isCallExpression(n)) inner = unresolvedCallee(n);
            return inner !== null;
          });
          if (inner) return `promise-local:${inner}`;
        }
        return null;
      }
      return `promise:${ts.SyntaxKind[d.kind]}`;
    }
    return null;
  }

  const unresolved = new Map<string, string>();
  const unresolvedCounts = new Map<string, number>();
  function report(n: ts.Node, text: string, construct: string): void {
    const base = `${rel(n.getSourceFile())}#${namedFn(n).name}#${text.replace(/\s+/g, "").slice(0, 80)}`;
    const k = (unresolvedCounts.get(base) ?? 0) + 1;
    unresolvedCounts.set(base, k);
    unresolved.set(`${base}#${k}`, construct);
    sites.set(`${base}#${k}`, where(n));
  }
  for (const c of calls) {
    if (!firstCatch(c)) continue;
    const u = unresolvedCallee(c);
    if (u) report(c, c.expression.getText(), u);
  }
  for (const a of awaits) {
    if (!firstCatch(a) || isWriterAwait(a)) continue;
    const e = skipOuter(a.expression);
    if (ts.isCallExpression(e)) continue; // the call is checked as a call
    const u = unresolvedPromise(e);
    if (u) report(a, `await ${a.expression.getText()}`, u);
  }
  // A handler on a promise the scan cannot resolve is reached the same way.
  for (const c of calls) {
    if (!isPromiseHandlerCall(c)) continue;
    const recv = skipOuter((c.expression as ts.PropertyAccessExpression).expression);
    const u = ts.isCallExpression(recv) ? unresolvedCallee(recv) : unresolvedPromise(recv);
    if (u) report(c, c.expression.getText(), `handler:${u}`);
  }
  // A1: a rest binding gathers members it cannot name; one of them may be a writer.
  for (const id of refs) {
    const d = declOf(checker.getSymbolAtLocation(id));
    if (!d || !ts.isBindingElement(d) || !d.dotDotDotToken || d.name === id) continue;
    if (checker.getTypeAtLocation(id).getProperties().some((p) => N.has(p.name)
      && mayBeCallable(checker.getTypeOfSymbolAtLocation(p, id)))) report(id, `...${id.text}`, "rest-binding");
  }

  // A writer constructor has no registry form: `new` cannot be caught by key.
  for (const n of news) {
    const d = checker.getResolvedSignature(n)?.declaration;
    if (d && writers.has(d)) errors.push(`writer constructor reached by new at ${where(n)}`);
  }

  // ---- lock entry (A7) -----------------------------------------------------------

  const fnKey = (d: ts.Node): string | null => {
    const name = fnName(d) ?? (ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) ? d.name.text : null);
    return name ? `${rel(d.getSourceFile())}#${name}` : null;
  };
  const lockEntries = new Set(opts.registry.lockEntries ?? [`${opts.rootFile}#${opts.lockName}`]);
  /** The pinned lock-entry slot: a callback argument of a lock-entry primitive, resolved by declaration. */
  function isLockEntryCallback(cl: ts.Node): boolean {
    const o = outerOf(cl);
    const call = o.parent;
    if (!call || !ts.isCallExpression(call) || !call.arguments.includes(o as ts.Expression)) return false;
    const d = calleeDecl(call);
    const k = d && fnKey(d);
    return !!k && lockEntries.has(k);
  }
  // Verified, not assumed: each primitive awaits its callback once, inside a
  // try whose finally releases.
  for (const key of lockEntries) {
    const [file, name] = [key.slice(0, key.lastIndexOf("#")), key.slice(key.lastIndexOf("#") + 1)];
    const sf = files.find((f) => rel(f) === file);
    let decl: ts.FunctionDeclaration | undefined;
    sf?.forEachChild((n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) decl = n; });
    if (!decl) { errors.push(`stale lock entry ${key}`); continue; }
    const cbs = decl.parameters.filter((p) => checker.getSignaturesOfType(checker.getTypeAtLocation(p), ts.SignatureKind.Call).length > 0);
    if (cbs.length !== 1) { errors.push(`lock entry ${key} must take exactly one callback parameter`); continue; }
    const cbSym = checker.getSymbolAtLocation(cbs[0]!.name);
    // ISS-1401: a destructured callback has no symbol, and neither has an unresolved identifier in any file.
    const uses = cbSym === undefined ? [] : refs.filter((r) => within(r, decl!) && r !== cbs[0]!.name && checker.getSymbolAtLocation(r) === cbSym);
    const invocations = uses.filter((u) => ts.isCallExpression(u.parent) && u.parent.expression === u);
    if (uses.length !== 1 || invocations.length !== 1) { errors.push(`lock-lifetime: lock entry ${key} must invoke its callback exactly once and nowhere else use it`); continue; }
    const inv = invocations[0]!.parent as ts.CallExpression;
    if (!ts.isAwaitExpression(consumerOf(inv))) { errors.push(`lock-lifetime: lock entry ${key} does not await its callback at ${where(inv)}`); continue; }
    const releaseErr = releaseError(decl, inv, opts.lockAcquisitions?.[key]);
    if (releaseErr) errors.push(`lock-lifetime: lock entry ${key} ${releaseErr}`);
  }

  /**
   * S7: the release is tied to the acquisition. It is a local of the entry
   * whose every value is an acquisition call made before the callback, called
   * directly in the finally of a try that awaits the callback. Outside that
   * finally it is never called or passed on; inside it, beyond the call, it may
   * only be tested for presence.
   */
  function releaseError(decl: ts.FunctionDeclaration, inv: ts.CallExpression, pinned?: { module: string; name: string }): string | null {
    const finals: ts.Block[] = [];
    for (let child: ts.Node = inv, p = inv.parent; p && p !== decl; child = p, p = p.parent) {
      if (ts.isTryStatement(p) && p.tryBlock === child && p.finallyBlock) finals.push(p.finallyBlock);
    }
    // One file: calls also need containingFunction(c) === decl, refs a local of decl (both parent-bound).
    const inside = (n: ts.Node, b: ts.Node) => n.pos >= b.pos && n.end <= b.end;
    // T2: exactly one acquisition, a call in the entry's own body before the
    // callback whose (awaited) result is callable; the release is its value.
    const callable = (t: ts.Type): boolean => {
      const a = checker.getAwaitedType(t) ?? t;
      return (a.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
        || (a.isUnion() ? a.types : [a]).some((x) => checker.getSignaturesOfType(x, ts.SignatureKind.Call).length > 0);
    };
    // One file: containingFunction(c) === decl walks c's parents to decl.
    const acquisitions = calls.filter((c) => c.end <= inv.pos && containingFunction(c) === decl && c.pos >= decl.pos && c.end <= decl.end
      && callable(checker.getTypeAtLocation(c)));
    if (acquisitions.length !== 1) return `must make exactly one acquisition before its callback, found ${acquisitions.length}`;
    const acq = acquisitions[0]!;
    const ad = calleeDecl(acq);
    const aFile = ad?.getSourceFile();
    const aName = ad && (ad as ts.NamedDeclaration).name ? (ad as ts.NamedDeclaration).name!.getText() : "<unresolved>";
    if (pinned && !(aFile && aName === pinned.name && (rel(aFile) === pinned.module || aFile.fileName.includes(`/${pinned.module}/`)))) {
      return `acquires by ${aName} at ${where(acq)}, not the pinned ${pinned.module}#${pinned.name}`;
    }
    // The lock target: the acquired path derives from the entry's parameters.
    const fromParams = (e: ts.Node, seen: Set<ts.Node>): boolean => subtreeHas(e, (x) => {
      if (!ts.isIdentifier(x)) return false;
      const d = declOf(checker.getSymbolAtLocation(x));
      if (!d || seen.has(d)) return false;
      seen.add(d);
      if (ts.isParameter(d)) return d.parent === decl;
      return ts.isVariableDeclaration(d) && containingFunction(d) === decl && !!d.initializer && fromParams(d.initializer, seen);
    });
    if (!acq.arguments[0] || !fromParams(acq.arguments[0], new Set())) return `acquires a lock target not derived from its parameters at ${where(acq)}`;
    const isAcquisition = (e: ts.Expression): boolean => {
      e = skipOuter(e);
      if (ts.isAwaitExpression(e)) e = skipOuter(e.expression);
      return e === acq;
    };
    for (const fin of finals) {
      for (const c of calls) {
        if (!inside(c, fin) || containingFunction(c) !== decl || !ts.isIdentifier(c.expression)) continue;
        const d = declOf(checker.getSymbolAtLocation(c.expression));
        if (!d || !ts.isVariableDeclaration(d) || !ts.isIdentifier(d.name) || containingFunction(d) !== decl) continue;
        // Every write to the release counts (R3-2): a loop, pattern or opaque write is never the acquisition.
        const writes = writeSites.filter((s) => siteDecl(s) === d);
        const sources = [...(d.initializer ? [d.initializer] : []), ...writes.map((s) => s.from.kind === "value" ? s.from.expr : s.at as ts.Expression)];
        if (sources.length === 0 || !sources.every(isAcquisition)) continue;
        const sym = checker.getSymbolAtLocation(d.name);
        const misuse = refs.find((r) => {
          if (r === d.name || checker.getSymbolAtLocation(r) !== sym) return false;
          const w = writesByName.get(r);
          if (w) return !w.every((s) => s.form === "=" && s.from.kind === "value" && isAcquisition(s.from.expr));
          const o = outerOf(r);
          const parent = o.parent;
          if (!inside(r, fin)) return true;
          if (ts.isCallExpression(parent) && parent.expression === o) return containingFunction(parent) !== decl;
          return !(ts.isIfStatement(parent) && parent.expression === o);
        });
        if (misuse) return `uses its release ${d.name.text} outside the finally at ${where(misuse)}`;
        return null;
      }
    }
    return "does not release in the finally of the try that awaits its callback";
  }

  const isAsyncLike = (cl: Closure): boolean => {
    if (ts.getCombinedModifierFlags(cl) & ts.ModifierFlags.Async || cl.asteriskToken) return true;
    const sig = checker.getSignatureFromDeclaration(cl);
    return !sig || !nonThenable(checker.getReturnTypeOfSignature(sig));
  };
  /** A call whose callee is the closure itself, or a parenthesised `??`, `||` or conditional with the closure as an operand (R-d). */
  function inPlaceCall(cl: ts.Node): ts.CallExpression | undefined {
    let o = outerOf(cl);
    for (;;) {
      const p = o.parent!;
      if (ts.isCallExpression(p) && p.expression === o) return p;
      if (ts.isBinaryExpression(p) && (p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        || p.operatorToken.kind === ts.SyntaxKind.BarBarToken)) { o = outerOf(p); continue; }
      if (ts.isConditionalExpression(p) && (p.whenTrue === o || p.whenFalse === o)) { o = outerOf(p); continue; }
      return undefined;
    }
  }
  /** The closure operands of a `??`, `||` or conditional expression (or the closure itself). */
  function closureOperands(e: ts.Expression): Closure[] {
    e = skipOuter(e);
    if (isClosure(e)) return [e];
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return [...closureOperands(e.left), ...closureOperands(e.right)];
    if (ts.isConditionalExpression(e)) return [...closureOperands(e.whenTrue), ...closureOperands(e.whenFalse)];
    return [];
  }
  function operandsOf(e: ts.Expression): ts.Expression[] {
    e = skipOuter(e);
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return [...operandsOf(e.left), ...operandsOf(e.right)];
    if (ts.isConditionalExpression(e)) return [...operandsOf(e.whenTrue), ...operandsOf(e.whenFalse)];
    return [e];
  }

  // ---- local functions (addendum 2, R-b) --------------------------------------------

  /** The const a closure is bound to, directly or as a `??`, `||` or conditional operand of its initializer. */
  function localFnBinding(cl: ts.Node): ts.VariableDeclaration | undefined {
    let o = outerOf(cl);
    for (;;) {
      const p = o.parent!;
      if (ts.isBinaryExpression(p) && (p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        || p.operatorToken.kind === ts.SyntaxKind.BarBarToken)) { o = outerOf(p); continue; }
      if (ts.isConditionalExpression(p) && (p.whenTrue === o || p.whenFalse === o)) { o = outerOf(p); continue; }
      if (ts.isVariableDeclaration(p) && p.initializer === o && ts.isIdentifier(p.name)
        && ts.isVariableDeclarationList(p.parent) && (p.parent.flags & ts.NodeFlags.Const)) return p;
      return undefined;
    }
  }
  const bindingRefs = new Map<ts.Node, ts.Identifier[]>();
  function refsTo(v: ts.VariableDeclaration): ts.Identifier[] {
    let r = bindingRefs.get(v);
    if (!r) {
      const sym = checker.getSymbolAtLocation(v.name);
      r = refs.filter((id) => id !== v.name && id.getSourceFile() === v.getSourceFile() && checker.getSymbolAtLocation(id) === sym);
      bindingRefs.set(v, r);
    }
    return r;
  }
  const isDirectCallRef = (id: ts.Identifier): boolean => {
    const c = consumerOf(id);
    return ts.isCallExpression(c) && outerOf(id) === c.expression;
  };
  /** R-b: every reference to the const is a direct call. */
  const isLocalFunction = (v: ts.VariableDeclaration): boolean => refsTo(v).every(isDirectCallRef);
  const localFnOf = (cl: ts.Node): ts.VariableDeclaration | undefined => {
    const v = localFnBinding(cl);
    return v && isLocalFunction(v) ? v : undefined;
  };

  // ---- awaited-callback primitives (addendum 2, R-a and R-a1) ----------------------------

  /**
   * R-a1, the one trusted adapter: `run` of an AsyncLocalStorage declared in
   * Node's `async_hooks` typings, resolved by the declaring symbol's provenance,
   * never by the method name alone. It invokes its callback synchronously, once,
   * and returns the callback's return value.
   */
  /**
   * The adapter's callback slot: `run(store, callback, ...args)` invokes its second argument and hands it any later
   * ones, so the callback must sit at index 1 with no spread before it.
   */
  const inCallbackSlot = (c: ts.CallExpression, index: number): boolean =>
    index === 1 && !c.arguments.slice(0, 2).some(ts.isSpreadElement);
  function isTrustedAdapterCall(c: ts.CallExpression): boolean {
    const e = skipOuter(c.expression);
    if (!ts.isPropertyAccessExpression(e)) return false;
    const d = resolve(checker.getSymbolAtLocation(e.name))?.declarations?.[0];
    if (!d || !external(d) || !(ts.isMethodDeclaration(d) || ts.isMethodSignature(d)) || d.name.getText() !== "run") return false;
    const owner = d.parent;
    if (!(ts.isClassDeclaration(owner) || ts.isInterfaceDeclaration(owner)) || owner.name?.text !== "AsyncLocalStorage") return false;
    for (let p: ts.Node | undefined = owner.parent; p; p = p.parent) {
      if (ts.isModuleDeclaration(p) && ts.isStringLiteral(p.name)) return p.name.text === "async_hooks" || p.name.text === "node:async_hooks";
    }
    return false;
  }

  const nearestFn = (n: ts.Node): Fn | undefined => containingFunction(n);
  function inLoop(n: ts.Node, host: ts.Node): boolean {
    for (let p: ts.Node | undefined = n.parent; p && p !== host; p = p.parent) {
      if (ts.isForStatement(p) || ts.isForOfStatement(p) || ts.isForInStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) return true;
    }
    return false;
  }
  /** Form 1 (the immediate operand of await) or form 2 (the immediate operand of return, outside a try or catch that has a finally). */
  function formOk(c: ts.Node): boolean {
    const o = outerOf(c);
    const parent = o.parent!;
    if (ts.isAwaitExpression(parent)) return true;
    if (isClosure(parent) && parent.body === o) return true;
    if (!ts.isReturnStatement(parent)) return false;
    for (let child: ts.Node = parent, p = parent.parent; p && !ts.isFunctionLike(p); child = p, p = p.parent) {
      if (ts.isTryStatement(p) && p.finallyBlock && (p.tryBlock === child || p.catchClause === child)) return false;
    }
    return true;
  }
  const callableParams = (fn: Fn): ts.ParameterDeclaration[] =>
    fn.parameters.filter((p) => checker.getSignaturesOfType(checker.getNonNullableType(checker.getTypeAtLocation(p)), ts.SignatureKind.Call).length > 0);

  const chainMembers = new Set<string>();
  /**
   * R-a: fn's callback parameter is never invoked, or invoked exactly once as
   * form 1 or 2, or handed (itself, or inside one closure that invokes it so)
   * to a delegate that passes the same check, or to the trusted adapter. Returns
   * why not, or null.
   */
  function verifyCallback(fn: Fn, param: ts.ParameterDeclaration, path: string, depth: number): string | null {
    if (depth > 8) return `${path}: delegation deeper than 8`;
    const body = fn.body;
    if (!body) return `${path}: no body to verify`;
    if (!ts.isIdentifier(param.name) || param.dotDotDotToken) return `${path}: the callback parameter is not a plain identifier`;
    const sym = checker.getSymbolAtLocation(param.name);
    // One file: the parameter name is an identifier (checked above), so sym is its parameter, local to fn.
    const uses = refs.filter((r) => r.pos >= body.pos && r.end <= body.end && checker.getSymbolAtLocation(r) === sym);
    if (uses.length > 1) return `${path}: the callback is referenced ${uses.length} times`;
    for (const u of uses) {
      const inner = nearestFn(u);
      let carrier: Closure | undefined;
      if (inner !== fn) {
        if (!inner || !isClosure(inner) || nearestFn(inner) !== fn) return `${path}: the callback is used inside a nested function at ${where(u)}`;
        carrier = inner;
      }
      const o = outerOf(u);
      const parent = o.parent!;
      if (ts.isCallExpression(parent) && parent.expression === o) {
        if (inLoop(parent, carrier ?? fn)) return `${path}: the callback is invoked inside a loop at ${where(parent)}`;
        if (!formOk(parent)) return `${path}: the callback's invocation at ${where(parent)} is neither awaited nor returned outside a releasing try`;
        if (!carrier) continue;
        const co = outerOf(carrier);
        const call = co.parent;
        if (!call || !ts.isCallExpression(call) || !call.arguments.includes(co as ts.Expression)) {
          return `${path}: the closure invoking the callback at ${where(carrier)} is not passed directly to a call`;
        }
        const r = delegate(call, call.arguments.indexOf(co as ts.Expression), fn, path, depth);
        if (r) return r;
        continue;
      }
      if (!carrier && ts.isCallExpression(parent) && parent.arguments.includes(o as ts.Expression)) {
        const r = delegate(parent, parent.arguments.indexOf(o as ts.Expression), fn, path, depth);
        if (r) return r;
        continue;
      }
      // A parameterless arrow whose whole body hands the callback to the trusted adapter's callback slot
      // (`() => als.run(store, fn)`) invokes it in place, as `() => fn()` would; the arrow itself is then
      // checked as that carrier is. Any other use of the callback inside a closure stays a value.
      if (carrier && ts.isArrowFunction(carrier) && carrier.parameters.length === 0 && carrier.body === outerOf(parent)
        && ts.isCallExpression(parent) && isTrustedAdapterCall(parent) && inCallbackSlot(parent, parent.arguments.indexOf(o as ts.Expression))) {
        const co = outerOf(carrier);
        const call = co.parent;
        if (!call || !ts.isCallExpression(call) || !call.arguments.includes(co as ts.Expression)) {
          return `${path}: the closure forwarding the callback at ${where(carrier)} is not passed directly to a call`;
        }
        const r = delegate(call, call.arguments.indexOf(co as ts.Expression), fn, path, depth);
        if (r) return r;
        continue;
      }
      return `${path}: the callback is used as a value at ${where(u)}`;
    }
    return null;
  }
  function delegate(call: ts.CallExpression, index: number, owner: Fn, path: string, depth: number): string | null {
    if (inLoop(call, owner)) return `${path}: the delegating call at ${where(call)} is inside a loop`;
    if (!formOk(call)) return `${path}: the delegating call at ${where(call)} is neither awaited nor returned outside a releasing try`;
    if (isTrustedAdapterCall(call)) {
      if (!inCallbackSlot(call, index)) return `${path}: the adapter at ${where(call)} receives the callback in the wrong position`;
      const releasing = ownTries(owner).find((t) => t.finallyBlock);
      // One file: call consumes a use inside owner's body, and the try is one of owner's own.
      if (releasing && !(call.pos >= releasing.tryBlock.pos && call.end <= releasing.tryBlock.end)) {
        return `${path}: the adapter call at ${where(call)} is outside the try whose finally releases`;
      }
      return null;
    }
    const sig = checker.getResolvedSignature(call)?.declaration;
    const target = sig && !external(sig) && ts.isFunctionLike(sig) && (sig as Fn).body ? sig as Fn : undefined;
    if (!target) return `${path}: the callback is handed to ${call.expression.getText()} at ${where(call)}, which the scan cannot follow (library-mediated)`;
    const param = target.parameters[index];
    if (!param) return `${path}: ${call.expression.getText()} has no parameter ${index}`;
    const key = fnKey(target) ?? `<fn ${where(target)}>`;
    chainMembers.add(key);
    return verifyCallback(target, param, `${path} -> ${key}`, depth + 1);
  }
  function ownTries(fn: Fn): ts.TryStatement[] {
    const out: ts.TryStatement[] = [];
    const v = (n: ts.Node): void => {
      if (n !== fn && ts.isFunctionLike(n)) return;
      if (ts.isTryStatement(n)) out.push(n);
      ts.forEachChild(n, v);
    };
    if (fn.body) v(fn.body);
    return out;
  }

  /** Pinned primitive declaration -> the index of its verified callback parameter. */
  const awaitedPrims = new Map<ts.Node, number>();
  for (const key of opts.registry.awaitedCallbackPrimitives ?? []) {
    const [file, name] = [key.slice(0, key.lastIndexOf("#")), key.slice(key.lastIndexOf("#") + 1)];
    const sf = files.find((f) => rel(f) === file);
    let decl: ts.FunctionDeclaration | undefined;
    sf?.forEachChild((n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) decl = n; });
    if (!decl) { errors.push(`stale awaited-callback primitive ${key}`); continue; }
    const cbs = callableParams(decl);
    if (cbs.length !== 1) { errors.push(`lock-lifetime: awaited-callback primitive ${key} must take exactly one callback parameter`); continue; }
    const why = verifyCallback(decl, cbs[0]!, key, 0);
    if (why) { errors.push(`lock-lifetime: awaited-callback primitive ${key} rejected: ${why}`); continue; }
    awaitedPrims.set(canon(decl), decl.parameters.indexOf(cbs[0]!));
  }

  const injected = opts.registry.injectedCallbackSlots ?? {};
  const testSeams = opts.registry.testSeamSlots ?? {};
  /** R-h1: edge receivers that may suspend, by their receiving call. */
  const asyncReceiverCalls = new Map<ts.CallExpression, string>();
  const usedSlots = new Set<string>();
  const wrapperVerdicts = new Map<ts.Node, string | null>();
  /** The callback index of a call to a pinned primitive, or to a const bound to verified wrappers and listed injected slots; else null. */
  function awaitedCallbackIndex(call: ts.CallExpression): number | null {
    const d = calleeDecl(call);
    if (!d) return null;
    const pinned = awaitedPrims.get(d);
    if (pinned !== undefined) return pinned;
    if (!ts.isVariableDeclaration(d) || !d.initializer || !ts.isVariableDeclarationList(d.parent) || !(d.parent.flags & ts.NodeFlags.Const)) return null;
    let index: number | null = null;
    for (const op of operandsOf(d.initializer)) {
      if (isClosure(op)) {
        const cbs = callableParams(op);
        if (cbs.length !== 1) return null;
        if (!wrapperVerdicts.has(op)) {
          // Addendum 3 R-f: a rejected verdict is not itself an error. It gives no
          // credit, so a closure that needs the credit fails under A5/A6.
          wrapperVerdicts.set(op, verifyCallback(op, cbs[0]!, `wrapper ${where(op)}`, 0));
        }
        if (wrapperVerdicts.get(op)) return null;
        index = op.parameters.indexOf(cbs[0]!);
        continue;
      }
      const slot = slotKey(op);
      if (!slot || !(slot in injected)) return null;
      usedSlots.add(slot);
    }
    return index;
  }
  /** R-a: a closure passed directly as the callback of an awaited-callback primitive. */
  function isAwaitedCallbackArg(cl: ts.Node): boolean {
    const o = outerOf(cl);
    const call = o.parent;
    if (!call || !ts.isCallExpression(call) || !call.arguments.includes(o as ts.Expression)) return false;
    const idx = awaitedCallbackIndex(call);
    return idx !== null && call.arguments.indexOf(o as ts.Expression) === idx;
  }
  // An injected awaited-callback slot is supplied only by tests: no src object literal fills it.
  for (const p of objMembers) {
    if (!(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)) || ts.isComputedPropertyName(p.name)) continue;
    const ctype = checker.getContextualType(p.parent as ts.ObjectLiteralExpression);
    const member = ctype?.getProperty(p.name.getText());
    const md = member?.declarations?.[0];
    if (!md || !(ts.isPropertySignature(md) || ts.isMethodSignature(md))) continue;
    let owner: ts.Node | undefined = md.parent;
    if (ts.isTypeLiteralNode(owner)) owner = owner.parent;
    const name = owner && (ts.isInterfaceDeclaration(owner) || ts.isTypeAliasDeclaration(owner)) ? owner.name.text : "<anon>";
    const key = `${rel(md.getSourceFile())}#${name}.${md.name.getText()}`;
    if (key in injected) errors.push(`injected awaited-callback slot ${key} is supplied in src at ${where(p)}`);
    if (key in testSeams) errors.push(`test-seam slot ${key} is supplied in src at ${where(p)}`);
  }
  for (const key of Object.keys(testSeams)) {
    if (!edgeSinks.has(key)) errors.push(`stale test-seam slot ${key}: no registered edge names it`);
  }
  // S6: a provider reaches the slot by more than a contextually typed literal.
  // Every value flowing into the slot's owner type (an argument, an
  // initializer, an assignment, a return, a property value, a spread) is
  // checked by its own type, and an assignment to the member itself is a supply.
  // A value whose member is the owner's own declaration is a forward of an
  // already checked provider; an untyped value cannot be established (fail closed).
  const guarded: { key: string; label: string; md: ts.Node; member: string }[] = [];
  /** Every value flowing anywhere a contextual type can receive it (S6, A1). */
  let flowsMemo: ts.Expression[] | undefined;
  function allFlows(): ts.Expression[] {
    if (flowsMemo) return flowsMemo;
    const flows: ts.Expression[] = [];
    for (const sf of files) {
      const v = (n: ts.Node): void => {
        if (testOnlyInits.has(n)) return;
        if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && n.arguments) flows.push(...n.arguments);
        else if (ts.isVariableDeclaration(n) && n.initializer) flows.push(n.initializer);
        else if (ts.isReturnStatement(n) && n.expression) flows.push(n.expression);
        else if (isClosure(n) && !ts.isBlock(n.body)) flows.push(n.body);
        else if (ts.isPropertyAssignment(n)) flows.push(n.initializer);
        else if (ts.isSpreadAssignment(n)) flows.push(n.expression);
        ts.forEachChild(n, v);
      };
      v(sf);
    }
    flows.push(...assignedValues);
    return (flowsMemo = flows);
  }
  const typeHolds = (t: ts.Type | undefined, owner: ts.Node): boolean =>
    !!t && (t.isUnion() || t.isIntersection() ? t.types : [t]).some((x) => (x.getSymbol()?.declarations ?? []).includes(owner as ts.Declaration));
  /** A2: guarded slot members; src never supplies them (S6), so a call through one runs a src default or a test provider. */
  const guardedMds = new Set<ts.Node>();
  for (const [label, keys] of [["injected awaited-callback slot", Object.keys(injected)], ["test-seam slot", Object.keys(testSeams)]] as const) {
    for (const key of keys) {
      const m = /^(.*)#([^.#]+)\.([^.#]+)$/.exec(key);
      const sf = m && files.find((f) => rel(f) === m[1]);
      let md: ts.Node | undefined;
      sf?.forEachChild((n) => {
        const members = ts.isInterfaceDeclaration(n) && n.name.text === m![2] ? n.members
          : ts.isTypeAliasDeclaration(n) && n.name.text === m![2] && ts.isTypeLiteralNode(n.type) ? n.type.members : undefined;
        md ??= members?.find((x) => x.name && x.name.getText() === m![3]);
      });
      if (md) { guarded.push({ key, label, md, member: m![3]! }); guardedMds.add(md); }
    }
  }
  if (guarded.length > 0) {
    const flows = allFlows();
    const once = (m: string): void => { if (!errors.includes(m)) errors.push(m); };
    /** T5: the slot name a computed key may hold: the constant, "*" when the checker cannot reduce it, or null for a number. */
    const computedKey = (k: ts.Expression): string | null => {
      const t = checker.getTypeAtLocation(k);
      if (t.isStringLiteral()) return t.value;
      if (t.isNumberLiteral() || t.flags & ts.TypeFlags.NumberLike) return null;
      return "*";
    };
    /** T5: an object literal's members, computed, accessor and spread ones included; named ones also meet the contextual check above. */
    const literalSupplies = (lit: ts.ObjectLiteralExpression, g: (typeof guarded)[number]): void => {
      for (const p of lit.properties) {
        if (ts.isSpreadAssignment(p)) {
          const x = skipOuter(p.expression);
          if (ts.isObjectLiteralExpression(x)) literalSupplies(x, g);
          continue;
        }
        if (!p.name) continue;
        const k = ts.isComputedPropertyName(p.name) ? computedKey(p.name.expression) : p.name.getText().replace(/^["']|["']$/g, "");
        if (k === g.member) once(`${g.label} ${g.key} is supplied in src at ${where(p)}`);
        else if (k === "*") once(`${g.label} ${g.key} may be supplied in src at ${where(p)} (computed key)`);
      }
    };
    /** T5: a write to the slot through an element access or a reflective write needs a receiver of the owner type. */
    const holdsOwner = (e: ts.Expression, g: (typeof guarded)[number]): boolean => {
      const t = checker.getTypeAtLocation(e);
      return !!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) ? false : typeHolds(t, g.md.parent);
    };
    for (const g of guarded) {
      // R3-2: every enumerated write (any operator, a pattern, a loop, `++`, `--`, `delete`) to the member is a supply.
      for (const w of writeSites) {
        const e = w.target;
        if (ts.isPropertyAccessExpression(e)) {
          if ((checker.getSymbolAtLocation(e.name)?.declarations ?? []).includes(g.md as ts.Declaration)) once(`${g.label} ${g.key} is supplied in src at ${where(w.at)}`);
        } else if (ts.isElementAccessExpression(e)) {
          if (!holdsOwner(e.expression, g)) continue;
          const k = computedKey(e.argumentExpression);
          if (k === g.member) once(`${g.label} ${g.key} is supplied in src at ${where(w.at)}`);
          else if (k === "*") once(`${g.label} ${g.key} may be supplied in src at ${where(w.at)} (computed key)`);
        }
      }
      for (const w of reflectiveWrites) {
        if (w.receiver && holdsOwner(w.receiver, g)) once(`${g.label} ${g.key} may be supplied in src at ${where(w.at)} (reflective write)`);
      }
      for (const e0 of flows) {
        const e = skipOuter(e0);
        const spread = ts.isSpreadAssignment(e0.parent);
        const target = spread ? checker.getContextualType(e0.parent.parent as ts.ObjectLiteralExpression) : checker.getContextualType(e0);
        if (!typeHolds(target, g.md.parent)) continue;
        if (ts.isObjectLiteralExpression(e)) { literalSupplies(e, g); continue; }
        const t = checker.getTypeAtLocation(e);
        if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) { errors.push(`${g.label} ${g.key} may be supplied in src at ${where(e)} (untyped provider)`); continue; }
        const prop = t.getProperty(g.member);
        if (prop && !(prop.declarations ?? []).every((x) => x === g.md)) errors.push(`${g.label} ${g.key} is supplied in src at ${where(e)}`);
      }
    }
  }

  const isIIFE = (cl: ts.Node): boolean => inPlaceCall(cl) !== undefined;
  /** A5/A6: a synchronous closure invoked in place runs in its enclosing region. No callee is credited with invoking one (R3-1). */
  const inheritsInPlace = (cl: Closure): boolean => !isAsyncLike(cl) && isIIFE(cl);

  // ---- value escapes (rule 3) ---------------------------------------------------

  /** A read of `x.m` that a cast or assertion turns into a callable value. */
  function castToCallable(id: ts.Identifier): boolean {
    let c: ts.Node = ts.isPropertyAccessExpression(id.parent) && id.parent.name === id ? id.parent : id;
    while (c.parent && (ts.isParenthesizedExpression(c.parent) || ts.isAsExpression(c.parent) || ts.isNonNullExpression(c.parent)
      || ts.isSatisfiesExpression(c.parent) || ts.isTypeAssertionExpression(c.parent))) {
      c = c.parent;
      if ((ts.isAsExpression(c) || ts.isTypeAssertionExpression(c)) && mayBeCallable(checker.getTypeFromTypeNode(c.type))) return true;
    }
    return false;
  }
  const edgeCands: { node: ts.Node; what: string }[] = [];
  for (const id of refs) {
    const d = declOf(checker.getSymbolAtLocation(id));
    if (!d) continue;
    // A registered param slot is a writer reference when passed on, not only when called (A1 applied to slots).
    const isWriterRef = writers.has(d) || (ts.isParameter(d) && declIsWriter(d)) || namedMember(d) || (dataMemberInN(d) && castToCallable(id));
    if (!isWriterRef) continue;
    const parent = id.parent;
    // The callee position, directly or as `x.method`.
    if (ts.isCallExpression(parent) && parent.expression === id) continue;
    if (ts.isPropertyAccessExpression(parent) && parent.name === id) {
      const c = consumerOf(parent);
      if (ts.isCallExpression(c) && outerOf(parent) === c.expression) continue;
      // An enumerated write target is a write to the member, not a read of it (R3-2).
      if (writesByName.has(id)) continue;
    }
    // Declarations and module plumbing are not values flowing anywhere.
    if ((ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isVariableDeclaration(parent)
      || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent)
      || ts.isMethodSignature(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent)
      || ts.isParameter(parent)) && (parent as ts.NamedDeclaration).name === id) continue;
    if (writesByName.has(id)) continue;
    // A returned writer promise makes its function a writer (fixed point), not an escape.
    if (returnsValue(id) && holdsPromise(checker.getTypeAtLocation(id))) continue;
    if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) continue;
    if (ts.isBindingElement(parent) && (parent.name === id || parent.propertyName === id)) continue;
    // A writer-carrying local is consumed, not passed on, by `await` and by
    // chaining a handler on it (both are covered as writer sites above).
    if ((ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d)) && (ts.isAwaitExpression(consumerOf(id))
      || (ts.isPropertyAccessExpression(parent) && parent.expression === id
        && ["then", "catch", "finally"].includes(parent.name.text)))) continue;
    if (ts.isTypeQueryNode(parent) || ts.isQualifiedName(parent) || ts.isTypeReferenceNode(parent)) continue;
    edgeCands.push({ node: id, what: `edge:${id.text}` });
  }

  // A writer defined inline as an object-literal member (`{ normalize: (s) => writer(s) }`)
  // leaves as a value just like a referenced writer: the call through the slot
  // resolves to the slot's signature, not here, so the escape must be declared.
  for (const d of writers) {
    if ((ts.isPropertyAssignment(d) || ts.isMethodDeclaration(d)) && ts.isObjectLiteralExpression(d.parent)) {
      edgeCands.push({ node: d, what: `edge:${d.name.getText()}` });
    }
  }

  // U1a: an anonymous writer closure passed anywhere is a value escape, unless
  // it is invoked in place or is the lock-entry callback.
  for (const cl of writerClosures) {
    const o = outerOf(cl);
    const parent = o.parent!;
    if (ts.isCallExpression(parent) && parent.expression === o) continue;
    if (isLockEntryCallback(cl) || inheritsInPlace(cl as Closure) || isIIFE(cl)) continue;
    if (isAwaitedCallbackArg(cl) || localFnOf(cl)) continue;
    if (writers.has(parent)) continue; // named by its variable or property: covered as a writer
    edgeCands.push({ node: cl, what: "edge:<closure>" });
  }

  // A writer's promise handed to src code, or stored in an object or an array,
  // settles where it is consumed, not at this call.
  for (const c of calls) {
    if (!isWriterCall(c) || !holdsPromise(checker.getTypeAtLocation(c))) continue;
    const parent = consumerOf(c);
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.includes(outerOf(c) as ts.Expression)) {
      const sig = checker.getResolvedSignature(parent)?.declaration;
      if (sig && !external(sig)) edgeCands.push({ node: c, what: "edge:<promise>" });
    } else if (ts.isPropertyAssignment(parent) || ts.isArrayLiteralExpression(parent)) {
      edgeCands.push({ node: c, what: "edge:<promise>" });
    }
  }

  edgeCands.sort((a, b) => a.node.getSourceFile() === b.node.getSourceFile()
    ? a.node.getStart() - b.node.getStart() : rel(a.node.getSourceFile()) < rel(b.node.getSourceFile()) ? -1 : 1);
  const edgeCounts = new Map<string, number>();
  const edgeKeyOf = new Map<ts.Node, string>();
  for (const { node, what } of edgeCands) {
    const base = `${rel(node.getSourceFile())}#${namedFn(node).name}#edge`;
    const n = (edgeCounts.get(base) ?? 0) + 1;
    edgeCounts.set(base, n);
    found.set(`${base}#${n}`, what);
    sites.set(`${base}#${n}`, where(node));
    edgeKeyOf.set(node, `${base}#${n}`);
  }

  // ---- lock contract (rule 6, addendum L1, A3 to A7) --------------------------------

  const contract = new Set(opts.registry.lockHeldByContract);
  const viaCaller = new Map(Object.entries(opts.registry.lockHeldViaCaller ?? {}));
  const keyOfNamed = (n: ts.Node) => `${rel(n.getSourceFile())}#${namedFn(n).name}`;

  // The lock-scoped context and the stage interface (tier 2).
  let ctxClass: ts.ClassDeclaration | undefined;
  let stageIface: ts.InterfaceDeclaration | undefined;
  if (opts.lockContext) {
    const sf = files.find((f) => rel(f) === opts.lockContext!.file);
    sf?.statements.forEach((st) => {
      if (ts.isClassDeclaration(st) && st.name?.text === opts.lockContext!.className) ctxClass = st;
      if (ts.isInterfaceDeclaration(st) && st.name.text === opts.lockContext!.stageInterface) stageIface = st;
    });
    if (!ctxClass || !stageIface) errors.push(`lock context ${opts.lockContext.file}#${opts.lockContext.className} or its stage interface not found`);
  }
  function isCtxType(t: ts.Type): boolean {
    if (!ctxClass) return false;
    const parts = t.isUnion() ? t.types : [t];
    return parts.some((p) => (p.getSymbol()?.declarations ?? []).includes(ctxClass!));
  }
  const implementsStage = (cls: ts.Node): boolean =>
    !!stageIface && ts.isClassLike(cls) && (cls.heritageClauses ?? []).some((h) => h.token === ts.SyntaxKind.ImplementsKeyword
      && h.types.some((t) => (resolve(checker.getSymbolAtLocation(t.expression))?.declarations ?? []).includes(stageIface!)));
  /**
   * Pen ruling on Proxy: a trap can supply a member by another route (a get
   * trap returning a different function is a provider). A `new Proxy` is
   * UNRESOLVED when its handler is no object literal, when the literal has a
   * write trap, a computed or spread member, or when its target type, the
   * type it flows into, or its own static result type is sensitive: it owns a
   * guarded or seam slot, an interface member whose src providers this run
   * enumerated (A1), a lock entry or contract function, is the context or a
   * stage, or is untyped (R4-2: the result type is tested by assignability to
   * every sensitive src type, so a proxy assigned later is caught where it is
   * built). Any other reference to Proxy was refused with the library refs.
   * Credit is given only through those slots and A1 provider enumeration, so
   * a type owning none of them cannot launder a provider; the A1 set is taken
   * from use and grows when a new member enters a writer chain.
   */
  const WRITE_TRAPS = new Set(["set", "defineProperty", "deleteProperty", "setPrototypeOf"]);
  const proxySensitive = (t: ts.Type | undefined): boolean => {
    if (!t) return false;
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
    if (isCtxType(t)) return true;
    return (t.isUnion() || t.isIntersection() ? t.types : [t]).some((x) =>
      (x.getSymbol()?.declarations ?? []).some((d) => implementsStage(d))
      || checker.getPropertiesOfType(x).some((m) => (m.declarations ?? []).some((d) => {
        if (guardedMds.has(d)) return true;
        if (typeOnlyMember(d) && providerMemo.has(d)) return true;
        const k = ts.isFunctionLike(d) ? fnKey(d) : null;
        return !!k && (contract.has(k) || lockEntries.has(k));
      })));
  };
  const contextParams = new Set(opts.registry.contextParams ?? []);
  const seenContextParams = new Set<string>();
  /** R-e: a pinned context-carrying parameter. */
  function isContextParam(d: ts.Node | undefined): boolean {
    if (!d || !ts.isParameter(d)) return false;
    const slot = paramSlot(d);
    if (slot && contextParams.has(slot)) { seenContextParams.add(slot); return true; }
    return false;
  }
  /** A value of the context: by type, or through a pinned context-carrying parameter. */
  const isCtxValueRef = (id: ts.Identifier): boolean =>
    isCtxType(checker.getTypeAtLocation(id)) || isContextParam(declOf(checker.getSymbolAtLocation(id)));
  /** Tier 2: a method of the context class or of a stage class, or a function taking a context parameter. */
  function holdsStructurally(p: ts.Node): boolean {
    if (!ctxClass) return false;
    if ((ts.isMethodDeclaration(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isConstructorDeclaration(p))
      && (p.parent === ctxClass || implementsStage(p.parent))) return true;
    if (ts.isFunctionLike(p)) return p.parameters.some((q) => isCtxType(checker.getTypeAtLocation(q)) || isContextParam(q));
    return false;
  }
  /**
   * R-c: a synchronous closure registered as an edge and passed directly to a
   * src function that calls the slot only directly, synchronously, in its own
   * body. It runs in the call site's region; the callee is a contract function.
   */
  function edgeCallbackOk(cl: ts.Node): boolean {
    if (!isClosure(cl) || isAsyncLike(cl)) return false;
    const o = outerOf(cl);
    const call = o.parent;
    if (!call || !ts.isCallExpression(call) || !call.arguments.includes(o as ts.Expression)) return false;
    const key = edgeKeyOf.get(cl);
    if (!key || !(key in opts.registry.edges)) return false;
    const sig = checker.getResolvedSignature(call)?.declaration;
    if (!sig || external(sig) || !ts.isFunctionLike(sig) || !(sig as Fn).body) return false;
    const param = sig.parameters[call.arguments.indexOf(o as ts.Expression)];
    if (!param || !ts.isIdentifier(param.name)) return false;
    const sym = checker.getSymbolAtLocation(param.name);
    const body = (sig as Fn).body!;
    // One file: the parameter name is an identifier (checked above), so sym is its parameter, local to sig.
    const uses = refs.filter((r) => r.pos >= body.pos && r.end <= body.end && checker.getSymbolAtLocation(r) === sym);
    if (!uses.every((u) => isDirectCallRef(u) && nearestFn(u) === sig && !ts.isAwaitExpression(consumerOf(u.parent)))) return false;
    noteReceiver(call, sig as Fn);
    return true;
  }
  /** R-h1: a receiver that may suspend must be called in completion form 1 or 2 (checked with A6 below). */
  function noteReceiver(call: ts.CallExpression, sig: Fn): void {
    const s = checker.getSignatureFromDeclaration(sig);
    const mayAwait = !!(ts.getCombinedModifierFlags(sig) & ts.ModifierFlags.Async) || !!sig.asteriskToken
      || !s || !nonThenable(checker.getReturnTypeOfSignature(s));
    if (mayAwait) asyncReceiverCalls.set(call, fnKey(sig) ?? `<fn ${where(sig)}>`);
  }
  /**
   * Addendum 3 R-h: `<recv>.<m>.bind(<recv>)`, the same identifier both times,
   * recv a context, m a method of the context class, no bound arguments. It is a
   * value reference to the writer and nothing more, accepted only when that
   * reference is a registered edge handed directly (or as an object-literal
   * property) to a src function that invokes the slot only by direct,
   * synchronous calls in its own body and never passes its parameter on.
   */
  function ctxBindOk(bind: ts.CallExpression, arg: ts.Node): boolean {
    if (!ctxClass || !ts.isIdentifier(arg) || bind.arguments.length !== 1 || bind.arguments[0] !== arg) return false;
    const callee = bind.expression;
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "bind") return false;
    const member = callee.expression;
    if (!ts.isPropertyAccessExpression(member) || !ts.isIdentifier(member.expression)) return false;
    const recv = checker.getSymbolAtLocation(member.expression);
    if (!recv || recv !== checker.getSymbolAtLocation(arg) || !isCtxValueRef(member.expression)) return false;
    const md = checker.getSymbolAtLocation(member.name)?.declarations?.[0];
    if (!md || !ts.isMethodDeclaration(md) || md.parent !== ctxClass) return false;
    const key = edgeKeyOf.get(member.name);
    if (!key || !(key in opts.registry.edges)) return false;
    // The receiving call: the bind is its argument, or a property of an object literal that is.
    let held: ts.Node = outerOf(bind);
    let prop: string | null = null;
    if (ts.isPropertyAssignment(held.parent) && held.parent.initializer === held && !ts.isComputedPropertyName(held.parent.name)) {
      prop = held.parent.name.getText().replace(/^["']|["']$/g, "");
      held = outerOf(held.parent.parent);
    }
    const call = held.parent;
    if (!call || !ts.isCallExpression(call) || !call.arguments.includes(held as ts.Expression)) return false;
    const sig = checker.getResolvedSignature(call)?.declaration;
    if (!sig || external(sig) || !ts.isFunctionLike(sig) || !(sig as Fn).body) return false;
    const param = sig.parameters[call.arguments.indexOf(held as ts.Expression)];
    if (!param || !ts.isIdentifier(param.name) || param.dotDotDotToken) return false;
    const psym = checker.getSymbolAtLocation(param.name);
    const body = (sig as Fn).body!;
    // ISS-1401: msym is a property of the parameter's type, which any file can reference.
    const inBody = (r: ts.Node) => within(r, body);
    const directCall = (u: ts.Identifier): boolean => {
      const at: ts.Node = prop === null ? u : u.parent;
      if (prop !== null && !(ts.isPropertyAccessExpression(at) && at.name === u)) return false;
      const c = consumerOf(at);
      return ts.isCallExpression(c) && outerOf(at) === c.expression && nearestFn(u) === sig && !ts.isAwaitExpression(consumerOf(c));
    };
    const paramUses = refs.filter((r) => inBody(r) && checker.getSymbolAtLocation(r) === psym);
    if (prop === null) {
      if (!paramUses.every(directCall)) return false;
    } else {
      // The object is only ever a receiver, so the slot cannot leave through it.
      if (!paramUses.every((u) => ts.isPropertyAccessExpression(u.parent) && u.parent.expression === u)) return false;
      const msym = checker.getTypeAtLocation(param).getProperty(prop);
      if (!msym) return false;
      const slotUses = refs.filter((r) => inBody(r) && checker.getSymbolAtLocation(r) === msym);
      if (!slotUses.every(directCall)) return false;
    }
    noteReceiver(call, sig as Fn);
    return true;
  }

  type Region = { how: "lexical" | "contract" | "structural" | "via" | "iife"; fn: string } | { how: null; fn: string; closure?: Closure };
  /**
   * Where n runs with respect to the lock. Inheritance stops at every function
   * boundary (A5) except a synchronous closure invoked in place and an IIFE
   * (whose invocation A6 checks); a lock-entry callback is the lock's root.
   */
  function regionOf(n: ts.Node, allowStructural = true, seen = new Set<ts.Node>()): Region {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (isClosure(p)) {
        // R-b: a local function inherits the region of every call site.
        const local = localFnOf(p);
        if (local) {
          if (seen.has(local)) return { how: "lexical", fn: keyOfNamed(p) };
          seen.add(local);
          const regions = refsTo(local).map((id) => regionOf(id, allowStructural, seen));
          const bad = regions.find((r) => r.how === null);
          if (bad) return { how: null, fn: bad.fn, closure: p };
          return regions.find((r) => r.how === "via") ?? regions[0] ?? { how: null, fn: keyOfNamed(p), closure: p };
        }
      }
      if (isClosure(p) && (!fnName(p) || localFnBinding(p))) {
        if (isLockEntryCallback(p)) return { how: "lexical", fn: keyOfNamed(p) };
        if (inheritsInPlace(p) || isIIFE(p) || isAwaitedCallbackArg(p) || edgeCallbackOk(p)) continue;
        return { how: null, fn: keyOfNamed(p), closure: p };
      }
      const name = fnName(p);
      if (!name) continue;
      const key = `${rel(n.getSourceFile())}#${name}`;
      if (contract.has(key)) return { how: "contract", fn: key };
      if (allowStructural && holdsStructurally(p)) return { how: "structural", fn: key };
      if (viaCaller.has(key)) return { how: "via", fn: key };
      return { how: null, fn: key };
    }
    return { how: null, fn: keyOfNamed(n) };
  }

  for (const c of calls) {
    const d = calleeDecl(c);
    const rootName = d && roots.get(d);
    if (!rootName) continue;
    if (regionOf(c).how === null) errors.push(`lock: ${rootName} at ${where(c)} is not inside ${opts.lockName} or a lock-held function`);
  }

  // Callers of tier 1 and tier 3 functions hold the lock, transitively through the registry.
  const checked = new Set<string>([...contract, ...viaCaller.keys()]);
  const neededVia = new Set<string>();
  const usedStructural = new Set<string>();
  const callersOf = new Map<string, Set<string>>();
  const unheldFns = new Set<string>();
  /** The lock-held functions a callee stands for: itself, or each one a local is bound to (U1b sources). */
  function heldTargets(d: ts.Node | undefined, seen = new Set<ts.Node>()): string[] {
    if (!d || seen.has(d)) return [];
    seen.add(d);
    const k = fnKey(d);
    const out = k && checked.has(k) ? [k] : [];
    if (ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d)) {
      const { exprs } = sourcesOf(d);
      for (const x of exprs) {
        for (const op of operandsOf(x)) {
          const e = skipOuter(op);
          if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
            out.push(...heldTargets(declOf(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(e) ? e.name : e)), seen));
          }
        }
      }
    }
    return out;
  }
  for (const c of calls) for (const k of heldTargets(calleeDecl(c))) {
    const r = regionOf(c);
    if (!callersOf.has(k)) callersOf.set(k, new Set());
    callersOf.get(k)!.add(r.fn);
    if (r.how === "structural") usedStructural.add(r.fn);
    if (r.how === "via") neededVia.add(r.fn);
    if (r.how === null) {
      unheldFns.add(r.fn);
      errors.push(`lock: lock-held function ${k} called at ${where(c)} from ${r.fn}, which is not inside ${opts.lockName}, a contract function, a context-holding function or a registered via-caller function`);
    }
  }
  // S4: a structurally admitted function (tier 2: a context or stage method, a
  // stage-interface dispatch, a context-parameter function) holds the lock only
  // when its caller does; its call sites are checked like tier 1 and tier 3.
  for (const c of calls) {
    const d = calleeDecl(c);
    if (!d || heldTargets(d).length > 0) continue;
    const dispatch = !!stageIface && (ts.isMethodSignature(d) || ts.isPropertySignature(d)) && d.parent === stageIface;
    if (!dispatch && !(ts.isFunctionLike(d) && (d as Fn).body && holdsStructurally(d))) continue;
    const r = regionOf(c);
    if (r.how !== null) continue;
    const k = dispatch ? `${opts.lockContext!.stageInterface}.${memberName(d)}` : (fnKey(d) ?? keyOfNamed(d));
    errors.push(`lock: context-holding function ${k} called at ${where(c)} from ${r.fn}, which is not inside ${opts.lockName}, a contract function, a context-holding function or a registered via-caller function`);
  }
  // Report aid only (never matched): where each function that needs a holder is called from.
  const holderHints: string[] = [];
  for (const c of calls) for (const k of heldTargets(calleeDecl(c))) {
    if (!(unheldFns.has(k) || viaCaller.has(k))) continue;
    const r = regionOf(c);
    holderHints.push(`${k} <- ${r.fn} (${r.how ?? "unheld"}) at ${where(c)}`);
  }
  for (const k of contract) {
    if (![...writers].some((d) => fnKey(d) === k)) errors.push(`stale lock-held-by-contract key ${k}`);
  }

  // L1a: the context exists only under the lock: every construction runs in a
  // lock-entry callback or a tier 1 or tier 3 function, and the set is pinned.
  const constructions: string[] = [];
  const constructionFns = new Set<string>();
  if (ctxClass) {
    const counts = new Map<string, number>();
    for (const n of news) {
      if (!isCtxType(checker.getTypeAtLocation(n))) continue;
      const base = `${keyOfNamed(n)}#new`;
      const k = (counts.get(base) ?? 0) + 1;
      counts.set(base, k);
      constructions.push(`${base}#${k}`);
      sites.set(`${base}#${k}`, where(n));
      constructionFns.add(keyOfNamed(n));
      const r = regionOf(n, false);
      if (r.how === null) errors.push(`lock-lifetime: context constructed at ${where(n)} outside ${opts.lockName}, a tier 1 or a tier 3 function`);
      // A construction needs its function's holder just as a lock-held call does.
      if (r.how === "via") neededVia.add(r.fn);
    }
    const pinned = new Set(opts.registry.contextConstructions ?? []);
    for (const k of constructions) if (!pinned.has(k)) errors.push(`unregistered context construction ${k}`);
    for (const k of pinned) if (!constructions.includes(k)) errors.push(`stale context construction ${k}`);
  }
  for (const [k, holder] of viaCaller) {
    if (!neededVia.has(k)) errors.push(`stale via-caller key ${k}`);
    else if (!(callersOf.get(k)?.has(holder))) errors.push(`via-caller ${k} names ${holder}, which does not call it`);
  }

  /** A contract closure (A5): it calls a lock-held function or a writer, or captures the context. */
  const contractClosures = new Set<Closure>();
  function contractCallee(c: ts.CallExpression): string | null {
    const e = skipOuter(c.expression);
    const inPlace = closureOperands(e).find((x) => contractClosures.has(x));
    if (inPlace) return `<closure ${where(inPlace)}>`;
    // R-c: a callee handed a registered contract callback is a contract function.
    const cb = c.arguments.find((a) => isClosure(skipOuter(a)) && contractClosures.has(skipOuter(a) as Closure) && edgeCallbackOk(skipOuter(a)));
    if (cb) return symbolKey(c.expression) ?? `<callee ${where(c)}>`;
    const d = calleeDecl(c);
    if (!d) return null;
    const k = fnKey(d);
    if (k && checked.has(k)) return k;
    const held = heldTargets(d);
    if (held.length > 0) return held[0]!;
    if (stageIface && (ts.isMethodSignature(d) || ts.isPropertySignature(d)) && d.parent === stageIface) {
      return `${opts.lockContext!.stageInterface}.${memberName(d)}`;
    }
    if (ts.isVariableDeclaration(d) && d.initializer && closureOperands(d.initializer).some((x) => contractClosures.has(x))) {
      return k ?? `<closure ${where(d)}>`;
    }
    const target = d;
    if (ts.isFunctionLike(target) && holdsStructurally(target)) return k ?? `<context function ${where(target)}>`;
    return null;
  }
  const capturesCtx = (cl: Closure): boolean => subtreeHas(cl.body, (x) => {
    if (x.kind === ts.SyntaxKind.ThisKeyword && ts.isArrowFunction(cl)) return isCtxType(checker.getTypeAtLocation(x));
    if (!ts.isIdentifier(x)) return false;
    const d = declOf(checker.getSymbolAtLocation(x));
    if (!d || within(d, cl)) return false;
    return (ts.isVariableDeclaration(d) || ts.isParameter(d)) && isCtxValueRef(x);
  });
  let grewC = true;
  while (grewC) {
    grewC = false;
    for (const cl of closures) {
      if (contractClosures.has(cl) || fnName(cl) && !ts.isVariableDeclaration(cl.parent)) continue;
      const own = (x: ts.Node) => { // a node in cl's own body, not in a nested function
        for (let p: ts.Node | undefined = x.parent; p && p !== cl; p = p.parent) if (ts.isFunctionLike(p)) return false;
        return true;
      };
      const hit = capturesCtx(cl) || calls.some((c) => within(c, cl) && own(c)
        && (isWriterCall(c) || contractCallee(c) !== null));
      if (hit) { contractClosures.add(cl); grewC = true; }
    }
  }

  /** The enclosing function of a node is itself a contract function (form 2). */
  function enclosingIsContract(n: ts.Node): boolean {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (!ts.isFunctionLike(p)) continue;
      if (isClosure(p) && (isLockEntryCallback(p) || contractClosures.has(p))) return true;
      const k = fnKey(p);
      return (!!k && checked.has(k)) || holdsStructurally(p);
    }
    return false;
  }
  /** A6: form 1 (the immediate operand of await) or form 2 (the immediate return operand in a contract function, outside any try that has a finally). */
  function completedForm(c: ts.Node): boolean {
    if (!formOk(c)) return false;
    return ts.isAwaitExpression(outerOf(c).parent!) || enclosingIsContract(c);
  }

  /**
   * S3/T4: a call may suspend when its exposed type may hold a promise or when
   * any implementation it resolves to may. The call-site type alone is never
   * trusted (an async closure fits a `() => void` local or cast). A closure
   * operand of the callee is read directly; an overload resolves to its
   * implementation bodies. Anything that is not a resolved declaration with a
   * body fails closed: a bodyless declaration with no implementation, an
   * accessor, a parameter, an unresolved callee, or a local or field with a
   * source that is not a closure or a resolvable reference.
   */
  /**
   * A1: the src providers of an interface or type member, built on the S6
   * every-flow walk: classes implementing the owner, and every value flowing
   * into the owner type (an object literal's member, or the value type's
   * member declarations), and every assignment to the member. A provider
   * without a body in src, an asserted or untyped flow, and a computed member
   * cannot be established: UNRESOLVED (fail closed).
   */
  const providerMemo = new Map<ts.Node, { bodies: ts.Node[]; unresolved: number }>();
  const memberProviders: Record<string, string[]> = {};
  function providersOf(md: ts.Node): { bodies: ts.Node[]; unresolved: number } {
    const hit = providerMemo.get(md);
    if (hit) return hit;
    const r = { bodies: [] as ts.Node[], unresolved: 0 };
    providerMemo.set(md, r);
    const owner = md.parent;
    const member = (md as ts.NamedDeclaration).name?.getText() ?? "";
    const holder = owner && (ts.isInterfaceDeclaration(owner) || ts.isTypeAliasDeclaration(owner)) ? owner
      : owner && ts.isTypeLiteralNode(owner) && ts.isTypeAliasDeclaration(owner.parent) ? owner.parent : undefined;
    const mkey = `${rel(md.getSourceFile())}#${holder ? holder.name.text : "<anon>"}.${member}`;
    const sitesOf = (memberProviders[mkey] ??= []);
    const unresolvedAt = (at: ts.Node, why: string): void => {
      r.unresolved++;
      const m = `UNRESOLVED provider ${mkey} at ${where(at)} (${why})`;
      if (!errors.includes(m)) errors.push(m);
    };
    const add = (n: ts.Node): void => { if (!r.bodies.includes(n)) { r.bodies.push(n); sitesOf.push(where(n)); } };
    const fromValue = (v: ts.Expression, at: ts.Node): void => {
      const x = skipOuter(v);
      if (isClosure(x)) { add(x); return; }
      const d = ts.isIdentifier(x) || ts.isPropertyAccessExpression(x)
        ? declOf(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(x) ? x.name : x)) : undefined;
      if (d && ts.isFunctionLike(d) && (d as Fn).body) add(d);
      else unresolvedAt(at, "provider without a body in src");
    };
    const fromDecl = (d: ts.Node, at: ts.Node): void => {
      if (d === md) return; // a forward of the owner's own member
      if (ts.isFunctionLike(d) && (d as Fn).body && !ts.isGetAccessor(d) && !ts.isSetAccessor(d)) add(d);
      else if ((ts.isPropertyDeclaration(d) || ts.isPropertyAssignment(d)) && d.initializer) fromValue(d.initializer, at);
      else unresolvedAt(at, "provider without a body in src");
    };
    const fromLiteral = (lit: ts.ObjectLiteralExpression): void => {
      for (const p of lit.properties) {
        if (ts.isSpreadAssignment(p)) {
          const x = skipOuter(p.expression);
          if (ts.isObjectLiteralExpression(x)) fromLiteral(x);
          else fromType(checker.getTypeAtLocation(x), p);
          continue;
        }
        if (!p.name) continue;
        if (ts.isComputedPropertyName(p.name)) { unresolvedAt(p, "computed member"); continue; }
        if (p.name.getText().replace(/^["']|["']$/g, "") !== member) continue;
        if (ts.isPropertyAssignment(p)) fromValue(p.initializer, p);
        else if (ts.isMethodDeclaration(p) && p.body) add(p);
        else unresolvedAt(p, "provider without a body in src");
      }
    };
    const fromType = (t: ts.Type, at: ts.Node): void => {
      if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) { unresolvedAt(at, "untyped provider"); return; }
      const prop = t.getProperty(member);
      for (const d of prop?.declarations ?? []) fromDecl(d, at);
    };
    if (holder) {
      for (const sf of files) {
        sf.forEachChild(function visit(n): void {
          if ((ts.isClassDeclaration(n) || ts.isClassExpression(n)) && (n.heritageClauses ?? []).some((h) => h.types.some((ht) =>
            (checker.getTypeAtLocation(ht.expression).getSymbol()?.declarations ?? []).includes(holder as ts.Declaration)
            || (checker.getTypeAtLocation(ht).getSymbol()?.declarations ?? []).includes(holder as ts.Declaration)))) {
            for (const m of n.members) {
              if (m.name && ts.isComputedPropertyName(m.name)) unresolvedAt(m, "computed member");
              else if (m.name && m.name.getText() === member) fromDecl(m, m);
            }
          }
          ts.forEachChild(n, visit);
        });
      }
    }
    for (const e0 of allFlows()) {
      const inner = skipParens(e0);
      const asserted = ts.isAsExpression(inner) || ts.isTypeAssertionExpression(inner);
      const spread = ts.isSpreadAssignment(e0.parent);
      const target = spread ? checker.getContextualType(e0.parent.parent as ts.ObjectLiteralExpression) : checker.getContextualType(e0);
      if (!typeHolds(target, owner) && !(asserted && typeHolds(checker.getTypeAtLocation(inner), owner))) continue;
      if (asserted) { unresolvedAt(e0, "asserted provider"); continue; }
      const e = skipOuter(e0);
      if (ts.isObjectLiteralExpression(e)) fromLiteral(e);
      else fromType(checker.getTypeAtLocation(e), e);
    }
    // R3-2: every enumerated write to the member supplies a provider.
    for (const w of writeSites) {
      const left = w.target;
      if (ts.isElementAccessExpression(left) && typeHolds(checker.getTypeAtLocation(left.expression), owner)) { unresolvedAt(w.at, "element-access write"); continue; }
      if (!ts.isPropertyAccessExpression(left) || !(checker.getSymbolAtLocation(left.name)?.declarations ?? []).includes(md as ts.Declaration)) continue;
      const from = w.from;
      if (from.kind === "value") fromValue(from.expr, w.at);
      else if (from.kind === "member") {
        if (!from.member) unresolvedAt(w.at, "destructured member");
        else for (const d of from.member.declarations ?? []) fromDecl(d, w.at);
      } else if (from.kind === "iterated") {
        // `for (s.m of [a, b])`: each element of a literal array; any other iterable fails closed.
        const it = skipOuter(from.expr);
        if (!ts.isArrayLiteralExpression(it)) { unresolvedAt(w.at, "loop-assigned member"); continue; }
        for (const x of it.elements) {
          if (ts.isSpreadElement(x) || ts.isOmittedExpression(x)) unresolvedAt(w.at, "loop-assigned member");
          else fromValue(x, w.at);
        }
      } else unresolvedAt(w.at, `${w.form} write`);
    }
    for (const w of reflectiveWrites) {
      if (!w.receiver || !typeHolds(checker.getTypeAtLocation(w.receiver), owner)) continue;
      // Object.assign and the prototype setters copy in their sources' members; any other reflective write fails closed.
      if (w.sources.length === 0) { unresolvedAt(w.at, "reflective write"); continue; }
      for (const src of w.sources) {
        const x = skipOuter(src);
        if (ts.isObjectLiteralExpression(x)) fromLiteral(x);
        else fromType(checker.getTypeAtLocation(x), w.at);
      }
    }
    sitesOf.sort();
    return r;
  }

  function implMaySuspend(d: ts.Node | undefined, seen = new Set<ts.Node>()): boolean {
    if (!d) return true;
    if (seen.has(d)) return false;
    seen.add(d);
    if (ts.isGetAccessor(d) || ts.isSetAccessor(d) || ts.isParameter(d)) return true;
    if (guardedMds.has(d)) return false; // A2: never supplied in src (S6); its default is the local's other operand
    if ((ts.isMethodSignature(d) || ts.isPropertySignature(d)) && (ts.isInterfaceDeclaration(d.parent) || ts.isTypeLiteralNode(d.parent))) {
      const p = providersOf(d);
      // No provider in src: whatever supplies it is unseen (fail closed).
      return p.unresolved > 0 || p.bodies.length === 0 || p.bodies.some((b) => isClosure(b) || ts.isFunctionLike(b) ? isAsyncLike(b as Closure) : true);
    }
    if (ts.isFunctionLike(d)) {
      if ((d as Fn).body) return isAsyncLike(d as Closure);
      const sym = (d as ts.NamedDeclaration).name ? checker.getSymbolAtLocation((d as ts.NamedDeclaration).name!) : undefined;
      const impls = (sym?.declarations ?? []).filter((x) => ts.isFunctionLike(x) && (x as Fn).body);
      return impls.length === 0 || impls.some((x) => isAsyncLike(x as Closure));
    }
    if (!ts.isVariableDeclaration(d) && !ts.isPropertyDeclaration(d)) return true;
    const { exprs, members, iterated } = sourcesOf(d);
    if (members.length > 0 || iterated.length > 0 || exprs.length === 0) return true;
    return exprs.some((src) => operandsOf(src).some((x) => {
      x = skipOuter(x);
      if (isClosure(x)) return isAsyncLike(x);
      if (ts.isIdentifier(x) || ts.isPropertyAccessExpression(x)) {
        return implMaySuspend(declOf(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(x) ? x.name : x)), seen);
      }
      return true;
    }));
  }
  const maySuspend = (c: ts.CallExpression): boolean => {
    if (holdsPromise(checker.getTypeAtLocation(c))) return true;
    const ops = closureOperands(c.expression);
    if (ops.length > 0) {
      return ops.some((cl) => isAsyncLike(cl)) || operandsOf(c.expression).some((x0) => {
        const x = skipOuter(x0);
        if (isClosure(x)) return false;
        const d = ts.isIdentifier(x) || ts.isPropertyAccessExpression(x)
          ? declOf(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(x) ? x.name : x)) : undefined;
        return implMaySuspend(d);
      });
    }
    return implMaySuspend(calleeDecl(c));
  };
  /** T4: a callee the scan cannot resolve to a declaration or a closure; under the lock it is held to the completion form. */
  const unresolvedLockCallee = (c: ts.CallExpression): string | null => {
    const e = skipOuter(c.expression);
    if (e.kind === ts.SyntaxKind.ImportKeyword || e.kind === ts.SyntaxKind.SuperKeyword) return null;
    if (closureOperands(e).length > 0 || calleeDecl(c)) return null;
    return `<unresolved callee ${e.getText().replace(/\s+/g, "")}>`;
  };

  // A3a/A6, scoped by A7 to code under the lock: a contract promise completes there.
  for (const c of calls) {
    if (regionOf(c).how === null) continue;
    const k = contractCallee(c) ?? (awaitedCallbackIndex(c) !== null ? `awaited-callback ${c.expression.getText()}` : null)
      ?? unresolvedLockCallee(c);
    if (!k || !maySuspend(c)) continue;
    if (!completedForm(c)) errors.push(`lock-lifetime: ${k} called at ${where(c)} is neither awaited nor returned in a contract function`);
  }

  // A5/A6: a contract closure under the lock is invoked in place, or is the lock-entry callback.
  for (const cl of contractClosures) {
    if (regionOf(cl).how === null && !isLockEntryCallback(cl)) continue;
    if (isLockEntryCallback(cl) || inheritsInPlace(cl) || isIIFE(cl) || isAwaitedCallbackArg(cl) || edgeCallbackOk(cl)) continue;
    const binding = localFnBinding(cl);
    if (binding) {
      if (isLocalFunction(binding)) continue; // R-b: its calls are checked by region and form
      errors.push(`lock-lifetime: contract closure ${binding.name.getText()} at ${where(cl)} is referenced other than by a direct call`);
      continue;
    }
    const key = edgeKeyOf.get(cl);
    if (!isAsyncLike(cl) && key && key in opts.registry.edges) continue;
    errors.push(`lock-lifetime: ${isAsyncLike(cl) ? "async " : ""}contract closure at ${where(cl)} is passed or stored, not invoked in place; hoist the context reads out of the callback, or await the work under the lock`);
  }

  // A3b: a context value may only be a parameter, a local, a receiver, an
  // argument to a contract function, or a field of the context class itself.
  if (ctxClass) {
    const ctxValues: ts.Node[] = [...refs.filter((r) => {
      const d = declOf(checker.getSymbolAtLocation(r));
      return !!d && (ts.isVariableDeclaration(d) || ts.isParameter(d)) && (d as ts.NamedDeclaration).name !== r
        && !inTypePosition(r) && isCtxValueRef(r);
    }), ...news.filter((n) => isCtxType(checker.getTypeAtLocation(n))),
    ...thisRefs.filter((t) => isCtxType(checker.getTypeAtLocation(t)))];
    for (const v of ctxValues) {
      const why = retention(v);
      // The remedy, since this is the rule a context-capturing callback meets.
      const remedy = why?.startsWith("captured") ? "; hoist the read out of the callback, or await the work under the lock" : "";
      if (why) errors.push(`lock-lifetime: context ${why} at ${where(v)}${remedy}`);
    }
    for (const p of props) {
      if (p.parent !== ctxClass && isCtxType(checker.getTypeAtLocation(p))) {
        errors.push(`lock-lifetime: class field ${p.name.getText()} holds a context at ${where(p)}`);
      }
    }
  }
  function retention(v: ts.Node): string | null {
    // Captured by a closure that does not run in place under A5/A6.
    for (let p: ts.Node | undefined = v.parent; p; p = p.parent) {
      if (!ts.isFunctionLike(p)) continue;
      if (ts.isIdentifier(v)) {
        const d = declOf(checker.getSymbolAtLocation(v));
        if (d && within(d, p)) break; // declared in this function: not a capture (ISS-1401: declOf follows imports to other files)
      } else break;
      if (isClosure(p) && (inheritsInPlace(p) || isIIFE(p) || isLockEntryCallback(p) || isAwaitedCallbackArg(p)
        || localFnOf(p) || edgeCallbackOk(p))) continue;
      return "captured by a function that may run outside the lock";
    }
    const o = outerOf(v);
    const parent = o.parent!;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === o) {
      // A receiver, except where the read hands a member function on (`ctx.m.bind(ctx)` is an argument below).
      return null;
    }
    if (ts.isElementAccessExpression(parent) && parent.expression === o) return null;
    if (ts.isVariableDeclaration(parent) && parent.initializer === o) {
      const top = parent.parent.parent;
      return ts.isVariableStatement(top) && ts.isSourceFile(top.parent) ? "stored to a module-level binding" : null;
    }
    const stored = ts.isExpression(o) ? writeOfValue.get(skipOuter(o)) : undefined;
    if (ts.isExpression(o) && patternSources.has(skipOuter(o))) return "stored to a field or a container";
    if (stored) {
      const left = stored.target;
      if (ts.isIdentifier(left)) {
        const d = siteDecl(stored);
        if (d && ts.isVariableDeclaration(d) && ts.isVariableStatement(d.parent.parent) && ts.isSourceFile(d.parent.parent.parent)) {
          return "stored to a module-level binding";
        }
        return null;
      }
      if (ts.isPropertyAccessExpression(left) && left.expression.kind === ts.SyntaxKind.ThisKeyword && containingClass(left) === ctxClass) return null;
      return "stored to a field or a container";
    }
    if (ts.isBinaryExpression(parent)) return null; // a comparison or a logical test
    if (ts.isPrefixUnaryExpression(parent) || ts.isTypeOfExpression(parent) || ts.isIfStatement(parent)
      || ts.isAwaitExpression(parent)) return null;
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      if (parent.expression === o) return null;
      const sig = checker.getResolvedSignature(parent);
      const params = sig?.getParameters() ?? [];
      const i = parent.arguments!.indexOf(o as ts.Expression);
      const param = params[Math.min(i, params.length - 1)];
      if (param && isCtxType(checker.getTypeOfSymbolAtLocation(param, parent))) return null;
      if (param && isContextParam(param.valueDeclaration)) return null;
      if (ts.isCallExpression(parent) && ctxBindOk(parent, o)) return null;
      return "passed where the parameter is not a context";
    }
    if (ts.isReturnStatement(parent) || (isClosure(parent) && parent.body === o)) {
      // S4: a lock callback's result settles after the lock is released.
      const from = ts.isReturnStatement(parent) ? containingFunction(parent) : parent;
      if (from && isClosure(from) && (isLockEntryCallback(from) || isAwaitedCallbackArg(from))) return "returned across the lock-entry boundary";
      return constructionFns.has(keyOfNamed(v)) ? null : "returned from a function that is not a construction site";
    }
    return `held by ${ts.SyntaxKind[parent.kind]}`;
  }
  /** `typeof ctx.state` and the like: a type query reads no value. */
  function inTypePosition(n: ts.Node): boolean {
    for (let p: ts.Node | undefined = n.parent; p && !ts.isStatement(p); p = p.parent) if (ts.isTypeNode(p)) return true;
    return false;
  }
  function containingClass(n: ts.Node): ts.Node | undefined {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) if (ts.isClassLike(p)) return p;
    return undefined;
  }

  // Not-followed src-receiver sinks: a pinned chain whose hops hide no catch and complete.
  const chains = opts.registry.unfollowedSinkChains ?? {};
  const fnDecls = new Map<string, Fn>();
  for (const sf of files) sf.forEachChild((n) => { if (ts.isFunctionDeclaration(n) && n.name && n.body) fnDecls.set(`${rel(sf)}#${n.name.text}`, n); });
  for (const [key, hops] of Object.entries(chains)) {
    if (!(key in opts.registry.edges)) { errors.push(`unfollowed sink chain ${key} names no registered edge`); continue; }
    // S8: the registered edge is the value handed to the first hop, in its parameter's slot.
    const first = fnDecls.get(hops[0]?.fn ?? "");
    const firstIndex = first ? first.parameters.findIndex((q) => ts.isIdentifier(q.name) && q.name.text === hops[0]!.param) : -1;
    const entries = [...edgeKeyOf].filter(([, k]) => k === key).map(([n]) => n);
    const entersFirst = entries.length > 0 && entries.every((n) => {
      const o = outerOf(n);
      const call = o.parent;
      return !!call && ts.isCallExpression(call) && calleeDecl(call) === first && call.arguments.indexOf(o as ts.Expression) === firstIndex;
    });
    if (!entersFirst) errors.push(`unfollowed sink chain ${key}: the edge does not enter ${hops[0]?.fn ?? "a first hop"}(${hops[0]?.param ?? ""})`);
    hops.forEach((hop, i) => {
      const fn = fnDecls.get(hop.fn);
      const param = fn?.parameters.find((q) => ts.isIdentifier(q.name) && q.name.text === hop.param);
      if (!fn || !param) { errors.push(`unfollowed sink chain ${key}: hop ${hop.fn}(${hop.param}) not found`); return; }
      const sym = checker.getSymbolAtLocation(param.name);
      // One file: the parameter was found by ts.isIdentifier(q.name), so sym is its parameter, local to fn.
      const uses = refs.filter((r) => r.pos >= fn.body!.pos && r.end <= fn.body!.end && checker.getSymbolAtLocation(r) === sym);
      if (uses.length === 0) errors.push(`unfollowed sink chain ${key}: ${hop.fn} never uses ${hop.param}`);
      for (const u of uses) {
        for (let p: ts.Node = u; p !== fn; p = p.parent) {
          if (ts.isTryStatement(p.parent) && p.parent.tryBlock === p && p.parent.catchClause) {
            errors.push(`unfollowed sink chain ${key}: a catch at ${where(p.parent.catchClause)} encloses ${hop.param} in ${hop.fn}`);
          }
        }
        // The call that uses or forwards it, out through closures returning it, must be awaited or returned.
        let c: ts.Node | undefined = consumerOf(u);
        for (;;) {
          if (!c || !ts.isCallExpression(c)) { c = undefined; break; }
          const up = consumerOf(c);
          if (isClosure(up) && (up as Closure).body === outerOf(c) && ts.isCallExpression(consumerOf(up))) { c = consumerOf(up); continue; }
          break;
        }
        // S8: completion is the A6 form check: awaited, or returned outside any try with a finally.
        if (!c || !formOk(c) || isClosure(consumerOf(c))) {
          errors.push(`unfollowed sink chain ${key}: ${hop.fn} does not await or return the call that uses ${hop.param} at ${where(u)}`);
          continue;
        }
        const call = c as ts.CallExpression;
        const next = hops[i + 1];
        const nextFn = next && fnDecls.get(next.fn);
        // The slot the use travels in: the next hop's parameter, or the trusted adapter's callback (run's second argument).
        // One file: call is u's consumer, reached by walking u's parents.
        const slot = call.arguments.findIndex((a) => u.pos >= a.pos && u.end <= a.end);
        const wantSlot = next ? (nextFn?.parameters.findIndex((q) => ts.isIdentifier(q.name) && q.name.text === next.param) ?? -1) : 1;
        if (next ? calleeDecl(call) !== nextFn || slot !== wantSlot : !isTrustedAdapterCall(call) || slot !== wantSlot) {
          errors.push(`unfollowed sink chain ${key}: ${hop.fn} forwards ${hop.param} to ${call.expression.getText()}, not ${next ? `${next.fn}(${next.param})` : "AsyncLocalStorage.run(callback)"}`);
        }
      }
    });
  }

  // R-h1: an edge receiver that may suspend completes in the region it was called from.
  for (const [call, k] of asyncReceiverCalls) {
    if (regionOf(call).how === null) continue;
    if (!completedForm(call)) errors.push(`lock-lifetime: edge receiver ${k} called at ${where(call)} is neither awaited nor returned in a contract function`);
  }

  // ---- registry comparison ----------------------------------------------------

  const policies = new Set<string>(POLICIES);
  for (const [key, what] of found) {
    if (key.includes("#edge#")) {
      if (!(key in opts.registry.edges)) errors.push(`unregistered value escape ${key} (${what})`);
      continue;
    }
    if (what === "contained") continue;
    const policy = opts.registry.catches[key];
    if (policy === undefined) errors.push(`unregistered ${what} ${key}`);
    else if (!policies.has(policy)) errors.push(`unknown policy ${policy} for ${key}`);
  }
  for (const key of Object.keys(opts.registry.catches)) {
    if (found.get(key) === undefined || found.get(key) === "contained") errors.push(`stale registry key ${key}`);
  }
  for (const key of Object.keys(opts.registry.edges)) {
    if (!found.has(key)) errors.push(`stale edge key ${key}`);
  }
  for (const key of Object.keys(injected)) {
    if (!usedSlots.has(key)) errors.push(`stale injected awaited-callback slot ${key}`);
  }
  for (const key of contextParams) {
    if (!seenContextParams.has(key)) errors.push(`stale context-carrying parameter ${key}`);
  }
  /**
   * The checks that need the A1 owner set, run once every provider lookup has been made: R4-1's computed keys,
   * R4-3's assertions and the Proxy ruling, the last two through R5-1 reachability.
   */
  /** R5-1 report aid; the budget bounds one reachability query's visits. */
  const reach = { budget: opts.reachBudget ?? 5000, maxVisits: 0, exhausted: [] as string[], paths: {} as Record<string, string> };
  function launderingChecks(): void {
    /** Every named src type that is itself sensitive (any and unknown aliases aside): the targets R4-2 and R4-3 test against. */
    const sensitiveTypes: ts.Type[] = [];
    const sensitiveDecls = new Set<ts.Node>();
    for (const sf of files) {
      sf.forEachChild(function visit(n): void {
        if ((ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isClassDeclaration(n)) && n.name) {
          const t = checker.getTypeAtLocation(n.name);
          if (!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) && proxySensitive(t)) {
            sensitiveTypes.push(t);
            for (const d of t.getSymbol()?.declarations ?? []) sensitiveDecls.add(d);
          }
        }
        ts.forEachChild(n, visit);
      });
    }
    const assignableToSensitive = (t: ts.Type): boolean =>
      !!(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) || sensitiveTypes.some((s) => checker.isTypeAssignableTo(t, s));
    /**
     * R5-1: the path by which a sensitive type (the context, or a named src type that owns a guarded or seam slot, an
     * A1 owner's member, a lock-entry or contract function, or is a stage) is structurally reachable from t, or null.
     * It goes through union and intersection parts, the constraint of a conditional, indexed-access or other
     * instantiable type, alias and reference type arguments (so array and tuple elements), and, for a type declared
     * in src, every property, call and construct signature (return and parameter types) and index signature. A type
     * declared only in the default library or node_modules is reached only through its type arguments: its members
     * are written in terms of those. Such a type that is not generic but has an any or unknown member is not walked;
     * a value read through that member is untyped, and the untyped-provider rule refuses it wherever it supplies.
     * The visit set ends cycles; a query that exhausts the budget answers as reaching (fail closed).
     */
    /** R5-1: a default-library or node_modules file; every other file of the program (a src .d.ts too) is src. */
    const notSrc = (sf: ts.SourceFile): boolean => program.isSourceFileDefaultLibrary(sf) || sf.fileName.includes("/node_modules/");
    const reachMemo = new Map<ts.Type, string | null>();
    function reachesSensitive(t0: ts.Type): string | null {
      if (reachMemo.has(t0)) return reachMemo.get(t0)!;
      const seen = new Set<ts.Type>();
      let visits = 0;
      /** The path from t to the sensitive type, built only on a hit. */
      const visit = (t: ts.Type): string | null => {
        if (seen.has(t)) return null;
        seen.add(t);
        if (++visits > reach.budget) return " (visit budget exhausted)";
        const decls = [...(t.getSymbol()?.declarations ?? []), ...(t.aliasSymbol?.declarations ?? [])];
        if (isCtxType(t) || decls.some((d) => sensitiveDecls.has(d))) return ` = ${checker.typeToString(t)}`;
        const step = (x: ts.Type, at: () => string): string | null => {
          const p = visit(x);
          return p === null ? null : at() + p;
        };
        if (t.isUnionOrIntersection()) {
          for (const x of t.types) { const p = step(x, () => ` ${t.isUnion() ? "|" : "&"} ${checker.typeToString(x)}`); if (p) return p; }
          return null;
        }
        if (t.flags & ts.TypeFlags.Instantiable) {
          const c = checker.getBaseConstraintOfType(t);
          if (c && c !== t) { const p = step(c, () => " (constraint)"); if (p) return p; }
        }
        const args = [...(t.aliasTypeArguments ?? []), ...((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference ? checker.getTypeArguments(t as ts.TypeReference) : [])];
        for (const [k, x] of args.entries()) { const p = step(x, () => `<${k}>`); if (p) return p; }
        if (!(t.flags & ts.TypeFlags.Object)) return null;
        const own = t.getSymbol()?.declarations ?? [];
        if (own.length > 0 && own.every((d) => notSrc(d.getSourceFile()))) return null;
        for (const sig of [...t.getCallSignatures(), ...t.getConstructSignatures()]) {
          const r = step(sig.getReturnType(), () => "()"); if (r) return r;
          for (const q of sig.getParameters()) { const p = step(checker.getTypeOfSymbol(q), () => `(${q.name})`); if (p) return p; }
        }
        for (const ii of checker.getIndexInfosOfType(t)) { const p = step(ii.type, () => "[index]"); if (p) return p; }
        for (const m of checker.getPropertiesOfType(t)) { const p = step(checker.getTypeOfSymbol(m), () => `.${m.name}`); if (p) return p; }
        return null;
      };
      const hit = visit(t0);
      const r = hit === null ? null : checker.typeToString(t0) + hit;
      reach.maxVisits = Math.max(reach.maxVisits, visits);
      if (visits > reach.budget) reach.exhausted.push(checker.typeToString(t0));
      reachMemo.set(t0, r);
      return r;
    }
    // R4-3: an `as` or angle-bracket assertion into a type reaching a sensitive type (R5-1), from any other type, is UNRESOLVED
    // wherever it appears. `as const`, `!` and `satisfies` assert nothing new; satisfies stays a contextual flow.
    for (const sf of files) {
      sf.forEachChild(function visit(n): void {
        if (testOnlyInits.has(n)) return;
        if ((ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) && !ts.isConstTypeReference(n.type)) {
          const asserted = checker.getTypeFromTypeNode(n.type);
          const path = asserted !== checker.getTypeAtLocation(n.expression) ? reachesSensitive(asserted) : null;
          if (path) {
            reach.paths[where(n)] = path;
            errors.push(`UNRESOLVED assertion at ${where(n)} (asserted into a sensitive type)`);
          }
        }
        ts.forEachChild(n, visit);
      });
    }
    // R4-1: a write with a key the checker cannot reduce may name __proto__; on a sensitive receiver that is UNRESOLVED.
    for (const e of protoUnknownKeys) {
      if (proxySensitive(checker.getTypeAtLocation(e.expression))) errors.push(`UNRESOLVED prototype mutation at ${where(e)} (computed key on a sensitive type)`);
    }
    /** R5-2: a Proxy's result type reaching a sensitive type forges it as an assertion would. */
    const reachedBy = (nx: ts.NewExpression): boolean => {
      const path = reachesSensitive(checker.getTypeAtLocation(nx));
      if (path) reach.paths[where(nx)] = path;
      return !!path;
    };
    for (const nx of news) {
      if (libIdentity(nx.expression) !== "ProxyConstructor") continue;
      const [target, handler] = nx.arguments ?? [];
      const h = handler && skipOuter(handler);
      let why: string | null = null;
      if (!h || !ts.isObjectLiteralExpression(h)) why = "handler is not an object literal";
      else {
        const bad = h.properties.find((p) => !p.name || ts.isComputedPropertyName(p.name) || WRITE_TRAPS.has(p.name.getText().replace(/^["']|["']$/g, "")));
        if (bad) why = `handler member ${bad.name ? bad.name.getText() : "spread"} may write`;
        else if (!target || proxySensitive(checker.getTypeAtLocation(target)) || proxySensitive(checker.getContextualType(nx))
          || assignableToSensitive(checker.getTypeAtLocation(nx)) || reachedBy(nx)) {
          why = "target, flow or result type owns a guarded, provider, contract or lock member, or is untyped";
        }
      }
      if (why) errors.push(`UNRESOLVED Proxy at ${where(nx)} (${why})`);
    }
  }
  launderingChecks();
  const reviewed = opts.registry.unresolved ?? {};
  for (const [key, construct] of unresolved) {
    if (!(key in reviewed)) errors.push(`UNRESOLVED ${key} (${construct})`);
  }
  for (const key of Object.keys(reviewed)) {
    if (!unresolved.has(key)) errors.push(`stale UNRESOLVED key ${key}`);
  }

  const writerNames = [...writers].map((d) => {
    const name = fnName(d) ?? (ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) ? d.name.text : memberName(d) ?? "<anon>");
    return `${rel(d.getSourceFile())}#${name}`;
  }).sort();
  return {
    errors, found, sites, unresolved, writers: writerNames,
    tiers: { structural: [...usedStructural].sort(), viaCaller: [...neededVia].sort() },
    constructions,
    chainMembers: [...chainMembers].sort(),
    holderHints: [...new Set(holderHints)].sort(),
    memberProviders,
    reach,
  };
}

/** A program over in-memory files, for fixtures. Paths are POSIX, under `/fx`. */
export function inMemoryProgram(sources: Record<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noLib: false,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options, true);
  const real = { getSourceFile: host.getSourceFile, fileExists: host.fileExists, readFile: host.readFile };
  host.getSourceFile = (name, lang, ...rest) =>
    name in sources ? ts.createSourceFile(name, sources[name]!, lang, true) : real.getSourceFile(name, lang, ...rest);
  host.fileExists = (name) => name in sources || real.fileExists(name);
  host.readFile = (name) => sources[name] ?? real.readFile(name);
  const dirs = new Set(Object.keys(sources).map((f) => path.posix.dirname(f)));
  const realDirExists = host.directoryExists?.bind(host);
  host.directoryExists = (d) => dirs.has(d) || (realDirExists ? realDirExists(d) : false);
  host.realpath = (f) => f;
  return ts.createProgram(Object.keys(sources), options, host);
}
