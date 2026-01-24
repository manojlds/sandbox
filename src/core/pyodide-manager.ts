/**
 * PyodideManager - Handles Python runtime lifecycle
 *
 * This class manages the Pyodide WebAssembly Python runtime, including:
 * - Initialization and lifecycle management
 * - Virtual filesystem operations
 * - Host <-> Virtual filesystem synchronization
 * - Python code execution (via worker thread for timeout support)
 * - Package installation
 *
 * Code execution runs in a separate worker thread to enable true timeout
 * enforcement. If Python code blocks indefinitely (infinite loops, etc.),
 * the worker can be terminated to enforce the timeout.
 */

import { loadPyodide, PyodideInterface } from "pyodide";
import { Worker } from "worker_threads";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  WORKSPACE_DIR,
  VIRTUAL_WORKSPACE,
  MAX_FILE_SIZE,
  MAX_WORKSPACE_SIZE,
  PYTHON_EXECUTION_TIMEOUT_MS,
} from "../config/constants.js";
import type {
  ExecutionResult,
  FileReadResult,
  FileWriteResult,
  FileListResult,
  FileDeleteResult,
  PackageInstallResult,
} from "../types/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface WorkerExecuteResult {
  type: "result";
  success: boolean;
  stdout: string;
  stderr: string;
  result: string | null;
  error: string | null;
}

interface WorkerReadyMessage {
  type: "ready";
}

interface WorkerErrorMessage {
  type: "error";
  error: string;
}

type WorkerMessage = WorkerExecuteResult | WorkerReadyMessage | WorkerErrorMessage;

export class PyodideManager {
  private pyodide: PyodideInterface | null = null;
  private initialized = false;
  private initializationPromise: Promise<PyodideInterface> | null = null;
  private interruptBuffer: Int32Array | null = null;

  // Worker thread for code execution with timeout support
  private worker: Worker | null = null;
  private workerReady = false;
  private workerInitPromise: Promise<void> | null = null;

  /**
   * Convert a virtual path to a host filesystem path.
   */
  private virtualToHostPath(virtualPath: string): string {
    if (virtualPath === VIRTUAL_WORKSPACE) {
      return WORKSPACE_DIR;
    }

    if (virtualPath.startsWith(`${VIRTUAL_WORKSPACE}/`)) {
      return path.join(WORKSPACE_DIR, virtualPath.slice(VIRTUAL_WORKSPACE.length + 1));
    }

    return path.join(WORKSPACE_DIR, virtualPath);
  }

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
  private async getWorkspaceSize(): Promise<number> {
    try {
      await fs.promises.access(WORKSPACE_DIR);
    } catch {
      return 0;
    }

    let totalSize = 0;

    const calculateSize = async (dirPath: string): Promise<void> => {
      const items = await fs.promises.readdir(dirPath);
      for (const item of items) {
        const itemPath = path.join(dirPath, item);
        const stat = await fs.promises.stat(itemPath);
        if (stat.isDirectory()) {
          await calculateSize(itemPath);
        } else {
          totalSize += stat.size;
        }
      }
    };

    await calculateSize(WORKSPACE_DIR);
    return totalSize;
  }

  /**
   * Validate that writing a file won't exceed workspace size limit
   * @param fileSize - Size of file to be written
   * @throws Error if workspace size limit would be exceeded
   */
  private async checkWorkspaceSize(fileSize: number): Promise<void> {
    const currentSize = await this.getWorkspaceSize();
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

    // Set up interruption buffer for timeouts (SharedArrayBuffer is required)
    if (!this.interruptBuffer && typeof SharedArrayBuffer !== "undefined") {
      this.interruptBuffer = new Int32Array(new SharedArrayBuffer(4));
      this.pyodide.setInterruptBuffer(this.interruptBuffer);
    } else if (typeof SharedArrayBuffer === "undefined") {
      console.error(
        "[Heimdall] Warning: SharedArrayBuffer unavailable - Python execution timeout mechanism disabled"
      );
    }

    // Load micropip for package installation with proper error handling
    // Note: micropip loading may fail in some environments (restricted network, etc.)
    // We'll handle this gracefully and lazy-load when actually needed
    try {
      await this.pyodide.loadPackage("micropip");
      console.error("[Pyodide] micropip loaded successfully");

      // Verify micropip is actually available
      this.pyodide.pyimport("micropip");
      console.error("[Pyodide] micropip verified");
    } catch (error) {
      console.error("[Pyodide] Warning: micropip not available (will be loaded on-demand):", error);
      // Don't throw - we'll lazy-load micropip when package installation is requested
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
    await this.syncHostToVirtual();

    this.initialized = true;
    console.error("[Pyodide] Runtime initialized successfully");

    return this.pyodide;
  }

  /**
   * Sync files from host filesystem to Pyodide virtual FS
   */
  async syncHostToVirtual(
    hostPath = WORKSPACE_DIR,
    virtualPath = VIRTUAL_WORKSPACE
  ): Promise<void> {
    await this.syncHostPathToVirtual(hostPath, virtualPath);
  }

  /**
   * Sync a specific host file or directory into the virtual FS.
   */
  private async syncHostPathToVirtual(hostPath: string, virtualPath: string): Promise<void> {
    if (!this.pyodide) return;

    // Check if path exists asynchronously
    try {
      await fs.promises.access(hostPath);
    } catch {
      return;
    }

    const stat = await fs.promises.stat(hostPath);
    if (!stat.isDirectory()) {
      const parentDir = path.posix.dirname(virtualPath);
      if (parentDir && parentDir !== "/" && !parentDir.includes("..")) {
        try {
          this.pyodide.FS.mkdirTree(parentDir);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          if (!errorMsg.includes("exists") && !errorMsg.includes("EEXIST")) {
            console.error(`[Pyodide] Error creating directory ${parentDir}:`, error);
          }
        }
      }
      const content = await fs.promises.readFile(hostPath);
      this.pyodide.FS.writeFile(virtualPath, content);
      return;
    }

    const items = await fs.promises.readdir(hostPath);

    for (const item of items) {
      const hostItemPath = path.join(hostPath, item);
      const virtualItemPath = `${virtualPath}/${item}`;
      const itemStat = await fs.promises.stat(hostItemPath);

      if (itemStat.isDirectory()) {
        try {
          this.pyodide.FS.mkdirTree(virtualItemPath);
        } catch (error) {
          // Only ignore if directory already exists, log other errors
          const errorMsg = error instanceof Error ? error.message : String(error);
          if (!errorMsg.includes("exists") && !errorMsg.includes("EEXIST")) {
            console.error(`[Pyodide] Error creating directory ${virtualItemPath}:`, error);
          }
        }
        await this.syncHostPathToVirtual(hostItemPath, virtualItemPath);
      } else {
        const content = await fs.promises.readFile(hostItemPath);
        this.pyodide.FS.writeFile(virtualItemPath, content);
      }
    }
  }

  /**
   * Sync files from Pyodide virtual FS to host filesystem
   */
  async syncVirtualToHost(
    virtualPath = VIRTUAL_WORKSPACE,
    hostPath = WORKSPACE_DIR
  ): Promise<void> {
    await this.syncVirtualPathToHost(virtualPath, hostPath);
  }

  /**
   * Sync a specific virtual file or directory into the host filesystem.
   */
  private async syncVirtualPathToHost(virtualPath: string, hostPath: string): Promise<void> {
    if (!this.pyodide) return;

    let stat: { mode: number };
    try {
      stat = this.pyodide.FS.stat(virtualPath);
    } catch {
      return;
    }

    const isDir = this.pyodide.FS.isDir(stat.mode);
    if (!isDir) {
      const parentDir = path.dirname(hostPath);
      await fs.promises.mkdir(parentDir, { recursive: true });
      const content = this.pyodide.FS.readFile(virtualPath);
      await fs.promises.writeFile(hostPath, content);
      return;
    }

    await fs.promises.mkdir(hostPath, { recursive: true });

    let items: string[];
    try {
      items = this.pyodide.FS.readdir(virtualPath).filter((x: string) => x !== "." && x !== "..");
    } catch {
      return;
    }

    for (const item of items) {
      const virtualItemPath = `${virtualPath}/${item}`;
      const hostItemPath = path.join(hostPath, item);

      const itemStat = this.pyodide.FS.stat(virtualItemPath);
      const itemIsDir = this.pyodide.FS.isDir(itemStat.mode);

      if (itemIsDir) {
        await this.syncVirtualPathToHost(virtualItemPath, hostItemPath);
      } else {
        const content = this.pyodide.FS.readFile(virtualItemPath);
        await fs.promises.writeFile(hostItemPath, content);
      }
    }
  }

  /**
   * Initialize the worker thread for code execution
   */
  private async initializeWorker(): Promise<void> {
    if (this.workerReady && this.worker) {
      return;
    }

    if (this.workerInitPromise) {
      return this.workerInitPromise;
    }

    this.workerInitPromise = this.doInitializeWorker();

    try {
      await this.workerInitPromise;
    } catch (error) {
      this.workerInitPromise = null;
      throw error;
    }
  }

  private async doInitializeWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Get the worker file path from the dist folder (built JavaScript)
      // We use the compiled JS to avoid path resolution issues with tsx in workers
      const distDir = path.resolve(__dirname, "..", "..", "dist", "core");
      const workerJsPath = path.join(distDir, "pyodide-worker.js");

      // Fallback to TypeScript source if dist doesn't exist (dev mode)
      const srcDir = path.resolve(__dirname);
      const workerTsPath = path.join(srcDir, "pyodide-worker.ts");

      let workerPath: string;
      let execArgv: string[] = [];

      if (fs.existsSync(workerJsPath)) {
        workerPath = workerJsPath;
      } else if (fs.existsSync(workerTsPath)) {
        workerPath = workerTsPath;
        execArgv = ["--import", "tsx"];
      } else {
        reject(new Error(`Worker file not found at ${workerJsPath} or ${workerTsPath}`));
        return;
      }

      console.error(`[Heimdall] Starting worker thread from ${workerPath}...`);

      this.worker = new Worker(workerPath, {
        workerData: {
          workspaceDir: WORKSPACE_DIR,
          virtualWorkspace: VIRTUAL_WORKSPACE,
        },
        execArgv,
      });

      const initTimeout = setTimeout(() => {
        this.terminateWorker();
        reject(new Error("Worker initialization timed out"));
      }, 60000); // 60 second timeout for initialization (Pyodide loading is slow)

      this.worker.on("message", (message: WorkerMessage) => {
        if (message.type === "ready") {
          clearTimeout(initTimeout);
          this.workerReady = true;
          console.error("[Heimdall] Worker thread ready");
          resolve();
        } else if (message.type === "error") {
          clearTimeout(initTimeout);
          reject(new Error(message.error));
        }
      });

      this.worker.on("error", (error) => {
        clearTimeout(initTimeout);
        this.workerReady = false;
        reject(error);
      });

      this.worker.on("exit", (code) => {
        this.workerReady = false;
        this.worker = null;
        this.workerInitPromise = null;
        if (code !== 0) {
          console.error(`[Heimdall] Worker exited with code ${code}`);
        }
      });
    });
  }

  /**
   * Terminate the worker thread
   */
  private terminateWorker(): void {
    if (this.worker) {
      void this.worker.terminate();
      this.worker = null;
      this.workerReady = false;
      this.workerInitPromise = null;
    }
  }

  /**
   * Execute Python code in the sandbox using a worker thread
   *
   * Network access is NOT available - Pyodide runs in WebAssembly which
   * doesn't have network capabilities. This is by design for security.
   *
   * The code runs in a separate worker thread, enabling true timeout
   * enforcement. If the code doesn't complete within the timeout,
   * the worker is terminated.
   */
  async executeCode(code: string, packages: string[] = []): Promise<ExecutionResult> {
    // Initialize worker if needed
    await this.initializeWorker();

    if (!this.worker) {
      return {
        success: false,
        stdout: "",
        stderr: "",
        result: null,
        error: "Worker thread not available",
      };
    }

    return new Promise((resolve) => {
      let timeoutId: NodeJS.Timeout | null = null;
      let resolved = false;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };

      const handleMessage = (message: WorkerMessage) => {
        if (resolved) return;

        if (message.type === "result") {
          resolved = true;
          cleanup();
          this.worker?.off("message", handleMessage);
          resolve({
            success: message.success,
            stdout: message.stdout,
            stderr: message.stderr,
            result: message.result,
            error: message.error,
          });
        } else if (message.type === "error") {
          resolved = true;
          cleanup();
          this.worker?.off("message", handleMessage);
          resolve({
            success: false,
            stdout: "",
            stderr: "",
            result: null,
            error: message.error,
          });
        }
      };

      // Worker is guaranteed to be non-null here due to the check above
      const worker = this.worker!;
      worker.on("message", handleMessage);

      // Set up timeout
      if (PYTHON_EXECUTION_TIMEOUT_MS > 0) {
        timeoutId = setTimeout(() => {
          if (resolved) return;
          resolved = true;

          console.error(
            `[Heimdall] Python execution timed out after ${PYTHON_EXECUTION_TIMEOUT_MS}ms, terminating worker`
          );

          // Terminate the worker to stop the infinite loop
          this.terminateWorker();

          resolve({
            success: false,
            stdout: "",
            stderr: "",
            result: null,
            error: `Execution timed out after ${PYTHON_EXECUTION_TIMEOUT_MS}ms`,
          });
        }, PYTHON_EXECUTION_TIMEOUT_MS);
      }

      // Send execute message to worker
      worker.postMessage({
        type: "execute",
        code,
        packages,
      });
    });
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

      const fullPath = this.validatePath(filePath);
      const hostPath = this.virtualToHostPath(fullPath);
      await this.syncHostPathToVirtual(hostPath, fullPath);

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

      const fullPath = this.validatePath(filePath);
      const hostPath = this.virtualToHostPath(fullPath);

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
      await this.syncVirtualPathToHost(fullPath, hostPath);
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
      const fullPath = dirPath ? this.validatePath(dirPath) : VIRTUAL_WORKSPACE;
      const hostPath = this.virtualToHostPath(fullPath);
      await this.syncHostPathToVirtual(hostPath, fullPath);

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

      const fullPath = this.validatePath(filePath);
      const hostPath = this.virtualToHostPath(fullPath);
      await this.syncHostPathToVirtual(hostPath, fullPath);

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
      try {
        await fs.promises.access(hostPath);
        const hostStat = await fs.promises.stat(hostPath);
        if (hostStat.isDirectory()) {
          await fs.promises.rmdir(hostPath);
        } else {
          await fs.promises.unlink(hostPath);
        }
      } catch {
        // File doesn't exist on host, which is fine
      }

      return { success: true, error: null };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
