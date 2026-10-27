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
  compare,
  format,
  maxSatisfying,
  type Range,
  type SemVer,
  tryParse,
  tryParseRange,
} from "@std/semver";

import type { DependencyRegistry } from "./specifiers.ts";
export type { DependencyRegistry };

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

/**
 * Where the shipped version came from; `installed` is the package a
 * package.json project holds in node_modules, which the bundle inlines.
 */
export type ShippedVersionSource =
  | "exact"
  | "installed"
  | "lockfile"
  | "registry";

export interface ShippedVersion {
  version: string;
  from: ShippedVersionSource;
  /** The archive's dependency audit record decided it; `from` stays push's source. */
  recorded?: true;
  /**
   * A valid lock fixed this version: a `deno.lock` push bundled with, or a
   * `package-lock.json` that node_modules matches (swamp-club#3970). A
   * version from the lockfile is always locked.
   */
  locked?: true;
}

/**
 * What an archive's dependency audit record says push audited
 * (swamp-club#3662): the registry audits the version push shipped.
 */
export interface RecordedDependencyVersions {
  /** The version push audited for this import's own specifier. */
  recordedFor(
    registry: DependencyRegistry,
    name: string,
    specVersion: string | null,
  ): ShippedVersion | undefined;
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
 * The version that ships for a specifier: an exact pin; else the version
 * installed in a package.json project's node_modules (swamp-club#3630),
 * which the bundle inlines whatever the lockfile says; else, for the
 * registry, the version the archive's audit record says push audited, when
 * the registry lists it; else the version
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
  installed?: string,
  record?: RecordedDependencyVersions,
): ShippedVersion | null {
  const exact = exactVersion(specVersion);
  if (exact !== null) return { version: exact, from: "exact" };
  if (installed !== undefined) return { version: installed, from: "installed" };

  const recorded = record?.recordedFor(registry, name, specVersion);
  // the record is the author's claim: it counts only for a version the registry lists
  if (recorded && published?.versions.includes(recorded.version)) {
    return { ...recorded, recorded: true };
  }

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

/**
 * The version to move to when `shipped` should not be used: the newest
 * stable version that is not in `excluded`, preferring the shipped version's
 * major (its minor too for 0.x, where the minor is the breaking line) and
 * falling back to the newest overall. Only versions that parse as semver
 * qualify, so registry metadata cannot put arbitrary text in a suggestion;
 * the version is returned as the registry lists it.
 * Null when no other version qualifies.
 */
export function suggestVersion(
  shipped: string,
  candidates: readonly string[],
  excluded: ReadonlySet<string>,
): string | null {
  const current = tryParse(shipped);
  const usable = candidates
    .filter((v) => !excluded.has(v))
    .flatMap((raw) => {
      const version = tryParse(raw);
      return version !== undefined && (version.prerelease?.length ?? 0) === 0 &&
          format(version) !== shipped
        ? [{ raw, version }]
        : [];
    });
  const sameLine = ({ version }: { version: SemVer }): boolean =>
    current !== undefined && version.major === current.major &&
    (current.major !== 0 || version.minor === current.minor);
  const newest = (list: typeof usable): string | null =>
    list.length === 0
      ? null
      : list.reduce((a, b) => compare(a.version, b.version) >= 0 ? a : b).raw;
  return newest(usable.filter(sameLine)) ?? newest(usable);
}
