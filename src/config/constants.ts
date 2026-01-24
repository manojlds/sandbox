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
  process.env.HEIMDALL_WORKSPACE || path.join(__dirname, "..", "..", "workspace");

/**
 * Virtual filesystem path to workspace directory in Pyodide
 */
export const VIRTUAL_WORKSPACE = "/workspace";

/**
 * Parse and validate a size limit from environment variable
 * @param envValue - Environment variable value
 * @param defaultValue - Default value in bytes
 * @param name - Name of the configuration (for error messages)
 * @returns Validated size in bytes
 */
function parseSizeLimit(envValue: string | undefined, defaultValue: number, name: string): number {
  if (!envValue) {
    return defaultValue;
  }

  const parsed = parseInt(envValue, 10);

  if (isNaN(parsed) || parsed <= 0) {
    console.error(
      `[Config] Invalid ${name}: "${envValue}". Must be a positive number. Using default: ${defaultValue} bytes`
    );
    return defaultValue;
  }

  return parsed;
}

/**
 * Parse and validate a timeout from environment variable
 * @param envValue - Environment variable value
 * @param defaultValue - Default value in milliseconds
 * @param name - Name of the configuration (for error messages)
 * @returns Validated timeout in milliseconds
 */
function parseTimeoutMs(envValue: string | undefined, defaultValue: number, name: string): number {
  if (!envValue) {
    return defaultValue;
  }

  const parsed = parseInt(envValue, 10);

  if (isNaN(parsed) || parsed <= 0) {
    console.error(
      `[Config] Invalid ${name}: "${envValue}". Must be a positive number. Using default: ${defaultValue}ms`
    );
    return defaultValue;
  }

  return parsed;
}

/**
 * Maximum size for a single file (default: 10MB)
 * Configure via HEIMDALL_MAX_FILE_SIZE environment variable (in bytes)
 */
export const MAX_FILE_SIZE = parseSizeLimit(
  process.env.HEIMDALL_MAX_FILE_SIZE,
  10 * 1024 * 1024,
  "HEIMDALL_MAX_FILE_SIZE"
);

/**
 * Maximum total workspace size (default: 100MB)
 * Configure via HEIMDALL_MAX_WORKSPACE_SIZE environment variable (in bytes)
 */
export const MAX_WORKSPACE_SIZE = parseSizeLimit(
  process.env.HEIMDALL_MAX_WORKSPACE_SIZE,
  100 * 1024 * 1024,
  "HEIMDALL_MAX_WORKSPACE_SIZE"
);

/**
 * Maximum execution time for Python code (default: 5000ms)
 * Configure via HEIMDALL_PYTHON_EXECUTION_TIMEOUT_MS environment variable
 */
export const PYTHON_EXECUTION_TIMEOUT_MS = parseTimeoutMs(
  process.env.HEIMDALL_PYTHON_EXECUTION_TIMEOUT_MS,
  5000,
  "HEIMDALL_PYTHON_EXECUTION_TIMEOUT_MS"
);

// Ensure workspace exists
if (!fs.existsSync(WORKSPACE_DIR)) {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}
