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

/**
 * Whether this process is PID 1 on Linux, where the kernel re-parents every
 * orphaned process to it. Deno only waits on children it spawned through
 * `Deno.Command`, so a swamp running as PID 1 (a container without an init)
 * never reaps the processes steps leave behind. `pid` is read inside the
 * process's own PID namespace, so it is 1 for a container's entrypoint.
 */
export function isUnreapedInit(options: {
  os: typeof Deno.build.os;
  pid: number;
}): boolean {
  return options.os === "linux" && options.pid === 1;
}

/**
 * Warns when this process is an init that will not reap orphans. Called by
 * the long-running processes that adopt them: `swamp serve` and
 * `swamp worker connect`.
 */
export function warnIfRunningAsInit(): void {
  if (!isUnreapedInit({ os: Deno.build.os, pid: Deno.pid })) return;
  logger.warn(
    "swamp is running as PID 1 without an init, so processes that steps " +
      "leave behind are never reaped and stay zombies until the container " +
      "exits. Run the container with --init, use the official swamp image " +
      "(which runs swamp under tini), or start swamp with tini -s -- swamp.",
  );
}
