import * as path from "path";
import { fileURLToPath } from "url";
import * as fs from "fs";

// Get directory paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Host filesystem path to workspace directory
 */
export const WORKSPACE_DIR =
  process.env.PYODIDE_WORKSPACE || path.join(__dirname, "..", "..", "workspace");

/**
 * Virtual filesystem path to workspace directory in Pyodide
 */
export const VIRTUAL_WORKSPACE = "/workspace";

/**
 * Maximum size for a single file (10MB)
 */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Maximum total workspace size (100MB)
 */
export const MAX_WORKSPACE_SIZE = 100 * 1024 * 1024;

// Ensure workspace exists
if (!fs.existsSync(WORKSPACE_DIR)) {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}
