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

import { dirname, normalize, resolve } from "@std/path";

/** Result of resolving local imports from entry points. */
export interface ImportResolverResult {
  /** All .ts files (entry points + dependencies), absolute paths. */
  resolvedFiles: string[];
  /** Non-local imports that were skipped (informational). */
  skippedImports: string[];
}

/** Pattern matching import/export from relative paths. */
const IMPORT_PATTERN =
  /(?:import|export)\s+[\s\S]*?from\s+["'](\.\.?\/[^"']+)["']/g;

/**
 * Scans .ts entry points for relative import/export statements and
 * recursively resolves local .ts dependencies within the boundary directory.
 *
 * @param entryPoints - Absolute paths to entry point .ts files
 * @param boundaryDir - Boundary directory; only files within this dir are included
 * @returns Resolved files and skipped non-local imports
 */
export async function resolveLocalImports(
  entryPoints: string[],
  boundaryDir: string,
): Promise<ImportResolverResult> {
  const normalizedBoundaryDir = normalize(boundaryDir);
  const visited = new Set<string>();
  const skippedImports = new Set<string>();

  async function visit(filePath: string): Promise<void> {
    const normalized = normalize(filePath);
    if (visited.has(normalized)) return;
    visited.add(normalized);

    // Only process files within the boundary directory
    if (!normalized.startsWith(normalizedBoundaryDir)) return;

    let content: string;
    try {
      content = await Deno.readTextFile(normalized);
    } catch {
      return; // File doesn't exist or can't be read
    }

    // Find all relative imports
    for (const match of content.matchAll(IMPORT_PATTERN)) {
      const importPath = match[1];
      const resolved = resolveImportPath(normalized, importPath);

      if (!resolved.startsWith(normalizedBoundaryDir)) {
        skippedImports.add(importPath);
        continue;
      }

      await visit(resolved);
    }
  }

  for (const entry of entryPoints) {
    await visit(entry);
  }

  return {
    resolvedFiles: [...visited].sort(),
    skippedImports: [...skippedImports].sort(),
  };
}

/**
 * Resolves a relative import path to an absolute path.
 * Appends `.ts` if no extension is present.
 */
function resolveImportPath(fromFile: string, importPath: string): string {
  const dir = dirname(fromFile);
  let resolved = resolve(dir, importPath);
  // Add .ts extension if missing
  if (!resolved.endsWith(".ts") && !resolved.endsWith(".js")) {
    resolved = resolved + ".ts";
  }
  return normalize(resolved);
}
