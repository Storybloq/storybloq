/**
 * ISS-1499 slice A, A2: content shapes for the tail rule. The string side
 * (`splitLineage`, `readLineage`) and the file side (the scan) must agree on
 * every one of them.
 */
export const LINE = '<!-- storybloq-lineage v1 continues="2026-11-13-01-a.md" role="manager" at="abc1234" by="w@x.y" -->';

export interface TailShape {
  readonly name: string;
  readonly bytes: Buffer;
  readonly linked: boolean;
  /** The body `splitLineage` must return for a linked shape that has one. */
  readonly body?: string;
}

const b = (s: string): Buffer => Buffer.from(s, "utf8");

function atBoundary(lineStartFromEnd: number): Buffer {
  // The line plus its trailing padding fill exactly `lineStartFromEnd` final bytes.
  const pad = "\n" + " ".repeat(lineStartFromEnd - LINE.length - 1);
  return b("# Title\n\nSome body text.\n" + "x".repeat(3000) + "\n" + LINE + pad);
}

function straddle(linked: boolean): Buffer {
  // A three-byte euro sign starts one byte before the 2,048 byte boundary.
  const suffix = b("\n" + LINE + "\n");
  const filler = 2048 - 2 - suffix.length;
  const tail = Buffer.concat([b("y".repeat(filler)), suffix]);
  const head = b("# T\n\n" + "z".repeat(100) + "€");
  if (linked) return Buffer.concat([head, tail]);
  // No LF inside the final 2,048 bytes before the line: replace the LF with a space.
  return Buffer.concat([head, b("y".repeat(filler)), b(" " + LINE + "\n")]);
}

export const TAIL_SHAPES: readonly TailShape[] = [
  { name: "LF endings", bytes: b("# T\n\nbody\n\n" + LINE + "\n"), linked: true, body: "# T\n\nbody\n" },
  { name: "CRLF endings", bytes: b("# T\r\n\r\nbody\r\n\r\n" + LINE + "\r\n"), linked: true, body: "# T\r\n\r\nbody\r\n" },
  { name: "no final newline", bytes: b("# T\n\nbody\n\n" + LINE), linked: true, body: "# T\n\nbody\n" },
  { name: "trailing blank lines", bytes: b("# T\n\nbody\n\n" + LINE + "\n\n\n  \n\t\n"), linked: true, body: "# T\n\nbody\n" },
  { name: "more than 2,048 bytes of trailing spaces", bytes: b("# T\n\nbody\n\n" + LINE + "\n" + " ".repeat(2049)), linked: false },
  { name: "more than 2,048 bytes of trailing newlines", bytes: b("# T\n\nbody\n\n" + LINE + "\n".repeat(2100)), linked: false },
  { name: "candidate starts exactly at the 2,048 byte boundary", bytes: atBoundary(2048), linked: false },
  { name: "candidate starts one byte before the boundary", bytes: atBoundary(2047), linked: true },
  { name: "multi-byte character straddling the boundary, line inside", bytes: straddle(true), linked: true },
  { name: "multi-byte character straddling the boundary, no LF in the tail", bytes: straddle(false), linked: false },
  { name: "only the line", bytes: b(LINE + "\n"), linked: true, body: "" },
  { name: "only the line, no newline", bytes: b(LINE), linked: true, body: "" },
  { name: "unclosed code fence before the line", bytes: b("# T\n\n```\ncode\n\n" + LINE + "\n"), linked: true, body: "# T\n\n```\ncode\n" },
  { name: "no lineage at all", bytes: b("# T\n\nbody\n"), linked: false },
  { name: "a v2 line", bytes: b("# T\n\n<!-- storybloq-lineage v2 continues=\"a.md\" -->\n"), linked: false },
  { name: "a v10 line", bytes: b("# T\n\n<!-- storybloq-lineage v10 -->\n"), linked: false },
  { name: "the line followed by more text", bytes: b("# T\n\n" + LINE + "\nmore\n"), linked: false },
];
