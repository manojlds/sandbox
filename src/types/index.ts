/**
 * Base interface with index signature for MCP SDK compatibility
 */
interface BaseResult {
  [x: string]: unknown;
}

/**
 * Result from executing Python code
 */
export interface ExecutionResult extends BaseResult {
  success: boolean;
  stdout: string;
  stderr: string;
  result: string | null;
  error: string | null;
}

/**
 * Result from reading a file
 */
export interface FileReadResult extends BaseResult {
  success: boolean;
  content: string | null;
  error: string | null;
}

/**
 * Result from writing a file
 */
export interface FileWriteResult extends BaseResult {
  success: boolean;
  error: string | null;
}

/**
 * Result from installing packages
 */
export interface PackageInstallResult extends BaseResult {
  package: string;
  success: boolean;
  error: string | null;
}

/**
 * File information
 */
export interface FileInfo extends BaseResult {
  name: string;
  isDirectory: boolean;
  size: number;
}

/**
 * Result from listing files
 */
export interface FileListResult extends BaseResult {
  success: boolean;
  files: FileInfo[];
  error: string | null;
}

/**
 * Result from deleting a file
 */
export interface FileDeleteResult extends BaseResult {
  success: boolean;
  error: string | null;
}
