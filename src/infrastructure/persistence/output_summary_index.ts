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
import { isSettledStatus } from "../../domain/models/model_output.ts";
import {
  type OutputSummary,
  outputSummaryFromData,
  outputSummaryToData,
} from "../../domain/models/output_summary.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { swampPath } from "./paths.ts";
import { assertSafePath } from "./safe_path.ts";

const logger = getLogger(["output-repo", "summaries"]);

/**
 * The checkout's own directory of summary shards, under `.swamp` beside the
 * read model's state: outside every materialised and synced subdirectory, so
 * it is never committed, pushed or swept by a v3 recovery.
 */
export const OUTPUT_SUMMARIES_DIR = "_output_summaries";

/** Bump when a shard's lines change, so old shards are simply not read. */
const SCHEMA_VERSION = "v1";

const SHARD_SUFFIX = ".ndjson";

/** Changes each time the summaries are cleared: see {@link OutputSummaryIndex.generation}. */
const CLEARED_MARKER = "cleared";

/** `startedAt` as an output file name spells it. */
export function outputFileStamp(startedAt: Date): string {
  return startedAt.toISOString().replace(/[:.]/g, "-");
}

/** What identifies a row in its shard, and the file it may stand in for. */
export function outputSummaryKey(
  method: string,
  definitionId: string,
  stamp: string,
): string {
  return JSON.stringify([method, definitionId, stamp]);
}

/** The key of the file an output with this summary is saved to. */
function keyOfSummary(summary: OutputSummary): string {
  return outputSummaryKey(
    summary.methodName,
    summary.definitionId,
    outputFileStamp(summary.startedAt),
  );
}

/** The shard a file name's stamp belongs in: its UTC day. */
export function shardDayOf(stamp: string): string {
  return stamp.slice(0, 10);
}

/** Whether `path` is itself a symlink; false when it is absent. */
async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await Deno.lstat(path)).isSymlink;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/**
 * Removes every summary of the checkout at `repoDir`, so its next reads go back
 * to the records. A v3 recovery can put back the committed version of a record
 * whose later save the index already holds, and a finished row is never checked
 * against its record. One that cannot be removed is warned about, never failing
 * the caller.
 */
export async function removeStaleOutputSummaries(
  repoDir: string,
): Promise<void> {
  const dir = swampPath(repoDir, OUTPUT_SUMMARIES_DIR);
  try {
    // A symlink here is not this index's to empty: only the link goes.
    if (await isSymlink(dir)) await Deno.remove(dir);
    await ensureDir(dir);
    // Before the shards go, so a read holding records from before this clear
    // cannot add them back to a directory that looks untouched.
    // Replaced rather than written through, should it be a symlink.
    await atomicWriteTextFile(join(dir, CLEARED_MARKER), crypto.randomUUID());
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name === CLEARED_MARKER) continue;
      await Deno.remove(join(dir, entry.name), { recursive: true }).catch(
        (error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        },
      );
    }
  } catch (error) {
    logger
      .warn`Removing the output summaries of ${repoDir} failed; history reads may show outdated results for finished runs. Delete ${dir} to rebuild them: ${error}`;
  }
}

/**
 * A derived cache of finished outputs' summaries: per type and UTC day, one
 * NDJSON shard, so a search of a window parses a few shards instead of a YAML
 * file per output (swamp-club#4145).
 *
 * The record files stay the only truth. A row is looked up only by what a
 * listing of the records found, and its key comes from its own content, so it
 * can stand in only for a file whose location says the same. A row with no
 * listed file is never used, so a delete needs no write here. A row that is
 * missing, torn or lost costs one read of its record, which adds it back; nothing
 * here ever fails a caller. Only finished outputs have rows, because only their
 * records never change. A row for a running output would have to be checked
 * against its record on every read anyway.
 *
 * Every write is one append, so writers in other processes interleave whole
 * lines. A rewrite ({@link compact}) can lose an append that lands while it
 * runs, which costs that one read as well.
 */
export class OutputSummaryIndex {
  readonly #root: string;
  readonly #marker: string;
  /** Where shards must really be: `.swamp`, so no link inside it can move them. */
  readonly #boundary: string;

  /** `baseDir` is where the records live: each root has its own shards. */
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
   * What identifies the summaries since they were last cleared. A caller adding
   * rows from records compares it from before it read them with its value now:
   * if it moved, those records may be what the clear was for. A clear landing
   * between that comparison and the append can still lose the race, in a window
   * of one file operation rather than a batch of reads.
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

  /** A shard's size in bytes; 0 when it cannot be told or there is none. */
  async shardBytes(type: string, day: string): Promise<number> {
    try {
      return (await Deno.lstat(this.#shardPath(type, day))).size;
    } catch {
      return 0;
    }
  }

  /** A shard's rows by key, the last row of each winning. */
  async read(type: string, day: string): Promise<Map<string, OutputSummary>> {
    return (await this.#readShard(this.#shardPath(type, day))).rows;
  }

  async #readShard(
    path: string,
  ): Promise<{ rows: Map<string, OutputSummary>; lines: number }> {
    const rows = new Map<string, OutputSummary>();
    let text: string;
    try {
      text = new TextDecoder().decode(await Deno.readFile(path));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        logger.debug`Reading output summaries ${path} failed: ${error}`;
      }
      return { rows, lines: 0 };
    }
    let lines = 0;
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      lines++;
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch {
        continue;
      }
      const summary = outputSummaryFromData(data);
      if (summary === undefined || !isSettledStatus(summary.status)) continue;
      rows.set(keyOfSummary(summary), summary);
    }
    return { rows, lines };
  }

  /**
   * Adds `summaries` of `type`, one append per shard; how many were written.
   * A summary whose start no file name can carry, or a run not yet finished, is
   * left out. A failure only leaves those rows to be added on a later read.
   */
  async append(
    type: string,
    summaries: readonly OutputSummary[],
  ): Promise<number> {
    const byShard = new Map<string, string[]>();
    for (const summary of summaries) {
      if (!isSettledStatus(summary.status)) continue;
      const stamp = outputFileStamp(summary.startedAt);
      if (!/^\d{4}-/.test(stamp)) continue;
      const path = this.#shardPath(type, shardDayOf(stamp));
      const lines = byShard.get(path) ?? [];
      lines.push(JSON.stringify(outputSummaryToData(summary)));
      byShard.set(path, lines);
    }
    let written = 0;
    for (const [path, lines] of byShard) {
      try {
        await this.#appendLines(path, `${lines.join("\n")}\n`);
        written += lines.length;
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
   * Drops the rows of every shard older than `quietFrom` (a UTC day) whose
   * record is gone, and shards left with none. `live` holds the key of each
   * record per type. Newer shards are left: a record saved since `live` was
   * listed would lose its row, and they are compacted once they are old enough.
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
            kept.map(([, summary]) =>
              `${JSON.stringify(outputSummaryToData(summary))}\n`
            ).join(""),
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
