import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Shared registration inventory for ISS-886.
 *
 * The prohibition gate (array-option-registration.test.ts) proves no array value
 * is registered OUTSIDE the policy wrappers. This module proves the complementary
 * half: it enumerates every registration that goes THROUGH those wrappers, so the
 * end-to-end suite can assert it covers all of them and a newly added array option
 * fails the suite until it has a case.
 *
 * Together the two directions close the loop, but only because
 * `discoverUnresolvableRegistrations` refuses to ignore what it cannot read: a
 * registration built dynamically would otherwise pass the prohibition gate and
 * never be demanded by the coverage matrix.
 */

export const CLI_DIR = fileURLToPath(new URL("../../src/cli", import.meta.url));

/** The module that DEFINES the wrappers. */
export const POLICY_MODULE = join(CLI_DIR, "array-options.ts");

/** The three sanctioned registration wrappers. */
export const WRAPPER_NAMES = ["arrayOption", "arrayOptions", "arrayPositional"] as const;

export interface ArrayRegistration {
  /** Full command path, e.g. "ticket update". */
  command: string;
  /** Flag or positional name as the user types it, e.g. "blocked-by". */
  name: string;
  /** "positional" for arrayPositional, "option" for arrayOption/arrayOptions. */
  form: "option" | "positional";
}

/** Registration key used by the e2e coverage assertion: "ticket update --blocked-by". */
export function registrationKey(r: ArrayRegistration): string {
  return `${r.command} ${r.form === "positional" ? `[${r.name}]` : `--${r.name}`}`;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Callee name for `f(...)`, `o.f(...)`, and `o["f"](...)`. */
function calleeName(node: ts.CallExpression): string | null {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
    return callee.argumentExpression.text;
  }
  return null;
}

/**
 * The command path a node sits inside, outermost first. yargs nests builders, so
 * `.command("ticket", ..., y => y.command("update", ...))` yields ["ticket", "update"].
 * The yargs signature string is reduced to its command word: "dispatch [ids..]"
 * becomes "dispatch".
 *
 * Only a command whose BUILDER argument contains the node counts. Sibling commands
 * in the same chain must not: `y.command("delete", ..).command("update", ..)` parses
 * as `(y.command("delete", ..)).command("update", ..)`, so climbing from inside
 * "delete"'s builder passes through "update"'s call node as an ancestor. Requiring
 * the node to sit in an argument at index >= 1 excludes those, since a sibling is
 * reached through `cur.expression` instead.
 */
function enclosingCommandPath(node: ts.Node): string[] {
  const path: string[] = [];
  let child: ts.Node = node;
  for (let cur: ts.Node | undefined = node.parent; cur; child = cur, cur = cur.parent) {
    if (!ts.isCallExpression(cur) || calleeName(cur) !== "command") continue;
    if (cur.arguments.indexOf(child as ts.Expression) < 1) continue;
    const first = cur.arguments[0];
    if (first && ts.isStringLiteralLike(first)) {
      path.unshift(first.text.split(/[\s[<]/)[0]!);
    }
  }
  return path;
}

/** Property name, including the computed string form `{ ["tags"]: ... }`. */
function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return null;
}

/** A wrapper call whose registered names could not be resolved statically. */
export interface UnresolvedRegistration {
  file: string;
  line: number;
  reason: string;
}

/** Nearest enclosing function declaration. */
function enclosingFunction(node: ts.Node): ts.FunctionDeclaration | null {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur)) return cur;
  }
  return null;
}

/**
 * The one wrapper call that is a definition-internal delegation rather than a
 * registration: `arrayOption(out, name, spec)` inside `arrayOptions`, where the
 * flag name is a parameter by design.
 *
 * Recognized by its exact shape, not just by location: the file, the callee, the
 * enclosing declaration being the top-level exported `arrayOptions`, and the
 * argument list being exactly the identifiers `(out, name, spec)`. Matching on
 * location alone would also skip an `arrayOption(out, "hidden", spec)` added
 * beside it, which registers a real option that neither inventory would then
 * demand a test for. The caller additionally requires exactly ONE match.
 */
function isInternalDelegation(file: string, node: ts.CallExpression, callee: string | null): boolean {
  if (file !== POLICY_MODULE || callee !== "arrayOption") return false;

  const fn = enclosingFunction(node);
  const isTopLevelExportedArrayOptions =
    fn !== null &&
    fn.name?.text === "arrayOptions" &&
    ts.isSourceFile(fn.parent) &&
    (ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Export) !== 0;
  if (!isTopLevelExportedArrayOptions) return false;

  const expected = ["out", "name", "spec"];
  return (
    node.arguments.length === expected.length &&
    node.arguments.every((arg, i) => ts.isIdentifier(arg) && arg.text === expected[i])
  );
}

/**
 * References to a wrapper that are not a direct call.
 *
 * The scanners recognize a wrapper by the callee's textual name, so an alias
 * (`import { arrayOptions as addArrays }`, or `const addArrays = arrayOptions`)
 * would still invoke the real wrapper while escaping BOTH inventories: no
 * registration recorded, and nothing flagged as unreadable. Rather than resolve
 * aliases, this forbids them: a wrapper name may appear only as a call target, as
 * an unaliased import specifier, or as its own declaration.
 */
export function discoverWrapperReferenceEscapes(): UnresolvedRegistration[] {
  const escapes: UnresolvedRegistration[] = [];
  const names = new Set<string>(WRAPPER_NAMES);

  for (const file of sourceFiles(CLI_DIR)) {
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, "utf-8"),
      ts.ScriptTarget.Latest,
      true,
    );

    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && names.has(node.text)) {
        const parent = node.parent;
        const isCallTarget = ts.isCallExpression(parent) && parent.expression === node;
        const isPlainImport = ts.isImportSpecifier(parent) && parent.propertyName === undefined;
        const isOwnDeclaration =
          file === POLICY_MODULE && ts.isFunctionDeclaration(parent) && parent.name === node;
        if (!isCallTarget && !isPlainImport && !isOwnDeclaration) {
          escapes.push({
            file,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            reason: `${node.text} is referenced somewhere other than a direct call`,
          });
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sf);
  }

  return escapes;
}

/**
 * Namespace or default imports of the policy module, which make every wrapper
 * call reachable as a property access that the name-based scanners do not see.
 */
export function discoverPolicyModuleIndirectImports(): UnresolvedRegistration[] {
  const indirect: UnresolvedRegistration[] = [];

  for (const file of sourceFiles(CLI_DIR)) {
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, "utf-8"),
      ts.ScriptTarget.Latest,
      true,
    );

    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const spec = statement.moduleSpecifier;
      if (!ts.isStringLiteralLike(spec) || !spec.text.endsWith("array-options.js")) continue;
      const clause = statement.importClause;
      if (clause === undefined) continue;
      const reason =
        clause.name !== undefined
          ? "default import of the policy module"
          : clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)
            ? "namespace import of the policy module"
            : null;
      if (reason !== null) {
        indirect.push({
          file,
          line: sf.getLineAndCharacterOfPosition(statement.getStart(sf)).line + 1,
          reason,
        });
      }
    }
  }

  return indirect;
}

/**
 * Scans every wrapper call site, separating registrations it could name from
 * calls it could not.
 *
 * The unresolved list is the honest half. A statically invisible registration
 * would otherwise be a silent coverage hole: the prohibition gate would still
 * pass (the wrapper IS being used), and the coverage matrix would not demand a
 * row for something it never saw. Surfacing them lets the gate fail loudly
 * instead, so the residual limit is enforced rather than merely documented.
 */
function scanRegistrations(): {
  registrations: ArrayRegistration[];
  unresolved: UnresolvedRegistration[];
} {
  const found: ArrayRegistration[] = [];
  const unresolved: UnresolvedRegistration[] = [];
  const delegations: UnresolvedRegistration[] = [];

  for (const file of sourceFiles(CLI_DIR)) {
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, "utf-8"),
      ts.ScriptTarget.Latest,
      true,
    );

    const flag = (node: ts.Node, reason: string): void => {
      unresolved.push({
        file,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        reason,
      });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = calleeName(node);
        const isWrapper =
          callee === "arrayOptions" || callee === "arrayOption" || callee === "arrayPositional";

        if (isWrapper && isInternalDelegation(file, node, callee)) {
          // Skipped, not excluded. Recorded so the count can be checked: a second
          // call of this exact shape would mean the delegation was duplicated, and
          // silently skipping both is what would hide a real registration.
          delegations.push({
            file,
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            reason: "internal arrayOption delegation inside arrayOptions",
          });
        } else if (isWrapper) {
          const command = enclosingCommandPath(node).join(" ");
          const spec = node.arguments[1];

          if (spec === undefined) {
            flag(node, `${callee} called without a name or spec argument`);
          } else if (command === "") {
            // Every wrapper call today sits inside a .command() builder. One that
            // did not would produce a key the matrix cannot express.
            flag(node, `${callee} is not inside a .command() builder`);
          } else if (callee === "arrayOptions") {
            if (!ts.isObjectLiteralExpression(spec)) {
              flag(node, "arrayOptions spec map is not an inline object literal");
            } else {
              for (const prop of spec.properties) {
                if (!ts.isPropertyAssignment(prop)) {
                  flag(prop, "arrayOptions spec map uses a spread or shorthand property");
                  continue;
                }
                const name = propertyName(prop.name);
                if (name === null) flag(prop, "arrayOptions spec map uses a dynamic key");
                else found.push({ command, name, form: "option" });
              }
            }
          } else if (!ts.isStringLiteralLike(spec)) {
            flag(node, `${callee} name is not a string literal`);
          } else {
            found.push({
              command,
              name: spec.text,
              form: callee === "arrayPositional" ? "positional" : "option",
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sf);
  }

  // Exactly one internal delegation is expected. Zero means the pin has drifted
  // from the implementation and is no longer matching anything, which would let a
  // later real call through under the same name; more than one means a second call
  // was written in the sanctioned shape and skipped along with it.
  if (delegations.length !== 1) {
    const detail = `expected exactly 1 internal arrayOption delegation, found ${delegations.length}`;
    if (delegations.length === 0) {
      unresolved.push({ file: POLICY_MODULE, line: 1, reason: detail });
    } else {
      unresolved.push(...delegations.map((d) => ({ ...d, reason: detail })));
    }
  }

  found.sort((a, b) => registrationKey(a).localeCompare(registrationKey(b)));
  return { registrations: found, unresolved };
}

/** Every array registration made through the policy wrappers, statically named. */
export function discoverArrayRegistrations(): ArrayRegistration[] {
  return scanRegistrations().registrations;
}

/**
 * Wrapper calls whose registered names are not statically visible. Must stay
 * empty: each one is a registration the coverage matrix cannot require a row for.
 */
export function discoverUnresolvableRegistrations(): UnresolvedRegistration[] {
  return scanRegistrations().unresolved;
}
