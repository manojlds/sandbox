/**
 * Bash Execution Tools
 *
 * Provides tools for executing bash commands in the sandboxed environment
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BashManager } from "../core/bash-manager.js";
import type { PyodideManager } from "../core/pyodide-manager.js";
import { z } from "zod";

/**
 * Register bash execution tools with the MCP server
 */
export function registerBashExecutionTools(
  server: McpServer,
  bashManager: BashManager,
  pyodideManager: PyodideManager
): void {
  server.registerTool(
    "execute_bash",
    {
      title: "Execute Bash",
      description: `Execute a bash command in the sandboxed environment.

Features:
- Supports 50+ built-in commands: grep, sed, awk, find, jq, curl, tar, etc.
- Pipes and redirections: |, >, >>, 2>, 2>&1
- Variables, loops, conditionals, and functions
- File operations: ls, cat, cp, mv, rm, mkdir, etc.
- Text processing: grep, sed, awk, cut, sort, uniq, wc, etc.
- Data tools: jq (JSON), sqlite3 (SQLite), xan (CSV), yq (YAML)
- Find and search: find, grep, rg (ripgrep)

The command runs with access to the /workspace directory. All file changes are immediately visible to Python code.

Security:
- No real processes spawned (TypeScript simulation)
- Execution limits prevent infinite loops
- Network access disabled by default
- Filesystem limited to workspace directory

Examples:
- Find files: "find . -name '*.py' -type f"
- Process text: "cat data.txt | grep 'pattern' | wc -l"
- JSON query: "cat data.json | jq '.users[] | {name, email}'"
- Multiple commands: "ls -la && cat README.md | head -10"`,
      inputSchema: {
        command: z.string().describe("The bash command to execute"),
        cwd: z
          .string()
          .optional()
          .describe("Working directory (relative to /workspace, e.g., 'subdir' or '.')"),
      },
    },
    async ({ command, cwd }) => {
      try {
        // Execute bash command
        const result = await bashManager.execute(command, { cwd });

        // Sync changes to Pyodide virtual filesystem
        // This ensures Python sees any file modifications made by bash
        await pyodideManager.syncHostToVirtual();

        // Combine stdout and stderr for output
        let output = "";
        if (result.stdout) {
          output += result.stdout;
        }
        if (result.stderr) {
          if (output) output += "\n";
          output += result.stderr;
        }

        // Return based on exit code
        if (result.exitCode === 0) {
          return {
            content: [
              {
                type: "text",
                text: output || "Command executed successfully (no output)",
              },
            ],
          };
        } else {
          // Non-zero exit code indicates failure
          return {
            content: [
              {
                type: "text",
                text: `Command failed with exit code ${result.exitCode}\n${output}`,
              },
            ],
            isError: true,
          };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Error executing bash command: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
