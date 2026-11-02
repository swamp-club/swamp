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
 * a published version (non-pending catalog row, or named by the latest marker)
 * is unreadable when its files lack what was written, as after an unclean v2
 * shutdown; one still being written is never unreadable
 */

export type UnreadableVersionReason =
  | "version_missing"
  | "metadata_missing"
  | "metadata_empty"
  | "metadata_unparseable"
  | "content_missing"
  | "content_short"
  | "marker_unreadable";

export type LatestMarkerState =
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "version"; version: number };

export interface UnreadableDataVersion {
  modelType: string;
  modelId: string;
  modelName: string;
  dataName: string;
  version: number | null;
  reason: UnreadableVersionReason;
  /**
   * true when reads of the latest version reach this one, so the record reads
   * as empty or not found; always true for an unreadable marker
   */
  latest: boolean;
  /**
   * never above the highest published version, so a save that crashed before
   * publishing is not chosen; null when none can be read
   */
  readableVersion: number | null;
}

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
