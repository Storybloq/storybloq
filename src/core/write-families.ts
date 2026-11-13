/**
 * 1.20 commit 0 (ISS-1433/1435 plan v4.1 section 9, amendment 1): the write
 * families and the former tool names they list in place of. Plain data with
 * no dependencies, so the capability check (core) and the MCP tool profile
 * (mcp/tool-profile.ts, which carries the behaviour) read one list.
 */

export interface WriteFamily {
  /** The listed family tool. */
  readonly name: string;
  /** The former tools' common prefix; `prefix + action` is a former tool name. */
  readonly prefix: string;
  readonly actions: readonly string[];
  /** The first words of the family description. */
  readonly head: string;
}

export const WRITE_FAMILIES: readonly WriteFamily[] = Object.freeze([
  Object.freeze({
    name: "storybloq_ruling_write",
    prefix: "storybloq_ruling_",
    actions: Object.freeze(["create", "supersede", "propose", "accept", "withdraw"]),
    head: "Rulings, write side",
  }),
  Object.freeze({
    name: "storybloq_earmark_write",
    prefix: "storybloq_earmark_",
    actions: Object.freeze(["reserve", "assign", "release"]),
    head: "Earmarks, write side",
  }),
  Object.freeze({
    name: "storybloq_checkpoint_write",
    prefix: "storybloq_checkpoint_",
    actions: Object.freeze(["attach", "change", "create", "reopen", "resolve", "retire"]),
    head: "Owner checkpoints, write side",
  }),
  Object.freeze({
    name: "storybloq_capability_write",
    prefix: "storybloq_capability_",
    actions: Object.freeze(["add", "update"]),
    head: "Capabilities, write side",
  }),
  Object.freeze({
    name: "storybloq_term_write",
    prefix: "storybloq_term_",
    actions: Object.freeze(["add", "update"]),
    head: "Glossary terms, write side",
  }),
]);

/** The former names: registered and callable, absent from `tools/list`. */
export const HIDDEN_LEGACY_TOOLS: ReadonlySet<string> = new Set(
  WRITE_FAMILIES.flatMap((f) => f.actions.map((a) => f.prefix + a)),
);
