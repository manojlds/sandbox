/**
 * Path Traversal Security Tests (non-symlink based)
 *
 * Tests to ensure that path traversal attacks using "..", absolute paths,
 * null bytes, and special characters are properly blocked across all
 * MCP file tools, bash cwd parameter, and bash commands.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_WORKSPACE = path.join(__dirname, "..", "test-workspace-path-traversal");

let client: Client | null = null;
let transport: StdioClientTransport | null = null;

async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  if (!client) throw new Error("Client not connected");
  const result = await client.callTool({ name, arguments: args });
  return result as { content: Array<{ type: string; text: string }>; isError?: boolean };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Path Traversal Security", () => {
  beforeAll(async () => {
    if (fs.existsSync(TEST_WORKSPACE)) {
      fs.rmSync(TEST_WORKSPACE, { recursive: true });
    }
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });

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

    client = new Client(
      { name: "path-traversal-test-client", version: "1.0.0" },
      { capabilities: {} }
    );
    await client.connect(transport);

    await sleep(5000);
  }, 60000);

  afterAll(async () => {
    if (client) {
      try {
        await client.close();
      } catch {
        // Ignore close errors
      }
    }

    if (fs.existsSync(TEST_WORKSPACE)) {
      fs.rmSync(TEST_WORKSPACE, { recursive: true });
    }
  });

  describe("MCP File Tool Path Traversal", () => {
    describe("read_file with relative traversal paths", () => {
      const traversalPaths = [
        "../outside.txt",
        "../../etc/passwd",
        "a/../../b",
        "a/../../etc/passwd",
        "./.././../b",
        "../../../etc/passwd",
      ];

      for (const traversalPath of traversalPaths) {
        it(`should reject read_file with path "${traversalPath}"`, async () => {
          const result = await callTool("read_file", { path: traversalPath });
          const text = result.content[0].text.toLowerCase();
          expect(text.includes("traversal") || text.includes("invalid path")).toBe(true);
          expect(text).not.toContain("root:");
        }, 30000);
      }
    });

    describe("read_file with absolute paths", () => {
      const absolutePaths = ["/etc/passwd", "/proc/self/environ", "/"];

      for (const absPath of absolutePaths) {
        it(`should reject read_file with absolute path "${absPath}"`, async () => {
          const result = await callTool("read_file", { path: absPath });
          const text = result.content[0].text.toLowerCase();
          expect(text.includes("traversal") || text.includes("invalid path")).toBe(true);
          expect(text).not.toContain("root:");
        }, 30000);
      }
    });

    describe("write_file with traversal paths", () => {
      const writeAttacks = [
        { path: "../evil.txt", checkPath: path.join(TEST_WORKSPACE, "..", "evil.txt") },
        {
          path: "../../tmp/evil.txt",
          checkPath: path.join(TEST_WORKSPACE, "..", "..", "tmp", "evil.txt"),
        },
        { path: "a/../../evil.txt", checkPath: path.join(TEST_WORKSPACE, "..", "evil.txt") },
      ];

      for (const attack of writeAttacks) {
        it(`should reject write_file with path "${attack.path}" and not create file outside workspace`, async () => {
          const result = await callTool("write_file", {
            path: attack.path,
            content: "MALICIOUS",
          });
          const text = result.content[0].text.toLowerCase();
          expect(text.includes("traversal") || text.includes("invalid path")).toBe(true);
          expect(fs.existsSync(attack.checkPath)).toBe(false);
        }, 30000);
      }
    });

    describe("list_files with traversal paths", () => {
      const listPaths = ["..", "../..", "/", "/etc"];

      for (const listPath of listPaths) {
        it(`should reject list_files with path "${listPath}"`, async () => {
          const result = await callTool("list_files", { path: listPath });
          const text = result.content[0].text.toLowerCase();
          expect(text.includes("traversal") || text.includes("invalid path")).toBe(true);
        }, 30000);
      }
    });

    describe("delete_file with traversal paths", () => {
      const deletePaths = ["../some-file", "../../tmp/something"];

      for (const deletePath of deletePaths) {
        it(`should reject delete_file with path "${deletePath}"`, async () => {
          const result = await callTool("delete_file", { path: deletePath });
          const text = result.content[0].text.toLowerCase();
          expect(text.includes("traversal") || text.includes("invalid path")).toBe(true);
        }, 30000);
      }
    });
  });

  describe("Bash cwd Parameter Traversal", () => {
    const invalidCwdValues = [
      "..",
      "../..",
      "/workspace/../..",
      "/etc",
      "/tmp",
      "//workspace/../../",
    ];

    for (const cwd of invalidCwdValues) {
      it(`should reject execute_bash with cwd "${cwd}"`, async () => {
        const result = await callTool("execute_bash", {
          command: "echo hello",
          cwd: cwd,
        });
        expect(result.isError).toBe(true);
        const text = result.content[0].text.toLowerCase();
        expect(
          text.includes("invalid") || text.includes("traversal") || text.includes("outside")
        ).toBe(true);
      }, 30000);
    }
  });

  describe("Bash Command Path Traversal", () => {
    it('should not expose /etc/passwd via "cat /etc/passwd"', async () => {
      const result = await callTool("execute_bash", { command: "cat /etc/passwd" });
      const text = result.content[0].text;
      expect(text).not.toContain("root:");
    }, 30000);

    it('should not list real root filesystem entries via "ls /"', async () => {
      const result = await callTool("execute_bash", { command: "ls /" });
      const text = result.content[0].text;
      expect(text).not.toContain("usr");
      expect(text).not.toContain("var");
      expect(text).not.toContain("home");
    }, 30000);

    it('should not expose /etc/passwd via "cat ../../../../etc/passwd"', async () => {
      const result = await callTool("execute_bash", {
        command: "cat ../../../../etc/passwd",
      });
      const text = result.content[0].text;
      expect(text).not.toContain("root:");
    }, 30000);

    it('should not find host files via "find / -maxdepth 1 -type f"', async () => {
      const result = await callTool("execute_bash", {
        command: "find / -maxdepth 1 -type f",
      });
      const text = result.content[0].text;
      expect(text).not.toContain("/etc");
      expect(text).not.toContain("/proc");
    }, 30000);
  });

  describe("Legitimate Operations Still Work", () => {
    it("should allow write_file and read_file with normal paths", async () => {
      const writeResult = await callTool("write_file", {
        path: "safe/test.txt",
        content: "hello",
      });
      expect(writeResult.content[0].text).toContain("Written");

      const readResult = await callTool("read_file", { path: "safe/test.txt" });
      expect(readResult.content[0].text).toBe("hello");
    }, 30000);

    it("should allow paths with dots that are not traversal", async () => {
      const writeResult = await callTool("write_file", {
        path: "file.with.dots.txt",
        content: "dotted",
      });
      expect(writeResult.content[0].text).toContain("Written");

      const readResult = await callTool("read_file", { path: "file.with.dots.txt" });
      expect(readResult.content[0].text).toBe("dotted");
    }, 30000);
  });

  describe("Null Byte and Special Character Paths", () => {
    it("should handle path with null byte gracefully", async () => {
      const result = await callTool("read_file", { path: "test\x00evil.txt" });
      const text = result.content[0].text.toLowerCase();
      expect(
        text.includes("error") ||
          text.includes("invalid") ||
          text.includes("traversal") ||
          result.isError === true
      ).toBe(true);
    }, 30000);

    it("should handle extremely long path gracefully", async () => {
      const longPath = "a".repeat(1000) + ".txt";
      const result = await callTool("read_file", { path: longPath });
      const text = result.content[0].text.toLowerCase();
      expect(
        text.includes("error") ||
          text.includes("invalid") ||
          text.includes("not found") ||
          text.includes("no such") ||
          result.isError === true
      ).toBe(true);
    }, 30000);
  });
});
