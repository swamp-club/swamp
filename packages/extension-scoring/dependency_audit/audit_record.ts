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
  type RecordedDependencyVersions,
  type ShippedVersion,
  type ShippedVersionSource,
} from "./resolution.ts";
import type { DependencySpecifier } from "./specifiers.ts";

/**
 * the version push audited for each npm: and jsr: dependency the shipped source
 * imports, so the registry scorecard audits what ships instead of re-resolving
 * a range; additive, a registry that predates it ignores the file
 */

export const DEPENDENCY_AUDIT_RECORD_FILENAME = "dependency-audit.json";

/** the legacy v1 record format; a push writes DEPENDENCY_AUDIT_RECORD_VERSION_2 */
export const DEPENDENCY_AUDIT_RECORD_VERSION = 1;

export interface DependencyAuditRecordEntry {
  registry: DependencyRegistry;
  name: string;
  spec: string | null;
  version: string;
  from: ShippedVersionSource;
}

export interface DependencyAuditRecord {
  recordVersion: typeof DEPENDENCY_AUDIT_RECORD_VERSION;
  dependencies: DependencyAuditRecordEntry[];
}

export interface ShippedDependency {
  specifier: DependencySpecifier;
  shipped: ShippedVersion;
}

/**
 * an entry is usable when its version is plain semver and the spec admits it (a
 * dist-tag or no spec admits any); the registry ignores other entries and
 * resolves those dependencies itself
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
 * package.json-mode imports are keyed by installed version, others by audited
 * spec; ignorable entries are left out and the order is fixed so the archive is
 * identical on every push
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

export const MAX_DEPENDENCY_AUDIT_RECORD_BYTES = 1024 * 1024;

const SOURCES: ReadonlySet<string> = new Set<ShippedVersionSource>([
  "exact",
  "installed",
  "lockfile",
  "registry",
]);

function keyOf(
  registry: DependencyRegistry,
  name: string,
  spec: string | null,
): string {
  return JSON.stringify([registry, name, spec]);
}

/**
 * the author writes the record, so off-format input reads as no record, an
 * unused entry as no entry and an unknown `from` as registry; the first entry
 * for a key wins
 */
export function parseDependencyAuditRecord(
  text: string,
): RecordedDependencyVersions | null {
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (body.recordVersion !== DEPENDENCY_AUDIT_RECORD_VERSION) return null;
  if (!Array.isArray(body.dependencies)) return null;

  const entries = new Map<
    string,
    { version: string; from: ShippedVersionSource }
  >();
  for (const raw of body.dependencies) {
    if (!raw || typeof raw !== "object") continue;
    const { registry, name, spec, version, from } = raw as Record<
      string,
      unknown
    >;
    if (
      typeof registry !== "string" || typeof name !== "string" ||
      (spec !== null && typeof spec !== "string") ||
      typeof version !== "string"
    ) continue;
    const entry = { registry, name, spec, version };
    if (!auditRecordEntryUsable(entry)) continue;
    const key = keyOf(registry as DependencyRegistry, name, spec);
    if (entries.has(key)) continue;
    entries.set(key, {
      version,
      from: typeof from === "string" && SOURCES.has(from)
        ? from as ShippedVersionSource
        : "registry",
    });
  }

  return {
    recordedFor: (registry, name, specVersion) =>
      entries.get(keyOf(registry, name, specVersion)),
  };
}

/**
 * each entry is one exact shipped version (spec equals version); `bundles`
 * holds a SHA-256 per bundle file; a record without `bundleFormat` reads as
 * DEFAULT_BUNDLE_FORMAT; a v1-only reader sees no record
 */
export const DEPENDENCY_AUDIT_RECORD_VERSION_2 = 2;

/**
 * the bundle format of a v2 record without `bundleFormat`; every such record
 * was pushed under format 1
 */
export const DEFAULT_BUNDLE_FORMAT = 1;

export interface DependencyAuditRecordV2Entry {
  registry: DependencyRegistry;
  name: string;
  spec: string;
  version: string;
  /** The weakest source across the imports that ship this version. */
  from: ShippedVersionSource;
  locked: boolean;
  writtenAs: string[];
}

export type UnauditedDependencyKind = "url" | "git" | "package-json";

export interface UnauditedDependency {
  kind: UnauditedDependencyKind;
  origin: string;
  /**
   * A SHA-256 of each module the bundle holds, keyed by its URL or its
   * node_modules-relative path; never a local absolute path.
   */
  modules: Record<string, string>;
}

export interface DependencyAuditRecordV2 {
  recordVersion: typeof DEPENDENCY_AUDIT_RECORD_VERSION_2;
  bundleFormat: number;
  bundles: Record<string, string>;
  dependencies: DependencyAuditRecordV2Entry[];
  unaudited: UnauditedDependency[];
}

export interface ShippedImport {
  registry: DependencyRegistry;
  name: string;
  writtenAs: string;
  shipped: ShippedVersion;
}

const SOURCE_STRENGTH: Record<ShippedVersionSource, number> = {
  exact: 0,
  lockfile: 1,
  installed: 2,
  registry: 3,
};

function sortedRecord(entries: Iterable<[string, string]>) {
  return Object.fromEntries(
    [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  );
}

export function isPlainSemver(version: string): boolean {
  const parsed = tryParse(version);
  return parsed !== undefined && format(parsed) === version;
}

/**
 * imports that are not plain semver are left out, and the order is fixed so the
 * archive is identical on every push
 */
export function buildDependencyAuditRecordV2(input: {
  imports: readonly ShippedImport[];
  bundleFormat: number;
  bundles: Readonly<Record<string, string>>;
  unaudited: readonly UnauditedDependency[];
}): DependencyAuditRecordV2 {
  const entries = new Map<string, DependencyAuditRecordV2Entry>();
  for (const { registry, name, writtenAs, shipped } of input.imports) {
    const version = shipped.version;
    if (name.length === 0 || !isPlainSemver(version)) continue;
    const key = keyOf(registry, name, version);
    const locked = shipped.locked === true || shipped.from === "lockfile";
    const entry = entries.get(key);
    if (!entry) {
      entries.set(key, {
        registry,
        name,
        spec: version,
        version,
        from: shipped.from,
        locked,
        writtenAs: [writtenAs],
      });
      continue;
    }
    if (SOURCE_STRENGTH[shipped.from] > SOURCE_STRENGTH[entry.from]) {
      entry.from = shipped.from;
    }
    entry.locked &&= locked;
    if (!entry.writtenAs.includes(writtenAs)) entry.writtenAs.push(writtenAs);
  }
  const dependencies = [...entries.values()]
    .map((e) => ({ ...e, writtenAs: [...e.writtenAs].sort() }))
    .sort((a, b) =>
      a.registry !== b.registry
        ? (a.registry < b.registry ? -1 : 1)
        : a.name !== b.name
        ? (a.name < b.name ? -1 : 1)
        : a.version < b.version
        ? -1
        : a.version > b.version
        ? 1
        : 0
    );
  const unaudited = input.unaudited
    .map((u) => ({
      kind: u.kind,
      origin: u.origin,
      modules: sortedRecord(Object.entries(u.modules)),
    }))
    .sort((a, b) =>
      a.kind !== b.kind
        ? (a.kind < b.kind ? -1 : 1)
        : a.origin < b.origin
        ? -1
        : a.origin > b.origin
        ? 1
        : 0
    );
  return {
    recordVersion: DEPENDENCY_AUDIT_RECORD_VERSION_2,
    bundleFormat: input.bundleFormat,
    bundles: sortedRecord(Object.entries(input.bundles)),
    dependencies,
    unaudited,
  };
}

export function serializeDependencyAuditRecordV2(
  record: DependencyAuditRecordV2,
): string {
  return JSON.stringify(
    {
      recordVersion: record.recordVersion,
      bundleFormat: record.bundleFormat,
      bundles: sortedRecord(Object.entries(record.bundles)),
      dependencies: record.dependencies.map((e) => ({
        registry: e.registry,
        name: e.name,
        spec: e.spec,
        version: e.version,
        from: e.from,
        locked: e.locked,
        writtenAs: e.writtenAs,
      })),
      unaudited: record.unaudited.map((u) => ({
        kind: u.kind,
        origin: u.origin,
        modules: sortedRecord(Object.entries(u.modules)),
      })),
    },
    null,
    2,
  ) + "\n";
}

const UNAUDITED_KINDS: ReadonlySet<string> = new Set<UnauditedDependencyKind>(
  ["url", "git", "package-json"],
);

function stringRecord(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") return null;
    out[k] = v;
  }
  return out;
}

/**
 * a body that is not a v2 record reads as null and an off-format entry is left
 * out; a missing `bundleFormat` reads as DEFAULT_BUNDLE_FORMAT, a
 * non-positive-integer one makes the body no record
 */
export function parseDependencyAuditRecordV2(
  text: string,
): DependencyAuditRecordV2 | null {
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (body.recordVersion !== DEPENDENCY_AUDIT_RECORD_VERSION_2) return null;
  const bundleFormat = body.bundleFormat === undefined
    ? DEFAULT_BUNDLE_FORMAT
    : body.bundleFormat;
  if (
    typeof bundleFormat !== "number" || !Number.isSafeInteger(bundleFormat) ||
    bundleFormat < 1
  ) return null;
  const bundles = stringRecord(body.bundles);
  if (
    !bundles || !Array.isArray(body.dependencies) ||
    !Array.isArray(body.unaudited)
  ) return null;

  const dependencies: DependencyAuditRecordV2Entry[] = [];
  const seen = new Set<string>();
  for (const raw of body.dependencies) {
    if (!raw || typeof raw !== "object") continue;
    const { registry, name, spec, version, from, locked, writtenAs } =
      raw as Record<string, unknown>;
    if (
      (registry !== "npm" && registry !== "jsr") ||
      typeof name !== "string" || name.length === 0 ||
      typeof version !== "string" || !isPlainSemver(version) ||
      spec !== version || typeof from !== "string" || !SOURCES.has(from) ||
      typeof locked !== "boolean" || !Array.isArray(writtenAs) ||
      !writtenAs.every((w) => typeof w === "string")
    ) continue;
    const key = keyOf(registry, name, version);
    if (seen.has(key)) continue;
    seen.add(key);
    dependencies.push({
      registry,
      name,
      spec: version,
      version,
      from: from as ShippedVersionSource,
      locked,
      writtenAs: writtenAs as string[],
    });
  }

  const unaudited: UnauditedDependency[] = [];
  for (const raw of body.unaudited) {
    if (!raw || typeof raw !== "object") continue;
    const { kind, origin, modules } = raw as Record<string, unknown>;
    const parsedModules = stringRecord(modules);
    if (
      typeof kind !== "string" || !UNAUDITED_KINDS.has(kind) ||
      typeof origin !== "string" || !parsedModules
    ) continue;
    unaudited.push({
      kind: kind as UnauditedDependencyKind,
      origin,
      modules: parsedModules,
    });
  }

  return {
    recordVersion: DEPENDENCY_AUDIT_RECORD_VERSION_2,
    bundleFormat,
    bundles,
    dependencies,
    unaudited,
  };
}
