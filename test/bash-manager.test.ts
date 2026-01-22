/**
 * BashManager Integration Tests
 *
 * Tests for bash command execution and integration with Python
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BashManager } from "../src/core/bash-manager.js";
import { PyodideManager } from "../src/core/pyodide-manager.js";
import fs from "fs/promises";
import path from "path";

describe("BashManager Integration Tests", () => {
  let bashManager: BashManager;
  let pyodideManager: PyodideManager;
  const testWorkspace = path.resolve("./test-workspace-bash");

  beforeAll(async () => {
    // Create test workspace
    await fs.mkdir(testWorkspace, { recursive: true });

    // Initialize managers
    bashManager = new BashManager(testWorkspace);
    pyodideManager = new PyodideManager(testWorkspace);

    await bashManager.initialize();
    await pyodideManager.initialize();
  });

  afterAll(async () => {
    // Clean up test workspace
    await fs.rm(testWorkspace, { recursive: true, force: true });
  });

  describe("Basic Bash Commands", () => {
    it("should execute simple echo command", async () => {
      const result = await bashManager.execute("echo 'Hello, World!'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("Hello, World!");
      expect(result.stderr).toBe("");
    });

    it("should handle commands with no output", async () => {
      const result = await bashManager.execute("true");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    });

    it("should capture stderr output", async () => {
      const result = await bashManager.execute("echo 'error message' >&2");
      expect(result.exitCode).toBe(0);
      expect(result.stderr.trim()).toBe("error message");
    });

    it("should return non-zero exit code for failed commands", async () => {
      const result = await bashManager.execute("false");
      expect(result.exitCode).not.toBe(0);
    });

    it("should handle command not found", async () => {
      const result = await bashManager.execute("nonexistent_command");
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("File Operations", () => {
    it("should create files", async () => {
      const result = await bashManager.execute("echo 'test content' > test.txt");
      expect(result.exitCode).toBe(0);

      // Verify file was created on host filesystem
      const content = await fs.readFile(path.join(testWorkspace, "test.txt"), "utf-8");
      expect(content.trim()).toBe("test content");
    });

    it("should read files", async () => {
      await bashManager.execute("echo 'file content' > read_test.txt");
      const result = await bashManager.execute("cat read_test.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("file content");
    });

    it("should list files", async () => {
      await bashManager.execute("touch file1.txt file2.txt file3.txt");
      const result = await bashManager.execute("ls *.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("file1.txt");
      expect(result.stdout).toContain("file2.txt");
      expect(result.stdout).toContain("file3.txt");
    });

    it("should create directories", async () => {
      const result = await bashManager.execute("mkdir -p subdir/nested");
      expect(result.exitCode).toBe(0);

      // Verify directory was created
      const stat = await fs.stat(path.join(testWorkspace, "subdir/nested"));
      expect(stat.isDirectory()).toBe(true);
    });

    it("should copy files", async () => {
      await bashManager.execute("echo 'original' > original.txt");
      const result = await bashManager.execute("cp original.txt copy.txt");
      expect(result.exitCode).toBe(0);

      const content = await fs.readFile(path.join(testWorkspace, "copy.txt"), "utf-8");
      expect(content.trim()).toBe("original");
    });

    it("should move files", async () => {
      await bashManager.execute("echo 'move me' > move_source.txt");
      const result = await bashManager.execute("mv move_source.txt move_dest.txt");
      expect(result.exitCode).toBe(0);

      // Source should not exist
      await expect(fs.access(path.join(testWorkspace, "move_source.txt"))).rejects.toThrow();

      // Destination should exist
      const content = await fs.readFile(path.join(testWorkspace, "move_dest.txt"), "utf-8");
      expect(content.trim()).toBe("move me");
    });

    it("should delete files", async () => {
      await bashManager.execute("echo 'delete me' > delete_test.txt");
      const result = await bashManager.execute("rm delete_test.txt");
      expect(result.exitCode).toBe(0);

      // File should not exist
      await expect(fs.access(path.join(testWorkspace, "delete_test.txt"))).rejects.toThrow();
    });
  });

  describe("Pipes and Redirections", () => {
    it("should support pipes", async () => {
      await bashManager.execute("echo -e 'line1\\nline2\\nline3' > lines.txt");
      const result = await bashManager.execute("cat lines.txt | grep line2");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("line2");
    });

    it("should support output redirection", async () => {
      const result = await bashManager.execute("echo 'redirected' > redirect.txt");
      expect(result.exitCode).toBe(0);

      const content = await fs.readFile(path.join(testWorkspace, "redirect.txt"), "utf-8");
      expect(content.trim()).toBe("redirected");
    });

    it("should support append redirection", async () => {
      await bashManager.execute("echo 'line1' > append.txt");
      await bashManager.execute("echo 'line2' >> append.txt");
      const result = await bashManager.execute("cat append.txt");
      expect(result.stdout).toContain("line1");
      expect(result.stdout).toContain("line2");
    });

    it("should support command chaining with &&", async () => {
      const result = await bashManager.execute("echo 'first' && echo 'second'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("first");
      expect(result.stdout).toContain("second");
    });
  });

  describe("Text Processing", () => {
    it("should support grep", async () => {
      await bashManager.execute("echo -e 'apple\\nbanana\\ncherry' > fruits.txt");
      const result = await bashManager.execute("grep 'an' fruits.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("banana");
    });

    it("should support wc (word count)", async () => {
      await bashManager.execute("echo -e 'line 1\\nline 2\\nline 3' > count.txt");
      const result = await bashManager.execute("wc -l count.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("3");
    });

    it("should support sed", async () => {
      await bashManager.execute("echo 'hello world' > sed_test.txt");
      const result = await bashManager.execute("sed 's/world/universe/' sed_test.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello universe");
    });

    it("should support awk", async () => {
      await bashManager.execute("echo -e '1 2 3\\n4 5 6' > numbers.txt");
      const result = await bashManager.execute("awk '{print $2}' numbers.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("2");
      expect(result.stdout).toContain("5");
    });

    it("should support head", async () => {
      await bashManager.execute("echo -e 'line1\\nline2\\nline3\\nline4\\nline5' > head_test.txt");
      const result = await bashManager.execute("head -n 2 head_test.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("line1");
      expect(result.stdout).toContain("line2");
      expect(result.stdout).not.toContain("line3");
    });

    it("should support tail", async () => {
      await bashManager.execute("echo -e 'line1\\nline2\\nline3\\nline4\\nline5' > tail_test.txt");
      const result = await bashManager.execute("tail -n 2 tail_test.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("line4");
      expect(result.stdout).toContain("line5");
      expect(result.stdout).not.toContain("line1");
    });

    it("should support sort", async () => {
      await bashManager.execute("echo -e 'zebra\\napple\\nbanana' > sort_test.txt");
      const result = await bashManager.execute("sort sort_test.txt");
      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split("\n");
      expect(lines[0]).toBe("apple");
      expect(lines[1]).toBe("banana");
      expect(lines[2]).toBe("zebra");
    });
  });

  describe("JSON Processing with jq", () => {
    it("should process JSON with jq", async () => {
      await bashManager.execute('echo \'{"name":"Alice","age":30}\' > data.json');
      const result = await bashManager.execute("cat data.json | jq '.name'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('"Alice"');
    });

    it("should extract multiple fields with jq", async () => {
      await bashManager.execute(
        'echo \'[{"name":"Alice","age":30},{"name":"Bob","age":25}]\' > users.json'
      );
      const result = await bashManager.execute("cat users.json | jq '.[].name'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"Alice"');
      expect(result.stdout).toContain('"Bob"');
    });
  });

  describe("Find Command", () => {
    it("should find files by name", async () => {
      await bashManager.execute("mkdir -p findtest/sub1 findtest/sub2");
      await bashManager.execute(
        "touch findtest/file1.py findtest/sub1/file2.py findtest/sub2/file3.txt"
      );
      const result = await bashManager.execute("find findtest -name '*.py'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("file1.py");
      expect(result.stdout).toContain("file2.py");
      expect(result.stdout).not.toContain("file3.txt");
    });

    it("should find files by type", async () => {
      await bashManager.execute("mkdir -p typetest");
      await bashManager.execute("touch typetest/file.txt");
      await bashManager.execute("mkdir typetest/subdir");
      const result = await bashManager.execute("find typetest -type f");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("file.txt");
      expect(result.stdout).not.toContain("subdir");
    });
  });

  describe("Integration with Python", () => {
    it("should allow Python to read files created by bash", async () => {
      // Bash creates file
      await bashManager.execute("echo 'bash created this' > bash_file.txt");

      // Sync to Pyodide
      await pyodideManager.syncHostToVirtual();

      // Python reads file
      const code = `
with open('/workspace/bash_file.txt', 'r') as f:
    content = f.read()
print(content)
`;
      const result = await pyodideManager.executeCode(code);
      expect(result.success).toBe(true);
      expect(result.stdout?.trim()).toBe("bash created this");
    });

    it("should allow bash to read files created by Python", async () => {
      // Python creates file
      const code = `
with open('/workspace/python_file.txt', 'w') as f:
    f.write('python created this')
`;
      await pyodideManager.executeCode(code);
      await pyodideManager.syncVirtualToHost();

      // Bash reads file
      const result = await bashManager.execute("cat python_file.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("python created this");
    });

    it("should process Python output with bash", async () => {
      // Python creates data
      const code = `
with open('/workspace/numbers.txt', 'w') as f:
    for i in range(1, 11):
        f.write(f'{i}\\n')
`;
      await pyodideManager.executeCode(code);
      await pyodideManager.syncVirtualToHost();

      // Bash processes data
      const result = await bashManager.execute("wc -l numbers.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("10");
    });
  });

  describe("Execution Limits", () => {
    it("should prevent infinite loops", async () => {
      const result = await bashManager.execute("while true; do echo 'infinite'; done");
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("maxLoopIterations");
    });

    it("should prevent excessive command execution", async () => {
      // Create a script that exceeds command count limit
      const script = Array(11000).fill("echo x").join("; ");
      const result = await bashManager.execute(script);
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("Working Directory", () => {
    it("should respect cwd option", async () => {
      await bashManager.execute("mkdir -p testdir");
      await bashManager.execute("echo 'in root' > root.txt");
      await bashManager.execute("echo 'in subdir' > testdir/sub.txt");

      const result = await bashManager.execute("cat sub.txt", {
        cwd: "/testdir",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("in subdir");
    });
  });

  describe("Environment Variables", () => {
    it("should support custom environment variables", async () => {
      const result = await bashManager.execute("echo $MY_VAR", {
        env: { MY_VAR: "test_value" },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("test_value");
    });
  });
});
