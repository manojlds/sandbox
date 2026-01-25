/**
 * Pyodide Worker - Runs Python code in a separate thread
 *
 * This worker enables true timeout enforcement for Python execution by
 * running Pyodide in a separate thread that can be terminated if it
 * exceeds the timeout limit.
 */

import { parentPort, workerData } from "worker_threads";
import { loadPyodide } from "pyodide";
import type { PyodideInterface } from "pyodide";
import * as fs from "fs";
import * as path from "path";

interface WorkerData {
  workspaceDir: string;
  virtualWorkspace: string;
}

interface ExecuteMessage {
  type: "execute";
  code: string;
  packages: string[];
}

interface ExecuteResult {
  type: "result";
  success: boolean;
  stdout: string;
  stderr: string;
  result: string | null;
  error: string | null;
}

interface ReadyMessage {
  type: "ready";
}

interface ErrorMessage {
  type: "error";
  error: string;
}

type WorkerMessage = ExecuteMessage;
type _WorkerResponse = ExecuteResult | ReadyMessage | ErrorMessage;

const { workspaceDir, virtualWorkspace } = workerData as WorkerData;

let pyodide: PyodideInterface | null = null;

/**
 * Resolve symlinks and validate that the real path is within the workspace.
 * This prevents symlink-based path traversal attacks.
 *
 * @param hostPath - The host filesystem path to validate
 * @throws Error if the resolved path escapes the workspace
 */
async function validateHostPathWithSymlinkResolution(hostPath: string): Promise<void> {
  try {
    const realPath = await fs.promises.realpath(hostPath);
    const realWorkspace = await fs.promises.realpath(workspaceDir);

    if (!realPath.startsWith(realWorkspace + path.sep) && realPath !== realWorkspace) {
      throw new Error(
        "Invalid path: Symlink points outside workspace. This is a security violation."
      );
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      await validateParentPathForSymlinks(hostPath);
    } else if ((e as Error).message?.includes("security violation")) {
      throw e;
    }
  }
}

/**
 * For files that don't exist yet, validate parent directories for symlinks.
 */
async function validateParentPathForSymlinks(hostPath: string): Promise<void> {
  let currentPath = path.dirname(hostPath);
  const realWorkspace = await fs.promises.realpath(workspaceDir);

  while (currentPath !== path.dirname(currentPath)) {
    try {
      const realPath = await fs.promises.realpath(currentPath);

      if (!realPath.startsWith(realWorkspace + path.sep) && realPath !== realWorkspace) {
        throw new Error(
          "Invalid path: Parent directory symlink points outside workspace. This is a security violation."
        );
      }
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        currentPath = path.dirname(currentPath);
      } else if ((e as Error).message?.includes("security violation")) {
        throw e;
      } else {
        return;
      }
    }
  }
}

/**
 * Sync files from host filesystem to Pyodide virtual FS
 */
async function syncHostToVirtual(
  py: PyodideInterface,
  hostPath: string,
  virtualPath: string
): Promise<void> {
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
        py.FS.mkdirTree(parentDir);
      } catch {
        // Directory might already exist
      }
    }
    const content = await fs.promises.readFile(hostPath);
    py.FS.writeFile(virtualPath, content);
    return;
  }

  try {
    py.FS.mkdirTree(virtualPath);
  } catch {
    // Directory might already exist
  }

  const items = await fs.promises.readdir(hostPath);
  for (const item of items) {
    const hostItemPath = path.join(hostPath, item);
    const virtualItemPath = `${virtualPath}/${item}`;
    await syncHostToVirtual(py, hostItemPath, virtualItemPath);
  }
}

/**
 * Sync files from Pyodide virtual FS to host filesystem.
 * Includes symlink protection to prevent writing outside workspace.
 */
async function syncVirtualToHost(
  py: PyodideInterface,
  virtualPath: string,
  hostPath: string
): Promise<void> {
  // SECURITY: Validate host path doesn't escape workspace via symlinks
  await validateHostPathWithSymlinkResolution(hostPath);

  let stat: { mode: number };
  try {
    stat = py.FS.stat(virtualPath);
  } catch {
    return;
  }

  const isDir = py.FS.isDir(stat.mode);
  if (!isDir) {
    const parentDir = path.dirname(hostPath);
    await fs.promises.mkdir(parentDir, { recursive: true });
    // Re-validate after mkdir
    await validateHostPathWithSymlinkResolution(hostPath);
    const content = py.FS.readFile(virtualPath);
    await fs.promises.writeFile(hostPath, content);
    return;
  }

  await fs.promises.mkdir(hostPath, { recursive: true });
  // Re-validate after mkdir
  await validateHostPathWithSymlinkResolution(hostPath);

  let items: string[];
  try {
    items = py.FS.readdir(virtualPath).filter((x: string) => x !== "." && x !== "..");
  } catch {
    return;
  }

  for (const item of items) {
    const virtualItemPath = `${virtualPath}/${item}`;
    const hostItemPath = path.join(hostPath, item);
    await syncVirtualToHost(py, virtualItemPath, hostItemPath);
  }
}

/**
 * Initialize Pyodide
 */
async function initializePyodide(): Promise<PyodideInterface> {
  const py = await loadPyodide({
    stdout: (text: string) => process.stdout.write(text),
    stderr: (text: string) => process.stderr.write(text),
  });

  // Create workspace directory in virtual filesystem
  py.FS.mkdirTree(virtualWorkspace);

  // Load micropip for package installation
  try {
    await py.loadPackage("micropip");
  } catch {
    // micropip may not be available in all environments
  }

  // Add workspace to Python path
  const escapedPath = virtualWorkspace.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  py.runPython(`
import sys
if '${escapedPath}' not in sys.path:
    sys.path.insert(0, '${escapedPath}')
`);

  return py;
}

/**
 * Execute Python code
 */
async function executeCode(
  py: PyodideInterface,
  code: string,
  packages: string[]
): Promise<ExecuteResult> {
  // Sync host files to virtual FS before execution
  await syncHostToVirtual(py, workspaceDir, virtualWorkspace);

  // Install requested packages
  if (packages.length > 0) {
    try {
      const micropip = py.pyimport("micropip");
      for (const pkg of packages) {
        try {
          await micropip.install(pkg);
        } catch {
          // Package installation may fail
        }
      }
    } catch {
      // micropip may not be available
    }
  }

  // Capture stdout and stderr
  const stdoutBuffer: string[] = [];
  const stderrBuffer: string[] = [];

  py.setStdout({
    batched: (text: string) => stdoutBuffer.push(text),
  });
  py.setStderr({
    batched: (text: string) => stderrBuffer.push(text),
  });

  try {
    // Set working directory
    const escapedPath = virtualWorkspace.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    py.runPython(`import os; os.chdir('${escapedPath}')`);

    // Auto-detect and load packages from imports
    await py.loadPackagesFromImports(code);

    // Run the code
    const result = await py.runPythonAsync(code);

    // Sync virtual FS back to host after execution
    await syncVirtualToHost(py, virtualWorkspace, workspaceDir);

    // Convert result to string
    let resultStr: string | null = null;
    if (result !== undefined && result !== null) {
      try {
        resultStr = py.runPython(`repr(${JSON.stringify(result)})`);
      } catch {
        resultStr = String(result);
      }
    }

    return {
      type: "result",
      success: true,
      stdout: stdoutBuffer.join(""),
      stderr: stderrBuffer.join(""),
      result: resultStr,
      error: null,
    };
  } catch (e) {
    // Sync even on error (code may have written files before failing)
    await syncVirtualToHost(py, virtualWorkspace, workspaceDir);

    const errorMessage = e instanceof Error ? e.message : String(e);

    return {
      type: "result",
      success: false,
      stdout: stdoutBuffer.join(""),
      stderr: stderrBuffer.join(""),
      result: null,
      error: errorMessage,
    };
  } finally {
    // Reset stdout/stderr
    py.setStdout({ batched: (text: string) => process.stdout.write(text + "\n") });
    py.setStderr({ batched: (text: string) => process.stderr.write(text + "\n") });
  }
}

/**
 * Main worker entry point
 */
async function main() {
  if (!parentPort) {
    throw new Error("This file must be run as a worker thread");
  }

  try {
    // Initialize Pyodide
    pyodide = await initializePyodide();

    // Signal that we're ready
    parentPort.postMessage({ type: "ready" } as ReadyMessage);

    // Listen for messages
    parentPort.on("message", (message: WorkerMessage) => {
      if (message.type === "execute") {
        // Handle async execution in a separate function to avoid promise issues
        void (async () => {
          try {
            const result = await executeCode(pyodide!, message.code, message.packages);
            parentPort!.postMessage(result);
          } catch (e) {
            parentPort!.postMessage({
              type: "error",
              error: e instanceof Error ? e.message : String(e),
            } as ErrorMessage);
          }
        })();
      }
    });
  } catch (e) {
    parentPort.postMessage({
      type: "error",
      error: `Worker initialization failed: ${e instanceof Error ? e.message : String(e)}`,
    } as ErrorMessage);
  }
}

main().catch((e) => {
  if (parentPort) {
    parentPort.postMessage({
      type: "error",
      error: `Worker crashed: ${e instanceof Error ? e.message : String(e)}`,
    } as ErrorMessage);
  }
});
