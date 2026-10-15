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
 * The released binary is compiled with granular `--allow-*` flags, and Deno
 * refuses any read under `/proc` without `--allow-all`, however narrow the
 * read grant. There the boot id is read by running `cat`, which
 * `--allow-run` permits, as the macOS id is read by running `sysctl`
 * (swamp-club#3418). Until then a Linux binary named no boot and synced
 * every file it caught up.
 *
 * The premise holds for local, fixed storage. A removable drive pulled
 * mid-write, a network filesystem whose server loses its cache, or a VM
 * restored from a snapshot can lose unsynced writes without ending the
 * boot: keep a checkout's cache on local disk.
 *
 * @module
 */

import { getSwampLogger } from "../logging/logger.ts";

const BOOT_ID_FILE = "/proc/sys/kernel/random/boot_id";
const SYSCTL = "/usr/sbin/sysctl";
const SYSCTL_TIMEOUT_MS = 5_000;
/** Where `cat` is run from when `/proc` is refused, in order; never `PATH`. */
const CAT_PATHS = ["/bin/cat", "/usr/bin/cat"];
const CAT_TIMEOUT_MS = 2_000;
const BOOT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const logger = getSwampLogger(["datastore", "v3", "boot-identity"]);

let read: Promise<string | undefined> | undefined;

/**
 * The current boot, `boot-id:<id>` on Linux or `boot-session:<uuid>` on
 * macOS; undefined where the boot cannot be named exactly. It is read once
 * per process, since a process never outlives its boot, and a boot that
 * cannot be named is not looked for again.
 */
export function currentBootIdentity(): Promise<string | undefined> {
  // A failed read is cached on purpose: retrying would run `cat` or
  // `sysctl` again at every exclusive section of a long-running serve.
  read ??= readBootIdentity(Deno.build.os).then((identity) => {
    if (identity === undefined && Deno.build.os !== "windows") {
      logger
        .debug`The boot cannot be named, so the read model syncs the files it writes`;
    }
    return identity;
  });
  return read;
}

/**
 * Reads the boot identity on `os`, uncached; undefined when it cannot be
 * read. `bootIdFile` is the Linux boot id's path. A read of it the
 * permissions refuse goes through `cat`; its output counts only as a UUID.
 */
export async function readBootIdentity(
  os: typeof Deno.build.os,
  bootIdFile: string = BOOT_ID_FILE,
): Promise<string | undefined> {
  try {
    if (os === "linux") {
      let id: string | undefined;
      try {
        id = (await Deno.readTextFile(bootIdFile)).trim();
      } catch (error) {
        if (!(error instanceof Deno.errors.NotCapable)) throw error;
        id = await catBootId(bootIdFile);
      }
      return id === undefined || id === "" ? undefined : `boot-id:${id}`;
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

/**
 * The boot id file as `cat` prints it, when it is a UUID; undefined when no
 * `cat` runs it, it fails or times out, or prints anything else. The next
 * path is tried only when one does not exist.
 */
async function catBootId(file: string): Promise<string | undefined> {
  for (const cat of CAT_PATHS) {
    let output: Deno.CommandOutput;
    try {
      output = await new Deno.Command(cat, {
        args: [file],
        stdin: "null",
        stdout: "piped",
        stderr: "null",
        signal: AbortSignal.timeout(CAT_TIMEOUT_MS),
      }).output();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      return undefined;
    }
    if (!output.success) return undefined;
    const id = new TextDecoder().decode(output.stdout).trim();
    return BOOT_ID_PATTERN.test(id) ? id : undefined;
  }
  return undefined;
}
