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

import { CalVer } from "../models/calver.ts";

export interface UpToDateStatus {
  status: "up_to_date";
  name: string;
  installedVersion: string;
  latestVersion: string;
  channel?: string;
}

export interface UpdateAvailableStatus {
  status: "update_available";
  name: string;
  installedVersion: string;
  latestVersion: string;
  channel?: string;
}

export interface UpdatedStatus {
  status: "updated";
  name: string;
  previousVersion: string;
  newVersion: string;
  channel?: string;
}

/**
 * The new version is installed, but its types collide with another
 * extension's and the rollback could not restore the previous version
 * (the lockfile could not be written), so the update was kept.
 */
export interface KeptWithCollisionStatus {
  status: "kept_with_collision";
  name: string;
  previousVersion: string;
  newVersion: string;
  error: string;
  channel?: string;
}

export interface NotFoundStatus {
  status: "not_found";
  name: string;
  installedVersion: string;
  error: string;
  channel?: string;
}

export interface FailedStatus {
  status: "failed";
  name: string;
  installedVersion: string;
  error: string;
  channel?: string;
}

export interface DeprecatedStatus {
  status: "deprecated";
  name: string;
  installedVersion: string;
  deprecationReason: string | null;
  supersededBy: string | null;
  channel?: string;
}

export type ExtensionUpdateStatus =
  | UpToDateStatus
  | UpdateAvailableStatus
  | UpdatedStatus
  | NotFoundStatus
  | FailedStatus
  | KeptWithCollisionStatus
  | DeprecatedStatus;

export interface UpdateSummary {
  total: number;
  upToDate: number;
  updated: number;
  failed: number;
  keptWithCollision: number;
}

export interface ExtensionUpdateResult {
  extensions: ExtensionUpdateStatus[];
  summary: UpdateSummary;
}

export function checkExtensionVersion(
  name: string,
  installedVersion: string,
  latestVersion: string | null,
  deprecation?: {
    deprecatedAt: string | null;
    deprecationReason: string | null;
    supersededBy: string | null;
  },
  channel?: string,
): UpToDateStatus | UpdateAvailableStatus | NotFoundStatus | DeprecatedStatus {
  if (latestVersion === null) {
    return {
      status: "not_found",
      name,
      installedVersion,
      error: `Extension ${name} not found in the registry.`,
      channel,
    };
  }

  const installed = CalVer.create(installedVersion);
  const latest = CalVer.create(latestVersion);
  const cmp = CalVer.compare(installed, latest);

  // version comparison outranks deprecation so security patches are never
  // silently skipped; deprecation surfaces only when up to date, as the pull
  // warning covers deprecated plus update
  if (cmp < 0) {
    return {
      status: "update_available",
      name,
      installedVersion,
      latestVersion,
      channel,
    };
  }

  if (deprecation?.deprecatedAt != null) {
    return {
      status: "deprecated",
      name,
      installedVersion,
      deprecationReason: deprecation.deprecationReason,
      supersededBy: deprecation.supersededBy,
      channel,
    };
  }

  return {
    status: "up_to_date",
    name,
    installedVersion,
    latestVersion,
    channel,
  };
}

export function buildUpdateResult(
  statuses: ExtensionUpdateStatus[],
): ExtensionUpdateResult {
  let upToDate = 0;
  let updated = 0;
  let failed = 0;
  let keptWithCollision = 0;

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
      case "kept_with_collision":
        keptWithCollision++;
        break;
      case "deprecated":
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
      keptWithCollision,
    },
  };
}
