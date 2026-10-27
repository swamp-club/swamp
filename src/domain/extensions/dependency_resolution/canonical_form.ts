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
 * The canonical shipped form (swamp-club#3970): every `npm:` and `jsr:`
 * import in an archive's source names the exact version its bundle holds,
 * `npm:<name>@<x.y.z>[/subpath]` or `jsr:@<scope>/<name>@<x.y.z>[/subpath]`.
 * Authors keep writing ranges, dist-tags, import-map names and
 * package.json dependencies; push pins each site to the version Deno's
 * module graph resolved it to.
 */

import { exactVersion } from "@swamp-club/extension-scoring/dependency-audit";
import { markErrorPaths, UserError } from "../../errors.ts";
import type { SpecifierRewrite } from "../source_archive_plan.ts";
import { scanImportSites } from "./import_sites.ts";
import type { PackageVersions } from "./package_versions.ts";

// `npm:` / `jsr:`, an optional leading slash, the package, its version and a subpath
const PACKAGE_SPECIFIER_RE =
  /^(?<registry>npm|jsr):\/?(?<name>(?:@[^/@]+\/)?[^/@]+)(?:@(?<version>[^/]*))?(?<subpath>\/.*)?$/;

/** What push ships for one `npm:` or `jsr:` specifier. */
export type CanonicalSpecifier =
  | { kind: "outside" }
  | { kind: "pinned"; specifier: string }
  | { kind: "unresolved" };

/**
 * The canonical form of `specifier`: unchanged for anything but `npm:` and
 * `jsr:` and for zod, which the host provides; an exact version in any
 * spelling (`=1.2.3`, `v1.2.3`) as plain semver; anything else at the
 * version `versions` says Deno resolved it to, keeping its subpath.
 * `unresolved` when the graph gave no exact version for it.
 */
export function canonicalSpecifier(
  specifier: string,
  versions: PackageVersions,
): CanonicalSpecifier {
  const match = PACKAGE_SPECIFIER_RE.exec(specifier);
  if (!match?.groups) return { kind: "outside" };
  const { registry, name, version, subpath = "" } = match.groups;
  if (registry === "npm" && name === "zod") return { kind: "outside" };
  const exact = version === undefined ? null : exactVersion(version);
  if (exact !== null) {
    return {
      kind: "pinned",
      specifier: `${registry}:${name}@${exact}${subpath}`,
    };
  }
  const root = versions[specifier] ??
    versions[
      `${registry}:${name}${version === undefined ? "" : `@${version}`}`
    ];
  return root === undefined
    ? { kind: "unresolved" }
    : { kind: "pinned", specifier: `${root.specifier}${subpath}` };
}

function unresolvedError(
  specifier: string,
  sourcePath: string,
): UserError {
  return markErrorPaths(
    new UserError(
      `Push could not tell which version of ${JSON.stringify(specifier)} ` +
        `(imported from ${sourcePath}) the bundle holds, so it cannot pin ` +
        `it in the archive's source. Pin an exact version, or commit a lock.`,
    ),
    [sourcePath],
  );
}

/**
 * Pins one import-map target push ships for a bare import. Throws a
 * UserError when the graph gave no exact version for it.
 */
export function canonicalTarget(
  target: string,
  versions: PackageVersions,
  sourcePath: string,
): string {
  const canonical = canonicalSpecifier(target, versions);
  if (canonical.kind === "unresolved") {
    throw unresolvedError(target, sourcePath);
  }
  return canonical.kind === "pinned" ? canonical.specifier : target;
}

/**
 * The rewrites that pin every `npm:` and `jsr:` import `source` writes out
 * (static, side-effect, dynamic and type imports, and re-exports) to the
 * exact version the graph resolved it to. A site already in the canonical
 * form is left alone. Throws a UserError for a site the graph gave no exact
 * version for, so a range can never ship. A module that does not parse
 * plans nothing: push refuses it first.
 */
export function canonicalImportRewrites(
  source: string,
  sourcePath: string,
  versions: PackageVersions,
): SpecifierRewrite[] {
  const rewrites: SpecifierRewrite[] = [];
  for (const { specifier, span } of scanImportSites(source, sourcePath) ?? []) {
    if (!specifier.startsWith("npm:") && !specifier.startsWith("jsr:")) {
      continue;
    }
    const canonical = canonicalSpecifier(specifier, versions);
    if (canonical.kind === "unresolved") {
      throw unresolvedError(specifier, sourcePath);
    }
    if (canonical.kind === "pinned" && canonical.specifier !== specifier) {
      rewrites.push({ span, from: specifier, to: canonical.specifier });
    }
  }
  return rewrites;
}
