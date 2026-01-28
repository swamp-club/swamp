/**
 * SwampVersion is a value object representing a semantic version string.
 *
 * Used to track the version of swamp that initialized or upgraded a repository.
 */
export class SwampVersion {
  private constructor(
    readonly major: number,
    readonly minor: number,
    readonly patch: number,
  ) {}

  /**
   * Creates a SwampVersion from a version string.
   *
   * @param version - The version string (e.g., "0.1.0", "1.2.3")
   * @returns A new SwampVersion instance
   * @throws Error if the version string is invalid
   */
  static create(version: string): SwampVersion {
    const trimmed = version.trim();
    if (trimmed.length === 0) {
      throw new Error("Version cannot be empty");
    }

    const match = trimmed.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) {
      throw new Error(
        `Invalid version format: ${version}. Expected format: major.minor.patch (e.g., "1.0.0")`,
      );
    }

    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    const patch = parseInt(match[3], 10);

    return new SwampVersion(major, minor, patch);
  }

  /**
   * Checks equality with another SwampVersion.
   */
  equals(other: SwampVersion): boolean {
    return (
      this.major === other.major &&
      this.minor === other.minor &&
      this.patch === other.patch
    );
  }

  /**
   * Compares this version to another.
   * Returns negative if this < other, zero if equal, positive if this > other.
   */
  compareTo(other: SwampVersion): number {
    if (this.major !== other.major) {
      return this.major - other.major;
    }
    if (this.minor !== other.minor) {
      return this.minor - other.minor;
    }
    return this.patch - other.patch;
  }

  /**
   * Returns true if this version is newer than the other.
   */
  isNewerThan(other: SwampVersion): boolean {
    return this.compareTo(other) > 0;
  }

  /**
   * Returns true if this version is older than the other.
   */
  isOlderThan(other: SwampVersion): boolean {
    return this.compareTo(other) < 0;
  }

  /**
   * Returns the version as a string (e.g., "1.0.0").
   */
  toString(): string {
    return `${this.major}.${this.minor}.${this.patch}`;
  }
}
