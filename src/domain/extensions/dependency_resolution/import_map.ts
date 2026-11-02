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

import type { BareImportResolver } from "../bare_import_resolution.ts";
import { readDenoConfig } from "../deno_config.ts";
import { isBareSpecifier } from "./specifier.ts";

export type ImportMap = Record<string, string>;

export async function readConfigImports(
  denoConfigPath: string,
): Promise<ImportMap | undefined> {
  const imports = (await readDenoConfig(denoConfigPath))?.imports;
  return imports && typeof imports === "object" && !Array.isArray(imports)
    ? imports as ImportMap
    : undefined;
}

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
 * a key mapped to an npm: or jsr: package also covers its subpaths unless the
 * map has its own key/ entry, as Deno expands it
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
 * reads only an imports record, with no scopes or importMap file; for tests and
 * callers holding no module graph
 */
export function importMapResolver(imports: ImportMap): BareImportResolver {
  return {
    resolve: (_importer, specifier) => resolveBareImport(specifier, imports),
  };
}
