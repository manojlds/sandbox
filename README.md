# Heimdall MCP Server

A TypeScript MCP server providing **sandboxed Python and Bash execution** using [Pyodide](https://pyodide.org/) (Python compiled to WebAssembly) and [just-bash](https://github.com/vercel-labs/just-bash).

> Named after the Norse god who guards the Bifröst bridge, Heimdall watches over code execution with security and vigilance.

## Features

- 🔒 **Secure Sandbox**: Python code runs in an isolated WebAssembly environment
- 🐚 **Bash Execution**: Run bash commands with 50+ built-in tools (grep, sed, awk, jq, find, etc.)
- 📁 **Virtual Filesystem**: Read, write, list, and delete files in a persistent workspace
- 📦 **Package Management**: Install pure Python packages via micropip
- 🔄 **Session Persistence**: Workspace files persist across executions
- ⚡ **Native Integration**: Direct Pyodide and just-bash integration (no subprocess bridge)
- 🤝 **Interoperability**: Bash and Python share the same workspace filesystem

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                   MCP Client (Cursor)                    │
└────────────────────┬─────────────────────────────────────┘
                     │ MCP Protocol (stdio)
┌────────────────────▼─────────────────────────────────────┐
│           TypeScript MCP Server (Node.js)                │
│  • @modelcontextprotocol/sdk                             │
│  • PyodideManager + BashManager                          │
│  • Virtual FS ↔ Host FS sync                             │
├──────────────────────┬──────────────────┬────────────────┤
│   Pyodide (WASM)     │  just-bash (TS)  │  Shared FS     │
│  • Python runtime    │  • Bash simulator│  • ./workspace │
│  • /workspace mount  │  • 50+ commands  │  • Persistence │
└──────────────────────┴──────────────────┴────────────────┘
```

## Prerequisites

- **Node.js** >= 18.0.0

## Installation

```bash
cd mcp/heimdall
npm install
```

## Usage

### Development (with hot reload)

```bash
npm run dev
```

### Production

```bash
npm run build
npm start
```

### Cursor MCP Configuration

Add to your Cursor settings (`~/.cursor/mcp.json` or workspace `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "heimdall": {
      "command": "node",
      "args": ["dist/server.js"],
      "cwd": "/path/to/mcp/heimdall"
    }
  }
}
```

Or for development with `tsx`:

```json
{
  "mcpServers": {
    "heimdall": {
      "command": "npx",
      "args": ["tsx", "src/server.ts"],
      "cwd": "/path/to/mcp/heimdall"
    }
  }
}
```

## Available Tools

### `execute_bash`

Execute bash commands in the Heimdall environment using just-bash.

**Features:**
- 50+ built-in commands: grep, sed, awk, find, jq, curl, tar, etc.
- Pipes and redirections: `|`, `>`, `>>`, `2>`, `2>&1`
- Variables, loops, conditionals, and functions
- File operations: ls, cat, cp, mv, rm, mkdir, etc.
- Text processing: grep, sed, awk, cut, sort, uniq, wc, etc.
- Data tools: jq (JSON), sqlite3 (SQLite), xan (CSV), yq (YAML)

**Security:**
- No real processes spawned (TypeScript simulation)
- Execution limits prevent infinite loops
- Network access disabled by default
- Filesystem limited to workspace directory

```typescript
// Input
{
  command: string;  // Bash command to execute
  cwd?: string;     // Working directory (relative to /workspace)
}

// Output
{
  stdout: string;
  stderr: string;
  exitCode: number;
}
```

**Examples:**

```bash
# Find Python files
find . -name "*.py" -type f

# Process text files
cat data.txt | grep "pattern" | wc -l

# JSON processing
cat data.json | jq '.users[] | {name, email}'

# Multiple commands
ls -la && cat README.md | head -10

# Text processing pipeline
grep -r "TODO" src/ | sort | uniq
```

### `execute_python`

Execute Python code in the sandbox. Packages are **auto-detected** from imports.

**Note:** Network access is NOT available - Pyodide runs in WebAssembly which provides a security boundary that prevents network requests.

```typescript
// Input
{
  code: string;           // Python code to execute
  packages?: string[];    // Optional additional packages (auto-detection handles most cases)
}

// Output
{
  success: boolean;
  stdout: string;
  stderr: string;
  result: string | null;  // Last expression value
  error: string | null;
}
```

**Example:**
```python
# Packages are auto-detected - no need to specify numpy/pandas!
import numpy as np
import pandas as pd

data = np.array([1, 2, 3, 4, 5])
df = pd.DataFrame({'values': data, 'squared': data ** 2})
print(df)
```

### `install_packages`

Install Python packages via micropip.

```typescript
// Input
{
  packages: string[];  // Package names to install
}

// Output
{
  results: Array<{
    package: string;
    success: boolean;
    error: string | null;
  }>;
}
```

### `write_file`

Write content to a file in the workspace.

```typescript
// Input
{
  path: string;     // File path relative to workspace
  content: string;  // Content to write
}
```

### `read_file`

Read a file from the workspace.

```typescript
// Input
{
  path: string;  // File path relative to workspace
}
```

### `list_files`

List files in a directory.

```typescript
// Input
{
  path?: string;  // Directory path (empty for root)
}

// Output
{
  files: Array<{
    name: string;
    isDirectory: boolean;
    size: number;
  }>;
}
```

### `delete_file`

Delete a file or empty directory.

```typescript
// Input
{
  path: string;  // File or directory path
}
```

## Available Resources

| URI | Description |
|-----|-------------|
| `workspace://files` | Tree listing of workspace contents |
| `workspace://file/{path}` | Read a specific file |
| `heimdall://info` | Environment information |

## Workspace

Files are stored in the `workspace/` directory.

### Configuration

Customize the server behavior with environment variables:

```json
{
  "mcpServers": {
    "heimdall": {
      "command": "node",
      "args": ["dist/server.js"],
      "cwd": "/path/to/mcp/heimdall",
      "env": {
        "HEIMDALL_WORKSPACE": "/custom/workspace/path",
        "HEIMDALL_MAX_FILE_SIZE": "52428800",
        "HEIMDALL_MAX_WORKSPACE_SIZE": "524288000",
        "HEIMDALL_PYTHON_EXECUTION_TIMEOUT_MS": "5000"
      }
    }
  }
}
```

**Available environment variables:**

| Variable | Description | Default | Format |
|----------|-------------|---------|--------|
| `HEIMDALL_WORKSPACE` | Path to workspace directory | `./workspace` | Absolute or relative path |
| `HEIMDALL_MAX_FILE_SIZE` | Maximum size for a single file | `10485760` (10MB) | Bytes (positive integer) |
| `HEIMDALL_MAX_WORKSPACE_SIZE` | Maximum total workspace size | `104857600` (100MB) | Bytes (positive integer) |
| `HEIMDALL_PYTHON_EXECUTION_TIMEOUT_MS` | Python execution timeout | `5000` | Milliseconds (positive integer) |

**Example:** To allow 50MB files and 500MB total workspace:
- `HEIMDALL_MAX_FILE_SIZE`: `52428800` (50 * 1024 * 1024)
- `HEIMDALL_MAX_WORKSPACE_SIZE`: `524288000` (500 * 1024 * 1024)

## Security

### Network Access

**Python code cannot make network requests.** Pyodide runs in WebAssembly which provides a security boundary that prevents:
- HTTP/HTTPS requests from Python code
- Socket connections
- Any external network communication initiated by user code

This is enforced by the WASM runtime itself. Code that attempts to make network requests will fail with an error.

### How Package Installation Works

Package installation (`micropip.install()`) works because it uses **Pyodide's internal mechanism** which operates at the JavaScript/Node.js layer, not Python:

```
micropip.install("numpy")  →  Pyodide (JS)  →  Node.js fetch()  →  PyPI
```

This is intentional - packages can be installed via Pyodide's trusted mechanism, but user code cannot make arbitrary network requests.

### What Works vs What's Blocked

| ✅ Available | ❌ Blocked |
|-------------|-----------|
| Package installation (micropip) | `urllib.request.urlopen()` |
| File I/O (workspace) | `requests.get()` |
| Data processing (numpy, pandas) | Socket connections |
| URL parsing (`urllib.parse`) | External API calls |
| `loadPackagesFromImports()` | Data exfiltration |

## Available Packages

Pyodide includes many popular packages:

### Pre-installed
- Standard library (os, sys, json, re, math, etc.)
- micropip (for installing more packages)

### Available via `install_packages`
- **Data Science**: numpy, pandas, scipy, scikit-learn
- **Visualization**: matplotlib, seaborn, plotly
- **HTML Parsing**: beautifulsoup4, lxml (parsing only, no fetching)
- **Text/NLP**: regex, nltk
- **Math**: sympy, statsmodels
- **Image**: pillow

### Limitations
- **No network access** (WASM security boundary)
- Packages with native C/Fortran code must have Pyodide-compatible wheels
- No multiprocessing or threading
- Memory constrained by Node.js heap

See [Pyodide Packages](https://pyodide.org/en/stable/usage/packages-in-pyodide.html) for full compatibility list.

## Project Structure

```
mcp/heimdall/
├── src/
│   └── server.ts       # MCP server with Pyodide integration
├── dist/               # Compiled JavaScript (after build)
├── workspace/          # Persistent file storage
├── package.json
├── tsconfig.json
└── README.md
```

## Development

### Build

```bash
npm run build
```

### Clean

```bash
npm run clean
```

## Bash and Python Interoperability

Bash and Python share the same workspace filesystem, enabling powerful workflows:

**Example: Bash prepares data, Python analyzes**

```bash
# Bash: Extract and clean data
cat raw_data.csv | grep -v '^#' | sort > clean_data.csv
```

```python
# Python: Analyze the cleaned data
import pandas as pd
df = pd.read_csv('/workspace/clean_data.csv')
print(df.describe())
```

**Example: Python generates data, Bash processes**

```python
# Python: Generate report data
import json
data = [{"name": "Alice", "score": 95}, {"name": "Bob", "score": 87}]
with open('/workspace/results.json', 'w') as f:
    json.dump(data, f)
```

```bash
# Bash: Extract specific fields
cat results.json | jq '.[] | select(.score > 90) | .name'
```

## Security Considerations

- ✅ Python runs in WebAssembly sandbox (memory-isolated)
- ✅ Bash uses just-bash (no real process spawning)
- ✅ No direct host filesystem access (only workspace)
- ✅ Execution limits prevent infinite loops and runaway scripts
- ✅ Limited networking capabilities
- ⚠️ Workspace files are accessible to all code executions
- ⚠️ Installed packages persist in the session

## Troubleshooting

### Slow first execution

Pyodide downloads ~15MB on first run. Subsequent runs use cached files.

### Package installation fails

Some packages aren't available in Pyodide. Check compatibility at [pyodide.org](https://pyodide.org/en/stable/usage/packages-in-pyodide.html).

### Memory errors

WebAssembly has memory limits. For large datasets, process in chunks. You can increase Node.js heap with:

```bash
NODE_OPTIONS="--max-old-space-size=4096" npm start
```

## License

MIT
