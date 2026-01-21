/**
 * PyodideManager - Handles Python runtime lifecycle
 *
 * This class manages the Pyodide WebAssembly Python runtime, including:
 * - Initialization and lifecycle management
 * - Virtual filesystem operations
 * - Host <-> Virtual filesystem synchronization
 * - Python code execution
 * - Package installation
 */

import { loadPyodide, PyodideInterface } from "pyodide";
import * as fs from "fs";
import * as path from "path";
import { WORKSPACE_DIR, VIRTUAL_WORKSPACE, MAX_FILE_SIZE, MAX_WORKSPACE_SIZE } from "../config/constants.js";
import type {
  ExecutionResult,
  FileReadResult,
  FileWriteResult,
  FileListResult,
  FileDeleteResult,
  PackageInstallResult,
} from "../types/index.js";

export class PyodideManager {
  private pyodide: PyodideInterface | null = null;
  private initialized = false;
  private initializationPromise: Promise<PyodideInterface> | null = null;

  /**
   * Validate and normalize a file path to prevent directory traversal attacks
   * @param filePath - The file path to validate
   * @returns The normalized virtual filesystem path
   * @throws Error if path is invalid or attempts to escape workspace
   */
  private validatePath(filePath: string): string {
    // Convert to virtual path if not already absolute
    const fullPath = filePath.startsWith("/") ? filePath : `${VIRTUAL_WORKSPACE}/${filePath}`;

    // Normalize the path to resolve '..' and '.' segments
    const normalized = path.posix.normalize(fullPath);

    // Check if the normalized path is still within the workspace
    if (!normalized.startsWith(VIRTUAL_WORKSPACE + "/") && normalized !== VIRTUAL_WORKSPACE) {
      throw new Error(
        `Invalid path: Path traversal detected. Path must be within ${VIRTUAL_WORKSPACE}`
      );
    }

    // Additional check: reject paths containing '..' after normalization
    // (should be caught above, but defense in depth)
    if (normalized.includes("..")) {
      throw new Error("Invalid path: Path contains '..' after normalization");
    }

    return normalized;
  }

  /**
   * Calculate total workspace size from host filesystem
   * @returns Total size in bytes
   */
  private getWorkspaceSize(): number {
    if (!fs.existsSync(WORKSPACE_DIR)) {
      return 0;
    }

    let totalSize = 0;

    const calculateSize = (dirPath: string): void => {
      const items = fs.readdirSync(dirPath);
      for (const item of items) {
        const itemPath = path.join(dirPath, item);
        const stat = fs.statSync(itemPath);
        if (stat.isDirectory()) {
          calculateSize(itemPath);
        } else {
          totalSize += stat.size;
        }
      }
    };

    calculateSize(WORKSPACE_DIR);
    return totalSize;
  }

  /**
   * Validate that writing a file won't exceed workspace size limit
   * @param fileSize - Size of file to be written
   * @throws Error if workspace size limit would be exceeded
   */
  private async checkWorkspaceSize(fileSize: number): Promise<void> {
    const currentSize = this.getWorkspaceSize();
    if (currentSize + fileSize > MAX_WORKSPACE_SIZE) {
      throw new Error(
        `Workspace size limit exceeded. Current: ${(currentSize / 1024 / 1024).toFixed(2)}MB, ` +
          `Limit: ${(MAX_WORKSPACE_SIZE / 1024 / 1024).toFixed(2)}MB`
      );
    }
  }

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
      throw new Error(
        `Failed to load micropip: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Verify micropip is actually available
    try {
      this.pyodide.pyimport("micropip");
    } catch (error) {
      console.error("[Pyodide] micropip verification failed:", error);
      throw new Error(
        "micropip was loaded but cannot be imported. This may indicate a Pyodide installation issue."
      );
    }

    // Add workspace to Python path for imports
    // Escape the path to prevent code injection vulnerabilities
    const escapedWorkspacePath = VIRTUAL_WORKSPACE.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    this.pyodide.runPython(`
import sys
if '${escapedWorkspacePath}' not in sys.path:
    sys.path.insert(0, '${escapedWorkspacePath}')
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
          if (!errorMsg.includes("exists") && !errorMsg.includes("EEXIST")) {
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
      items = this.pyodide.FS.readdir(virtualPath).filter((x: string) => x !== "." && x !== "..");
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
  async executeCode(code: string, packages: string[] = []): Promise<ExecutionResult> {
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
      const escapedWorkspacePath = VIRTUAL_WORKSPACE.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      py.runPython(`import os; os.chdir('${escapedWorkspacePath}')`);

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
  async installPackages(packages: string[]): Promise<PackageInstallResult[]> {
    const py = await this.initialize();
    const micropip = py.pyimport("micropip");

    const results: PackageInstallResult[] = [];

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
  async readFile(filePath: string): Promise<FileReadResult> {
    try {
      const py = await this.initialize();
      this.syncHostToVirtual();

      const fullPath = this.validatePath(filePath);

      const content = py.FS.readFile(fullPath, { encoding: "utf8" });
      return { success: true, content, error: null };
    } catch (e) {
      return { success: false, content: null, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Write a file to the virtual filesystem
   */
  async writeFile(filePath: string, content: string): Promise<FileWriteResult> {
    try {
      const py = await this.initialize();
      this.syncHostToVirtual();

      const fullPath = this.validatePath(filePath);

      // Validate file size
      const fileSize = Buffer.byteLength(content, "utf8");
      if (fileSize > MAX_FILE_SIZE) {
        throw new Error(
          `File too large: ${(fileSize / 1024 / 1024).toFixed(2)}MB. ` +
            `Maximum allowed: ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(2)}MB`
        );
      }

      // Check workspace size limit
      await this.checkWorkspaceSize(fileSize);

      // Ensure parent directory exists
      const parentDir = path.posix.dirname(fullPath);
      if (parentDir && parentDir !== "/" && !parentDir.includes("..")) {
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
  async listFiles(dirPath = ""): Promise<FileListResult> {
    try {
      const py = await this.initialize();
      this.syncHostToVirtual();

      const fullPath = dirPath ? this.validatePath(dirPath) : VIRTUAL_WORKSPACE;

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
  async deleteFile(filePath: string): Promise<FileDeleteResult> {
    try {
      const py = await this.initialize();
      this.syncHostToVirtual();

      const fullPath = this.validatePath(filePath);
      const relativePath = fullPath.replace(VIRTUAL_WORKSPACE + "/", "");
      const hostPath = path.join(WORKSPACE_DIR, relativePath);

      // Validate the host path is within workspace directory
      const normalizedHostPath = path.normalize(hostPath);
      if (!normalizedHostPath.startsWith(path.normalize(WORKSPACE_DIR))) {
        throw new Error("Invalid path: Path traversal detected in host filesystem");
      }

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
