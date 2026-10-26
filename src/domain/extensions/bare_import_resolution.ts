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
  /**
   * The file in a node_modules directory Deno resolved it to, when it did:
   * a package.json project's installed package (swamp-club#3630).
   */
  installedFile?: string;
  /**
   * The version installed in a package.json project's node_modules, when
   * `target` names that installed package (swamp-club#3630).
   */
  installedVersion?: string;
  /**
   * The `npm:` specifier the project's package.json declares for the
   * package (`npm:ms@^2.1.0`), when `target` names the installed version
   * and package.json declares it.
   */
  declared?: string;
}

/**
 * Port: what a bare import resolves to from the module that writes it.
 * Undefined means unresolved: the import ships as written and the
 * bare-specifiers finding names it. An implementation never answers with a
 * target Deno would not use for that importer.
 */
export interface BareImportResolver {
  resolve(importer: string, specifier: string): string | undefined;
  /**
   * The installed package a bare import `resolve` answers with in a
   * package.json project, and the `npm:` specifier package.json declares
   * for it when it does (swamp-club#3630); undefined otherwise.
   */
  installed?(
    importer: string,
    specifier: string,
  ): { version: string; declared?: string } | undefined;
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
 * The directory of the entry point `deno info --json` output was read from
 * (its first root), which {@link isLocalModuleSpecifier} reads paths
 * relative to; undefined when the output names no `file:` root.
 */
export function denoInfoRootDir(json: unknown): string | undefined {
  const root = (json as { roots?: unknown })?.roots;
  const first = Array.isArray(root) ? root[0] : undefined;
  return typeof first === "string" && first.startsWith("file:")
    ? dirname(fromFileUrl(first))
    : undefined;
}

/**
 * A `file:` module that is not an npm package installed in a node_modules
 * directory: the extension's own source. Only the path from `rootDir`, the
 * entry point's directory, is read, so a repository checked out under a
 * directory named node_modules still has local modules.
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

/** A `file:` URL inside a node_modules directory below `rootDir`. */
function isInstalledPackageFile(specifier: string, rootDir?: string): boolean {
  return specifier.startsWith("file:") &&
    !isLocalModuleSpecifier(specifier, rootDir);
}

/**
 * The bare imports each local module in `deno info --json` output writes,
 * with the specifier Deno resolved each to. A code import's resolution
 * wins over a type import's; one Deno reports an error for is unresolved,
 * and so is one Deno resolves into a node_modules directory (a manual
 * `nodeModulesDir`): the graph names a file there, not a specifier push
 * can ship. {@link withPackageSpecifiers} fills these from a second read.
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

/** A bare import's package name and the subpath after it (`/posix`). */
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
 * What a package.json declares for a dependency: an npm registry range or
 * dist-tag, read through an `npm:` alias to its target package; undefined
 * for a non-registry source (`file:`, `link:`, `workspace:`, git, a URL or
 * `user/repo`), which the registry never serves.
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

/** `dependencies` then `devDependencies`, as the bundler resolves them. */
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

/**
 * The installed package directory a node_modules file belongs to, and the
 * package name its path gives: the segments after the last `node_modules`
 * (one, or two for a scope). Undefined for a file not under one.
 */
function installedPackageDir(
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

/**
 * A bare import package.json declares at a registry range whose package
 * node_modules does not hold, or holds at a version outside that range.
 */
export interface StaleInstalledImport {
  importer: string;
  specifier: string;
  /** The package as package.json names it. */
  packageName: string;
  /** The range package.json declares. */
  declaredRange: string;
  /** The installed version, when one is installed. */
  installedVersion?: string;
  /**
   * The package installed in its place, when it is not the one package.json
   * declares (an `npm:` alias changed without reinstalling).
   */
  installedName?: string;
  /** The package package.json declares, when `installedName` is set. */
  declaredName?: string;
}

/** {@link installedPackageImports}' answer. */
export interface InstalledPackageImports {
  resolutions: ResolvedBareImport[];
  stale: StaleInstalledImport[];
}

/**
 * `resolutions` from a package.json project's graph, read with
 * `--node-modules-dir=manual`, with each import Deno resolved into
 * node_modules given the specifier of the package installed there:
 * `npm:<name>@<installed version><subpath>`, the code the bundle inlines
 * (swamp-club#3630). `declared` records the range package.json lists for
 * it, `dependencies` then `devDependencies`.
 *
 * The installed manifest is repo-controlled, so it names a package only
 * when its name is a valid npm name, its version is strict semver, and the
 * name is the package package.json declares (the `npm:` alias target, when
 * it is one) or, for a package package.json does not declare, its
 * node_modules directory: the shipped specifier and the audited one are
 * always the same package. Otherwise, or for a non-registry declaration,
 * the import stays unresolved and ships as written. An import package.json
 * declares at a registry range that is not installed, is installed outside
 * that range, or is installed as another package, is reported in `stale`.
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
 * Whether any bare import is unresolved: Deno reported an error for it or
 * resolved it into node_modules. Under a manual `nodeModulesDir` (a
 * package.json beside the config) Deno applies the import map and then
 * looks the npm package up in node_modules, so a mapped name reads as
 * unresolved whenever the package is not installed, or names a file there
 * when it is.
 */
export function hasUnresolvedBareImports(
  resolutions: readonly ResolvedBareImport[],
): boolean {
  return resolutions.some((r) => r.target === undefined);
}

/**
 * `resolutions` with each unresolved import filled from `packageRead`, the
 * same graph read with `--node-modules-dir=none` (swamp-club#3612): there
 * Deno names the npm specifier the config maps the name to rather than a
 * place in node_modules. Where to install a package does not change which
 * specifier a name maps to, so this is still Deno's answer. A resolved
 * import keeps its first answer, and one the second read cannot resolve
 * either stays unresolved.
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
