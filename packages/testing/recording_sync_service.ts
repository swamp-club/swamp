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

import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
} from "./datastore_types.ts";

/** One call recorded by {@link createRecordingSyncService}, in call order. */
export type RecordedSyncEvent =
  | { kind: "mark"; relPath: string | undefined }
  | { kind: "pull"; options: DatastoreSyncOptions | undefined }
  | { kind: "push"; options: DatastoreSyncOptions | undefined };

/** Result of {@link createRecordingSyncService}. */
export interface RecordingSyncService {
  /** A sync service that records calls and does nothing else. */
  service: DatastoreSyncService;
  /** The `relPath` of each `markDirty` call; `undefined` for a bare call. */
  marks: Array<string | undefined>;
  /** Every call, in order. */
  events: RecordedSyncEvent[];
}

/**
 * Creates a sync service that records `markDirty`, `pullChanged` and
 * `pushChanged` calls and does nothing else. Pull and push resolve to 0.
 *
 * ```typescript
 * import { createRecordingSyncService } from "@swamp-club/swamp-testing";
 *
 * const { service, marks } = createRecordingSyncService();
 * await service.markDirty({ relPath: "data/a" });
 * await service.markDirty();
 * // marks: ["data/a", undefined]
 * ```
 */
export function createRecordingSyncService(): RecordingSyncService {
  const marks: Array<string | undefined> = [];
  const events: RecordedSyncEvent[] = [];
  const service: DatastoreSyncService = {
    pullChanged(options?: DatastoreSyncOptions): Promise<number> {
      events.push({ kind: "pull", options });
      return Promise.resolve(0);
    },
    pushChanged(options?: DatastoreSyncOptions): Promise<number> {
      events.push({ kind: "push", options });
      return Promise.resolve(0);
    },
    markDirty(options?: DatastoreSyncOptions): Promise<void> {
      marks.push(options?.relPath);
      events.push({ kind: "mark", relPath: options?.relPath });
      return Promise.resolve();
    },
  };
  return { service, marks, events };
}
