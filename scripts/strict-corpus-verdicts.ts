/**
 * ISS-1398: the zod verdict for each case of the Mac app's strict-ledger
 * corpus. Reads `[{kind, label, json}]` (json is raw JSON text) on stdin and
 * prints `{label: boolean}`: whether the CLI's own schema accepts
 * `JSON.parse(json)`. A text JSON.parse rejects prints false. The app's
 * StrictLedgerSchemaDifferentialTests compares its validator against this.
 *
 * Run with tsx: LessonSchema is not exported from the package entry point.
 */
import { TicketSchema } from "../src/models/ticket.js";
import { IssueSchema } from "../src/models/issue.js";
import { NoteSchema } from "../src/models/note.js";
import { LessonSchema } from "../src/models/lesson.js";

const schemas = { ticket: TicketSchema, issue: IssueSchema, note: NoteSchema, lesson: LessonSchema } as const;

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const cases = JSON.parse(input) as Array<{ kind: keyof typeof schemas; label: string; json: string }>;
const verdicts: Record<string, boolean> = {};
for (const c of cases) {
  const schema = schemas[c.kind];
  if (!schema) throw new Error(`unknown kind ${c.kind} in ${c.label}`);
  if (Object.prototype.hasOwnProperty.call(verdicts, c.label)) throw new Error(`duplicate label ${c.label}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(c.json);
  } catch {
    verdicts[c.label] = false;
    continue;
  }
  verdicts[c.label] = schema.safeParse(parsed).success;
}
process.stdout.write(JSON.stringify(verdicts));
