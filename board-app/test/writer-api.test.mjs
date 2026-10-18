import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { signature, generateWriterTypes } from "../writer-api.mjs";

// Captured before any test regenerates it, so the comparison is against the
// declaration this checkout carries, not one a sibling test just wrote.
const declarationPath = "src/canonical-writes.d.mts";
const workingDeclaration = await readFile(declarationPath, "utf8");

const sample = `export async function write(id: string, updates: {title: string}, force = false, hooks?: {before: () => Promise<void>}): Promise<{output: string}> { throw new Error(); }`;
async function compile(declaration, consumer) {
  const dir = await mkdtemp(join(tmpdir(), "story-writer-contract-"));
  try {
    await writeFile(join(dir, "api.d.mts"), declaration);
    const file = join(dir, "consumer.mts");
    await writeFile(file, consumer);
    const program = ts.createProgram([file], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: false,
      noEmit: true,
      types: ["node"],
      typeRoots: [resolve("node_modules/@types")],
    });
    return ts.getPreEmitDiagnostics(program).map((d) => ({
      code: d.code,
      message: ts.flattenDiagnosticMessageText(d.messageText, " "),
    }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const call = (code) => `import {write} from './api.mjs'; ${code}`;
test("generated signatures preserve default optionality, hooks and typed output", async () => {
  const declaration = signature(sample, "write");
  assert.deepEqual(
    await compile(
      declaration,
      call(
        `const r = await write('id', {title:'Text'}); const body: string = r.output; await write('id', {title:'Text'}, false, {before: async () => {}});`,
      ),
    ),
    [],
  );
});
for (const [name, code] of [
  ["input", `await write('id', {title:42});`],
  ["force", `await write('id', {title:'Text'}, 'yes');`],
  ["hook", `await write('id', {title:'Text'}, false, {before: () => 42});`],
  ["return", `const n: number = (await write('id', {title:'Text'})).output;`],
])
  test("generated consumer rejects invalid " + name, async () => {
    const errors = await compile(signature(sample, "write"), call(code));
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.ok([2322, 2345].includes(errors[0].code), JSON.stringify(errors));
  });
test("signature changes regenerate a different consumer contract", async () => {
  const revised = signature(
    sample.replace("title: string", "title: number"),
    "write",
  );
  assert.notEqual(revised, signature(sample, "write"));
  assert.deepEqual(
    await compile(revised, call(`await write('id', {title:42});`)),
    [],
  );
  const errors = await compile(
    revised,
    call(`await write('id', {title:'old shape'});`),
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 2322);
});
test("generation refuses absent handlers, ambiguous overloads, unsupported defaults and unknown types", () => {
  assert.throws(() => signature(sample, "absent"), /handler/i);
  assert.throws(() => signature(sample + sample, "write"), /handler/i);
  assert.throws(
    () => signature(sample.replace("force = false", "force = 'yes'"), "write"),
    /default/i,
  );
  assert.throws(
    () => signature("export function write(id:string) { return id; }", "write"),
    /return/i,
  );
  assert.throws(
    () =>
      signature("export function write(value: UnknownType): void {}", "write"),
    /type/i,
  );
});
test("canonical type references cannot silently bind to a different module", () => {
  const sourceUrl = new URL(
    "../../src/cli/commands/ticket.ts",
    import.meta.url,
  );
  const correct = `import type {Ticket} from '../../models/ticket.js'; export function write(item: Ticket): void {}`;
  assert.match(signature(correct, "write", sourceUrl), /item: Ticket/);
  assert.throws(
    () =>
      signature(
        correct.replace("../../models/ticket.js", "./unrelated.js"),
        "write",
        sourceUrl,
      ),
    /type|module/i,
  );
  assert.throws(
    () =>
      signature(
        "interface Ticket {wrong: number} export function write(item: Ticket): void {}",
        "write",
        sourceUrl,
      ),
    /type|module/i,
  );
});
test("the real generated canonical API validates consumers without skipping declaration checks", async () => {
  await generateWriterTypes();
  const api = JSON.stringify(resolve("src/canonical-writes.mjs"));
  const prefix = `import {handleTicketUpdate, handleIssueUpdate} from ${api}; `;
  const valid = `const r = await handleTicketUpdate('T-001', {title:'Text'}, 'json', '/project'); const body: string = r.output; await handleTicketUpdate('T-001', {description:'Body'}, 'json', '/project', false, {precondition: async (item, state) => { const title: string = item.title; const project: string = state.config.project; }, validatePreparedContent: text => { const bytes: string = text; }}); await handleIssueUpdate('ISS-001', {impact:'Impact', resolution:null}, 'json', '/project', {validatePreparedContent: async text => {}});`;
  assert.deepEqual(await compile("", prefix + valid), []);
  for (const invalid of [
    `await handleTicketUpdate('T-001', {title:42}, 'json', '/project');`,
    `await handleTicketUpdate('T-001', {title:'Text'}, 'json', '/project', 'force');`,
    `await handleIssueUpdate('ISS-001', {impact:'Text'}, 'json', '/project', {precondition: () => 42});`,
    `const n: number = (await handleIssueUpdate('ISS-001', {impact:'Text'}, 'json', '/project')).output;`,
  ]) {
    const errors = await compile("", prefix + invalid);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.ok([2322, 2345].includes(errors[0].code), JSON.stringify(errors));
  }
  const generated = await readFile("src/canonical-writes.d.mts", "utf8");
  assert.ok(
    generated.includes("handleTicketUpdate") &&
      generated.includes("handleIssueUpdate"),
  );
  assert.ok(!generated.includes("handleTicketCreate"));
});

test("generated note API binds actual canonical inputs, optional hooks and typed acknowledgments", async () => {
  await generateWriterTypes();
  const api = JSON.stringify(resolve("src/canonical-writes.mjs"));
  const prefix = `import {handleNoteUpdate} from ${api}; `;
  assert.deepEqual(
    await compile(
      "",
      prefix +
        `const result = await handleNoteUpdate('N-001', {title:null, content:'Body', tags:[], status:'archived'}, 'json', '/project'); const output: string = result.output; await handleNoteUpdate('N-001', {title:'Title'}, 'json', '/project', undefined, {precondition: async (note, state) => { const body: string = note.content; const project: string = state.config.project; }, validatePreparedContent: async text => { const serialized: string = text; }});`,
    ),
    [],
  );
  for (const invalid of [
    `await handleNoteUpdate('N-001', {title:42}, 'json', '/project');`,
    `await handleNoteUpdate('N-001', {tags:'tag'}, 'json', '/project');`,
    `await handleNoteUpdate('N-001', {content:'Body'}, 'json', '/project', undefined, {precondition: () => 42});`,
    `await handleNoteUpdate('N-001', {content:'Body'}, 'json', '/project', {precondition: async () => {}});`,
    `await handleNoteUpdate('N-001', {content:'Body'}, 'json', '/project', {confirm: 'x'});`,
    `const number: number = (await handleNoteUpdate('N-001', {title:'Title'}, 'json', '/project')).output;`,
  ]) {
    const errors = await compile("", prefix + invalid);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.ok(
      [2322, 2345, 2353, 2741].includes(errors[0].code),
      JSON.stringify(errors),
    );
  }
  assert.match(
    await readFile("src/canonical-writes.d.mts", "utf8"),
    /handleNoteUpdate/,
  );
});

// T-566 F1: main's note handler takes hatches in slot five and hooks in slot six.
const noteUrl = new URL("../../src/cli/commands/note.ts", import.meta.url);
test("the real six-argument note handler generates with hatches before hooks", async () => {
  const generated = await generateWriterTypes();
  assert.match(
    generated,
    /export declare function handleNoteUpdate\(id: string, updates: NoteUpdateInput, format: OutputFormat, root: string, hatches\?: NoteUpdateHatches, hooks\?: UpdateWriteHooks<Note>\): Promise<CommandResult>;/,
  );
  assert.match(
    generated,
    /import type \{ NoteUpdateHatches \} from "\.\.\/\.\.\/src\/core\/update-inputs\.js";/,
  );
  const api = JSON.stringify(resolve("src/canonical-writes.mjs"));
  assert.deepEqual(
    await compile(
      "",
      `import {handleNoteUpdate} from ${api}; await handleNoteUpdate('N-001', {content:'Body', confirmReplace: true}, 'json', '/project', {confirm: 'a', append: 'b'}, {validatePreparedContent: async () => {}});`,
    ),
    [],
  );
});
test("a locally declared or misbound NoteUpdateHatches is refused", () => {
  const bound = `import type {NoteUpdateHatches} from '../../core/update-inputs.js'; export function write(hatches: NoteUpdateHatches): void {}`;
  assert.match(signature(bound, "write", noteUrl), /hatches: NoteUpdateHatches/);
  assert.throws(
    () =>
      signature(
        "export interface NoteUpdateHatches {confirm: string; append: string} export function write(hatches: NoteUpdateHatches): void {}",
        "write",
        noteUrl,
      ),
    /canonical module/,
  );
  // A local declaration shadows even a correct canonical import.
  assert.throws(
    () =>
      signature(
        bound.replace(
          "export function",
          "interface NoteUpdateHatches {confirm: string; append: string} export function",
        ),
        "write",
        noteUrl,
      ),
    /canonical module/,
  );
  assert.throws(
    () =>
      signature(
        bound.replace("../../core/update-inputs.js", "./note-hatches.js"),
        "write",
        noteUrl,
      ),
    /canonical module/,
  );
  assert.throws(
    () =>
      signature(
        bound.replace(
          "{NoteUpdateHatches}",
          "{NoteUpdateInput as NoteUpdateHatches}",
        ),
        "write",
        noteUrl,
      ),
    /canonical module/,
  );
});
test("the generated canonical API matches the working-tree declaration byte for byte", async () => {
  assert.equal(await generateWriterTypes(), workingDeclaration);
  assert.equal(await readFile(declarationPath, "utf8"), workingDeclaration);
});
