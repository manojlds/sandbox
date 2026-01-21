/**
 * Filesystem Tools
 *
 * MCP tools for file system operations in the sandbox workspace
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PyodideManager } from "../core/pyodide-manager.js";

/**
 * Register filesystem tools with the MCP server
 */
export function registerFilesystemTools(server: McpServer, pyodideManager: PyodideManager) {
  // Write file
  server.registerTool(
    "write_file",
    {
      title: "Write File",
      description: `Write content to a file in the sandbox workspace.

Creates parent directories automatically. Files persist between executions.`,
      inputSchema: {
        path: z.string().describe("File path relative to workspace"),
        content: z.string().describe("Content to write"),
      },
    },
    async ({ path: filePath, content }) => {
      const result = await pyodideManager.writeFile(filePath, content);

      return {
        content: [
          {
            type: "text",
            text: result.success ? `✓ Written to ${filePath}` : `✗ Error: ${result.error}`,
          },
        ],
        structuredContent: result,
      };
    }
  );

  // Read file
  server.registerTool(
    "read_file",
    {
      title: "Read File",
      description: "Read content from a file in the sandbox workspace.",
      inputSchema: {
        path: z.string().describe("File path relative to workspace"),
      },
    },
    async ({ path: filePath }) => {
      const result = await pyodideManager.readFile(filePath);

      return {
        content: [
          {
            type: "text",
            text: result.success ? result.content! : `Error: ${result.error}`,
          },
        ],
        structuredContent: result,
      };
    }
  );

  // List files
  server.registerTool(
    "list_files",
    {
      title: "List Files",
      description: "List files and directories in the sandbox workspace.",
      inputSchema: {
        path: z.string().optional().describe("Directory path (empty for workspace root)"),
      },
    },
    async ({ path: dirPath }) => {
      const result = await pyodideManager.listFiles(dirPath || "");

      let text: string;
      if (result.success) {
        if (result.files.length === 0) {
          text = "Directory is empty";
        } else {
          text = result.files
            .map((f) => {
              const icon = f.isDirectory ? "📁" : "📄";
              const size = f.isDirectory ? "" : ` (${f.size} bytes)`;
              return `${icon} ${f.name}${size}`;
            })
            .join("\n");
        }
      } else {
        text = `Error: ${result.error}`;
      }

      return {
        content: [{ type: "text", text }],
        structuredContent: result,
      };
    }
  );

  // Delete file
  server.registerTool(
    "delete_file",
    {
      title: "Delete File",
      description: "Delete a file or empty directory from the sandbox workspace.",
      inputSchema: {
        path: z.string().describe("File or directory path"),
      },
    },
    async ({ path: filePath }) => {
      const result = await pyodideManager.deleteFile(filePath);

      return {
        content: [
          {
            type: "text",
            text: result.success ? `✓ Deleted ${filePath}` : `✗ Error: ${result.error}`,
          },
        ],
        structuredContent: result,
      };
    }
  );
}
