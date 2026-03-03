// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

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

  /**
   * Checks if a normalized type string starts with '@' (user namespace).
   */
  static isUserNamespace(normalized: string): boolean {
    return normalized.startsWith("@");
  }

  /**
   * Extracts the namespace from a user namespace type.
   * Returns the segment after '@' (e.g., "@user/foo/bar" → "user").
   * Returns undefined if not a user namespace.
   */
  static getUserNamespace(normalized: string): string | undefined {
    if (!ModelType.isUserNamespace(normalized)) {
      return undefined;
    }
    const withoutAt = normalized.slice(1);
    const slashIndex = withoutAt.indexOf("/");
    if (slashIndex === -1) {
      return withoutAt;
    }
    return withoutAt.slice(0, slashIndex);
  }

  /**
   * Returns the number of path segments in a normalized type.
   * For user namespaces, treats "@namespace" as segment 1.
   * Examples:
   * - "swamp/echo" → 2
   * - "@user/echo" → 2
   * - "@user/foo/bar" → 3
   */
  static getSegmentCount(normalized: string): number {
    if (ModelType.isUserNamespace(normalized)) {
      const withoutAt = normalized.slice(1);
      return withoutAt.split("/").filter((s) => s.length > 0).length;
    }
    return normalized.split("/").filter((s) => s.length > 0).length;
  }

  /**
   * Reserved built-in namespaces that user extensions cannot use.
   */
  private static readonly RESERVED_NAMESPACES = ["swamp", "si"];

  /**
   * Checks if a normalized type uses a reserved namespace.
   * Reserved namespaces are: swamp, si (with or without @ prefix).
   */
  static isReservedNamespace(normalized: string): boolean {
    // Check for @swamp/*, @si/*
    if (ModelType.isUserNamespace(normalized)) {
      const namespace = ModelType.getUserNamespace(normalized);
      return namespace !== undefined &&
        ModelType.RESERVED_NAMESPACES.includes(namespace);
    }
    // Check for swamp/*, si/*
    const firstSlash = normalized.indexOf("/");
    const firstSegment = firstSlash === -1
      ? normalized
      : normalized.slice(0, firstSlash);
    return ModelType.RESERVED_NAMESPACES.includes(firstSegment);
  }
}
