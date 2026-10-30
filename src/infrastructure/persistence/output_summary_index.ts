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

/** Names a clear moves entries to before removing them. */
const CLEARED_ASIDE_PREFIX = ".cleared-";

/**
 * A row of a shard: a run's summary, and the fingerprint of the record it was
 * made from, so a record changed since can be told apart without reading it. As
 * read back from a shard the fingerprint is not trusted:
 * {@link fingerprintMatches} takes anything and matches only a real one.
 */
export interface OutputSummaryRow {
  readonly summary: OutputSummary;
  readonly record: unknown;
}

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

/** `rows` as the lines of a shard. */
function shardText(rows: Iterable<OutputSummaryRow>): string {
  let text = "";
  for (const { summary, record } of rows) {
    text += `${JSON.stringify({ ...outputSummaryToData(summary), record })}\n`;
  }
  return text;
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
 * to the records: a v3 recovery can put back the committed version of a record
 * whose later save the index already holds. Rows are checked against their
 * records anyway, so this is a second guard, and what frees their disk.
 *
 * Entries are moved aside before they are removed. A read adding rows can add a
 * file to a directory while a removal empties it, which fails the removal. Under
 * a name no writer knows that cannot happen, and every shard is gone at once
 * rather than as the removal reaches it. One still there from a removal that
 * failed goes with the next clear. Nothing here fails the caller.
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
    await atomicWriteTextFile(join(dir, CLEARED_MARKER), crypto.randomUUID());
    for (const { name } of await Array.fromAsync(Deno.readDir(dir))) {
      if (name === CLEARED_MARKER) continue;
      if (name.startsWith(CLEARED_ASIDE_PREFIX)) {
        aside.push(join(dir, name));
        continue;
      }
      const moved = join(dir, `${CLEARED_ASIDE_PREFIX}${crypto.randomUUID()}`);
      await Deno.rename(join(dir, name), moved);
      aside.push(moved);
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
 * A derived cache of finished outputs' summaries: per type and UTC day, one
 * NDJSON shard, so a search of a window parses a few shards instead of a YAML
 * file per output (swamp-club#4145).
 *
 * The record files stay the only truth. A row is looked up only by what a
 * listing of the records found, and its key comes from its own content, so it
 * can stand in only for a file whose location says the same. A row with no
 * listed file is never used, so a delete needs no write here. A row carries the
 * fingerprint of the record it was made from, and its caller uses it only while
 * the record's stat still says the same, so a record damaged, replaced or put
 * back is read as it would be without this index. A row that is missing, torn,
 * lost or outdated costs one read of its record, which adds it back if it can;
 * nothing here ever fails a caller. Only finished outputs have rows: a running
 * output changes too often for one to be worth keeping.
 *
 * Every write is one append, so writers in other processes interleave whole
 * lines. Readers racing on a cold index each add the same rows, so {@link read}
 * rewrites a shard that is at least half lines no read would use. A rewrite can
 * lose an append that lands while it runs, which costs that one read as well.
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
   * between that comparison and the append can still lose the race, but a row
   * added that way does not match a record the clear's recovery put back.
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

  /**
   * A shard's rows by key, the last row of each winning. A shard at least half
   * made of lines that lost to another, or are not rows, is rewritten with only
   * the winners. Each line a rewrite drops took an append to add, so a read pays
   * for this at most once per doubling of the shard.
   */
  async read(
    type: string,
    day: string,
  ): Promise<Map<string, OutputSummaryRow>> {
    const path = this.#shardPath(type, day);
    const { rows, lines, bytes } = await this.#readShard(path);
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
      // Grown since it was read: other readers are still adding rows, and the
      // rewrite would lose them. A later read gets to it.
      if ((await Deno.lstat(path)).size !== bytesRead) return;
      await atomicWriteTextFile(path, shardText(rows.values()));
      currentDiagnosticTally().add("summary_shards_rewritten");
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      logger.debug`Rewriting output summaries ${path} failed: ${error}`;
    }
  }

  async #readShard(
    path: string,
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
    let lines = 0;
    for (const line of new TextDecoder().decode(content).split("\n")) {
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
      rows.set(keyOfSummary(summary), {
        summary,
        record: (data as { record?: unknown }).record,
      });
    }
    return { rows, lines, bytes: content.length };
  }

  /**
   * Adds `rows` of `type`, one append per shard; how many were written. A
   * summary whose start no file name can carry, or a run not yet finished, is
   * left out. A failure only leaves those rows to be added on a later read.
   */
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
        await this.#appendLines(path, shardText(shard));
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
            shardText(kept.map(([, row]) => row)),
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
