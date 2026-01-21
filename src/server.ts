#!/usr/bin/env node
/**
 * Pyodide Sandbox MCP Server
 *
 * A TypeScript MCP server providing sandboxed Python code execution
 * using Pyodide (Python compiled to WebAssembly).
 *
 * Features:
 * - Secure Python execution in WebAssembly sandbox
 * - Virtual filesystem with host sync
 * - Package installation via micropip
 * - Session persistence
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PyodideManager } from "./core/pyodide-manager.js";
import { registerAllTools } from "./tools/index.js";
import { registerAllResources } from "./resources/index.js";

/**
 * Main entry point
 */
async function main() {
  console.error("[MCP] Starting Pyodide Sandbox server...");

  // Create PyodideManager instance
  const pyodideManager = new PyodideManager();

  // Create MCP server
  const server = new McpServer({
    name: "pyodide-sandbox",
    version: "1.0.0",
  });

  // Register all tools and resources
  registerAllTools(server, pyodideManager);
  registerAllResources(server, pyodideManager);

  // Pre-initialize Pyodide (optional, improves first tool call latency)
  await pyodideManager.initialize();

  // Connect transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[MCP] Server connected and ready");
}

main().catch((error) => {
  console.error("[MCP] Fatal error:", error);
  process.exit(1);
});
