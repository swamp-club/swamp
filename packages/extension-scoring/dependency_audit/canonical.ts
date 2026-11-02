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
 * in a canonical archive every npm: and jsr: import names one plain semver
 * version; push checks each shipped specifier against this and the registry
 * reads v2 archives by the same rule
 */

import { type DependencyAuditRecordV2, isPlainSemver } from "./audit_record.ts";
import {
  exactVersion,
  type RecordedDependencyVersions,
  type ShippedVersion,
} from "./resolution.ts";
import { parseSpecifier } from "./specifiers.ts";

const NPM_RE = /^npm:(?<name>(?:@[^/@]+\/)?[^/@]+)(?:@(?<version>[^/]*))?/;
const JSR_RE = /^jsr:(?<name>(?:@[^/@]+\/)?[^/@]+)(?:@(?<version>[^/]*))?/;

/**
 * anything other than npm: or jsr: is outside the rule; zod is provided by the
 * host, so it ships as written and is never audited
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
 * an import resolves only when it is exact and the record lists that version;
 * an entry reached through a non-exact spelling with no valid lock keeps it as
 * looseAs, so it costs the loose point
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

function isExactWriting(written: string): boolean {
  const version = parseSpecifier(written)?.version ?? null;
  return version !== null && exactVersion(version) !== null;
}
