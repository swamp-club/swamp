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

import { getSwampLogger } from "../logging/logger.ts";
import { withSpan } from "../tracing/tracer.ts";

const logger = getSwampLogger(["datastore", "v3", "prewarm"]);

/** a quarter of what the host has free, so the warmed pages evict nothing hot */
export const PREWARM_MEMORY_FRACTION = 0.25;

/** recovery itself must not wait on this longer than a sequential pass needs */
export const PREWARM_DEADLINE_MS = 10_000;

const CHUNK_BYTES = 1024 * 1024;

export interface RecoveryPrewarmOptions {
  /** read in this order until the budget is spent */
  readonly paths: readonly string[];
  readonly signal?: AbortSignal;
  readonly availableMemory?: () => number | undefined;
  readonly now?: () => number;
  readonly deadlineMs?: number;
  readonly chunkBytes?: number;
}

export interface RecoveryPrewarmReport {
  readonly bytesRead: number;
  readonly files: number;
  readonly budget: number;
  /** stopped by the budget before every file was read whole */
  readonly capped: boolean;
  readonly timedOut: boolean;
}

/**
 * reads the files a recovery is about to walk at random, sequentially, so its
 * page reads find them cached; best effort, it never throws
 */
export function prewarmForRecovery(
  options: RecoveryPrewarmOptions,
): Promise<RecoveryPrewarmReport> {
  return withSpan("swamp.datastore.v3.recover.prewarm", {}, async (span) => {
    const report = await prewarm(options);
    span.setAttributes({
      "swamp.datastore.v3.recover.prewarm.bytes_read": report.bytesRead,
      "swamp.datastore.v3.recover.prewarm.files": report.files,
      "swamp.datastore.v3.recover.prewarm.budget": report.budget,
      "swamp.datastore.v3.recover.prewarm.capped": report.capped,
      "swamp.datastore.v3.recover.prewarm.timed_out": report.timedOut,
    });
    return report;
  });
}

async function prewarm(
  options: RecoveryPrewarmOptions,
): Promise<RecoveryPrewarmReport> {
  const now = options.now ?? (() => performance.now());
  const until = now() + (options.deadlineMs ?? PREWARM_DEADLINE_MS);
  const available = (options.availableMemory ?? systemAvailableMemory)();
  const budget = available === undefined
    ? 0
    : Math.floor(available * PREWARM_MEMORY_FRACTION);
  const buffer = new Uint8Array(options.chunkBytes ?? CHUNK_BYTES);
  let bytesRead = 0;
  let files = 0;
  let capped = false;
  let timedOut = false;
  for (const path of options.paths) {
    if (budget === 0) break;
    if (bytesRead >= budget) {
      capped = true;
      break;
    }
    let file: Deno.FsFile;
    try {
      file = await Deno.open(path, { read: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        logger.debug`Skipped prewarming ${path}: ${error}`;
      }
      continue;
    }
    try {
      // a file that grows while it is read is read only as far as it was
      const size = (await file.stat()).size;
      let left = size;
      files++;
      while (left > 0) {
        if (options.signal?.aborted === true) return done();
        if (now() >= until) {
          timedOut = true;
          return done();
        }
        const room = budget - bytesRead;
        if (room <= 0) {
          capped = true;
          return done();
        }
        const want = Math.min(buffer.length, left, room);
        const got = await file.read(buffer.subarray(0, want));
        if (got === null) break;
        bytesRead += got;
        left -= got;
      }
    } catch (error) {
      logger.debug`Stopped prewarming ${path}: ${error}`;
    } finally {
      file.close();
    }
  }
  return done();

  function done(): RecoveryPrewarmReport {
    return { bytesRead, files, budget, capped, timedOut };
  }
}

function systemAvailableMemory(): number | undefined {
  try {
    return Deno.systemMemoryInfo().available;
  } catch {
    return undefined;
  }
}
