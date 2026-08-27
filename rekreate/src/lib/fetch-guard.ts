/**
 * Survive a failure that happens BELOW the fetch promise.
 *
 * The audit already treats one prospect's broken markup as that prospect's
 * problem rather than the run's — every parse sits inside a try. But there is a
 * class of failure a try cannot reach: Node's HTTP client can throw from a
 * socket's `end` event, after the response has been handed over, on a
 * connection nobody is awaiting any more. There is no promise to reject, so it
 * arrives as an uncaught exception and takes the process with it.
 *
 * The specific one seen in the wild:
 *
 *   AssertionError [ERR_ASSERTION]: assert(!this.paused)
 *       at Parser.finish (node:internal/deps/undici/undici)
 *       at TLSSocket.onHttpSocketEnd
 *
 * It is a bug in the client, not in the site and not in this code, and it
 * killed a 130-prospect audit at the seventh row — losing a sweep that had
 * already been paid for in API calls, over one server closing a connection
 * rudely. That is exactly the outcome the rest of the audit is written to
 * avoid.
 *
 * DELIBERATELY NARROW. A blanket uncaughtException handler turns every real bug
 * into a silent wrong answer, which is far worse than a crash. This recognises
 * one signature and re-raises everything else as fatal, so the guard can only
 * ever hide the thing it was written for.
 */

/**
 * True only for the undici socket-teardown assertion described above.
 *
 * Matched on all three of: the assertion error code, the `this.paused`
 * expression, and an undici frame in the stack. Any one of them alone would be
 * loose enough to swallow something real.
 */
export function isSocketTeardownBug(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== 'ERR_ASSERTION') return false;
  if (!error.message.includes('this.paused')) return false;
  return (error.stack ?? '').includes('undici');
}

/**
 * Install the guard for the lifetime of the process.
 *
 * `onIgnored` is called once per occurrence so a run can report how many times
 * it happened — a guard that hides its own frequency is how a workaround
 * becomes permanent. Everything unrecognised is printed and exits non-zero,
 * which is what would have happened without the handler at all.
 */
export function guardSocketTeardown(onIgnored: (error: Error) => void): void {
  process.on('uncaughtException', (error: Error) => {
    if (isSocketTeardownBug(error)) {
      onIgnored(error);
      return;
    }
    console.error(error);
    process.exit(1);
  });
}
