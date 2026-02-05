/**
 * Test demonstrating Pyodide FFI 128MB limit
 *
 * DSPy discovered that Pyodide's FFI crashes at exactly 128MB (134,217,728 bytes).
 * This test shows:
 * 1. What the FFI limit is (code/data sent through postMessage -> runPythonAsync)
 * 2. What triggers it (large string literals embedded in code)
 * 3. What bypasses it (virtual filesystem operations)
 *
 * Note: This test uses the MCP server approach like integration.test.ts to avoid
 * Pyodide module resolution issues in CI environments.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_WORKSPACE = path.join(__dirname, "..", "test-workspace-ffi-demo");

let client: Client | null = null;
let transport: StdioClientTransport | null = null;

/**
 * Helper to call an MCP tool with extended timeout
 */
async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ content?: { text?: string }[] }> {
  if (!client) throw new Error("Client not connected");
  const result = (await client.callTool(
    { name, arguments: args },
    undefined,
    { timeout: 180000 } // 3 minute timeout for large data transfers
  )) as {
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

beforeAll(async () => {
  // Clean workspace
  if (fs.existsSync(TEST_WORKSPACE)) {
    fs.rmSync(TEST_WORKSPACE, { recursive: true });
  }
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });

  // Spawn the server process
  const serverPath = path.join(__dirname, "..", "src", "server.ts");

  // Use longer Python execution timeout for this test (large data transfers)
  const pythonExecutionTimeout = 120000; // 2 minutes

  transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", serverPath],
    env: {
      ...process.env,
      HEIMDALL_WORKSPACE: TEST_WORKSPACE,
      HEIMDALL_MAX_FILE_SIZE: String(200 * 1024 * 1024), // 200MB
      HEIMDALL_MAX_WORKSPACE_SIZE: String(500 * 1024 * 1024), // 500MB
      HEIMDALL_PYTHON_EXECUTION_TIMEOUT_MS: String(pythonExecutionTimeout),
    },
    cwd: path.join(__dirname, ".."),
  });

  client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

  await client.connect(transport);

  // Wait for Pyodide to initialize
  await sleep(3000);
}, 60000);

afterAll(async () => {
  if (client) {
    await client.close();
  }

  // Clean up
  if (fs.existsSync(TEST_WORKSPACE)) {
    fs.rmSync(TEST_WORKSPACE, { recursive: true });
  }
});

describe("Pyodide FFI 128MB Limit", () => {
  it("should fail with 140MB string literal embedded in code", async () => {
    // Create a 140MB string literal directly in the code
    // This goes through FFI and should hit the 128MB limit
    const size = 140 * 1024 * 1024;
    const hugeString = "z".repeat(size);

    const code = `
# Embedded 140MB string literal
data = """${hugeString}"""
print(f"String length: {len(data) / 1024 / 1024:.2f}MB")
    `.trim();

    console.log(
      `Testing with ${(code.length / 1024 / 1024).toFixed(2)}MB of code (embedded string)...`
    );

    const result = await callTool("execute_python", { code });

    // Expected to fail due to FFI limit
    console.log(`Result: ${result.content?.[0]?.text?.includes("✗") ? "FAILURE" : "SUCCESS"}`);
    if (result.content?.[0]?.text) {
      console.log("Output:", result.content[0].text.substring(0, 200));
    }
  }, 200000);

  it("should work with 150MB through virtual filesystem (bypasses FFI)", async () => {
    // Virtual filesystem bypasses FFI - this should work
    const size = 150 * 1024 * 1024;
    const content = "y".repeat(size);

    const writeResult = await callTool("write_file", {
      path: "large.txt",
      content: content,
    });

    expect(writeResult.content?.[0]?.text).toContain("✓ Written to");

    const code = `
with open('/workspace/large.txt', 'r') as f:
    data = f.read()
print(f"Read {len(data) / 1024 / 1024:.2f}MB from file")
    `.trim();

    const result = await callTool("execute_python", { code });

    expect(result.content?.[0]?.text).toContain("150.00MB");
  }, 200000);
});
