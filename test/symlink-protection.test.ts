/**
 * Symlink Protection Tests
 *
 * Tests to ensure that symlink-based path traversal attacks are blocked.
 * These tests verify that the sandbox cannot be escaped by creating symlinks
 * that point outside the workspace directory.
 *
 * Uses the MCP server to test end-to-end symlink protection.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test workspace
const TEST_WORKSPACE = path.join(__dirname, "..", "test-workspace-symlink");

// Directory outside workspace for testing symlink attacks
let outsideDir: string;
let outsideFile: string;

let client: Client | null = null;
let transport: StdioClientTransport | null = null;

/**
 * Helper to call an MCP tool
 */
async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  if (!client) throw new Error("Client not connected");
  const result = await client.callTool({ name, arguments: args });
  return result as { content: Array<{ type: string; text: string }>; isError?: boolean };
}

/**
 * Helper for delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Symlink Protection", () => {
  beforeAll(async () => {
    // Create directory outside workspace for attack targets
    outsideDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "heimdall-symlink-test-"));
    outsideFile = path.join(outsideDir, "sensitive-data.txt");
    await fs.promises.writeFile(outsideFile, "SENSITIVE DATA - SHOULD NOT BE ACCESSIBLE");

    // Clean up and create test workspace
    if (fs.existsSync(TEST_WORKSPACE)) {
      fs.rmSync(TEST_WORKSPACE, { recursive: true });
    }
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });

    // Start MCP server
    const serverPath = path.join(__dirname, "..", "src", "server.ts");

    transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", serverPath],
      env: {
        ...process.env,
        HEIMDALL_WORKSPACE: TEST_WORKSPACE,
      },
      cwd: path.join(__dirname, ".."),
    });

    client = new Client({ name: "symlink-test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);

    // Wait for Pyodide to initialize
    await sleep(5000);
  }, 60000);

  afterAll(async () => {
    // Close client
    if (client) {
      try {
        await client.close();
      } catch {
        // Ignore close errors
      }
    }

    // Clean up test workspace
    if (fs.existsSync(TEST_WORKSPACE)) {
      fs.rmSync(TEST_WORKSPACE, { recursive: true });
    }

    // Clean up outside directory
    if (outsideDir) {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    // Clean workspace contents before each test
    const items = await fs.promises.readdir(TEST_WORKSPACE);
    for (const item of items) {
      await fs.promises.rm(path.join(TEST_WORKSPACE, item), { recursive: true, force: true });
    }
  });

  describe("Direct Symlink Attacks", () => {
    it("should block reading through symlink pointing outside workspace", async () => {
      // Create a symlink inside workspace pointing to file outside
      const symlinkPath = path.join(TEST_WORKSPACE, "evil-link");
      await fs.promises.symlink(outsideFile, symlinkPath);

      // Attempt to read through the symlink should fail
      const result = await callTool("read_file", { path: "evil-link" });

      expect(result.content[0].text).toContain("security violation");
    });

    it("should block writing through symlink pointing outside workspace", async () => {
      // Create a symlink inside workspace pointing to file outside
      const symlinkPath = path.join(TEST_WORKSPACE, "evil-write-link");
      await fs.promises.symlink(outsideFile, symlinkPath);

      // Attempt to write through the symlink should fail
      const result = await callTool("write_file", {
        path: "evil-write-link",
        content: "MALICIOUS CONTENT",
      });

      expect(result.content[0].text).toContain("security violation");

      // Verify the original file was not modified
      const content = await fs.promises.readFile(outsideFile, "utf-8");
      expect(content).toBe("SENSITIVE DATA - SHOULD NOT BE ACCESSIBLE");
    });

    it("should block deleting through symlink pointing outside workspace", async () => {
      // Create a temp file outside workspace to try to delete
      const tempFile = path.join(outsideDir, "to-delete.txt");
      await fs.promises.writeFile(tempFile, "delete me");

      // Create a symlink inside workspace pointing to file outside
      const symlinkPath = path.join(TEST_WORKSPACE, "evil-delete-link");
      await fs.promises.symlink(tempFile, symlinkPath);

      // Attempt to delete through the symlink should fail
      const result = await callTool("delete_file", { path: "evil-delete-link" });

      expect(result.content[0].text).toContain("security violation");

      // Verify the original file was not deleted
      const exists = await fs.promises
        .access(tempFile)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    it("should block directory symlink pointing outside workspace", async () => {
      // Create a symlink to a directory outside workspace
      const symlinkPath = path.join(TEST_WORKSPACE, "evil-dir-link");
      await fs.promises.symlink(outsideDir, symlinkPath);

      // Attempt to list files through the symlink should fail
      const result = await callTool("list_files", { path: "evil-dir-link" });

      expect(result.content[0].text).toContain("security violation");
    });
  });

  describe("Nested Symlink Attacks", () => {
    it("should block nested symlink chain escaping workspace", async () => {
      // Create a legitimate subdirectory
      const subdir = path.join(TEST_WORKSPACE, "subdir");
      await fs.promises.mkdir(subdir, { recursive: true });

      // Create a symlink in subdir pointing outside
      const nestedSymlink = path.join(subdir, "nested-evil");
      await fs.promises.symlink(outsideFile, nestedSymlink);

      // Attempt to read through nested symlink should fail
      const result = await callTool("read_file", { path: "subdir/nested-evil" });

      expect(result.content[0].text).toContain("security violation");
    });

    it("should block parent directory being a symlink to outside", async () => {
      // Create a symlink to outside directory
      const symlinkDir = path.join(TEST_WORKSPACE, "symlink-parent");
      await fs.promises.symlink(outsideDir, symlinkDir);

      // Attempt to write a file with parent being a symlink should fail
      const result = await callTool("write_file", {
        path: "symlink-parent/newfile.txt",
        content: "content",
      });

      expect(result.content[0].text).toContain("security violation");
    });
  });

  describe("Legitimate Operations", () => {
    it("should allow normal file operations within workspace", async () => {
      // Write a normal file
      const writeResult = await callTool("write_file", {
        path: "normal-file.txt",
        content: "Hello, World!",
      });
      expect(writeResult.content[0].text).toContain("Written");

      // Read the file back
      const readResult = await callTool("read_file", { path: "normal-file.txt" });
      expect(readResult.content[0].text).toBe("Hello, World!");

      // Delete the file
      const deleteResult = await callTool("delete_file", { path: "normal-file.txt" });
      expect(deleteResult.content[0].text).toContain("Deleted");
    });

    it("should allow operations in nested directories", async () => {
      // Create nested directory structure and files
      const writeResult = await callTool("write_file", {
        path: "a/b/c/deep-file.txt",
        content: "Deep content",
      });
      expect(writeResult.content[0].text).toContain("Written");

      // Read back
      const readResult = await callTool("read_file", { path: "a/b/c/deep-file.txt" });
      expect(readResult.content[0].text).toBe("Deep content");
    });

    it("should allow symlinks within workspace that stay within workspace", async () => {
      // Create a legitimate file
      await callTool("write_file", { path: "original.txt", content: "Original content" });

      // Create a symlink to it (within workspace)
      const symlinkPath = path.join(TEST_WORKSPACE, "internal-link");
      const targetPath = path.join(TEST_WORKSPACE, "original.txt");
      await fs.promises.symlink(targetPath, symlinkPath);

      // Reading through internal symlink should work
      const result = await callTool("read_file", { path: "internal-link" });
      expect(result.content[0].text).toBe("Original content");
    });
  });

  describe("Edge Cases", () => {
    it("should handle relative symlinks that escape workspace", async () => {
      // Create a symlink using relative path that escapes
      const symlinkPath = path.join(TEST_WORKSPACE, "relative-escape");
      // This creates a relative symlink like "../../../tmp/..."
      const relativePath = path.relative(TEST_WORKSPACE, outsideFile);
      await fs.promises.symlink(relativePath, symlinkPath);

      // Should be blocked
      const result = await callTool("read_file", { path: "relative-escape" });
      expect(result.content[0].text).toContain("security violation");
    });

    it("should handle symlink with dots in filename (not traversal)", async () => {
      // Create a file with dots in name (not path traversal)
      const writeResult = await callTool("write_file", {
        path: "file.with.dots.txt",
        content: "Dotted content",
      });
      expect(writeResult.content[0].text).toContain("Written");

      const readResult = await callTool("read_file", { path: "file.with.dots.txt" });
      expect(readResult.content[0].text).toBe("Dotted content");
    });

    it("should reject symlink to /etc/passwd", async () => {
      // Skip on Windows
      if (process.platform === "win32") {
        return;
      }

      // Check if /etc/passwd exists
      const passwdExists = await fs.promises
        .access("/etc/passwd")
        .then(() => true)
        .catch(() => false);

      if (!passwdExists) {
        return; // Skip if /etc/passwd doesn't exist
      }

      // Create a symlink to /etc/passwd
      const symlinkPath = path.join(TEST_WORKSPACE, "passwd-link");
      await fs.promises.symlink("/etc/passwd", symlinkPath);

      // Should be blocked
      const result = await callTool("read_file", { path: "passwd-link" });
      expect(result.content[0].text).toContain("security violation");
    });
  });

  describe("Python-based Symlink Attacks", () => {
    it("should block Python from reading through external symlinks", async () => {
      // Create a symlink pointing outside
      const symlinkPath = path.join(TEST_WORKSPACE, "py-evil-link");
      await fs.promises.symlink(outsideFile, symlinkPath);

      // Try to read via Python - the file operations go through PyodideManager
      // which should validate symlinks
      const result = await callTool("execute_python", {
        code: `
with open('/workspace/py-evil-link', 'r') as f:
    print(f.read())
`,
      });

      // The operation should fail due to symlink protection
      // Either during sync or read
      const hasError =
        result.isError ||
        result.content[0].text.includes("security violation") ||
        result.content[0].text.includes("Error");
      expect(hasError).toBe(true);
    });

    it("should block Python from writing through external symlinks", async () => {
      // Create a symlink pointing outside
      const symlinkPath = path.join(TEST_WORKSPACE, "py-write-evil");
      await fs.promises.symlink(outsideFile, symlinkPath);

      // Try to write via Python
      const result = await callTool("execute_python", {
        code: `
with open('/workspace/py-write-evil', 'w') as f:
    f.write('HACKED')
`,
      });

      // Verify the original file was not modified
      const content = await fs.promises.readFile(outsideFile, "utf-8");
      expect(content).toBe("SENSITIVE DATA - SHOULD NOT BE ACCESSIBLE");
    });
  });
});
