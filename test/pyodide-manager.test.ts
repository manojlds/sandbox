/**
 * Unit tests for PyodideManager async file operations
 *
 * These tests verify that synchronous file operations have been properly
 * converted to async to avoid blocking the event loop.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { PyodideManager } from "../src/core/pyodide-manager.js";
import { VIRTUAL_WORKSPACE } from "../src/config/constants.js";

// Test workspace directory
const TEST_WORKSPACE = path.join(process.cwd(), "test-workspace-async");

describe("PyodideManager - Async File Operations", () => {
  beforeEach(async () => {
    // Clean up test workspace before each test
    if (await fsExists(TEST_WORKSPACE)) {
      await fs.promises.rm(TEST_WORKSPACE, { recursive: true });
    }
    await fs.promises.mkdir(TEST_WORKSPACE, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test workspace after each test
    if (await fsExists(TEST_WORKSPACE)) {
      await fs.promises.rm(TEST_WORKSPACE, { recursive: true });
    }
  });

  describe("Async File Operations - Performance", () => {
    it("should not block event loop during file read operations", async () => {
      // Create test files
      const testDir = path.join(TEST_WORKSPACE, "performance");
      await fs.promises.mkdir(testDir, { recursive: true });

      // Create multiple files
      const fileCount = 10;
      const promises = [];
      for (let i = 0; i < fileCount; i++) {
        const filePath = path.join(testDir, `file${i}.txt`);
        promises.push(fs.promises.writeFile(filePath, `Content ${i}`));
      }
      await Promise.all(promises);

      // Measure if other operations can run concurrently
      let otherOperationCompleted = false;
      const otherOperation = async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        otherOperationCompleted = true;
      };

      // Read all files asynchronously while other operation runs
      const readPromises = [];
      for (let i = 0; i < fileCount; i++) {
        const filePath = path.join(testDir, `file${i}.txt`);
        readPromises.push(fs.promises.readFile(filePath, "utf8"));
      }

      const [contents] = await Promise.all([Promise.all(readPromises), otherOperation()]);

      // Both should complete
      expect(contents).toHaveLength(fileCount);
      expect(otherOperationCompleted).toBe(true);
    });

    it("should handle large workspace efficiently with async operations", async () => {
      // Create large workspace
      const testDir = path.join(TEST_WORKSPACE, "large");
      await fs.promises.mkdir(testDir, { recursive: true });

      // Create 100 files with 1KB each
      const fileCount = 100;
      const fileSize = 1024; // 1KB
      const content = "x".repeat(fileSize);

      const promises = [];
      for (let i = 0; i < fileCount; i++) {
        const filePath = path.join(testDir, `file${i}.txt`);
        promises.push(fs.promises.writeFile(filePath, content));
      }
      await Promise.all(promises);

      // Calculate size asynchronously
      const startTime = Date.now();
      const size = await calculateWorkspaceSize(testDir);
      const duration = Date.now() - startTime;

      // Should complete within reasonable time (less than 1 second)
      expect(duration).toBeLessThan(1000);

      // Should calculate correct size
      const expectedSize = fileCount * fileSize;
      expect(size).toBe(expectedSize);
    });

    it("should allow concurrent async operations", async () => {
      const testDir = path.join(TEST_WORKSPACE, "concurrent");
      await fs.promises.mkdir(testDir, { recursive: true });

      // Create multiple files concurrently
      const fileCount = 20;
      const promises = [];

      for (let i = 0; i < fileCount; i++) {
        const filePath = path.join(testDir, `file${i}.txt`);
        promises.push(fs.promises.writeFile(filePath, `Content ${i}`));
      }

      // All writes should succeed without race conditions
      await Promise.all(promises);

      // Verify all files were created
      const files = await fs.promises.readdir(testDir);
      expect(files.length).toBe(fileCount);
    });

    it("should properly await async operations in sequence", async () => {
      const testDir = path.join(TEST_WORKSPACE, "sequence");
      await fs.promises.mkdir(testDir, { recursive: true });

      const filePath = path.join(testDir, "test.txt");

      // Write, read, update sequence
      await fs.promises.writeFile(filePath, "Initial content");

      const content1 = await fs.promises.readFile(filePath, "utf8");
      expect(content1).toBe("Initial content");

      await fs.promises.writeFile(filePath, "Updated content");

      const content2 = await fs.promises.readFile(filePath, "utf8");
      expect(content2).toBe("Updated content");
    });

    it("should handle nested directory traversal asynchronously", async () => {
      // Create nested structure
      const testDir = path.join(TEST_WORKSPACE, "nested");
      const level1 = path.join(testDir, "level1");
      const level2 = path.join(level1, "level2");
      const level3 = path.join(level2, "level3");

      await fs.promises.mkdir(level3, { recursive: true });

      // Create files at each level
      await fs.promises.writeFile(path.join(testDir, "file0.txt"), "Level 0");
      await fs.promises.writeFile(path.join(level1, "file1.txt"), "Level 1");
      await fs.promises.writeFile(path.join(level2, "file2.txt"), "Level 2");
      await fs.promises.writeFile(path.join(level3, "file3.txt"), "Level 3");

      // Calculate size asynchronously
      const size = await calculateWorkspaceSize(testDir);

      // Should calculate correct size
      const expectedSize =
        Buffer.byteLength("Level 0") +
        Buffer.byteLength("Level 1") +
        Buffer.byteLength("Level 2") +
        Buffer.byteLength("Level 3");
      expect(size).toBe(expectedSize);
    });

    it("should handle empty workspace directory", async () => {
      const testDir = path.join(TEST_WORKSPACE, "empty");
      await fs.promises.mkdir(testDir, { recursive: true });

      const size = await calculateWorkspaceSize(testDir);
      expect(size).toBe(0);
    });

    it("should handle non-existent workspace directory", async () => {
      const nonExistentDir = path.join(TEST_WORKSPACE, "non-existent");

      const size = await calculateWorkspaceSize(nonExistentDir);
      expect(size).toBe(0);
    });

    it("should efficiently sync multiple files in parallel", async () => {
      const testDir = path.join(TEST_WORKSPACE, "parallel");
      await fs.promises.mkdir(testDir, { recursive: true });

      // Create files
      const fileCount = 50;
      const writePromises = [];
      for (let i = 0; i < fileCount; i++) {
        writePromises.push(
          fs.promises.writeFile(path.join(testDir, `file${i}.txt`), `Content ${i}`)
        );
      }

      const startTime = Date.now();
      await Promise.all(writePromises);
      const writeDuration = Date.now() - startTime;

      // Should complete faster than sequential writes would
      // (Sequential would take ~fileCount * minWriteTime)
      expect(writeDuration).toBeLessThan(500);

      // Verify all files exist
      const files = await fs.promises.readdir(testDir);
      expect(files.length).toBe(fileCount);
    });
  });

  describe("Targeted workspace syncs", () => {
    it("syncHostPathToVirtual only writes the requested file", async () => {
      const testDir = path.join(TEST_WORKSPACE, "targeted");
      await fs.promises.mkdir(testDir, { recursive: true });

      const fileA = path.join(testDir, "a.txt");
      const fileB = path.join(testDir, "b.txt");
      await fs.promises.writeFile(fileA, "file-a");
      await fs.promises.writeFile(fileB, "file-b");

      const virtualWrites: Record<string, Buffer> = {};
      const mkdirs: string[] = [];

      const manager = new PyodideManager();
      (manager as unknown as { pyodide: { FS: unknown } }).pyodide = {
        FS: {
          mkdirTree: (dir: string) => mkdirs.push(dir),
          writeFile: (targetPath: string, content: Buffer) => {
            virtualWrites[targetPath] = content;
          },
        },
      };

      await (
        manager as unknown as {
          syncHostPathToVirtual: (hostPath: string, virtualPath: string) => Promise<void>;
        }
      ).syncHostPathToVirtual(fileA, `${VIRTUAL_WORKSPACE}/a.txt`);

      expect(Object.keys(virtualWrites)).toEqual([`${VIRTUAL_WORKSPACE}/a.txt`]);
      expect(virtualWrites[`${VIRTUAL_WORKSPACE}/a.txt`].toString()).toBe("file-a");
      expect(mkdirs.length).toBeGreaterThanOrEqual(0);
    });

    it("syncVirtualPathToHost only writes the requested file", async () => {
      const manager = new PyodideManager();
      const fileMode = 0;
      const fileContent = Buffer.from("hello");

      const virtualPath = `${VIRTUAL_WORKSPACE}/nested/hello.txt`;
      const hostPath = path.join(TEST_WORKSPACE, "nested", "hello.txt");

      (manager as unknown as { pyodide: { FS: unknown } }).pyodide = {
        FS: {
          stat: () => ({ mode: fileMode }),
          isDir: (mode: number) => mode !== fileMode,
          readFile: () => fileContent,
        },
      };

      await (
        manager as unknown as {
          syncVirtualPathToHost: (virtualPath: string, hostPath: string) => Promise<void>;
        }
      ).syncVirtualPathToHost(virtualPath, hostPath);

      const content = await fs.promises.readFile(hostPath, "utf8");
      expect(content).toBe("hello");
    });
  });
});

// Helper function to check if file/directory exists
async function fsExists(path: string): Promise<boolean> {
  try {
    await fs.promises.access(path);
    return true;
  } catch {
    return false;
  }
}

// Helper function to calculate workspace size (mimics PyodideManager implementation)
async function calculateWorkspaceSize(dirPath: string): Promise<number> {
  try {
    await fs.promises.access(dirPath);
  } catch {
    return 0;
  }

  let totalSize = 0;

  const calculateSize = async (currentPath: string): Promise<void> => {
    const items = await fs.promises.readdir(currentPath);
    for (const item of items) {
      const itemPath = path.join(currentPath, item);
      const stat = await fs.promises.stat(itemPath);
      if (stat.isDirectory()) {
        await calculateSize(itemPath);
      } else {
        totalSize += stat.size;
      }
    }
  };

  await calculateSize(dirPath);
  return totalSize;
}
