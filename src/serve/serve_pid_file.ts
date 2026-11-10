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

/**
 * Removes the reload PID file only while it still names this process, so a
 * serve that started after this one keeps its own file.
 */
export async function removePidFileIfOurs(
  pidPath: string,
  pid: number,
): Promise<boolean> {
  let content: string;
  try {
    content = await Deno.readTextFile(pidPath);
  } catch {
    return false;
  }
  if (content.trim() !== String(pid)) return false;
  try {
    await Deno.remove(pidPath);
    return true;
  } catch {
    return false;
  }
}
