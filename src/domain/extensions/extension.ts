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

import { markErrorPaths } from "../errors.ts";
import type { ExtensionKind } from "../../infrastructure/persistence/extension_catalog_store.ts";
import { canonicalizePath } from "../../infrastructure/persistence/canonicalize_path.ts";
import type { BundleLocation } from "./bundle_location.ts";
import type { RowState, TombstoneReason, TypeName } from "./row_state.ts";
import {
  makeSource,
  type Source,
  withFingerprintAndState,
  withState,
} from "./source.ts";
import type { SourceFingerprint } from "./source_fingerprint.ts";
import type { SourceLocation } from "./source_location.ts";

/**
 * across aggregates origin precedence is local > source-mounted > pulled;
 * within one Extension all Sources share an origin
 */
export type ExtensionOrigin = "pulled" | "source-mounted" | "local";

export type CalVer = string;

/**
 * keyed (name, version); transitions return new instances. Locals take the
 * manifest name and version, else @local/<basename> at 0.0.0; basename
 * collisions are harmless since catalogs are per repo
 */
export interface Extension {
  readonly name: string;
  readonly version: CalVer;
  readonly origin: ExtensionOrigin;
  readonly extensionRoot: string;
  readonly checksum?: string;
  readonly sources: ReadonlyMap<SourceLocation, Source>;
}

export class IntraExtensionDuplicateType extends Error {
  readonly extensionName: string;
  readonly extensionVersion: CalVer;
  readonly kind: ExtensionKind;
  readonly type: TypeName;
  readonly canonicalPaths: readonly [string, string];

  constructor(args: {
    extensionName: string;
    extensionVersion: CalVer;
    kind: ExtensionKind;
    type: TypeName;
    canonicalPaths: [string, string];
  }) {
    super(
      `Extension ${args.extensionName}@${args.extensionVersion} has two ` +
        `Sources sharing (kind=${args.kind}, type=${args.type}): ` +
        `${args.canonicalPaths[0]} and ${args.canonicalPaths[1]}`,
    );
    this.name = "IntraExtensionDuplicateType";
    this.extensionName = args.extensionName;
    this.extensionVersion = args.extensionVersion;
    this.kind = args.kind;
    this.type = args.type;
    this.canonicalPaths = args.canonicalPaths;
    markErrorPaths(this, args.canonicalPaths);
  }
}

export class SourceExtensionRootMismatch extends Error {
  readonly extensionName: string;
  readonly expected: string;
  readonly actual: string;
  constructor(args: {
    extensionName: string;
    expected: string;
    actual: string;
  }) {
    super(
      `Source extensionRoot ${args.actual} does not match Extension ` +
        `${args.extensionName}'s extensionRoot ${args.expected} (I1)`,
    );
    this.name = "SourceExtensionRootMismatch";
    this.extensionName = args.extensionName;
    this.expected = args.expected;
    this.actual = args.actual;
    markErrorPaths(this, [args.actual, args.expected]);
  }
}

/**
 * extensionRoot is canonicalized so the I1 comparison is symmetric; native
 * Windows paths would otherwise compare unequal to the canonical Source form
 */
export function makeExtension(args: {
  name: string;
  version: CalVer;
  origin: ExtensionOrigin;
  extensionRoot: string;
  checksum?: string;
  sources: Iterable<Source>;
}): Extension {
  const canonicalRoot = canonicalizePath(args.extensionRoot);
  const sources = new Map<SourceLocation, Source>();
  for (const s of args.sources) {
    if (s.id.extensionRoot !== canonicalRoot) {
      throw new SourceExtensionRootMismatch({
        extensionName: args.name,
        expected: canonicalRoot,
        actual: s.id.extensionRoot,
      });
    }
    sources.set(s.id, s);
  }
  const resolved = enforceI2(sources);

  return {
    name: args.name,
    version: args.version,
    origin: args.origin,
    extensionRoot: canonicalRoot,
    checksum: args.checksum,
    sources: resolved,
  };
}

/**
 * saveAll([vN.tombstoneAll(), vN+1]) swaps versions in one transaction, with
 * I-Repo-1 checked against the post-state
 */
export function tombstoneAll(extension: Extension): Extension {
  const next = new Map<SourceLocation, Source>();
  for (const [id, source] of extension.sources) {
    next.set(
      id,
      withState(source, { tag: "Tombstoned", reason: "extension-removed" }),
    );
  }
  return {
    ...extension,
    sources: next,
  };
}

export function observeFreshSource(
  extension: Extension,
  args: {
    location: SourceLocation;
    kind: ExtensionKind;
    fingerprint: SourceFingerprint;
    type: TypeName;
    bundle: BundleLocation;
    sourceMtime: string;
  },
): Extension {
  if (args.location.extensionRoot !== extension.extensionRoot) {
    throw new SourceExtensionRootMismatch({
      extensionName: extension.name,
      expected: extension.extensionRoot,
      actual: args.location.extensionRoot,
    });
  }
  const next = new Map(extension.sources);
  const existing = next.get(args.location);
  const state: RowState = {
    tag: "Bundled",
    type: args.type,
    bundle: args.bundle,
    loadedInProcess: false,
  };
  if (existing) {
    next.set(
      args.location,
      withFingerprintAndState(
        existing,
        args.fingerprint,
        state,
        args.sourceMtime,
      ),
    );
  } else {
    next.set(
      args.location,
      makeSource({
        id: args.location,
        kind: args.kind,
        fingerprint: args.fingerprint,
        state,
        sourceMtime: args.sourceMtime,
      }),
    );
  }
  const resolved = enforceI2(next);
  return { ...extension, sources: resolved };
}

export function recordBundled(
  extension: Extension,
  args: {
    location: SourceLocation;
    type: TypeName;
    bundle: BundleLocation;
  },
): Extension {
  return updateSourceState(
    extension,
    args.location,
    { tag: "Indexed", type: args.type, bundle: args.bundle },
  );
}

/**
 * the fingerprint is updated with the transition so findStaleFiles does not
 * re-mark the file stale, which ends the rebundle loop
 */
export function recordBundleBuildFailed(
  extension: Extension,
  args: {
    location: SourceLocation;
    lastError: string;
    fingerprint?: SourceFingerprint;
    sourceMtime?: string;
  },
): Extension {
  const state: RowState = {
    tag: "BundleBuildFailed",
    lastError: args.lastError,
  };
  if (args.fingerprint !== undefined) {
    return updateSourceStateAndFingerprint(
      extension,
      args.location,
      state,
      args.fingerprint,
      args.sourceMtime,
    );
  }
  return updateSourceState(extension, args.location, state);
}

export function recordValidationFailed(
  extension: Extension,
  args: {
    location: SourceLocation;
    bundle: BundleLocation;
    lastError: string;
    fingerprint?: SourceFingerprint;
    sourceMtime?: string;
  },
): Extension {
  const state: RowState = {
    tag: "ValidationFailed",
    bundle: args.bundle,
    lastError: args.lastError,
  };
  if (args.fingerprint !== undefined) {
    return updateSourceStateAndFingerprint(
      extension,
      args.location,
      state,
      args.fingerprint,
      args.sourceMtime,
    );
  }
  return updateSourceState(extension, args.location, state);
}

export function recordEntryPointUnreadable(
  extension: Extension,
  args: { location: SourceLocation; lastError: string },
): Extension {
  return updateSourceState(
    extension,
    args.location,
    { tag: "EntryPointUnreadable", lastError: args.lastError },
  );
}

/**
 * a bundle still on disk gives OrphanedBundleOnly, which serves type resolution
 * in degraded mode; otherwise the source is tombstoned as source-deleted
 */
export function markSourceMissing(
  extension: Extension,
  args: { location: SourceLocation; bundleOnDisk: BundleLocation | null },
): Extension {
  const newState: RowState = args.bundleOnDisk
    ? { tag: "OrphanedBundleOnly", bundle: args.bundleOnDisk }
    : { tag: "Tombstoned", reason: "source-deleted" };
  return updateSourceState(extension, args.location, newState);
}

export function recordSourceMissing(
  extension: Extension,
  args: { location: SourceLocation; reason?: TombstoneReason },
): Extension {
  return updateSourceState(
    extension,
    args.location,
    { tag: "Tombstoned", reason: args.reason ?? "source-deleted" },
  );
}

export function makeLocalExtension(args: {
  repoRoot: string;
  basename: string;
  sources?: Iterable<Source>;
}): Extension {
  return makeExtension({
    name: `@local/${args.basename}`,
    version: "0.0.0",
    origin: "local",
    extensionRoot: args.repoRoot,
    sources: args.sources ?? [],
  });
}

function updateSourceState(
  extension: Extension,
  location: SourceLocation,
  state: RowState,
): Extension {
  const existing = extension.sources.get(location);
  if (!existing) {
    throw markErrorPaths(
      new Error(
        `Extension ${extension.name}@${extension.version} has no Source at ` +
          `${location.canonicalPath}; cannot update state to ${state.tag}.`,
      ),
      [location.canonicalPath],
    );
  }
  const next = new Map(extension.sources);
  next.set(location, withState(existing, state));
  const resolved = enforceI2(next);
  return { ...extension, sources: resolved };
}

function updateSourceStateAndFingerprint(
  extension: Extension,
  location: SourceLocation,
  state: RowState,
  fingerprint: SourceFingerprint,
  sourceMtime?: string,
): Extension {
  const existing = extension.sources.get(location);
  if (!existing) {
    throw markErrorPaths(
      new Error(
        `Extension ${extension.name}@${extension.version} has no Source at ` +
          `${location.canonicalPath}; cannot update state to ${state.tag}.`,
      ),
      [location.canonicalPath],
    );
  }
  const next = new Map(extension.sources);
  next.set(
    location,
    withFingerprintAndState(
      existing,
      fingerprint,
      state,
      sourceMtime ?? existing.sourceMtime,
    ),
  );
  const resolved = enforceI2(next);
  return { ...extension, sources: resolved };
}

/**
 * smaller canonicalPath wins, loser is tombstoned as renamed; extension-kind
 * sources are skipped since several files may extend one base type, as in the
 * repository check
 */
function enforceI2(
  sources: ReadonlyMap<SourceLocation, Source>,
): Map<SourceLocation, Source> {
  const seen = new Map<string, Source>();
  const losers: Source[] = [];

  for (const source of sources.values()) {
    if (source.state.tag === "Tombstoned") continue;
    if (source.kind === "extension") continue;
    const typeName = extractType(source.state);
    if (typeName === null) continue;
    const key = `${source.kind}::${typeName}`;
    const prior = seen.get(key);
    if (prior) {
      if (source.id.canonicalPath < prior.id.canonicalPath) {
        losers.push(prior);
        seen.set(key, source);
      } else {
        losers.push(source);
      }
    } else {
      seen.set(key, source);
    }
  }

  if (losers.length === 0) return new Map(sources);

  const result = new Map(sources);
  for (const loser of losers) {
    result.set(
      loser.id,
      withState(loser, { tag: "Tombstoned", reason: "renamed" }),
    );
  }
  return result;
}

/**
 * ValidationFailed returns null: its type was rejected, so it does not occupy
 * the (kind, type) namespace
 */
function extractType(state: RowState): TypeName | null {
  switch (state.tag) {
    case "Indexed":
    case "Bundled":
      return state.type;
    case "BundleBuildFailed":
    case "ValidationFailed":
    case "EntryPointUnreadable":
    case "OrphanedBundleOnly":
    case "Tombstoned":
      return null;
  }
}
