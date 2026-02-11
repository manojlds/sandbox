/**
 * Bash Security Tests
 *
 * Tests for bash-specific attack vectors including command substitution,
 * heredoc/redirection attacks, network attempts, fork bombs, expansion
 * blowups, environment variable leakage, and file permission attacks.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_WORKSPACE = path.join(__dirname, "..", "test-workspace-bash-security");

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

describe("Bash Security", () => {
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
      { name: "bash-security-test-client", version: "1.0.0" },
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

    if (transport) {
      await transport.close();
    }

    if (fs.existsSync(TEST_WORKSPACE)) {
      fs.rmSync(TEST_WORKSPACE, { recursive: true });
    }
  });

  describe("Command Substitution / Eval Bypass Attempts", () => {
    it("should block eval cat /etc/passwd", async () => {
      const result = await callTool("execute_bash", {
        command: "eval 'cat /etc/passwd'",
      });
      const output = result.content[0].text;
      expect(output).not.toContain("root:");
    }, 30000);

    it("should block variable-based path to /etc/passwd", async () => {
      const result = await callTool("execute_bash", {
        command: "x=/etc/passwd; cat $x",
      });
      const output = result.content[0].text;
      expect(output).not.toContain("root:");
    }, 30000);

    it("should block command substitution to read /etc/passwd", async () => {
      const result = await callTool("execute_bash", {
        command: "cat $(echo /etc/passwd)",
      });
      const output = result.content[0].text;
      expect(output).not.toContain("root:");
    }, 30000);
  });

  describe("Heredoc / Redirection Attacks", () => {
    it("should block writing to /etc/evil", async () => {
      const result = await callTool("execute_bash", {
        command: "echo 'HACKED' > /etc/evil",
      });
      const output = result.content[0].text;
      const fileExists = fs.existsSync("/etc/evil");
      expect(fileExists).toBe(false);
      expect(result.isError === true || !output.includes("HACKED")).toBe(true);
    }, 30000);

    it("should block writing via path traversal ../../evil.txt", async () => {
      const result = await callTool("execute_bash", {
        command: "echo 'HACKED' > ../../evil.txt",
      });
      const evilPath = path.resolve(TEST_WORKSPACE, "..", "..", "evil.txt");
      const fileExists = fs.existsSync(evilPath);
      expect(fileExists).toBe(false);
    }, 30000);

    it("should block heredoc redirect to /tmp/evil.txt", async () => {
      const result = await callTool("execute_bash", {
        command: "cat > /tmp/evil.txt <<EOF\nMALICIOUS\nEOF",
      });
      const fileExists = fs.existsSync("/tmp/evil.txt");
      expect(fileExists).toBe(false);
    }, 30000);
  });

  describe("Network Attempts", () => {
    it("should block curl", async () => {
      const result = await callTool("execute_bash", {
        command: "curl https://example.com",
      });
      const output = result.content[0].text;
      expect(
        result.isError === true ||
          output.includes("fail") ||
          output.includes("error") ||
          output.includes("not found") ||
          output.includes("Command failed")
      ).toBe(true);
    }, 30000);

    it("should block wget", async () => {
      const result = await callTool("execute_bash", {
        command: "wget https://example.com",
      });
      const output = result.content[0].text;
      expect(
        result.isError === true ||
          output.includes("fail") ||
          output.includes("error") ||
          output.includes("not found") ||
          output.includes("Command failed")
      ).toBe(true);
    }, 30000);

    it("should block ping", async () => {
      const result = await callTool("execute_bash", {
        command: "ping -c 1 8.8.8.8",
      });
      const output = result.content[0].text;
      expect(
        result.isError === true ||
          output.includes("fail") ||
          output.includes("error") ||
          output.includes("not found") ||
          output.includes("Command failed")
      ).toBe(true);
    }, 30000);
  });

  describe("Recursive / Fork Bomb Constructs", () => {
    it("should stop recursive function", async () => {
      const result = await callTool("execute_bash", {
        command: "f(){ f; }; f",
      });
      const output = result.content[0].text;
      expect(
        result.isError === true || /callDepth|maxCallDepth|limit|recursion|failed/i.test(output)
      ).toBe(true);
    }, 30000);

    it("should stop deeply nested function calls", async () => {
      const result = await callTool("execute_bash", {
        command: "a(){ b; }; b(){ a; }; a",
      });
      const output = result.content[0].text;
      expect(
        result.isError === true || /callDepth|maxCallDepth|limit|recursion|fail/i.test(output)
      ).toBe(true);
    }, 30000);

    it("should limit large loop iterations", async () => {
      const result = await callTool("execute_bash", {
        command: "i=0; while [ $i -lt 100000 ]; do echo $i; i=$((i+1)); done",
      });
      const output = result.content[0].text;
      expect(
        result.isError === true || /maxLoopIterations|maxCommandCount|limit|fail/i.test(output)
      ).toBe(true);
    }, 30000);
  });

  describe("Globbing / Expansion Blowups", () => {
    it("should handle brace expansion without crashing", async () => {
      const result = await callTool("execute_bash", {
        command: "echo {1..10000}",
      });
      const output = result.content[0].text;
      expect(
        result.isError === true || /limit|fail|error/i.test(output) || output.length < 1000000
      ).toBe(true);
    }, 30000);

    it("should handle combinatorial brace expansion without crashing", async () => {
      const result = await callTool("execute_bash", {
        command: "echo {a..z}{a..z}{a..z}",
      });
      const output = result.content[0].text;
      expect(
        result.isError === true || /limit|fail|error/i.test(output) || output.length < 10000000
      ).toBe(true);
    }, 30000);
  });

  describe("Environment Variable Leakage via Bash", () => {
    const realHome = process.env.HOME || "";
    const realUser = process.env.USER || process.env.USERNAME || "";

    it("should not expose host environment via env", async () => {
      const result = await callTool("execute_bash", {
        command: "env",
      });
      const output = result.content[0].text;
      if (realHome) {
        expect(output).not.toContain(realHome);
      }
      if (realUser) {
        expect(output).not.toContain(`USER=${realUser}`);
      }
    }, 30000);

    it("should not expose host environment via printenv", async () => {
      const result = await callTool("execute_bash", {
        command: "printenv",
      });
      const output = result.content[0].text;
      if (realHome) {
        expect(output).not.toContain(realHome);
      }
      if (realUser) {
        expect(output).not.toContain(`USER=${realUser}`);
      }
    }, 30000);

    it("should not expose real HOME", async () => {
      const result = await callTool("execute_bash", {
        command: "echo $HOME",
      });
      const output = result.content[0].text.trim();
      if (realHome) {
        expect(output).not.toBe(realHome);
      }
    }, 30000);

    it("should not expose real PATH", async () => {
      const result = await callTool("execute_bash", {
        command: "echo $PATH",
      });
      const output = result.content[0].text.trim();
      if (process.env.PATH) {
        expect(output).not.toBe(process.env.PATH);
      }
    }, 30000);
  });

  describe("File Permission Attacks", () => {
    it("should block chmod on /etc/passwd", async () => {
      const result = await callTool("execute_bash", {
        command: "chmod 777 /etc/passwd",
      });
      const output = result.content[0].text;
      expect(result.isError === true || /fail|error|denied|not found/i.test(output)).toBe(true);
    }, 30000);

    it("should block chmod via path traversal", async () => {
      const result = await callTool("execute_bash", {
        command: "chmod 777 ../../something",
      });
      const output = result.content[0].text;
      expect(result.isError === true || /fail|error|denied|not found/i.test(output)).toBe(true);
    }, 30000);
  });

  describe("Recovery / Server Health", () => {
    it("should still execute bash after attacks", async () => {
      const result = await callTool("execute_bash", {
        command: 'echo "healthy"',
      });
      const output = result.content[0].text;
      expect(output).toContain("healthy");
      expect(result.isError).toBeFalsy();
    }, 30000);

    it("should still execute python after attacks", async () => {
      const result = await callTool("execute_python", {
        code: 'print("healthy")',
      });
      const output = result.content[0].text;
      expect(output).toContain("healthy");
      expect(result.isError).toBeFalsy();
    }, 30000);
  });
});
