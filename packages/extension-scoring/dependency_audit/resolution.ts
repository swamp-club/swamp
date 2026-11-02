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
 * the port between the dependency audit and whichever lockfile the bundler
 * honours, so another platform's lockfile can plug in
 */
export interface LockedDependencyVersions {
  readonly source: string;
  resolvedFor(
    registry: DependencyRegistry,
    name: string,
    specVersion: string | null,
  ): string | undefined;
  versionsFor(registry: DependencyRegistry, name: string): readonly string[];
}

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
   * a valid lock fixed this version: a deno.lock push bundled with, or a
   * package-lock.json that node_modules matches; a version from the lockfile is
   * always locked
   */
  locked?: true;
  /**
   * a v2 record entry ships a version no valid lock fixed though the author
   * wrote a non-exact spelling, kept here so it costs the loose point as in the
   * source
   */
  looseAs?: string;
}

/**
 * what the archive's dependency audit record says push audited; the registry
 * audits the version push shipped
 */
export interface RecordedDependencyVersions {
  recordedFor(
    registry: DependencyRegistry,
    name: string,
    specVersion: string | null,
  ): ShippedVersion | undefined;
  /**
   * present only for a v2 record: why the specifier breaks the canonical
   * shipped form, or null; with it a version comes only from an exact specifier
   * the record lists
   */
  canonicalIssue?(specifier: string): string | null;
}

export interface PublishedPackage {
  versions: readonly string[];
  distTags: Readonly<Record<string, string>>;
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
 * order: exact pin; installed package.json version (the bundle inlines it);
 * recorded version if the registry lists it; lockfile's version; highest locked
 * satisfying one
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
  if (record?.canonicalIssue) {
    const written = `${registry}:${name}${
      specVersion === null ? "" : `@${specVersion}`
    }`;
    if (record.canonicalIssue(written) !== null) return null;
    const entry = record.recordedFor(registry, name, specVersion);
    return entry ? { ...entry, recorded: true } : null;
  }
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
 * prefers the shipped version's major (minor too for 0.x), else the newest
 * overall; only semver-parsing versions qualify so registry metadata cannot put
 * arbitrary text in a suggestion
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
