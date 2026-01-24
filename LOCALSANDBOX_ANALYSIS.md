# LocalSandbox vs Our Pyodide Solution - Comparative Analysis

## Executive Summary

This document analyzes the [coplane/localsandbox](https://github.com/coplane/localsandbox) implementation and compares it to our Pyodide-based MCP sandbox. It provides insights on architectural differences and recommendations for incorporating bash execution capabilities using [just-bash](https://github.com/vercel-labs/just-bash).

---

## Architecture Comparison

### Our Implementation (Pyodide MCP Server)

```
┌─────────────────────────────────────────────────┐
│           MCP Server (Node.js)                  │
├─────────────────────────────────────────────────┤
│  Tools:                                         │
│  - execute_python                               │
│  - install_packages                             │
│  - write_file / read_file / list_files         │
│  - delete_file                                  │
├─────────────────────────────────────────────────┤
│         PyodideManager (Singleton)              │
│  - Pyodide WASM Runtime                         │
│  - Emscripten Virtual FS (/workspace)           │
│  - Bidirectional Sync (Host ↔ Virtual)         │
│  - Package Management (micropip)                │
├─────────────────────────────────────────────────┤
│         Host Filesystem (Node.js)               │
│  - ./workspace/ directory                       │
│  - Persistent storage                           │
└─────────────────────────────────────────────────┘

Execution Flow:
MCP Client → Node.js Server → PyodideManager → Pyodide (WASM)
                                     ↓
                            File Sync ↔ Host FS
```

**Key Characteristics:**
- Single runtime (Python only via Pyodide)
- Emscripten virtual filesystem in WASM memory
- Explicit sync operations between host and virtual FS
- Direct Node.js filesystem for persistence
- No bash/shell capabilities

---

### LocalSandbox Implementation

```
┌─────────────────────────────────────────────────┐
│        LocalSandbox Python SDK                  │
├─────────────────────────────────────────────────┤
│  Methods:                                       │
│  - bash(command)                                │
│  - execute_python(code)                         │
│  - read_file / write_file / list_files         │
│  - KVStore (key-value state)                   │
│  - export_snapshot / restore                   │
├─────────────────────────────────────────────────┤
│         Deno Shim Layer (TypeScript)           │
│  - CLI router (bash, execute-python, seed...)  │
│  - AgentFS coordination                        │
│  - just-bash runtime                           │
│  - Pyodide integration                         │
├─────────────────────────────────────────────────┤
│           AgentFS (SQLite Backend)              │
│  - Virtual filesystem (all operations)         │
│  - Persistent storage in SQLite database       │
│  - Shared by both bash and Python              │
│  - Binary support (base64 encoding)            │
├─────────────────────────────────────────────────┤
│    Execution Engines (Coordinated)             │
│  ┌──────────────┐    ┌────────────────────┐   │
│  │  just-bash   │    │  Pyodide (WASM)    │   │
│  │  (TypeScript)│    │  (Python runtime)  │   │
│  │  /data mount │    │  /data mount       │   │
│  └──────────────┘    └────────────────────┘   │
└─────────────────────────────────────────────────┘

Execution Flow:
Python SDK → Deno subprocess → Shim CLI → AgentFS
                                    ↓
                    just-bash OR Pyodide (both access AgentFS)
                                    ↓
                            SQLite Database
```

**Key Characteristics:**
- Dual runtime (Bash via just-bash + Python via Pyodide)
- SQLite-backed virtual filesystem (AgentFS)
- Unified filesystem shared by both runtimes
- Deno subprocess isolation per command
- Snapshot/restore capability
- Separate KV store for state management

---

## Key Differences

| Aspect | Our Implementation | LocalSandbox |
|--------|-------------------|--------------|
| **Runtimes** | Python only (Pyodide) | Bash (just-bash) + Python (Pyodide) |
| **Filesystem** | Emscripten FS + Node.js FS with sync | AgentFS (SQLite-backed virtual FS) |
| **Persistence** | Direct host filesystem | SQLite database |
| **Process Model** | Single long-lived Pyodide instance | Deno subprocess per command |
| **Isolation** | WASM sandbox | WASM + subprocess isolation |
| **State Management** | Files only | Files + KV store + command history |
| **Snapshots** | Not supported | Export/restore full state |
| **Shell Execution** | None | Full bash simulation via just-bash |
| **Binary Files** | Direct FS operations | Base64 encoded in SQLite |
| **Networking** | Blocked by WASM | Controlled via just-bash config |

---

## What We Can Learn from LocalSandbox

### 1. **Unified Filesystem Abstraction (AgentFS)**

**Their Approach:**
- Single SQLite database backing all filesystem operations
- Both bash and Python access the same virtual filesystem at `/data`
- Automatic persistence without explicit sync operations
- Command history and audit logging built-in

**Advantages:**
- No sync complexity - all changes immediately persisted
- State is fully portable (export SQLite file = complete snapshot)
- Built-in versioning and audit trail
- Consistent view across both runtimes

**What We Can Adopt:**
- Consider a unified virtual filesystem abstraction
- Eliminate the need for explicit sync operations
- Add snapshot/restore capabilities for reproducibility

### 2. **Dual Runtime Support (Bash + Python)**

**Their Approach:**
- just-bash provides bash simulation without spawning real processes
- Both runtimes operate on the same virtual filesystem
- Seamless interop: bash can execute Python scripts, Python can read bash output

**Advantages:**
- More versatile for file manipulation (grep, sed, awk, find, etc.)
- Familiar bash commands for text processing
- Shell scripting capabilities for automation
- Better alignment with typical development workflows

**What We Can Adopt:**
- Add bash execution as a complementary capability to Python
- Enable more natural file operations and text processing
- Provide richer tooling for AI agents

### 3. **Subprocess Isolation Model**

**Their Approach:**
- Each command spawns a fresh Deno subprocess
- Opens AgentFS, executes command, persists changes, exits
- Complete isolation between command executions

**Trade-offs:**
- ✅ Stronger isolation (process boundary)
- ✅ Clean state per execution
- ✅ Resource cleanup guaranteed
- ❌ Slower for repeated operations (subprocess overhead)
- ❌ Cannot maintain runtime state (Python imports, variables)

**Our Current Approach:**
- Single long-lived Pyodide instance
- Faster for repeated Python executions
- State accumulation across executions (imports cached)

**Recommendation:**
- Maintain our long-lived model for Python (performance)
- Use just-bash in-process (no subprocess needed)
- Provide explicit state reset if needed

### 4. **Structured Command Results**

**Their Approach:**
```json
{
  "stdout": "...",
  "stderr": "...",
  "exit_code": 0,
  "duration_ms": 123
}
```

**What We Can Adopt:**
- Standardize our response format across all tools
- Include execution timing metrics
- Consistent error reporting structure

### 5. **Execution Limits & Safety**

**Their Approach:**
- Three preset levels: STRICT, NORMAL, PERMISSIVE
- Configurable limits:
  - `maxLoopIterations` (prevents infinite loops)
  - `maxCommandCount` (prevents runaway scripts)
  - `maxCallDepth` (prevents stack overflow)
- Applied to both bash and Python

**What We Can Adopt:**
- Add execution limits to prevent DoS
- Implement timeout mechanisms
- Resource usage controls

### 6. **Network Access Control**

**Their Approach (via just-bash):**
- Network disabled by default
- Opt-in via URL allowlists
- HTTP method restrictions
- Redirect protection

**What We Can Adopt:**
- Controlled network access for specific use cases
- Allowlist-based approach for security
- Granular permission model

---

## Incorporating just-bash into Our Solution

### Recommended Architecture

```
┌─────────────────────────────────────────────────────┐
│            MCP Server (Node.js)                     │
├─────────────────────────────────────────────────────┤
│  Tools:                                             │
│  - execute_python                                   │
│  - execute_bash           ← NEW                     │
│  - install_packages                                 │
│  - write_file / read_file / list_files / delete    │
├─────────────────────────────────────────────────────┤
│         Sandbox Manager                             │
│  ┌────────────────────┐   ┌─────────────────────┐ │
│  │  PyodideManager    │   │  BashManager        │ │
│  │  - Pyodide runtime │   │  - just-bash        │ │
│  │  - micropip        │   │  - ReadWriteFs      │ │
│  │  - /workspace      │   │  - /workspace       │ │
│  └────────────────────┘   └─────────────────────┘ │
├─────────────────────────────────────────────────────┤
│          Shared Filesystem Layer                    │
│  - Host: ./workspace/ (Node.js)                    │
│  - Both runtimes access same directory             │
│  - Sync after bash operations                      │
│  - Pyodide syncs as before                         │
└─────────────────────────────────────────────────────┘
```

### Implementation Strategy

#### Option A: Direct Integration (Simpler, Recommended)

**Approach:**
- Add just-bash as a dependency
- Create new `BashManager` class alongside `PyodideManager`
- Use `ReadWriteFs` filesystem backed by our `./workspace` directory
- Both managers access the same host filesystem
- Sync Pyodide after bash operations, sync before/after Python execution

**Advantages:**
- ✅ Simple architecture - no subprocess overhead
- ✅ Direct filesystem access for bash commands
- ✅ Fast execution - in-process TypeScript
- ✅ Easy to maintain and debug
- ✅ Consistent with our current design

**Code Structure:**
```typescript
// src/core/bash-manager.ts
import { Bash, ReadWriteFs } from "just-bash";

export class BashManager {
  private bash: Bash;

  constructor(workspaceDir: string) {
    const fs = new ReadWriteFs({ root: workspaceDir });
    this.bash = new Bash({
      fs,
      cwd: "/",
      executionLimits: {
        maxLoopIterations: 10000,
        maxCommandCount: 10000,
        maxCallDepth: 100
      }
    });
  }

  async execute(command: string, cwd?: string) {
    const result = await this.bash.exec(command, { cwd });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    };
  }
}
```

**Integration Points:**
1. Add `execute_bash` tool in `src/tools/bash-execution.ts`
2. Register with MCP server
3. Coordinate with PyodideManager for filesystem consistency
4. After bash execution, sync to Pyodide if needed

#### Option B: AgentFS Approach (More Complex)

**Approach:**
- Adopt AgentFS (SQLite-backed virtual FS)
- Both bash and Pyodide access AgentFS
- Single source of truth in SQLite database

**Advantages:**
- ✅ Perfect consistency between runtimes
- ✅ Snapshot/restore capability
- ✅ Audit trail and versioning
- ✅ Portable state

**Disadvantages:**
- ❌ Requires significant refactoring
- ❌ Adds dependency on AgentFS/SQLite
- ❌ More complex architecture
- ❌ Potential performance overhead

**Recommendation:** Start with Option A, consider Option B if we need snapshots/audit trail.

---

## Specific Recommendations

### Phase 1: Add Basic Bash Support (Quick Win)

**Goal:** Enable bash command execution using just-bash

**Implementation:**
1. Install just-bash: `npm install just-bash`
2. Create `BashManager` class with `ReadWriteFs` filesystem
3. Add `execute_bash` MCP tool
4. Coordinate filesystem sync with PyodideManager
5. Add integration tests

**Estimated Effort:** Small (1-2 days)

**Value:**
- Immediate bash execution capability
- File manipulation with bash commands
- Text processing (grep, sed, awk, etc.)
- Shell scripting support

### Phase 2: Enhanced Integration

**Goal:** Improve coordination between bash and Python

**Implementation:**
1. Shared filesystem abstraction layer
2. Automatic sync between runtimes
3. Execution limits and timeouts
4. Standardized result format
5. Network access controls (if needed)

**Estimated Effort:** Medium (3-5 days)

### Phase 3: Advanced Features (Optional)

**Goal:** Match or exceed localsandbox capabilities

**Implementation:**
1. Consider AgentFS for unified virtual filesystem
2. Snapshot/restore capability
3. Command history and audit logging
4. KV store for state management
5. Execution metrics and monitoring

**Estimated Effort:** Large (1-2 weeks)

---

## Implementation Example: Adding execute_bash Tool

### 1. Install Dependencies

```bash
npm install just-bash
```

### 2. Create BashManager

```typescript
// src/core/bash-manager.ts
import { Bash, ReadWriteFs } from "just-bash";
import type { ExecutionLimits } from "just-bash";
import { WORKSPACE_DIR } from "../config/constants.js";

export interface BashExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class BashManager {
  private bash: Bash;
  private workspaceDir: string;

  constructor(workspaceDir: string = WORKSPACE_DIR) {
    this.workspaceDir = workspaceDir;

    // Create ReadWriteFs backed by our workspace directory
    const fs = new ReadWriteFs({ root: workspaceDir });

    // Configure execution limits to prevent DoS
    const limits: ExecutionLimits = {
      maxLoopIterations: 10000,
      maxCommandCount: 10000,
      maxCallDepth: 100
    };

    this.bash = new Bash({
      fs,
      cwd: "/",
      executionLimits: limits,
      // Network disabled by default for security
      network: undefined
    });
  }

  /**
   * Execute a bash command
   */
  async execute(
    command: string,
    options?: { cwd?: string }
  ): Promise<BashExecutionResult> {
    try {
      const result = await this.bash.exec(command, options);

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode
      };
    } catch (error) {
      return {
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1
      };
    }
  }

  /**
   * Get the workspace directory
   */
  getWorkspaceDir(): string {
    return this.workspaceDir;
  }
}
```

### 3. Create Bash Execution Tool

```typescript
// src/tools/bash-execution.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BashManager } from "../core/bash-manager.js";
import type { PyodideManager } from "../core/pyodide-manager.js";
import { z } from "zod";

const ExecuteBashSchema = z.object({
  command: z.string().describe("The bash command to execute"),
  cwd: z.string().optional().describe("Working directory (relative to /workspace)")
});

export function registerBashExecutionTools(
  server: McpServer,
  bashManager: BashManager,
  pyodideManager: PyodideManager
): void {

  server.tool(
    "execute_bash",
    "Execute a bash command in the sandboxed environment. Supports standard bash features including pipes, redirections, variables, loops, and 50+ built-in commands (grep, sed, awk, find, jq, curl, etc.). The command runs with access to the /workspace directory. Changes to files are immediately visible to Python code.",
    ExecuteBashSchema,
    async ({ command, cwd }) => {
      try {
        // Execute bash command
        const result = await bashManager.execute(command, { cwd });

        // Sync changes to Pyodide virtual filesystem
        // This ensures Python sees any file modifications made by bash
        await pyodideManager.syncHostToVirtual();

        // Format output
        let output = "";
        if (result.stdout) {
          output += result.stdout;
        }
        if (result.stderr) {
          output += result.stderr;
        }

        // Return success
        if (result.exitCode === 0) {
          return {
            content: [
              {
                type: "text",
                text: output || "Command executed successfully (no output)"
              }
            ]
          };
        } else {
          // Non-zero exit code
          return {
            content: [
              {
                type: "text",
                text: `Command failed with exit code ${result.exitCode}\n${output}`
              }
            ],
            isError: true
          };
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error executing bash command: ${error instanceof Error ? error.message : String(error)}`
            }
          ],
          isError: true
        };
      }
    }
  );
}
```

### 4. Update Tool Registration

```typescript
// src/tools/index.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PyodideManager } from "../core/pyodide-manager.js";
import type { BashManager } from "../core/bash-manager.js";
import { registerPythonExecutionTools } from "./python-execution.js";
import { registerFilesystemTools } from "./filesystem.js";
import { registerBashExecutionTools } from "./bash-execution.js";

/**
 * Register all tools with the MCP server
 */
export function registerAllTools(
  server: McpServer,
  pyodideManager: PyodideManager,
  bashManager: BashManager
): void {
  registerPythonExecutionTools(server, pyodideManager);
  registerFilesystemTools(server, pyodideManager);
  registerBashExecutionTools(server, bashManager, pyodideManager);
}
```

### 5. Update Server

```typescript
// src/server.ts (partial)
import { BashManager } from "./core/bash-manager.js";

// Initialize managers
const pyodideManager = new PyodideManager();
const bashManager = new BashManager();

// Register tools
registerAllTools(server, pyodideManager, bashManager);
```

---

## Use Cases Enabled by Bash Support

### 1. File Processing
```bash
# Find all Python files and count lines
find . -name "*.py" | xargs wc -l

# Search for specific patterns
grep -r "TODO" src/ --color=never

# Process CSV files
cat data.csv | awk -F',' '{sum+=$2} END {print sum}'
```

### 2. Data Transformation
```bash
# Extract JSON fields
cat data.json | jq '.users[] | {name, email}'

# Process logs
tail -n 100 app.log | grep ERROR | wc -l

# Convert formats
cat data.csv | xan select 'name,age' | xan to json
```

### 3. File Management
```bash
# Organize files
mkdir -p output/{processed,raw}
mv *.txt raw/
cp processed_* output/processed/

# Archive operations
tar -czf backup.tar.gz ./data/
```

### 4. Text Processing
```bash
# Complex sed operations
sed -i 's/old_pattern/new_pattern/g' *.txt

# Multi-file operations
for file in *.md; do
  echo "Processing $file"
  sed 's/# /## /g' "$file" > "processed_$file"
done
```

### 5. Integration with Python
```bash
# Bash prepares data, Python processes it
cat raw_data.csv | grep -v '^#' > clean_data.csv
python process.py clean_data.csv
```

---

## Security Considerations

### just-bash Security Model

**What it Provides:**
- ✅ No real process spawning
- ✅ Filesystem isolation (limited to provided directory)
- ✅ Execution limits (loops, recursion, command count)
- ✅ Network disabled by default
- ✅ No access to host system binaries

**What it DOESN'T Provide:**
- ❌ Not security audited (per their disclaimer)
- ❌ No resource limits (CPU, memory) beyond counts
- ❌ Possible bypasses in bash simulation
- ❌ JavaScript execution still has Node.js access

**Our Recommendations:**
1. **Combine Isolation Layers:**
   - Use just-bash for bash simulation
   - Keep Pyodide for Python (WASM isolation)
   - Both provide different security boundaries

2. **Apply Least Privilege:**
   - Limit filesystem access to workspace only
   - Disable network unless explicitly needed
   - Use strict execution limits

3. **Validate Inputs:**
   - Sanitize bash commands if from untrusted sources
   - Validate file paths against traversal attacks
   - Check file sizes before operations

4. **Monitor Resource Usage:**
   - Implement timeouts
   - Track execution counts
   - Limit workspace size

---

## Performance Considerations

### just-bash Performance

**Advantages:**
- ✅ In-process execution (no subprocess overhead)
- ✅ TypeScript/JavaScript speed
- ✅ No WASM overhead for simple commands

**Limitations:**
- ❌ Slower than native bash for heavy operations
- ❌ Not optimized for large file processing
- ❌ JavaScript memory constraints apply

**Optimization Strategies:**
1. Use native Node.js FS operations for large files
2. Offload heavy processing to Python/WASM
3. Implement streaming for large data operations
4. Cache execution environment setup

### Comparison: Subprocess vs In-Process

| Aspect | LocalSandbox (Subprocess) | Our Approach (In-Process) |
|--------|--------------------------|---------------------------|
| Startup Time | ~50-100ms per command | ~0ms (already loaded) |
| Isolation | Process boundary | In-memory only |
| State Persistence | SQLite | Filesystem |
| Memory Usage | Separate heap per command | Shared heap |
| Concurrent Execution | Independent processes | Requires coordination |
| Resource Cleanup | Automatic (process exit) | Manual/GC |

**Recommendation:** In-process is better for our use case (lower latency, simpler architecture).

---

## Testing Strategy

### Integration Tests for Bash Support

```typescript
// test/bash-integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { BashManager } from "../src/core/bash-manager.js";
import { PyodideManager } from "../src/core/pyodide-manager.js";
import fs from "fs/promises";
import path from "path";

describe("Bash Integration Tests", () => {
  let bashManager: BashManager;
  let pyodideManager: PyodideManager;
  const testWorkspace = "./test-workspace-bash";

  beforeAll(async () => {
    await fs.mkdir(testWorkspace, { recursive: true });
    bashManager = new BashManager(testWorkspace);
    pyodideManager = new PyodideManager(testWorkspace);
    await pyodideManager.initialize();
  });

  afterAll(async () => {
    await fs.rm(testWorkspace, { recursive: true, force: true });
  });

  it("should execute simple bash commands", async () => {
    const result = await bashManager.execute("echo 'Hello, World!'");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("Hello, World!");
  });

  it("should create files visible to Python", async () => {
    // Bash creates file
    await bashManager.execute("echo 'test content' > test.txt");

    // Sync to Python
    await pyodideManager.syncHostToVirtual();

    // Python reads file
    const code = `
with open('/workspace/test.txt', 'r') as f:
    content = f.read()
print(content)
`;
    const result = await pyodideManager.executeCode(code);
    expect(result.output.trim()).toBe("test content");
  });

  it("should process files created by Python", async () => {
    // Python creates file
    const code = `
with open('/workspace/data.txt', 'w') as f:
    for i in range(10):
        f.write(f'{i}\\n')
`;
    await pyodideManager.executeCode(code);
    await pyodideManager.syncVirtualToHost();

    // Bash processes file
    const result = await bashManager.execute("wc -l data.txt");
    expect(result.stdout).toContain("10");
  });

  it("should support pipes and redirections", async () => {
    await bashManager.execute("echo -e 'apple\\nbanana\\ncherry' > fruits.txt");
    const result = await bashManager.execute("cat fruits.txt | grep 'an' | wc -l");
    expect(result.stdout.trim()).toBe("2");
  });

  it("should handle grep operations", async () => {
    await bashManager.execute("echo -e 'line 1\\nline 2\\nline 3' > lines.txt");
    const result = await bashManager.execute("grep '2' lines.txt");
    expect(result.stdout.trim()).toBe("line 2");
  });

  it("should respect execution limits", async () => {
    // This should fail due to infinite loop protection
    const result = await bashManager.execute("while true; do echo 'infinite'; done");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("maxLoopIterations");
  });

  it("should handle find command", async () => {
    await bashManager.execute("mkdir -p dir1 dir2");
    await bashManager.execute("touch dir1/file1.txt dir2/file2.txt");
    const result = await bashManager.execute("find . -name '*.txt' | sort");
    expect(result.stdout).toContain("file1.txt");
    expect(result.stdout).toContain("file2.txt");
  });

  it("should process JSON with jq", async () => {
    await bashManager.execute("echo '{\"name\":\"Alice\",\"age\":30}' > data.json");
    const result = await bashManager.execute("cat data.json | jq '.name'");
    expect(result.stdout.trim()).toBe('"Alice"');
  });
});
```

---

## Migration Path

### Phase 1: Prototype (Week 1)
- [ ] Install just-bash dependency
- [ ] Create BashManager class
- [ ] Add execute_bash tool
- [ ] Basic integration tests
- [ ] Update documentation

### Phase 2: Integration (Week 2)
- [ ] Improve filesystem sync between bash and Python
- [ ] Add execution limits and timeouts
- [ ] Comprehensive error handling
- [ ] Performance benchmarks
- [ ] Security review

### Phase 3: Enhancement (Week 3+)
- [ ] Consider AgentFS for unified filesystem
- [ ] Add snapshot/restore capability
- [ ] Command history and audit logging
- [ ] Network access controls
- [ ] Advanced monitoring and metrics

---

## Conclusion

### Key Takeaways

1. **LocalSandbox's Strengths:**
   - Dual runtime (bash + Python) provides versatility
   - AgentFS offers unified, portable filesystem
   - Snapshot capability enables reproducibility
   - Subprocess isolation provides strong boundaries

2. **Our Current Strengths:**
   - Simple architecture, easy to maintain
   - Fast Python execution (long-lived instance)
   - Direct filesystem access
   - WASM security boundary

3. **Best Path Forward:**
   - Add just-bash support (Option A: Direct Integration)
   - Maintain our current Pyodide architecture
   - Use ReadWriteFs for bash filesystem access
   - Coordinate sync between runtimes
   - Consider AgentFS later if snapshot/audit needs arise

4. **Immediate Value:**
   - Bash execution enables file processing, text manipulation, and shell scripting
   - Minimal architectural changes required
   - Complements Python execution
   - Familiar tooling for developers and AI agents

### Recommended Action

**Implement Phase 1: Add basic bash support using just-bash with ReadWriteFs.**

This provides immediate value with minimal complexity, and positions us to adopt more advanced features (AgentFS, snapshots) if needed in the future.

---

## Codebase Review: Improvement Opportunities

The following items come directly from reviewing the current implementation and comparing it to LocalSandbox capabilities.

### 1. Add Execution Timeouts for Python Runs
**Current State:** `executeCode` runs unbounded, so a tight loop can block the server indefinitely.  
**LocalSandbox Comparison:** uses per-command subprocess isolation which naturally bounds execution time.  
**Recommendation:** add a configurable timeout wrapper and return a structured timeout error response.

### 2. Cache Package Installs and Report Failures
**Current State:** `executeCode` attempts package installs but only logs failures, so callers don't see install errors.  
**LocalSandbox Comparison:** returns structured results for each command, including errors and timing.  
**Recommendation:** track installed packages in-memory and surface install failures in the response payload.

### 3. Standardize Structured Results Across Tools
**Current State:** Python and filesystem tools include structured content; bash tool only returns text and errors.  
**LocalSandbox Comparison:** uniform response schema with stdout/stderr/exit_code/duration.  
**Recommendation:** return a consistent payload for bash (stdout/stderr/exit_code/duration_ms) and for Python (include duration_ms).

### 4. Introduce Snapshots for Workspace State
**Current State:** workspace persistence relies on host filesystem; no snapshot/export support.  
**LocalSandbox Comparison:** AgentFS snapshots allow export/restore and reproducibility.  
**Recommendation:** add snapshot tooling (tarball or sqlite export) to align with LocalSandbox portability.

### 5. Unify Filesystem Views Between Bash and Pyodide
**Current State:** Pyodide uses an in-memory virtual FS plus sync; bash operates directly on host FS.  
**LocalSandbox Comparison:** both runtimes share the same virtual FS (AgentFS).  
**Recommendation:** consider a shared abstraction (or sync optimizations) so both runtimes read the same state without repeated full syncs.

---

## References

- [LocalSandbox Repository](https://github.com/coplane/localsandbox)
- [just-bash Repository](https://github.com/vercel-labs/just-bash)
- [Vercel bash-tool Announcement](https://vercel.com/changelog/introducing-bash-tool-for-filesystem-based-context-retrieval)
- [InfoQ: Vercel Bash Tool Analysis](https://www.infoq.com/news/2026/01/vercel-bash-tool/)
- [Turso Blog: Building AI Agents with AgentFS and just-bash](https://turso.tech/blog/agentfs-just-bash)
