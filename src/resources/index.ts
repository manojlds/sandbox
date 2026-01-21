/**
 * Resources Registration
 *
 * Central module for registering all MCP resources
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PyodideManager } from "../core/pyodide-manager.js";
import { registerWorkspaceResources } from "./workspace.js";

/**
 * Register all resources with the MCP server
 */
export function registerAllResources(server: McpServer, pyodideManager: PyodideManager): void {
  registerWorkspaceResources(server, pyodideManager);
}
