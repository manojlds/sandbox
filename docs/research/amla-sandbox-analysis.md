# AMLA Sandbox Analysis for Heimdall

## Overview

This document analyzes [amla-sandbox](https://github.com/amlalabs/amla-sandbox) - a WebAssembly-based sandboxing solution for LLM-generated code execution - and identifies features that could enhance Heimdall.

**Repository:** https://github.com/amlalabs/amla-sandbox
**Date:** January 2026

---

## 1. Executive Summary

Amla-sandbox provides capability-based security for sandboxed code execution. While Heimdall already has a solid sandboxed execution model (Pyodide for Python, just-bash for shell), amla-sandbox offers several compelling features around **tool authorization**, **constraint enforcement**, **audit logging**, and **rate limiting** that could significantly enhance Heimdall's security and usability for agent-based workflows.

### Key Differentiators from Heimdall

| Feature | Heimdall (Current) | Amla-Sandbox |
|---------|-------------------|--------------|
| Code Execution | Python (Pyodide), Bash (just-bash) | JavaScript (QuickJS), Shell |
| Language Runtime | WASM (Pyodide), TypeScript (just-bash) | WASM (QuickJS) |
| Tool Authorization | None | Capability-based with constraints |
| Rate Limiting | Execution timeout only | Per-tool call budgets |
| Audit Logging | None | Structured audit trail |
| Constraint DSL | None | Rich parameter validation |
| Multi-tenancy | Single workspace | Scoped sandboxes per tenant |

---

## 2. High-Priority Features for Implementation

### 2.1 Capability-Based Tool Authorization

**What it does:** Amla-sandbox implements a capability-based security model where tools must be explicitly granted with constraints. This prevents LLM-generated code from accessing unauthorized operations.

**Current Heimdall Gap:** Heimdall has no tool-level authorization. Any code executed in the sandbox can call any available function without restrictions.

**Amla Implementation:**
```python
from amla_sandbox import MethodCapability, ConstraintSet, Param

# Define what the agent CAN do
capabilities = [
    MethodCapability(
        method_pattern="stripe/charges/*",
        constraints=ConstraintSet([
            Param("amount") <= 10000,
            Param("currency").is_in(["USD", "EUR"]),
        ]),
        max_calls=100,
    ),
]
```

**Heimdall Implementation Proposal:**

```typescript
// src/capabilities/types.ts
interface MethodCapability {
  methodPattern: string;  // e.g., "fs/*", "execute_python"
  constraints: Constraint[];
  maxCalls?: number;
}

interface Constraint {
  param: string;
  operator: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'in' | 'notIn' | 'startsWith' | 'endsWith' | 'contains';
  value: unknown;
}

// Example usage
const capabilities: MethodCapability[] = [
  {
    methodPattern: "write_file",
    constraints: [
      { param: "path", operator: "startsWith", value: "/workspace/safe/" },
    ],
    maxCalls: 50,
  },
];
```

**Files to modify:**
- `src/capabilities/` (new directory)
  - `types.ts` - Capability type definitions
  - `validator.ts` - Capability validation logic
  - `constraint-dsl.ts` - Constraint parsing and evaluation
- `src/tools/*.ts` - Add capability checks before execution

**Estimated Complexity:** Medium-High

---

### 2.2 Constraint DSL (Domain-Specific Language)

**What it does:** Amla provides a fluent API for defining parameter constraints that are checked before tool execution.

**Supported Constraint Types:**
- **Comparison:** `>=`, `<=`, `>`, `<`, `==`, `!=`
- **Set membership:** `is_in([...])`, `not_in([...])`
- **String patterns:** `starts_with()`, `ends_with()`, `contains()`
- **Existence:** `exists()`, `not_exists()`
- **Nested paths:** `Param("user/role")` for nested objects
- **Composite logic:** `Constraint.or_([...])`, `Constraint.and_([...])`

**Heimdall Implementation Proposal:**

```typescript
// src/capabilities/constraint-dsl.ts

export function Param(name: string): ParamBuilder {
  return new ParamBuilder(name);
}

class ParamBuilder {
  constructor(private name: string) {}

  le(value: number): Constraint {
    return { param: this.name, operator: 'le', value };
  }

  ge(value: number): Constraint {
    return { param: this.name, operator: 'ge', value };
  }

  isIn(values: unknown[]): Constraint {
    return { param: this.name, operator: 'in', value: values };
  }

  startsWith(prefix: string): Constraint {
    return { param: this.name, operator: 'startsWith', value: prefix };
  }
  // ... more operators
}

// Usage
import { Param } from './constraint-dsl';

const constraints = [
  Param("amount").le(10000),
  Param("currency").isIn(["USD", "EUR"]),
  Param("path").startsWith("/workspace/"),
];
```

**Estimated Complexity:** Medium

---

### 2.3 Rate Limiting / Call Budgets

**What it does:** Per-tool call limits that prevent runaway execution and enforce usage quotas.

**Current Heimdall Gap:** Only has global execution timeout for Python. No per-operation limits.

**Amla Implementation:**
```python
MethodCapability(
    method_pattern="expensive_api/*",
    max_calls=10,  # Only allow 10 calls
)

# Check remaining budget before execution
remaining = sandbox.get_remaining_calls("expensive_api")
can_proceed = sandbox.can_call("expensive_api/query")
```

**Heimdall Implementation Proposal:**

```typescript
// src/rate-limiting/types.ts
interface CallBudget {
  methodPattern: string;
  maxCalls: number;
  currentCalls: number;
  resetPolicy?: 'never' | 'per-session' | 'per-execution';
}

// src/rate-limiting/budget-manager.ts
class BudgetManager {
  private budgets: Map<string, CallBudget> = new Map();

  registerBudget(budget: CallBudget): void { /* ... */ }

  canCall(method: string): boolean {
    const budget = this.findMatchingBudget(method);
    return budget ? budget.currentCalls < budget.maxCalls : true;
  }

  recordCall(method: string): void {
    const budget = this.findMatchingBudget(method);
    if (budget) budget.currentCalls++;
  }

  getRemainingCalls(method: string): number | undefined {
    const budget = this.findMatchingBudget(method);
    return budget ? budget.maxCalls - budget.currentCalls : undefined;
  }
}
```

**Files to modify:**
- `src/rate-limiting/` (new directory)
  - `types.ts`
  - `budget-manager.ts`
- `src/tools/index.ts` - Wrap tool calls with budget checks

**Estimated Complexity:** Low-Medium

---

### 2.4 Audit Logging

**What it does:** Structured logging of all sandbox operations for debugging, compliance, and security monitoring.

**Current Heimdall Gap:** Only console logging for debugging. No structured audit trail.

**Amla Components:**
- `AuditConfig` - Configure logging (agent_id, trace_id, output_path)
- `AuditEntry` - Structured log entries with timestamps, event types
- `AuditCollector` - Manages collection, filtering, file output

**Event Types Tracked:**
- `tool_call` - Tool invocations with parameters
- `command_create` - Command lifecycle start
- `command_exit` - Command completion with exit codes
- `stream_chunk` - Real-time output chunks
- Custom events with enrichment metadata

**Heimdall Implementation Proposal:**

```typescript
// src/audit/types.ts
interface AuditConfig {
  agentId?: string;
  traceId?: string;
  sessionId: string;
  outputPath?: string;  // JSONL file path
  customEnricher?: (entry: AuditEntry) => AuditEntry;
}

interface AuditEntry {
  timestamp: string;
  type: 'tool_call' | 'execution_start' | 'execution_end' | 'file_operation' | 'error';
  sessionId: string;
  agentId?: string;
  traceId?: string;
  turnId?: number;
  data: Record<string, unknown>;
}

// src/audit/collector.ts
class AuditCollector {
  private entries: AuditEntry[] = [];
  private config: AuditConfig;
  private currentTurn = 0;

  constructor(config: AuditConfig) { /* ... */ }

  log(type: AuditEntry['type'], data: Record<string, unknown>): void {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      type,
      sessionId: this.config.sessionId,
      agentId: this.config.agentId,
      traceId: this.config.traceId,
      turnId: this.currentTurn,
      data,
    };

    if (this.config.customEnricher) {
      entry = this.config.customEnricher(entry);
    }

    this.entries.push(entry);
    this.writeToFile(entry);
  }

  newTurn(): void {
    this.currentTurn++;
  }

  getEntries(filter?: { type?: string; since?: Date }): AuditEntry[] { /* ... */ }

  exportToJsonl(): string { /* ... */ }
}
```

**Usage in tools:**
```typescript
// In tool handler
auditCollector.log('tool_call', {
  tool: 'execute_python',
  params: { code: code.substring(0, 1000) },  // Truncate for safety
});

const result = await pyodideManager.executeCode(code);

auditCollector.log('execution_end', {
  tool: 'execute_python',
  success: result.success,
  exitCode: result.error ? 1 : 0,
});
```

**Estimated Complexity:** Medium

---

### 2.5 Pre-flight Authorization Checks

**What it does:** Validate tool calls BEFORE execution to fail fast and avoid wasting compute.

**Amla Pattern:**
```python
# Check if call is allowed before executing
if sandbox.can_call("transfer_money", {"amount": 5000}):
    result = sandbox.run("await transfer_money({amount: 5000})")
else:
    raise CapabilityError("Transfer not authorized")
```

**Heimdall Implementation Proposal:**

```typescript
// src/capabilities/pre-flight.ts
interface PreflightResult {
  allowed: boolean;
  reason?: string;
  remainingCalls?: number;
}

function checkPreflight(
  method: string,
  params: Record<string, unknown>,
  capabilities: MethodCapability[],
  budgetManager: BudgetManager
): PreflightResult {
  // 1. Check if method is in allowed capabilities
  const cap = findMatchingCapability(method, capabilities);
  if (!cap) {
    return { allowed: false, reason: 'Method not in allowed capabilities' };
  }

  // 2. Validate constraints
  for (const constraint of cap.constraints) {
    if (!evaluateConstraint(constraint, params)) {
      return {
        allowed: false,
        reason: `Constraint violated: ${constraint.param} ${constraint.operator} ${constraint.value}`
      };
    }
  }

  // 3. Check budget
  if (!budgetManager.canCall(method)) {
    return {
      allowed: false,
      reason: 'Call budget exceeded',
      remainingCalls: 0
    };
  }

  return {
    allowed: true,
    remainingCalls: budgetManager.getRemainingCalls(method)
  };
}
```

**Estimated Complexity:** Low (builds on capability and rate limiting systems)

---

## 3. Medium-Priority Features

### 3.1 Multi-Tenant Isolation

**What it does:** Scoped sandboxes per tenant with isolated capabilities, budgets, and workspaces.

**Amla Pattern:**
```python
# Create tenant-scoped sandbox
tenant_sandbox = create_sandbox_tool(
    tools=[read_document, write_document],
    constraints={
        "read_document": {"tenant_id": tenant.tenant_id},
        "write_document": {"tenant_id": tenant.tenant_id},
    },
)
```

**Heimdall Implementation Proposal:**

```typescript
// src/multi-tenant/types.ts
interface TenantConfig {
  tenantId: string;
  workspacePath: string;  // e.g., `/workspace/tenants/{tenantId}`
  capabilities: MethodCapability[];
  budgets: CallBudget[];
  maxWorkspaceSize?: number;
  maxFileSize?: number;
}

// src/multi-tenant/tenant-manager.ts
class TenantManager {
  private tenants: Map<string, TenantContext> = new Map();

  createTenant(config: TenantConfig): TenantContext {
    const context = new TenantContext(config);
    this.tenants.set(config.tenantId, context);
    return context;
  }

  getTenant(tenantId: string): TenantContext | undefined {
    return this.tenants.get(tenantId);
  }
}

class TenantContext {
  readonly pyodideManager: PyodideManager;
  readonly bashManager: BashManager;
  readonly budgetManager: BudgetManager;
  readonly auditCollector: AuditCollector;

  constructor(config: TenantConfig) {
    // Initialize with tenant-scoped workspace
    this.pyodideManager = new PyodideManager({ workspace: config.workspacePath });
    this.bashManager = new BashManager(config.workspacePath);
    // ... etc
  }
}
```

**Estimated Complexity:** High

---

### 3.2 Streaming Output

**What it does:** Real-time output callbacks during execution for progressive feedback.

**Amla Pattern:**
```python
def on_output(chunk: str):
    print(f"[stream] {chunk}")

sandbox.run(code, on_output=on_output)
```

**Current Heimdall State:** Output is batched and returned after execution completes.

**Heimdall Implementation Proposal:**

```typescript
// src/types/index.ts
interface StreamCallback {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onProgress?: (progress: { step: number; total?: number }) => void;
}

// Modify executeCode signature
async executeCode(
  code: string,
  packages?: string[],
  streaming?: StreamCallback
): Promise<ExecutionResult>;
```

**Implementation Notes:**
- Would require changes to the worker thread communication
- Could use `postMessage` to stream chunks from worker to main thread
- MCP protocol may need updates to support streaming responses

**Estimated Complexity:** Medium-High

---

### 3.3 JavaScript Runtime Support

**What it does:** Amla uses QuickJS compiled to WASM for JavaScript execution.

**Current Heimdall State:** Python (Pyodide) and Bash (just-bash). No JavaScript sandbox.

**Potential Benefits:**
- Many agent workflows are more natural in JavaScript
- Better async/await handling
- JSON manipulation is native
- Could share tools between Python and JS runtimes

**Heimdall Implementation Options:**

1. **QuickJS via WASM** (like amla-sandbox)
   - Pros: Mature, secure, small footprint
   - Cons: New dependency, different sandbox model

2. **V8 Isolates** (like Cloudflare Workers)
   - Pros: Full V8 compatibility, faster
   - Cons: Heavier, more complex isolation

3. **Deno Deploy** style
   - Pros: Modern, TypeScript native
   - Cons: Different security model

**Estimated Complexity:** High (new runtime integration)

---

### 3.4 Tool Framework Adapters

**What it does:** Import tools from popular frameworks (LangChain, OpenAI, Anthropic) automatically.

**Amla Pattern:**
```python
from amla_sandbox import from_langchain, from_openai_tools, from_anthropic_tools

# Auto-convert LangChain tools
sandbox = create_sandbox_tool(tools=from_langchain(langchain_tools))
```

**Heimdall Implementation Proposal:**

Since Heimdall is an MCP server, it could provide adapters for:
- LangChain tools → MCP tools
- OpenAI function calling format → MCP tools
- Anthropic tool format → MCP tools

```typescript
// src/adapters/langchain.ts
function fromLangChainTool(tool: LangChainTool): McpToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: convertZodToJsonSchema(tool.schema),
    handler: async (params) => tool.invoke(params),
  };
}
```

**Estimated Complexity:** Medium

---

## 4. Lower-Priority / Nice-to-Have Features

### 4.1 Persistent Virtual Filesystem State

**What it does:** State persists between execution calls within a session.

**Current Heimdall State:** Syncs between virtual and host filesystem, but state management is implicit.

**Enhancement:** Explicit session state management with snapshots and restore points.

### 4.2 Binary Data Handling

**What it does:** Base64 encoding/decoding for binary files in the sandbox.

**Current Heimdall State:** Text files work; binary file support may be incomplete.

### 4.3 WASM Precompilation/Caching

**What it does:** Amla caches compiled WASM modules for ~0.5ms subsequent loads vs ~300ms cold start.

**Heimdall Opportunity:** Pyodide already has some caching, but could be optimized further.

### 4.4 CodeAct Agent Pattern

**What it does:** Complete agent implementation that thinks in code rather than multi-turn tool calls.

**Why it's interesting:** Token efficiency through code consolidation:
```
Traditional: LLM → tool → LLM → tool → LLM → tool
CodeAct: LLM → script that does all things → result
```

---

## 5. Architecture Comparison

### Amla-Sandbox Architecture
```
┌────────────────────────────────┐
│ WASM Sandbox                   │
│ ┌──────────────────────────┐   │
│ │ Async Scheduler          │   │
│ │ tasks: waiting/running   │   │
│ └──────────────────────────┘   │
│ [VFS] [Shell] [Capabilities]   │
│ ↓ yield on tool call           │
└────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│ Python Host                     │
│ while sandbox.has_work():       │
│   req = sandbox.step()          │
│   sandbox.resume(execute(req))  │
└─────────────────────────────────┘
```

### Proposed Heimdall Architecture Enhancement
```
┌─────────────────────────────────────────────────────────────┐
│                    MCP Server Layer                          │
│  [Capability Validator] [Budget Manager] [Audit Collector]  │
└─────────────────────────────────────────────────────────────┘
         │                      │                      │
         ▼                      ▼                      ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ PyodideManager  │  │  BashManager    │  │  JSManager*     │
│ (Python WASM)   │  │ (just-bash)     │  │ (QuickJS)*      │
└─────────────────┘  └─────────────────┘  └─────────────────┘
         │                      │                      │
         └──────────────────────┴──────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │ Shared Workspace  │
                    │ (with VFS sync)   │
                    └───────────────────┘

* = future addition
```

---

## 6. Implementation Roadmap

### Phase 1: Foundation (Estimated: 2-3 weeks)
1. **Capability Types & Constraint DSL** - Define the type system
2. **Basic Capability Validation** - Method pattern matching
3. **Simple Rate Limiting** - Call budgets per tool

### Phase 2: Security Layer (Estimated: 2-3 weeks)
4. **Pre-flight Authorization** - Check before execution
5. **Constraint Evaluation** - Full DSL implementation
6. **Audit Logging** - Structured event logging

### Phase 3: Advanced Features (Estimated: 3-4 weeks)
7. **Multi-tenancy** - Tenant-scoped contexts
8. **Streaming Output** - Real-time feedback
9. **Framework Adapters** - LangChain/OpenAI integration

### Phase 4: Future (Optional)
10. **JavaScript Runtime** - QuickJS integration
11. **CodeAct Pattern** - Agent implementation
12. **Advanced Caching** - WASM precompilation

---

## 7. Key Takeaways

### Must-Have Features
1. **Capability-based authorization** - Critical for production agent deployments
2. **Rate limiting** - Prevents runaway costs and abuse
3. **Audit logging** - Essential for debugging and compliance

### Nice-to-Have Features
1. **Multi-tenancy** - Important for SaaS deployments
2. **Streaming output** - Better UX for long-running operations
3. **JavaScript runtime** - Expands use cases

### Architectural Insights
- Amla's yield/resume pattern for tool calls is elegant and could inspire similar patterns in Heimdall
- Capability-based security (like seL4) is more robust than ACL-based approaches
- Pre-flight checks save compute and provide better error messages

---

## 8. References

- [amla-sandbox GitHub](https://github.com/amlalabs/amla-sandbox)
- [Pyodide Documentation](https://pyodide.org/)
- [QuickJS Documentation](https://bellard.org/quickjs/)
- [Capability-Based Security (Wikipedia)](https://en.wikipedia.org/wiki/Capability-based_security)
- [MCP Protocol Specification](https://modelcontextprotocol.io/)
