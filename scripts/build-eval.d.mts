// Types for scripts/build-eval.mjs (T-538 S5a), so the tests that import it type-check.
export declare const EVAL_DIST: string;
export declare const HELPER_INPUTS: readonly string[];
export declare const EVAL_INPUTS: readonly string[];
export declare function evalInputDigest(root: string): string;
export declare function builtDigest(root: string): string | null;
export declare function buildEval(root: string, options?: { force?: boolean }): Promise<{ digest: string; built: boolean }>;
