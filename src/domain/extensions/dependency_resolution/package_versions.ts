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
 * The exact versions Deno resolved each `npm:` and `jsr:` import to, read
 * from the same `deno info --json` graph the bundle is built from
 * (swamp-club#3970). Push pins each import it ships to the version this
 * reports, so the shipped source, the bundle and the audit read one answer.
 */

import {
  isPlainSemver,
  parseSpecifier,
  type UnauditedDependency,
} from "@swamp-club/extension-scoring/dependency-audit";

/**
 * The package one specifier resolved to at the exact version:
 * `npm:<name>@<x.y.z>` or `jsr:@<scope>/<name>@<x.y.z>`, with no subpath.
 * `installed` when Deno read it from a package installed in node_modules
 * rather than from the registry.
 */
export interface PackageVersion {
  specifier: string;
  installed?: true;
}

/**
 * Each `npm:` or `jsr:` specifier a graph resolved, as Deno read it (after
 * the import map), to its package at the exact version.
 */
export type PackageVersions = Readonly<Record<string, PackageVersion>>;

const NPM_TARGET_RE = /^npm:\/?(?<name>(?:@[^/@]+\/)?[^/@]+)@(?<version>[^/]+)/;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** The version a JSR module URL names for `name`: `…/@scope/name/<version>/…`. */
function jsrVersionIn(url: string, name: string): string | undefined {
  const marker = `/${name}/`;
  const at = url.indexOf(marker);
  if (at === -1) return undefined;
  return url.slice(at + marker.length).split("/")[0] || undefined;
}

/** The exact package a resolved target names for `specifier`'s package, or undefined. */
function exactPackage(specifier: string, target: string): string | undefined {
  const parsed = parseSpecifier(specifier);
  if (!parsed) return undefined;
  let version: string | undefined;
  if (parsed.registry === "npm") {
    const match = NPM_TARGET_RE.exec(target);
    if (match?.groups?.name !== parsed.name) return undefined;
    version = match.groups.version;
  } else {
    version = jsrVersionIn(target, parsed.name);
  }
  return version !== undefined && isPlainSemver(version)
    ? `${parsed.registry}:${parsed.name}@${version}`
    : undefined;
}

/**
 * The exact package each `npm:` and `jsr:` specifier in a `deno info`
 * graph resolved to. Deno reports both in `redirects` (`npm:ms@^2` to
 * `npm:/ms@2.1.3`, `jsr:@std/assert@^1/assert` to the JSR module URL),
 * and each npm dependency's `npmPackage` (`ms@2.1.3`) as well.
 */
export function packageVersionsFromDenoInfo(json: unknown): PackageVersions {
  const body = record(json);
  const versions: Record<string, PackageVersion> = {};
  for (const [from, to] of Object.entries(record(body.redirects))) {
    if (typeof to !== "string") continue;
    const exact = exactPackage(from, to);
    if (exact !== undefined) versions[from] = { specifier: exact };
  }
  const modules = Array.isArray(body.modules) ? body.modules : [];
  for (const module of modules) {
    const deps = record(module).dependencies;
    for (const dep of Array.isArray(deps) ? deps : []) {
      const { code, type, npmPackage } = record(dep);
      if (typeof npmPackage !== "string") continue;
      for (const target of [code, type]) {
        const specifier = record(target).specifier;
        if (typeof specifier !== "string" || specifier in versions) continue;
        const exact = exactPackage(specifier, `npm:${npmPackage}`);
        if (exact !== undefined) versions[specifier] = { specifier: exact };
      }
    }
  }
  return versions;
}

/**
 * The installed package an `npm:` specifier resolved to, when Deno read it
 * from node_modules: `npm:<name>@<version>` for the package `name` names,
 * or undefined when the name does not match.
 */
export function installedPackageVersion(
  specifier: string,
  name: string,
  version: string,
): PackageVersion | undefined {
  const parsed = parseSpecifier(specifier);
  return parsed?.registry === "npm" && parsed.name === name &&
      isPlainSemver(version)
    ? { specifier: `npm:${name}@${version}`, installed: true }
    : undefined;
}

/** Every graph's answers in one; the first answer for a specifier wins. */
export function mergePackageVersions(
  all: readonly (PackageVersions | undefined)[],
): PackageVersions {
  const merged: Record<string, PackageVersion> = {};
  for (const versions of all) {
    for (const [specifier, version] of Object.entries(versions ?? {})) {
      if (!(specifier in merged)) merged[specifier] = version;
    }
  }
  return merged;
}

/**
 * What push ships for an extension's dependencies, read from the module
 * graphs its bundles are built from (swamp-club#3970).
 */
export interface GraphDependencies {
  /** The exact version each `npm:` and `jsr:` specifier resolved to. */
  packageVersions: PackageVersions;
  /** Code from outside npm and JSR, with a SHA-256 of each module. */
  unaudited: UnauditedDependency[];
  /**
   * A package.json project's package-lock.json: whether it counts as a
   * lock (node_modules matches it), and why not when it is present but
   * does not. Absent outside a package.json project.
   */
  packageLock?: { valid: boolean; warning?: string };
}
