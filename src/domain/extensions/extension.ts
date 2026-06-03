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
 * Origin of an extension's content. Drives the cross-aggregate
 * `local > source-mounted > pulled` precedence rule used by
 * I-Repo-1 conflict resolution at the lifecycle layer (W2). Within a
 * single Extension all Sources share the same origin (the Extension
 * IS the origin boundary) — so intra-aggregate I2 violations cannot
 * resolve via precedence; W1b throws on construction.
 */
export type ExtensionOrigin = "pulled" | "source-mounted" | "local";

/**
 * Calendar-version tag, e.g. `2026.05.02.1`. Locals always use
 * `0.0.0`; pulled extensions get their version from the upstream
 * registry / lockfile.
 */
export type CalVer = string;

/**
 * The Extension aggregate root. Keyed `(name, version)` — the same
 * extension installed at two different versions is two distinct
 * aggregates (load-bearing for the upgrade-as-atomic-transition
 * pattern: `saveAll([vN.tombstoneAll(), vN+1])`).
 *
 * Local-extension special case (per design doc lines 264-289):
 *   - When `extensions/manifest.yaml` declares both `name` and
 *     `version`, the local aggregate uses those values. This makes
 *     the identity path-independent — the same repo mounted at
 *     different paths (host vs container) produces the same identity.
 *   - When no manifest is present, the aggregate falls back to the
 *     synthetic `@local/<basename(repoRoot)>` at version `"0.0.0"`.
 *     Basename collision across unrelated repos with the same name
 *     (e.g. `~/work/myproject` and `~/personal/myproject`) is
 *     INTENDED for the no-manifest case: per-repo catalog isolation
 *     makes the collision harmless.
 *   - Origin is `"local"`.
 *   - `extensionRoot` is the **repo root**, not a per-kind directory.
 *     Callers that walk extensionRoot must tolerate this distinction —
 *     for pulled/source-mounted it's the per-extension subtree, for
 *     locals it's the whole repo.
 *
 * **Immutability.** Every transition method returns a NEW Extension
 * instance. The aggregate itself is treated as a value by callers; the
 * repository compares the post-transition aggregate against the
 * persisted state and computes the diff to apply.
 *
 * **Invariants enforced on construction and every transition:**
 *   - I1: every Source.id.extensionRoot === Extension.extensionRoot
 *     (canonical-form equality).
 *   - I2: within this Extension, no two Sources share `(kind, typeNormalized)`
 *     in any non-Tombstoned state. Enforced by a deterministic-winner +
 *     tombstone-loser transform: the Source with the lexicographically
 *     smaller `canonicalPath` wins; the loser is tombstoned with reason
 *     `"renamed"`. Cross-aggregate uniqueness is separately enforced by
 *     the repository's I-Repo-1 invariant.
 *
 * I3 (ValidationFailed retains fingerprint+bundle) and I4 (Tombstoned
 * excluded from registration but retained in-memory) are structural —
 * they're properties of the RowState union itself, enforced by the type
 * shape, not by aggregate code.
 *
 * I5 (sources map matches the disk walk) is a reconcile-level invariant
 * owned by W3's `ReconcileFromDisk` service; the aggregate accepts
 * whatever the caller hands it.
 */
export interface Extension {
  readonly name: string;
  readonly version: CalVer;
  readonly origin: ExtensionOrigin;
  readonly extensionRoot: string;
  readonly checksum?: string;
  readonly sources: ReadonlyMap<SourceLocation, Source>;
}

/**
 * Thrown by the repository's I-Repo-1 invariant when two Sources in
 * DIFFERENT Extensions share `(kind, typeNormalized)`. Within a single
 * Extension, the aggregate resolves duplicates via deterministic-winner
 * transform (see {@link enforceI2}); `IntraExtensionDuplicateType` is
 * retained for cross-aggregate violations surfaced by the repository.
 */
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
  }
}

/**
 * Thrown when an Extension is constructed with a Source whose
 * `id.extensionRoot` does not equal the Extension's `extensionRoot`
 * (I1 violation). Both are compared in their already-canonicalized form.
 */
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
  }
}

/**
 * Constructs an Extension. Enforces I1 (extensionRoot match) and I2
 * (intra-aggregate (kind, typeNormalized) uniqueness in non-Tombstoned
 * states) against the input sources. Throws on violation.
 *
 * `args.extensionRoot` is canonicalized at the boundary so the I1
 * comparison against `Source.id.extensionRoot` (which is itself
 * canonicalized via {@link makeSourceLocation}) is symmetric on every
 * platform. Without this normalization, Windows fixtures that pass a
 * native path (`C:\Users\...\foo` with backslashes + uppercase) would
 * compare unequal to the Source's canonicalized form
 * (`c:/users/.../foo`) and I1 would fire spuriously.
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
 * Returns a NEW Extension whose every Source has been moved to the
 * `Tombstoned` state. Load-bearing for the upgrade-as-atomic-transition
 * pattern: `saveAll([vN.tombstoneAll(), vN+1])` removes v1's rows and
 * inserts v2's in one transaction, with I-Repo-1 evaluated against the
 * post-state where only v2 holds the type identifiers.
 *
 * Tombstone reason is `"extension-removed"` — every Source is being
 * retired together as part of an aggregate-level transition. (Per-Source
 * deletes use `recordSourceMissing` which sets `"source-deleted"`.)
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

/**
 * Records that a Source was observed on disk during reconcile with the
 * given fingerprint. If the Source is new to the aggregate, it's added
 * in `Bundled`-pending state (transient — caller must follow up with
 * `recordBundled` or `recordValidationFailed`/etc to settle it). If the
 * Source already exists with the same fingerprint, it's untouched. If
 * the fingerprint differs, the Source advances to a state that signals
 * "needs re-bundle" — for W1b that's modelled as `Bundled` (transient)
 * with the new fingerprint and the old bundle, leaving `recordBundled`
 * to update the bundle when the rebundle completes.
 *
 * Returns a NEW Extension. Throws if the new Source's `extensionRoot`
 * doesn't match this Extension's (I1).
 *
 * @throws SourceExtensionRootMismatch if I1 is violated.
 */
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

/**
 * Records a successful bundle build + schema validation. Settles the
 * Source in `Indexed` state. Returns a NEW Extension.
 */
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
 * Records that a bundle build failed AND no cached bundle exists on
 * disk. Returns a NEW Extension.
 *
 * When {@link fingerprint} is provided, the Source's fingerprint is
 * updated atomically with the state transition. This prevents
 * {@link findStaleFiles} from re-marking the file as stale on the
 * next pass — the stored fingerprint matches the on-disk content,
 * terminating the rebundle loop.
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

/**
 * Records that the bundle imported cleanly but Zod schema validation
 * rejected the export. Per I3, the fingerprint and bundle are retained.
 * Returns a NEW Extension.
 *
 * When {@link fingerprint} is provided, the Source's fingerprint is
 * updated atomically with the state transition (same pattern as
 * {@link recordBundleBuildFailed}).
 */
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

/**
 * Records that the entry point itself failed to fingerprint
 * (filesystem error, perms denied). Returns a NEW Extension.
 */
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
 * "Smart" missing-source transition — the source `.ts` is gone from
 * disk:
 *   - If a bundle is still on disk → `OrphanedBundleOnly` (the bundle
 *     can still serve type resolution requests in degraded mode).
 *   - Otherwise → `Tombstoned` with reason `"source-deleted"`.
 *
 * The decision needs the bundle path because the Source's existing state
 * may not include one (e.g. EntryPointUnreadable carries no bundle).
 * Returns a NEW Extension.
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

/**
 * Unconditional tombstone — the Source is being retired regardless of
 * any bundle on disk. Use when the surrounding extension is being
 * removed. Returns a NEW Extension.
 */
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

/**
 * Local-extension synthetic-aggregate constructor. Returns a fresh
 * Extension with the canonical local shape:
 *   - name: `@local/<basename(repoRoot)>`
 *   - version: `"0.0.0"`
 *   - origin: `"local"`
 *   - extensionRoot: the canonical repo root (the caller passes it pre-
 *     canonicalized; see {@link makeSourceLocation}).
 */
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

// ----- internal helpers -----

function updateSourceState(
  extension: Extension,
  location: SourceLocation,
  state: RowState,
): Extension {
  const existing = extension.sources.get(location);
  if (!existing) {
    throw new Error(
      `Extension ${extension.name}@${extension.version} has no Source at ` +
        `${location.canonicalPath}; cannot update state to ${state.tag}.`,
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
    throw new Error(
      `Extension ${extension.name}@${extension.version} has no Source at ` +
        `${location.canonicalPath}; cannot update state to ${state.tag}.`,
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
 * Enforces I2 (intra-extension `(kind, typeNormalized)` uniqueness in
 * non-Tombstoned states) via deterministic-winner + tombstone-loser
 * transform.
 *
 * When two non-Tombstoned Sources share `(kind, type)`, the one with
 * the lexicographically smaller `canonicalPath` wins; the loser is
 * tombstoned with reason `"renamed"`. Within a single Extension all
 * Sources share the same origin, so origin-precedence reduces to
 * path ordering — deterministic across platforms because
 * `canonicalPath` is already NFC-normalised and case-folded.
 *
 * Returns a NEW map with losers tombstoned. Callers replace their
 * sources map with the result.
 */
function enforceI2(
  sources: ReadonlyMap<SourceLocation, Source>,
): Map<SourceLocation, Source> {
  const seen = new Map<string, Source>();
  const losers: Source[] = [];

  for (const source of sources.values()) {
    if (source.state.tag === "Tombstoned") continue;
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
 * Returns the typeName carried by a RowState, if any. States that don't
 * carry a type (BundleBuildFailed, EntryPointUnreadable,
 * OrphanedBundleOnly, Tombstoned, ValidationFailed) return null.
 *
 * ValidationFailed intentionally returns null: the type was rejected by
 * the schema, so it does not occupy the (kind, type) namespace and
 * cannot conflict with another Source under I2 / I-Repo-1.
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
