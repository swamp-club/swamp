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

import type { DatastoreSyncService } from "./datastore_types.ts";

/** The return value from {@link createRecordingSyncService}. */
export interface RecordingSyncServiceResult {
  /** A sync service whose push and pull do nothing and resolve to `0`. */
  service: DatastoreSyncService;
  /**
   * Every `markDirty` relPath in call order. `undefined` records a bare
   * call, which the contract treats as a bulk mutation.
   */
  marks: Array<string | undefined>;
}

/**
 * Creates a sync service that only records `markDirty` calls.
 *
 * ```typescript
 * import { createRecordingSyncService } from "@swamp-club/swamp-testing";
 *
 * const { service, marks } = createRecordingSyncService();
 * await service.markDirty({ relPath: "data/x" });
 * await service.markDirty();
 * // marks is ["data/x", undefined]
 * ```
 */
export function createRecordingSyncService(): RecordingSyncServiceResult {
  const marks: Array<string | undefined> = [];
  return {
    marks,
    service: {
      pullChanged: () => Promise.resolve(0),
      pushChanged: () => Promise.resolve(0),
      markDirty: (options) => {
        marks.push(options?.relPath);
        return Promise.resolve();
      },
    },
  };
}
