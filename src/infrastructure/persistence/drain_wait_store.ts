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

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import {
  DRAIN_WAIT_TTL_MS,
  type DrainWait,
  isDrainWaitExpired,
  parseDrainWait,
  serializeDrainWait,
} from "../../domain/datastore/drain_wait.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";

/**
 * The directory, under the datastore root or its namespace, that holds one
 * marker per waiting drain. It sits outside `data/`, so the per-model lock
 * scan never sees it.
 */
export const DRAIN_WAITS_DIR = "drain-waits";

/** The most directory entries one {@link DrainWaitStore.list} looks at. */
export const MAX_DRAIN_WAIT_ENTRIES = 256;

/** The largest marker file {@link DrainWaitStore.list} reads, in bytes. */
const MAX_DRAIN_WAIT_BYTES = 256 * 1024;

/**
 * The drain-wait markers of a filesystem datastore: one small JSON file per
 * structural command currently waiting on per-model locks
 * (design/enablers/datastores.md, "Parent-Process Lock Awareness").
 */
export class DrainWaitStore {
  readonly #dir: string;

  constructor(datastorePath: string, namespace?: string) {
    this.#dir = namespace
      ? join(datastorePath, namespace, DRAIN_WAITS_DIR)
      : join(datastorePath, DRAIN_WAITS_DIR);
  }

  /** Writes or replaces the marker for `wait`. */
  async publish(wait: DrainWait): Promise<void> {
    await ensureDir(this.#dir);
    await atomicWriteTextFile(
      join(this.#dir, `${wait.id}.json`),
      serializeDrainWait(wait),
    );
  }

  /**
   * The unexpired waits other drains have published, at most
   * {@link MAX_DRAIN_WAIT_ENTRIES} directory entries deep. A file that
   * cannot be read or validated is skipped. Anything that is not a live
   * marker and has not been written for a full ttl is deleted, which clears
   * what a killed drain left behind.
   */
  async list(nowMs: number): Promise<DrainWait[]> {
    const waits: DrainWait[] = [];
    let seen = 0;
    try {
      for await (const entry of Deno.readDir(this.#dir)) {
        if (++seen > MAX_DRAIN_WAIT_ENTRIES) {
          break;
        }
        if (!entry.isFile) {
          continue;
        }
        const path = join(this.#dir, entry.name);
        const wait = await readMarker(path, entry.name);
        if (wait !== null && !isDrainWaitExpired(wait, nowMs)) {
          waits.push(wait);
        } else {
          await removeIfOld(path, nowMs);
        }
      }
    } catch {
      // No directory yet, or it cannot be read: no waits to report.
    }
    return waits;
  }

  /** Deletes the marker for the wait named `id`, if it is still there. */
  async remove(id: string): Promise<void> {
    try {
      await Deno.remove(join(this.#dir, `${id}.json`));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }
}

async function readMarker(
  path: string,
  fileName: string,
): Promise<DrainWait | null> {
  try {
    const stat = await Deno.stat(path);
    if (stat.size > MAX_DRAIN_WAIT_BYTES) {
      return null;
    }
    const wait = parseDrainWait(JSON.parse(await Deno.readTextFile(path)));
    // A marker speaks only for the wait its file is named after.
    return wait !== null && fileName === `${wait.id}.json` ? wait : null;
  } catch {
    return null;
  }
}

async function removeIfOld(path: string, nowMs: number): Promise<void> {
  try {
    const mtime = (await Deno.stat(path)).mtime?.getTime();
    if (mtime !== undefined && nowMs - mtime > DRAIN_WAIT_TTL_MS) {
      await Deno.remove(path);
    }
  } catch {
    // Already gone, or held open by its writer (Windows): leave it.
  }
}
