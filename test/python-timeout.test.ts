/**
 * Python Execution Timeout Tests for Heimdall Server
 *
 * These tests verify the Python execution timeout functionality using worker threads.
 *
 * The timeout mechanism uses a worker thread architecture:
 * - Python code runs in a separate worker thread via Pyodide
 * - If execution exceeds the timeout, the main thread terminates the worker
 * - This enables true timeout enforcement for ANY blocking code, including:
 *   - Infinite loops (while True, for loops)
 *   - time.sleep() calls
 *   - CPU-intensive computations
 *
 * Run with: npm test -- test/python-timeout.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test workspace - use a temp directory to avoid conflicts
const TEST_WORKSPACE = path.join(__dirname, "..", "test-workspace-timeout");

// Short timeout for faster testing (2000ms)
const TEST_TIMEOUT_MS = 2000;

let client: Client | null = null;
let transport: StdioClientTransport | null = null;

/**
 * Helper to call an MCP tool
 */
async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!client) throw new Error("Client not connected");
  const result = await client.callTool({ name, arguments: args });
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
  console.log("🚀 Starting MCP server with timeout config...");

  // Clean up test workspace
  if (fs.existsSync(TEST_WORKSPACE)) {
    fs.rmSync(TEST_WORKSPACE, { recursive: true });
  }
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });

  // Spawn the server process with custom timeout
  const serverPath = path.join(__dirname, "..", "src", "server.ts");

  transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", serverPath],
    env: {
      ...process.env,
      HEIMDALL_WORKSPACE: TEST_WORKSPACE,
      HEIMDALL_PYTHON_EXECUTION_TIMEOUT_MS: String(TEST_TIMEOUT_MS),
    },
    cwd: path.join(__dirname, ".."),
  });

  client = new Client({ name: "test-client-timeout", version: "1.0.0" }, { capabilities: {} });

  await client.connect(transport);
  console.log("✓ MCP client connected");

  // Wait for Pyodide worker to initialize (takes longer due to worker thread setup)
  console.log("⏳ Waiting for Pyodide worker initialization...");
  await sleep(5000);
  console.log("✓ Ready to run timeout tests\n");
}, 120000); // Extended timeout for worker initialization

// Cleanup after all tests
afterAll(async () => {
  console.log("\n🧹 Cleaning up...");

  if (client) {
    await client.close();
  }

  if (transport) {
    await transport.close();
  }

  // Clean up test workspace
  if (fs.existsSync(TEST_WORKSPACE)) {
    fs.rmSync(TEST_WORKSPACE, { recursive: true });
  }

  console.log("✓ Cleanup complete");
});

describe("Python Execution Timeout", () => {
  describe("Fast Operations", () => {
    it("should allow fast operations to complete normally", async () => {
      const result = (await callTool("execute_python", {
        code: `
# This quick loop should complete well before timeout
total = 0
for i in range(1000):
    total += i
print(f"Sum of 0-999: {total}")
`,
      })) as { content: Array<{ text: string }> };

      const output = result.content[0].text;

      // Should complete successfully without timeout
      expect(output).toContain("Sum of 0-999: 499500");
      expect(output).not.toContain("timed out");
    }, 30000);

    it("should execute multiple quick operations without timeout", async () => {
      // Run several quick operations to verify the timeout doesn't interfere
      for (let i = 0; i < 3; i++) {
        const result = (await callTool("execute_python", {
          code: `
import math
result = math.factorial(10)
print(f"factorial(10) = {result}")
`,
        })) as { content: Array<{ text: string }> };

        const output = result.content[0].text;
        expect(output).toContain("factorial(10) = 3628800");
        expect(output).not.toContain("timed out");
      }
    }, 90000);
  });

  describe("Synchronous Blocking Code Timeout", () => {
    it("should timeout infinite while loops", async () => {
      const startTime = Date.now();

      const result = (await callTool("execute_python", {
        code: `
# This infinite while loop should be terminated by the worker timeout
count = 0
while True:
    count += 1
print(f"Reached count: {count}")  # Should not reach here
`,
      })) as { content: Array<{ text: string }> };

      const elapsed = Date.now() - startTime;
      const output = result.content[0].text;

      console.log(`Infinite loop timeout test completed in ${elapsed}ms`);
      console.log(`Output: ${output.substring(0, 200)}`);

      // Should contain the timeout error message
      expect(output).toContain("timed out");
      expect(output).toContain(`${TEST_TIMEOUT_MS}ms`);

      // Should complete within a reasonable time (timeout + buffer for worker restart)
      expect(elapsed).toBeLessThan(TEST_TIMEOUT_MS + 5000);

      // Wait for worker to restart before next test
      await sleep(3000);
    }, 60000);

    it("should timeout CPU-intensive operations", async () => {
      const startTime = Date.now();

      const result = (await callTool("execute_python", {
        code: `
# CPU-intensive computation that exceeds timeout
result = 0
for i in range(10**12):  # This would take a very long time
    result += i
print(f"Result: {result}")
`,
      })) as { content: Array<{ text: string }> };

      const elapsed = Date.now() - startTime;
      const output = result.content[0].text;

      console.log(`CPU-intensive timeout test completed in ${elapsed}ms`);
      console.log(`Output: ${output.substring(0, 200)}`);

      // Should timeout (or indicate worker restarting)
      expect(output).toMatch(/timed out|Worker/i);

      // Wait for worker to restart
      await sleep(3000);
    }, 60000);
  });

  describe("Recovery After Timeout", () => {
    it("should recover and work normally after a timeout", async () => {
      // First, trigger a timeout with an infinite loop
      const timeoutResult = (await callTool("execute_python", {
        code: `
while True:
    pass  # Infinite loop
`,
      })) as { content: Array<{ text: string }> };

      expect(timeoutResult.content[0].text).toContain("timed out");

      // Wait for worker to restart
      await sleep(2000);

      // Now run a normal operation - should work
      const normalResult = (await callTool("execute_python", {
        code: `
print("Server recovered!")
result = 42 * 2
print(f"Result: {result}")
`,
      })) as { content: Array<{ text: string }> };

      const output = normalResult.content[0].text;

      // Should complete successfully
      expect(output).toContain("Server recovered!");
      expect(output).toContain("Result: 84");
      expect(output).not.toContain("timed out");
    }, 120000); // Extended timeout for worker restart
  });

  describe("Timeout Error Messages", () => {
    it("should include timeout duration in error message", async () => {
      const result = (await callTool("execute_python", {
        code: `
# Infinite loop to trigger timeout
while True:
    x = 1 + 1
`,
      })) as { content: Array<{ text: string }> };

      const output = result.content[0].text;

      // Should show timeout message with the configured duration
      expect(output).toContain("timed out");
      expect(output).toContain(`${TEST_TIMEOUT_MS}ms`);
    }, 30000);
  });
});
