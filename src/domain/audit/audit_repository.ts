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

import type { BashCommandEntry } from "./audit_command_entry.ts";

/**
 * Repository interface for persisting and retrieving bash command audit entries.
 */
export interface AuditRepository {
  /**
   * Appends a bash command entry to the audit log.
   * Should never throw - errors are logged silently.
   */
  append(entry: BashCommandEntry): Promise<void>;

  /**
   * Finds all bash command entries within a time range.
   */
  findByTimeRange(
    startTime: Date,
    endTime: Date,
  ): Promise<BashCommandEntry[]>;

  /**
   * Deletes audit files older than the given date.
   * Returns the number of files deleted.
   */
  deleteOlderThan(date: Date): Promise<number>;
}
