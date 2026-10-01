/**
 * T-536 check set 5: what counts as citing the setup skill. Frozen with check set 5 and never derived from the live
 * skill, so a sentence stays detectable after the skill deletes it. Two arms:
 *
 * - the explanatory sentences agents quoted in their packages, historical ones included, each matched as a whole
 *   normalised entry (lower case, straight quotes, whitespace collapsed, the final period dropped) with no letter or
 *   digit directly before or after it;
 * - the setup skill's paths: anything ending in `skills/story/<file>`, or a bare `setup-flow.md` or `SKILL.md`.
 *
 * Mandated output text (the closing lines, the labels, the probe and status lines), the governance files a package
 * proposes and the project's own sources are never matched.
 */

export const PROHIBITED_SENTENCES: readonly string[] = [
  "One approval of the setup package authorises all of it.",
  "Nothing is written before approval.",
  "One approval covers everything listed.",
  "Nothing is created until you approve it.",
];

/** Lower case, typographic quotes made straight, whitespace runs collapsed to one space. */
export function normalise(text: string): string {
  return text.toLowerCase().replace(/[‘’‚‛]/g, "'").replace(/[“”„‟]/g, '"').replace(/\s+/g, " ");
}

const ENTRIES: readonly string[] = PROHIBITED_SENTENCES.map((s) => normalise(s).replace(/\.$/, ""));
const WORD_CHAR = /[\p{L}\p{N}]/u;
const SKILL_PATH = /(?:^|[^\p{L}\p{N}_.\/-])((?:[\p{L}\p{N}_.~\/-]*\/)?skills\/story\/[\p{L}\p{N}_.-]+)/gu;
const SKILL_FILE = /(?:^|[^\p{L}\p{N}_.\/-])(setup-flow\.md|SKILL\.md)(?![\p{L}\p{N}_-])/gu;

export interface SkillCitation {
  readonly kind: "sentence" | "path";
  readonly match: string;
}

/** Every setup skill citation in `text`, sentences first, then paths. */
export function findSkillCitations(text: string): SkillCitation[] {
  const out: SkillCitation[] = [];
  const norm = normalise(text);
  PROHIBITED_SENTENCES.forEach((sentence, i) => {
    const entry = ENTRIES[i]!;
    for (let at = norm.indexOf(entry); at >= 0; at = norm.indexOf(entry, at + 1)) {
      const before = at === 0 ? "" : norm[at - 1]!;
      const after = norm[at + entry.length] ?? "";
      if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) { out.push({ kind: "sentence", match: sentence }); break; }
    }
  });
  for (const re of [SKILL_PATH, SKILL_FILE]) for (const m of text.matchAll(re)) out.push({ kind: "path", match: m[1]! });
  return out;
}

/**
 * Every occurrence of a corpus sentence in `text`, whole or broken across lines, as [start, end) offsets into `text`.
 * The text is normalised one character at a time so each normalised character keeps the offset it came from.
 */
function sentenceSpans(text: string): [number, number][] {
  let norm = "";
  const at: number[] = [];
  let offset = 0;
  for (const ch of text) {
    const piece = normalise(ch);
    for (let k = 0; k < piece.length; k++) {
      if (piece[k] === " " && norm.endsWith(" ")) continue;
      norm += piece[k]!;
      at.push(offset);
    }
    offset += ch.length;
  }
  const spans: [number, number][] = [];
  for (const entry of ENTRIES) {
    for (let i = norm.indexOf(entry); i >= 0; i = norm.indexOf(entry, i + 1)) {
      const before = i === 0 ? "" : norm[i - 1]!;
      const after = norm[i + entry.length] ?? "";
      if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) spans.push([at[i]!, at[i + entry.length - 1]! + 1]);
    }
  }
  return spans;
}

/**
 * The lines of `text` that carry a citation, in order, each once: a line that cites by itself, and every line any
 * occurrence of a corpus sentence touches, so a sentence broken across lines lists each of its lines.
 */
export function citingLines(text: string): string[] {
  const lines = text.split("\n");
  const hit = new Set<number>();
  lines.forEach((line, i) => { if (findSkillCitations(line).length > 0) hit.add(i); });
  const starts: number[] = [];
  lines.reduce((start, line) => { starts.push(start); return start + line.length + 1; }, 0);
  for (const [from, to] of sentenceSpans(text)) {
    lines.forEach((line, i) => { if (starts[i]! < to && starts[i]! + line.length > from) hit.add(i); });
  }
  return lines.filter((_, i) => hit.has(i));
}
