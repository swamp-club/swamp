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

export interface TrackedOwnerRow {
  readonly pid: number;
  readonly ownerStartTime: string | null;
  readonly instanceId: string | undefined;
}

export interface OwnerProbe {
  readonly present: boolean;
  readonly zombie: boolean;
  readonly startTime?: string;
}

export interface JudgingProcess {
  readonly pid: number;
  readonly startTime?: string;
  readonly instanceId?: string;
  readonly probe: (pid: number) => OwnerProbe;
}

/**
 * a pid is judged only by a caller that already placed the row on this
 * process host; an unreadable start time proves nothing, so presence decides
 */
export function trackedOwnerGone(
  row: TrackedOwnerRow,
  self: JudgingProcess,
): boolean {
  if (row.pid === self.pid) {
    if (row.ownerStartTime !== null && self.startTime !== undefined) {
      return row.ownerStartTime !== self.startTime;
    }
    // without a start time, only a serve row under another instance id shows
    // a predecessor that held this pid
    return row.ownerStartTime === null && row.instanceId !== undefined &&
      self.instanceId !== undefined && row.instanceId !== self.instanceId;
  }
  const probe = self.probe(row.pid);
  if (!probe.present || probe.zombie) return true;
  return row.ownerStartTime !== null && probe.startTime !== undefined &&
    row.ownerStartTime !== probe.startTime;
}
