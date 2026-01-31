# Heimdall - Agent Guide

Sandboxed Python (Pyodide/WASM) and Bash (just-bash) execution MCP server.

## Essential Commands

```bash
npm install              # Setup
npm run validate         # Type-check + lint + format + build (run before committing)
npm test                 # Run all tests
npm run dev              # Start server with hot reload
```

## Before Committing

```bash
npm run validate && npm test
```

If validation fails:
```bash
npm run lint:fix         # Auto-fix lint issues
npm run format           # Auto-fix formatting
```

## Project Structure

```
src/
├── core/
│   ├── bash-manager.ts      # Bash execution (just-bash)
│   └── pyodide-manager.ts   # Python execution (Pyodide WASM)
├── tools/                   # MCP tool handlers
├── resources/               # MCP resource handlers
└── server.ts                # Entry point
test/                        # Vitest tests
```

## Key Concepts

- **BashManager**: Uses just-bash for sandboxed bash commands
- **PyodideManager**: Uses Pyodide (Python in WASM) with virtual filesystem
- **Workspace**: Shared `./workspace` directory for both runtimes
- **Filesystem sync**: Pyodide has virtual FS that syncs to host; bash operates directly on host

## Common Issues

| Problem | Fix |
|---------|-----|
| Lint errors | `npm run lint:fix && npm run format` |
| Type errors | `npm run type-check` and fix manually |
| Build failing | `npm run clean && npm install && npm run build` |
| Tests failing | `npm run test:watch` to debug |
