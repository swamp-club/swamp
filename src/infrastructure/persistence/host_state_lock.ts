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

import { join } from "@std/path";
import { markErrorPaths, UserError } from "../../domain/errors.ts";

// no .lock suffix, so no workspace's .<name>.lock or removal folder can be this file
export const HOST_STATE_LOCK_FILE = ".host-lock";

export interface HostStateLock {
  release(): void;
}

/**
 * a kernel lock, released when the process dies however it dies, so a held
 * file is never judged stale; the file stays, since removing it races a start
 */
export async function acquireHostStateLock(
  stateDir: string,
): Promise<HostStateLock> {
  await Deno.mkdir(stateDir, { recursive: true });
  const path = join(stateDir, HOST_STATE_LOCK_FILE);
  const file = await Deno.open(path, {
    read: true,
    write: true,
    create: true,
  });
  let locked: boolean;
  try {
    locked = await file.tryLock(true);
  } catch (error) {
    file.close();
    throw error;
  }
  if (!locked) {
    file.close();
    throw markErrorPaths(
      new UserError(
        `Another swamp serve host is running on the state folder ${stateDir}. Stop it first; one host runs per state folder.`,
        "host_state_locked",
      ),
      [stateDir],
    );
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      // closing the handle drops the lock too
      file.close();
    },
  };
}
