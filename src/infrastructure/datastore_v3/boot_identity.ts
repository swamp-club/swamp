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
 * Which boot of the operating system this process runs in (swamp-club#3337).
 * A file written and not synced can be lost only to an OS crash or a power
 * loss, and either one ends the boot: within one boot, the page cache holds
 * what was written. The read model writes its files unsynced and checks
 * them on its first open in a later boot.
 *
 * On Linux the kernel's boot id names the boot exactly. Elsewhere the boot
 * is named by its start time, now less the uptime, which the clock and the
 * uptime's whole seconds blur by a few seconds: two boot times within
 * {@link BOOT_TIME_TOLERANCE_MS} are one boot, since no machine restarts
 * that fast. An identity that cannot be compared is a different boot, so a
 * doubt costs a check and never skips one.
 *
 * @module
 */

/** How far apart two readings of one boot's start time can be. */
export const BOOT_TIME_TOLERANCE_MS = 5_000;

const BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";

/** The current boot: `boot-id:<uuid>` on Linux, else `boot-time:<ms>`. */
export function currentBootIdentity(): string {
  if (Deno.build.os === "linux") {
    try {
      const id = Deno.readTextFileSync(BOOT_ID_FILE).trim();
      if (id !== "") return `boot-id:${id}`;
    } catch {
      // No procfs: fall back to the boot time.
    }
  }
  return `boot-time:${Math.round(Date.now() - Deno.osUptime() * 1000)}`;
}

/** True when `a` and `b` name the same boot. */
export function sameBoot(a: string, b: string): boolean {
  if (a === b) return true;
  const time = (identity: string): number | undefined => {
    const match = /^boot-time:(-?\d+)$/.exec(identity);
    return match === null ? undefined : Number(match[1]);
  };
  const ta = time(a);
  const tb = time(b);
  return ta !== undefined && tb !== undefined &&
    Math.abs(ta - tb) <= BOOT_TIME_TOLERANCE_MS;
}
