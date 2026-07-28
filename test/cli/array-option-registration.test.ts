import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  discoverUnresolvableRegistrations,
  discoverWrapperReferenceEscapes,
  discoverPolicyModuleIndirectImports,
} from "./array-registration-inventory.js";

/**
 * Completeness gate for ISS-886.
 *
 * The comma/empty/trim policy of an array option is attached inside
 * `arrayOption` / `arrayPositional` via a yargs coerce callback, so registration
 * and policy cannot be separated. That guarantee only holds while those wrappers
 * are the ONLY way an array value gets registered. This test enforces that by
 * PROHIBITION rather than by extraction: it fails on any raw array registration
 * anywhere under src/cli, in any existing or future file.
 *
 * Known residual limit, stated rather than papered over: an options object whose
 * properties are spread from a runtime value cannot be resolved statically by any
 * such pass. The wrappers being the only sanctioned path plus code review cover
 * that case.
 */

const CLI_DIR = fileURLToPath(new URL("../../src/cli", import.meta.url));
const POLICY_MODULE = join(CLI_DIR, "array-options.ts");

/**
 * The one legitimate `type: "array"` outside the policy module: the JSON Schema
 * describing the reviewer's own output, built by `reviewSchema()`. Bound to its
 * exact ancestry and count so a raw yargs registration cannot take its place by
 * merely sitting under some other `findings` property.
 */
const JSON_SCHEMA_EXCEPTION = {
  file: join(CLI_DIR, "commands", "codex-review.ts"),
  declarationName: "reviewSchema",
  propertyPath: ["properties", "findings"],
  count: 1,
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

interface Hit {
  file: string;
  line: number;
  kind: "array-true" | "type-array" | "array-call";
  /** Full enclosing property chain, outermost first, for ancestry assertions. */
  propertyPath: string[];
  /** Nearest enclosing named declaration or function. */
  declarationName: string | null;
  /** Nearest enclosing function declaration. */
  functionName: string | null;
}

/** Every enclosing property name, outermost first. */
function enclosingPropertyPath(node: ts.Node): string[] {
  const path: string[] = [];
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isPropertyAssignment(cur)) {
      const name = propertyName(cur.name);
      if (name !== null) path.unshift(name);
    }
  }
  return path;
}

function enclosingDeclarationName(node: ts.Node): string | null {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
  }
  return null;
}

/** Nearest enclosing function declaration, skipping intermediate variables. */
function enclosingFunctionName(node: ts.Node): string | null {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
  }
  return null;
}

/**
 * Resolves a property name, including the computed string form `{ ["array"]: true }`.
 * Returns null only for genuinely dynamic keys, which no static pass can resolve.
 */
function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const inner = unwrap(name.expression);
    if (ts.isStringLiteralLike(inner)) return inner.text;
  }
  return null;
}

/** Strips `as const`, `satisfies`, `<T>x`, and parentheses from an initializer. */
function unwrap(node: ts.Expression): ts.Expression {
  let cur = node;
  for (;;) {
    if (ts.isAsExpression(cur) || ts.isTypeAssertionExpression(cur)) cur = cur.expression;
    else if (ts.isSatisfiesExpression(cur)) cur = cur.expression;
    else if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else return cur;
  }
}

function scan(file: string): Hit[] {
  const text = readFileSync(file, "utf-8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const hits: Hit[] = [];

  const record = (node: ts.Node, kind: Hit["kind"]) => {
    hits.push({
      file,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      kind,
      propertyPath: enclosingPropertyPath(node),
      declarationName: enclosingDeclarationName(node),
      functionName: enclosingFunctionName(node),
    });
  };

  const visit = (node: ts.Node): void => {
    // `.array("name")` -- the yargs API a regex sweep misses entirely -- and its
    // element-access spelling `y["array"]("name")`.
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const calleeName = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isElementAccessExpression(callee) &&
            ts.isStringLiteralLike(callee.argumentExpression)
          ? callee.argumentExpression.text
          : null;
      if (calleeName === "array") record(node, "array-call");
    }

    // Shorthand `{ array }` where the binding resolves to a literal true.
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === "array") {
      record(node, "array-true");
    }

    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      // `array: true as const` and `type: "array" as const` are the forms the
      // wrappers themselves use, so the scanner must see through assertions and
      // parentheses or it would miss the very pattern it is policing.
      const initializer = unwrap(node.initializer);
      // Covers quoted keys ("array": true) as well as bare ones.
      if (name === "array" && initializer.kind === ts.SyntaxKind.TrueKeyword) {
        record(node, "array-true");
      }
      if (
        name === "type" &&
        ts.isStringLiteralLike(initializer) &&
        initializer.text === "array"
      ) {
        record(node, "type-array");
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);
  return hits;
}

describe("CLI array option registration gate (ISS-886)", () => {
  const files = sourceFiles(CLI_DIR);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain(join(CLI_DIR, "register.ts"));
    expect(files).toContain(join(CLI_DIR, "commands", "bus.ts"));
  });

  it("registers array values only through arrayOption or arrayPositional", () => {
    const violations = files
      .filter((f) => f !== POLICY_MODULE && f !== JSON_SCHEMA_EXCEPTION.file)
      .flatMap(scan)
      .map((h) => `${relative(CLI_DIR, h.file).split(sep).join("/")}:${h.line} (${h.kind})`);

    expect(
      violations,
      "Raw yargs array registrations bypass the comma/empty/trim policy. " +
        "Register through arrayOption/arrayPositional in src/cli/array-options.ts instead.",
    ).toEqual([]);
  });

  it("permits the codex-review JSON Schema only at its exact ancestry", () => {
    const hits = scan(JSON_SCHEMA_EXCEPTION.file);
    expect(hits).toHaveLength(JSON_SCHEMA_EXCEPTION.count);
    const [hit] = hits;
    expect(hit!.kind).toBe("type-array");
    // Bound to the declaration AND the full property chain, so a raw
    // registration cannot qualify by sitting under some other `findings`.
    expect(hit!.declarationName).toBe(JSON_SCHEMA_EXCEPTION.declarationName);
    expect(hit!.propertyPath).toEqual(JSON_SCHEMA_EXCEPTION.propertyPath);
  });

  it("keeps every wrapper call statically nameable, so none escapes the coverage matrix", () => {
    // The prohibition above only proves array values are registered THROUGH the
    // wrappers. A wrapper call whose flag names cannot be read statically -- a
    // computed name, a spec map spread from a variable -- would pass that gate and
    // then never be demanded by the e2e coverage matrix, which is a silent hole
    // rather than a failure. This closes it.
    const unresolved = discoverUnresolvableRegistrations().map(
      (u) => `${relative(CLI_DIR, u.file).split(sep).join("/")}:${u.line} ${u.reason}`,
    );
    expect(
      unresolved,
      "These registrations cannot be enumerated statically, so the coverage matrix " +
        "cannot require an end-to-end case for them. Pass inline literals instead.",
    ).toEqual([]);
  });

  it("forbids aliasing a wrapper, which would hide a registration from both gates", () => {
    // Both scanners recognize a wrapper by the callee's textual name, so
    // `import { arrayOptions as addArrays }` or `const addArrays = arrayOptions`
    // would still register options while appearing in NEITHER inventory: nothing
    // enumerated, nothing flagged. Forbidding the alias is deterministic where
    // resolving it would need a full Program and type checker.
    const escapes = discoverWrapperReferenceEscapes().map(
      (e) => `${relative(CLI_DIR, e.file).split(sep).join("/")}:${e.line} ${e.reason}`,
    );
    expect(
      escapes,
      "A wrapper must be called directly by name. Aliasing or passing it as a value " +
        "hides the registration from the inventory and from the coverage matrix.",
    ).toEqual([]);

    const indirect = discoverPolicyModuleIndirectImports().map(
      (e) => `${relative(CLI_DIR, e.file).split(sep).join("/")}:${e.line} ${e.reason}`,
    );
    expect(indirect, "Import the wrappers by name, not as a namespace or default.").toEqual([]);
  });

  it("pins the policy module's own raw registration to its exact call sites", () => {
    // Proves the scanner detects what it claims to, and that the exemption is not
    // a blanket pass: a second raw registration inside the policy module fails
    // this count.
    const hits = scan(POLICY_MODULE);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe("array-true");
    expect(hits[0]!.declarationName).toBe("config");
    expect(hits[0]!.functionName).toBe("register");

    // The single `config` object is what makes one array-true node enough for the
    // whole module, so reusing it for another direct yargs registration would add
    // no new node and pass the count above. Pin the call sites too: exactly one
    // y.option and one y.positional, both inside register().
    const source = readFileSync(POLICY_MODULE, "utf-8");
    const sf = ts.createSourceFile(POLICY_MODULE, source, ts.ScriptTarget.Latest, true);
    // Both spellings: y.option(...) and the equivalent y["option"](...), which a
    // property-access-only resolver would not see.
    const memberCallName = (node: ts.CallExpression): string | null => {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
      if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
        return callee.argumentExpression.text;
      }
      return null;
    };

    const calls: { name: string; fn: string | null }[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = memberCallName(node);
        if (name === "option" || name === "positional") {
          calls.push({ name, fn: enclosingFunctionName(node) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    expect(calls).toEqual([
      { name: "positional", fn: "register" },
      { name: "option", fn: "register" },
    ]);

    // `config` itself must not travel: passing it to a helper, exporting it, or
    // aliasing it would let another registration reuse the sanctioned object
    // without adding a call site the assertion above can see. It may appear ONLY
    // as its own declaration and as an argument to one of the two pinned calls --
    // an argument to any other member call (helper.sneak(y, config),
    // y.option.call(y, "x", config)) is reported, since the call inventory above
    // would see the name "sneak" or "call" rather than "option".
    const configRefs: string[] = [];
    const visitConfig = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === "config") {
        const parent = node.parent;
        const isDeclaration = ts.isVariableDeclaration(parent) && parent.name === node;
        const isPinnedArgument =
          ts.isCallExpression(parent) &&
          parent.arguments.includes(node) &&
          (memberCallName(parent) === "option" || memberCallName(parent) === "positional") &&
          enclosingFunctionName(parent) === "register";
        if (!isDeclaration && !isPinnedArgument) {
          configRefs.push(
            `line ${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`,
          );
        }
      }
      ts.forEachChild(node, visitConfig);
    };
    visitConfig(sf);
    expect(
      configRefs,
      "The shared yargs config object must not escape register(): another " +
        "registration could reuse it without adding a visible call site.",
    ).toEqual([]);
  });
});
