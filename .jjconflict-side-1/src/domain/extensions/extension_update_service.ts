// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { CalVer } from "../models/calver.ts";

/** Extension is already at or ahead of the latest registry version. */
export interface UpToDateStatus {
  status: "up_to_date";
  name: string;
  installedVersion: string;
  latestVersion: string;
}

/** A newer version is available in the registry. */
export interface UpdateAvailableStatus {
  status: "update_available";
  name: string;
  installedVersion: string;
  latestVersion: string;
}

/** Extension was successfully updated. */
export interface UpdatedStatus {
  status: "updated";
  name: string;
  previousVersion: string;
  newVersion: string;
}

/** Extension was not found in the registry. */
export interface NotFoundStatus {
  status: "not_found";
  name: string;
  installedVersion: string;
  error: string;
}

/** Extension install failed during update (network, safety, integrity, etc.). */
export interface FailedStatus {
  status: "failed";
  name: string;
  installedVersion: string;
  error: string;
}

/** Discriminated union of all possible update statuses. */
export type ExtensionUpdateStatus =
  | UpToDateStatus
  | UpdateAvailableStatus
  | UpdatedStatus
  | NotFoundStatus
  | FailedStatus;

/** Summary counts for the update operation. */
export interface UpdateSummary {
  total: number;
  upToDate: number;
  updated: number;
  failed: number;
}

/** Aggregated result of checking/updating extensions. */
export interface ExtensionUpdateResult {
  extensions: ExtensionUpdateStatus[];
  summary: UpdateSummary;
}

/**
 * Compares the installed version against the latest registry version
 * and returns the appropriate status.
 *
 * Returns `up_to_date` if installed >= latest, `update_available` if
 * installed < latest, or `not_found` if latestVersion is null (extension
 * missing from registry).
 */
export function checkExtensionVersion(
  name: string,
  installedVersion: string,
  latestVersion: string | null,
): UpToDateStatus | UpdateAvailableStatus | NotFoundStatus {
  if (latestVersion === null) {
    return {
      status: "not_found",
      name,
      installedVersion,
      error: `Extension ${name} not found in the registry.`,
    };
  }

  const installed = CalVer.create(installedVersion);
  const latest = CalVer.create(latestVersion);
  const cmp = CalVer.compare(installed, latest);

  if (cmp >= 0) {
    return {
      status: "up_to_date",
      name,
      installedVersion,
      latestVersion,
    };
  }

  return {
    status: "update_available",
    name,
    installedVersion,
    latestVersion,
  };
}

/**
 * Aggregates an array of statuses into a result with summary counts.
 */
export function buildUpdateResult(
  statuses: ExtensionUpdateStatus[],
): ExtensionUpdateResult {
  let upToDate = 0;
  let updated = 0;
  let failed = 0;

  for (const s of statuses) {
    switch (s.status) {
      case "up_to_date":
        upToDate++;
        break;
      case "updated":
        updated++;
        break;
      case "update_available":
        // Not yet acted on — counts toward neither updated nor failed
        break;
      case "not_found":
      case "failed":
        failed++;
        break;
    }
  }

  return {
    extensions: statuses,
    summary: {
      total: statuses.length,
      upToDate,
      updated,
      failed,
    },
  };
}
