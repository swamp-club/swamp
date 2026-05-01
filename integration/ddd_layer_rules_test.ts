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

import { assert, assertEquals } from "@std/assert";
import { walk } from "@std/fs/walk";
import { join, relative } from "@std/path";

const ROOT = join(import.meta.dirname!, "..");

/**
 * Extract import paths from a TypeScript file's source text.
 */
function extractImports(source: string): string[] {
  const importRegex = /from\s+["']([^"']+)["']/g;
  const imports: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(source)) !== null) {
    imports.push(match[1]);
  }
  return imports;
}

/**
 * Check if an import path resolves to a specific layer.
 */
function importsLayer(
  filePath: string,
  importPath: string,
  targetLayer: string,
): boolean {
  if (!importPath.startsWith(".")) return false;
  const fileDir = filePath.substring(0, filePath.lastIndexOf("/"));
  const resolved = join(fileDir, importPath);
  const rel = relative(join(ROOT, "src"), resolved);
  return rel.startsWith(targetLayer + "/");
}

/**
 * Check if an import is a logging import (cross-cutting concern, not a real violation).
 */
function isLoggingImport(filePath: string, importPath: string): boolean {
  return importsLayer(filePath, importPath, "infrastructure/logging");
}

/**
 * Check if an import is a tracing import (cross-cutting concern, not a real violation).
 */
function isTracingImport(filePath: string, importPath: string): boolean {
  return importsLayer(filePath, importPath, "infrastructure/tracing");
}

// Ratchet counts: current number of known violations.
// If someone fixes a violation, the count decreases and the test still passes.
// If someone adds a new violation, the count increases and the test fails.
//
// Stream B (Windows-GA) introduced two new cross-platform helpers in
// infrastructure (`process/resolve_command.ts` and `archive/tar_archive.ts`).
// The domain-side consumers of each — `audit/doctor/checks/resolve_binary.ts`
// and `extensions/extension_rubric_scorer.ts` — receive the helpers via
// dependency injection (a `ResolveBinary` port and an `ExtractTarball`
// port respectively, wired in by the CLI / libswamp layer at construction
// time). Domain stays infrastructure-free; the ratchet stays at 26.
const KNOWN_DOMAIN_INFRA_VIOLATIONS = 26;

Deno.test(
  "domain layer must not add new infrastructure imports (ratchet)",
  async () => {
    const domainDir = join(ROOT, "src", "domain");
    const violations: string[] = [];

    for await (
      const entry of walk(domainDir, {
        exts: [".ts"],
        includeDirs: false,
        skip: [/_test\.ts$/],
      })
    ) {
      const source = await Deno.readTextFile(entry.path);
      const imports = extractImports(source);

      for (const imp of imports) {
        if (importsLayer(entry.path, imp, "infrastructure")) {
          // Logging and tracing are cross-cutting concerns, not infrastructure dependencies
          if (isLoggingImport(entry.path, imp)) continue;
          if (isTracingImport(entry.path, imp)) continue;
          violations.push(relative(ROOT, entry.path));
          break; // Count each file only once
        }
      }
    }

    const count = violations.length;

    assert(
      count <= KNOWN_DOMAIN_INFRA_VIOLATIONS,
      `Domain→Infrastructure violation count increased from ${KNOWN_DOMAIN_INFRA_VIOLATIONS} to ${count}.\n` +
        `New violations:\n${violations.sort().join("\n")}\n\n` +
        `The domain layer should not import from infrastructure (dependency inversion principle).\n` +
        `If you fixed violations, update KNOWN_DOMAIN_INFRA_VIOLATIONS in this test.`,
    );

    if (count < KNOWN_DOMAIN_INFRA_VIOLATIONS) {
      console.log(
        `  [ratchet] Domain→Infrastructure violations decreased from ${KNOWN_DOMAIN_INFRA_VIOLATIONS} to ${count}. ` +
          `Update KNOWN_DOMAIN_INFRA_VIOLATIONS to ${count} to lock in the improvement.`,
      );
    }
  },
);

Deno.test(
  "presentation layer must not import infrastructure (excluding logging)",
  async () => {
    const presentationDir = join(ROOT, "src", "presentation");
    const violations: string[] = [];

    for await (
      const entry of walk(presentationDir, {
        exts: [".ts", ".tsx"],
        includeDirs: false,
        skip: [/_test\.ts$/],
      })
    ) {
      const source = await Deno.readTextFile(entry.path);
      const imports = extractImports(source);

      for (const imp of imports) {
        if (importsLayer(entry.path, imp, "infrastructure")) {
          // Logging and tracing are cross-cutting concerns, not infrastructure dependencies
          if (isLoggingImport(entry.path, imp)) continue;
          if (isTracingImport(entry.path, imp)) continue;
          violations.push(relative(ROOT, entry.path));
          break; // Count each file only once
        }
      }
    }

    assertEquals(
      violations.length,
      0,
      `Presentation→Infrastructure violations found (excluding logging):\n` +
        `${violations.sort().join("\n")}\n\n` +
        `The presentation layer should go through the CLI/application layer, not reach into infrastructure.\n` +
        `Logging imports (infrastructure/logging/) are excluded as a cross-cutting concern.`,
    );
  },
);
