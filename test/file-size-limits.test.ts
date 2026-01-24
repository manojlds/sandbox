/**
 * Integration tests for file size and workspace size limits
 *
 * These tests verify that the configurable file size limits work correctly:
 * - MAX_FILE_SIZE: Maximum size for a single file
 * - MAX_WORKSPACE_SIZE: Maximum total workspace size
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test workspace - use a dedicated directory
const TEST_WORKSPACE = path.join(__dirname, "..", "test-workspace-limits");

let client: Client | null = null;
let transport: StdioClientTransport | null = null;

/**
 * Helper to call an MCP tool
 */
async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ content?: { text?: string }[] }> {
  if (!client) throw new Error("Client not connected");
  const result = (await client.callTool({ name, arguments: args })) as {
    content?: { text?: string }[];
  };
  return result;
}

/**
 * Helper for delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Setup before all tests
beforeAll(async () => {
  console.log("🚀 Starting MCP server for file size limit tests...");

  // Clean up test workspace
  if (fs.existsSync(TEST_WORKSPACE)) {
    fs.rmSync(TEST_WORKSPACE, { recursive: true });
  }
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });

  // Spawn the server process with custom limits
  const serverPath = path.join(__dirname, "..", "src", "server.ts");

  transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", serverPath],
    env: {
      ...process.env,
      PYODIDE_WORKSPACE: TEST_WORKSPACE,
      // Use default limits: 10MB file, 100MB workspace
    },
    cwd: path.join(__dirname, ".."),
  });

  client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

  await client.connect(transport);
  console.log("✓ MCP client connected");

  // Wait for Pyodide to initialize
  console.log("⏳ Waiting for Pyodide initialization...");
  await sleep(3000);
  console.log("✓ Ready to run file size limit tests\n");
}, 30000);

// Cleanup after all tests
afterAll(async () => {
  console.log("\n🧹 Cleaning up...");

  if (client) {
    await client.close();
  }

  // Clean up test workspace
  if (fs.existsSync(TEST_WORKSPACE)) {
    fs.rmSync(TEST_WORKSPACE, { recursive: true });
  }

  console.log("✓ Cleanup complete");
});

describe("File Size and Workspace Limits (Integration)", () => {
  describe("MAX_FILE_SIZE limit", () => {
    it("should reject files larger than MAX_FILE_SIZE (10MB default)", async () => {
      // Create content larger than default MAX_FILE_SIZE (10MB)
      // Use 11MB to ensure it exceeds the limit
      const largeContent = "x".repeat(11 * 1024 * 1024);

      const result = await callTool("write_file", {
        path: "test-large.txt",
        content: largeContent,
      });

      expect(result.content).toBeDefined();
      expect(result.content?.[0]?.text).toBeDefined();

      const responseText = result.content![0].text!;

      expect(responseText).toContain("✗ Error:");
      expect(responseText).toContain("File too large");
      expect(responseText).toContain("MB");
    });

    it("should accept files smaller than MAX_FILE_SIZE", async () => {
      // Create content smaller than MAX_FILE_SIZE (10MB)
      // Use 1MB to be well under the limit
      const content = "x".repeat(1 * 1024 * 1024);

      const result = await callTool("write_file", {
        path: "test-small.txt",
        content: content,
      });

      const responseText = result.content![0].text!;

      expect(responseText).toContain("✓ Written to");
      expect(responseText).toContain("test-small.txt");

      // Verify file was written
      const filePath = path.join(TEST_WORKSPACE, "test-small.txt");
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it("should accept files at the boundary of MAX_FILE_SIZE", async () => {
      // Create content at just under MAX_FILE_SIZE (10MB)
      const content = "x".repeat(10 * 1024 * 1024 - 100);

      const result = await callTool("write_file", {
        path: "test-boundary.txt",
        content: content,
      });

      const responseText = result.content![0].text!;

      expect(responseText).toContain("✓ Written to");
      expect(responseText).toContain("test-boundary.txt");
    });

    it("should provide helpful error message with size information", async () => {
      const largeContent = "x".repeat(15 * 1024 * 1024); // 15MB

      const result = await callTool("write_file", {
        path: "test-error.txt",
        content: largeContent,
      });

      const responseText = result.content![0].text!;

      expect(responseText).toContain("✗ Error:");
      expect(responseText).toContain("File too large");
      expect(responseText).toContain("15"); // Should show the actual size
      expect(responseText).toContain("Maximum allowed");
    });
  });

  describe("MAX_WORKSPACE_SIZE limit", () => {
    it("should reject files that would exceed MAX_WORKSPACE_SIZE (100MB default)", async () => {
      // Clean workspace first
      if (fs.existsSync(TEST_WORKSPACE)) {
        const files = fs.readdirSync(TEST_WORKSPACE);
        for (const file of files) {
          fs.rmSync(path.join(TEST_WORKSPACE, file), { recursive: true, force: true });
        }
      }

      await sleep(100);

      // Fill workspace with files close to the limit (100MB default)
      // Create 11 files of 9MB each = 99MB (should all succeed)
      for (let i = 0; i < 11; i++) {
        const content = "x".repeat(9 * 1024 * 1024);
        const result = await callTool("write_file", {
          path: `file${i}.txt`,
          content: content,
        });

        const responseText = result.content![0].text!;
        expect(responseText).toContain("✓ Written to");
      }

      // Now try to add another 9MB file (would be 108MB total), which should exceed the 100MB limit
      const additionalContent = "x".repeat(9 * 1024 * 1024);
      const result = await callTool("write_file", {
        path: "overflow.txt",
        content: additionalContent,
      });

      const responseText = result.content![0].text!;

      expect(responseText).toContain("✗ Error:");
      expect(responseText).toContain("Workspace size limit exceeded");
    });

    it("should accept files that keep workspace under MAX_WORKSPACE_SIZE", async () => {
      // Clean workspace first
      if (fs.existsSync(TEST_WORKSPACE)) {
        const files = fs.readdirSync(TEST_WORKSPACE);
        for (const file of files) {
          fs.rmSync(path.join(TEST_WORKSPACE, file), { recursive: true, force: true });
        }
      }

      // Wait a bit for cleanup
      await sleep(100);

      // Create multiple small files that stay under the limit
      // 5 files of 1MB each = 5MB (well under 100MB limit)
      for (let i = 0; i < 5; i++) {
        const content = "x".repeat(1 * 1024 * 1024);
        const result = await callTool("write_file", {
          path: `small${i}.txt`,
          content: content,
        });

        const responseText = result.content![0].text!;

        expect(responseText).toContain("✓ Written to");
      }
    });

    it("should provide helpful error with current and limit sizes", async () => {
      // Clean workspace first
      if (fs.existsSync(TEST_WORKSPACE)) {
        const files = fs.readdirSync(TEST_WORKSPACE);
        for (const file of files) {
          fs.rmSync(path.join(TEST_WORKSPACE, file), { recursive: true, force: true });
        }
      }

      await sleep(100);

      // Fill workspace to 99MB (11 files of 9MB)
      for (let i = 0; i < 11; i++) {
        const content = "x".repeat(9 * 1024 * 1024);
        await callTool("write_file", {
          path: `limit${i}.txt`,
          content: content,
        });
      }

      // Now try to add another 9MB file, which should exceed 100MB and fail
      const result = await callTool("write_file", {
        path: "overflow2.txt",
        content: "x".repeat(9 * 1024 * 1024),
      });

      const responseText = result.content![0].text!;

      expect(responseText).toContain("✗ Error:");
      expect(responseText).toContain("Workspace size limit exceeded");
      expect(responseText).toContain("Current:");
      expect(responseText).toContain("Limit:");
      expect(responseText).toContain("MB");
    });
  });

  describe("Combined limits", () => {
    it("should enforce both file size and workspace size limits", async () => {
      // Clean workspace first
      if (fs.existsSync(TEST_WORKSPACE)) {
        const files = fs.readdirSync(TEST_WORKSPACE);
        for (const file of files) {
          fs.rmSync(path.join(TEST_WORKSPACE, file), { recursive: true, force: true });
        }
      }

      await sleep(100);

      // Test MAX_FILE_SIZE is checked first
      const tooLargeFile = "x".repeat(11 * 1024 * 1024); // 11MB (exceeds MAX_FILE_SIZE)
      const result1 = await callTool("write_file", {
        path: "too-large.txt",
        content: tooLargeFile,
      });

      const responseText1 = result1.content![0].text!;

      expect(responseText1).toContain("✗ Error:");
      expect(responseText1).toContain("File too large");

      // Fill workspace to 99MB (11 files of 9MB each)
      for (let i = 0; i < 11; i++) {
        const content = "x".repeat(9 * 1024 * 1024);
        await callTool("write_file", {
          path: `combo${i}.txt`,
          content: content,
        });
      }

      // Try to add file that's under MAX_FILE_SIZE but would exceed workspace (99MB + 5MB = 104MB > 100MB)
      const result2 = await callTool("write_file", {
        path: "another.txt",
        content: "x".repeat(5 * 1024 * 1024),
      });

      const responseText2 = result2.content![0].text!;

      expect(responseText2).toContain("✗ Error:");
      expect(responseText2).toContain("Workspace size limit exceeded");
    });
  });

  describe("Empty and small files", () => {
    it("should handle empty files correctly", async () => {
      const result = await callTool("write_file", {
        path: "empty.txt",
        content: "",
      });

      const responseText = result.content![0].text!;

      expect(responseText).toContain("✓ Written to");
      expect(responseText).toContain("empty.txt");
    });

    it("should handle very small files correctly", async () => {
      const result = await callTool("write_file", {
        path: "tiny.txt",
        content: "Hello, World!",
      });

      const responseText = result.content![0].text!;

      expect(responseText).toContain("✓ Written to");
      expect(responseText).toContain("tiny.txt");
    });
  });
});
