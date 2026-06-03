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

/*
 * RowState — the freshness contract for a Source within an Extension.
 * Seven tags. Type resolution returns a Source iff its state is `Indexed`;
 * reconcile and `swamp doctor extensions` see all states.
 *
 * State machine table (architect requirement, matches W1a precedent):
 *
 * | Tag                   | Entry condition                                                                                                       | Visible to type resolver | Exit transitions                                                                                                                                                                                                                                                                                                                                                                                                |
 * | --------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
 * | `Indexed`             | Source seen, bundle present on disk, schema validation passed.                                                        | YES                      | Fingerprint changes → re-bundle → settles in `Bundled` (transient) → `Indexed` (validation pass) or `ValidationFailed` (validation fail). Source missing on disk → `OrphanedBundleOnly` if bundle present, else `Tombstoned`.                                                                                                                                                                                    |
 * | `Bundled`             | Transient. Set by `recordBundled` after a successful bundle build, before validation runs.                            | NO                       | Validation runs → settles in `Indexed` (pass) or `ValidationFailed` (fail) before reconcile returns. Should never persist beyond a single reconcile call.                                                                                                                                                                                                                                                       |
 * | `BundleBuildFailed`   | `recordBundleBuildFailed` — bundle attempt failed AND no cached bundle on disk.                                       | NO                       | Fingerprint changes + successful rebundle → `Bundled` → `Indexed`/`ValidationFailed`. Same fingerprint + still failing → stays here with the new error.                                                                                                                                                                                                                                                         |
 * | `ValidationFailed`    | `recordValidationFailed` — bundle imports cleanly but Zod schema validation rejects the export.                       | NO                       | Fingerprint changes + new bundle + validation passes → `Indexed`. Source missing → `OrphanedBundleOnly` (bundle retained) or `Tombstoned`. Per I3, the fingerprint and bundle are retained while in this state — freshness terminates against the last-seen-broken hash so we don't loop on rebundle.                                                                                                            |
 * | `EntryPointUnreadable`| `recordEntryPointUnreadable` — entry-point itself failed to fingerprint (filesystem error / perms).                   | NO                       | Entry point readable on next reconcile → re-bundle → `Bundled` → `Indexed`/`ValidationFailed`/`BundleBuildFailed`. Source missing → `Tombstoned`.                                                                                                                                                                                                                                                                |
 * | `OrphanedBundleOnly`  | `markSourceMissing` when source `.ts` is gone but a bundle exists on disk (pulled-extension case).                    | NO                       | Source reappears → `Bundled` → `Indexed`/`ValidationFailed`. Extension removed → `Tombstoned`.                                                                                                                                                                                                                                                                                                                  |
 * | `Tombstoned`          | `recordSourceMissing`, or `markSourceMissing` when no bundle exists, or `tombstoneAll()` for upgrade-as-atomic-swap.  | NO                       | Excluded from registration (per I4). Retained in-memory until the aggregate is persisted, then dropped on save. No transitions OUT of Tombstoned — once tombstoned, always tombstoned within this aggregate; a re-introduction is a brand-new Source.                                                                                                                                                            |
 *
 * Per I3, ValidationFailed retains its fingerprint and bundle. Per I4,
 * Tombstoned is excluded from registration but retained in-memory until
 * the aggregate is persisted, at which point the repository's diff-save
 * deletes the row.
 */

import type { BundleLocation } from "./bundle_location.ts";

/**
 * Normalised type name. Folded to NFC + lowercase per the design doc's
 * "case-folded NFC-normalised" rule. Stored as TEXT in `bundle_types`.
 */
export type TypeName = string;

/**
 * Why a Source was tombstoned. Diagnostic-only — the registry doesn't
 * branch on this, but `swamp doctor extensions` does.
 */
export type TombstoneReason =
  | "source-deleted"
  | "extension-removed"
  | "renamed";

/**
 * Discriminated union over the 7 Source states. See the module-level
 * comment for the full state-machine table.
 */
export type RowState =
  | { tag: "Indexed"; type: TypeName; bundle: BundleLocation }
  | {
    tag: "Bundled";
    type: TypeName;
    bundle: BundleLocation;
    loadedInProcess: boolean;
  }
  | { tag: "BundleBuildFailed"; lastError: string }
  | { tag: "ValidationFailed"; bundle: BundleLocation; lastError: string }
  | { tag: "EntryPointUnreadable"; lastError: string }
  | { tag: "OrphanedBundleOnly"; bundle: BundleLocation }
  | { tag: "Tombstoned"; reason: TombstoneReason };

/**
 * The literal tag set, exhaustively. Mirrors the discriminant of
 * {@link RowState} and is used by callers that must enumerate every
 * state (e.g. `swamp doctor extensions` rendering, exhaustiveness
 * tests).
 */
export const ROW_STATE_TAGS = [
  "Indexed",
  "Bundled",
  "BundleBuildFailed",
  "ValidationFailed",
  "EntryPointUnreadable",
  "OrphanedBundleOnly",
  "Tombstoned",
] as const;

export type RowStateTag = typeof ROW_STATE_TAGS[number];

/**
 * Whether a state is considered "visible to the type resolver" — only
 * `Indexed` Sources are visible. Every other state is hidden until a
 * transition lifts the Source back to `Indexed`.
 */
export function isVisibleToResolver(state: RowState): boolean {
  return state.tag === "Indexed";
}
