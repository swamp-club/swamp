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

export interface LegacyMigration {
  readonly migrated: number;
  readonly kept: readonly string[];
}

/**
 * a task read back always carries the folder it was read from as its workspace
 * path
 */
export interface StartSessionRepository {
  /** a record that cannot be read is left out, never rewritten */
  list(workspacePath: string): Promise<StartSession[]>;
  load(workspacePath: string, id: string): Promise<StartSession | null>;
  save(session: StartSession): Promise<void>;
  reserveBriefFile(
    workspacePath: string,
    createdAt: string,
    title: string,
  ): Promise<string>;
  /** idempotent; nothing that cannot be read is deleted */
  migrateLegacy(workspacePath: string): Promise<LegacyMigration>;
}
