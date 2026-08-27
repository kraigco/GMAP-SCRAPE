import { describe, expect, it } from 'vitest';
import { isSocketTeardownBug } from '../src/lib/fetch-guard.ts';

/**
 * The guard exists to hide exactly one client bug and nothing else. These tests
 * are almost entirely about what it must REFUSE to hide, because a handler that
 * swallows a real fault turns a crash into a silently wrong answer — which is
 * far worse than the crash it replaced.
 */

function teardownError(): Error {
  const err = new Error('The expression evaluated to a falsy value:\n\n  assert(!this.paused)\n');
  (err as NodeJS.ErrnoException).code = 'ERR_ASSERTION';
  err.stack = 'AssertionError\n    at Parser.finish (node:internal/deps/undici/undici:7380:9)\n' +
    '    at TLSSocket.onHttpSocketEnd (node:internal/deps/undici/undici:7819:34)';
  return err;
}

describe('isSocketTeardownBug', () => {
  it('recognises the fault that killed a 130-prospect audit', () => {
    expect(isSocketTeardownBug(teardownError())).toBe(true);
  });

  it('refuses an assertion from our own code', () => {
    const err = new Error('assert(!this.paused)');
    (err as NodeJS.ErrnoException).code = 'ERR_ASSERTION';
    err.stack = 'AssertionError\n    at auditSite (src/audit/site.ts:200:3)';
    expect(isSocketTeardownBug(err)).toBe(false);
  });

  it('refuses a different assertion from inside the client', () => {
    const err = teardownError();
    err.message = 'The expression evaluated to a falsy value:\n\n  assert(socket.destroyed)\n';
    expect(isSocketTeardownBug(err)).toBe(false);
  });

  it('refuses an ordinary network error', () => {
    const err = new Error('fetch failed');
    (err as NodeJS.ErrnoException).code = 'ECONNRESET';
    expect(isSocketTeardownBug(err)).toBe(false);
  });

  it('refuses a TypeError with a matching message', () => {
    const err = new TypeError('assert(!this.paused) in undici');
    expect(isSocketTeardownBug(err)).toBe(false);
  });

  it('refuses things that are not errors at all', () => {
    for (const value of [null, undefined, 'assert(!this.paused)', 42, {}]) {
      expect(isSocketTeardownBug(value)).toBe(false);
    }
  });
});
