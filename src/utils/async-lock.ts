/**
 * AsyncLock - A simple async mutex/lock implementation
 *
 * Provides mutual exclusion for async operations, preventing race conditions
 * in concurrent code. Used to protect critical sections like file writes
 * where TOCTOU (time-of-check to time-of-use) vulnerabilities could occur.
 *
 * @example
 * ```typescript
 * const lock = new AsyncLock();
 *
 * // Multiple concurrent calls will be serialized
 * await lock.acquire('write', async () => {
 *   await checkSize();
 *   await writeFile();
 * });
 * ```
 */
export class AsyncLock {
  private locks: Map<string, Promise<void>> = new Map();

  /**
   * Acquire a lock for the given key, execute the function, then release.
   * If another operation holds the lock, this will wait until it's released.
   *
   * @param key - The lock key (allows multiple independent locks)
   * @param fn - The async function to execute while holding the lock
   * @returns The result of the function
   */
  async acquire<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Wait for any existing lock on this key
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }

    // Create a new lock promise
    let releaseLock: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    this.locks.set(key, lockPromise);

    try {
      // Execute the protected function
      return await fn();
    } finally {
      // Release the lock
      this.locks.delete(key);
      releaseLock!();
    }
  }

  /**
   * Check if a lock is currently held for the given key
   */
  isLocked(key: string): boolean {
    return this.locks.has(key);
  }
}
