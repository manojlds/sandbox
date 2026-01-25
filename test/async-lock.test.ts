/**
 * AsyncLock Unit Tests
 *
 * Tests for the async lock implementation that prevents TOCTOU race conditions.
 */

import { describe, it, expect } from "vitest";
import { AsyncLock } from "../src/utils/async-lock.js";

describe("AsyncLock", () => {
  it("should allow single operation to complete", async () => {
    const lock = new AsyncLock();
    let executed = false;

    await lock.acquire("test", async () => {
      executed = true;
    });

    expect(executed).toBe(true);
  });

  it("should return the result of the operation", async () => {
    const lock = new AsyncLock();

    const result = await lock.acquire("test", async () => {
      return 42;
    });

    expect(result).toBe(42);
  });

  it("should serialize concurrent operations on the same key", async () => {
    const lock = new AsyncLock();
    const order: number[] = [];

    // Start three concurrent operations
    const p1 = lock.acquire("test", async () => {
      await sleep(50);
      order.push(1);
    });

    const p2 = lock.acquire("test", async () => {
      await sleep(10);
      order.push(2);
    });

    const p3 = lock.acquire("test", async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);

    // Operations should complete in order they were started
    expect(order).toEqual([1, 2, 3]);
  });

  it("should allow concurrent operations on different keys", async () => {
    const lock = new AsyncLock();
    const order: string[] = [];

    // Start concurrent operations on different keys
    const p1 = lock.acquire("key1", async () => {
      await sleep(50);
      order.push("key1");
    });

    const p2 = lock.acquire("key2", async () => {
      await sleep(10);
      order.push("key2");
    });

    await Promise.all([p1, p2]);

    // key2 should finish first since it has shorter delay and different lock
    expect(order).toEqual(["key2", "key1"]);
  });

  it("should release lock on error", async () => {
    const lock = new AsyncLock();

    // First operation throws
    await expect(
      lock.acquire("test", async () => {
        throw new Error("Test error");
      })
    ).rejects.toThrow("Test error");

    // Second operation should still work (lock was released)
    let executed = false;
    await lock.acquire("test", async () => {
      executed = true;
    });

    expect(executed).toBe(true);
  });

  it("should report lock status correctly", async () => {
    const lock = new AsyncLock();

    expect(lock.isLocked("test")).toBe(false);

    let checkDuringLock = false;
    const promise = lock.acquire("test", async () => {
      checkDuringLock = lock.isLocked("test");
      await sleep(10);
    });

    // Give time for the lock to be acquired
    await sleep(1);
    expect(lock.isLocked("test")).toBe(true);

    await promise;

    expect(checkDuringLock).toBe(true);
    expect(lock.isLocked("test")).toBe(false);
  });

  it("should prevent TOCTOU race condition in simulated workspace size check", async () => {
    const lock = new AsyncLock();
    const maxSize = 100;
    let currentSize = 0;

    // Simulated write with size check
    const writeWithCheck = async (size: number): Promise<boolean> => {
      return lock.acquire("workspace", async () => {
        // Check
        if (currentSize + size > maxSize) {
          return false; // Would exceed limit
        }

        // Simulate some async work
        await sleep(10);

        // Use (write)
        currentSize += size;
        return true;
      });
    };

    // Try to write 60 bytes concurrently twice
    // Without lock, both would pass the check (0 + 60 <= 100)
    // With lock, only one should succeed
    const [result1, result2] = await Promise.all([writeWithCheck(60), writeWithCheck(60)]);

    // One should succeed, one should fail
    expect([result1, result2].filter((r) => r === true).length).toBe(1);
    expect([result1, result2].filter((r) => r === false).length).toBe(1);

    // Total size should be exactly 60
    expect(currentSize).toBe(60);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
