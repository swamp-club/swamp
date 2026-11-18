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

export type DaemonRestartOutcome =
  | "restarted"
  | "not_running"
  | "not_installed";

export interface DaemonRestartTarget {
  readonly name: string;
  scheduler(): Promise<{ restart(): Promise<DaemonRestartOutcome> }>;
}

export interface DaemonRestartResult {
  restarted: string[];
  error?: string;
}

/** Never throws: one daemon's failure is recorded and the next is still tried. */
export async function restartDaemonsAfterUpdate(
  targets: readonly DaemonRestartTarget[],
): Promise<DaemonRestartResult> {
  const restarted: string[] = [];
  const errors: string[] = [];
  for (const target of targets) {
    try {
      const scheduler = await target.scheduler();
      if (await scheduler.restart() === "restarted") {
        restarted.push(target.name);
      }
    } catch (error) {
      errors.push(
        `${target.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return errors.length > 0
    ? { restarted, error: errors.join("; ") }
    : { restarted };
}
