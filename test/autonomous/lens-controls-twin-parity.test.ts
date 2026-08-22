import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LENSES } from "@storybloq/lenses";

/**
 * The Mac panel draws a CHECKBOX PER LENS from a hardcoded copy of this
 * registry (T-471).
 *
 * It cannot import `@storybloq/lenses` -- no runtime holds both languages -- so
 * the list is a copy, and a copy of someone else's registry is wrong the moment
 * that registry moves. The failure is worse here than a stale number would be,
 * because the panel does not merely DISPLAY the list, it WRITES it: ticking
 * every box on an app whose copy is short one lens would produce a config that
 * excludes the missing one.
 *
 * The app defends against exactly that by writing `auto` when everything is
 * ticked, so a stale copy cannot silently narrow a review (see
 * `tickingEveryBoxWritesAutoRatherThanAList` on the Swift side). This gate is
 * the other half: it makes the staleness itself visible, so a lens added here
 * turns the panel red instead of quietly going unofferable.
 *
 * Read rather than imported, and inert in the public projection, for the same
 * reason as the other twin gates: `Storybloq/storybloq` carries `storybloq/`
 * only.
 */

const here = resolve(fileURLToPath(import.meta.url), "..");
const panelPath = resolve(here, "../../../macos/claudestory/Views/Detail/AutonomousSettingsPanel.swift");
const swiftPresent = existsSync(panelPath);

describe.skipIf(!swiftPresent)("the Mac panel's lens list", () => {
  it("offers exactly the registry's lenses, in the registry's order", () => {
    const src = readFileSync(panelPath, "utf-8");
    const decl = src.indexOf("static let knownLenses");
    expect(decl, "could not find the lens table in the Swift panel").toBeGreaterThan(-1);
    // From the literal's opening bracket, not the identifier: the type
    // annotation `[(id: String, label: String)]` closes a bracket first, and
    // slicing to that one parses an empty block.
    const start = src.indexOf("= [", decl);
    expect(start, "could not find the table literal").toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("]", start));

    // ANY quoted id, not a pattern built from the ids this test expects: a
    // stricter pattern would skip an extra or misspelled row and leave the
    // count matching, reporting parity for a table the panel does not have.
    const re = /\("([^"]*)",\s*"([^"]*)"\)/g;
    const rows: [string, string][] = [];
    for (let m = re.exec(block); m !== null; m = re.exec(block)) rows.push([m[1]!, m[2]!]);

    // Vacuous-pass guard: a regex that matched nothing would report parity
    // between two empty sets forever.
    expect(rows.length, "the Swift lens table parsed to no rows").toBeGreaterThan(0);
    expect(rows.map(([id]) => id)).toEqual(Object.keys(LENSES));
    // Every lens needs a human label, or the grid renders a blank checkbox.
    expect(rows.every(([, label]) => label.trim().length > 0)).toBe(true);
  });

  /**
   * The CAP BOUND the panel offers, which is the harness's and not the
   * registry's.
   *
   * `loadLensActivationConfig` honours `maxLenses` only within `1...8`, so a
   * stepper that went to 9 would offer a setting the harness discards -- and
   * the registry has nine lenses, which makes 9 the number a user would
   * naturally reach for. ISS-1030 carries the stale bound itself; until it
   * moves, the panel and the harness have to agree on the number as it stands.
   */
  it("caps the stepper at the highest value the harness honours", () => {
    const src = readFileSync(panelPath, "utf-8");
    const m = /static let lensCapRange\s*=\s*(\d+)\.\.\.(\d+)/.exec(src);
    expect(m, "could not find lensCapRange in the Swift panel").not.toBeNull();

    // Read the bound out of the harness rather than restating it, so this fails
    // when ISS-1030 lands instead of silently keeping the old number.
    const prepareSrc = readFileSync(resolve(here, "../../src/autonomous/lens-harness/prepare.ts"), "utf-8");
    const lower = /lc\.maxLenses >= (\d+)/.exec(prepareSrc);
    const upper = /lc\.maxLenses <= (\d+)/.exec(prepareSrc);
    expect(lower, "could not find the maxLenses lower bound in prepare.ts").not.toBeNull();
    expect(upper, "could not find the maxLenses upper bound in prepare.ts").not.toBeNull();

    expect(Number(m![1])).toBe(Number(lower![1]));
    expect(Number(m![2])).toBe(Number(upper![1]));
  });
});

describe.skipIf(swiftPresent)("the lens parity gate", () => {
  it("is inert without the Mac app sources, which is the published-package case", () => {
    expect(swiftPresent).toBe(false);
  });
});
