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

import type { CompletedLine } from "./quest_event.ts";

export interface Season {
  readonly slug: string;
  readonly name: string;
  readonly theme: string;
  readonly description: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly active: boolean;
}

export interface QuestProgress {
  readonly season: Season;
  readonly completed_count: number;
  readonly total_count: number;
  readonly lines_completed: number;
  readonly quest_completed: boolean;
  readonly completed_at: string | null;
}

export interface ObjectiveCell {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly position: readonly [number, number];
  readonly is_free_space: boolean;
  readonly completed: boolean;
  readonly current: number;
  readonly target: number;
  readonly completed_at: string | null;
}

export interface QuestBoard {
  readonly season: Season;
  readonly grid_size: { readonly rows: number; readonly cols: number };
  readonly objectives: ObjectiveCell[];
  readonly lines_completed: CompletedLine[];
  readonly quest_completed: boolean;
}

export interface QuestHistoryEntry {
  readonly season: Season;
  readonly completed_count: number;
  readonly total_count: number;
  readonly lines_completed: number;
  readonly quest_completed: boolean;
  readonly completed_at: string | null;
}
