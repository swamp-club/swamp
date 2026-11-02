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

import { getLogger } from "@logtape/logtape";

const logger = getLogger(["process", "init"]);

export interface ProcessIdentity {
  os: typeof Deno.build.os;
  pid: number;
}

/**
 * Deno only waits on children it spawned, so a swamp running as PID 1 never
 * reaps orphans the kernel re-parents to it; pid is read in the process's own
 * PID namespace
 */
export function isPidOneOnLinux(identity: ProcessIdentity): boolean {
  return identity.os === "linux" && identity.pid === 1;
}

export function warnIfRunningAsInit(
  identity: ProcessIdentity = { os: Deno.build.os, pid: Deno.pid },
): void {
  if (!isPidOneOnLinux(identity)) return;
  logger.warn(
    "swamp is running as PID 1 without an init, so orphaned step processes " +
      "are never reaped. Use docker run --init, the official swamp image, or " +
      "tini -s -- swamp.",
  );
}
