/**
 * ModelType is a value object representing the type of a model.
 *
 * Types can be specified in various formats (e.g., AWS::EC2::VPC, docker run, swamp/echo)
 * and are normalized to a path-safe format (e.g., aws/ec2/vpc, docker/run, swamp/echo).
 */
export class ModelType {
  private constructor(
    readonly raw: string,
    readonly normalized: string,
  ) {}

  /**
   * Creates a ModelType from a raw type string.
   * Normalizes the type to a path-safe format.
   *
   * @param rawType - The raw type string (e.g., "AWS::EC2::VPC", "docker run", "swamp/echo")
   * @returns A new ModelType instance
   * @throws Error if the raw type is empty or invalid
   */
  static create(rawType: string): ModelType {
    const trimmed = rawType.trim();
    if (trimmed.length === 0) {
      throw new Error("Model type cannot be empty");
    }

    const normalized = ModelType.normalize(trimmed);
    if (normalized.length === 0) {
      throw new Error("Model type normalization resulted in empty string");
    }

    return new ModelType(trimmed, normalized);
  }

  /**
   * Normalizes a raw type string to a path-safe format.
   *
   * Conversion rules:
   * - Convert to lowercase
   * - Replace "::" with "/"
   * - Replace spaces with "/"
   * - Replace "." with "/"
   * - Remove consecutive slashes
   * - Remove leading/trailing slashes
   *
   * Examples:
   * - "AWS::EC2::VPC" -> "aws/ec2/vpc"
   * - "docker run" -> "docker/run"
   * - "Microsoft.Resources/resourceGroup" -> "microsoft/resources/resourcegroup"
   * - "swamp/echo" -> "swamp/echo"
   */
  private static normalize(raw: string): string {
    return raw
      .toLowerCase()
      .replace(/::/g, "/")
      .replace(/\s+/g, "/")
      .replace(/\./g, "/")
      .replace(/\/+/g, "/")
      .replace(/^\/|\/$/g, "");
  }

  /**
   * Returns the normalized type string (path-safe format).
   */
  toNormalized(): string {
    return this.normalized;
  }

  /**
   * Returns the directory path for storing files of this type.
   * Same as normalized, but explicitly named for clarity.
   */
  toDirectoryPath(): string {
    return this.normalized;
  }

  /**
   * Checks equality with another ModelType.
   * Two ModelTypes are equal if their normalized forms are equal.
   */
  equals(other: ModelType): boolean {
    return this.normalized === other.normalized;
  }

  /**
   * Returns the raw type string representation.
   */
  toString(): string {
    return this.raw;
  }
}
