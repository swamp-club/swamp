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
 * What push refuses from above swamp's boundary (swamp-club#3971): a
 * config Deno would discover there and use to resolve one of the
 * extension's bare imports, and a package Deno would read from a
 * node_modules there. Push passes `--no-config`, so neither reaches the
 * bundle; the refusal names the file and the fix rather than leaving the
 * import to fail.
 */

import { resolve, SEPARATOR, SEPARATOR_PATTERN } from "@std/path";
import type { AncestorConfig } from "./extension_project.ts";
import { readConfigImports, resolveBareImport } from "./import_map.ts";

/** The package a bare specifier names: `@scope/name` or `name`. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const PACKAGE_JSON_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

async function packageJsonDependencyNames(path: string): Promise<Set<string>> {
  let json: unknown;
  try {
    json = JSON.parse(await Deno.readTextFile(path));
  } catch {
    return new Set();
  }
  const names = new Set<string>();
  for (const field of PACKAGE_JSON_DEPENDENCY_FIELDS) {
    const deps = (json as Record<string, unknown> | null)?.[field];
    if (deps && typeof deps === "object" && !Array.isArray(deps)) {
      for (const name of Object.keys(deps)) names.add(name);
    }
  }
  return names;
}

/**
 * The bare specifiers an ancestor config would resolve: those its
 * deno.json `imports` map, or whose package its package.json declares. A
 * workspace root above the boundary applies to its member whatever it
 * maps, so every specifier counts and none need be written.
 */
export async function ancestorConfigResolves(
  ancestor: AncestorConfig,
  bareSpecifiers: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(bareSpecifiers)].sort();
  switch (ancestor.kind) {
    case "workspace-root":
      return unique;
    case "deno-config": {
      const imports = await readConfigImports(ancestor.path) ?? {};
      return unique.filter((s) => resolveBareImport(s, imports) !== undefined);
    }
    case "package-json": {
      const declared = await packageJsonDependencyNames(ancestor.path);
      return unique.filter((s) => declared.has(packageNameOf(s)));
    }
  }
}

/** The refusal for an ancestor config, naming it, what it maps and the fix. */
export function ancestorConfigRefusal(
  ancestor: AncestorConfig,
  resolves: readonly string[],
  repoDir: string,
): string {
  if (ancestor.kind === "workspace-root") {
    return `Push found the workspace root ${ancestor.path} above ` +
      `${repoDir}. Deno would apply its imports and lock to this ` +
      `extension, but it is outside the repository, so push cannot use it. ` +
      `Move the workspace root inside the repository, or push from the ` +
      `workspace root's own repository.`;
  }
  const names = resolves.map((s) => `"${s}"`).join(", ");
  const fix = ancestor.kind === "package-json"
    ? "Add a package.json inside the repository that declares"
    : "Add a deno.json inside the repository that maps";
  return `Push found ${ancestor.path} above ${repoDir}. Deno would use it ` +
    `to resolve ${names}, but it is outside the repository, so push ` +
    `ignores it (--no-config). ${fix} ${
      resolves.length === 1 ? "the import" : "the imports"
    }, or write the specifier in full.`;
}

function isSameOrUnder(path: string, root: string): boolean {
  if (path === root) return true;
  const rest = path.startsWith(root) ? path.slice(root.length) : undefined;
  return rest !== undefined && SEPARATOR_PATTERN.test(rest[0] ?? "");
}

/**
 * The package directories from `packageDirs` whose node_modules sits above
 * `boundary`: a node_modules inside the repository serves the extension, a
 * hoisted monorepo install included, one above it does not.
 */
export function nodeModulesAboveBoundary(
  packageDirs: readonly string[],
  boundary: string,
): string[] {
  const root = resolve(boundary);
  return [...new Set(packageDirs)].filter((dir) =>
    !isSameOrUnder(resolve(dir), root)
  ).sort();
}

/** The refusal for packages read from a node_modules above the repository. */
export function ancestorNodeModulesRefusal(
  packageDirs: readonly string[],
  repoDir: string,
  packageJsonDir: string | undefined,
): string {
  const where = packageJsonDir
    ? `${packageJsonDir}${SEPARATOR}package.json`
    : "a package.json inside the repository";
  return `Push found ${packageDirs.join(", ")} in a node_modules above ` +
    `${repoDir}. Deno resolves ${
      packageDirs.length === 1 ? "it" : "them"
    } there, but it is outside the repository, so the bundle would ship ` +
    `code no file in the repository declares. Declare ${
      packageDirs.length === 1 ? "the package" : "the packages"
    } in ${where} and install ${
      packageDirs.length === 1 ? "it" : "them"
    }, or write the specifier in full.`;
}
