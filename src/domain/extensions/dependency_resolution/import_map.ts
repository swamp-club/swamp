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

/**
 * A Deno config's top-level `imports`, read as data: the one place swamp
 * reads an import map itself (swamp-club#3969). Push resolves bare imports
 * through Deno's module graph, which applies scopes, an `importMap` file and
 * workspaces; this reader serves only the two callers that compare against,
 * or fall back to, the plain map: the package cache key and the bundler's
 * zod fallback.
 */

import type { BareImportResolver } from "../bare_import_resolution.ts";
import { readDenoConfig } from "../deno_config.ts";
import { isBareSpecifier } from "./specifier.ts";

/** A `deno.json` `imports` object. */
export type ImportMap = Record<string, string>;

/** The config's top-level `imports`; undefined when it has none. */
export async function readConfigImports(
  denoConfigPath: string,
): Promise<ImportMap | undefined> {
  const imports = (await readDenoConfig(denoConfigPath))?.imports;
  return imports && typeof imports === "object" && !Array.isArray(imports)
    ? imports as ImportMap
    : undefined;
}

/**
 * What an import map resolves a bare specifier to, when that target is an
 * explicit specifier an author can write in its place (`npm:`, `jsr:`, a
 * URL or a relative path). An exact key wins; otherwise the longest key
 * ending in `/` that prefixes the specifier, with the rest appended, as
 * import maps resolve. Undefined when the map has no usable entry.
 */
export function importMapTarget(
  specifier: string,
  imports: Record<string, string> | undefined,
): string | undefined {
  if (!imports) return undefined;
  let target: string | undefined = imports[specifier];
  if (target === undefined) {
    let bestKey = "";
    for (const key of Object.keys(imports)) {
      if (
        key.endsWith("/") && specifier.startsWith(key) &&
        key.length > bestKey.length
      ) {
        bestKey = key;
      }
    }
    if (bestKey) {
      target = imports[bestKey] + specifier.slice(bestKey.length);
    }
  }
  if (typeof target !== "string" || isBareSpecifier(target)) return undefined;
  return target;
}

/**
 * What the import map resolves a bare specifier to, as the bundler
 * resolves it: {@link importMapTarget}, where a key mapped to an `npm:` or
 * `jsr:` package also covers its subpaths (`"@std/path"` resolves
 * `@std/path/posix`) unless the map has its own `key/` entry, as Deno
 * expands it.
 */
export function resolveBareImport(
  specifier: string,
  imports: ImportMap,
): string | undefined {
  const expanded: ImportMap = { ...imports };
  for (const [key, target] of Object.entries(imports)) {
    if (
      !key.endsWith("/") && typeof target === "string" &&
      /^(?:npm|jsr):/.test(target) && !Object.hasOwn(imports, `${key}/`)
    ) {
      expanded[`${key}/`] = `${target}/`;
    }
  }
  return importMapTarget(specifier, expanded);
}

/**
 * A resolver reading only an `imports` record, the same for every importer:
 * no scopes, no `importMap` file. For tests and callers that hold no module
 * graph; push resolves through the graph (swamp-club#3612).
 */
export function importMapResolver(imports: ImportMap): BareImportResolver {
  return {
    resolve: (_importer, specifier) => resolveBareImport(specifier, imports),
  };
}
