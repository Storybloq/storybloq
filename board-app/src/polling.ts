/** A single owned interval; starting it does not perform a read. */
export function startAutoRefresh<T>(
  tick: () => void,
  visible: () => boolean,
  schedule: (callback: () => void, milliseconds: number) => T,
  cancel: (timer: T) => void,
) {
  let stopped = false;
  const timer = schedule(() => {
    if (!stopped && visible()) tick();
  }, 30000);
  return () => {
    if (!stopped) {
      stopped = true;
      cancel(timer);
    }
  };
}
