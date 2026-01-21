/**
 * Python Execution Tools
 *
 * MCP tools for executing Python code and installing packages
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PyodideManager } from "../core/pyodide-manager.js";

/**
 * Register Python execution tools with the MCP server
 */
export function registerPythonExecutionTools(server: McpServer, pyodideManager: PyodideManager) {
  // Execute Python code
  server.registerTool(
    "execute_python",
    {
      title: "Execute Python",
      description: `Execute Python code in a sandboxed Pyodide environment.

The code runs in an isolated WebAssembly sandbox with:
- Access to /workspace directory for file I/O
- Standard library and auto-loaded packages
- stdout/stderr capture for output
- NO network access (WebAssembly security boundary)

Returns execution results including output and any errors.`,
      inputSchema: {
        code: z.string().describe("Python code to execute"),
        packages: z
          .array(z.string())
          .optional()
          .describe(
            "Optional additional packages to install (most are auto-detected from imports)"
          ),
      },
    },
    async ({ code, packages }) => {
      const result = await pyodideManager.executeCode(code, packages || []);

      const output = {
        success: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
        result: result.result,
        error: result.error,
      };

      let text = "";
      if (result.stdout) text += `Output:\n${result.stdout}\n`;
      if (result.stderr) text += `Stderr:\n${result.stderr}\n`;
      if (result.result) text += `Result: ${result.result}\n`;
      if (result.error) text += `Error:\n${result.error}\n`;
      if (!text) text = "Code executed successfully (no output)";

      return {
        content: [{ type: "text", text }],
        structuredContent: output,
      };
    }
  );

  // Install packages
  server.registerTool(
    "install_packages",
    {
      title: "Install Packages",
      description: `Install Python packages via micropip.

Note: Only pure Python packages or packages with WebAssembly wheels are supported.
Common data science packages like numpy, pandas, scipy are available.`,
      inputSchema: {
        packages: z.array(z.string()).describe("List of package names to install"),
      },
    },
    async ({ packages }) => {
      const results = await pyodideManager.installPackages(packages);

      const text = results
        .map((r) => `${r.package}: ${r.success ? "✓ installed" : `✗ ${r.error}`}`)
        .join("\n");

      return {
        content: [{ type: "text", text }],
        structuredContent: { results },
      };
    }
  );
}
