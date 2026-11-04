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

/** Reading a swamp app's package.json and bun.lock, for the dependency audit. */

import { satisfies, tryParse, tryParseRange } from "@std/semver";
import { MAX_LOCKFILE_BYTES } from "./lockfile.ts";
import { type DependencySpecifier, NPM_NAME_RE } from "./specifiers.ts";

/** Apps build with Bun, so this is the only lockfile an app may have. */
export const BUN_LOCKFILE = "bun.lock";

/** Another package manager's lockfile, which an app may not have. */
export const OTHER_APP_LOCKFILES: readonly string[] = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
];

/** What an app folder holds for its dependencies; `null` for a missing file. */
export interface AppPackageFiles {
  readonly packageJson: string | null;
  readonly bunLock: string | null;
  /** Names from {@link OTHER_APP_LOCKFILES} the folder also holds. */
  readonly otherLockfiles: readonly string[];
}

/** Every package passes the lock's static checks; only `shipped` is looked up on npm and OSV. */
export interface AppDependencies {
  /** The {@link shippedLockKeys} packages: audited in full. */
  readonly shipped: DependencySpecifier[];
  /** Build tools and types only the build runs: static checks only. */
  readonly buildOnly: DependencySpecifier[];
  /** Why the app's dependencies cannot be audited. */
  readonly problems: string[];
}

/** External to the app build, so swamp audits the copies it serves; matches the SDK's `PLATFORM_MODULES`. */
export const PLATFORM_PACKAGES: ReadonlySet<string> = new Set([
  "react",
  "react-dom",
  "@swamp-club/app-sdk",
  "@swamp-club/ui",
  "d3-array",
  "d3-brush",
  "d3-drag",
  "d3-force",
  "d3-format",
  "d3-hierarchy",
  "d3-interpolate",
  "d3-scale",
  "d3-selection",
  "d3-shape",
  "d3-time-format",
  "d3-zoom",
]);

/** bun.lock is JSON with trailing commas; they are dropped outside strings. */
export function parseBunLockText(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return JSON.parse(out);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, spec] of Object.entries(value)) {
    if (typeof spec === "string") out[key] = spec;
  }
  return out;
}

/** The package.json maps whose packages bun installs, most binding first. */
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** Bun may skip these when they cannot install, so the lock may lack them. */
const UNLOCKED_FIELDS: ReadonlySet<string> = new Set([
  "optionalDependencies",
  "peerDependencies",
]);

/** Fields that change what bun installs or runs beyond the audited packages. */
const REFUSED_FIELDS: Readonly<Record<string, string>> = {
  overrides: "replaces the versions packages ask for",
  resolutions: "replaces the versions packages ask for",
  trustedDependencies: "lets packages run install scripts",
  patchedDependencies: "patches package code after install",
  workspaces: "builds local packages into the app",
};

/** The package.json and lock entry maps a package needs at runtime. */
const RUNTIME_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** A bun.lock key's package names: `a/@s/b` nests `@s/b` under `a`. */
function keyPath(key: string): string[] {
  const parts = key.split("/");
  const names: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    names.push(
      parts[i].startsWith("@") && i + 1 < parts.length
        ? `${parts[i]}/${parts[++i]}`
        : parts[i],
    );
  }
  return names;
}

/** Climbs as node resolution does: nested under `from`, then each ancestor, then the top level. */
function resolveLockKey(
  packages: Record<string, unknown>,
  from: string | null,
  name: string,
): string | null {
  const path = from === null ? [] : keyPath(from);
  for (let depth = path.length; depth >= 0; depth--) {
    const key = [...path.slice(0, depth), name].join("/");
    if (Object.hasOwn(packages, key)) return key;
  }
  return null;
}

/** The dependency names a lock entry's metadata gives for runtime. */
function runtimeNames(entry: unknown): string[] {
  if (!Array.isArray(entry)) return [];
  const meta = entry[2];
  if (!isRecord(meta)) return [];
  return RUNTIME_FIELDS.flatMap((field) => Object.keys(stringMap(meta[field])));
}

/** A platform package is external to the build, so neither it nor what only it needs is shipped. */
export function shippedLockKeys(
  manifest: unknown,
  packages: Record<string, unknown>,
): Set<string> {
  const fields = isRecord(manifest) ? manifest : {};
  const shipped = new Set<string>();
  const queue: { from: string | null; name: string }[] = RUNTIME_FIELDS
    .flatMap((field) =>
      Object.keys(stringMap(fields[field])).map((name) => ({
        from: null,
        name,
      }))
    );
  while (queue.length > 0) {
    const { from, name } = queue.pop()!;
    if (PLATFORM_PACKAGES.has(name)) continue;
    const key = resolveLockKey(packages, from, name);
    if (key === null || shipped.has(key)) continue;
    shipped.add(key);
    for (const dep of runtimeNames(packages[key])) {
      queue.push({ from: key, name: dep });
    }
  }
  return shipped;
}

/** bun writes the default npm registry as an empty string. */
const DEFAULT_REGISTRIES: ReadonlySet<string> = new Set([
  "",
  "https://registry.npmjs.org",
  "https://registry.npmjs.org/",
]);

const INTEGRITY_RE = /^sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

/** The name and version in a bun.lock entry's `name@version`. */
function splitPackageId(id: string): { name: string; version: string } | null {
  const at = id.indexOf("@", 1);
  return at === -1
    ? null
    : { name: id.slice(0, at), version: id.slice(at + 1) };
}

/** The version in a bun.lock entry's `name@version`. */
function lockedVersion(entry: unknown, name: string): string | null {
  if (!Array.isArray(entry) || typeof entry[0] !== "string") return null;
  const id = entry[0];
  return id.startsWith(`${name}@`) ? id.slice(name.length + 1) : null;
}

interface LockedPackage {
  name: string;
  version: string;
}

/** Only an npm registry package at an exact version with an integrity hash is auditable. */
function registryPackage(
  key: string,
  entry: unknown,
  label: string,
): LockedPackage | string {
  const id = Array.isArray(entry) && typeof entry[0] === "string"
    ? entry[0]
    : null;
  const parts = id === null ? null : splitPackageId(id);
  if (
    id === null || parts === null || !NPM_NAME_RE.test(parts.name) ||
    tryParse(parts.version) === undefined
  ) {
    return `App ${label}'s ${BUN_LOCKFILE} takes ${key} from ${
      id ?? "an unreadable entry"
    }, not the npm registry, so it cannot be audited. Depend on a published npm version and run bun install.`;
  }
  const registry = (entry as unknown[])[1];
  if (typeof registry !== "string" || !DEFAULT_REGISTRIES.has(registry)) {
    return `App ${label}'s ${BUN_LOCKFILE} takes ${id} from ${
      typeof registry === "string" ? registry : "an unnamed source"
    }, not the npm registry, so it cannot be audited. Remove the registry setting and run bun install.`;
  }
  const integrity = (entry as unknown[])[3];
  if (typeof integrity !== "string" || !INTEGRITY_RE.test(integrity)) {
    return `App ${label}'s ${BUN_LOCKFILE} has no integrity hash for ${id}. Run bun install.`;
  }
  return parts;
}

/** Each package is at the version the lock pins: those package.json names cite it, the rest cite the lock. */
export function appDependencySpecifiers(
  files: AppPackageFiles,
  label: string,
  sourceFile: string,
  lockFile: string,
): AppDependencies {
  const problems: string[] = [];
  const shipped: DependencySpecifier[] = [];
  const buildOnly: DependencySpecifier[] = [];
  const result = () => ({ shipped, buildOnly, problems });
  if (files.packageJson === null) {
    return {
      shipped,
      buildOnly,
      problems: [
        `App ${label} has no package.json, so what its build ships cannot be audited.`,
      ],
    };
  }
  for (const other of files.otherLockfiles) {
    problems.push(
      `App ${label} has ${other}; apps build with Bun only. Remove it and run bun install.`,
    );
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(files.packageJson);
  } catch {
    problems.push(`App ${label} has a package.json that is not JSON.`);
    return result();
  }
  const fields = isRecord(manifest) ? manifest : {};
  for (const [field, effect] of Object.entries(REFUSED_FIELDS)) {
    if (Object.hasOwn(fields, field)) {
      problems.push(
        `App ${label}'s package.json sets ${field}, which ${effect} outside the audit. Remove it and run bun install.`,
      );
    }
  }

  const declared = new Map<string, { spec: string; field: string }>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(stringMap(fields[field]))) {
      const earlier = declared.get(name);
      if (earlier === undefined) declared.set(name, { spec, field });
      else if (earlier.spec !== spec) {
        problems.push(
          `App ${label}'s package.json declares ${name} as ${earlier.spec} in ${earlier.field} and ${spec} in ${field}. Declare it once.`,
        );
      }
    }
  }
  if (declared.size === 0 && files.bunLock === null) {
    return result();
  }
  if (files.bunLock === null) {
    problems.push(
      `App ${label} has no ${BUN_LOCKFILE}, so its dependency versions are not pinned. Run bun install.`,
    );
    return result();
  }
  let lock: Record<string, unknown>;
  let packages: Record<string, unknown>;
  try {
    if (files.bunLock.length > MAX_LOCKFILE_BYTES) throw new Error();
    const parsed = parseBunLockText(files.bunLock);
    if (!isRecord(parsed) || !isRecord(parsed.packages)) throw new Error();
    lock = parsed;
    packages = parsed.packages;
  } catch {
    problems.push(`App ${label} has a ${BUN_LOCKFILE} that cannot be read.`);
    return result();
  }
  for (const [field, effect] of Object.entries(REFUSED_FIELDS)) {
    if (field !== "workspaces" && Object.hasOwn(lock, field)) {
      problems.push(
        `App ${label}'s ${BUN_LOCKFILE} records ${field}, which ${effect} outside the audit. Remove it from package.json and run bun install.`,
      );
    }
  }
  if (
    isRecord(lock.workspaces) &&
    Object.keys(lock.workspaces).some((path) => path !== "")
  ) {
    problems.push(
      `App ${label}'s ${BUN_LOCKFILE} has workspaces besides the app; an app is one package. Remove them and run bun install.`,
    );
  }

  const locked: LockedPackage[] = [];
  const shippedIds = new Set<string>();
  const shippedKeys = shippedLockKeys(manifest, packages);
  for (const [key, entry] of Object.entries(packages)) {
    const pkg = registryPackage(key, entry, label);
    if (typeof pkg === "string") problems.push(pkg);
    else {
      locked.push(pkg);
      if (shippedKeys.has(key)) shippedIds.add(`${pkg.name}@${pkg.version}`);
    }
  }
  const listFor = (id: string) => shippedIds.has(id) ? shipped : buildOnly;
  const covered = new Set<string>();
  for (const [name, { spec, field }] of declared) {
    const range = tryParseRange(spec);
    if (range === undefined) {
      problems.push(
        `App ${label} takes ${name} from ${spec}, which is not an npm registry version and cannot be audited.`,
      );
      continue;
    }
    const version = lockedVersion(packages[name], name);
    if (version === null && UNLOCKED_FIELDS.has(field)) continue;
    const parsed = version === null ? undefined : tryParse(version);
    if (version === null || parsed === undefined) {
      problems.push(
        `App ${label}'s ${BUN_LOCKFILE} does not pin ${name} to an npm registry version. Run bun install.`,
      );
      continue;
    }
    if (!satisfies(parsed, range)) {
      problems.push(
        `App ${label}'s ${BUN_LOCKFILE} pins ${name} ${version}, outside ${spec} in package.json. Run bun install.`,
      );
      continue;
    }
    covered.add(`${name}@${version}`);
    listFor(`${name}@${version}`).push({
      name,
      version: spec,
      registry: "npm",
      sourceFile,
      bundled: { version, from: "lockfile", locked: true },
    });
  }
  for (const { name, version } of locked) {
    const id = `${name}@${version}`;
    if (covered.has(id)) continue;
    covered.add(id);
    listFor(id).push({
      name,
      version,
      registry: "npm",
      sourceFile: lockFile,
      bundled: { version, from: "lockfile", locked: true },
    });
  }
  return result();
}
