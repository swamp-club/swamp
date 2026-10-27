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
 * The `npm:` and `jsr:` dependencies an extension's source imports, read
 * the same way by push and by the registry's scorecard.
 */

import { importedSpecifiers } from "../source/imports.ts";

/** A package registry the audit checks. */
export type DependencyRegistry = "npm" | "jsr";

/** One dependency an import names. */
export interface DependencySpecifier {
  name: string;
  version: string | null;
  registry: DependencyRegistry;
  sourceFile: string;
  /**
   * The bare specifier the source wrote, when the import map resolved it
   * to this one; absent for an import written as `npm:` or `jsr:`.
   */
  importedAs?: string;
  /**
   * The version installed in a package.json project's node_modules, which
   * the bundle inlines, when the import resolved to it; `version` is then
   * the range package.json declares (swamp-club#3630).
   */
  installedVersion?: string;
}

// `npm:@scope/name@version`, `npm:name@version`, `npm:name`; a subpath is dropped
const NPM_SPECIFIER_RE =
  /^npm:(?<name>(?:@[^/@]+\/)?[^/@]+)(?:@(?<version>[^/]+))?/;

// `jsr:@scope/name@version`, `jsr:name@version`; an unscoped name is kept so
// the audit reports it as an invalid JSR name rather than skipping it
const JSR_SPECIFIER_RE =
  /^jsr:(?<name>(?:@[^/@]+\/)?[^/@]+)(?:@(?<version>[^/]+))?/;

/** zod is externalized by the bundler — not a real extension dependency. */
const EXCLUDED_NPM_PACKAGES: ReadonlySet<string> = new Set(["zod"]);

/** A JSR package name: `@scope/name`, lowercase alphanumerics and hyphens. */
export const JSR_NAME_RE = /^@[a-z0-9-]+\/[a-z0-9-]+$/;

/** npm's naming rules, uppercase allowed for legacy names. */
export const NPM_NAME_RE =
  /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

/**
 * The package an `npm:` or `jsr:` specifier names, or null for anything
 * else and for an excluded package.
 */
export function parseSpecifier(
  raw: string,
):
  | { name: string; version: string | null; registry: DependencyRegistry }
  | null {
  if (raw.startsWith("npm:")) {
    const match = NPM_SPECIFIER_RE.exec(raw);
    if (!match?.groups) return null;
    const name = match.groups.name;
    if (EXCLUDED_NPM_PACKAGES.has(name)) return null;
    return { name, version: match.groups.version ?? null, registry: "npm" };
  }
  if (raw.startsWith("jsr:")) {
    const match = JSR_SPECIFIER_RE.exec(raw);
    if (!match?.groups) return null;
    return {
      name: match.groups.name,
      version: match.groups.version ?? null,
      registry: "jsr",
    };
  }
  return null;
}

/** The specifier as the source writes it, without any subpath. */
export function specifierText(
  spec: Pick<DependencySpecifier, "registry" | "name" | "version">,
): string {
  return `${spec.registry}:${spec.name}${
    spec.version !== null ? `@${spec.version}` : ""
  }`;
}

/**
 * A specifier's identity for deduplication: an installed package.json
 * dependency ships pinned to its installed version, so two installed copies
 * under one declared range are two dependencies (swamp-club#3793).
 */
export function specifierKey(
  spec: Pick<
    DependencySpecifier,
    "registry" | "name" | "version" | "installedVersion"
  >,
): string {
  const key = `${spec.registry}:${spec.name}@${spec.version ?? ""}`;
  return spec.installedVersion === undefined
    ? key
    : `${key}#${spec.installedVersion}`;
}

/**
 * The `npm:` and `jsr:` dependencies a module writes out in import
 * position: static, side-effect and dynamic imports and re-exports, read
 * from the module's syntax tree (`sourceFile` picks TypeScript or
 * JavaScript), so a commented-out import or a specifier-shaped string is
 * never audited. A module that does not parse writes none. Each appears
 * once, in source order.
 */
export function writtenSpecifiers(
  source: string,
  sourceFile: string,
): DependencySpecifier[] {
  const seen = new Set<string>();
  const results: DependencySpecifier[] = [];
  for (const raw of importedSpecifiers(source, { path: sourceFile })) {
    const parsed = parseSpecifier(raw);
    if (!parsed) continue;
    const key = specifierKey(parsed);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ ...parsed, sourceFile });
  }
  return results;
}

/** File extensions of code modules whose imports the audit reads. */
export const CODE_FILE_EXTENSIONS: readonly string[] = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

/**
 * Whether an archive path is a code module the audit and the secret-docs
 * check read: a code file that is not a test.
 */
export function isAuditedCodeFile(path: string): boolean {
  const lower = path.toLowerCase();
  if (!CODE_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return false;
  return !/[._]test\.[cm]?[jt]sx?$/.test(lower);
}

/** Sorts dependencies by registry, name and version, as the audit reports them. */
export function compareSpecifiers(
  a: Pick<DependencySpecifier, "registry" | "name" | "version">,
  b: Pick<DependencySpecifier, "registry" | "name" | "version">,
): number {
  return a.registry.localeCompare(b.registry) ||
    a.name.localeCompare(b.name) ||
    (a.version ?? "").localeCompare(b.version ?? "");
}
