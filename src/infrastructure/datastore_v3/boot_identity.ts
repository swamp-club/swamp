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
 * unsynced files are lost only to an OS crash or power loss, which end the
 * boot, so the read model writes unsynced only where it can name the boot
 * exactly and checks them on first open in a later boot
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
 * read once per process, since a process never outlives its boot; a boot that
 * cannot be named is not looked for again
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
 * a read the permissions refuse goes through cat, and its output counts only if
 * it is a UUID
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
