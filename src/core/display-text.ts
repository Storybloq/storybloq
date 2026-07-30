/**
 * Neutralize untrusted text before it reaches a terminal (ISS-897).
 *
 * Session diagnostics render two things the process does not control: directory
 * names read off the filesystem, and values read out of a `state.json` that
 * failed validation. Both end up in `storybloq session list`, `session show`,
 * `session report`, and `storybloq status` output.
 *
 * A directory named with an ESC sequence, or an invalid enum value containing a
 * newline, can therefore move the cursor, recolour the screen, or add lines that
 * read as separate rows. That matters more here than in most output, because
 * these surfaces exist to be read during an incident, when the reader is
 * deciding whether another agent is running.
 *
 * `escapeMarkdownInline` does NOT cover this: it protects line-leading Markdown
 * markers and deliberately preserves everything else.
 *
 * Structured carriers keep the decoded value unmodified. Only the human-readable rendering
 * is sanitized, so a JSON consumer receives the decoded value unmodified.
 */

/**
 * C0 controls and DEL, plus the C1 range.
 *
 * C1 (U+0080-U+009F) is included because several terminals still interpret those
 * code points as control introducers when the stream is not strictly UTF-8, and
 * because no legitimate directory name or schema value needs them.
 *
 * The Unicode ranges matter for the same reason and are easy to miss, because
 * none of them is a "control character" in the C0 sense:
 *
 *  - U+2028/U+2029 (line and paragraph separator) are LINE BREAKS to many
 *    renderers, so they forge a row exactly as `\n` would
 *  - the Unicode `Bidi_Control` set REORDERS text visually without changing its
 *    bytes, so a directory name can be made to display as a different one --
 *    which defeats the whole point of a diagnostic that names the directory to
 *    go and inspect. The set is U+061C, U+200E/U+200F, U+202A-U+202E, and
 *    U+2066-U+2069, and it is enumerated here in full ON PURPOSE: the first cut
 *    covered the two obvious ranges and missed U+061C, which is the same class
 *    of character reached by a different script.
 *  - the INVISIBLE formatting characters do the same job by a simpler route.
 *    U+200B ZERO WIDTH SPACE renders as nothing at all, so `session` and
 *    `session<U+200B>` are two different directories that look identical in
 *    every diagnostic, every table and every prompt. That is the same spoof as
 *    a bidi override with less machinery, and it lands on the surface an
 *    operator reads while deciding which copy of a session is real.
 *
 * That last class is why this is a Unicode PROPERTY and not a list. The first
 * cut enumerated the ranges by hand and covered the obvious ones; review found
 * U+00AD SOFT HYPHEN, U+034F COMBINING GRAPHEME JOINER, U+180E MONGOLIAN VOWEL
 * SEPARATOR, the variation selectors and the astral tag characters still
 * passing through, each of them able to make two distinct filenames render
 * identically. An enumeration cannot be finished: every hand-written list is
 * one code point behind the next reviewer, and the property IS the question
 * being asked -- "does this render as nothing?" -- answered by Unicode instead
 * of by us.
 *
 * What the property does NOT cover stays enumerated beside it, and the two
 * omissions are deliberate rather than incidental.
 * `Default_Ignorable_Code_Point` subtracts `White_Space`, so U+2028/U+2029 are
 * not members; C0 and C1 are not members either. Both are here because they
 * are a different question: a character that ACTS on the terminal or forges a
 * line, not one that hides inside a name.
 *
 * This class matches whole CODE POINTS, not UTF-16 units: several members are
 * astral (the U+E0100 variation selectors, the U+E0000 tag characters), and the
 * `u` flag is what makes `.replace` consume a surrogate pair as one unit rather
 * than emitting two replacements for one character.
 *
 * `Surrogate` is the third question, and it depends on that same flag. A JSON
 * string may hold an UNPAIRED surrogate -- `"\\ud800"` parses without error --
 * and one is not a character: a terminal draws it as the replacement glyph, so
 * a name carrying one renders identically to a name carrying a literal U+FFFD,
 * to one carrying a different lone surrogate, and to any other invalid
 * sequence. That is the same visual collision the rest of this class exists to
 * prevent, arriving through a code point rather than through an invisible.
 * Under the `u` flag a valid pair is consumed as ONE astral code point and is
 * therefore not in `Surrogate` at all, so this member matches exactly the
 * unpaired ones and leaves real emoji and CJK extensions alone.
 */
const CONTROL_CHARACTER_CLASS =
  "[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\p{Default_Ignorable_Code_Point}\\p{Surrogate}]";
const CONTROL_CHARACTERS = new RegExp(CONTROL_CHARACTER_CLASS, "gu");
/**
 * The same class WITHOUT `g`.
 *
 * `.test` on a global regex advances `lastIndex`, so it alternates true and
 * false across calls on the same string -- which for the path encoder below
 * would mean every other dangerous path rendered as though it were clean.
 */
const HAS_CONTROL_CHARACTER = new RegExp(CONTROL_CHARACTER_CLASS, "u");

/** Longest rendering allowed before truncation, so one absurd value cannot flood a screen. */
export const MAX_DISPLAY_LENGTH = 300;

/**
 * The budget for authored PROSE, as opposed to a name (ISS-897).
 *
 * `MAX_DISPLAY_LENGTH` is a LABEL width -- it exists so one hostile directory
 * name cannot take the screen, and 300 characters is generous for a name. A
 * diagnostic `reason` is not a name. It is a paragraph this build wrote, and
 * the label cap cut it at 300 with the remedy still to come: on the collision
 * reason the surviving text ended at "which a name cannot establish" and the
 * sentence that got dropped was "do not delete anything on this diagnostic
 * alone". Truncating prose at the safety instruction is worse than not
 * truncating it.
 *
 * The prose is still sanitized and still bounded, because it INTERPOLATES
 * untrusted values -- names, serialized fields -- and those are individually
 * bounded before they get here. This cap is the backstop for their number, not
 * for their size.
 */
export const MAX_PROSE_LENGTH = 4000;

/**
 * The cap for a FILESYSTEM PATH, which is an address and not a label.
 *
 * A truncated path is not a shorter path, it is a wrong one: the whole point of
 * printing it is that the operator can go open it. 4096 is `PATH_MAX` on Linux
 * and above the practical limit on macOS, so truncation is unreachable for a
 * path that could actually exist, while a fabricated value still cannot flood a
 * screen.
 */
const MAX_PATH_LENGTH = 4096;

/**
 * Replace control characters with `?` and cap the length.
 *
 * `?` rather than deletion: a name that differs only by an invisible character
 * should still look different from one that does not, or an operator cannot tell
 * two rows apart.
 */
export function sanitizeDisplayText(value: string, maxLength = MAX_DISPLAY_LENGTH): string {
  const cleaned = value.replace(CONTROL_CHARACTERS, "?");
  if (cleaned.length <= maxLength) return cleaned;
  // `slice` counts UTF-16 UNITS, so a cap landing inside a surrogate pair
  // leaves a lone high surrogate -- which a terminal draws as the replacement
  // glyph. That defeats the one thing this function is for: the truncated form
  // of a name ending in an emoji then renders identically to the truncated form
  // of a name ending in a literal U+FFFD, and to any other astral character cut
  // at the same offset. `sanitizeDisplayPath` already trims to whole characters
  // for exactly this reason; the label path needs it too.
  return `${trimToWholeCharacters(cleaned.slice(0, maxLength))}... (truncated)`;
}

/**
 * Sanitize a path the operator is expected to ACT on.
 *
 * Bounded by `PATH_MAX` rather than by a label width, so a real address is
 * never rendered unusable -- and REVERSIBLE, which `sanitizeDisplayText` is
 * not. That difference is the whole reason this is a separate function.
 *
 * A label only has to be READABLE -- something a person can scan a list by,
 * with the dangerous code points visibly marked where they occur -- and `?` is
 * enough for that. It is not enough for identity, and does not claim to be:
 * every dangerous code point becomes the SAME `?`, and `?` is itself a legal
 * filename character, so `dir<ESC>x`, `dir<U+202E>x` and a directory genuinely
 * named `dir?x` all render as `dir?x`. A sanitized label is therefore never an
 * identity and never an address; telling two names apart, and opening either
 * one, are jobs for the reversible form below. An address has to be
 * RECOVERABLE:
 * it is printed next to "inspect by hand" precisely because no CLI selector can
 * reach it, so this string is the only record of which file was meant. `?` is
 * also a legal filename character, so the lossy rendering is not merely
 * incomplete -- it is ambiguous with a real path, and following it can open the
 * wrong file or none at all.
 *
 * So dangerous code points become `\uXXXX` escape TEXT (`\u{XXXXX}` above the
 * BMP), which is inert in a terminal and DECODES back to the exact input string.
 * Backslashes are doubled first so the encoding is unambiguous, and the suffix
 * says the escaping belongs to this rendering rather than to the name on disk.
 * Paths with nothing to escape -- effectively all of them -- are returned
 * returned unmodified and unmarked.
 *
 * Decoding is the step, and it is not the same as typing. Never hand this string
 * to a shell or a filesystem call as it stands: `\u001b` is six ordinary
 * characters, a directory whose literal name is those six characters is legal
 * and may exist, and the doubled backslashes are part of the encoding rather
 * than part of the name. Passing the rendering through unchanged therefore
 * addresses a DIFFERENT file -- the same wrong-target failure the lossy `?`
 * causes, reached from the other side. Decode the escapes back to the raw value
 * first, then run the containment and identity checks on the decoded name.
 */
export function sanitizeDisplayPath(value: string): string {
  // The cap applies to the RAW path, before expansion. Capping the encoding
  // instead would truncate a path that is perfectly legal on disk -- one
  // control character costs six -- and a truncated encoding is not a shorter
  // address, it is one that no longer decodes. Whether to truncate is a
  // question about the path; how many characters it takes to write down safely
  // is not.
  const overlong = value.length > MAX_PATH_LENGTH;
  const bounded = overlong ? trimToWholeCharacters(value.slice(0, MAX_PATH_LENGTH)) : value;
  const tail = overlong ? "... (truncated)" : "";
  // A backslash triggers the escaped form too, even with no control character
  // in sight, and that is what makes this INJECTIVE rather than merely
  // reversible. Without it the two branches overlap: a directory literally
  // NAMED with the escape text and the suffix is clean, so it would come back
  // as the same decoded string -- identical to what the other branch produces for the path
  // that actually carries the control character. Two distinct paths rendering
  // as one string is exactly the ambiguity this encoding exists to remove, and
  // it lands on the surface an operator is told to open by hand.
  //
  // With this, the branches cannot collide: the plain one emits no backslash at
  // all, and the escaped one always emits at least one.
  if (!HAS_CONTROL_CHARACTER.test(bounded) && !bounded.includes("\\")) return `${bounded}${tail}`;
  const encoded = bounded
    .replace(/\\/gu, "\\\\")
    .replace(CONTROL_CHARACTERS, (c) => {
      const cp = c.codePointAt(0)!;
      // `\\u{...}` for anything outside the BMP. `\\u` takes exactly four hex
      // digits, so an astral code point rendered that way decodes to a
      // DIFFERENT path rather than failing to decode -- silently wrong, which
      // for an address the operator is told to open by hand is the worst
      // outcome available. Both spellings are inert escape TEXT and both
      // round-trip.
      return cp > 0xffff
        ? `\\u{${cp.toString(16)}}`
        : `\\u${cp.toString(16).padStart(4, "0")}`;
    });
  return `${encoded}${tail}  (rendered with \\uXXXX or \\u{XXXXX} escapes and doubled backslashes; decode them to get the name on disk)`;
}

/**
 * Drop a trailing lone surrogate left by slicing at a fixed code-unit index.
 *
 * Half of an astral character is not a shorter name either, and it renders as a
 * replacement glyph that looks like part of the path.
 *
 * Still needed even though `CONTROL_CHARACTER_CLASS` now covers unpaired
 * surrogates, because this one is created AFTER that pass: the class removes
 * the surrogates that were in the input, and the slice then cuts a pair that
 * survived it.
 */
function trimToWholeCharacters(value: string): string {
  const last = value.charCodeAt(value.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? value.slice(0, -1) : value;
}
