/**
 * ISS-1022: what a presence record is allowed to say about a tool call.
 *
 * Presence records sit in a project directory and are read by a UI, so the
 * question is not "is this path useful" but "can this field ever carry
 * something the user did not intend to publish". The answer is an ALLOWLIST:
 * four tools, one named key each, and a containment proof on the value. These
 * fixtures pin both halves -- the tools that are excluded, and the paths that
 * fail the proof.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, parse } from "node:path";
import { tmpdir } from "node:os";

import { PATH_INPUT_KEYS, capPathForDisplay, capString, containedRelativePath, redactedTarget } from "../../src/presence/redaction.js";
import { MAX_TARGET_BYTES } from "../../src/presence/types.js";

let root: string;
let outside: string;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "presence-redact-"));
  root = join(base, "project");
  outside = join(base, "elsewhere");
  mkdirSync(join(root, ".story"), { recursive: true });
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "src", "main.ts"), "x");
  writeFileSync(join(outside, "secrets.env"), "TOKEN=1");
});

afterEach(() => {
  rmSync(join(root, ".."), { recursive: true, force: true });
});

describe("the allowlist (ISS-1022)", () => {
  it("records the path only for the four allowlisted tool inputs", () => {
    expect(Object.keys(PATH_INPUT_KEYS).sort()).toEqual(["Edit", "NotebookEdit", "Read", "Write"]);
    expect(redactedTarget(root, root, "Read", { file_path: join(root, "src/main.ts") })).toBe("src/main.ts");
    expect(redactedTarget(root, root, "Edit", { file_path: join(root, "src/main.ts") })).toBe("src/main.ts");
    expect(redactedTarget(root, root, "NotebookEdit", { notebook_path: join(root, "src/main.ts") })).toBe("src/main.ts");
  });

  /**
   * The excluded tools are the point of the design. A Bash `command`, a Grep
   * `pattern`, a WebFetch `url` and every MCP tool input can carry secrets,
   * prompts or user content, so they never reach a record at all -- and a NEW
   * tool is excluded by default rather than needing to be remembered.
   */
  it("records nothing for tools that carry user content", () => {
    expect(redactedTarget(root, root, "Bash", { command: "aws s3 cp s3://x --token SECRET" })).toBeNull();
    expect(redactedTarget(root, root, "Grep", { pattern: "password=", path: root })).toBeNull();
    expect(redactedTarget(root, root, "WebFetch", { url: "https://example.com/?key=SECRET" })).toBeNull();
    expect(redactedTarget(root, root, "Task", { prompt: "the user's private prompt" })).toBeNull();
    expect(redactedTarget(root, root, "mcp__whatever__do", { file_path: join(root, "src/main.ts") })).toBeNull();
  });

  it("ignores every key other than the allowlisted one, even on an allowlisted tool", () => {
    expect(redactedTarget(root, root, "Write", {
      file_path: join(root, "src/main.ts"),
      content: "an entire file body with an API key in it",
    })).toBe("src/main.ts");
  });

  it("records nothing when the allowlisted key is absent or not a string", () => {
    expect(redactedTarget(root, root, "Read", {})).toBeNull();
    expect(redactedTarget(root, root, "Read", { file_path: 42 })).toBeNull();
    expect(redactedTarget(root, root, "Read", null)).toBeNull();
    expect(redactedTarget(root, root, "Read", ["a"])).toBeNull();
  });
});

describe("the containment proof (ISS-1022)", () => {
  /**
   * The reason the proof uses the NEAREST EXISTING ANCESTOR rather than
   * realpath of the target: a Write target usually does not exist yet, and
   * realpath of the file itself would reject every new file.
   */
  it("proves a Write to a not-yet-existing file under a valid directory", () => {
    expect(redactedTarget(root, root, "Write", { file_path: join(root, "src/deep/brand-new.ts") }))
      .toBe("src/deep/brand-new.ts");
    expect(redactedTarget(root, root, "Write", { file_path: join(root, "src/deep/a/b/c/new.ts") }))
      .toBe("src/deep/a/b/c/new.ts");
  });

  it("refuses a path outside the project", () => {
    expect(containedRelativePath(root, root, join(outside, "secrets.env"))).toBeNull();
    expect(containedRelativePath(root, root, "/etc/passwd")).toBeNull();
  });

  it("refuses traversal, however it is spelled", () => {
    expect(containedRelativePath(root, root, join(root, "../elsewhere/secrets.env"))).toBeNull();
    expect(containedRelativePath(root, root, "../elsewhere/secrets.env")).toBeNull();
    expect(containedRelativePath(root, root, join(root, "src/../../elsewhere/secrets.env"))).toBeNull();
  });

  /** realpath of the ancestor is what makes a symlinked parent fail the proof. */
  it("refuses a path whose parent directory is a symlink out of the project", () => {
    symlinkSync(outside, join(root, "escape"), "dir");
    expect(containedRelativePath(root, root, join(root, "escape/secrets.env"))).toBeNull();
    expect(containedRelativePath(root, root, join(root, "escape/not-yet.txt"))).toBeNull();
  });

  it("accepts an in-project symlink that resolves back inside the project", () => {
    symlinkSync(join(root, "src"), join(root, "link-to-src"), "dir");
    expect(containedRelativePath(root, root, join(root, "link-to-src/main.ts"))).toBe("src/main.ts");
  });

  /**
   * A symlinked project ROOT is the common macOS case (/tmp -> /private/tmp).
   * Both sides canonicalize, so it must not reject everything.
   */
  it("works when the project root itself is reached through a symlink", () => {
    const alias = join(root, "..", "alias");
    symlinkSync(root, alias, "dir");
    expect(containedRelativePath(alias, alias, join(alias, "src/main.ts"))).toBe("src/main.ts");
    expect(realpathSync(alias)).toBe(realpathSync(root));
  });

  /**
   * A project AT a filesystem root already ends in a separator, so the old
   * `root + sep` prefix test built "//" and rejected every legitimate
   * descendant. Exercised through the real root rather than a fixture, because
   * the bug was in the string arithmetic and a fixture would reproduce the
   * arithmetic rather than the filesystem.
   */
  it("contains paths correctly when the project sits at a filesystem root", () => {
    const fsRoot = parse(root).root;
    const inside = containedRelativePath(fsRoot, fsRoot, join(root, "src", "main.ts"));
    expect(inside).not.toBeNull();
    expect(isAbsolute(inside!)).toBe(false);
    expect(inside!.startsWith("..")).toBe(false);
    expect(join(fsRoot, inside!)).toBe(realpathSync(join(root, "src", "main.ts")));
  });

  it("resolves a relative tool input against the session cwd", () => {
    expect(containedRelativePath(root, join(root, "src"), "main.ts")).toBe("src/main.ts");
    expect(containedRelativePath(root, join(root, "src"), "../../elsewhere/secrets.env")).toBeNull();
  });

  /**
   * That these refusals happen BEFORE any canonicalization is asserted in
   * presence-mocked-fs.test.ts, by proving the filesystem calls are never made.
   * A wall-clock threshold cannot distinguish "refused early" from "walked the
   * path quickly on a warm local disk", and fails on a loaded CI worker without
   * any regression to show for it.
   */
  it("refuses a NUL byte and an absurdly long value", () => {
    expect(redactedTarget(root, root, "Read", { file_path: join(root, "src/ma\0in.ts") })).toBeNull();
    expect(redactedTarget(root, root, "Read", { file_path: "/" + "a".repeat(9000) })).toBeNull();

    const deep = "/" + Array.from({ length: 2000 }, (_, i) => `seg${i}`).join("/");
    expect(deep.length).toBeGreaterThan(4096);
    expect(redactedTarget(root, root, "Read", { file_path: deep })).toBeNull();
  });

  it("handles unicode paths", () => {
    mkdirSync(join(root, "src", "日本語"), { recursive: true });
    writeFileSync(join(root, "src", "日本語", "ファイル.ts"), "x");
    expect(containedRelativePath(root, root, join(root, "src/日本語/ファイル.ts"))).toBe("src/日本語/ファイル.ts");
  });
});

describe("display caps (ISS-1022)", () => {
  /**
   * A path cut mid-string is a path that points somewhere ELSE. Head-trimming
   * with a visible marker is partial rather than wrong.
   */
  it("trims a long path by leading components, never mid-string", () => {
    const long = Array.from({ length: 40 }, (_, i) => `directory-number-${i}`).join("/") + "/file.ts";
    const capped = capPathForDisplay(long)!;
    expect(Buffer.byteLength(capped, "utf-8")).toBeLessThanOrEqual(MAX_TARGET_BYTES);
    expect(capped.startsWith(".../")).toBe(true);
    expect(capped.endsWith("/file.ts")).toBe(true);
    expect(long.endsWith(capped.slice(4))).toBe(true);
  });

  it("returns null when not even the basename fits", () => {
    expect(capPathForDisplay("x".repeat(MAX_TARGET_BYTES + 1))).toBeNull();
  });

  it("caps a label on a character boundary rather than splitting a code point", () => {
    const capped = capString("日".repeat(100), 10)!;
    expect(Buffer.byteLength(capped, "utf-8")).toBeLessThanOrEqual(10);
    expect(capped).toBe("日日日");
    expect(capped.includes("\uFFFD")).toBe(false);
  });

  /**
   * The case a hand-rolled continuation-byte walk gets wrong: when the cap
   * lands EXACTLY on a character boundary there is no partial sequence to drop,
   * and dropping one anyway discards a complete character. At two bytes it
   * discarded the only character there was and returned null.
   */
  it("keeps a complete final character when the cap lands exactly on its boundary", () => {
    expect(capString("éx", 2)).toBe("é");        // 2-byte character, cap = 2
    expect(capString("日日日x", 9)).toBe("日日日"); // 3-byte characters, cap = 9
    expect(capString("ab", 1)).toBe("a");
  });

  it("returns null only when nothing complete fits", () => {
    expect(capString("日", 2)).toBeNull();       // a 3-byte character in 2 bytes
    expect(capString("日", 3)).toBe("日");
  });

  it("refuses empty values and NUL bytes", () => {
    expect(capString("", 10)).toBeNull();
    expect(capString("a\0b", 10)).toBeNull();
    expect(capString(42, 10)).toBeNull();
    expect(capString(undefined, 10)).toBeNull();
  });
});
