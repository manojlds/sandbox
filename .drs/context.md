# Pyodide Sandbox MCP Server Project Context (Review Focus)

## What This Project Is
A TypeScript MCP (Model Context Protocol) server providing sandboxed Python code execution using Pyodide (Python compiled to WebAssembly). It enables secure Python code execution in an isolated environment with virtual filesystem support.

## Core Architecture
- MCP server implementation in `src/server.ts` using `@modelcontextprotocol/sdk`.
- Pyodide runtime manager handles Python execution lifecycle.
- Virtual filesystem syncs between Pyodide's WASM environment and host filesystem.
- Workspace management provides persistent file storage.
- Integration tests in `src/integration.test.ts`.

## Key Components
- **PyodideManager**: Manages Python runtime initialization and lifecycle.
- **MCP Tools**: `execute_python`, `install_packages`, `write_file`, `read_file`, `list_files`, `delete_file`.
- **MCP Resources**: Workspace file access via URI patterns.
- **Virtual Filesystem**: Bidirectional sync between host `workspace/` and Pyodide's `/workspace`.

## Security Model
- Python code runs in WebAssembly sandbox (memory-isolated).
- Network access is blocked by WASM runtime (except for package installation via Pyodide's trusted mechanism).
- No direct host filesystem access (only through workspace directory).
- User code cannot make arbitrary network requests.

## Dependencies & Tech Stack
- TypeScript with strict mode
- Node.js >= 18.0.0
- @modelcontextprotocol/sdk for MCP implementation
- Pyodide ^0.26.0 for Python runtime
- Zod for schema validation

## Build & Test
- Build: `npm run build` (TypeScript compilation to dist/)
- Test: `npm test` (integration tests)
- Dev: `npm run dev` (tsx with hot reload)

## Review Focus
- Review only the diff and its direct impact.
- Prioritize correctness, safety (especially security boundaries), clarity, and maintainability.
- Pay special attention to:
  - Filesystem security (workspace isolation)
  - Error handling in async operations
  - Resource cleanup (Python runtime, file handles)
  - MCP protocol compliance
  - WebAssembly/Pyodide integration patterns
- Avoid flagging standard TypeScript/Node.js patterns unless they introduce real risk.
