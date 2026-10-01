import type { ProjectState } from "./project-state.js";

/** Trusted caller policy, evaluated inside the canonical update lock. */
export interface UpdateWriteHooks<T> extends PreparedContentValidation {
  precondition?: (
    existing: Readonly<T>,
    state: ProjectState,
  ) => void | Promise<void>;
}

/** Runs on the final serialized bytes, after schema and ownership guards. */
export interface PreparedContentValidation {
  validatePreparedContent?: (content: string) => void | Promise<void>;
}
