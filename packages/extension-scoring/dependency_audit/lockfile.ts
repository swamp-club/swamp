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

/** Reading a Deno lockfile as data, for the dependency audit. */

import { formatRange, tryParseRange } from "@std/semver";
import type { LockedDependencyVersions } from "./resolution.ts";
import type { DependencyRegistry } from "./specifiers.ts";

/** A larger lockfile is not read; the audit resolves from the registry. */
export const MAX_LOCKFILE_BYTES = 16 * 1024 * 1024;

const SUPPORTED_VERSIONS: ReadonlySet<string> = new Set(["4", "5"]);

/** `npm:@scope/name@range` or `jsr:@scope/name@range` → its parts. */
function packageOfSpecifier(
  key: string,
): { registry: DependencyRegistry; name: string; range: string | null } | null {
  const match = /^(npm|jsr):((?:@[^/@]+\/)?[^/@]+)(?:@([^/]+))?/.exec(key);
  return match
    ? {
      registry: match[1] as DependencyRegistry,
      name: match[2],
      range: match[3] ?? null,
    }
    : null;
}

/** Two ranges admit the same versions, e.g. `^2.0.0` and `2`. */
function sameRange(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  const ra = tryParseRange(a ?? "*");
  const rb = tryParseRange(b ?? "*");
  return ra !== undefined && rb !== undefined &&
    formatRange(ra) === formatRange(rb);
}

/** `name@version` or `name@version_peer…` → its name and bare version. */
function packageOfEntry(key: string): { name: string; version: string } | null {
  const at = key.indexOf("@", 1);
  if (at <= 0) return null;
  return {
    name: key.slice(0, at),
    version: key.slice(at + 1).split("_")[0],
  };
}

/**
 * What a Deno lockfile (format 4 or 5) records, read as data: the resolved
 * value of each import specifier, and every version of each package from
 * the specifiers and the keys of the `npm` and `jsr` sections. Undefined
 * when the text is not JSON or another format, so the audit resolves from
 * the registry instead.
 *
 * @param source names the lockfile in findings, e.g. "deno.lock"
 */
export function parseDenoLockfile(
  text: string,
  source: string,
): LockedDependencyVersions | undefined {
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return undefined;
    body = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!SUPPORTED_VERSIONS.has(String(body.version))) return undefined;

  const versions = new Map<string, Set<string>>();
  const direct: {
    key: string;
    range: string | null;
    version: string;
  }[] = [];
  const record = (registry: DependencyRegistry, name: string, v: string) => {
    const key = `${registry}:${name}`;
    const set = versions.get(key) ?? new Set<string>();
    set.add(v);
    versions.set(key, set);
  };

  const specifiers = body.specifiers;
  if (specifiers && typeof specifiers === "object") {
    for (const [key, value] of Object.entries(specifiers)) {
      const pkg = packageOfSpecifier(key);
      if (pkg && typeof value === "string") {
        const version = value.split("_")[0];
        record(pkg.registry, pkg.name, version);
        direct.push({
          key: `${pkg.registry}:${pkg.name}`,
          range: pkg.range,
          version,
        });
      }
    }
  }
  for (const registry of ["npm", "jsr"] as const) {
    const section = body[registry];
    if (!section || typeof section !== "object") continue;
    for (const key of Object.keys(section)) {
      const entry = packageOfEntry(key);
      if (entry) record(registry, entry.name, entry.version);
    }
  }

  return {
    source,
    // Deno writes each import's specifier as a key, sometimes in a shorter
    // equivalent form (`npm:ms@2` for `^2.0.0`), so match by the versions
    // the range admits rather than by text.
    resolvedFor: (registry, name, specVersion) =>
      direct.find((d) =>
        d.key === `${registry}:${name}` && sameRange(d.range, specVersion)
      )?.version,
    versionsFor: (registry, name) => [
      ...(versions.get(`${registry}:${name}`) ?? []),
    ],
  };
}
