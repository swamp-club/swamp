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

// type resolution returns a Source only in state Indexed; ValidationFailed
// keeps its fingerprint and bundle so freshness does not loop on rebundle;
// Tombstoned never transitions out and is dropped on save

import type { BundleLocation } from "./bundle_location.ts";

export type TypeName = string;

/** diagnostic only: the registry does not branch on it */
export type TombstoneReason =
  | "source-deleted"
  | "extension-removed"
  | "renamed";

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

export function isVisibleToResolver(state: RowState): boolean {
  return state.tag === "Indexed";
}
