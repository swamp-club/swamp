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
 * what was written. The read model writes its files unsynced only where it
 * can name the boot exactly, and checks them on its first open in a later
 * boot.
 *
 * The identity must not depend on the wall clock: a clock step within one
 * boot would look like a reboot, and the check would read the files back
 * from the page cache, pass, and stop watching them. So it is the kernel's
 * own per-boot id: `/proc/sys/kernel/random/boot_id` on Linux, the
 * `kern.bootsessionuuid` sysctl on macOS. Elsewhere, or when it cannot be
 * read, there is no identity and the read model syncs its files instead.
 *
 * @module
 */

const BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";
const SYSCTL = "/usr/sbin/sysctl";
const SYSCTL_TIMEOUT_MS = 5_000;

let cached: Promise<string | undefined> | undefined;

/**
 * The current boot, `boot-id:<id>` on Linux or `boot-session:<uuid>` on
 * macOS; undefined where the boot cannot be named exactly. Read once per
 * process: a process never outlives its boot.
 */
export function currentBootIdentity(): Promise<string | undefined> {
  cached ??= readBootIdentity(Deno.build.os);
  return cached;
}

/**
 * Reads the boot identity on `os`, uncached; undefined when it cannot be
 * read. `bootIdFile` is the Linux boot id's path.
 */
export async function readBootIdentity(
  os: typeof Deno.build.os,
  bootIdFile: string = BOOT_ID_FILE,
): Promise<string | undefined> {
  try {
    if (os === "linux") {
      const id = (await Deno.readTextFile(bootIdFile)).trim();
      return id === "" ? undefined : `boot-id:${id}`;
    }
    if (os === "darwin") {
      const output = await new Deno.Command(SYSCTL, {
        args: ["-n", "kern.bootsessionuuid"],
        stdin: "null",
        stdout: "piped",
        stderr: "null",
        signal: AbortSignal.timeout(SYSCTL_TIMEOUT_MS),
      }).output();
      const id = new TextDecoder().decode(output.stdout).trim();
      return output.success && id !== "" ? `boot-session:${id}` : undefined;
    }
  } catch {
    // No identity: the caller syncs instead.
  }
  return undefined;
}
