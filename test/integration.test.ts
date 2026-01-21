/**
 * MCP Integration Tests for Pyodide Sandbox Server
 *
 * These tests spin up the MCP server and connect with a client
 * to verify all functionality works end-to-end.
 *
 * Run with: npm test
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
const TEST_WORKSPACE = path.join(__dirname, "..", "test-workspace");

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
  console.log("🚀 Starting MCP server...");

  // Clean up test workspace
  if (fs.existsSync(TEST_WORKSPACE)) {
    fs.rmSync(TEST_WORKSPACE, { recursive: true });
  }
  fs.mkdirSync(TEST_WORKSPACE, { recursive: true });

  // Spawn the server process
  const serverPath = path.join(__dirname, "..", "src", "server.ts");

  transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", serverPath],
    env: {
      ...process.env,
      PYODIDE_WORKSPACE: TEST_WORKSPACE,
    },
    cwd: path.join(__dirname, ".."),
  });

  client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

  await client.connect(transport);
  console.log("✓ MCP client connected");

  // Wait for Pyodide to initialize
  console.log("⏳ Waiting for Pyodide initialization...");
  await sleep(3000);
  console.log("✓ Ready to run tests\n");
}, 30000);

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

describe("Pyodide Sandbox MCP Server", () => {
  describe("Basic Python Execution", () => {
    it("should execute basic Python code", async () => {
      const result = (await callTool("execute_python", {
        code: `
import sys
print(f"Python version: {sys.version_info.major}.{sys.version_info.minor}")
print("Hello from Pyodide!")
`,
      })) as { content: Array<{ text: string }> };

      const output = result.content[0].text;
      expect(output).toContain("Python version: 3.12");
      expect(output).toContain("Hello from Pyodide!");
    });

    it("should perform math operations", async () => {
      const result = (await callTool("execute_python", {
        code: `
import math
print(f"Pi: {math.pi}")
print(f"factorial(5): {math.factorial(5)}")
`,
      })) as { content: Array<{ text: string }> };

      const output = result.content[0].text;
      expect(output).toContain("Pi: 3.14159");
      expect(output).toContain("factorial(5): 120");
    });

    it("should handle errors gracefully", async () => {
      const result = (await callTool("execute_python", {
        code: "x = 1 / 0  # This will raise ZeroDivisionError",
      })) as { content: Array<{ text: string }> };

      const output = result.content[0].text;
      expect(output).toContain("ZeroDivisionError");
    });
  });

  describe("File Operations", () => {
    it("should write files", async () => {
      const result = (await callTool("write_file", {
        path: "test_module.py",
        content: `
def add(a, b):
    return a + b

def multiply(a, b):
    return a * b

MESSAGE = "Hello from test module!"
`,
      })) as { content: Array<{ text: string }> };

      const output = result.content[0].text;
      expect(output).toContain("✓");
    });

    it("should read files", async () => {
      const result = (await callTool("read_file", {
        path: "test_module.py",
      })) as { content: Array<{ text: string }> };

      const output = result.content[0].text;
      expect(output).toContain("def add(a, b)");
      expect(output).toContain("MESSAGE");
    });

    it("should list files", async () => {
      const result = (await callTool("list_files", {
        path: "",
      })) as { content: Array<{ text: string }> };

      const output = result.content[0].text;
      expect(output).toContain("test_module.py");
    });

    it("should create nested directories", async () => {
      await callTool("write_file", {
        path: "data/config/settings.json",
        content: JSON.stringify({ debug: true, version: "1.0.0" }, null, 2),
      });

      const listResult = (await callTool("list_files", {
        path: "data",
      })) as { content: Array<{ text: string }> };

      const output = listResult.content[0].text;
      expect(output).toContain("config");
    });

    it("should delete files", async () => {
      // Create a file
      await callTool("write_file", {
        path: "to_delete.txt",
        content: "This file will be deleted",
      });

      // Verify it exists
      const beforeList = (await callTool("list_files", {
        path: "",
      })) as { content: Array<{ text: string }> };
      expect(beforeList.content[0].text).toContain("to_delete.txt");

      // Delete it
      const deleteResult = (await callTool("delete_file", {
        path: "to_delete.txt",
      })) as { content: Array<{ text: string }> };
      expect(deleteResult.content[0].text).toContain("✓");

      // Small delay for sync
      await sleep(100);

      // Verify it's gone
      const afterList = (await callTool("list_files", {
        path: "",
      })) as { content: Array<{ text: string }> };
      expect(afterList.content[0].text).not.toContain("to_delete.txt");
    });
  });

  describe("Python File I/O", () => {
    it("should import custom modules", async () => {
      const result = (await callTool("execute_python", {
        code: `
import test_module
print(test_module.MESSAGE)
print(f"add(2, 3) = {test_module.add(2, 3)}")
print(f"multiply(4, 5) = {test_module.multiply(4, 5)}")
`,
      })) as { content: Array<{ text: string }> };

      const output = result.content[0].text;
      expect(output).toContain("Hello from test module!");
      expect(output).toContain("add(2, 3) = 5");
      expect(output).toContain("multiply(4, 5) = 20");
    });

    it("should perform file I/O from Python", async () => {
      const result = (await callTool("execute_python", {
        code: `
import json

# Read the config file we created
with open('data/config/settings.json') as f:
    config = json.load(f)

print(f"Debug: {config['debug']}")
print(f"Version: {config['version']}")

# Write a new file
with open('output.txt', 'w') as f:
    f.write("Generated from Python!\\n")
    f.write(f"Config version: {config['version']}")

print("File written successfully!")
`,
      })) as { content: Array<{ text: string }> };

      const output = result.content[0].text;
      expect(output).toContain("Debug: True");
      expect(output).toContain("Version: 1.0.0");
      expect(output).toContain("File written successfully");
    });

    it("should verify Python-written files", async () => {
      const result = (await callTool("read_file", {
        path: "output.txt",
      })) as { content: Array<{ text: string }> };

      const output = result.content[0].text;
      expect(output).toContain("Generated from Python!");
      expect(output).toContain("Config version: 1.0.0");
    });
  });

  describe("Package Management", () => {
    it("should install and use NumPy", async () => {
      // Install numpy
      const installResult = (await callTool("install_packages", {
        packages: ["numpy"],
      })) as { content: Array<{ text: string }> };

      const installOutput = installResult.content[0].text;
      expect(installOutput).toContain("numpy: ✓ installed");

      // Use numpy
      const execResult = (await callTool("execute_python", {
        code: `
import numpy as np
arr = np.array([1, 2, 3, 4, 5])
print(f"Array: {arr}")
print(f"Mean: {np.mean(arr)}")
print(f"Sum: {np.sum(arr)}")
print(f"Std: {np.std(arr):.2f}")
`,
      })) as { content: Array<{ text: string }> };

      const output = execResult.content[0].text;
      expect(output).toContain("Mean: 3.0");
      expect(output).toContain("Sum: 15");
    });

    it("should install and use Pandas", async () => {
      const installResult = (await callTool("install_packages", {
        packages: ["pandas"],
      })) as { content: Array<{ text: string }> };

      const installOutput = installResult.content[0].text;
      expect(installOutput).toContain("pandas");

      const execResult = (await callTool("execute_python", {
        code: `
import pandas as pd
data = {'name': ['Alice', 'Bob'], 'score': [85, 92]}
df = pd.DataFrame(data)
print(f"Names: {list(df['name'])}")
print(f"Mean: {df['score'].mean()}")
`,
      })) as { content: Array<{ text: string }> };

      const output = execResult.content[0].text;
      expect(output).toContain("Alice");
      expect(output).toMatch(/Mean:.*88/);
    });
  });

  describe("MCP Resources", () => {
    it("should read sandbox info resource", async () => {
      const resources = await client!.listResources();
      const infoResource = resources.resources.find((r) => r.uri === "sandbox://info");
      expect(infoResource).toBeDefined();

      const content = await client!.readResource({ uri: "sandbox://info" });
      const text = content.contents[0];
      expect("text" in text && text.text).toContain("Pyodide Sandbox");
    });

    it("should read workspace files resource", async () => {
      const content = await client!.readResource({ uri: "workspace://files" });
      const text = content.contents[0];
      expect("text" in text && text.text).toContain("test_module.py");
    });
  });

  describe("Security & Sandboxing", () => {
    it("should block network requests", async () => {
      const result = (await callTool("execute_python", {
        code: `
import urllib.request

try:
    # This should fail - Pyodide in WASM cannot make network requests
    response = urllib.request.urlopen("https://example.com", timeout=5)
    print(f"UNEXPECTED: Network request succeeded with status {response.status}")
except Exception as e:
    # Expected: network access fails in WASM sandbox
    print(f"EXPECTED: Network blocked - {type(e).__name__}: {str(e)[:100]}")
`,
      })) as { content: Array<{ text: string }> };

      const output = result.content[0].text;
      // Should fail with some error
      expect(output).toMatch(/EXPECTED: Network blocked|Error/);
      expect(output).not.toContain("UNEXPECTED");
    });
  });

  describe("Concurrent Operations", () => {
    it("should handle concurrent tool calls with micropip", async () => {
      const promises = [
        callTool("execute_python", {
          code: `import micropip; print("Call 1: micropip available")`,
        }),
        callTool("execute_python", {
          code: `import micropip; print("Call 2: micropip available")`,
        }),
        callTool("execute_python", {
          code: `import micropip; print("Call 3: micropip available")`,
        }),
      ];

      const results = (await Promise.all(promises)) as Array<{
        content: Array<{ text: string }>;
      }>;

      // All three should succeed - no "No module named 'micropip'" errors
      for (let i = 0; i < results.length; i++) {
        const output = results[i].content[0].text;
        expect(output).not.toContain("No module named 'micropip'");
        expect(output).toMatch(/micropip available|successfully/);
      }
    });
  });
});
