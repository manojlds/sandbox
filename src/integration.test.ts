/**
 * MCP Integration Tests for Pyodide Sandbox Server
 *
 * These tests spin up the MCP server and connect with a client
 * to verify all functionality works end-to-end.
 *
 * Run with: npm test
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import assert from "assert";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test workspace - use a temp directory to avoid conflicts
const TEST_WORKSPACE = path.join(__dirname, "..", "test-workspace");

// Colors for test output
const colors = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
};

function log(message: string, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logTest(name: string, passed: boolean, details?: string) {
  const icon = passed ? "✓" : "✗";
  const color = passed ? colors.green : colors.red;
  console.log(`  ${color}${icon} ${name}${colors.reset}`);
  if (details && !passed) {
    console.log(`    ${colors.yellow}${details}${colors.reset}`);
  }
}

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

class McpTestRunner {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private results: TestResult[] = [];

  /**
   * Start the MCP server and connect client
   */
  async setup(): Promise<void> {
    log("\n🚀 Starting MCP server...", colors.blue);

    // Clean up test workspace
    if (fs.existsSync(TEST_WORKSPACE)) {
      fs.rmSync(TEST_WORKSPACE, { recursive: true });
    }
    fs.mkdirSync(TEST_WORKSPACE, { recursive: true });

    // Spawn the server process
    const serverPath = path.join(__dirname, "server.ts");

    this.transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", serverPath],
      env: {
        ...process.env,
        PYODIDE_WORKSPACE: TEST_WORKSPACE,
      },
      cwd: path.join(__dirname, ".."),
    });

    this.client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} }
    );

    await this.client.connect(this.transport);
    log("✓ MCP client connected\n", colors.green);

    // Wait a bit for Pyodide to initialize
    log("⏳ Waiting for Pyodide initialization...", colors.yellow);
    await this.sleep(3000);
    log("✓ Ready to run tests\n", colors.green);
  }

  /**
   * Disconnect client and cleanup
   */
  async teardown(): Promise<void> {
    log("\n🧹 Cleaning up...", colors.blue);

    if (this.client) {
      await this.client.close();
    }

    if (this.transport) {
      await this.transport.close();
    }

    // Clean up test workspace
    if (fs.existsSync(TEST_WORKSPACE)) {
      fs.rmSync(TEST_WORKSPACE, { recursive: true });
    }

    log("✓ Cleanup complete", colors.green);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Call an MCP tool
   */
  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error("Client not connected");

    const result = await this.client.callTool({ name, arguments: args });
    return result;
  }

  /**
   * Run a single test
   */
  private async runTest(
    name: string,
    testFn: () => Promise<void>
  ): Promise<TestResult> {
    const start = Date.now();
    try {
      await testFn();
      const duration = Date.now() - start;
      logTest(name, true);
      return { name, passed: true, duration };
    } catch (e) {
      const duration = Date.now() - start;
      const error = e instanceof Error ? e.message : String(e);
      logTest(name, false, error);
      return { name, passed: false, error, duration };
    }
  }

  /**
   * Run all tests
   */
  async runAllTests(): Promise<void> {
    log(`${colors.bold}Running Integration Tests${colors.reset}\n`, colors.blue);

    // Test 1: Basic Python Execution
    this.results.push(
      await this.runTest("Basic Python execution", async () => {
        const result = await this.callTool("execute_python", {
          code: `
import sys
print(f"Python version: {sys.version_info.major}.{sys.version_info.minor}")
print("Hello from Pyodide!")
`,
        }) as { content: Array<{ text: string }> };

        const output = result.content[0].text;
        assert(output.includes("Python version: 3.12"), "Should show Python version");
        assert(output.includes("Hello from Pyodide!"), "Should print hello message");
      })
    );

    // Test 2: Math operations
    this.results.push(
      await this.runTest("Math operations", async () => {
        const result = await this.callTool("execute_python", {
          code: `
import math
print(f"Pi: {math.pi}")
print(f"factorial(5): {math.factorial(5)}")
`,
        }) as { content: Array<{ text: string }> };

        const output = result.content[0].text;
        assert(output.includes("Pi: 3.14159"), "Should calculate pi");
        assert(output.includes("factorial(5): 120"), "Should calculate factorial");
      })
    );

    // Test 3: Write file
    this.results.push(
      await this.runTest("Write file", async () => {
        const result = await this.callTool("write_file", {
          path: "test_module.py",
          content: `
def add(a, b):
    return a + b

def multiply(a, b):
    return a * b

MESSAGE = "Hello from test module!"
`,
        }) as { content: Array<{ text: string }> };

        const output = result.content[0].text;
        assert(output.includes("✓"), "Should succeed writing file");
      })
    );

    // Test 4: Read file
    this.results.push(
      await this.runTest("Read file", async () => {
        const result = await this.callTool("read_file", {
          path: "test_module.py",
        }) as { content: Array<{ text: string }> };

        const output = result.content[0].text;
        assert(output.includes("def add(a, b)"), "Should contain add function");
        assert(output.includes("MESSAGE"), "Should contain MESSAGE constant");
      })
    );

    // Test 5: List files
    this.results.push(
      await this.runTest("List files", async () => {
        const result = await this.callTool("list_files", {
          path: "",
        }) as { content: Array<{ text: string }> };

        const output = result.content[0].text;
        assert(output.includes("test_module.py"), "Should list test_module.py");
      })
    );

    // Test 6: Import custom module (tests sys.path fix)
    this.results.push(
      await this.runTest("Import custom module", async () => {
        const result = await this.callTool("execute_python", {
          code: `
import test_module
print(test_module.MESSAGE)
print(f"add(2, 3) = {test_module.add(2, 3)}")
print(f"multiply(4, 5) = {test_module.multiply(4, 5)}")
`,
        }) as { content: Array<{ text: string }> };

        const output = result.content[0].text;
        assert(output.includes("Hello from test module!"), "Should import MESSAGE");
        assert(output.includes("add(2, 3) = 5"), "Should call add function");
        assert(output.includes("multiply(4, 5) = 20"), "Should call multiply function");
      })
    );

    // Test 7: Create nested directory structure
    this.results.push(
      await this.runTest("Create nested directories", async () => {
        await this.callTool("write_file", {
          path: "data/config/settings.json",
          content: JSON.stringify({ debug: true, version: "1.0.0" }, null, 2),
        });

        const listResult = await this.callTool("list_files", {
          path: "data",
        }) as { content: Array<{ text: string }> };

        const output = listResult.content[0].text;
        assert(output.includes("config"), "Should have config directory");
      })
    );

    // Test 8: File I/O from Python
    this.results.push(
      await this.runTest("File I/O from Python", async () => {
        const result = await this.callTool("execute_python", {
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
        }) as { content: Array<{ text: string }> };

        const output = result.content[0].text;
        assert(output.includes("Debug: True"), "Should read debug setting");
        assert(output.includes("Version: 1.0.0"), "Should read version");
        assert(output.includes("File written successfully"), "Should write file");
      })
    );

    // Test 9: Verify Python-written file via MCP
    this.results.push(
      await this.runTest("Verify Python-written file", async () => {
        const result = await this.callTool("read_file", {
          path: "output.txt",
        }) as { content: Array<{ text: string }> };

        const output = result.content[0].text;
        assert(output.includes("Generated from Python!"), "Should contain generated content");
        assert(output.includes("Config version: 1.0.0"), "Should contain config version");
      })
    );

    // Test 10: Install and use package (numpy)
    this.results.push(
      await this.runTest("Install and use NumPy", async () => {
        // Install numpy
        const installResult = await this.callTool("install_packages", {
          packages: ["numpy"],
        }) as { content: Array<{ text: string }> };

        const installOutput = installResult.content[0].text;
        assert(installOutput.includes("numpy: ✓ installed"), "Should install numpy");

        // Use numpy
        const execResult = await this.callTool("execute_python", {
          code: `
import numpy as np
arr = np.array([1, 2, 3, 4, 5])
print(f"Array: {arr}")
print(f"Mean: {np.mean(arr)}")
print(f"Sum: {np.sum(arr)}")
print(f"Std: {np.std(arr):.2f}")
`,
        }) as { content: Array<{ text: string }> };

        const output = execResult.content[0].text;
        assert(output.includes("Mean: 3.0"), "Should calculate mean");
        assert(output.includes("Sum: 15"), "Should calculate sum");
      })
    );

    // Test 11: Install and use pandas
    this.results.push(
      await this.runTest("Install and use Pandas", async () => {
        const installResult = await this.callTool("install_packages", {
          packages: ["pandas"],
        }) as { content: Array<{ text: string }> };

        const installOutput = installResult.content[0].text;
        assert(installOutput.includes("pandas"), "Should show pandas in output");

        const execResult = await this.callTool("execute_python", {
          code: `
import pandas as pd
data = {'name': ['Alice', 'Bob'], 'score': [85, 92]}
df = pd.DataFrame(data)
print(f"Names: {list(df['name'])}")
print(f"Mean: {df['score'].mean()}")
`,
        }) as { content: Array<{ text: string }> };

        const output = execResult.content[0].text;
        assert(output.includes("Alice"), "Should have Alice in output");
        assert(output.includes("Mean:") && output.includes("88"), "Should calculate mean");
      })
    );

    // Test 12: Error handling
    this.results.push(
      await this.runTest("Error handling", async () => {
        const result = await this.callTool("execute_python", {
          code: `
x = 1 / 0  # This will raise ZeroDivisionError
`,
        }) as { content: Array<{ text: string }> };

        const output = result.content[0].text;
        assert(output.includes("ZeroDivisionError"), "Should catch division error");
      })
    );

    // Test 13: Delete file
    this.results.push(
      await this.runTest("Delete file", async () => {
        // Create a file specifically for this test
        await this.callTool("write_file", {
          path: "to_delete.txt",
          content: "This file will be deleted",
        });

        // Verify file exists
        const beforeList = await this.callTool("list_files", {
          path: "",
        }) as { content: Array<{ text: string }> };
        assert(beforeList.content[0].text.includes("to_delete.txt"), "File should exist before delete");

        // Delete file
        const deleteResult = await this.callTool("delete_file", {
          path: "to_delete.txt",
        }) as { content: Array<{ text: string }> };
        assert(deleteResult.content[0].text.includes("✓"), "Should delete successfully");

        // Small delay to ensure sync completes
        await this.sleep(100);

        // Verify file is gone
        const afterList = await this.callTool("list_files", {
          path: "",
        }) as { content: Array<{ text: string }> };
        assert(!afterList.content[0].text.includes("to_delete.txt"), "File should be deleted");
      })
    );

    // Test 14: Read resources
    this.results.push(
      await this.runTest("Read sandbox info resource", async () => {
        const resources = await this.client!.listResources();
        const infoResource = resources.resources.find(
          (r) => r.uri === "sandbox://info"
        );
        assert(infoResource, "Should have sandbox://info resource");

        const content = await this.client!.readResource({ uri: "sandbox://info" });
        const text = content.contents[0];
        assert("text" in text && text.text.includes("Pyodide Sandbox"), "Should contain sandbox info");
      })
    );

    // Test 15: List workspace resource
    this.results.push(
      await this.runTest("Read workspace files resource", async () => {
        const content = await this.client!.readResource({ uri: "workspace://files" });
        const text = content.contents[0];
        assert("text" in text && text.text.includes("test_module.py"), "Should list test_module.py");
      })
    );

    // Test 16: Network is always blocked (WASM security boundary)
    this.results.push(
      await this.runTest("Network requests always fail", async () => {
        const result = await this.callTool("execute_python", {
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
        }) as { content: Array<{ text: string }> };

        const output = result.content[0].text;
        // The request should fail with some error (URLError, OSError, etc.)
        // It should NOT succeed
        assert(
          output.includes("EXPECTED: Network blocked") || output.includes("Error"),
          "Network requests should fail in WASM sandbox"
        );
        assert(
          !output.includes("UNEXPECTED"),
          "Network request should not succeed"
        );
      })
    );

    // Test 17: Concurrent tool calls (regression test for race condition)
    this.results.push(
      await this.runTest("Concurrent tool calls with micropip", async () => {
        // Fire multiple concurrent requests that all use micropip
        const promises = [
          this.callTool("execute_python", {
            code: `import micropip; print("Call 1: micropip available")`,
          }),
          this.callTool("execute_python", {
            code: `import micropip; print("Call 2: micropip available")`,
          }),
          this.callTool("execute_python", {
            code: `import micropip; print("Call 3: micropip available")`,
          }),
        ];

        const results = await Promise.all(promises) as Array<{ content: Array<{ text: string }> }>;
        
        // All three should succeed - no "No module named 'micropip'" errors
        for (let i = 0; i < results.length; i++) {
          const output = results[i].content[0].text;
          // Check that it contains the expected output OR executed successfully
          const hasExpectedOutput = output.includes(`Call ${i + 1}: micropip available`);
          const executedSuccessfully = output.includes("micropip available") || output.includes("successfully");
          const hasMicropipError = output.includes("No module named 'micropip'");
          
          assert(
            !hasMicropipError,
            `Concurrent call ${i + 1} failed with micropip error: ${output}`
          );
          assert(
            hasExpectedOutput || executedSuccessfully || !output.includes("Error"),
            `Concurrent call ${i + 1} should succeed. Got: ${output.substring(0, 200)}`
          );
        }
      })
    );

    // Print summary
    this.printSummary();
  }

  /**
   * Print test summary
   */
  private printSummary(): void {
    const passed = this.results.filter((r) => r.passed).length;
    const failed = this.results.filter((r) => !r.passed).length;
    const total = this.results.length;
    const totalTime = this.results.reduce((sum, r) => sum + r.duration, 0);

    log("\n" + "=".repeat(50), colors.blue);
    log(`${colors.bold}Test Summary${colors.reset}`, colors.blue);
    log("=".repeat(50), colors.blue);

    log(`\nTotal: ${total} tests`, colors.reset);
    log(`Passed: ${passed}`, colors.green);
    if (failed > 0) {
      log(`Failed: ${failed}`, colors.red);
      log("\nFailed tests:", colors.red);
      this.results
        .filter((r) => !r.passed)
        .forEach((r) => {
          log(`  - ${r.name}: ${r.error}`, colors.red);
        });
    }
    log(`\nTotal time: ${(totalTime / 1000).toFixed(2)}s`, colors.yellow);

    if (failed === 0) {
      log("\n🎉 All tests passed!", colors.green);
    } else {
      log(`\n❌ ${failed} test(s) failed`, colors.red);
    }
  }
}

// Main entry point
async function main() {
  const runner = new McpTestRunner();

  try {
    await runner.setup();
    await runner.runAllTests();
  } catch (e) {
    log(`\n❌ Fatal error: ${e}`, colors.red);
    process.exit(1);
  } finally {
    await runner.teardown();
  }

  // Exit with appropriate code
  const failed = runner["results"].filter((r) => !r.passed).length;
  process.exit(failed > 0 ? 1 : 0);
}

main();

