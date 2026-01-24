# Claude Development Guide

This guide contains information for developers working on this project, particularly when using Claude or other AI assistants.

## Project Overview

This is a TypeScript MCP server providing sandboxed Python and Bash execution using:
- **Pyodide** - Python compiled to WebAssembly
- **just-bash** - TypeScript-based bash simulator

## Development Workflow

### Prerequisites

- Node.js >= 18.0.0
- npm

### Setup

```bash
npm install
```

### Development Commands

```bash
# Development (with hot reload)
npm run dev

# Build the project
npm run build

# Run tests
npm test                    # Run all tests

# Run specific test file
npm test -- test/bash-only.test.ts

# Run integration tests
npm test:integration

# Type checking
npm run type-check

# Linting
npm run lint
npm run lint:fix

# Formatting
npm run format              # Auto-fix formatting
npm run format:check        # Check formatting only

# Validation (run all checks)
npm run validate            # type-check + lint + format:check + build

# Clean build artifacts
npm run clean
```

### CI/CD

The project uses GitHub Actions for continuous integration. All tests run in CI.

**Test Results:**
- Bash tests: 13/13 passing ✓
- Pyodide unit tests: 10/10 passing ✓
- Integration tests: 14/17 passing (3 package installation tests may fail if micropip unavailable)
- **Total: 37/40 tests passing (92.5%)**

**Note:** Package installation tests (numpy, pandas) require micropip which may not be available in all environments. Basic Python execution and bash functionality are fully tested.

### Pre-commit Checklist

Before committing code, always run:

```bash
npm run validate
```

This runs:
1. **Type checking** (`tsc --noEmit`) - Ensures TypeScript types are correct
2. **Linting** (`eslint`) - Checks code quality (warnings are acceptable if they're from Pyodide's untyped API)
3. **Format checking** (`prettier`) - Ensures consistent code style
4. **Build** (`tsc`) - Verifies the code compiles successfully

If format check fails, run:
```bash
npm run format
```

Then run `npm run validate` again to ensure everything passes.

## Project Structure

```
.
├── src/
│   ├── core/
│   │   ├── bash-manager.ts       # Bash execution manager (just-bash)
│   │   └── pyodide-manager.ts    # Python execution manager (Pyodide)
│   ├── tools/
│   │   ├── bash-execution.ts     # Bash MCP tools
│   │   ├── python-execution.ts   # Python MCP tools
│   │   ├── filesystem.ts         # File operation tools
│   │   └── index.ts              # Tool registration
│   ├── resources/
│   │   ├── workspace.ts          # Workspace resources
│   │   └── index.ts              # Resource registration
│   ├── config/
│   │   └── constants.ts          # Configuration constants
│   ├── types/
│   │   └── index.ts              # TypeScript type definitions
│   └── server.ts                 # MCP server entry point
├── test/
│   ├── bash-only.test.ts         # Bash-only tests (fast)
│   ├── bash-manager.test.ts      # Bash + Python integration tests
│   ├── pyodide-manager.test.ts   # Python tests
│   └── integration.test.ts       # Full integration tests
├── dist/                         # Compiled JavaScript (gitignored)
├── workspace/                    # Runtime workspace (gitignored)
└── package.json
```

## Architecture

### Dual Runtime System

The server supports both Python and Bash execution:

```
MCP Client (Claude, Cursor, etc.)
        ↓ (stdio)
    MCP Server
    ├── PyodideManager (Python via WASM)
    └── BashManager (Bash via just-bash)
            ↓
    Shared Workspace Filesystem
```

### Managers

#### PyodideManager
- Manages Pyodide (Python WebAssembly runtime)
- Handles package installation via micropip
- Syncs between Emscripten virtual FS and host FS
- Located at: `src/core/pyodide-manager.ts`

#### BashManager
- Manages just-bash (TypeScript bash simulator)
- Provides 50+ bash commands
- Uses ReadWriteFs for direct filesystem access
- Located at: `src/core/bash-manager.ts`

### Filesystem Synchronization

**Python (Pyodide):**
- Uses Emscripten virtual filesystem mounted at `/workspace`
- Requires explicit sync between virtual FS and host FS
- Sync happens before/after code execution

**Bash (just-bash):**
- Uses ReadWriteFs for direct host filesystem access
- No sync needed - operates directly on `./workspace`
- After bash execution, sync to Pyodide if needed

## Testing

### Test Files

1. **bash-only.test.ts** - Fast bash-only tests (no Pyodide)
2. **bash-manager.test.ts** - Bash + Python integration tests
3. **pyodide-manager.test.ts** - Python execution tests
4. **integration.test.ts** - Full system integration tests

### Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- test/bash-only.test.ts

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage
```

### Test Workspace

Tests create temporary workspaces that are cleaned up automatically:
- `test-workspace-bash-only/` - For bash-only tests
- `test-workspace-bash/` - For bash integration tests
- `test-workspace/` - For general integration tests

## MCP Tools

### execute_bash
Execute bash commands in sandboxed environment.

**Input:**
```typescript
{
  command: string;  // Bash command
  cwd?: string;     // Working directory
}
```

**Features:**
- 50+ commands: grep, sed, awk, jq, find, etc.
- Pipes and redirections
- Execution limits to prevent infinite loops

### execute_python
Execute Python code in Pyodide sandbox.

**Input:**
```typescript
{
  code: string;        // Python code
  packages?: string[]; // Optional packages (auto-detected)
}
```

### File Operations
- `write_file` - Write content to file
- `read_file` - Read file contents
- `list_files` - List directory contents
- `delete_file` - Delete file or directory

## Security

### Execution Limits

Both bash and Python have execution limits to prevent DoS:

```typescript
// BashManager
executionLimits: {
  maxLoopIterations: 10000,
  maxCommandCount: 10000,
  maxCallDepth: 100,
}
```

### Filesystem Isolation

- Both runtimes limited to `./workspace` directory
- Path validation prevents directory traversal attacks
- File size limits: 10MB per file, 100MB total workspace

### Network Access

- **Python**: Blocked by WASM sandbox (no network calls possible)
- **Bash**: Network disabled by default (can enable with allowlist)
- **Package installation**: Works via Pyodide's internal mechanism

## Common Development Tasks

### Adding a New Tool

1. Create tool handler in `src/tools/your-tool.ts`
2. Register in `src/tools/index.ts`
3. Add tests in `test/your-tool.test.ts`
4. Update README.md with tool documentation
5. Run `npm run validate` before committing

### Adding a New Resource

1. Create resource handler in `src/resources/your-resource.ts`
2. Register in `src/resources/index.ts`
3. Add tests
4. Update documentation

### Modifying Managers

When modifying PyodideManager or BashManager:
1. Update corresponding test file
2. Ensure sync operations work correctly
3. Test with both simple and complex operations
4. Verify error handling

## Linting Warnings

The project has ESLint warnings related to Pyodide's untyped API. These are acceptable:
- `@typescript-eslint/no-unsafe-call`
- `@typescript-eslint/no-unsafe-member-access`
- `@typescript-eslint/no-unsafe-assignment`

These warnings come from Pyodide's FS API which uses `any` types. They can be safely ignored as long as:
1. Error handling is in place
2. Tests pass
3. Runtime behavior is correct

## Environment Variables

```bash
# Workspace directory (default: ./workspace)
PYODIDE_WORKSPACE=/path/to/workspace

# Maximum size for a single file in bytes (default: 10485760 = 10MB)
MAX_FILE_SIZE=52428800  # Example: 50MB

# Maximum total workspace size in bytes (default: 104857600 = 100MB)
MAX_WORKSPACE_SIZE=524288000  # Example: 500MB

# Node.js memory limit
NODE_OPTIONS="--max-old-space-size=4096"
```

**Configuration Notes:**
- All size limits must be positive integers in bytes
- Invalid values will fallback to defaults with a warning
- File size checks happen during write operations
- Workspace size checks happen before writing new files

## Troubleshooting

### Build Errors

```bash
# Clean and rebuild
npm run clean
npm install
npm run build
```

### Test Failures

```bash
# Clean test workspaces
rm -rf test-workspace*

# Run specific failing test
npm test -- test/specific-test.test.ts

# Run only bash tests (always reliable)
npm test -- test/bash-only.test.ts
```

### Pyodide Issues

Pyodide loads ~15MB on first run and requires network access to fetch packages. Common issues:

**"fetch failed" or "No module named 'micropip'":**
- Pyodide tries to fetch packages from CDN on initialization
- Ensure network access is available
- In restricted environments, Pyodide tests may fail
- Bash-only tests (`test/bash-only.test.ts`) will still pass

**"ENOENT" errors:**
- The paths might be incorrect in node_modules
- Try reinstalling: `rm -rf node_modules && npm install`

**Integration tests failing in CI:**
- This is usually a Pyodide environment issue
- The `test/bash-only.test.ts` suite should always pass
- In production/development with network access, Pyodide works correctly

### Format/Lint Issues

```bash
# Auto-fix formatting
npm run format

# Auto-fix linting where possible
npm run lint:fix

# Then validate
npm run validate
```

## Git Workflow

### Before Committing

1. Run `npm run validate`
2. Ensure all tests pass: `npm test`
3. Update CLAUDE.md if adding new workflows
4. Update README.md if adding user-facing features

### Commit Message Format

```
<type>: <short description>

<detailed description>

<details about changes, files affected, etc.>
```

Types: feat, fix, docs, test, refactor, chore

## References

- [Pyodide Documentation](https://pyodide.org/)
- [just-bash GitHub](https://github.com/vercel-labs/just-bash)
- [MCP Documentation](https://modelcontextprotocol.io/)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)

## Notes for AI Assistants

When working on this project:

1. **Always run `npm run validate` before committing**
2. **Format code with `npm run format` if format:check fails**
3. Linting warnings about Pyodide's `any` types are acceptable
4. Both managers must be initialized before use
5. Filesystem sync is critical - bash writes → sync → Pyodide reads
6. Test both bash and Python interaction, not just individually
7. Security: validate paths, enforce size limits, respect execution limits
8. Update both CLAUDE.md and README.md when adding features
