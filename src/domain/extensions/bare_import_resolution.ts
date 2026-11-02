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
 * push reads the answer from the module graph Deno reports rather than the
 * config itself, so it never ships or audits a different target than the one
 * the extension was bundled with
 */

import {
  dirname,
  fromFileUrl,
  relative,
  resolve,
  SEPARATOR,
  SEPARATOR_PATTERN,
} from "@std/path";
import { format, satisfies, tryParse, tryParseRange } from "@std/semver";
import { isBareSpecifier } from "./dependency_resolution/specifier.ts";

export interface ResolvedBareImport {
  importer: string;
  specifier: string;
  target?: string;
  installedFile?: string;
  installedVersion?: string;
  declared?: string;
}

/**
 * undefined means unresolved: the import ships as written and the
 * bare-specifiers finding names it. An implementation never answers with a
 * target Deno would not use for that importer.
 */
export interface BareImportResolver {
  resolve(importer: string, specifier: string): string | undefined;
  installed?(
    importer: string,
    specifier: string,
  ): { version: string; declared?: string } | undefined;
}

export const NO_BARE_IMPORT_RESOLUTION: BareImportResolver = {
  resolve: () => undefined,
};

function resolutionKey(importer: string, specifier: string): string {
  return `${resolve(importer)}\0${specifier}`;
}

export function bareImportResolverFrom(
  resolutions: readonly ResolvedBareImport[],
): BareImportResolver {
  const first = new Map<string, ResolvedBareImport>();
  for (const r of resolutions) {
    const key = resolutionKey(r.importer, r.specifier);
    if (!first.has(key)) first.set(key, r);
  }
  return {
    resolve: (importer, specifier) =>
      first.get(resolutionKey(importer, specifier))?.target,
    installed: (importer, specifier) => {
      const r = first.get(resolutionKey(importer, specifier));
      if (r?.target === undefined || r.installedVersion === undefined) {
        return undefined;
      }
      return r.declared === undefined
        ? { version: r.installedVersion }
        : { version: r.installedVersion, declared: r.declared };
    },
  };
}

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

export function denoInfoRootDir(json: unknown): string | undefined {
  const root = (json as { roots?: unknown })?.roots;
  const first = Array.isArray(root) ? root[0] : undefined;
  return typeof first === "string" && first.startsWith("file:")
    ? dirname(fromFileUrl(first))
    : undefined;
}

/**
 * only the path from rootDir (the entry point's directory) is read, so a
 * repository checked out under a directory named node_modules still has local
 * modules
 */
export function isLocalModuleSpecifier(
  specifier: unknown,
  rootDir?: string,
): specifier is string {
  if (typeof specifier !== "string" || !specifier.startsWith("file:")) {
    return false;
  }
  const path = fromFileUrl(specifier);
  return !(rootDir === undefined ? path : relative(rootDir, path))
    .split(SEPARATOR_PATTERN).includes("node_modules");
}

function isInstalledPackageFile(specifier: string, rootDir?: string): boolean {
  return specifier.startsWith("file:") &&
    !isLocalModuleSpecifier(specifier, rootDir);
}

/**
 * a code import's resolution wins over a type import's; errors and imports
 * resolved into node_modules are unresolved, since the graph names a file
 * there, not a specifier push can ship
 */
export function bareImportsFromDenoInfo(json: unknown): ResolvedBareImport[] {
  const modules = (json as { modules?: unknown })?.modules;
  if (!Array.isArray(modules)) return [];
  const rootDir = denoInfoRootDir(json);
  const found: ResolvedBareImport[] = [];
  for (const m of modules as DenoInfoModuleEntry[]) {
    if (!isLocalModuleSpecifier(m?.specifier, rootDir)) continue;
    if (!Array.isArray(m.dependencies)) continue;
    const importer = fromFileUrl(m.specifier);
    for (const dep of m.dependencies as DenoInfoDependencyEntry[]) {
      const specifier = dep?.specifier;
      if (typeof specifier !== "string" || !isBareSpecifier(specifier)) {
        continue;
      }
      const resolved = (dep.code ?? dep.type)?.specifier;
      found.push(
        typeof resolved !== "string"
          ? { importer, specifier }
          : isInstalledPackageFile(resolved, rootDir)
          ? { importer, specifier, installedFile: fromFileUrl(resolved) }
          : { importer, specifier, target: resolved },
      );
    }
  }
  return uniqueBareImports(found);
}

function packageOfBareImport(
  specifier: string,
): { name: string; subpath: string } {
  const parts = specifier.split("/");
  const length = specifier.startsWith("@") ? 2 : 1;
  return {
    name: parts.slice(0, length).join("/"),
    subpath: parts.length > length ? `/${parts.slice(length).join("/")}` : "",
  };
}

// An npm package name: lower case, URL-safe, optionally scoped. Anything
// else in an installed manifest is never written into a specifier.
const NPM_PACKAGE_NAME_RE =
  /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

// A strict semver version, with no range operators, prefix or whitespace.
const STRICT_SEMVER_RE =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * non-registry sources (file:, link:, workspace:, git, a URL, user/repo) give
 * undefined, since the registry never serves them
 */
function registryDeclaration(
  name: string,
  value: string,
): { name: string; range: string } | undefined {
  const alias = /^npm:((?:@[^/@]+\/)?[^/@]+)(?:@(.*))?$/.exec(value);
  const declared = alias
    ? { name: alias[1], range: alias[2] || "*" }
    : { name, range: value.trim() || "*" };
  if (
    !NPM_PACKAGE_NAME_RE.test(declared.name) || /[:/\\]/.test(declared.range)
  ) {
    return undefined;
  }
  return declared;
}

function declaredDependency(
  packageJson: unknown,
  name: string,
): string | undefined {
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = (packageJson as Record<string, unknown> | null)?.[field];
    if (!deps || typeof deps !== "object") continue;
    const value = Object.hasOwn(deps, name)
      ? (deps as Record<string, unknown>)[name]
      : undefined;
    if (typeof value === "string") return value;
  }
  return undefined;
}

export function installedPackageDir(
  file: string,
): { dir: string; name: string } | undefined {
  const parts = file.split(SEPARATOR_PATTERN);
  const at = parts.lastIndexOf("node_modules");
  if (at < 0) return undefined;
  const length = parts[at + 1]?.startsWith("@") ? 2 : 1;
  const nameParts = parts.slice(at + 1, at + 1 + length);
  if (nameParts.length < length || nameParts.some((p) => p === "")) {
    return undefined;
  }
  return {
    dir: parts.slice(0, at + 1 + length).join(SEPARATOR),
    name: nameParts.join("/"),
  };
}

export interface StaleInstalledImport {
  importer: string;
  specifier: string;
  packageName: string;
  declaredRange: string;
  installedVersion?: string;
  installedName?: string;
  declaredName?: string;
}

export interface InstalledPackageImports {
  resolutions: ResolvedBareImport[];
  stale: StaleInstalledImport[];
}

/**
 * the installed manifest is repo-controlled, so it counts only with a valid npm
 * name, strict semver and the declared name; the shipped and audited specifier
 * are then one package, else the import ships as written
 */
export async function installedPackageImports(
  resolutions: readonly ResolvedBareImport[],
  packageJson: unknown,
  readManifest: (packageDir: string) => Promise<unknown>,
): Promise<InstalledPackageImports> {
  const manifests = new Map<string, Promise<unknown>>();
  const manifestOf = (dir: string) => {
    let manifest = manifests.get(dir);
    if (!manifest) {
      manifest = readManifest(dir).catch(() => undefined);
      manifests.set(dir, manifest);
    }
    return manifest;
  };

  const out: ResolvedBareImport[] = [];
  const stale: StaleInstalledImport[] = [];
  for (const r of resolutions) {
    if (r.target !== undefined) {
      out.push(r);
      continue;
    }
    const { name, subpath } = packageOfBareImport(r.specifier);
    const value = declaredDependency(packageJson, name);
    const declared = value === undefined
      ? undefined
      : registryDeclaration(name, value);
    const unresolved: ResolvedBareImport = {
      importer: r.importer,
      specifier: r.specifier,
    };
    const installed = r.installedFile
      ? installedPackageDir(r.installedFile)
      : undefined;
    if (!installed) {
      if (declared) {
        stale.push({
          importer: r.importer,
          specifier: r.specifier,
          packageName: name,
          declaredRange: declared.range,
        });
      }
      out.push(unresolved);
      continue;
    }
    if (value !== undefined && !declared) {
      out.push(unresolved);
      continue;
    }
    const manifest = await manifestOf(installed.dir) as
      | Record<string, unknown>
      | undefined;
    const installedName = manifest?.name;
    const version = manifest?.version;
    if (
      typeof installedName !== "string" ||
      !NPM_PACKAGE_NAME_RE.test(installedName) ||
      (!declared && installedName !== installed.name) ||
      typeof version !== "string" || !STRICT_SEMVER_RE.test(version)
    ) {
      out.push(unresolved);
      continue;
    }
    const parsed = tryParse(version);
    if (!parsed) {
      out.push(unresolved);
      continue;
    }
    if (declared && installedName !== declared.name) {
      stale.push({
        importer: r.importer,
        specifier: r.specifier,
        packageName: name,
        declaredRange: declared.range,
        installedVersion: format(parsed),
        installedName,
        declaredName: declared.name,
      });
      out.push(unresolved);
      continue;
    }
    // A dist-tag (`latest`) is no range: node_modules cannot show which
    // version it named when installed, so the installed one stands.
    const range = declared ? tryParseRange(declared.range) : undefined;
    if (declared && range && !satisfies(parsed, range)) {
      stale.push({
        importer: r.importer,
        specifier: r.specifier,
        packageName: name,
        declaredRange: declared.range,
        installedVersion: format(parsed),
      });
      out.push(unresolved);
      continue;
    }
    out.push({
      importer: r.importer,
      specifier: r.specifier,
      target: `npm:${installedName}@${version}${subpath}`,
      installedFile: r.installedFile,
      installedVersion: version,
      ...(declared
        ? { declared: `npm:${declared.name}@${declared.range}` }
        : {}),
    });
  }
  return { resolutions: out, stale };
}

/**
 * under a manual nodeModulesDir Deno applies the import map then looks in
 * node_modules, so a mapped name reads as unresolved when the package is not
 * installed, or names a file there when it is
 */
export function hasUnresolvedBareImports(
  resolutions: readonly ResolvedBareImport[],
): boolean {
  return resolutions.some((r) => r.target === undefined);
}

/**
 * the second read, with node-modules-dir none, names the npm specifier the
 * config maps to; where to install does not change that mapping, so it is still
 * Deno's answer. A resolved import keeps its first.
 */
export function withPackageSpecifiers(
  resolutions: readonly ResolvedBareImport[],
  packageRead: readonly ResolvedBareImport[],
): ResolvedBareImport[] {
  if (!hasUnresolvedBareImports(resolutions)) return [...resolutions];
  const second = bareImportResolverFrom(packageRead);
  return resolutions.map((r) => {
    if (r.target !== undefined) return r;
    const target = second.resolve(r.importer, r.specifier);
    return target === undefined ? r : { ...r, target };
  });
}
