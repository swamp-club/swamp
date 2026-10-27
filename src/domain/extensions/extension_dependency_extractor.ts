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

import {
  type DependencySpecifier,
  parseSpecifier,
  specifierKey,
  writtenSpecifiers,
} from "@swamp-club/extension-scoring/dependency-audit";
import { importedSpecifiers } from "@swamp-club/extension-scoring/source";
import type { BareImportResolver } from "./bare_import_resolution.ts";
import { isBareSpecifier } from "./dependency_resolution/specifier.ts";

/**
 * The `npm:` and `jsr:` dependencies a module imports: those it writes
 * out, and, given a resolver, the bare imports it resolves to one from
 * `sourceFile`. A dependency written both ways keeps the written form.
 */
export function extractSpecifiersFromSource(
  source: string,
  sourceFile: string,
  resolver?: BareImportResolver,
): DependencySpecifier[] {
  const results = writtenSpecifiers(source, sourceFile);
  const seen = new Set(results.map(specifierKey));

  if (!resolver) return results;

  // Bare names are read as the bare-specifiers rule reads them, from the
  // module's syntax tree, so generated code is never audited.
  for (const bare of importedSpecifiers(source, { path: sourceFile })) {
    if (!bare || !isBareSpecifier(bare)) continue;
    const target = resolver.resolve(sourceFile, bare);
    if (!target) continue;
    // A `key/` entry must write its target `npm:/name@v/` for Deno to
    // resolve it; the package is the same.
    const resolved = parseSpecifier(target.replace(/^(npm|jsr):\//, "$1:"));
    if (!resolved) continue;
    // An installed package.json dependency ships its installed version and
    // is audited at the range package.json declares, if it declares one. A
    // declaration naming another package never replaces the one that ships.
    const installed = resolver.installed?.(sourceFile, bare);
    const declaredSpec = installed?.declared
      ? parseSpecifier(installed.declared)
      : null;
    const parsed = !installed
      ? resolved
      : declaredSpec && declaredSpec.name === resolved.name
      ? { ...declaredSpec, installedVersion: installed.version }
      : { ...resolved, installedVersion: installed.version };

    const key = specifierKey(parsed);
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({ ...parsed, sourceFile, importedAs: bare });
  }

  return results;
}

/**
 * The dependencies of `sourceFiles`, which are the code modules the module
 * graph reports (TypeScript or JavaScript in any extension), so every file
 * push rewrites bare imports in is audited too (swamp-club#3637).
 */
export async function extractDependencySpecifiers(
  sourceFiles: string[],
  resolver?: BareImportResolver,
): Promise<DependencySpecifier[]> {
  const seen = new Map<string, DependencySpecifier>();

  for (const file of sourceFiles) {
    let source: string;
    try {
      source = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    for (const spec of extractSpecifiersFromSource(source, file, resolver)) {
      // Each version of a package is audited: two specifiers, or two
      // installed copies, can ship two different versions. A written
      // specifier replaces a mapped one.
      const key = specifierKey(spec);
      const existing = seen.get(key);
      if (!existing || (existing.importedAs && !spec.importedAs)) {
        seen.set(key, spec);
      }
    }
  }

  return Array.from(seen.values());
}
