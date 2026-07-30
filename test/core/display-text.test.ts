import { describe, it, expect } from "vitest";
import { sanitizeDisplayText, sanitizeDisplayPath } from "../../src/core/display-text.js";
import { escapeMarkdownDocumentStrict } from "../../src/core/output-formatter.js";

/**
 * A LABEL may be lossy. An ADDRESS may not (ISS-897).
 *
 * The two functions differ on purpose, and the difference is easy to erase by
 * "simplifying" one into the other. `sanitizeDisplayText` renders a name so a
 * reader can tell two rows apart, and `?` is enough for that.
 * `sanitizeDisplayPath` renders the string an operator is told to go open BY
 * HAND -- printed exactly where no CLI selector can reach it -- so a rendering
 * they cannot type back is a dead end, and one that is ambiguous with a real
 * path is worse than a dead end: `?` is a legal filename character, so the
 * lossy form can name a different, existing file.
 */
describe("sanitizeDisplayPath is reversible, unlike sanitizeDisplayText", () => {
  /** [label, fragment carrying the raw code point, the escape text it must render as] */
  const DANGEROUS: [string, string, string][] = [
    ["ESC", "\u001b[2J", "\\u001b"],
    ["newline", "a\u000ab", "\\u000a"],
    ["carriage return", "a\u000db", "\\u000d"],
    ["NUL", "a\u0000b", "\\u0000"],
    ["DEL", "a\u007fb", "\\u007f"],
    ["C1 CSI", "a\u009bb", "\\u009b"],
    ["line separator", "a\u2028b", "\\u2028"],
    ["paragraph separator", "a\u2029b", "\\u2029"],
    ["Arabic letter mark", "a\u061cb", "\\u061c"],
    ["RTL override", "a\u202eb", "\\u202e"],
    ["isolate", "a\u2066b", "\\u2066"],
    ["zero width space", "a\u200bb", "\\u200b"],
    ["zero width non-joiner", "a\u200cb", "\\u200c"],
    ["word joiner", "a\u2060b", "\\u2060"],
    ["BOM / zero width no-break space", "a\ufeffb", "\\ufeff"],
    // Each of these was passing through the hand-written class. They are here
    // by NAME rather than as a property assertion because the lesson is that an
    // enumeration cannot be finished: every one of them is invisible, every one
    // makes two distinct filenames render identically, and none of them looked
    // like a "control character" to the person writing the first list.
    ["soft hyphen", "a\u00adb", "\\u00ad"],
    ["combining grapheme joiner", "a\u034fb", "\\u034f"],
    ["Mongolian vowel separator", "a\u180eb", "\\u180e"],
    ["Hangul filler", "a\u3164b", "\\u3164"],
    ["variation selector 16", "a\ufe0fb", "\\ufe0f"],
    // ASTRAL, and the reason the escape notation had to grow a second form:
    // `\\uXXXX` takes exactly four hex digits, so rendering U+E0101 that way
    // produces `\\ue0101`, which decodes as U+E010 followed by "1" -- a
    // different, silently wrong path.
    ["astral variation selector", "a\u{E0101}b", "\\u{e0101}"],
    ["astral language tag", "a\u{E0001}b", "\\u{e0001}"],
  ];

  const SUFFIX =
    "  (rendered with \\uXXXX or \\u{XXXXX} escapes and doubled backslashes; decode them to get the name on disk)";
  // What must not SURVIVE in the rendered address. Written as the property plus
  // the three things the property deliberately excludes, mirroring production
  // -- the point is that the output contains no member of the class at all,
  // whichever member went in.
  const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Default_Ignorable_Code_Point}]/u;

  it.each(DANGEROUS)("encodes %s as recoverable escape text", (_label, raw, escape) => {
    const out = sanitizeDisplayPath(`/tmp/${raw}/state.json`);
    expect(out).toContain(escape);
    // Inert: nothing that survives is itself a control character, so the
    // address is still safe to print into a terminal during an incident.
    expect(out).not.toMatch(CONTROLS);
    // ...and it says the escaping belongs to the RENDERING, so the operator
    // does not go looking for a directory with a literal backslash in its name.
    expect(out).toContain("decode them to get the name on disk");
  });

  it.each(DANGEROUS)("round-trips %s back to the exact original", (_label, raw) => {
    const value = `/tmp/${raw}/state.json`;
    const rendered = sanitizeDisplayPath(value).replace(SUFFIX, "");
    // The decode an operator would perform: one left-to-right pass, so a
    // doubled backslash is consumed before it can be read as an escape.
    // Both escape forms, and the braced one FIRST: `\\u{e0101}` also matches the
    // four-digit alternative at `\\ue010`, so an alternation that tries the
    // short form first decodes an astral escape into the wrong character plus
    // three stray digits -- which is exactly the ambiguity the braced form
    // exists to remove, reintroduced by the decoder.
    const decoded = rendered.replace(
      /\\\\|\\u\{([0-9a-f]+)\}|\\u([0-9a-f]{4})/gu,
      (_m, braced: string | undefined, short: string | undefined) => {
        const hex = braced ?? short;
        return hex === undefined ? "\\" : String.fromCodePoint(Number.parseInt(hex, 16));
      },
    );
    expect(decoded).toBe(value);
  });

  it("doubles pre-existing backslashes so the encoding stays unambiguous", () => {
    // Without the doubling, a directory literally NAMED `\\u001b` and one
    // CONTAINING the ESC character render identically, and the decode above
    // then reconstructs the wrong path for one of them.
    const literalName = sanitizeDisplayPath("/tmp/a\\u001b\u0000/x");
    const realControl = sanitizeDisplayPath("/tmp/a\u001b/x");
    expect(literalName).toContain("\\\\u001b");
    expect(realControl).toContain("\\u001b");
    expect(literalName).not.toBe(realControl);
  });

  it("returns an ordinary path unmodified and unannotated", () => {
    // The overwhelmingly common case. Annotating it too would train operators
    // to skip the annotation on the one path that needs it.
    const plain = "/Users/x/proj/.story/sessions/not-a-uuid";
    expect(sanitizeDisplayPath(plain)).toBe(plain);
  });

  it("still caps an absurd value so it cannot flood a screen", () => {
    expect(sanitizeDisplayPath("a".repeat(5000))).toContain("... (truncated)");
    expect(sanitizeDisplayPath(`a\u001b${"b".repeat(5000)}`)).toContain("... (truncated)");
  });

  it("does not alternate across repeated calls", () => {
    // `.test` on a `g` regex advances `lastIndex`, so the guard that chooses
    // between the two renderings has to hold a non-global copy of the class.
    // Two identical calls returning different strings is the exact symptom, and
    // it would surface as an address printed raw every other time.
    const value = "/tmp/a\u001bb";
    const first = sanitizeDisplayPath(value);
    expect(sanitizeDisplayPath(value)).toBe(first);
    expect(sanitizeDisplayPath(value)).toBe(first);
  });


  it("keeps an INVISIBLE character from making two names look identical", () => {
    // The point of replacing rather than deleting, reached by a different
    // character class. U+200B and friends render as nothing, so `session` and
    // `session<ZWSP>` are two directories that display the same in every
    // diagnostic, table and prompt an operator uses to decide which copy of a
    // session is real -- the same spoof a bidi override performs, with less
    // machinery.
    const ZWSP = String.fromCharCode(0x200b);
    expect(sanitizeDisplayText(`session${ZWSP}`)).not.toBe("session");
    expect(sanitizeDisplayText(`session${ZWSP}`)).toBe("session?");
    // And on the ADDRESS path it stays recoverable, not merely different.
    expect(sanitizeDisplayPath(`/tmp/session${ZWSP}`)).toContain("\\u200b");
  });

  it("collapses an ASTRAL invisible to ONE replacement, not two", () => {
    // The `u` flag is doing real work here. Without it the class matches UTF-16
    // units, so one astral character becomes `??` -- and `session<VS18>` then
    // renders two characters wider than `session<ZWSP>` for no reason a reader
    // could account for, on the surface where they are comparing two names by
    // eye to decide which session is real.
    const VS18 = String.fromCodePoint(0xe0101);
    expect(VS18.length, "fixture is not astral").toBe(2);
    expect(sanitizeDisplayText(`session${VS18}`)).toBe("session?");
  });

  it("does not sanitize characters that merely LOOK unusual", () => {
    // The property is narrow on purpose. Widening detection to "not ASCII"
    // would mangle every legitimate non-Latin directory name into a row of
    // question marks, which destroys the thing the sanitizer exists to protect:
    // an operator's ability to tell two names apart.
    for (const value of ["session-\u00e9t\u00e9", "\u30bb\u30c3\u30b7\u30e7\u30f3", "\u0645\u062c\u0644\u062f", "emoji-\u{1f600}"]) {
      expect(sanitizeDisplayText(value), value).toBe(value);
      expect(sanitizeDisplayPath(`/tmp/${value}`), value).toBe(`/tmp/${value}`);
    }
  });

  it("never truncates a LABEL through the middle of an astral character", () => {
    // `slice` counts UTF-16 units, so a cap landing inside a surrogate pair
    // leaves a lone high surrogate. A terminal draws that as the replacement
    // glyph -- and the whole job of this function is keeping two names
    // distinguishable, so a truncation that renders every astral character at
    // the boundary as the SAME glyph defeats it at the one place it is being
    // asked to work hardest.
    const EMOJI = "\u{1f600}";
    expect(EMOJI.length, "fixture is not astral").toBe(2);
    // Cap lands exactly between the two surrogates.
    const value = `${"a".repeat(299)}${EMOJI}tail`;
    const out = sanitizeDisplayText(value);

    expect(out).toContain("... (truncated)");
    // No lone surrogate anywhere in the result.
    for (let i = 0; i < out.length; i += 1) {
      const c = out.charCodeAt(i);
      const isHigh = c >= 0xd800 && c <= 0xdbff;
      const isLow = c >= 0xdc00 && c <= 0xdfff;
      if (isHigh) {
        const next = out.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff, `lone high surrogate at ${i}`).toBe(true);
        i += 1;
      } else {
        expect(isLow, `lone low surrogate at ${i}`).toBe(false);
      }
    }
    // The pair is dropped whole rather than half-kept.
    expect(out.startsWith("a".repeat(299))).toBe(true);
    expect(out).not.toContain(EMOJI);
  });

  it("treats an UNPAIRED surrogate as dangerous, and a real pair as a character", () => {
    // A JSON string can hold `\ud800` on its own -- it parses, and it is not a
    // character. A terminal draws it as the replacement glyph, so a name
    // carrying one is indistinguishable from a name carrying a literal U+FFFD,
    // from one carrying a DIFFERENT lone surrogate, and from any other invalid
    // sequence. That is the visual collision this whole class exists to
    // prevent, arriving through a code point rather than an invisible.
    const HI = String.fromCharCode(0xd800);
    const LO = String.fromCharCode(0xdc00);
    const PAIR = String.fromCodePoint(0x1f600);

    // The LABEL substitutes, like every other dangerous code point.
    expect(sanitizeDisplayText(`a${HI}b`)).toBe("a?b");
    expect(sanitizeDisplayText(`a${LO}b`)).toBe("a?b");
    // The ADDRESS escapes reversibly, and the two directions stay APART --
    // which `?` cannot do and is the reason this renderer exists.
    expect(sanitizeDisplayPath(`/s/a${HI}b`)).toContain("a\\ud800b");
    expect(sanitizeDisplayPath(`/s/a${LO}b`)).toContain("a\\udc00b");
    expect(sanitizeDisplayPath(`/s/a${HI}b`)).not.toBe(sanitizeDisplayPath(`/s/a${LO}b`));

    // A VALID pair is a character and must survive both renderers untouched.
    // Under the `u` flag it is one astral code point and so is not in
    // `Surrogate` at all; without that flag this test is what goes red.
    expect(sanitizeDisplayText(`a${PAIR}b`)).toBe(`a${PAIR}b`);
    expect(sanitizeDisplayPath(`/s/a${PAIR}b`)).toBe(`/s/a${PAIR}b`);
  });

  it("keeps the LABEL renderer lossy, which is what it is for", () => {
    // Not an oversight waiting to be fixed the same way: a label is compared by
    // eye against the label beside it, and `?` keeps two names looking
    // different without spending width on escape text. Only an address has to
    // be recoverable.
    expect(sanitizeDisplayText("a\u001bb")).toBe("a?b");
    expect(sanitizeDisplayText("a\u001bb")).not.toContain("\\u");
  });
});

/**
 * The two passes do not commute, and the wrong order is not visibly wrong
 * (ISS-897).
 *
 * Encoding and Markdown-neutralizing are each defensible on their own, so the
 * rule that decides their ORDER lives only in prose -- in `renderingSafety` in
 * the guard matrix, and in the docblocks at the call sites. Prose cannot fail a
 * build. This executes both compositions on the same inputs and pins the
 * difference, so a future "tidy-up" that swaps them at a call site is caught
 * here rather than in a rendered client.
 */
describe("encode first, neutralize Markdown second", () => {
  const BACKSLASH = String.fromCharCode(92);
  const forward = (raw: string): string =>
    escapeMarkdownDocumentStrict(sanitizeDisplayPath(raw));
  const reversed = (raw: string): string =>
    sanitizeDisplayPath(escapeMarkdownDocumentStrict(raw));

  it("is the order that leaves Markdown structure inert", () => {
    // The whole reason for the rule. `escapeMarkdownDocument` doubles
    // backslashes as its FIRST step, so running it last means the `\[` it just
    // wrote is the last word. Running it first means the encoder doubles that
    // same backslash afterwards, and `\\[` renders as an escaped BACKSLASH
    // followed by a live `[` -- the bracket is structural again.
    const raw = "a[b](https://evil.example)";

    // Correct order: one backslash before the bracket, so the bracket is text.
    expect(forward(raw)).toContain(`a${BACKSLASH}[b`);
    expect(forward(raw)).not.toContain(`${BACKSLASH}${BACKSLASH}[`);
    expect(forward(raw)).not.toContain("](https://evil.example)");

    // Reversed: the bracket comes back.
    expect(reversed(raw)).toContain(`${BACKSLASH}${BACKSLASH}[`);
  });

  it("and the autolink neutralization survives it, rather than being re-broken", () => {
    const raw = "see https://evil.example";
    expect(forward(raw)).not.toContain("https://evil.example");
    expect(forward(raw)).toContain("&#58;//");
    // Reversed, the encoder runs over an already-entity-escaped string and the
    // suffix it appends is itself un-neutralized -- a second way the order
    // leaks structure that the first pass had removed.
    expect(reversed(`bad${BACKSLASH}u001b`)).not.toContain(
      `${BACKSLASH}${BACKSLASH}(rendered`,
    );
  });

  it("but injectivity is NOT what the order buys -- both orders keep the pair apart", () => {
    // Stated because the opposite is an easy and attractive thing to believe,
    // and the fixture prose asserted it until this test was written. A real
    // U+001B and a directory literally named with the six characters
    // `\u001b` must never render alike, or a collision report names the wrong
    // file -- and they do not, under EITHER composition, because whichever pass
    // sees the literal backslash doubles it. The order is decided by inertness
    // alone; claiming a second reason invites someone to check it, find it
    // false, and discount the first.
    const realEsc = String.fromCharCode(27);
    const literal = `${BACKSLASH}u001b`;

    expect(forward(realEsc)).not.toBe(forward(literal));
    expect(reversed(realEsc)).not.toBe(reversed(literal));
  });
});
