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

export const LIMITS_FILE = "scripts/binary_size_limits.json";

const BYTES_PER_MB = 1_000_000;

export interface BinaryToCheck {
  target: string;
  path: string;
}

export function parseLimits(text: string): Record<string, number> {
  const parsed: unknown = JSON.parse(text);
  const limits = (parsed as { maxMegabytes?: unknown } | null)?.maxMegabytes;
  if (typeof limits !== "object" || limits === null) {
    throw new Error(`${LIMITS_FILE} has no maxMegabytes object`);
  }
  const entries = Object.entries(limits);
  for (const [target, limit] of entries) {
    if (typeof limit !== "number" || !(limit > 0)) {
      throw new Error(`${LIMITS_FILE} has an invalid limit for ${target}`);
    }
  }
  return Object.fromEntries(entries) as Record<string, number>;
}

/** Each argument is `<target>=<path>`, or a bare path built for the host. */
export function parseBinaryArgs(
  args: readonly string[],
  hostTarget: string,
): BinaryToCheck[] {
  return args.map((arg) => {
    const separator = arg.indexOf("=");
    return separator < 0
      ? { target: hostTarget, path: arg }
      : { target: arg.slice(0, separator), path: arg.slice(separator + 1) };
  });
}

function megabytes(bytes: number): string {
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

/** Returns the failure message, or undefined when the size is within the limit. */
export function checkBinarySize(
  target: string,
  sizeBytes: number,
  limits: Record<string, number>,
): string | undefined {
  const limit = limits[target];
  if (limit === undefined) {
    return `${target}: no size limit in ${LIMITS_FILE}. Add one for this target.`;
  }
  const limitBytes = limit * BYTES_PER_MB;
  if (sizeBytes <= limitBytes) return undefined;
  return `${target}: the binary is ${megabytes(sizeBytes)}, over its ${limit} MB limit by ${
    megabytes(sizeBytes - limitBytes)
  }. Check what grew, usually a new npm dependency or a Deno upgrade. If the increase is intended, raise this target's limit in ${LIMITS_FILE} in the same change.`;
}

async function main(): Promise<number> {
  if (Deno.args.length === 0) {
    console.error(
      "::error::usage: check_binary_size.ts <path> | <target>=<path> ...",
    );
    return 2;
  }

  let limits: Record<string, number>;
  try {
    limits = parseLimits(
      await Deno.readTextFile(
        new URL("binary_size_limits.json", import.meta.url),
      ),
    );
  } catch (err) {
    console.error(`::error::could not read ${LIMITS_FILE}: ${err}`);
    return 1;
  }

  // every binary is reported before failing: a Deno upgrade trips all targets
  let failed = false;
  for (
    const { target, path } of parseBinaryArgs(Deno.args, Deno.build.target)
  ) {
    let size: number;
    try {
      size = (await Deno.stat(path)).size;
    } catch (err) {
      console.error(`::error::${target}: could not read ${path}: ${err}`);
      failed = true;
      continue;
    }
    const failure = checkBinarySize(target, size, limits);
    if (failure) {
      console.error(`::error::${failure}`);
      failed = true;
    } else {
      console.log(
        `${target}: ${megabytes(size)} is within its ${limits[target]} MB limit`,
      );
    }
  }
  return failed ? 1 : 0;
}

if (import.meta.main) {
  Deno.exit(await main());
}
