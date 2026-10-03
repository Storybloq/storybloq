import ts from "typescript";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Only side-effect-free canonical type modules belong in this adapter surface.
const typeModules = {
  CommandResult: "../../src/cli/types.js",
  TicketUpdateInput: "../../src/core/update-inputs.js",
  IssueUpdateInput: "../../src/core/update-inputs.js",
  NoteUpdateInput: "../../src/core/update-inputs.js",
  UpdateWriteHooks: "../../src/core/update-write-hooks.js",
  Ticket: "../../src/models/ticket.js",
  Issue: "../../src/models/issue.js",
  Note: "../../src/models/note.js",
  OutputFormat: "../../src/models/types.js",
};
const allowedTypes = new Set(["Promise", ...Object.keys(typeModules)]);

function checkBinding(name, source, sourceUrl) {
  if (!sourceUrl) return;
  const bindings = [];
  let localDeclaration = false;
  for (const statement of source.statements) {
    if (
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name?.text === name
    )
      localDeclaration = true;
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause?.name?.text === name) bindings.push(null);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
      for (const binding of clause.namedBindings.elements)
        if (binding.name.text === name)
          bindings.push({
            imported: binding.propertyName?.text ?? binding.name.text,
            module: statement.moduleSpecifier.text,
          });
  }
  if (name === "Promise") {
    if (localDeclaration || bindings.length)
      throw new Error("Writer type shadows the global Promise contract");
    return;
  }
  const binding = bindings[0];
  const destination = new URL("src/canonical-writes.d.mts", import.meta.url);
  if (
    localDeclaration ||
    bindings.length !== 1 ||
    !binding ||
    binding.imported !== name ||
    new URL(binding.module, sourceUrl).href !==
      new URL(typeModules[name], destination).href
  )
    throw new Error(
      "Writer type is not bound to its canonical module: " + name,
    );
}

function checkType(type, source, sourceUrl) {
  function visit(node) {
    if (
      node.kind === ts.SyntaxKind.AnyKeyword ||
      node.kind === ts.SyntaxKind.UnknownKeyword ||
      ts.isImportTypeNode(node) ||
      ts.isTypeQueryNode(node)
    )
      throw new Error("Unsupported writer type: " + node.getText(source));
    if (
      ts.isTypeReferenceNode(node) &&
      (!ts.isIdentifier(node.typeName) || !allowedTypes.has(node.typeName.text))
    )
      throw new Error("Unresolved writer type: " + node.getText(source));
    if (ts.isTypeReferenceNode(node))
      checkBinding(node.typeName.text, source, sourceUrl);
    ts.forEachChild(node, visit);
  }
  visit(type);
}

/** Derive a declaration from the handler source; unsupported changes fail closed. */
export function signature(sourceText, functionName, sourceUrl) {
  const source = ts.createSourceFile(
    "handler.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (source.parseDiagnostics.length)
    throw new Error("Cannot parse writer handler source");
  const matches = source.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === functionName,
  );
  if (
    matches.length !== 1 ||
    !matches[0].body ||
    !matches[0].modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  )
    throw new Error("Expected one exported writer handler: " + functionName);
  const handler = matches[0];
  if (handler.typeParameters?.length)
    throw new Error(
      "Generic writer handler types need explicit adapter support",
    );
  if (!handler.type)
    throw new Error("Writer handler needs an explicit return type");
  checkType(handler.type, source, sourceUrl);
  const parameters = handler.parameters.map((parameter) => {
    if (!ts.isIdentifier(parameter.name))
      throw new Error("Unsupported writer parameter pattern");
    let type = parameter.type;
    if (!type) {
      if (
        parameter.name.text !== "force" ||
        parameter.initializer?.kind !== ts.SyntaxKind.FalseKeyword
      )
        throw new Error("Unsupported inferred writer parameter default");
      type = ts.factory.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword);
    } else checkType(type, source, sourceUrl);
    return ts.factory.createParameterDeclaration(
      undefined,
      parameter.dotDotDotToken,
      parameter.name,
      parameter.questionToken ||
        (parameter.initializer
          ? ts.factory.createToken(ts.SyntaxKind.QuestionToken)
          : undefined),
      type,
      undefined,
    );
  });
  const declaration = ts.factory.createFunctionDeclaration(
    [
      ts.factory.createModifier(ts.SyntaxKind.ExportKeyword),
      ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword),
    ],
    undefined,
    handler.name,
    undefined,
    parameters,
    handler.type,
    undefined,
  );
  return ts
    .createPrinter()
    .printNode(ts.EmitHint.Unspecified, declaration, source);
}

export async function generateWriterTypes() {
  const declarations = [];
  for (const [file, handler] of [
    ["ticket", "handleTicketUpdate"],
    ["issue", "handleIssueUpdate"],
    ["note", "handleNoteUpdate"],
  ]) {
    const path = new URL(
      "../src/cli/commands/" + file + ".ts",
      import.meta.url,
    );
    declarations.push(signature(await readFile(path, "utf8"), handler, path));
  }
  const imports = Object.entries(typeModules)
    .map(
      ([name, path]) => `import type { ${name} } from ${JSON.stringify(path)};`,
    )
    .join("\n");
  const content =
    "// Generated by writer-api.mjs from canonical handlers. Do not edit.\n" +
    imports +
    "\n\n" +
    declarations.join("\n\n") +
    "\n";
  const destination = new URL("src/canonical-writes.d.mts", import.meta.url);
  let previous;
  try {
    previous = await readFile(destination, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (content !== previous) await writeFile(destination, content);
  return content;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await generateWriterTypes();
