/*
 * Startup and sign-out paths must never wait forever on something that may not settle (an
 * IndexedDB open blocked by another tab, a Web Lock held by a frozen tab, a request with no
 * answer). `withTimeout` turns such a wait into an error the UI can show with a Retry.
 */

export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

/** Resolve or reject like `promise`, or reject with `TimeoutError` after `ms`. The work itself isn't cancelled. */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number, what = 'Operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
