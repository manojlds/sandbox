/**
 * Resource Exhaustion & Race Condition Tests for Heimdall Server
 *
 * These tests verify that the server handles resource exhaustion attacks
 * and integration-level race conditions gracefully without crashing.
 *
 * Run with: npm test -- test/resource-exhaustion.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_WORKSPACE = path.join(__dirname, "..", "test-workspace-exhaustion");

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

beforeAll(async () => {
  console.log("🚀 Starting MCP server for resource exhaustion tests...");

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
      HEIMDALL_PYTHON_EXECUTION_TIMEOUT_MS: "3000",
    },
    cwd: path.join(__dirname, ".."),
  });

  client = new Client({ name: "test-client-exhaustion", version: "1.0.0" }, { capabilities: {} });

  await client.connect(transport);
  console.log("✓ MCP client connected");

  console.log("⏳ Waiting for Pyodide initialization...");
  await sleep(5000);
  console.log("✓ Ready to run resource exhaustion tests\n");
}, 60000);

afterAll(async () => {
  console.log("\n🧹 Cleaning up...");

  if (client) {
    await client.close();
  }

  if (transport) {
    await transport.close();
  }

  if (fs.existsSync(TEST_WORKSPACE)) {
    fs.rmSync(TEST_WORKSPACE, { recursive: true });
  }

  console.log("✓ Cleanup complete");
});

describe("Resource Exhaustion & Race Conditions", () => {
  describe("Python Memory Exhaustion", () => {
    it("should handle large string allocation without crashing", async () => {
      const result = await callTool("execute_python", {
        code: `
try:
    a = "x" * (200 * 1024 * 1024)
    print(f"ALLOCATED: {len(a)} bytes")
    del a  # Free memory
except MemoryError:
    print("BLOCKED: MemoryError")
except Exception as e:
    print(f"BLOCKED: {type(e).__name__}")
`,
      });

      const output = result.content[0].text;
      // WASM has ~4GB address space, so 200MB allocation may succeed
      // The important thing is the server doesn't crash
      expect(output).toMatch(/ALLOCATED|BLOCKED|MemoryError|timed out/);

      await sleep(3000);

      // Server must recover and work normally
      const recovery = await callTool("execute_python", {
        code: 'print("recovered")',
      });
      expect(recovery.content[0].text).toContain("recovered");
    }, 30000);

    it("should handle list allocation bomb without crashing", async () => {
      const result = await callTool("execute_python", {
        code: `
try:
    a = [0] * (100 * 1024 * 1024)
    print(f"ALLOCATED: {len(a)} items")
    del a  # Free memory
except MemoryError:
    print("BLOCKED: MemoryError")
except Exception as e:
    print(f"BLOCKED: {type(e).__name__}")
`,
      });

      const output = result.content[0].text;
      // WASM has ~4GB address space, so 100M list allocation may succeed
      // The important thing is the server doesn't crash
      expect(output).toMatch(/ALLOCATED|BLOCKED|MemoryError|timed out/);

      await sleep(3000);

      const recovery = await callTool("execute_python", {
        code: 'print("recovered")',
      });
      expect(recovery.content[0].text).toContain("recovered");
    }, 30000);
  });

  describe("Python Output Flooding", () => {
    it("should handle huge stdout without breaking the server", async () => {
      const result = await callTool("execute_python", {
        code: `
for i in range(100000):
    print(f"LINE {i}: {'x' * 100}")
print("DONE")
`,
      });

      expect(result.content).toBeDefined();
      expect(result.content[0].text).toBeDefined();

      await sleep(3000);

      const recovery = await callTool("execute_python", {
        code: 'print("still alive")',
      });
      expect(recovery.content[0].text).toContain("still alive");
    }, 30000);
  });

  describe("Concurrent Write Race Condition (Workspace Size Bypass)", () => {
    it("should enforce workspace size limits under concurrent writes", async () => {
      const items = fs.readdirSync(TEST_WORKSPACE);
      for (const item of items) {
        fs.rmSync(path.join(TEST_WORKSPACE, item), { recursive: true, force: true });
      }
      await sleep(100);

      for (let i = 0; i < 10; i++) {
        const content = "x".repeat(9 * 1024 * 1024);
        await callTool("write_file", { path: `fill${i}.txt`, content });
      }

      const content5MB = "y".repeat(5 * 1024 * 1024);
      const results = await Promise.all([
        callTool("write_file", { path: "race1.txt", content: content5MB }),
        callTool("write_file", { path: "race2.txt", content: content5MB }),
        callTool("write_file", { path: "race3.txt", content: content5MB }),
      ]);

      const successes = results.filter((r) => r.content[0].text.includes("✓")).length;
      const failures = results.filter((r) => r.content[0].text.includes("✗")).length;

      expect(failures).toBeGreaterThan(0);
      console.log(
        `Race condition test: ${successes} successes, ${failures} failures out of 3 concurrent writes`
      );
    }, 120000);
  });

  describe("Deep Directory Nesting", () => {
    it("should handle deeply nested directories without crashing", async () => {
      const result = await callTool("execute_python", {
        code: `
import os
current = '/workspace/deep'
for i in range(100):
    current = os.path.join(current, f'level_{i}')
os.makedirs(current, exist_ok=True)

with open(os.path.join(current, 'bottom.txt'), 'w') as f:
    f.write('deep file')

print(f"Created {100} levels deep")
`,
      });

      const output = result.content[0].text;
      expect(output).toContain("Created 100 levels deep");

      const listResult = await callTool("list_files", { path: "" });
      expect(listResult.content).toBeDefined();
      expect(listResult.content[0].text).toBeDefined();
    }, 60000);
  });

  describe("Many Small Files Stress", () => {
    it("should handle creating and listing many small files", async () => {
      const result = await callTool("execute_python", {
        code: `
import os
os.makedirs('/workspace/many', exist_ok=True)
for i in range(500):
    with open(f'/workspace/many/file_{i}.txt', 'w') as f:
        f.write(f'content {i}')
print(f"Created 500 files")
`,
      });

      const output = result.content[0].text;
      expect(output).toContain("Created 500 files");

      const listResult = await callTool("list_files", { path: "many" });
      expect(listResult.content).toBeDefined();
      expect(listResult.content[0].text).toBeDefined();
    }, 60000);
  });

  describe("Server Recovery Verification", () => {
    it("should be fully healthy after all exhaustion tests", async () => {
      const pythonResult = await callTool("execute_python", {
        code: 'print("final health check")',
      });
      expect(pythonResult.content[0].text).toContain("final health check");

      const bashResult = await callTool("execute_bash", {
        command: 'echo "bash healthy"',
      });
      expect(bashResult.content[0].text).toContain("bash healthy");
    }, 30000);
  });
}, 300000);
