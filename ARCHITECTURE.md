# Pyodide Sandbox MCP Server - Architecture

## Overview

This document describes the modular architecture of the Pyodide Sandbox MCP Server. The codebase was refactored from a monolithic 850-line `server.ts` file into a clean, maintainable modular structure.

## Directory Structure

```
src/
├── server.ts                      # Main entry point (53 lines)
├── config/
│   └── constants.ts              # Configuration and constants
├── core/
│   └── pyodide-manager.ts        # Pyodide lifecycle management
├── tools/
│   ├── python-execution.ts       # Python execution MCP tools
│   ├── filesystem.ts             # Filesystem MCP tools
│   └── index.ts                  # Tool registration
├── resources/
│   ├── workspace.ts              # Workspace MCP resources
│   └── index.ts                  # Resource registration
└── types/
    └── index.ts                  # Shared TypeScript interfaces
```

## Module Responsibilities

### `server.ts` - Main Entry Point

**Purpose**: Bootstrap the MCP server and coordinate all components

**Responsibilities**:

- Create MCP server instance
- Initialize PyodideManager
- Register all tools and resources
- Connect transport layer

**Key Functions**:

- `main()`: Application entry point

---

### `config/constants.ts` - Configuration

**Purpose**: Centralize all configuration constants

**Exports**:

- `WORKSPACE_DIR`: Host filesystem workspace path
- `VIRTUAL_WORKSPACE`: Virtual filesystem workspace path (`/workspace`)
- `MAX_FILE_SIZE`: Maximum single file size (10MB)
- `MAX_WORKSPACE_SIZE`: Maximum total workspace size (100MB)

**Side Effects**:

- Creates workspace directory if it doesn't exist

---

### `core/pyodide-manager.ts` - Pyodide Lifecycle

**Purpose**: Manage the Pyodide WebAssembly Python runtime

**Class**: `PyodideManager`

**Key Methods**:

- `initialize()`: Load and configure Pyodide runtime
- `executeCode(code, packages)`: Execute Python code with optional packages
- `installPackages(packages)`: Install Python packages via micropip
- `readFile(path)`: Read file from virtual filesystem
- `writeFile(path, content)`: Write file to virtual filesystem
- `listFiles(dirPath)`: List files in directory
- `deleteFile(path)`: Delete file or directory
- `syncHostToVirtual()`: Sync host filesystem to Pyodide virtual FS
- `syncVirtualToHost()`: Sync Pyodide virtual FS to host filesystem

**Private Methods**:

- `validatePath(path)`: Validate and normalize paths (security)
- `getWorkspaceSize()`: Calculate total workspace size
- `checkWorkspaceSize(size)`: Validate workspace size limits
- `doInitialize()`: Internal initialization logic

**Security Features**:

- Path traversal protection
- File size limits
- Workspace size limits
- Automatic path normalization

---

### `tools/python-execution.ts` - Python Execution Tools

**Purpose**: MCP tools for Python code execution and package management

**Function**: `registerPythonExecutionTools(server, pyodideManager)`

**Registered Tools**:

1. **`execute_python`**
   - Execute Python code in sandbox
   - Auto-load packages from imports
   - Capture stdout/stderr
   - Return execution results

2. **`install_packages`**
   - Install Python packages via micropip
   - Support pure Python and WebAssembly packages
   - Return installation results for each package

---

### `tools/filesystem.ts` - Filesystem Tools

**Purpose**: MCP tools for filesystem operations

**Function**: `registerFilesystemTools(server, pyodideManager)`

**Registered Tools**:

1. **`write_file`**
   - Write content to workspace file
   - Auto-create parent directories
   - Persist between executions

2. **`read_file`**
   - Read content from workspace file
   - Support text files

3. **`list_files`**
   - List files and directories
   - Show file sizes
   - Support subdirectories

4. **`delete_file`**
   - Delete files or empty directories
   - Sync to both virtual and host filesystems

---

### `tools/index.ts` - Tool Registration

**Purpose**: Central tool registration coordinator

**Function**: `registerAllTools(server, pyodideManager)`

**Responsibilities**:

- Import all tool modules
- Register tools in correct order
- Provide single entry point for tool registration

---

### `resources/workspace.ts` - Workspace Resources

**Purpose**: MCP resources for workspace access

**Function**: `registerWorkspaceResources(server, pyodideManager)`

**Registered Resources**:

1. **`workspace://files`**
   - List all workspace files
   - Markdown formatted output
   - Include file sizes

2. **`workspace://file/{path}`**
   - Read specific workspace file
   - Template-based URI
   - Plain text content

3. **`sandbox://info`**
   - Sandbox environment information
   - Available packages
   - Capabilities and limitations

---

### `resources/index.ts` - Resource Registration

**Purpose**: Central resource registration coordinator

**Function**: `registerAllResources(server, pyodideManager)`

**Responsibilities**:

- Import all resource modules
- Register resources in correct order
- Provide single entry point for resource registration

---

### `types/index.ts` - Type Definitions

**Purpose**: Shared TypeScript interfaces

**Exported Types**:

- `ExecutionResult`: Python code execution results
- `FileReadResult`: File read operation results
- `FileWriteResult`: File write operation results
- `PackageInstallResult`: Package installation results
- `FileInfo`: File metadata information
- `FileListResult`: Directory listing results
- `FileDeleteResult`: File deletion results

**Design Notes**:

- All interfaces extend `BaseResult` with index signature for MCP SDK compatibility
- Consistent error handling patterns
- Null-safe content fields

---

## Architecture Benefits

### 1. Separation of Concerns

Each module has a single, well-defined responsibility:

- Configuration → `config/`
- Business logic → `core/`
- MCP tools → `tools/`
- MCP resources → `resources/`
- Type definitions → `types/`

### 2. Maintainability

- Easy to locate specific functionality
- Changes are isolated to relevant modules
- Clear module boundaries

### 3. Testability

- Individual modules can be unit tested
- Dependency injection via function parameters
- Clear interfaces between components

### 4. Scalability

- Add new tools without modifying core logic
- Add new resources without touching tools
- Easy to extend configuration

### 5. Type Safety

- Centralized type definitions
- Consistent interfaces across modules
- TypeScript strict mode enabled

---

## Data Flow

### Code Execution Flow

```
User Request
    ↓
MCP Server (server.ts)
    ↓
Python Execution Tool (tools/python-execution.ts)
    ↓
PyodideManager.executeCode() (core/pyodide-manager.ts)
    ↓
Pyodide Runtime (WebAssembly)
    ↓
Virtual Filesystem (/workspace)
    ↓ (sync)
Host Filesystem (WORKSPACE_DIR)
    ↓
Execution Result
    ↓
MCP Response
```

### File Operation Flow

```
User Request
    ↓
MCP Server (server.ts)
    ↓
Filesystem Tool (tools/filesystem.ts)
    ↓
PyodideManager.writeFile/readFile() (core/pyodide-manager.ts)
    ↓
Path Validation (security)
    ↓
Virtual Filesystem (/workspace)
    ↓ (sync)
Host Filesystem (WORKSPACE_DIR)
    ↓
Operation Result
    ↓
MCP Response
```

---

## Security Model

### Path Validation

- All file paths validated by `validatePath()`
- Directory traversal attempts blocked
- Paths normalized using `path.posix.normalize()`
- Paths must be within `/workspace`

### Size Limits

- Single file: 10MB max
- Total workspace: 100MB max
- Checked before write operations

### Sandbox Isolation

- Code runs in WebAssembly sandbox
- No native system access
- No raw network sockets
- Limited to Pyodide capabilities

---

## Adding New Tools

To add a new MCP tool:

1. Create a new file in `tools/` (e.g., `tools/my-tool.ts`)
2. Export a registration function:

```typescript
export function registerMyTools(
  server: McpServer,
  pyodideManager: PyodideManager
) {
  server.registerTool("my_tool", { ... }, async (args) => { ... });
}
```

3. Import and call in `tools/index.ts`:

```typescript
import { registerMyTools } from "./my-tool.js";

export function registerAllTools(server: McpServer, pyodideManager: PyodideManager) {
  registerPythonExecutionTools(server, pyodideManager);
  registerFilesystemTools(server, pyodideManager);
  registerMyTools(server, pyodideManager); // Add here
}
```

---

## Adding New Resources

To add a new MCP resource:

1. Create a new file in `resources/` (e.g., `resources/my-resource.ts`)
2. Export a registration function:

```typescript
export function registerMyResources(
  server: McpServer,
  pyodideManager: PyodideManager
) {
  server.registerResource("my-resource", "my://uri", { ... }, async () => { ... });
}
```

3. Import and call in `resources/index.ts`:

```typescript
import { registerMyResources } from "./my-resource.js";

export function registerAllResources(server: McpServer, pyodideManager: PyodideManager) {
  registerWorkspaceResources(server, pyodideManager);
  registerMyResources(server, pyodideManager); // Add here
}
```

---

## Build and Development

### Build

```bash
npm run build        # Compile TypeScript to dist/
```

### Development

```bash
npm run dev          # Run with tsx (no compilation)
```

### Testing

```bash
npm run test                # Run unit tests
npm run test:integration    # Run integration tests
npm run test:coverage       # Run with coverage
```

### Code Quality

```bash
npm run lint         # Check code style
npm run format       # Fix formatting
npm run type-check   # TypeScript type checking
npm run validate     # Run all checks + build
```

---

## Migration Notes

### Breaking Changes

None. The refactoring preserves all existing functionality.

### API Compatibility

- All MCP tools remain unchanged
- All MCP resources remain unchanged
- Tool and resource names identical
- Input/output schemas unchanged

### Testing

- All existing tests pass
- Build succeeds without errors
- Integration tests verify functionality

---

## Future Improvements

### Potential Enhancements

1. **Add unit tests for individual modules**
   - Test PyodideManager methods
   - Test tool handlers
   - Test resource handlers

2. **Add configuration file support**
   - Allow customizing limits via config file
   - Support environment-specific settings

3. **Add logging module**
   - Structured logging
   - Log levels
   - Log rotation

4. **Add metrics/monitoring**
   - Track execution times
   - Monitor workspace usage
   - Package installation stats

5. **Extend filesystem operations**
   - Copy files
   - Move files
   - Search files

---

## References

- [MCP SDK Documentation](https://modelcontextprotocol.io)
- [Pyodide Documentation](https://pyodide.org)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)
