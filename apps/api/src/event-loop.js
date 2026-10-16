/**
 * Cooperative event-loop yield helpers.
 *
 * Long synchronous batch work (Silver projection drains, poison isolation)
 * otherwise monopolises the single Node event loop: `await`-ing an
 * immediately-resolved value only drains the microtask queue and never returns
 * control to the macrotask/I-O queue, so pending HTTP requests, timers, and
 * health checks are starved until the whole batch finishes. Yielding through
 * `setImmediate` returns to the macrotask queue, letting queued I/O run before
 * the next batch.
 *
 * The helper is exported (and injectable at call sites) so tests can substitute
 * a counting or deterministic stub without patching globals.
 */
export function yieldToEventLoop() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
