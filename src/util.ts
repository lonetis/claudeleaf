/** Small async utilities (Node is event-driven, so these replace Python's threads/locks). */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A promise plus its resolve/reject, for cross-callback signalling. */
export class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason?: unknown) => void;
  settled = false;

  constructor() {
    this.promise = new Promise<T>((res, rej) => {
      this.resolve = (v) => {
        this.settled = true;
        res(v);
      };
      this.reject = (e) => {
        this.settled = true;
        rej(e);
      };
    });
  }
}

/** Serializes async work into a chain so callers run one at a time, in order. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

/** Reject with `onTimeout()` if `promise` does not settle within `ms`. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
