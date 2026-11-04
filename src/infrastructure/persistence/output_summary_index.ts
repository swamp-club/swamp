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

import { createHash } from "node:crypto";
import { ensureDir } from "@std/fs";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import { getLogger } from "@logtape/logtape";
import { currentDiagnosticTally } from "../../domain/diagnostics/diagnostic_phase.ts";
import { isSettledStatus } from "../../domain/models/model_output.ts";
import {
  type OutputSummary,
  outputSummaryFromData,
  outputSummaryToData,
} from "../../domain/models/output_summary.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { swampPath } from "./paths.ts";
import { assertSafePath } from "./safe_path.ts";
import { chunkEnd } from "./ndjson_chunks.ts";
import { inTimeSlices } from "./scan_permits.ts";

const logger = getLogger(["output-repo", "summaries"]);

/**
 * outside every materialised and synced subdirectory, so it is never committed,
 * pushed or swept by a v3 recovery
 */
export const OUTPUT_SUMMARIES_DIR = "_output_summaries";

const SCHEMA_VERSION = "v1";

const SHARD_SUFFIX = ".ndjson";

const CLEARED_MARKER = "cleared";

const CLEARED_ASIDE_PREFIX = ".cleared-";

/**
 * the fingerprint read back from a shard is untrusted: fingerprintMatches takes
 * anything and matches only a real one
 */
export interface OutputSummaryRow {
  readonly summary: OutputSummary;
  readonly record: unknown;
}

export function outputFileStamp(startedAt: Date): string {
  return startedAt.toISOString().replace(/[:.]/g, "-");
}

export function outputSummaryKey(
  method: string,
  definitionId: string,
  stamp: string,
): string {
  return JSON.stringify([method, definitionId, stamp]);
}

function keyOfSummary(summary: OutputSummary): string {
  return outputSummaryKey(
    summary.methodName,
    summary.definitionId,
    outputFileStamp(summary.startedAt),
  );
}

async function shardText(rows: readonly OutputSummaryRow[]): Promise<string> {
  let text = "";
  let next = 0;
  await inTimeSlices(
    () => next < rows.length,
    (until) => {
      do {
        const { summary, record } = rows[next++];
        const data = { ...outputSummaryToData(summary), record };
        text += `${JSON.stringify(data)}\n`;
      } while (next < rows.length && performance.now() < until);
    },
  );
  return text;
}

export function shardDayOf(stamp: string): string {
  return stamp.slice(0, 10);
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await Deno.lstat(path)).isSymlink;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

// Windows renames the handle it opened by name, so a refusal is either another
// clear deleting what it moved, or a file held open inside; asking again by
// name tells them apart.
async function movedAside(from: string, to: string): Promise<boolean> {
  try {
    await Deno.rename(from, to);
    return true;
  } catch (error) {
    if (!(error instanceof Deno.errors.PermissionDenied)) throw error;
  }
  try {
    await Deno.rename(from, to);
    return true;
  } catch (error) {
    if (!(error instanceof Deno.errors.PermissionDenied)) throw error;
    logger.debug`Leaving output summaries ${from} for the next clear: ${error}`;
    return false;
  }
}

const MARKER_ATTEMPTS = 5;

// Windows refuses a rename onto the marker while another clear replaces it or
// a reader has it open; both let go within moments, and the shards must not go
// until this clear's marker is in.
async function writeClearedMarker(path: string): Promise<void> {
  for (let attempt = 1;; attempt++) {
    try {
      return await atomicWriteTextFile(path, crypto.randomUUID());
    } catch (error) {
      if (
        !(error instanceof Deno.errors.PermissionDenied) ||
        attempt === MARKER_ATTEMPTS
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 5));
    }
  }
}

/**
 * entries are moved aside before removal so a read adding a file cannot fail
 * it; one a reader holds open on Windows is left, and like any leftover goes
 * with the next clear; never fails the caller
 */
export async function removeStaleOutputSummaries(
  repoDir: string,
): Promise<void> {
  const dir = swampPath(repoDir, OUTPUT_SUMMARIES_DIR);
  const aside: string[] = [];
  try {
    // A symlink here is not this index's to empty: only the link goes.
    if (await isSymlink(dir)) await Deno.remove(dir);
    await ensureDir(dir);
    // Before the shards go, so a read holding records from before this clear
    // cannot add them back to a directory that looks untouched.
    // Replaced rather than written through, should it be a symlink.
    await writeClearedMarker(join(dir, CLEARED_MARKER));
    for (const { name } of await Array.fromAsync(Deno.readDir(dir))) {
      // The temp file of another clear's marker is its to rename.
      if (name === CLEARED_MARKER || name.endsWith(".tmp")) continue;
      if (name.startsWith(CLEARED_ASIDE_PREFIX)) {
        aside.push(join(dir, name));
        continue;
      }
      const moved = join(dir, `${CLEARED_ASIDE_PREFIX}${crypto.randomUUID()}`);
      try {
        if (await movedAside(join(dir, name), moved)) aside.push(moved);
      } catch (error) {
        // Another clear got to it first, and removes it.
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
  } catch (error) {
    logger
      .warn`Clearing the output summaries of ${repoDir} failed. Reads still check each row against its record, but the rows stay on disk. Delete ${dir} to remove them: ${error}`;
  }
  for (const path of aside) {
    try {
      await Deno.remove(path, { recursive: true });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      logger.debug`Removing cleared output summaries ${path} failed: ${error}`;
    }
  }
}

/**
 * derived cache; the record files stay the only truth. A row is used only for a
 * listed file whose stat fingerprint still matches, and a missing or bad row
 * costs one record read, never a failure
 */
export class OutputSummaryIndex {
  readonly #root: string;
  readonly #marker: string;
  /** Where shards must really be: `.swamp`, so no link inside it can move them. */
  readonly #boundary: string;

  constructor(repoDir: string, baseDir: string) {
    const location = createHash("sha256").update(resolve(baseDir)).digest("hex")
      .slice(0, 16);
    this.#root = swampPath(
      repoDir,
      OUTPUT_SUMMARIES_DIR,
      SCHEMA_VERSION,
      location,
    );
    this.#marker = swampPath(repoDir, OUTPUT_SUMMARIES_DIR, CLEARED_MARKER);
    this.#boundary = swampPath(repoDir);
  }

  /**
   * callers compare it from before reading records with its value now; if it
   * moved, those records may be what the clear was for
   */
  async generation(): Promise<string | undefined> {
    try {
      return new TextDecoder().decode(await Deno.readFile(this.#marker));
    } catch {
      return undefined;
    }
  }

  #shardPath(type: string, day: string): string {
    return join(this.#root, type, `${day}${SHARD_SUFFIX}`);
  }

  async shardBytes(type: string, day: string): Promise<number> {
    try {
      return (await Deno.lstat(this.#shardPath(type, day))).size;
    } catch {
      return 0;
    }
  }

  /**
   * the last row per key wins; a shard at least half dead lines is rewritten
   * with only winners, so a read pays for this at most once per doubling of the
   * shard
   */
  async read(
    type: string,
    day: string,
    signal?: AbortSignal,
  ): Promise<Map<string, OutputSummaryRow>> {
    const path = this.#shardPath(type, day);
    const { rows, lines, bytes } = await this.#readShard(path, signal);
    if (lines > 0 && lines >= 2 * rows.size) {
      await this.#rewriteWithoutLosers(path, rows, bytes);
    }
    return rows;
  }

  async #rewriteWithoutLosers(
    path: string,
    rows: ReadonlyMap<string, OutputSummaryRow>,
    bytesRead: number,
  ): Promise<void> {
    try {
      await assertSafePath(path, this.#boundary);
      const text = await shardText([...rows.values()]);
      // Grown since it was read: other readers are still adding rows, and the
      // rewrite would lose them. A later read gets to it.
      if ((await Deno.lstat(path)).size !== bytesRead) return;
      await atomicWriteTextFile(path, text);
      currentDiagnosticTally().add("summary_shards_rewritten");
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      logger.debug`Rewriting output summaries ${path} failed: ${error}`;
    }
  }

  /**
   * parsed a chunk at a time in slices of the event loop, so a large shard
   * neither holds up other requests nor resists a cancelled read
   */
  async #readShard(
    path: string,
    signal?: AbortSignal,
  ): Promise<
    { rows: Map<string, OutputSummaryRow>; lines: number; bytes: number }
  > {
    const rows = new Map<string, OutputSummaryRow>();
    let content: Uint8Array;
    try {
      content = await Deno.readFile(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        logger.debug`Reading output summaries ${path} failed: ${error}`;
      }
      return { rows, lines: 0, bytes: 0 };
    }
    const decoder = new TextDecoder();
    let lines = 0;
    let decodedTo = 0;
    let chunk: string[] = [];
    let next = 0;
    const more = () => next < chunk.length || decodedTo < content.length;
    const parseNext = () => {
      if (next === chunk.length) {
        const end = chunkEnd(content, decodedTo);
        try {
          chunk = decoder.decode(content.subarray(decodedTo, end)).split("\n");
        } catch (error) {
          logger.debug`Decoding output summaries ${path} failed: ${error}`;
          chunk = [];
          lines++;
        }
        next = 0;
        decodedTo = end;
        return;
      }
      const line = chunk[next++];
      if (line.length === 0) return;
      lines++;
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch {
        return;
      }
      const summary = outputSummaryFromData(data);
      if (summary === undefined || !isSettledStatus(summary.status)) return;
      rows.set(keyOfSummary(summary), {
        summary,
        record: (data as { record?: unknown }).record,
      });
    };
    await inTimeSlices(
      more,
      (until) => {
        do {
          parseNext();
        } while (more() && performance.now() < until);
      },
      signal,
    );
    return { rows, lines, bytes: content.length };
  }

  async append(
    type: string,
    rows: readonly OutputSummaryRow[],
  ): Promise<number> {
    const byShard = new Map<string, OutputSummaryRow[]>();
    for (const row of rows) {
      if (!isSettledStatus(row.summary.status)) continue;
      const stamp = outputFileStamp(row.summary.startedAt);
      if (!/^\d{4}-/.test(stamp)) continue;
      const path = this.#shardPath(type, shardDayOf(stamp));
      const shard = byShard.get(path) ?? [];
      shard.push(row);
      byShard.set(path, shard);
    }
    let written = 0;
    for (const [path, shard] of byShard) {
      try {
        await this.#appendLines(path, await shardText(shard));
        written += shard.length;
      } catch (error) {
        logger.debug`Adding output summaries to ${path} failed: ${error}`;
      }
    }
    return written;
  }

  async #appendLines(path: string, text: string): Promise<void> {
    await assertSafePath(path, this.#boundary);
    // assertSafePath cannot follow a dangling symlink, but an append would.
    if (await isSymlink(path)) throw new Error("The shard is a symlink");
    try {
      await Deno.writeTextFile(path, text, { append: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      await ensureDir(dirname(path));
      await Deno.writeTextFile(path, text, { append: true });
    }
  }

  /**
   * newer shards are left: a record saved since live was listed would lose its
   * row
   */
  async compact(
    live: ReadonlyMap<string, ReadonlySet<string>>,
    quietFrom: string,
  ): Promise<{ shardsRewritten: number; shardsRemoved: number }> {
    const compacted = { shardsRewritten: 0, shardsRemoved: 0 };
    try {
      await assertSafePath(this.#root, this.#boundary);
    } catch (error) {
      logger.debug`Not compacting output summaries ${this.#root}: ${error}`;
      return compacted;
    }
    const generation = await this.generation();
    for (const path of await this.#shardPaths(this.#root)) {
      const day = basename(path).slice(0, -SHARD_SUFFIX.length);
      if (day >= quietFrom) continue;
      // A rewrite after a clear would bring back rows it removed.
      if (await this.generation() !== generation) return compacted;
      const type = relative(this.#root, dirname(path)).split(SEPARATOR)
        .join("/");
      const keys = live.get(type);
      try {
        const { rows, lines } = await this.#readShard(path);
        const kept = [...rows].filter(([key]) => keys?.has(key) === true);
        if (kept.length === 0) {
          await Deno.remove(path);
          compacted.shardsRemoved++;
        } else if (kept.length !== lines) {
          await atomicWriteTextFile(
            path,
            await shardText(kept.map(([, row]) => row)),
          );
          compacted.shardsRewritten++;
        }
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        logger.debug`Compacting output summaries ${path} failed: ${error}`;
      }
    }
    return compacted;
  }

  async #shardPaths(dir: string): Promise<string[]> {
    const paths: string[] = [];
    try {
      for await (const entry of Deno.readDir(dir)) {
        const path = join(dir, entry.name);
        if (entry.isDirectory) {
          for (const nested of await this.#shardPaths(path)) paths.push(nested);
        } else if (entry.isFile && entry.name.endsWith(SHARD_SUFFIX)) {
          paths.push(path);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        logger.debug`Listing output summaries ${dir} failed: ${error}`;
      }
    }
    return paths;
  }
}
