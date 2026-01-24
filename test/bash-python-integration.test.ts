/**
 * Bash-Python Integration Tests
 *
 * Tests that verify bash and Python scripts can access the same files,
 * ensuring proper synchronization between BashManager (direct host FS)
 * and PyodideManager (Emscripten virtual FS).
 *
 * Run with: npm test -- test/bash-python-integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test workspace - use a dedicated directory for bash-python tests
const TEST_WORKSPACE = path.join(__dirname, "..", "test-workspace-bash-python");

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
  console.log("🚀 Starting MCP server for bash-python integration tests...");

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
  console.log("✓ Ready to run bash-python integration tests\n");
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

describe("Bash-Python File Integration", () => {
  describe("Bash → Python File Access", () => {
    it("should allow Python to read file created by bash", async () => {
      // Bash creates a file
      await callTool("execute_bash", {
        command: "echo 'Hello from bash!' > bash_created.txt",
      });

      // Python reads the file
      const pythonResult = (await callTool("execute_python", {
        code: `
with open('bash_created.txt', 'r') as f:
    content = f.read()
print(f"Python read: {content.strip()}")
`,
      })) as { content: Array<{ text: string }> };

      const output = pythonResult.content[0].text;
      expect(output).toContain("Python read: Hello from bash!");
    });

    it("should allow Python to read JSON file created by bash with jq", async () => {
      // Bash creates JSON using jq
      await callTool("execute_bash", {
        command: 'echo \'{"name":"Alice","age":30,"city":"NYC"}\' | jq . > user.json',
      });

      // Python parses the JSON
      const pythonResult = (await callTool("execute_python", {
        code: `
import json
with open('user.json', 'r') as f:
    data = json.load(f)
print(f"Name: {data['name']}")
print(f"Age: {data['age']}")
print(f"City: {data['city']}")
`,
      })) as { content: Array<{ text: string }> };

      const output = pythonResult.content[0].text;
      expect(output).toContain("Name: Alice");
      expect(output).toContain("Age: 30");
      expect(output).toContain("City: NYC");
    });

    it("should allow Python to read multi-line file created by bash", async () => {
      // Bash creates multi-line file
      await callTool("execute_bash", {
        command: "echo -e 'Line 1\\nLine 2\\nLine 3\\nLine 4\\nLine 5' > lines.txt",
      });

      // Python reads and counts lines
      const pythonResult = (await callTool("execute_python", {
        code: `
with open('lines.txt', 'r') as f:
    lines = f.readlines()
print(f"Total lines: {len(lines)}")
for i, line in enumerate(lines, 1):
    print(f"Line {i}: {line.strip()}")
`,
      })) as { content: Array<{ text: string }> };

      const output = pythonResult.content[0].text;
      expect(output).toContain("Total lines: 5");
      expect(output).toContain("Line 1: Line 1");
      expect(output).toContain("Line 5: Line 5");
    });

    it("should allow Python to process CSV created by bash", async () => {
      // Bash creates CSV file
      await callTool("execute_bash", {
        command: `cat > data.csv << 'EOF'
name,score,grade
Alice,95,A
Bob,87,B
Charlie,92,A
David,78,C
EOF`,
      });

      // Python processes CSV
      const pythonResult = (await callTool("execute_python", {
        code: `
import csv
with open('data.csv', 'r') as f:
    reader = csv.DictReader(f)
    students = list(reader)

print(f"Total students: {len(students)}")
a_students = [s for s in students if s['grade'] == 'A']
print(f"A students: {', '.join(s['name'] for s in a_students)}")

total_score = sum(int(s['score']) for s in students)
avg_score = total_score / len(students)
print(f"Average score: {avg_score:.1f}")
`,
      })) as { content: Array<{ text: string }> };

      const output = pythonResult.content[0].text;
      expect(output).toContain("Total students: 4");
      expect(output).toContain("A students: Alice, Charlie");
      expect(output).toContain("Average score: 88.0");
    });
  });

  describe("Python → Bash File Access", () => {
    it("should allow bash to read file created by Python", async () => {
      // Python creates a file
      const pythonResult = (await callTool("execute_python", {
        code: `
with open('python_created.txt', 'w') as f:
    f.write('Hello from Python!')
print("File created successfully")
`,
      })) as { content: Array<{ text: string }> };

      expect(pythonResult.content[0].text).toContain("File created successfully");

      // Bash reads the file
      const bashResult = (await callTool("execute_bash", {
        command: "cat python_created.txt",
      })) as { content: Array<{ text: string }> };

      expect(bashResult.content[0].text).toContain("Hello from Python!");
    });

    it("should allow bash to grep file created by Python", async () => {
      // Python creates file with multiple lines
      await callTool("execute_python", {
        code: `
content = '''apple
banana
cherry
date
elderberry
'''
with open('fruits.txt', 'w') as f:
    f.write(content)
`,
      });

      // Bash greps for pattern
      const bashResult = (await callTool("execute_bash", {
        command: "grep 'err' fruits.txt",
      })) as { content: Array<{ text: string }> };

      const output = bashResult.content[0].text;
      expect(output).toContain("cherry");
      expect(output).toContain("elderberry");
    });

    it("should allow bash to process JSON created by Python", async () => {
      // Python creates JSON
      await callTool("execute_python", {
        code: `
import json
data = {
    'project': 'MCP Server',
    'version': '1.0.0',
    'features': ['bash', 'python', 'filesystem']
}
with open('config.json', 'w') as f:
    json.dump(data, f, indent=2)
`,
      });

      // Bash uses jq to extract values
      const bashResult = (await callTool("execute_bash", {
        command: "cat config.json | jq -r '.project'",
      })) as { content: Array<{ text: string }> };

      expect(bashResult.content[0].text).toContain("MCP Server");
    });

    it("should allow bash to count lines in file created by Python", async () => {
      // Python creates multi-line file
      await callTool("execute_python", {
        code: `
with open('numbers.txt', 'w') as f:
    for i in range(1, 101):
        f.write(f"{i}\\n")
`,
      });

      // Bash counts lines
      const bashResult = (await callTool("execute_bash", {
        command: "wc -l numbers.txt",
      })) as { content: Array<{ text: string }> };

      expect(bashResult.content[0].text).toContain("100");
    });
  });

  describe("Alternating Modifications", () => {
    it("should handle bash and Python modifying the same file sequentially", async () => {
      // Bash creates initial file
      await callTool("execute_bash", {
        command: "echo 'Initial content from bash' > shared.txt",
      });

      // Python appends to it
      await callTool("execute_python", {
        code: `
with open('shared.txt', 'a') as f:
    f.write('\\nAppended by Python')
`,
      });

      // Bash appends again
      await callTool("execute_bash", {
        command: "echo 'Appended by bash again' >> shared.txt",
      });

      // Python reads final content
      const pythonResult = (await callTool("execute_python", {
        code: `
with open('shared.txt', 'r') as f:
    content = f.read()
print(content)
`,
      })) as { content: Array<{ text: string }> };

      const output = pythonResult.content[0].text;
      expect(output).toContain("Initial content from bash");
      expect(output).toContain("Appended by Python");
      expect(output).toContain("Appended by bash again");
    });

    it("should handle Python and bash processing data in pipeline", async () => {
      // Step 1: Bash creates raw data
      await callTool("execute_bash", {
        command: `cat > raw_data.txt << 'EOF'
100
200
300
400
500
EOF`,
      });

      // Step 2: Python processes and transforms
      await callTool("execute_python", {
        code: `
with open('raw_data.txt', 'r') as f:
    numbers = [int(line.strip()) for line in f if line.strip()]

# Calculate statistics
total = sum(numbers)
average = total / len(numbers)
maximum = max(numbers)
minimum = min(numbers)

# Write results
with open('stats.txt', 'w') as f:
    f.write(f"Total: {total}\\n")
    f.write(f"Average: {average}\\n")
    f.write(f"Max: {maximum}\\n")
    f.write(f"Min: {minimum}\\n")
`,
      });

      // Step 3: Bash reads and formats results
      const bashResult = (await callTool("execute_bash", {
        command: "cat stats.txt | grep 'Average'",
      })) as { content: Array<{ text: string }> };

      expect(bashResult.content[0].text).toContain("Average: 300");
    });

    it("should handle counter incrementation across both runtimes", async () => {
      // Bash initializes counter
      await callTool("execute_bash", {
        command: "echo '0' > counter.txt",
      });

      // Python increments
      await callTool("execute_python", {
        code: `
with open('counter.txt', 'r') as f:
    count = int(f.read().strip())
count += 1
with open('counter.txt', 'w') as f:
    f.write(str(count))
`,
      });

      // Bash increments
      await callTool("execute_bash", {
        command: "echo $(($(cat counter.txt) + 1)) > counter.txt",
      });

      // Python increments again
      await callTool("execute_python", {
        code: `
with open('counter.txt', 'r') as f:
    count = int(f.read().strip())
count += 1
with open('counter.txt', 'w') as f:
    f.write(str(count))
print(f"Final count: {count}")
`,
      });

      // Bash reads final value
      const bashResult = (await callTool("execute_bash", {
        command: "cat counter.txt",
      })) as { content: Array<{ text: string }> };

      expect(bashResult.content[0].text.trim()).toBe("3");
    });
  });

  describe("Complex Data Pipelines", () => {
    it("should handle bash generating CSV, Python analyzing it, bash formatting results", async () => {
      // Step 1: Bash generates sales data
      await callTool("execute_bash", {
        command: `cat > sales.csv << 'EOF'
product,quantity,price
Widget,10,25.50
Gadget,5,99.99
Doohickey,8,15.75
Thingamajig,12,45.00
Whatsit,3,150.00
EOF`,
      });

      // Step 2: Python analyzes the data
      const pythonResult = (await callTool("execute_python", {
        code:
          "import csv\n\n" +
          "with open('sales.csv', 'r') as f:\n" +
          "    reader = csv.DictReader(f)\n" +
          "    sales = list(reader)\n\n" +
          "# Calculate revenue for each product\n" +
          "results = []\n" +
          "for item in sales:\n" +
          "    product = item['product']\n" +
          "    quantity = int(item['quantity'])\n" +
          "    price = float(item['price'])\n" +
          "    revenue = quantity * price\n" +
          "    results.append({'product': product, 'revenue': revenue})\n\n" +
          "# Sort by revenue\n" +
          "results.sort(key=lambda x: x['revenue'], reverse=True)\n\n" +
          "# Write top products\n" +
          "with open('top_products.txt', 'w') as f:\n" +
          "    for i, item in enumerate(results, 1):\n" +
          "        f.write(f\"{i}. {item['product']}: ${item['revenue']:.2f}\\n\")\n\n" +
          "print('Analysis complete')\n",
      })) as { content: Array<{ text: string }> };

      expect(pythonResult.content[0].text).toContain("Analysis complete");

      // Step 3: Bash formats and displays top product
      const bashResult = (await callTool("execute_bash", {
        command: "head -n 1 top_products.txt",
      })) as { content: Array<{ text: string }> };

      // Thingamajig has highest revenue: 12 * $45 = $540
      expect(bashResult.content[0].text).toContain("Thingamajig: $540.00");
    });

    it("should handle log processing pipeline", async () => {
      // Step 1: Bash creates log file
      await callTool("execute_bash", {
        command: `cat > app.log << 'EOF'
2024-01-01 10:00:00 INFO Application started
2024-01-01 10:05:00 ERROR Database connection failed
2024-01-01 10:05:30 INFO Retrying connection
2024-01-01 10:05:45 INFO Database connected
2024-01-01 10:10:00 WARNING Memory usage high
2024-01-01 10:15:00 ERROR Timeout occurred
2024-01-01 10:20:00 INFO Request processed
2024-01-01 10:25:00 ERROR Invalid input
EOF`,
      });

      // Step 2: Bash extracts errors
      await callTool("execute_bash", {
        command: "grep 'ERROR' app.log > errors.log",
      });

      // Step 3: Python analyzes error patterns
      await callTool("execute_python", {
        code: `
with open('errors.log', 'r') as f:
    errors = f.readlines()

error_count = len(errors)
error_types = {}

for error in errors:
    # Extract error type (last part after ERROR)
    parts = error.split('ERROR')
    if len(parts) > 1:
        error_type = parts[1].strip().split()[0]
        error_types[error_type] = error_types.get(error_type, 0) + 1

with open('error_summary.txt', 'w') as f:
    f.write(f"Total Errors: {error_count}\\n")
    f.write("\\nError Types:\\n")
    for error_type, count in error_types.items():
        f.write(f"  {error_type}: {count}\\n")
`,
      });

      // Step 4: Bash displays summary
      const bashResult = (await callTool("execute_bash", {
        command: "cat error_summary.txt",
      })) as { content: Array<{ text: string }> };

      expect(bashResult.content[0].text).toContain("Total Errors: 3");
    });
  });

  describe("Nested Directory Operations", () => {
    it("should handle nested directories created by bash, used by Python", async () => {
      // Bash creates nested structure
      await callTool("execute_bash", {
        command: "mkdir -p data/input data/output data/temp",
      });

      await callTool("execute_bash", {
        command: "echo 'test data' > data/input/sample.txt",
      });

      // Python processes files in nested directories
      const pythonResult = (await callTool("execute_python", {
        code: `
import os

# Check directory structure
dirs = []
for root, directories, files in os.walk('data'):
    dirs.append(root)
    for file in files:
        filepath = os.path.join(root, file)
        print(f"Found: {filepath}")

print(f"Total directories: {len(dirs)}")

# Process input file and write to output
with open('data/input/sample.txt', 'r') as f:
    content = f.read()

with open('data/output/processed.txt', 'w') as f:
    f.write(content.upper())
`,
      })) as { content: Array<{ text: string }> };

      const output = pythonResult.content[0].text;
      expect(output).toContain("Found: data/input/sample.txt");
      expect(output).toContain("Total directories:");

      // Bash reads processed file
      const bashResult = (await callTool("execute_bash", {
        command: "cat data/output/processed.txt",
      })) as { content: Array<{ text: string }> };

      expect(bashResult.content[0].text).toContain("TEST DATA");
    });

    it("should handle Python creating nested dirs, bash navigating them", async () => {
      // Python creates nested structure
      await callTool("execute_python", {
        code: `
import os

# Create nested directories
os.makedirs('project/src/core', exist_ok=True)
os.makedirs('project/src/utils', exist_ok=True)
os.makedirs('project/tests', exist_ok=True)

# Create files
with open('project/src/core/main.py', 'w') as f:
    f.write('# Main module')

with open('project/src/utils/helpers.py', 'w') as f:
    f.write('# Helper functions')

with open('project/tests/test_main.py', 'w') as f:
    f.write('# Tests')

print("Project structure created")
`,
      });

      // Bash finds all Python files
      const bashResult = (await callTool("execute_bash", {
        command: "find project -name '*.py'",
      })) as { content: Array<{ text: string }> };

      const output = bashResult.content[0].text;
      expect(output).toContain("main.py");
      expect(output).toContain("helpers.py");
      expect(output).toContain("test_main.py");
    });
  });

  describe("Binary and Special Files", () => {
    it("should handle Python writing binary data, bash verifying it exists", async () => {
      // Python writes binary data
      await callTool("execute_python", {
        code: `
# Write some binary data
data = bytes([0x89, 0x50, 0x4E, 0x47])  # PNG header
with open('binary.dat', 'wb') as f:
    f.write(data)
print(f"Wrote {len(data)} bytes")
`,
      });

      // Bash checks file exists and size
      const bashResult = (await callTool("execute_bash", {
        command: "ls -la binary.dat | awk '{print $5}'",
      })) as { content: Array<{ text: string }> };

      expect(bashResult.content[0].text.trim()).toBe("4");
    });
  });

  describe("Error Handling", () => {
    it("should handle bash creating file, Python failing to parse, bash cleaning up", async () => {
      // Bash creates invalid JSON
      await callTool("execute_bash", {
        command: "echo 'not valid json{' > invalid.json",
      });

      // Python tries to parse and fails gracefully
      const pythonResult = (await callTool("execute_python", {
        code: `
import json
try:
    with open('invalid.json', 'r') as f:
        data = json.load(f)
    print("Unexpected success")
except json.JSONDecodeError as e:
    print(f"Expected error: {type(e).__name__}")
    # Write error log
    with open('error.log', 'w') as f:
        f.write(f"JSON parse error: {str(e)}\\n")
`,
      })) as { content: Array<{ text: string }> };

      expect(pythonResult.content[0].text).toContain("Expected error");

      // Bash checks error log and cleans up
      const bashResult = (await callTool("execute_bash", {
        command: "cat error.log && rm invalid.json error.log",
      })) as { content: Array<{ text: string }> };

      expect(bashResult.content[0].text).toContain("JSON parse error");
    });
  });
});
