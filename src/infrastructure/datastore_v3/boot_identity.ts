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

export const BOOT_IDENTITY_RETRY_MS = 60_000;

/**
 * a named boot is kept for the process, which never outlives it; a failed read
 * is retried at most once per retryMs, since a spawn can fail only for a while
 * (EMFILE, a slow disk) and a cached failure makes a whole command sync
 */
export function bootIdentityReader(
  read: () => Promise<string | undefined>,
  options: {
    readonly retries: boolean;
    readonly retryMs?: number;
    readonly now?: () => number;
  },
): () => Promise<string | undefined> {
  const retryMs = options.retryMs ?? BOOT_IDENTITY_RETRY_MS;
  const now = options.now ?? Date.now;
  let current: Promise<string | undefined> | undefined;
  let failedAt: number | undefined;
  return () => {
    if (current !== undefined) return current;
    if (
      failedAt !== undefined && (!options.retries || now() - failedAt < retryMs)
    ) {
      return Promise.resolve(undefined);
    }
    const attempt = read().catch(() => undefined).then((identity) => {
      if (identity === undefined) {
        failedAt = now();
        current = undefined;
        if (options.retries) {
          logger
            .debug`The boot cannot be named, so the read model syncs the files it writes`;
        }
      }
      return identity;
    });
    current = attempt;
    return attempt;
  };
}

export const currentBootIdentity: () => Promise<string | undefined> =
  bootIdentityReader(() => readBootIdentity(Deno.build.os), {
    retries: Deno.build.os === "linux" || Deno.build.os === "darwin",
  });

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
