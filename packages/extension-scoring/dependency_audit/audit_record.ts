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

/**
 * The v1 record format, which pushes before swamp-club#3970 wrote; a push
 * now writes {@link DEPENDENCY_AUDIT_RECORD_VERSION_2}.
 */
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
 * resolves that dependency itself. Push writes only entries that pass, and
 * the registry reads only those.
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

/** The largest record the registry reads. */
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
 * Reads a record from an archive. The author writes it, so anything off
 * format reads as no record, an entry it does not use reads as no entry,
 * and an unknown `from` reads as `registry`. The first entry for a key
 * wins.
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
 * The v2 record (swamp-club#3970), which a push of the canonical shipped
 * form writes. Every `npm:` and `jsr:` import in the archive's source is
 * exact, so each entry is one shipped package version with `spec` equal to
 * `version`; `writtenAs` keeps what the author wrote, and `from` and
 * `locked` say how that version was chosen. `bundles` holds a SHA-256 of
 * each bundle file, so a consumer or the registry can tell the bundle is
 * the one published with this source, and `bundleFormat` names what those
 * bundles expect from the swamp that runs them (swamp-club#3972). A record
 * written before `bundleFormat` existed reads as format
 * {@link DEFAULT_BUNDLE_FORMAT}. `unaudited` lists code from outside npm and
 * JSR that the bundles hold:
 *
 * ```json
 * {
 *   "recordVersion": 2,
 *   "bundleFormat": 1,
 *   "bundles": { "bundles/m.js": "sha256:…" },
 *   "dependencies": [
 *     { "registry": "npm", "name": "ms", "spec": "2.1.3", "version": "2.1.3",
 *       "from": "lockfile", "locked": true, "writtenAs": ["npm:ms@^2"] }
 *   ],
 *   "unaudited": [
 *     { "kind": "url", "origin": "https://example.com/x.ts",
 *       "modules": { "https://example.com/x.ts": "sha256:…" } }
 *   ]
 * }
 * ```
 *
 * A reader that knows only v1 reads a v2 record as no record.
 */
export const DEPENDENCY_AUDIT_RECORD_VERSION_2 = 2;

/**
 * The bundle format a v2 record without `bundleFormat` was written for:
 * every such record was pushed before the field existed, under format 1.
 */
export const DEFAULT_BUNDLE_FORMAT = 1;

/** One shipped package version in a v2 record. */
export interface DependencyAuditRecordV2Entry {
  registry: DependencyRegistry;
  name: string;
  /** What the shipped source writes after `@`; always equal to `version`. */
  spec: string;
  version: string;
  /** The weakest source across the imports that ship this version. */
  from: ShippedVersionSource;
  /** Every import that ships this version was fixed by a valid lock. */
  locked: boolean;
  /** The specifiers the author wrote for it, sorted: `npm:ms@^2`, or a bare `ms`. */
  writtenAs: string[];
}

/** Where code from outside npm and JSR came from. */
export type UnauditedDependencyKind = "url" | "git" | "package-json";

/** Code the bundles hold that no registry audit covers. */
export interface UnauditedDependency {
  kind: UnauditedDependencyKind;
  /** The URL, or the package.json spec as written (`file:../x`, a git URL). */
  origin: string;
  /**
   * A SHA-256 of each module the bundle holds, keyed by its URL or its
   * node_modules-relative path; never a local absolute path.
   */
  modules: Record<string, string>;
}

export interface DependencyAuditRecordV2 {
  recordVersion: typeof DEPENDENCY_AUDIT_RECORD_VERSION_2;
  /** What the bundles expect from the swamp that runs them; a positive integer. */
  bundleFormat: number;
  /** Each bundle file's archive path to its `sha256:<hex>`. */
  bundles: Record<string, string>;
  dependencies: DependencyAuditRecordV2Entry[];
  unaudited: UnauditedDependency[];
}

/** One import push audited, with the version the bundle holds. */
export interface ShippedImport {
  registry: DependencyRegistry;
  name: string;
  /** The specifier as the author wrote it, or the bare name an import map resolved. */
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

/** Whether `version` is a plain semver, as the canonical form writes it. */
export function isPlainSemver(version: string): boolean {
  const parsed = tryParse(version);
  return parsed !== undefined && format(parsed) === version;
}

/**
 * The v2 record for what push ships: one entry per shipped package version,
 * imports that are not plain semver left out, and a fixed order so the
 * archive is the same on every push.
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

/** The v2 record as the archive stores it. */
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
 * Reads a v2 record from an archive. The author writes it, so a body that
 * is not a v2 record reads as null, and an entry off format is left out:
 * a dependency entry must name npm or jsr, a plain semver version and the
 * same spec; an unaudited entry a known kind, an origin and its modules.
 * The first entry for a version wins. A missing `bundleFormat` reads as
 * {@link DEFAULT_BUNDLE_FORMAT}; one that is not a positive integer makes
 * the body no record, since no format can be told from it.
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
