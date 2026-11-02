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
  isPlainSemver,
  parseSpecifier,
  type UnauditedDependency,
} from "@swamp-club/extension-scoring/dependency-audit";

export interface PackageVersion {
  specifier: string;
  installed?: true;
}

export type PackageVersions = Readonly<Record<string, PackageVersion>>;

const NPM_TARGET_RE = /^npm:\/?(?<name>(?:@[^/@]+\/)?[^/@]+)@(?<version>[^/]+)/;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function jsrVersionIn(url: string, name: string): string | undefined {
  const marker = `/${name}/`;
  const at = url.indexOf(marker);
  if (at === -1) return undefined;
  return url.slice(at + marker.length).split("/")[0] || undefined;
}

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

export interface GraphDependencies {
  packageVersions: PackageVersions;
  unaudited: UnauditedDependency[];
  /**
   * A package.json project's package-lock.json: whether it counts as a
   * lock (node_modules matches it), and why not when it is present but
   * does not. Absent outside a package.json project.
   */
  packageLock?: { valid: boolean; warning?: string };
}
