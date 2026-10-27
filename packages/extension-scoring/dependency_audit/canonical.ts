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
