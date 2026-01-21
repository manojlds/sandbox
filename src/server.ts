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

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadPyodide, PyodideInterface } from "pyodide";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// Get directory paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_DIR = process.env.PYODIDE_WORKSPACE || path.join(__dirname, "..", "workspace");
const VIRTUAL_WORKSPACE = "/workspace";

// Ensure workspace exists
if (!fs.existsSync(WORKSPACE_DIR)) {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

// =============================================================================
// Pyodide Manager - Handles Python runtime lifecycle
// =============================================================================

class PyodideManager {
  private pyodide: PyodideInterface | null = null;
  private initialized = false;
  private initializationPromise: Promise<PyodideInterface> | null = null;

  async initialize(): Promise<PyodideInterface> {
    // Return existing instance if already initialized
    if (this.pyodide && this.initialized) {
      return this.pyodide;
    }

    // Use promise-based singleton to prevent concurrent initialization race conditions
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this.doInitialize();
    
    try {
      return await this.initializationPromise;
    } catch (error) {
      // Reset on failure so retry is possible
      this.initializationPromise = null;
      throw error;
    }
  }

  private async doInitialize(): Promise<PyodideInterface> {
    console.error("[Pyodide] Loading runtime...");

    this.pyodide = await loadPyodide({
      stdout: (text: string) => process.stdout.write(text),
      stderr: (text: string) => process.stderr.write(text),
    });

    // Create workspace directory in virtual filesystem
    this.pyodide.FS.mkdirTree(VIRTUAL_WORKSPACE);

    // Load micropip for package installation with proper error handling
    try {
      await this.pyodide.loadPackage("micropip");
      console.error("[Pyodide] micropip loaded successfully");
    } catch (error) {
      console.error("[Pyodide] Failed to load micropip:", error);
      throw new Error(`Failed to load micropip: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Verify micropip is actually available
    try {
      this.pyodide.pyimport("micropip");
    } catch (error) {
      console.error("[Pyodide] micropip verification failed:", error);
      throw new Error("micropip was loaded but cannot be imported. This may indicate a Pyodide installation issue.");
    }

    // Add workspace to Python path for imports
    this.pyodide.runPython(`
import sys
if '${VIRTUAL_WORKSPACE}' not in sys.path:
    sys.path.insert(0, '${VIRTUAL_WORKSPACE}')
`);

    // Sync host workspace to virtual FS
    this.syncHostToVirtual();

    this.initialized = true;
    console.error("[Pyodide] Runtime initialized successfully");

    return this.pyodide;
  }

  /**
   * Sync files from host filesystem to Pyodide virtual FS
   */
  syncHostToVirtual(hostPath = WORKSPACE_DIR, virtualPath = VIRTUAL_WORKSPACE): void {
    if (!this.pyodide || !fs.existsSync(hostPath)) return;

    const items = fs.readdirSync(hostPath);

    for (const item of items) {
      const hostItemPath = path.join(hostPath, item);
      const virtualItemPath = `${virtualPath}/${item}`;
      const stat = fs.statSync(hostItemPath);

      if (stat.isDirectory()) {
        try {
          this.pyodide.FS.mkdirTree(virtualItemPath);
        } catch (error) {
          // Only ignore if directory already exists, log other errors
          const errorMsg = error instanceof Error ? error.message : String(error);
          if (!errorMsg.includes('exists') && !errorMsg.includes('EEXIST')) {
            console.error(`[Pyodide] Error creating directory ${virtualItemPath}:`, error);
          }
        }
        this.syncHostToVirtual(hostItemPath, virtualItemPath);
      } else {
        const content = fs.readFileSync(hostItemPath);
        this.pyodide.FS.writeFile(virtualItemPath, content);
      }
    }
  }

  /**
   * Sync files from Pyodide virtual FS to host filesystem
   */
  syncVirtualToHost(virtualPath = VIRTUAL_WORKSPACE, hostPath = WORKSPACE_DIR): void {
    if (!this.pyodide) return;

    if (!fs.existsSync(hostPath)) {
      fs.mkdirSync(hostPath, { recursive: true });
    }

    let items: string[];
    try {
      items = this.pyodide.FS.readdir(virtualPath).filter(
        (x: string) => x !== "." && x !== ".."
      );
    } catch {
      return;
    }

    for (const item of items) {
      const virtualItemPath = `${virtualPath}/${item}`;
      const hostItemPath = path.join(hostPath, item);

      const stat = this.pyodide.FS.stat(virtualItemPath);
      const isDir = this.pyodide.FS.isDir(stat.mode);

      if (isDir) {
        this.syncVirtualToHost(virtualItemPath, hostItemPath);
      } else {
        const content = this.pyodide.FS.readFile(virtualItemPath);
        fs.writeFileSync(hostItemPath, content);
      }
    }
  }

  /**
   * Execute Python code in the sandbox
   * 
   * Network access is NOT available - Pyodide runs in WebAssembly which
   * doesn't have network capabilities. This is by design for security.
   */
  async executeCode(
    code: string,
    packages: string[] = []
  ): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    result: string | null;
    error: string | null;
  }> {
    const py = await this.initialize();

    // Sync before execution
    this.syncHostToVirtual();

    // Install requested packages
    if (packages.length > 0) {
      const micropip = py.pyimport("micropip");
      for (const pkg of packages) {
        try {
          await micropip.install(pkg);
        } catch (e) {
          console.error(`[Pyodide] Failed to install ${pkg}:`, e);
        }
      }
    }

    // Capture stdout and stderr natively
    const stdoutBuffer: string[] = [];
    const stderrBuffer: string[] = [];

    py.setStdout({
      batched: (text: string) => stdoutBuffer.push(text),
    });
    py.setStderr({
      batched: (text: string) => stderrBuffer.push(text),
    });

    try {
      // Set working directory to workspace
      py.runPython(`import os; os.chdir('${VIRTUAL_WORKSPACE}')`);

      // Auto-detect and load packages from imports in the code
      await py.loadPackagesFromImports(code);

      // Run user code directly using runPythonAsync
      const result = await py.runPythonAsync(code);

      // Sync back to host after execution
      this.syncVirtualToHost();

      // Convert result to string representation if it exists
      let resultStr: string | null = null;
      if (result !== undefined && result !== null) {
        try {
          resultStr = py.runPython(`repr(${JSON.stringify(result)})`);
        } catch {
          resultStr = String(result);
        }
      }

      return {
        success: true,
        stdout: stdoutBuffer.join(""),
        stderr: stderrBuffer.join(""),
        result: resultStr,
        error: null,
      };
    } catch (e) {
      // Sync even on error (code may have written files before failing)
      this.syncVirtualToHost();

      let errorMessage: string;
      if (e instanceof Error) {
        errorMessage = e.message;
      } else {
        errorMessage = String(e);
      }

      return {
        success: false,
        stdout: stdoutBuffer.join(""),
        stderr: stderrBuffer.join(""),
        result: null,
        error: errorMessage,
      };
    } finally {
      // Reset stdout/stderr to defaults
      py.setStdout({ batched: (text: string) => process.stdout.write(text + "\n") });
      py.setStderr({ batched: (text: string) => process.stderr.write(text + "\n") });
    }
  }

  /**
   * Install packages via micropip
   */
  async installPackages(
    packages: string[]
  ): Promise<Array<{ package: string; success: boolean; error: string | null }>> {
    const py = await this.initialize();
    const micropip = py.pyimport("micropip");

    const results: Array<{ package: string; success: boolean; error: string | null }> = [];

    for (const pkg of packages) {
      try {
        await micropip.install(pkg);
        results.push({ package: pkg, success: true, error: null });
      } catch (e) {
        results.push({
          package: pkg,
          success: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return results;
  }

  /**
   * Read a file from the virtual filesystem
   */
  async readFile(filePath: string): Promise<{ success: boolean; content: string | null; error: string | null }> {
    const py = await this.initialize();
    this.syncHostToVirtual();

    const fullPath = filePath.startsWith("/") ? filePath : `${VIRTUAL_WORKSPACE}/${filePath}`;

    try {
      const content = py.FS.readFile(fullPath, { encoding: "utf8" });
      return { success: true, content, error: null };
    } catch (e) {
      return { success: false, content: null, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Write a file to the virtual filesystem
   */
  async writeFile(filePath: string, content: string): Promise<{ success: boolean; error: string | null }> {
    const py = await this.initialize();
    this.syncHostToVirtual();

    const fullPath = filePath.startsWith("/") ? filePath : `${VIRTUAL_WORKSPACE}/${filePath}`;

    try {
      // Ensure parent directory exists
      const parentDir = path.dirname(fullPath);
      if (parentDir && parentDir !== "/") {
        py.FS.mkdirTree(parentDir);
      }

      py.FS.writeFile(fullPath, content, { encoding: "utf8" });
      this.syncVirtualToHost();
      return { success: true, error: null };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * List files in a directory
   */
  async listFiles(
    dirPath = ""
  ): Promise<{
    success: boolean;
    files: Array<{ name: string; isDirectory: boolean; size: number }>;
    error: string | null;
  }> {
    const py = await this.initialize();
    this.syncHostToVirtual();

    const fullPath = dirPath
      ? dirPath.startsWith("/")
        ? dirPath
        : `${VIRTUAL_WORKSPACE}/${dirPath}`
      : VIRTUAL_WORKSPACE;

    try {
      const items = py.FS.readdir(fullPath).filter((x: string) => x !== "." && x !== "..");

      const files = items.map((item: string) => {
        const itemPath = `${fullPath}/${item}`;
        const stat = py.FS.stat(itemPath);
        return {
          name: item,
          isDirectory: py.FS.isDir(stat.mode),
          size: stat.size,
        };
      });

      return { success: true, files, error: null };
    } catch (e) {
      return { success: false, files: [], error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Delete a file or directory
   */
  async deleteFile(filePath: string): Promise<{ success: boolean; error: string | null }> {
    const py = await this.initialize();
    this.syncHostToVirtual();

    const fullPath = filePath.startsWith("/") ? filePath : `${VIRTUAL_WORKSPACE}/${filePath}`;
    const relativePath = filePath.startsWith("/") 
      ? filePath.replace(VIRTUAL_WORKSPACE + "/", "") 
      : filePath;
    const hostPath = path.join(WORKSPACE_DIR, relativePath);

    try {
      // Delete from virtual filesystem
      const stat = py.FS.stat(fullPath);
      if (py.FS.isDir(stat.mode)) {
        py.FS.rmdir(fullPath);
      } else {
        py.FS.unlink(fullPath);
      }

      // Also delete from host filesystem
      if (fs.existsSync(hostPath)) {
        const hostStat = fs.statSync(hostPath);
        if (hostStat.isDirectory()) {
          fs.rmdirSync(hostPath);
        } else {
          fs.unlinkSync(hostPath);
        }
      }

      return { success: true, error: null };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

// =============================================================================
// MCP Server Setup
// =============================================================================

const pyodideManager = new PyodideManager();

const server = new McpServer({
  name: "pyodide-sandbox",
  version: "1.0.0",
});

// =============================================================================
// Tools - Code Execution
// =============================================================================

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
        .describe("Optional additional packages to install (most are auto-detected from imports)"),
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

// =============================================================================
// Tools - File System
// =============================================================================

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

// =============================================================================
// Resources
// =============================================================================

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

// =============================================================================
// Server Entry Point
// =============================================================================

async function main() {
  console.error("[MCP] Starting Pyodide Sandbox server...");

  // Pre-initialize Pyodide (optional, improves first tool call latency)
  await pyodideManager.initialize();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[MCP] Server connected and ready");
}

main().catch((error) => {
  console.error("[MCP] Fatal error:", error);
  process.exit(1);
});

