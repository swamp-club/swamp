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
 * What a bare import resolves to, as Deno resolves it: the project config
 * (`deno.json` or `deno.jsonc`), an `importMap` file it references, the scope
 * covering the importing module, and a workspace root's imports. Push reads
 * the answer from the module graph Deno reports rather than reading the
 * config itself, so it never ships or audits a different target than the
 * one the extension was bundled with (swamp-club#3612).
 */

import { fromFileUrl, resolve } from "@std/path";
import { isBareSpecifier } from "../models/bundle.ts";

/** One bare import a local module writes, and what Deno resolved it to. */
export interface ResolvedBareImport {
  /** Absolute path of the importing module. */
  importer: string;
  /** The specifier as the importer writes it. */
  specifier: string;
  /**
   * The specifier Deno resolved it to (`npm:ms@2.1.2`,
   * `jsr:/@std/path@1/posix`, a `file:` or `https:` URL), or undefined when
   * Deno could not resolve it.
   */
  target?: string;
}

/**
 * Port: what a bare import resolves to from the module that writes it.
 * Undefined means unresolved: the import ships as written and the
 * bare-specifiers finding names it. An implementation never answers with a
 * target Deno would not use for that importer.
 */
export interface BareImportResolver {
  resolve(importer: string, specifier: string): string | undefined;
}

/** A resolver that resolves nothing: every bare import ships as written. */
export const NO_BARE_IMPORT_RESOLUTION: BareImportResolver = {
  resolve: () => undefined,
};

function resolutionKey(importer: string, specifier: string): string {
  return `${resolve(importer)}\0${specifier}`;
}

/**
 * A resolver answering exactly what `resolutions` records for each importer
 * and specifier; anything not recorded is unresolved.
 */
export function bareImportResolverFrom(
  resolutions: readonly ResolvedBareImport[],
): BareImportResolver {
  const targets = new Map<string, string | undefined>();
  for (const r of resolutions) {
    const key = resolutionKey(r.importer, r.specifier);
    if (!targets.has(key)) targets.set(key, r.target);
  }
  return {
    resolve: (importer, specifier) =>
      targets.get(resolutionKey(importer, specifier)),
  };
}

/** Each resolution once per importer and specifier, the first kept. */
export function uniqueBareImports(
  resolutions: readonly ResolvedBareImport[],
): ResolvedBareImport[] {
  const seen = new Set<string>();
  return resolutions.filter((r) => {
    const key = resolutionKey(r.importer, r.specifier);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface DenoInfoTarget {
  specifier?: unknown;
}

interface DenoInfoDependencyEntry {
  specifier?: unknown;
  code?: DenoInfoTarget;
  type?: DenoInfoTarget;
}

interface DenoInfoModuleEntry {
  specifier?: unknown;
  dependencies?: unknown;
}

/**
 * A `file:` module that is not an npm package installed in a node_modules
 * directory: the extension's own source.
 */
export function isLocalModuleSpecifier(
  specifier: unknown,
): specifier is string {
  return typeof specifier === "string" && specifier.startsWith("file:") &&
    !fromFileUrl(specifier).split(/[\\/]/).includes("node_modules");
}

/**
 * The bare imports each local module in `deno info --json` output writes,
 * with the specifier Deno resolved each to. A code import's resolution
 * wins over a type import's; one Deno reports an error for is unresolved.
 */
export function bareImportsFromDenoInfo(json: unknown): ResolvedBareImport[] {
  const modules = (json as { modules?: unknown })?.modules;
  if (!Array.isArray(modules)) return [];
  const found: ResolvedBareImport[] = [];
  for (const m of modules as DenoInfoModuleEntry[]) {
    if (!isLocalModuleSpecifier(m?.specifier)) continue;
    if (!Array.isArray(m.dependencies)) continue;
    const importer = fromFileUrl(m.specifier);
    for (const dep of m.dependencies as DenoInfoDependencyEntry[]) {
      const specifier = dep?.specifier;
      if (typeof specifier !== "string" || !isBareSpecifier(specifier)) {
        continue;
      }
      const resolved = (dep.code ?? dep.type)?.specifier;
      found.push(
        typeof resolved === "string"
          ? { importer, specifier, target: resolved }
          : { importer, specifier },
      );
    }
  }
  return uniqueBareImports(found);
}
