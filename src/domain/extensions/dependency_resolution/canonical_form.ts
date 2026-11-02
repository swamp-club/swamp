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

import { exactVersion } from "@swamp-club/extension-scoring/dependency-audit";
import { markErrorPaths, UserError } from "../../errors.ts";
import type { SpecifierRewrite } from "../source_archive_plan.ts";
import { scanImportSites } from "./import_sites.ts";
import type { PackageVersions } from "./package_versions.ts";

const PACKAGE_SPECIFIER_RE =
  /^(?<registry>npm|jsr):\/?(?<name>(?:@[^/@]+\/)?[^/@]+)(?:@(?<version>[^/]*))?(?<subpath>\/.*)?$/;

export type CanonicalSpecifier =
  | { kind: "outside" }
  | { kind: "pinned"; specifier: string }
  | { kind: "unresolved" };

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
