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

/** Reading npm's and JSR's package metadata as the audit needs it. */

import { suggestVersion } from "./resolution.ts";

/** The most of a third-party deprecation notice a finding repeats. */
const MAX_DEPRECATION_NOTICE = 200;

/** What npm's packument says about one package, read once per package. */
export interface NpmPackument {
  /** The `latest` dist-tag; null when the packument has none. */
  latestVersion: string | null;
  /** Every version the packument lists with a manifest. */
  publishedVersions: string[];
  distTags: Record<string, string>;
  manifests: Record<string, Record<string, unknown>>;
  packageLevel: Record<string, unknown>;
  weeklyDownloads: number | null;
  /** When `latest` was published, else when the package last changed. */
  lastPublish: string | null;
}

/**
 * Reads an npm packument and, when the downloads lookup answered, its
 * body. A version listed without a manifest object is not published as far
 * as the audit is concerned.
 */
export function parseNpmPackument(
  body: unknown,
  downloadsBody: unknown,
): NpmPackument {
  const pkgBody = body && typeof body === "object"
    ? body as Record<string, unknown>
    : {};
  const distTags: Record<string, string> = {};
  const rawTags = pkgBody["dist-tags"];
  if (rawTags && typeof rawTags === "object") {
    for (const [tag, value] of Object.entries(rawTags)) {
      if (typeof value === "string") distTags[tag] = value;
    }
  }
  const manifests: Record<string, Record<string, unknown>> = {};
  if (pkgBody.versions && typeof pkgBody.versions === "object") {
    for (const [version, manifest] of Object.entries(pkgBody.versions)) {
      if (manifest && typeof manifest === "object") {
        manifests[version] = manifest as Record<string, unknown>;
      }
    }
  }
  const latestVersion = distTags.latest ?? null;
  const time = pkgBody.time && typeof pkgBody.time === "object"
    ? pkgBody.time as Record<string, unknown>
    : {};
  const published = latestVersion === null ? undefined : time[latestVersion];
  const lastPublish = typeof published === "string"
    ? published
    : typeof time.modified === "string"
    ? time.modified
    : null;
  let weeklyDownloads: number | null = null;
  if (downloadsBody && typeof downloadsBody === "object") {
    const downloads = (downloadsBody as Record<string, unknown>).downloads;
    if (typeof downloads === "number") weeklyDownloads = downloads;
  }
  return {
    latestVersion,
    publishedVersions: Object.keys(manifests),
    distTags,
    manifests,
    packageLevel: pkgBody,
    weeklyDownloads,
    lastPublish,
  };
}

/** A manifest's license field as text. */
export function licenseOf(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (
    raw && typeof raw === "object" &&
    typeof (raw as Record<string, unknown>).type === "string"
  ) {
    return (raw as Record<string, unknown>).type as string;
  }
  return null;
}

/** npm marks a deprecated version with a non-empty notice. */
export function deprecationOf(raw: unknown): string | null {
  if (typeof raw === "string") return raw.length > 0 ? raw : null;
  return raw === true ? "" : null;
}

/** A third-party notice made safe for one terminal line. */
export function sanitiseDeprecationNotice(notice: string): string {
  // Control characters, and the bidi and zero-width format characters that
  // could reorder or hide part of the line.
  const flat = notice.replace(
    // deno-lint-ignore no-control-regex
    /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]+/g,
    " ",
  ).replace(/\s+/g, " ").trim();
  return flat.length > MAX_DEPRECATION_NOTICE
    ? `${flat.slice(0, MAX_DEPRECATION_NOTICE - 1)}…`
    : flat;
}

/** Whole months between `iso` and `now`, counting a month as 30.44 days. */
export function monthsSince(iso: string, now: Date): number {
  const then = new Date(iso);
  const diffMs = now.getTime() - then.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24 * 30.44));
}

/** The facts the trust gates read for the version that ships. */
export interface NpmPackageFacts {
  version: string;
  license: string | null;
  /** The version that ships is deprecated. */
  deprecated: boolean;
  /**
   * The package's `latest` is deprecated too, so the package is. Without a
   * `latest` dist-tag only the shipped version can be judged.
   */
  latestDeprecated: boolean;
  /** npm's deprecation notice for the version that ships, made safe. */
  deprecationReason?: string;
  /** The newest stable version that is not deprecated, when one exists. */
  suggestedVersion?: string;
  /** Null when npm lists no maintainers array at all. */
  maintainerCount: number | null;
  weeklyDownloads: number | null;
  lastPublish: string | null;
}

/**
 * The facts for the version that ships: license, maintainers and
 * deprecation from its own manifest, else the package level. The age stays
 * the package's latest publish: it measures whether the package is
 * maintained, not the pin. The caller reports a version the packument does
 * not list as not audited.
 */
export function factsFor(
  packument: NpmPackument,
  version: string,
): NpmPackageFacts {
  const pkg = packument.packageLevel;
  const latest = packument.latestVersion === null
    ? undefined
    : packument.manifests[packument.latestVersion];
  const shipped: Record<string, unknown> | undefined =
    packument.manifests[version];
  const latestNotice = latest === undefined
    ? null
    : deprecationOf(latest.deprecated ?? pkg.deprecated);
  const notice = deprecationOf(shipped?.deprecated ?? pkg.deprecated);
  const maintainers = shipped?.maintainers ?? pkg.maintainers;
  const suggestion = notice === null ? null : suggestVersion(
    version,
    packument.publishedVersions,
    new Set(
      packument.publishedVersions.filter((v) =>
        deprecationOf(packument.manifests[v]?.deprecated ?? pkg.deprecated) !==
          null
      ),
    ),
  );
  return {
    version,
    license: licenseOf(shipped?.license ?? pkg.license),
    deprecated: notice !== null,
    latestDeprecated: latestNotice !== null,
    ...(notice ? { deprecationReason: sanitiseDeprecationNotice(notice) } : {}),
    ...(notice !== null && suggestion !== null
      ? { suggestedVersion: suggestion }
      : {}),
    maintainerCount: Array.isArray(maintainers) ? maintainers.length : null,
    weeklyDownloads: packument.weeklyDownloads,
    lastPublish: packument.lastPublish,
  };
}

/** What JSR's `meta.json` says about one package. */
export interface JsrPackageMeta {
  latest: string | null;
  versions: string[];
  yanked: Set<string>;
}

/**
 * Reads JSR's `meta.json`, or returns why it cannot be used.
 */
export function parseJsrMeta(
  body: unknown,
): { kind: "found"; value: JsrPackageMeta } | {
  kind: "unavailable";
  reason: string;
} {
  const record = body && typeof body === "object"
    ? body as Record<string, unknown>
    : {};
  const rawVersions = record.versions;
  if (!rawVersions || typeof rawVersions !== "object") {
    return { kind: "unavailable", reason: "metadata lists no versions" };
  }
  const versions: string[] = [];
  const yanked = new Set<string>();
  for (const [version, entry] of Object.entries(rawVersions)) {
    versions.push(version);
    if (
      entry && typeof entry === "object" &&
      (entry as Record<string, unknown>).yanked === true
    ) {
      yanked.add(version);
    }
  }
  return {
    kind: "found",
    value: {
      latest: typeof record.latest === "string" ? record.latest : null,
      versions,
      yanked,
    },
  };
}
