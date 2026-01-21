/**
 * Workspace Resources
 *
 * MCP resources for accessing workspace information and sandbox details
 */

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PyodideManager } from "../core/pyodide-manager.js";
import { WORKSPACE_DIR, VIRTUAL_WORKSPACE } from "../config/constants.js";

/**
 * Register workspace resources with the MCP server
 */
export function registerWorkspaceResources(server: McpServer, pyodideManager: PyodideManager) {
  // Workspace files list
  server.registerResource(
    "workspace-files",
    "workspace://files",
    {
      title: "Workspace Files",
      description: "List all files in the sandbox workspace",
      mimeType: "text/plain",
    },
    async () => {
      const result = await pyodideManager.listFiles("");

      let text: string;
      if (!result.success) {
        text = `Error: ${result.error}`;
      } else if (result.files.length === 0) {
        text = "Workspace is empty";
      } else {
        text =
          "# Workspace Files\n\n" +
          result.files
            .map((f) => {
              const icon = f.isDirectory ? "📁" : "📄";
              const size = f.isDirectory ? "" : ` (${f.size} bytes)`;
              return `- ${icon} ${f.name}${size}`;
            })
            .join("\n");
      }

      return {
        contents: [{ uri: "workspace://files", text }],
      };
    }
  );

  // Individual workspace file
  server.registerResource(
    "workspace-file",
    new ResourceTemplate("workspace://file/{path}", { list: undefined }),
    {
      title: "Workspace File Content",
      description: "Read a specific file from the workspace",
    },
    async (uri, { path: filePath }) => {
      const result = await pyodideManager.readFile(filePath as string);

      return {
        contents: [
          {
            uri: uri.href,
            text: result.success ? result.content! : `Error: ${result.error}`,
            mimeType: "text/plain",
          },
        ],
      };
    }
  );

  // Sandbox information
  server.registerResource(
    "sandbox-info",
    "sandbox://info",
    {
      title: "Sandbox Information",
      description: "Information about the Pyodide sandbox environment",
      mimeType: "text/markdown",
    },
    async () => {
      const info = `# Pyodide Sandbox Environment

## Workspace
- **Host path:** ${WORKSPACE_DIR}
- **Virtual path:** ${VIRTUAL_WORKSPACE}

## Capabilities
- ✅ Python code execution (WebAssembly sandbox)
- ✅ File system operations (read, write, list, delete)
- ✅ Package installation via micropip

## Standard Library
Most Python standard library modules are available:
- os, sys, io, pathlib
- json, csv, re
- math, random, statistics
- datetime, time
- collections, itertools, functools
- urllib, http (limited networking)

## Popular Packages Available
Install via \`install_packages\` tool:
- **Data Science:** numpy, pandas, scipy, scikit-learn
- **Visualization:** matplotlib, seaborn, plotly
- **Web/HTTP:** requests, beautifulsoup4, lxml
- **Text:** regex, nltk
- **Math:** sympy, statsmodels
- **Image:** pillow

## Limitations
- ❌ No native C extensions (unless compiled to WASM)
- ❌ Limited networking (no raw sockets)
- ❌ No multiprocessing/threading
- ❌ Memory limited by Node.js heap

See [Pyodide Packages](https://pyodide.org/en/stable/usage/packages-in-pyodide.html) for full list.
`;

      return {
        contents: [{ uri: "sandbox://info", text: info }],
      };
    }
  );
}
