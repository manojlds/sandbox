/**
 * BashManager - Manages bash command execution using just-bash
 *
 * Provides a sandboxed bash environment with an in-memory virtual filesystem.
 * Commands are executed using just-bash, a TypeScript implementation of bash
 * that doesn't spawn real processes.
 */

import { Bash, ReadWriteFs } from "just-bash";
import { WORKSPACE_DIR } from "../config/constants.js";
import path from "path";

/**
 * Result of a bash command execution
 */
export interface BashExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Options for bash execution
 */
export interface BashExecutionOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * BashManager provides bash command execution in a sandboxed environment
 */
export class BashManager {
  private bash: Bash | null = null;
  private workspaceDir: string;
  private initialized = false;

  constructor(workspaceDir: string = WORKSPACE_DIR) {
    this.workspaceDir = path.resolve(workspaceDir);
  }

  /**
   * Initialize the bash manager
   */
  async initialize(): Promise<void> {
    if (this.initialized && this.bash) {
      return;
    }

    // Create ReadWriteFs backed by our workspace directory
    const fs = new ReadWriteFs({ root: this.workspaceDir });

    // Initialize bash environment
    this.bash = new Bash({
      fs,
      cwd: "/",
      // Configure execution limits to prevent DoS attacks
      executionLimits: {
        maxLoopIterations: 10000,
        maxCommandCount: 10000,
        maxCallDepth: 100,
      },
      // Network disabled by default for security
      // Can be enabled later if needed with allowlist
      network: undefined,
    });

    this.initialized = true;
  }

  /**
   * Execute a bash command
   */
  async execute(command: string, options?: BashExecutionOptions): Promise<BashExecutionResult> {
    if (!this.initialized || !this.bash) {
      await this.initialize();
    }

    if (!this.bash) {
      throw new Error("Bash manager not initialized");
    }

    try {
      // Execute the command
      const result = await this.bash.exec(command, {
        cwd: options?.cwd,
        env: options?.env,
      });

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    } catch (error) {
      // Handle execution errors
      const errorMessage = error instanceof Error ? error.message : String(error);

      return {
        stdout: "",
        stderr: errorMessage,
        exitCode: 1,
      };
    }
  }

  /**
   * Get the workspace directory
   */
  getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  /**
   * Check if the manager is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Reset the bash environment (for testing)
   */
  async reset(): Promise<void> {
    this.bash = null;
    this.initialized = false;
    await this.initialize();
  }
}
