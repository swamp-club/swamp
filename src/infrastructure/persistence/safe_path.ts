// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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

import { dirname, join, resolve, SEPARATOR } from "@std/path";

/**
 * Error thrown when a path resolves outside its expected boundary,
 * typically due to a symlink pointing outside the repository.
 */
export class PathTraversalError extends Error {
  readonly path: string;
  readonly boundary: string;
  readonly resolvedTarget: string;

  constructor(path: string, boundary: string, resolvedTarget: string) {
    super(
      `Path traversal detected: "${path}" resolves to "${resolvedTarget}" which is outside boundary "${boundary}"`,
    );
    this.name = "PathTraversalError";
    this.path = path;
    this.boundary = boundary;
    this.resolvedTarget = resolvedTarget;
  }
}

/**
 * Resolves a path to its real filesystem location, handling the case where
 * the path (or parts of it) may not exist yet.
 *
 * If the path exists, uses `Deno.realPath()` directly. Otherwise, walks up
 * to the nearest existing ancestor, resolves that, and appends the remaining
 * non-existent segments.
 */
async function resolveRealPath(path: string): Promise<string> {
  const normalized = resolve(path);

  try {
    return await Deno.realPath(normalized);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      throw e;
    }
  }

  // Path doesn't exist — walk up to find the nearest existing ancestor
  const segments: string[] = [];
  let current = normalized;

  while (true) {
    const parent = dirname(current);
    if (parent === current) {
      // Reached filesystem root without finding an existing path;
      // fall back to the lexically resolved path
      return normalized;
    }

    segments.unshift(current.slice(parent.length + 1));
    current = parent;

    try {
      const realParent = await Deno.realPath(current);
      return join(realParent, ...segments);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) {
        throw e;
      }
      // Keep walking up
    }
  }
}

/**
 * Asserts that `path` resolves (following symlinks) to a location within
 * `boundary`.
 *
 * This protects against symlink-based path traversal attacks where a
 * directory like `.swamp/outputs` is replaced with a symlink pointing
 * outside the repository.
 *
 * The check handles paths that don't yet exist by resolving the nearest
 * existing ancestor and appending the remaining segments.
 *
 * @param path - The path to validate
 * @param boundary - The directory the path must stay within
 * @throws {PathTraversalError} if the resolved path escapes the boundary
 */
export async function assertSafePath(
  path: string,
  boundary: string,
): Promise<void> {
  const resolvedBoundary = await resolveRealPath(boundary);
  const resolvedPath = await resolveRealPath(path);

  if (
    resolvedPath !== resolvedBoundary &&
    !resolvedPath.startsWith(resolvedBoundary + SEPARATOR)
  ) {
    throw new PathTraversalError(path, boundary, resolvedPath);
  }
}
