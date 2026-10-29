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
 * Published data versions whose stored content cannot be read
 * (swamp-club#3955).
 *
 * A version is published once a read can reach it: it has a catalog row
 * that is not pending, or the data name's latest marker names it. A
 * published version is unreadable when its files no longer hold what was
 * written, as an unclean shutdown of an unsynced v2 write leaves them: an
 * empty `metadata.yaml` and `raw`, while the marker and the catalog row
 * already name the version. Reads then serve it as empty content or as not
 * found. A version still being written is not published, so it is never
 * unreadable.
 *
 * @module
 */

/** Why a published data version, or a data name's marker, cannot be read. */
export type UnreadableVersionReason =
  /** The catalog has a row for the version, but its directory is gone. */
  | "version_missing"
  /** The version directory has no `metadata.yaml`. */
  | "metadata_missing"
  /** `metadata.yaml` is empty. */
  | "metadata_empty"
  /** `metadata.yaml` does not parse as a data version's metadata. */
  | "metadata_unparseable"
  /** The version directory has no `raw`. */
  | "content_missing"
  /** `raw` is shorter than the size `metadata.yaml` records. */
  | "content_short"
  /** The data name's `latest` marker is empty or names no version. */
  | "marker_unreadable";

/** What a data name's `latest` marker holds. */
export type LatestMarkerState =
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "version"; version: number };

/** A published data version, or a data name's marker, that cannot be read. */
export interface UnreadableDataVersion {
  /** The model type, normalized. */
  modelType: string;
  modelId: string;
  /** The model's name, or "" when no readable version or row records it. */
  modelName: string;
  dataName: string;
  /** The version, or null for a `marker_unreadable` finding. */
  version: number | null;
  reason: UnreadableVersionReason;
  /**
   * Whether reads of the data name's latest version reach this one (the
   * marker names it, or its catalog row is latest), so the record reads as
   * empty or not found. Always true for an unreadable marker.
   */
  latest: boolean;
  /**
   * The highest promoted version of the data name that can be read, which
   * a repair leaves as latest; null when none can, and the repair removes
   * the record.
   */
  readableVersion: number | null;
}

/** A short phrase for why a version cannot be read. */
export function describeUnreadableVersionReason(
  reason: UnreadableVersionReason,
): string {
  switch (reason) {
    case "version_missing":
      return "its catalog row names a version directory that is gone";
    case "metadata_missing":
      return "its metadata.yaml is missing";
    case "metadata_empty":
      return "its metadata.yaml is empty";
    case "metadata_unparseable":
      return "its metadata.yaml does not parse";
    case "content_missing":
      return "its raw content file is missing";
    case "content_short":
      return "its raw content file is shorter than its metadata records";
    case "marker_unreadable":
      return "its latest marker is empty or names no version";
  }
}
