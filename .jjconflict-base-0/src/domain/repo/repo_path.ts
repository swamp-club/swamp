import { isAbsolute, resolve } from "@std/path";

/**
 * RepoPath is a value object representing a validated repository path.
 *
 * The path is always stored as an absolute path.
 */
export class RepoPath {
  private constructor(readonly value: string) {}

  /**
   * Creates a RepoPath from a path string.
   * Converts relative paths to absolute paths using the current working directory.
   *
   * @param path - The path string
   * @returns A new RepoPath instance
   * @throws Error if the path is empty
   */
  static create(path: string): RepoPath {
    const trimmed = path.trim();
    if (trimmed.length === 0) {
      throw new Error("Repository path cannot be empty");
    }

    // Convert to absolute if relative
    const absolutePath = isAbsolute(trimmed) ? trimmed : resolve(trimmed);

    return new RepoPath(absolutePath);
  }

  /**
   * Checks equality with another RepoPath.
   */
  equals(other: RepoPath): boolean {
    return this.value === other.value;
  }

  /**
   * Returns the path as a string.
   */
  toString(): string {
    return this.value;
  }
}
