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

import type { StartSession } from "./start_session.ts";

/** What converting a workspace's pre-task-list files did. */
export interface LegacyMigration {
  /** Tasks written as records from the old current and filed sessions. */
  readonly migrated: number;
  /** Old files that couldn't be read, kept where they are. */
  readonly kept: readonly string[];
}

/**
 * Stores a workspace's tasks: one record each, plus the brief file each task
 * names. A task read back always carries the folder it was read from as its
 * workspace path.
 */
export interface StartSessionRepository {
  /**
   * Every readable task of the workspace, in no particular order. A record
   * that can't be read is left out, never rewritten.
   */
  list(workspacePath: string): Promise<StartSession[]>;
  /** One task, or null when there is none with that id (or it's unreadable). */
  load(workspacePath: string, id: string): Promise<StartSession | null>;
  save(session: StartSession): Promise<void>;
  /**
   * A brief path no other task of the workspace uses and no file under
   * `tasks/` already has: `tasks/<date>-<slug>.md`, with `-2`, `-3`… added
   * when taken.
   */
  reserveBriefFile(
    workspacePath: string,
    createdAt: string,
    title: string,
  ): Promise<string>;
  /**
   * Converts the files `swamp start` wrote before every task had its own
   * record and brief (`.swamp/start/state.json`, `history/`, `TASK.md`).
   * Idempotent; nothing that can't be read is deleted.
   */
  migrateLegacy(workspacePath: string): Promise<LegacyMigration>;
}
