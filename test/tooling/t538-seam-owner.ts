/**
 * The fault seam is process-global, and a test abandoned at its timeout keeps
 * running. Each test body here runs under its own generation in async
 * context, so a finished test's run cannot write into the next test's log or
 * replace the next test's seam.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { it as base } from "vitest";
import { setAfterWriteFault } from "../../src/core/setup-apply.js";

const runs = new AsyncLocalStorage<number>();
let live = 0;

type Body = (...args: never[]) => unknown;
const owned = (fn: Body) => (...args: never[]): unknown => runs.run(++live, () => fn(...args));

/** vitest's `it` and `it.each`, each body under its own generation. */
export const it = Object.assign(
  (name: string, fn: Body, timeout?: number) => base(name, owned(fn) as never, timeout),
  { each: (table: readonly unknown[]) => (name: string, fn: Body, timeout?: number) => base.each(table as never)(name, owned(fn) as never, timeout) },
) as unknown as typeof base;

/** Installs a fault seam for the running test; events from any other test's run are dropped. */
export function ownSeam(fn: (point: string, info: Parameters<Parameters<typeof setAfterWriteFault>[0]>[1]) => void | Promise<void>): void {
  if (runs.getStore() !== live) return;
  setAfterWriteFault((point, info) => (runs.getStore() === live ? fn(point, info) : undefined));
}
