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
import { markErrorPaths } from "../../domain/errors.ts";

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
    markErrorPaths(this, [path, resolvedTarget, boundary]);
  }
}

export async function resolveRealPath(path: string): Promise<string> {
  const normalized = resolve(path);

  try {
    return await Deno.realPath(normalized);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      throw e;
    }
  }

  const segments: string[] = [];
  let current = normalized;

  while (true) {
    const parent = dirname(current);
    if (parent === current) {
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
    }
  }
}

/**
 * guards against a directory like .swamp/outputs being replaced by a symlink
 * pointing outside the repository; a path not yet existing resolves through its
 * nearest existing ancestor
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

/**
 * lexical check that rejects absolute paths, null bytes and .. before any
 * filesystem I/O; use it on untrusted paths from committed lockfiles
 */
export function assertContainedPath(
  relativePath: string,
  boundary: string,
): void {
  if (!relativePath || relativePath === ".") {
    throw new PathTraversalError(
      relativePath,
      boundary,
      "(empty or identity path)",
    );
  }
  if (relativePath.includes("\0")) {
    throw new PathTraversalError(
      relativePath,
      boundary,
      "(contains null byte)",
    );
  }
  if (relativePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(relativePath)) {
    throw new PathTraversalError(
      relativePath,
      boundary,
      "(absolute path)",
    );
  }
  const resolvedBoundary = resolve(boundary);
  const resolvedPath = resolve(join(resolvedBoundary, relativePath));
  if (
    resolvedPath !== resolvedBoundary &&
    !resolvedPath.startsWith(resolvedBoundary + SEPARATOR)
  ) {
    throw new PathTraversalError(relativePath, boundary, resolvedPath);
  }
}

/**
 * use before joining an identifier read from persisted data: assertSafePath
 * alone accepts a path equal to its boundary, so an empty name, . or .. would
 * slip through
 */
export function isSinglePathSegment(name: unknown): name is string {
  return typeof name === "string" && name !== "" && name !== "." &&
    name !== ".." && !name.includes("/") && !name.includes("\\") &&
    !name.includes("\0");
}
