# Code Improvements & Technical Debt

This document tracks identified areas for improvement in the Pyodide Sandbox MCP Server codebase. Items are organized by priority and category, with implementation status tracked.

**Last Updated:** 2026-01-21
**Progress:** 7 High Priority Issues Fixed, 31 Improvements Pending

---

## 🔴 Critical Issues (Security & Stability)

### 1. ✅ Silent Error Handling
**Status:** FIXED
**Location:** `src/core/pyodide-manager.ts:194-200`

**Issue:** Silent error catching can hide real problems.

**Resolution:** Fixed to only ignore specific "file exists" errors and log all others:
```typescript
} catch (error) {
  const errorMsg = error instanceof Error ? error.message : String(error);
  if (!errorMsg.includes("exists") && !errorMsg.includes("EEXIST")) {
    console.error(`[Pyodide] Error creating directory ${virtualItemPath}:`, error);
  }
}
```

---

### 2. ✅ Path Injection Vulnerability
**Status:** FIXED
**Location:** `src/core/pyodide-manager.ts:163-168, 280-281`

**Issue:** String interpolation in Python code could allow code injection.

**Resolution:** Added proper path escaping:
```typescript
const escapedWorkspacePath = VIRTUAL_WORKSPACE.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
this.pyodide.runPython(`
import sys
if '${escapedWorkspacePath}' not in sys.path:
    sys.path.insert(0, '${escapedWorkspacePath}')
`);
```

---

### 3. ✅ Path Traversal Protection
**Status:** FIXED
**Location:** `src/core/pyodide-manager.ts:41-62`

**Resolution:** Comprehensive path validation prevents directory traversal:
- Uses `path.posix.normalize()` to resolve `..' and '.' segments
- Validates paths stay within workspace
- Rejects paths containing '..' after normalization
- Applied to all file operations

---

### 4. ✅ File Size Limits
**Status:** FIXED
**Location:** `src/core/pyodide-manager.ts:387-393`

**Resolution:** Added size limits to prevent OOM:
- Single file limit: 10MB (MAX_FILE_SIZE)
- Total workspace limit: 100MB (MAX_WORKSPACE_SIZE)
- Checked before all write operations

---

### 5. ✅ Workspace Size Limit
**Status:** FIXED
**Location:** `src/core/pyodide-manager.ts:68-105`

**Resolution:** Workspace size tracking implemented:
- `getWorkspaceSize()` recursively calculates total size
- `checkWorkspaceSize()` validates before writes
- Prevents workspace from exceeding 100MB

---

### 6. ✅ Server Process Leak in Tests
**Status:** FIXED
**Location:** `src/integration.test.ts:53-114`

**Resolution:** Properly captures and cleans up transport in test teardown.

---

## 🟡 High Priority (Performance & Reliability)

### 7. ✅ Synchronous File Operations
**Status:** FIXED
**Priority:** High
**Location:** `src/core/pyodide-manager.ts:182-241, 68-105`

**Issue:** Using synchronous fs operations blocks the event loop during workspace syncing.

**Resolution:** Converted all synchronous file operations to async:
- `syncHostToVirtual()` - Now uses `fs.promises.readdir()`, `fs.promises.stat()`, `fs.promises.readFile()`
- `syncVirtualToHost()` - Now uses `fs.promises.mkdir()`, `fs.promises.writeFile()`
- `getWorkspaceSize()` - Now async, uses `fs.promises.readdir()` and `fs.promises.stat()`
- All callers updated to properly await the async operations

**Testing:** Added comprehensive unit tests in `test/pyodide-manager.test.ts` covering:
- Async operations don't block event loop
- Large workspace performance
- Concurrent file operations
- Nested directory traversal
- Edge cases (empty/non-existent directories)

**Benefits:**
- Event loop no longer blocked during workspace syncing
- Improved performance with large workspaces
- Better concurrency for file operations
- All operations properly awaited

---

### 8. ⏳ Redundant Workspace Syncs
**Status:** Pending
**Priority:** High
**Location:** `src/core/pyodide-manager.ts:252, 289, 365, 382, 418, 446`

**Issue:** Every operation syncs the entire workspace bidirectionally, even for single file operations.

**Impact:** Performance overhead grows linearly with workspace size. A 100MB workspace syncs fully on every operation.

**Recommendation:** Implement targeted sync or make sync optional:
```typescript
// Option 1: Targeted sync for single file operations
async writeFile(filePath: string, content: string, sync = true): Promise<FileWriteResult> {
  // ... validation ...

  if (sync) {
    // Only sync the specific file, not entire workspace
    const hostPath = this.virtualToHostPath(fullPath);
    await fs.promises.writeFile(hostPath, content);
  }
}

// Option 2: Lazy sync with dirty tracking
private dirtyFiles = new Set<string>();

async executeCode(code: string, packages: string[] = []): Promise<ExecutionResult> {
  await this.syncDirtyFiles(); // Only sync changed files
  // ... execute ...
  this.markWorkspaceDirty();
  await this.syncDirtyFiles();
}
```

**Effort:** Medium-High (4-6 hours)

---

### 9. ⏳ No Execution Timeout
**Status:** Pending
**Priority:** High
**Location:** `src/core/pyodide-manager.ts:249-332`

**Issue:** Python code can run indefinitely with no timeout mechanism.

**Impact:** Infinite loops or long-running computations can hang the server.

**Recommendation:** Add configurable timeout:
```typescript
async executeCode(
  code: string,
  packages: string[] = [],
  timeoutMs = 30000
): Promise<ExecutionResult> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Execution timeout after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    const result = await Promise.race([
      this.doExecuteCode(code, packages),
      timeoutPromise
    ]);
    return result;
  } catch (e) {
    if (e instanceof Error && e.message.includes('timeout')) {
      return {
        success: false,
        stdout: '',
        stderr: '',
        result: null,
        error: `Execution timeout: code ran longer than ${timeoutMs}ms`
      };
    }
    throw e;
  }
}
```

**Effort:** Low-Medium (2-3 hours)

---

### 10. ⏳ No Package Installation Caching
**Status:** Pending
**Priority:** Medium-High
**Location:** `src/core/pyodide-manager.ts:256-265, 337-357`

**Issue:** Package installation results aren't cached; same package may be installed multiple times.

**Impact:** Wastes time and network bandwidth reinstalling packages.

**Recommendation:** Track installed packages:
```typescript
private installedPackages = new Set<string>();

async installPackages(packages: string[]): Promise<PackageInstallResult[]> {
  const py = await this.initialize();
  const micropip = py.pyimport("micropip");
  const results: PackageInstallResult[] = [];

  for (const pkg of packages) {
    // Skip if already installed
    if (this.installedPackages.has(pkg)) {
      results.push({
        package: pkg,
        success: true,
        error: null,
        cached: true
      });
      continue;
    }

    try {
      await micropip.install(pkg);
      this.installedPackages.add(pkg);
      results.push({ package: pkg, success: true, error: null, cached: false });
    } catch (e) {
      results.push({
        package: pkg,
        success: false,
        error: e instanceof Error ? e.message : String(e),
        cached: false
      });
    }
  }

  return results;
}
```

**Effort:** Low (1-2 hours)

---

### 11. ⏳ Workspace Size Calculation Inefficiency
**Status:** Pending
**Priority:** Medium
**Location:** `src/core/pyodide-manager.ts:68-89, 97-105`

**Issue:** `getWorkspaceSize()` recursively scans entire workspace on every write operation.

**Impact:** O(n) filesystem operations on every file write, where n = total files in workspace.

**Recommendation:** Cache workspace size and update incrementally:
```typescript
private cachedWorkspaceSize = 0;
private workspaceSizeDirty = true;

private getWorkspaceSize(): number {
  if (!this.workspaceSizeDirty) {
    return this.cachedWorkspaceSize;
  }

  // Recalculate only when dirty
  this.cachedWorkspaceSize = this.calculateWorkspaceSize();
  this.workspaceSizeDirty = false;
  return this.cachedWorkspaceSize;
}

async writeFile(filePath: string, content: string): Promise<FileWriteResult> {
  const fileSize = Buffer.byteLength(content, 'utf8');

  // Check if file already exists to get accurate size delta
  const existingSize = this.getFileSize(filePath);
  const sizeDelta = fileSize - existingSize;

  await this.checkWorkspaceSize(sizeDelta);

  // ... write file ...

  // Update cached size incrementally
  this.cachedWorkspaceSize += sizeDelta;
}
```

**Effort:** Medium (3-4 hours)

---

### 12. ⏳ No Resource Cleanup Method
**Status:** Pending
**Priority:** Medium
**Location:** `src/core/pyodide-manager.ts:30-481`

**Issue:** PyodideManager has no explicit cleanup/destroy method.

**Impact:** Resources may not be properly released when server shuts down.

**Recommendation:** Add cleanup method:
```typescript
async cleanup(): Promise<void> {
  console.error('[Pyodide] Cleaning up resources...');

  if (this.pyodide) {
    // Sync any pending changes
    this.syncVirtualToHost();

    // Clear references to allow garbage collection
    this.pyodide = null;
    this.initialized = false;
    this.initializationPromise = null;
    this.installedPackages?.clear();
  }

  console.error('[Pyodide] Cleanup complete');
}

// Call from server shutdown
process.on('SIGTERM', async () => {
  await pyodideManager.cleanup();
  process.exit(0);
});
```

**Effort:** Low (1-2 hours)

---

### 13. ⏳ No Graceful Shutdown Handling
**Status:** Pending
**Priority:** Medium
**Location:** `src/server.ts:24-53`

**Issue:** Server doesn't handle SIGTERM/SIGINT signals for graceful shutdown.

**Impact:** Abrupt termination may lose in-flight operations or leave corrupted state.

**Recommendation:** Add signal handlers:
```typescript
async function main() {
  // ... existing setup ...

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.error(`[MCP] Received ${signal}, shutting down gracefully...`);

    await pyodideManager.cleanup();
    await server.close();

    console.error('[MCP] Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
```

**Effort:** Low (1 hour)

---

### 14. ⏳ Result Repr Bug
**Status:** Pending
**Priority:** Medium
**Location:** `src/core/pyodide-manager.ts:293-299`

**Issue:** Attempting to `repr()` a JavaScript value instead of Python value.

```typescript
// Current (incorrect)
try {
  resultStr = py.runPython(`repr(${JSON.stringify(result)})`);
} catch {
  resultStr = String(result);
}
```

**Impact:** repr() call will likely fail, always falling back to String(result).

**Recommendation:** Convert to Python object first or use Python's string representation:
```typescript
// Option 1: Use __repr__ method
if (result && typeof result === 'object' && '__repr__' in result) {
  resultStr = result.__repr__();
} else {
  resultStr = String(result);
}

// Option 2: Convert to Python and repr
try {
  const pyResult = py.toPy(result);
  resultStr = py.runPython(`repr(x)`, { x: pyResult });
  pyResult.destroy();
} catch {
  resultStr = String(result);
}
```

**Effort:** Low (30 minutes)

---

## 🧪 Testing Improvements

### 15. ⏳ Hard-coded Test Delays
**Status:** Pending
**Priority:** Medium
**Location:** `src/integration.test.ts:90, 407`

**Issue:** Hard-coded `sleep()` calls make tests slow and potentially flaky.

**Current:**
```typescript
await this.sleep(3000); // Wait for Pyodide initialization
await this.sleep(100);  // Wait for sync to complete
```

**Recommendation:** Implement polling with timeout:
```typescript
async waitForReady(timeoutMs = 10000): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      // Try a simple operation to check if ready
      await this.callTool('list_files', { path: '' });
      return; // Success
    } catch (e) {
      await this.sleep(100);
    }
  }

  throw new Error(`Server not ready after ${timeoutMs}ms`);
}

async waitForFileOperation(filePath: string, shouldExist: boolean): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < 5000) {
    const files = await this.callTool('list_files', { path: '' });
    const exists = files.content[0].text.includes(filePath);

    if (exists === shouldExist) {
      return;
    }

    await this.sleep(50);
  }

  throw new Error(`File ${filePath} ${shouldExist ? 'not found' : 'still exists'}`);
}
```

**Effort:** Low-Medium (2 hours)

---

### 16. ⏳ Test Interdependence
**Status:** Pending
**Priority:** Medium
**Location:** `src/integration.test.ts:234-251`

**Issue:** Tests share state. Test #6 (Import custom module) depends on test #3 (Write file) creating `test_module.py`.

**Impact:** Tests cannot run independently; failures cascade.

**Recommendation:** Make each test self-contained:
```typescript
// Option 1: Setup/teardown hooks
beforeEach(async () => {
  // Clean workspace
  const files = await this.callTool('list_files', { path: '' });
  // Delete all files
});

// Option 2: Test-specific setup
await this.runTest("Import custom module", async () => {
  // Create the module file in this test
  await this.callTool('write_file', {
    path: 'test_module.py',
    content: `def add(a, b): return a + b`
  });

  // Now test importing it
  const result = await this.callTool('execute_python', {
    code: `import test_module; print(test_module.add(2, 3))`
  });

  assert(result.content[0].text.includes('5'));
});
```

**Effort:** Medium (3 hours)

---

### 17. ⏳ Missing Unit Tests
**Status:** Pending
**Priority:** Medium
**Location:** Test infrastructure exists, but only integration tests are implemented

**Issue:** Only integration tests exist. Individual modules lack unit tests.

**Recommendation:** Add unit tests for PyodideManager methods:
```typescript
// test/unit/pyodide-manager.test.ts
import { describe, it, expect } from 'vitest';
import { PyodideManager } from '../../src/core/pyodide-manager';

describe('PyodideManager', () => {
  describe('validatePath', () => {
    it('should accept valid paths', () => {
      const manager = new PyodideManager();
      expect(() => manager['validatePath']('file.txt')).not.toThrow();
      expect(() => manager['validatePath']('/workspace/file.txt')).not.toThrow();
    });

    it('should reject path traversal attempts', () => {
      const manager = new PyodideManager();
      expect(() => manager['validatePath']('../etc/passwd')).toThrow('Path traversal');
      expect(() => manager['validatePath']('/workspace/../etc/passwd')).toThrow();
    });
  });

  describe('getWorkspaceSize', () => {
    it('should return 0 for empty workspace', () => {
      const manager = new PyodideManager();
      expect(manager['getWorkspaceSize']()).toBe(0);
    });
  });
});
```

**Effort:** High (8-12 hours for comprehensive coverage)

---

### 18. ⏳ Weak Type Assertions in Tests
**Status:** Pending
**Priority:** Low-Medium
**Location:** `src/integration.test.ts:163, 180, etc.`

**Issue:** Type casting bypasses type safety.

```typescript
const result = (await this.callTool(...)) as { content: Array<{ text: string }> };
```

**Recommendation:** Define proper interfaces and runtime validation:
```typescript
import { z } from 'zod';

const ToolResultSchema = z.object({
  content: z.array(z.object({
    type: z.literal('text'),
    text: z.string()
  })),
  structuredContent: z.unknown().optional()
});

type ToolResult = z.infer<typeof ToolResultSchema>;

async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const result = await this.client!.callTool({ name, arguments: args });
  return ToolResultSchema.parse(result);
}
```

**Effort:** Low-Medium (2-3 hours)

---

### 19. ⏳ No Timeout Tests
**Status:** Pending
**Priority:** Low
**Location:** Test coverage gap

**Issue:** Tests don't verify timeout behavior for long-running code.

**Recommendation:** Add timeout tests once timeout feature is implemented:
```typescript
await this.runTest("Code execution timeout", async () => {
  const result = await this.callTool("execute_python", {
    code: `
import time
# This will timeout
while True:
    time.sleep(0.1)
`,
    timeout: 1000  // 1 second timeout
  });

  assert(result.error?.includes('timeout'), 'Should timeout infinite loop');
});
```

**Effort:** Low (1 hour) - depends on #9

---

### 20. ⏳ Better Test Assertions
**Status:** Pending
**Priority:** Low
**Location:** `src/integration.test.ts` throughout

**Issue:** Generic assertion messages make debugging failures difficult.

**Current:**
```typescript
assert(output.includes("Python version: 3.12"), "Should show Python version");
```

**Recommendation:** Include actual values in assertions:
```typescript
assert(
  output.includes("Python version: 3.12"),
  `Expected Python 3.12 in output, got: ${output.substring(0, 200)}`
);
```

**Effort:** Low (1-2 hours)

---

### 21. ⏳ No Test Coverage Tracking
**Status:** Pending
**Priority:** Low-Medium
**Location:** CI pipeline (`.github/workflows/ci.yml`)

**Issue:** CI doesn't track or report test coverage.

**Recommendation:** Add coverage reporting:
```yaml
# .github/workflows/ci.yml
- name: Run tests with coverage
  run: npm run test:coverage

- name: Upload coverage to Codecov
  uses: codecov/codecov-action@v4
  with:
    file: ./coverage/lcov.info
    fail_ci_if_error: true
```

**Effort:** Low (1 hour)

---

## 📚 Documentation & Code Quality

### 22. ⏳ Inconsistent Error Formatting
**Status:** Pending
**Priority:** Low-Medium
**Location:** Various methods return different error formats

**Issue:** Error responses have inconsistent structure across different operations.

**Current:**
- `executeCode`: `{ success, error }`
- `readFile`: `{ success, content, error }`
- Tool responses: Plain text messages

**Recommendation:** Standardize error responses:
```typescript
interface OperationResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// Usage
async executeCode(...): Promise<OperationResult<ExecutionData>> {
  try {
    return {
      success: true,
      data: { stdout, stderr, result }
    };
  } catch (e) {
    return {
      success: false,
      error: {
        code: 'EXECUTION_FAILED',
        message: e.message,
        details: { stdout, stderr }
      }
    };
  }
}
```

**Effort:** Medium (4-6 hours across all methods)

---

### 23. ⏳ Missing JSDoc for Public APIs
**Status:** Pending
**Priority:** Low-Medium
**Location:** Various public methods lack comprehensive documentation

**Issue:** Some methods have basic comments but lack comprehensive JSDoc.

**Recommendation:** Add comprehensive JSDoc:
```typescript
/**
 * Execute Python code in the Pyodide sandbox.
 *
 * The code runs in an isolated WebAssembly environment with access to the
 * virtual workspace filesystem at /workspace.
 *
 * @param code - The Python code to execute
 * @param packages - Optional packages to install before execution (auto-detected from imports)
 * @returns Execution results including stdout, stderr, result, and errors
 * @throws {Error} If Pyodide initialization fails
 *
 * @example
 * ```typescript
 * const result = await manager.executeCode('print("Hello")', ['numpy']);
 * console.log(result.stdout); // "Hello\n"
 * ```
 *
 * @remarks
 * - Network access is NOT available (WebAssembly security boundary)
 * - Code execution has no timeout by default
 * - Workspace is synced before and after execution
 */
async executeCode(code: string, packages: string[] = []): Promise<ExecutionResult>
```

**Effort:** Medium (4-6 hours)

---

### 24. ⏳ No ADR (Architecture Decision Records)
**Status:** Pending
**Priority:** Low
**Location:** Missing `docs/adr/` directory

**Issue:** Key architectural decisions aren't documented.

**Recommendation:** Create ADRs for major decisions:
```markdown
# docs/adr/001-pyodide-over-subprocess.md

# ADR-001: Use Pyodide Instead of Subprocess Python

## Status
Accepted

## Context
Need to provide Python execution in an MCP server. Options:
1. Subprocess to system Python
2. Pyodide (Python in WebAssembly)
3. Docker containers

## Decision
Use Pyodide for Python execution.

## Consequences
**Positive:**
- True sandboxing via WebAssembly
- No system Python dependency
- Cross-platform compatibility
- Memory isolation

**Negative:**
- Limited package compatibility
- No native C extensions
- Slower than native Python
- 15MB download on first run

## Alternatives Considered
- **Subprocess:** Less secure, requires Python installation
- **Docker:** Heavier, requires Docker daemon
```

**Effort:** Low-Medium (1 hour per ADR, ~3-4 ADRs recommended)

---

### 25. ⏳ No CHANGELOG.md
**Status:** Pending
**Priority:** Low
**Location:** Root directory

**Issue:** No changelog tracking version history.

**Recommendation:** Create CHANGELOG.md:
```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Comprehensive test coverage
- Execution timeout support
- Package installation caching

## [0.1.0] - 2024-01-15

### Added
- Initial release with Python sandbox execution
- File system operations (read, write, list, delete)
- Package installation via micropip
- Virtual workspace with host sync

### Security
- Path traversal protection
- File size limits (10MB per file, 100MB workspace)
- Code injection prevention in path handling
```

**Effort:** Low (1 hour initial, ongoing maintenance)

---

## 🛠️ Tooling & Infrastructure

### 26. ✅ ESLint Configuration
**Status:** COMPLETE
**Location:** `.eslintrc.json`

Comprehensive ESLint configuration already exists with TypeScript rules.

---

### 27. ✅ Prettier Configuration
**Status:** COMPLETE
**Location:** `.prettierrc.json`

Prettier configuration exists with consistent formatting rules.

---

### 28. ✅ GitHub Actions CI
**Status:** COMPLETE
**Location:** `.github/workflows/ci.yml`

Comprehensive CI pipeline exists:
- Multi-version Node.js testing (20, 22)
- Format checking
- Linting
- Type checking
- Build verification
- Integration tests
- Package validation

---

### 29. ⏳ Pre-commit Hooks
**Status:** Pending
**Priority:** Low
**Location:** Package setup

**Issue:** No pre-commit hooks to enforce quality standards.

**Recommendation:** Add husky and lint-staged:
```bash
npm install --save-dev husky lint-staged

# package.json
{
  "scripts": {
    "prepare": "husky install"
  },
  "lint-staged": {
    "*.ts": [
      "eslint --fix",
      "prettier --write"
    ],
    "*.{json,md}": [
      "prettier --write"
    ]
  }
}

# .husky/pre-commit
#!/usr/bin/env sh
. "$(dirname -- "$0")/_/husky.sh"

npx lint-staged
```

**Effort:** Low (1 hour)

---

### 30. ⏳ Improve Logging
**Status:** Pending
**Priority:** Low
**Location:** Throughout codebase (using `console.error`)

**Issue:** Using `console.error` instead of a proper logging framework.

**Impact:**
- No log levels
- No structured logging
- No log rotation
- Hard to filter/search logs

**Recommendation:** Use a proper logger:
```typescript
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss',
      ignore: 'pid,hostname'
    }
  }
});

// Usage
logger.info({ msg: 'Pyodide runtime initialized', duration: 1234 });
logger.error({ err, msg: 'Failed to load package', package: 'numpy' });
logger.debug({ path: '/workspace/file.py', msg: 'Reading file' });
```

**Effort:** Medium (3-4 hours)

---

### 31. ⏳ Add Environment Variable Validation
**Status:** Pending
**Priority:** Low
**Location:** `src/config/constants.ts`

**Issue:** Environment variables aren't validated at startup.

**Recommendation:** Use Zod for env validation:
```typescript
import { z } from 'zod';

const envSchema = z.object({
  PYODIDE_WORKSPACE: z.string().optional().default(
    path.join(process.cwd(), 'workspace')
  ),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  MAX_FILE_SIZE: z.coerce.number().positive().default(10 * 1024 * 1024),
  MAX_WORKSPACE_SIZE: z.coerce.number().positive().default(100 * 1024 * 1024),
  EXECUTION_TIMEOUT: z.coerce.number().positive().default(30000),
});

export const env = envSchema.parse(process.env);

// Usage
export const WORKSPACE_DIR = env.PYODIDE_WORKSPACE;
export const MAX_FILE_SIZE = env.MAX_FILE_SIZE;
```

**Effort:** Low-Medium (2 hours)

---

### 32. ⏳ Add Metrics/Telemetry
**Status:** Pending
**Priority:** Low
**Location:** New module

**Issue:** No visibility into execution metrics, performance, or usage patterns.

**Recommendation:** Add basic metrics:
```typescript
interface ExecutionMetrics {
  startTime: number;
  endTime: number;
  duration: number;
  codeLength: number;
  packagesInstalled: string[];
  stdout: number; // bytes
  stderr: number; // bytes
  success: boolean;
  error?: string;
}

class MetricsCollector {
  private executions: ExecutionMetrics[] = [];

  recordExecution(metrics: ExecutionMetrics) {
    this.executions.push(metrics);

    // Log summary every 100 executions
    if (this.executions.length % 100 === 0) {
      this.logSummary();
    }
  }

  private logSummary() {
    const successful = this.executions.filter(e => e.success).length;
    const avgDuration = this.executions.reduce((sum, e) => sum + e.duration, 0) / this.executions.length;

    logger.info({
      msg: 'Execution metrics summary',
      total: this.executions.length,
      successful,
      failed: this.executions.length - successful,
      avgDuration,
      successRate: (successful / this.executions.length * 100).toFixed(2)
    });
  }
}
```

**Effort:** Medium (4-5 hours)

---

## 🚀 Additional Enhancements

### 33. ⏳ Duplicate Package Installation Prevention
**Status:** Pending
**Priority:** Low
**Location:** `src/core/pyodide-manager.ts:256-265`

**Issue:** In `executeCode()`, packages are installed without checking if they're already loaded.

**Recommendation:** Check before installing (related to #10):
```typescript
async executeCode(code: string, packages: string[] = []): Promise<ExecutionResult> {
  const py = await this.initialize();
  this.syncHostToVirtual();

  // Filter out already-installed packages
  const packagesToInstall = packages.filter(pkg => !this.installedPackages.has(pkg));

  if (packagesToInstall.length > 0) {
    await this.installPackages(packagesToInstall);
  }

  // ... rest of execution
}
```

**Effort:** Low (30 minutes) - part of #10

---

### 34. ⏳ Virtual Filesystem Persistence Options
**Status:** Pending
**Priority:** Low
**Location:** New feature

**Issue:** All workspace changes are persisted. No option for ephemeral execution.

**Recommendation:** Add option to skip persistence:
```typescript
async executeCode(
  code: string,
  packages: string[] = [],
  options: {
    persist?: boolean;  // Default true
    timeout?: number;
  } = {}
): Promise<ExecutionResult> {
  const { persist = true, timeout = 30000 } = options;

  if (persist) {
    this.syncHostToVirtual();
  }

  // ... execute code ...

  if (persist) {
    this.syncVirtualToHost();
  }

  return result;
}
```

**Effort:** Low-Medium (2 hours)

---

### 35. ⏳ Add File Copy/Move Operations
**Status:** Pending
**Priority:** Low
**Location:** New tools

**Issue:** Only write, read, list, delete are supported. No copy/move operations.

**Recommendation:** Add copy and move tools:
```typescript
// tools/filesystem.ts
server.registerTool(
  "copy_file",
  {
    title: "Copy File",
    description: "Copy a file or directory to a new location",
    inputSchema: {
      source: z.string().describe("Source path"),
      destination: z.string().describe("Destination path")
    }
  },
  async ({ source, destination }) => {
    const result = await pyodideManager.copyFile(source, destination);
    return { content: [{ type: "text", text: result.success ? "✓ Copied" : result.error }] };
  }
);
```

**Effort:** Low-Medium (3 hours)

---

### 36. ⏳ Enhanced Error Context
**Status:** Pending
**Priority:** Low
**Location:** Error handling throughout

**Issue:** Error messages sometimes lack context about what operation failed.

**Recommendation:** Include operation context in errors:
```typescript
async writeFile(filePath: string, content: string): Promise<FileWriteResult> {
  try {
    // ... validation and write logic
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      error: `Failed to write file '${filePath}': ${errorMessage}`,
      context: {
        operation: 'writeFile',
        path: filePath,
        contentLength: content.length
      }
    };
  }
}
```

**Effort:** Low-Medium (2-3 hours)

---

### 37. ⏳ Configurable Constants
**Status:** Pending
**Priority:** Low
**Location:** `src/config/constants.ts`

**Issue:** Size limits and other constants are hardcoded.

**Recommendation:** Make configurable via environment (see #31):
```typescript
export const MAX_FILE_SIZE = env.MAX_FILE_SIZE;
export const MAX_WORKSPACE_SIZE = env.MAX_WORKSPACE_SIZE;
export const EXECUTION_TIMEOUT = env.EXECUTION_TIMEOUT;
```

**Effort:** Low (1 hour) - part of #31

---

### 38. ⏳ Workspace Cleanup Utility
**Status:** Pending
**Priority:** Low
**Location:** New tool

**Issue:** No easy way to clear entire workspace.

**Recommendation:** Add workspace reset tool:
```typescript
server.registerTool(
  "clear_workspace",
  {
    title: "Clear Workspace",
    description: "Delete all files from the workspace (cannot be undone)",
    inputSchema: {
      confirm: z.literal(true).describe("Must be true to confirm deletion")
    }
  },
  async ({ confirm }) => {
    if (!confirm) {
      return { content: [{ type: "text", text: "Error: Must confirm with confirm: true" }] };
    }

    await pyodideManager.clearWorkspace();
    return { content: [{ type: "text", text: "✓ Workspace cleared" }] };
  }
);
```

**Effort:** Low (1-2 hours)

---

## 📊 Summary & Roadmap

### Status Overview

| Category | Total | Fixed | Pending | Completion |
|----------|-------|-------|---------|------------|
| Critical Issues | 6 | 6 | 0 | 100% ✅ |
| High Priority | 8 | 1 | 7 | 13% |
| Testing | 7 | 0 | 7 | 0% |
| Documentation | 4 | 0 | 4 | 0% |
| Tooling | 6 | 3 | 3 | 50% |
| Enhancements | 7 | 0 | 7 | 0% |
| **Total** | **38** | **10** | **28** | **26%** |

### Priority Implementation Order

**Phase 1: Performance & Reliability (High Priority)**
1. #7 - Async file operations (3 hours)
2. #8 - Optimize workspace syncing (6 hours)
3. #9 - Add execution timeout (3 hours)
4. #10 - Package installation caching (2 hours)
5. #11 - Cache workspace size (4 hours)
6. #13 - Graceful shutdown (1 hour)
7. #14 - Fix result repr bug (30 min)

**Total Effort:** ~20 hours

**Phase 2: Testing Improvements**
8. #15 - Replace hard-coded sleeps (2 hours)
9. #16 - Fix test interdependence (3 hours)
10. #17 - Add unit tests (12 hours)
11. #18 - Improve type safety (3 hours)

**Total Effort:** ~20 hours

**Phase 3: Code Quality & Documentation**
12. #22 - Standardize error formats (6 hours)
13. #23 - Add JSDoc (6 hours)
14. #24 - Create ADRs (4 hours)
15. #25 - Add CHANGELOG (1 hour)
16. #31 - Environment validation (2 hours)

**Total Effort:** ~19 hours

**Phase 4: Nice-to-Have Enhancements**
17. #29 - Pre-commit hooks (1 hour)
18. #30 - Structured logging (4 hours)
19. #32 - Metrics/telemetry (5 hours)
20. #34-38 - Additional features (10 hours)

**Total Effort:** ~20 hours

### Key Metrics

- **Technical Debt Addressed:** 6 critical security issues fixed
- **Code Quality:** ESLint + Prettier + CI/CD in place
- **Test Coverage:** Integration tests exist, unit tests needed
- **Documentation:** Architecture docs complete, API docs partial

### Recent Improvements

**2024-01 Refactor:**
- ✅ Modular architecture implemented
- ✅ Security vulnerabilities fixed
- ✅ File size limits added
- ✅ Path traversal protection
- ✅ CI/CD pipeline established
- ✅ Comprehensive documentation

---

## Contributing

When working on improvements:

1. **Update Status:** Change status from ⏳ to 🔄 (in progress) to ✅ (complete)
2. **Add Details:** Document actual implementation approach
3. **Link PRs:** Reference related pull requests
4. **Test Coverage:** Ensure changes are tested
5. **Update Metrics:** Recalculate completion percentages

---

**Document Version:** 2.0
**Last Review:** 2026-01-21
**Next Review:** 2026-02-21
