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

import { format, satisfies, tryParse, tryParseRange } from "@std/semver";
import {
  type DependencyRegistry,
  exactVersion,
  type ShippedVersion,
  type ShippedVersionSource,
} from "./dependency_version_resolution.ts";
import type { DependencySpecifier } from "./extension_dependency_extractor.ts";

/**
 * The dependency audit record (swamp-club#3662): the version push audited
 * for each `npm:` and `jsr:` dependency the shipped source imports, which is
 * the version the archive's bundles contain. The registry's scorecard
 * (swamp-club#3778) reads it to audit what ships instead of re-resolving a
 * range against today's registry. It is additive: a registry that predates
 * it ignores the file.
 *
 * It sits at the archive root beside `manifest.yaml`:
 *
 * ```json
 * {
 *   "recordVersion": 1,
 *   "dependencies": [
 *     { "registry": "npm", "name": "ms", "spec": "^2", "version": "2.1.3", "from": "lockfile" }
 *   ]
 * }
 * ```
 *
 * An entry is keyed by `(registry, name, spec)`, where `spec` is the version
 * the shipped source writes after `@` (`null` when it writes none). That is
 * what the registry reads from the archive's source: an import written out
 * keeps its spec, a bare import ships as its import-map target's, and a
 * package.json-mode import ships pinned to the installed version.
 */

/** The record's file name at the archive root. */
export const DEPENDENCY_AUDIT_RECORD_FILENAME = "dependency-audit.json";

/** The record format this swamp writes. */
export const DEPENDENCY_AUDIT_RECORD_VERSION = 1;

export interface DependencyAuditRecordEntry {
  registry: DependencyRegistry;
  name: string;
  /** The version the shipped source writes after `@`; null when none. */
  spec: string | null;
  /** The version push audited, which the bundle ships. */
  version: string;
  from: ShippedVersionSource;
}

export interface DependencyAuditRecord {
  recordVersion: typeof DEPENDENCY_AUDIT_RECORD_VERSION;
  dependencies: DependencyAuditRecordEntry[];
}

/** A dependency the audit resolved, with the version that ships. */
export interface ShippedDependency {
  specifier: DependencySpecifier;
  shipped: ShippedVersion;
}

/**
 * Whether a record entry may stand for the version that ships: the version
 * is a plain semver, and the spec admits it (an exact spec names it, a range
 * contains it). A dist-tag or no spec admits any version. The registry
 * ignores an entry that fails this, or whose version is not published, and
 * resolves that dependency itself.
 */
export function auditRecordEntryUsable(
  entry: {
    registry: string;
    name: string;
    spec: string | null;
    version: string;
  },
): boolean {
  if (entry.registry !== "npm" && entry.registry !== "jsr") return false;
  if (entry.name.length === 0) return false;
  const version = tryParse(entry.version);
  if (!version || format(version) !== entry.version) return false;
  if (entry.spec === null) return true;
  const exact = exactVersion(entry.spec);
  if (exact !== null) return exact === entry.version;
  const range = tryParseRange(entry.spec);
  return range ? satisfies(version, range) : true;
}

function compareEntries(
  a: DependencyAuditRecordEntry,
  b: DependencyAuditRecordEntry,
): number {
  if (a.registry !== b.registry) return a.registry < b.registry ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.spec === b.spec) return 0;
  if (a.spec === null) return -1;
  if (b.spec === null) return 1;
  return a.spec < b.spec ? -1 : 1;
}

/**
 * The record for the dependencies the audit resolved. A package.json-mode
 * import is keyed by its installed version, which the shipped source pins;
 * every other import by the spec it is audited at. Each key appears once,
 * entries the registry would ignore are left out, and the order is fixed so
 * the archive is the same on every push.
 */
export function buildDependencyAuditRecord(
  shipped: readonly ShippedDependency[],
): DependencyAuditRecord {
  const entries = new Map<string, DependencyAuditRecordEntry>();
  for (const { specifier, shipped: version } of shipped) {
    const entry: DependencyAuditRecordEntry = {
      registry: specifier.registry,
      name: specifier.name,
      spec: specifier.installedVersion ?? specifier.version,
      version: version.version,
      from: version.from,
    };
    if (!auditRecordEntryUsable(entry)) continue;
    const key = `${entry.registry}:${entry.name}@${entry.spec ?? ""}`;
    if (!entries.has(key)) entries.set(key, entry);
  }
  return {
    recordVersion: DEPENDENCY_AUDIT_RECORD_VERSION,
    dependencies: [...entries.values()].sort(compareEntries),
  };
}

/** The record as the archive stores it. */
export function serializeDependencyAuditRecord(
  record: DependencyAuditRecord,
): string {
  return JSON.stringify(
    {
      recordVersion: record.recordVersion,
      dependencies: record.dependencies.map((e) => ({
        registry: e.registry,
        name: e.name,
        spec: e.spec,
        version: e.version,
        from: e.from,
      })),
    },
    null,
    2,
  ) + "\n";
}
