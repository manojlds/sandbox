/**
 * SecureFs - Secure filesystem wrapper with symlink protection
 *
 * Wraps ReadWriteFs to add symlink validation before all file operations.
 * Prevents symlink-based path traversal attacks by resolving real paths
 * and ensuring they stay within the workspace directory.
 *
 * @see SECURITY-REVIEW.md for security details
 */

import {
  ReadWriteFs,
  type CpOptions,
  type FsStat,
  type IFileSystem,
  type MkdirOptions,
  type RmOptions,
  type FileContent,
  type BufferEncoding,
} from "just-bash";
import * as fs from "fs";
import * as path from "path";

// DirentEntry type for readdirWithFileTypes
interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

// ReadFileOptions and WriteFileOptions interfaces
interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}

interface WriteFileOptions {
  encoding?: BufferEncoding;
}

export interface SecureFsOptions {
  /**
   * The root directory on the real filesystem.
   * All paths are relative to this root and cannot escape it.
   */
  root: string;
}

/**
 * Error thrown when a symlink attack is detected
 */
export class SymlinkSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SymlinkSecurityError";
  }
}

/**
 * SecureFs wraps ReadWriteFs with symlink protection
 *
 * Before every file operation, it validates that the resolved real path
 * stays within the workspace directory. This prevents:
 * - Direct symlinks pointing outside workspace
 * - Nested symlink chains escaping workspace
 * - Parent directory symlinks
 * - Relative symlinks that escape
 */
export class SecureFs implements IFileSystem {
  private readonly inner: ReadWriteFs;
  private readonly root: string;
  private readonly resolvedRoot: string;

  constructor(options: SecureFsOptions) {
    this.root = path.resolve(options.root);

    // Resolve the root path itself (in case it's a symlink)
    try {
      this.resolvedRoot = fs.realpathSync(this.root);
    } catch {
      // If root doesn't exist yet, use the absolute path
      this.resolvedRoot = this.root;
    }

    this.inner = new ReadWriteFs({ root: this.root });
  }

  /**
   * Convert a virtual path to a real filesystem path
   */
  private toRealPath(virtualPath: string): string {
    // Normalize the virtual path
    const normalized = path.posix.normalize(virtualPath);

    // Join with root
    return path.join(this.root, normalized);
  }

  /**
   * Validate that a path doesn't escape the workspace via symlinks
   *
   * SECURITY: This is the core protection against symlink attacks.
   * It resolves ALL symlinks in the path and verifies the final
   * real path is within the workspace directory.
   */
  private async validatePath(virtualPath: string): Promise<void> {
    const hostPath = this.toRealPath(virtualPath);

    try {
      // Resolve all symlinks to get the real path
      const realPath = await fs.promises.realpath(hostPath);

      // Check if the real path is within the workspace
      if (!this.isWithinWorkspace(realPath)) {
        throw new SymlinkSecurityError(
          `Security violation: Path resolves outside workspace. ` + `Symlink attack detected.`
        );
      }
    } catch (error) {
      if (error instanceof SymlinkSecurityError) {
        throw error;
      }

      // For ENOENT (file doesn't exist), validate parent directories
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.validateParentPath(hostPath);
        return;
      }

      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Validate parent directories for paths that don't exist yet
   *
   * SECURITY: When creating new files, we need to ensure that
   * parent directories aren't symlinks pointing outside workspace.
   */
  private async validateParentPath(hostPath: string): Promise<void> {
    let currentPath = hostPath;

    // Walk up the directory tree until we find an existing path
    while (currentPath !== this.root && currentPath !== path.dirname(currentPath)) {
      currentPath = path.dirname(currentPath);

      try {
        const realPath = await fs.promises.realpath(currentPath);

        if (!this.isWithinWorkspace(realPath)) {
          throw new SymlinkSecurityError(
            `Security violation: Parent directory resolves outside workspace. ` +
              `Symlink attack detected.`
          );
        }

        // Found a valid existing parent
        return;
      } catch (error) {
        if (error instanceof SymlinkSecurityError) {
          throw error;
        }

        // Continue up the tree if this path doesn't exist
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
  }

  /**
   * Check if a real path is within the workspace
   */
  private isWithinWorkspace(realPath: string): boolean {
    const normalizedReal = path.normalize(realPath);
    const normalizedRoot = path.normalize(this.resolvedRoot);

    return (
      normalizedReal === normalizedRoot || normalizedReal.startsWith(normalizedRoot + path.sep)
    );
  }

  /**
   * Validate symlink creation doesn't point outside workspace
   *
   * SECURITY: Block creation of symlinks that point to external targets
   */
  private async validateSymlinkTarget(target: string, linkPath: string): Promise<void> {
    // Get the directory where the symlink will be created
    const linkDir = path.dirname(this.toRealPath(linkPath));

    // Resolve the target relative to the link's directory
    let absoluteTarget: string;
    if (path.isAbsolute(target)) {
      absoluteTarget = target;
    } else {
      absoluteTarget = path.resolve(linkDir, target);
    }

    // Check if target is within workspace
    if (!this.isWithinWorkspace(absoluteTarget)) {
      throw new SymlinkSecurityError(
        `Security violation: Cannot create symlink pointing outside workspace.`
      );
    }

    // Also try to resolve the target if it exists
    try {
      const realTarget = await fs.promises.realpath(absoluteTarget);
      if (!this.isWithinWorkspace(realTarget)) {
        throw new SymlinkSecurityError(
          `Security violation: Symlink target resolves outside workspace.`
        );
      }
    } catch (error) {
      // Target doesn't exist yet - just check the absolute path
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  // ============================================================
  // IFileSystem Implementation - All methods validate symlinks
  // ============================================================

  async readFile(filePath: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    await this.validatePath(filePath);
    return this.inner.readFile(filePath, options);
  }

  async readFileBuffer(filePath: string): Promise<Uint8Array> {
    await this.validatePath(filePath);
    return this.inner.readFileBuffer(filePath);
  }

  async writeFile(
    filePath: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    await this.validatePath(filePath);
    return this.inner.writeFile(filePath, content, options);
  }

  async appendFile(
    filePath: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding
  ): Promise<void> {
    await this.validatePath(filePath);
    return this.inner.appendFile(filePath, content, options);
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await this.validatePath(filePath);
      return this.inner.exists(filePath);
    } catch (error) {
      if (error instanceof SymlinkSecurityError) {
        // Symlinks outside workspace "don't exist" from our perspective
        return false;
      }
      throw error;
    }
  }

  async stat(filePath: string): Promise<FsStat> {
    await this.validatePath(filePath);
    return this.inner.stat(filePath);
  }

  async lstat(filePath: string): Promise<FsStat> {
    // For lstat, we validate the parent but allow checking the symlink itself
    const hostPath = this.toRealPath(filePath);
    await this.validateParentPath(hostPath);
    return this.inner.lstat(filePath);
  }

  async mkdir(filePath: string, options?: MkdirOptions): Promise<void> {
    await this.validatePath(filePath);
    return this.inner.mkdir(filePath, options);
  }

  async readdir(filePath: string): Promise<string[]> {
    await this.validatePath(filePath);
    return this.inner.readdir(filePath);
  }

  async readdirWithFileTypes(filePath: string): Promise<DirentEntry[]> {
    await this.validatePath(filePath);
    return this.inner.readdirWithFileTypes(filePath);
  }

  async rm(filePath: string, options?: RmOptions): Promise<void> {
    // For removal, check if it's a symlink first
    const hostPath = this.toRealPath(filePath);

    try {
      const lstats = await fs.promises.lstat(hostPath);

      if (lstats.isSymbolicLink()) {
        // For symlinks, validate the parent path (where the symlink lives)
        await this.validateParentPath(hostPath);
        // Allow removing symlinks that point outside (cleaning up attack artifacts)
      } else {
        // For regular files/directories, validate the full path
        await this.validatePath(filePath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // File doesn't exist - let the underlying fs handle the error
        if (!options?.force) {
          return this.inner.rm(filePath, options);
        }
        return;
      }
      throw error;
    }

    return this.inner.rm(filePath, options);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    await this.validatePath(src);
    await this.validatePath(dest);
    return this.inner.cp(src, dest, options);
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.validatePath(src);
    await this.validatePath(dest);
    return this.inner.mv(src, dest);
  }

  resolvePath(base: string, relativePath: string): string {
    return this.inner.resolvePath(base, relativePath);
  }

  getAllPaths(): string[] {
    return this.inner.getAllPaths();
  }

  async chmod(filePath: string, mode: number): Promise<void> {
    await this.validatePath(filePath);
    return this.inner.chmod(filePath, mode);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    // SECURITY: Validate both the link location and target
    await this.validatePath(linkPath);
    await this.validateSymlinkTarget(target, linkPath);
    return this.inner.symlink(target, linkPath);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    await this.validatePath(existingPath);
    await this.validatePath(newPath);
    return this.inner.link(existingPath, newPath);
  }

  async readlink(filePath: string): Promise<string> {
    // Validate the symlink itself exists within workspace
    const hostPath = this.toRealPath(filePath);
    await this.validateParentPath(hostPath);
    return this.inner.readlink(filePath);
  }
}
