/**
 * Bash Symlink Attack Tests
 *
 * These tests verify that BashManager properly blocks symlink-based
 * path traversal attacks. Currently, these tests are EXPECTED TO FAIL
 * because BashManager lacks symlink protection (unlike PyodideManager).
 *
 * This is a security vulnerability that needs to be fixed.
 *
 * @see SECURITY-REVIEW.md for full details
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { BashManager } from "../src/core/bash-manager.js";
import fs from "fs/promises";
import path from "path";
import os from "os";

describe("Bash Symlink Attack Prevention", () => {
  let bashManager: BashManager;
  const testWorkspace = path.resolve("./test-workspace-bash-symlink");

  // Directory and file outside the workspace for attack testing
  let outsideDir: string;
  let sensitiveFile: string;
  const SENSITIVE_CONTENT = "SENSITIVE_DATA_SHOULD_NOT_BE_ACCESSIBLE_VIA_BASH";

  beforeAll(async () => {
    // Create a directory outside the workspace with sensitive data
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "heimdall-bash-symlink-test-"));
    sensitiveFile = path.join(outsideDir, "sensitive.txt");
    await fs.writeFile(sensitiveFile, SENSITIVE_CONTENT);

    // Create test workspace
    await fs.mkdir(testWorkspace, { recursive: true });

    // Initialize bash manager
    bashManager = new BashManager(testWorkspace);
    await bashManager.initialize();
  });

  afterAll(async () => {
    // Clean up test workspace
    await fs.rm(testWorkspace, { recursive: true, force: true });

    // Clean up outside directory
    if (outsideDir) {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    // Clean workspace contents before each test
    const items = await fs.readdir(testWorkspace);
    for (const item of items) {
      await fs.rm(path.join(testWorkspace, item), { recursive: true, force: true });
    }
  });

  describe("Reading through symlinks", () => {
    it("should block reading file through symlink pointing outside workspace", async () => {
      // ATTACK: Create a symlink inside workspace pointing to sensitive file outside
      const symlinkPath = path.join(testWorkspace, "evil-link");
      await fs.symlink(sensitiveFile, symlinkPath);

      // Attempt to read through the symlink using cat
      const result = await bashManager.execute("cat evil-link");

      // SECURITY EXPECTATION: This should be blocked
      // The command should either:
      // 1. Return an error (non-zero exit code)
      // 2. Not return the sensitive content
      // 3. Return a security violation message

      // Currently FAILS: BashManager reads the file successfully
      expect(result.stdout).not.toContain(SENSITIVE_CONTENT);
      // OR check for error
      // expect(result.exitCode).not.toBe(0);
      // expect(result.stderr).toContain("security");
    });

    it("should block reading /etc/passwd through symlink", async function () {
      // Skip on Windows
      if (process.platform === "win32") {
        return;
      }

      // Check if /etc/passwd exists
      try {
        await fs.access("/etc/passwd");
      } catch {
        // Skip if /etc/passwd doesn't exist
        return;
      }

      // ATTACK: Create symlink to /etc/passwd
      const symlinkPath = path.join(testWorkspace, "passwd-link");
      await fs.symlink("/etc/passwd", symlinkPath);

      // Attempt to read /etc/passwd through symlink
      const result = await bashManager.execute("cat passwd-link");

      // SECURITY EXPECTATION: Should not return passwd file contents
      expect(result.stdout).not.toContain("root:");
      expect(result.exitCode).not.toBe(0);
    });

    it("should block head/tail on symlinked files", async () => {
      const symlinkPath = path.join(testWorkspace, "head-evil");
      await fs.symlink(sensitiveFile, symlinkPath);

      const headResult = await bashManager.execute("head head-evil");
      const tailResult = await bashManager.execute("tail head-evil");

      // Neither should expose the sensitive content
      expect(headResult.stdout).not.toContain(SENSITIVE_CONTENT);
      expect(tailResult.stdout).not.toContain(SENSITIVE_CONTENT);
    });

    it("should block grep on symlinked files", async () => {
      const symlinkPath = path.join(testWorkspace, "grep-evil");
      await fs.symlink(sensitiveFile, symlinkPath);

      // Try to grep for content in the symlinked file
      const result = await bashManager.execute("grep SENSITIVE grep-evil");

      // Should not find or expose the content
      expect(result.stdout).not.toContain("SENSITIVE");
    });
  });

  describe("Writing through symlinks", () => {
    it("should block writing through symlink pointing outside workspace", async () => {
      // ATTACK: Create symlink to a file we want to overwrite
      const targetFile = path.join(outsideDir, "target-for-write.txt");
      await fs.writeFile(targetFile, "ORIGINAL_CONTENT");

      const symlinkPath = path.join(testWorkspace, "write-evil");
      await fs.symlink(targetFile, symlinkPath);

      // Attempt to write through the symlink
      await bashManager.execute("echo 'HACKED' > write-evil");

      // SECURITY EXPECTATION: Original file should not be modified
      const content = await fs.readFile(targetFile, "utf-8");
      expect(content).toBe("ORIGINAL_CONTENT");
      expect(content).not.toContain("HACKED");
    });

    it("should block appending through symlink", async () => {
      const targetFile = path.join(outsideDir, "append-target.txt");
      await fs.writeFile(targetFile, "ORIGINAL");

      const symlinkPath = path.join(testWorkspace, "append-evil");
      await fs.symlink(targetFile, symlinkPath);

      // Attempt to append through symlink
      await bashManager.execute("echo 'APPENDED' >> append-evil");

      // Original file should not be modified
      const content = await fs.readFile(targetFile, "utf-8");
      expect(content).toBe("ORIGINAL");
      expect(content).not.toContain("APPENDED");
    });
  });

  describe("Directory symlink attacks", () => {
    it("should block listing directory through symlink", async () => {
      // Create symlink to outside directory
      const symlinkPath = path.join(testWorkspace, "dir-evil");
      await fs.symlink(outsideDir, symlinkPath);

      // Attempt to list the external directory
      const result = await bashManager.execute("ls dir-evil");

      // Should not list the external directory contents
      expect(result.stdout).not.toContain("sensitive.txt");
      expect(result.exitCode).not.toBe(0);
    });

    it("should block reading files via directory symlink", async () => {
      const symlinkPath = path.join(testWorkspace, "dir-link");
      await fs.symlink(outsideDir, symlinkPath);

      // Attempt to read file through directory symlink
      const result = await bashManager.execute("cat dir-link/sensitive.txt");

      expect(result.stdout).not.toContain(SENSITIVE_CONTENT);
    });

    it("should block find through directory symlink", async () => {
      const symlinkPath = path.join(testWorkspace, "find-evil");
      await fs.symlink(outsideDir, symlinkPath);

      // Attempt to find files through symlink
      const result = await bashManager.execute("find find-evil -type f");

      // Should not find files in external directory
      expect(result.stdout).not.toContain("sensitive");
    });
  });

  describe("Nested symlink attacks", () => {
    it("should block nested symlink chains escaping workspace", async () => {
      // Create a subdirectory
      await fs.mkdir(path.join(testWorkspace, "subdir"), { recursive: true });

      // Create a symlink in the subdirectory pointing outside
      const nestedSymlink = path.join(testWorkspace, "subdir", "nested-evil");
      await fs.symlink(sensitiveFile, nestedSymlink);

      // Attempt to read through nested symlink
      const result = await bashManager.execute("cat subdir/nested-evil");

      expect(result.stdout).not.toContain(SENSITIVE_CONTENT);
    });

    it("should block parent directory being a symlink", async () => {
      // Create symlink to outside directory
      const parentSymlink = path.join(testWorkspace, "parent-link");
      await fs.symlink(outsideDir, parentSymlink);

      // Try to create/access file through parent symlink
      const result = await bashManager.execute("cat parent-link/sensitive.txt");

      expect(result.stdout).not.toContain(SENSITIVE_CONTENT);
    });
  });

  describe("Relative symlink attacks", () => {
    it("should block relative symlinks escaping workspace", async () => {
      // Create a symlink using relative path that escapes
      const symlinkPath = path.join(testWorkspace, "relative-escape");
      const relativePath = path.relative(testWorkspace, sensitiveFile);

      await fs.symlink(relativePath, symlinkPath);

      const result = await bashManager.execute("cat relative-escape");

      expect(result.stdout).not.toContain(SENSITIVE_CONTENT);
    });
  });

  describe("Symlink creation attacks", () => {
    it("should block ln -s creating symlinks to outside locations", async () => {
      // Attempt to create a symlink to /etc/passwd using ln -s
      const result = await bashManager.execute(`ln -s /etc/passwd evil-passwd-link`);

      // Even if the command succeeds, reading should be blocked
      if (result.exitCode === 0) {
        const readResult = await bashManager.execute("cat evil-passwd-link");
        expect(readResult.stdout).not.toContain("root:");
      }
    });

    it("should block ln -s to arbitrary paths outside workspace", async () => {
      // Try to create symlink to external file
      const result = await bashManager.execute(`ln -s ${sensitiveFile} external-link`);

      // The symlink creation might succeed, but reading should fail
      if (result.exitCode === 0) {
        const readResult = await bashManager.execute("cat external-link");
        expect(readResult.stdout).not.toContain(SENSITIVE_CONTENT);
      }
    });
  });

  describe("Legitimate symlink operations", () => {
    it("should allow symlinks within workspace that stay within workspace", async () => {
      // Create a legitimate file
      await bashManager.execute("echo 'internal content' > original.txt");

      // Create internal symlink (this should work)
      await bashManager.execute("ln -s original.txt internal-link");

      // Reading internal symlink should work
      const result = await bashManager.execute("cat internal-link");
      expect(result.stdout.trim()).toBe("internal content");
    });

    it("should allow normal file operations", async () => {
      // Normal operations should still work
      await bashManager.execute("echo 'test' > normal.txt");
      const result = await bashManager.execute("cat normal.txt");
      expect(result.stdout.trim()).toBe("test");
    });
  });
});
