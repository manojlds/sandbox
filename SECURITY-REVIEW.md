# Heimdall Security Review

**Date:** 2026-01-31
**Reviewer:** Security Adversarial Analysis
**Scope:** Complete codebase security review for AI agent sandbox

## Executive Summary

Heimdall is an MCP server providing sandboxed Python and Bash execution. The codebase demonstrates good security awareness with multiple defense layers. However, several vulnerabilities were identified that could potentially allow sandbox escape or resource exhaustion.

## Security Architecture Overview

### Strengths

1. **WebAssembly Isolation (Python)**: Python runs in Pyodide WASM sandbox, preventing network access and system calls
2. **TypeScript Bash Simulation**: `just-bash` doesn't spawn real processes
3. **Path Validation**: Comprehensive path traversal prevention with normalization
4. **Symlink Protection**: Real path resolution prevents symlink-based escapes (for Python)
5. **Execution Limits**: Timeouts, loop limits, and resource caps
6. **Write Locking**: AsyncLock prevents TOCTOU race conditions during file writes
7. **Worker Thread Isolation**: Python runs in separate thread for true timeout enforcement

---

## Vulnerabilities Identified

### CRITICAL: BashManager Lacks Symlink Protection

**File:** `src/core/bash-manager.ts`
**Severity:** Critical
**CVSS Score:** 8.1 (High)

**Description:**
The BashManager uses `ReadWriteFs` from `just-bash` which operates directly on the host filesystem without symlink validation. While PyodideManager has comprehensive symlink protection, bash commands can read/write through symlinks that escape the workspace.

**Attack Scenario:**
```bash
# Attacker creates symlink in workspace
ln -s /etc/passwd evil-link

# Bash command reads through symlink
cat evil-link   # Returns /etc/passwd contents

# Or write attack
ln -s /home/user/.ssh/authorized_keys key-link
echo "attacker-key" > key-link
```

**Impact:** Arbitrary file read/write on host system

**Recommendation:**
Implement symlink validation in BashManager similar to PyodideManager:
1. Before any file operation, resolve real paths using `fs.realpath()`
2. Validate resolved path stays within workspace directory
3. Add integration tests for bash symlink attacks

---

### HIGH: Race Condition in AsyncLock

**File:** `src/utils/async-lock.ts:30-42`
**Severity:** High
**CVSS Score:** 6.5 (Medium)

**Description:**
The AsyncLock implementation has a race window between checking if a lock exists and setting a new lock:

```typescript
// RACE WINDOW HERE
while (this.locks.has(key)) {  // Thread A checks - no lock
  await this.locks.get(key);    // Thread B also checks - no lock
}
// Both threads proceed past the check

this.locks.set(key, lockPromise);  // Both set their locks
```

In highly concurrent scenarios, multiple operations could bypass the lock simultaneously, defeating the TOCTOU protection.

**Impact:** Multiple concurrent writes could exceed workspace size limits

**Recommendation:**
Use a proper mutex implementation or atomic compare-and-swap pattern:
```typescript
// Option 1: Use a Set for pending operations
private pending: Set<string> = new Set();

async acquire<T>(key: string, fn: () => Promise<T>): Promise<T> {
  while (this.pending.has(key)) {
    await new Promise(r => setTimeout(r, 1));
  }
  this.pending.add(key);  // Atomic in single-threaded JS
  try {
    return await fn();
  } finally {
    this.pending.delete(key);
  }
}
```

---

### HIGH: Host-to-Virtual Sync Reads Through Symlinks

**File:** `src/core/pyodide-manager.ts:310-361`, `src/core/pyodide-worker.ts:109-147`
**Severity:** High
**CVSS Score:** 7.0 (High)

**Description:**
The `syncHostToVirtual()` and `syncHostPathToVirtual()` functions read from the host filesystem without validating symlinks. If an attacker creates a symlink in the workspace pointing to an external file, the sync operation will read the external content and copy it into the virtual filesystem.

```typescript
// Line 333 - reads without symlink check
const content = await fs.promises.readFile(hostItemPath);
py.FS.writeFile(virtualItemPath, content);
```

**Attack Scenario:**
1. Attacker uses bash to create symlink: `ln -s /etc/shadow shadow-link`
2. Python execution triggers `syncHostToVirtual()`
3. Sync reads `/etc/shadow` contents through symlink
4. Contents now accessible in virtual filesystem
5. Python code can read the sensitive data

**Impact:** Sensitive file disclosure through combined bash+python attack

**Recommendation:**
Add symlink validation to `syncHostToVirtual`:
```typescript
private async syncHostPathToVirtual(hostPath: string, virtualPath: string): Promise<void> {
  // SECURITY: Validate before reading
  await this.validateHostPathWithSymlinkResolution(hostPath);
  // ... rest of implementation
}
```

---

### MEDIUM: Bash Commands Can Escape via Internal `cd`

**File:** `src/tools/bash-execution.ts:59-93`
**Severity:** Medium
**CVSS Score:** 5.5 (Medium)

**Description:**
The bash execution tool validates the initial `cwd` parameter, but bash commands can contain `cd` that changes the working directory internally:

```typescript
// Only the initial cwd is validated
if (cwd) {
  const normalizedCwd = path.normalize(cwd);
  // validation happens here
}

// But the command itself can contain:
// cd /tmp && cat /etc/passwd
```

The security depends on whether `just-bash`'s `ReadWriteFs` properly constrains all operations to the root directory.

**Impact:** Potential path traversal if `just-bash` has vulnerabilities

**Recommendation:**
1. Audit `just-bash` `ReadWriteFs` implementation for path constraints
2. Consider adding command sanitization to reject patterns like `cd /`, `cd ..` outside workspace
3. Add integration tests for bash escape attempts via `cd`

---

### MEDIUM: Python Can Create Symlinks via os.symlink()

**File:** `src/core/pyodide-worker.ts:274`
**Severity:** Medium
**CVSS Score:** 5.0 (Medium)

**Description:**
Python code running in Pyodide can call `os.symlink()` to create symlinks in the virtual filesystem. When `syncVirtualToHost()` runs, these symlinks could potentially be written to the host filesystem.

**Attack Scenario:**
```python
import os
os.symlink('/etc/passwd', '/workspace/evil-link')
```

If the sync operation doesn't handle symlinks properly, this could create a symlink on the host.

**Impact:** Could create symlinks on host filesystem

**Recommendation:**
1. Check if Pyodide's FS operations can create real symlinks
2. Add symlink type checking during `syncVirtualToHost`
3. Reject or skip symlink files during sync

---

### MEDIUM: Environment Variable Size Limits Can Enable DoS

**File:** `src/config/constants.ts:72-86`
**Severity:** Medium
**CVSS Score:** 4.5 (Medium)

**Description:**
The `HEIMDALL_MAX_FILE_SIZE` and `HEIMDALL_MAX_WORKSPACE_SIZE` environment variables can be set to arbitrarily large values, potentially enabling disk exhaustion attacks.

```typescript
// Only validates that value is positive
if (isNaN(parsed) || parsed <= 0) {
  // falls back to default
}
// No upper bound check!
```

**Impact:** Resource exhaustion, disk space DoS

**Recommendation:**
Add maximum value validation:
```typescript
const MAX_ALLOWED_FILE_SIZE = 1024 * 1024 * 1024;  // 1GB absolute max
const MAX_ALLOWED_WORKSPACE_SIZE = 10 * 1024 * 1024 * 1024;  // 10GB absolute max

if (parsed > MAX_ALLOWED_FILE_SIZE) {
  console.error(`[Config] ${name} exceeds maximum allowed value`);
  return defaultValue;
}
```

---

### LOW: Error Messages Leak Path Information

**File:** Various
**Severity:** Low
**CVSS Score:** 3.5 (Low)

**Description:**
Error messages include full filesystem paths which could reveal system structure:

```typescript
throw new Error(`Invalid path: Path traversal detected. Path must be within ${VIRTUAL_WORKSPACE}`);
// Reveals internal path structure
```

**Impact:** Information disclosure, aids reconnaissance

**Recommendation:**
Use generic error messages in production:
```typescript
throw new Error("Invalid path: Access denied");
```

---

### LOW: No Rate Limiting on Execution Requests

**File:** `src/tools/python-execution.ts`, `src/tools/bash-execution.ts`
**Severity:** Low
**CVSS Score:** 3.0 (Low)

**Description:**
There is no rate limiting on code execution requests. An attacker could flood the server with requests, causing resource exhaustion.

**Impact:** Denial of service

**Recommendation:**
Implement request rate limiting:
1. Track requests per time window
2. Reject requests exceeding threshold
3. Add exponential backoff for repeated violations

---

### LOW: Worker stdout/stderr Leaks to Parent Process

**File:** `src/core/pyodide-worker.ts:201-204`
**Severity:** Low
**CVSS Score:** 2.5 (Low)

**Description:**
Worker initialization outputs go directly to `process.stdout/stderr`:

```typescript
const py = await loadPyodide({
  stdout: (text: string) => process.stdout.write(text),
  stderr: (text: string) => process.stderr.write(text),
});
```

In certain deployment scenarios, this could leak sensitive information.

**Impact:** Potential information disclosure in logs

**Recommendation:**
Buffer and sanitize worker output, or suppress during initialization.

---

## Security Testing Gaps

### Missing Test Coverage

1. **Bash symlink attacks** - No tests for bash reading/writing through symlinks
2. **Bash internal `cd` escape attempts** - No tests for `cd ..` patterns
3. **Python `os.symlink()` creation** - No tests for Python-created symlinks
4. **Concurrent write race conditions** - Limited concurrency stress testing
5. **Resource exhaustion** - No tests for very large file/workspace limits

### Recommended Additional Tests

```typescript
describe("Bash Symlink Attacks", () => {
  it("should block bash reading through symlink", async () => {
    // Create symlink to /etc/passwd
    // Execute: cat evil-link
    // Verify blocked
  });

  it("should block bash cd escape", async () => {
    // Execute: cd /tmp && pwd
    // Verify still in workspace
  });
});

describe("Concurrency Attacks", () => {
  it("should handle 100 concurrent writes without exceeding limits", async () => {
    // Spawn 100 parallel writes
    // Verify total size stays within limit
  });
});
```

---

## Recommendations Summary

### Immediate Actions (Critical/High)

1. **Add symlink validation to BashManager** - Required to match PyodideManager security level
2. **Fix AsyncLock race condition** - Use atomic operations for lock acquisition
3. **Add symlink validation to syncHostToVirtual** - Prevent combined bash+python attacks

### Short-term Actions (Medium)

4. **Audit just-bash ReadWriteFs** - Verify path constraints are enforced
5. **Handle Python-created symlinks** - Check and block during sync
6. **Add environment variable bounds** - Prevent DoS via config

### Long-term Actions (Low)

7. **Sanitize error messages** - Remove path information
8. **Implement rate limiting** - Prevent request flooding
9. **Buffer worker output** - Prevent log leakage
10. **Expand test coverage** - Add security-focused test suite

---

## Compliance Notes

- **OWASP Top 10**: Addresses A01 (Broken Access Control) via path validation
- **CWE-22**: Path Traversal - Partially mitigated
- **CWE-367**: TOCTOU Race Condition - Partially mitigated
- **CWE-59**: Symlink Following - Partially mitigated (Python only)

---

## Appendix: Attack Surface Map

```
                                    ┌─────────────────────────────────────┐
                                    │         MCP Client (Agent)          │
                                    └──────────────────┬──────────────────┘
                                                       │
                                              MCP Protocol (stdio)
                                                       │
                                    ┌──────────────────▼──────────────────┐
                                    │           MCP Server                 │
                                    │  ┌─────────────────────────────────┐ │
                                    │  │        Tool Handlers            │ │
                                    │  │  • execute_python               │ │
                                    │  │  • execute_bash    [!]          │ │
                                    │  │  • read/write/delete_file       │ │
                                    │  └─────────────────────────────────┘ │
                                    └──────────────────┬──────────────────┘
                         ┌─────────────────────────────┼─────────────────────────────┐
                         │                             │                             │
          ┌──────────────▼──────────────┐ ┌────────────▼────────────┐ ┌──────────────▼──────────────┐
          │      PyodideManager         │ │     BashManager         │ │     Filesystem Tools        │
          │  ✓ Symlink validation       │ │  ✗ No symlink check [!] │ │  ✓ Via PyodideManager       │
          │  ✓ Path normalization       │ │  ✓ Execution limits     │ │  ✓ Path validation          │
          │  ✓ Timeout enforcement      │ │  ✗ No timeout [!]       │ │                             │
          │  ✓ WASM sandbox             │ │  ✓ No real processes    │ │                             │
          │  ✗ Sync reads symlinks [!]  │ │                         │ │                             │
          └──────────────┬──────────────┘ └────────────┬────────────┘ └─────────────────────────────┘
                         │                             │
          ┌──────────────▼──────────────┐ ┌────────────▼────────────┐
          │    Worker Thread            │ │     ReadWriteFs         │
          │  ✓ Isolated execution       │ │  ✗ Depends on just-bash │
          │  ✓ Terminable on timeout    │ │    security model       │
          └─────────────────────────────┘ └─────────────────────────┘

[!] = Identified vulnerability or gap
```

---

*This security review is provided for defensive purposes to improve the security posture of the Heimdall sandbox.*
