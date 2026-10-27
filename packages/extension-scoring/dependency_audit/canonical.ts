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
 * The canonical shipped form (swamp-club#3970): in an archive push writes,
 * every `npm:` and `jsr:` import names one plain semver version, which the
 * v2 dependency audit record lists. Push checks every specifier it ships
 * against this; the registry reads a v2 archive by the same rule.
 */

import { type DependencyAuditRecordV2, isPlainSemver } from "./audit_record.ts";
import {
  exactVersion,
  type RecordedDependencyVersions,
  type ShippedVersion,
} from "./resolution.ts";
import { parseSpecifier } from "./specifiers.ts";

// `npm:@scope/name@version[/subpath]`, `npm:name@version[/subpath]`
const NPM_RE = /^npm:(?<name>(?:@[^/@]+\/)?[^/@]+)(?:@(?<version>[^/]*))?/;
// `jsr:@scope/name@version[/subpath]`
const JSR_RE = /^jsr:(?<name>(?:@[^/@]+\/)?[^/@]+)(?:@(?<version>[^/]*))?/;

/**
 * Why `specifier`, as an archive's source writes it, breaks the canonical
 * form, or null when it keeps it. Anything other than `npm:` or `jsr:` is
 * outside the rule. zod is the one exception: the host provides it, so it
 * ships as written and is never audited.
 */
export function canonicalShippedSpecifierIssue(
  specifier: string,
  record: Pick<DependencyAuditRecordV2, "dependencies"> | null,
): string | null {
  const registry = specifier.startsWith("npm:")
    ? "npm"
    : specifier.startsWith("jsr:")
    ? "jsr"
    : null;
  if (registry === null) return null;
  const match = (registry === "npm" ? NPM_RE : JSR_RE).exec(specifier);
  if (!match?.groups) {
    return `${specifier} is not in the canonical form: it names no package`;
  }
  const { name, version } = match.groups;
  if (registry === "npm" && name === "zod") return null;
  if (version === undefined || !isPlainSemver(version)) {
    return `${specifier} is not in the canonical form: it must name one exact version, such as ${registry}:${name}@1.2.3`;
  }
  const listed = record?.dependencies.some((e) =>
    e.registry === registry && e.name === name && e.version === version
  );
  if (!listed) {
    return `${specifier} is not in the canonical form: dependency-audit.json lists no ${registry}:${name}@${version}`;
  }
  return null;
}

/**
 * How the registry reads a v2 record (swamp-club#4018): an import resolves
 * only when it is exact and the record lists that version, taking the
 * entry's `from` and `locked`. An entry that some import reached through a
 * non-exact spelling with no valid lock (`from` is `registry`, or
 * `installed` without a verified lock) keeps that spelling as `looseAs`, so
 * it costs the loose point.
 */
export function canonicalRecordedVersions(
  record: DependencyAuditRecordV2,
): RecordedDependencyVersions {
  const entries = new Map<string, ShippedVersion>();
  for (const e of record.dependencies) {
    const loose = e.from === "registry" ||
      (e.from === "installed" && !e.locked);
    const looseAs = loose
      ? e.writtenAs.find((w) => !isExactWriting(w)) ?? e.writtenAs[0]
      : undefined;
    entries.set(JSON.stringify([e.registry, e.name, e.version]), {
      version: e.version,
      from: e.from,
      ...(e.locked || e.from === "lockfile" ? { locked: true as const } : {}),
      ...(looseAs !== undefined ? { looseAs } : {}),
    });
  }
  return {
    recordedFor: (registry, name, specVersion) =>
      specVersion === null
        ? undefined
        : entries.get(JSON.stringify([registry, name, specVersion])),
    canonicalIssue: (specifier) =>
      canonicalShippedSpecifierIssue(specifier, record),
  };
}

/**
 * Whether a spelling the author wrote names one exact version; a subpath
 * after the version does not count against it.
 */
function isExactWriting(written: string): boolean {
  const version = parseSpecifier(written)?.version ?? null;
  return version !== null && exactVersion(version) !== null;
}
