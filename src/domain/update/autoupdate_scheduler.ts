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

import type { UpdateCadence } from "./update_preferences.ts";

export interface ScheduleStatus {
  installed: boolean;
  cadence?: UpdateCadence;
  nextRun?: string;
}

export interface AutoupdateScheduler {
  install(binaryPath: string, cadence: UpdateCadence): Promise<void>;
  remove(): Promise<void>;
  status(): Promise<ScheduleStatus>;
}

// TODO(windows): Implement Windows Task Scheduler support when swamp update
// ships for Windows. Implement the AutoupdateScheduler interface using
// schtasks.exe or the Task Scheduler COM API.
