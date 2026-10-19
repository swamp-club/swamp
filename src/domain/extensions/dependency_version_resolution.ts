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
  format,
  maxSatisfying,
  type Range,
  type SemVer,
  tryParse,
  tryParseRange,
} from "@std/semver";

export type DependencyRegistry = "npm" | "jsr";

/**
 * What a package manager's lockfile records for a package. The port between
 * the dependency audit and whichever lockfile the bundler honours, so
 * another platform's lockfile can plug in.
 */
export interface LockedDependencyVersions {
  /** Names the lockfile in findings, e.g. "deno.lock". */
  readonly source: string;
  /**
   * The version the lockfile resolves this import specifier to, when it
   * records the specifier itself (`null` for an unpinned import).
   */
  resolvedFor(
    registry: DependencyRegistry,
    name: string,
    specVersion: string | null,
  ): string | undefined;
  /** Every version the lockfile records for the package, transitive too. */
  versionsFor(registry: DependencyRegistry, name: string): readonly string[];
}

/** How a specifier pins its package. */
export type SpecifierKind = "exact" | "range" | "dist-tag" | "unpinned";

/** Where the shipped version came from. */
export type ShippedVersionSource = "exact" | "lockfile" | "registry";

export interface ShippedVersion {
  version: string;
  from: ShippedVersionSource;
}

/** What a registry publishes for one package. */
export interface PublishedPackage {
  versions: readonly string[];
  distTags: Readonly<Record<string, string>>;
  /** Versions withdrawn from range resolution (JSR yanks). */
  yanked?: ReadonlySet<string>;
}

/**
 * The single version an exact specifier names, or null. A leading `=` or
 * `v` on an otherwise exact version still names one version.
 */
export function exactVersion(spec: string | null): string | null {
  if (spec === null) return null;
  const parsed = tryParse(spec.replace(/^=\s*/, ""));
  return parsed ? format(parsed) : null;
}

export function specifierKind(spec: string | null): SpecifierKind {
  if (spec === null) return "unpinned";
  if (exactVersion(spec) !== null) return "exact";
  return tryParseRange(spec) ? "range" : "dist-tag";
}

function highestSatisfying(
  versions: readonly string[],
  range: Range,
): string | null {
  const parsed = versions
    .map((v) => tryParse(v))
    .filter((v): v is SemVer => v !== undefined);
  const best = maxSatisfying(parsed, range);
  return best ? format(best) : null;
}

/**
 * The exact version an npm specifier resolves to from the registry, the way
 * the registry's scorecard does: an exact version as-is, a dist-tag through
 * `distTags`, a range to the highest published version that satisfies it,
 * and no version to `latest`. Null when nothing resolves.
 */
export function resolveAuditVersion(
  specVersion: string | null,
  publishedVersions: readonly string[],
  distTags: Readonly<Record<string, string>>,
): string | null {
  if (specVersion === null) return distTags.latest ?? null;
  if (tryParse(specVersion)) return specVersion;
  if (Object.hasOwn(distTags, specVersion)) return distTags[specVersion];

  const range = tryParseRange(specVersion);
  if (!range) return null;
  return highestSatisfying(publishedVersions, range);
}

/**
 * A JSR range resolves the way Deno does: the highest version that is not
 * yanked or a prerelease, falling back to a yanked match when nothing else
 * satisfies. No version means the registry's `latest`.
 */
function resolveJsrVersion(
  specVersion: string | null,
  published: PublishedPackage,
): string | null {
  if (specVersion === null) return published.distTags.latest ?? null;
  const range = tryParseRange(specVersion);
  if (!range) return null;
  const yanked = published.yanked ?? new Set<string>();
  return highestSatisfying(
    published.versions.filter((v) => !yanked.has(v)),
    range,
  ) ?? highestSatisfying(
    published.versions.filter((v) => yanked.has(v)),
    range,
  );
}

/**
 * The version push ships for a specifier: an exact pin; else the version
 * the lockfile resolves that specifier to; else, when the lockfile does not
 * record the specifier, the highest version it records for the package that
 * satisfies it (Deno reuses a locked version that does); else what the
 * registry resolves today. A stale lock that satisfies nothing falls
 * through to the registry, as Deno re-resolves it. Null when nothing
 * resolves.
 */
export function resolveShippedVersion(
  registry: DependencyRegistry,
  name: string,
  specVersion: string | null,
  lock: LockedDependencyVersions | undefined,
  published: PublishedPackage | null,
): ShippedVersion | null {
  const exact = exactVersion(specVersion);
  if (exact !== null) return { version: exact, from: "exact" };

  const kind = specifierKind(specVersion);
  if (lock && kind !== "dist-tag") {
    const range = specVersion === null
      ? tryParseRange("*")
      : tryParseRange(specVersion);
    const direct = lock.resolvedFor(registry, name, specVersion);
    const locked = !range
      ? null
      : direct !== undefined && highestSatisfying([direct], range) !== null
      ? direct
      : highestSatisfying(lock.versionsFor(registry, name), range);
    if (locked !== null) return { version: locked, from: "lockfile" };
  }

  if (published === null) return null;
  const version = registry === "jsr"
    ? resolveJsrVersion(specVersion, published)
    : resolveAuditVersion(specVersion, published.versions, published.distTags);
  return version === null ? null : { version, from: "registry" };
}
