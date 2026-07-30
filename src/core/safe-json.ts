/**
 * Render an untrusted value as text without throwing and without flooding
 * (ISS-897).
 *
 * Every diagnostic that reports "this field held X" reaches for
 * `JSON.stringify`, and on this path X is a value parsed out of a `state.json`
 * this build has already decided it cannot interpret. Two things go wrong with
 * the bare call, and both are reachable from a file on disk:
 *
 *  - It THROWS. `JSON.stringify` recurses, so a sufficiently nested value
 *    exhausts the stack and raises `RangeError`. The asymmetry is the problem:
 *    `JSON.parse` accepts depths the encoder cannot handle, so a file of 20000
 *    nested arrays parses without complaint and then crashes the scan when the
 *    diagnostic about it is built. A guard whose contract is to fail closed on
 *    an untrusted payload must not fail by crashing -- the caller is left with
 *    no verdict at all, which is strictly worse than the `unverifiable` the
 *    diagnostic was being written to produce. Hand-built failures can also
 *    carry cycles or BigInt, which throw for their own reasons.
 *  - It has no bound. A large value produces a large string, and these strings
 *    go into an incident report a person is reading to find out whether another
 *    agent is running. Burying that answer is its own denial of service.
 *
 * So: never throw, always bound, and say which happened rather than quietly
 * substituting something shorter. `absent` and `unserializable` are FINDINGS --
 * "the field could not be rendered" is information about the record, and
 * omitting it would leave the reader assuming the field was fine.
 *
 * The result is text, not a value. It still has to go through display
 * sanitization and, for a Markdown sink, `escapeMarkdownDocumentStrict` --
 * bounding a string does not make its contents inert, and every nested key and
 * value the payload chose is inside this one.
 */

/** Long enough to identify a value, short enough not to bury the sentence around it. */
export const MAX_SERIALIZED_LENGTH = 500;

/**
 * The budget for text that then goes through `sanitizeDisplayText` (ISS-897).
 *
 * Two bounds in a row is one bound too many, and the SECOND one wins silently.
 * `sanitizeDisplayText` caps at `MAX_DISPLAY_LENGTH` and appends its own bare
 * "... (truncated)" -- so a 500-character serialization was cut again at 300
 * and the "(truncated from N characters)" suffix, which is the part carrying
 * the magnitude, was exactly what got dropped. The reader was left with a
 * shortened value and no way to tell whether it was a field or a flood.
 *
 * So a serialization headed for that sink is bounded to fit INSIDE it, suffix
 * included, and the outer cap becomes a bound that never has to fire.
 */
export const MAX_DISPLAY_SERIALIZED_LENGTH = 200;

export function safeJson(value: unknown, maxLength = MAX_SERIALIZED_LENGTH): string {
  // `JSON.stringify(undefined)` is `undefined`, not a string, and an absent
  // field is a different report from a null one.
  if (value === undefined) return "absent";

  let text: string;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return "unserializable";
    text = encoded;
  } catch {
    // Depth, a cycle, a BigInt. Which one it was is not something the reader
    // can act on; that it could not be rendered is.
    return "unserializable";
  }

  if (text.length <= maxLength) return text;
  // The ORIGINAL length is reported, because "truncated" without a magnitude
  // tells a reader nothing about whether they are looking at a field or at a
  // payload built to bury the line it sits on.
  return `${trimTrailingSurrogate(text.slice(0, maxLength))}... (truncated from ${text.length} characters)`;
}

/**
 * Drop a high surrogate stranded by slicing at a fixed code-unit index.
 *
 * Half a character renders as the replacement glyph, which is indistinguishable
 * from a literal U+FFFD in the value itself.
 */
function trimTrailingSurrogate(value: string): string {
  const last = value.charCodeAt(value.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? value.slice(0, -1) : value;
}

/**
 * The same problem one layer out: a value going into a JSON RESPONSE (ISS-897).
 *
 * `safeJson` protects a value being rendered into prose. It does nothing for a
 * value handed to a caller's own `JSON.stringify` -- and `session list
 * --format json` did exactly that with `rawVersion`, so a `state.json` nested
 * deeper than the encoder can go made the whole listing throw. The bounded
 * `reason` string beside it was no protection at all; the field next to it was
 * the raw value.
 *
 * Two outcomes, on separate keys, because a consumer must be able to TELL them
 * apart. Substituting a string for an unencodable value would be
 * indistinguishable from a `schemaVersion` that genuinely is a string.
 */
export type JsonSafeField =
  | { readonly rawVersion: unknown }
  | { readonly rawVersionSerialization: string };

export function rawVersionField(value: unknown, maxLength = MAX_DISPLAY_SERIALIZED_LENGTH): JsonSafeField {
  try {
    const encoded = JSON.stringify(value);
    // Encodable AND small: publish the value itself, so the ordinary case
    // keeps the shape a consumer expects.
    if (encoded !== undefined && encoded.length <= maxLength) return { rawVersion: value };
  } catch {
    // Falls through to the bounded serialization.
  }
  return { rawVersionSerialization: safeJson(value, maxLength) };
}
