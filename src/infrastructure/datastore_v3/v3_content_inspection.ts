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
 * What `swamp doctor datastores` reports about a v3 checkout's content
 * (swamp-club#3617): records the read model could not materialise because
 * a chunk was missing or damaged, checkout files moved aside into the
 * read model's `at-risk` directory, and, on a filesystem datastore, chunks
 * the checkout's live records name that a crash left short.
 *
 * Read-only, and from checkout-local state only: the read model's state
 * database is opened read-only and the datastore's chunks are only
 * `stat`ed. The commit store is never opened, so the checkout's view may lag
 * the datastore's; a chunk absent from the datastore is not reported, as a
 * lagging checkout may still name one history compaction released.
 *
 * @module
 */

import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import {
  type DatastoreConfig,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import type { ChunkStatReader } from "../../domain/datastore/datastore_storage.ts";
import {
  restoreNamespace,
  SOLO_NAMESPACE,
} from "../../domain/data/namespace.ts";
import type { BlobRefJSON } from "../../domain/datastore_v3/blob_ref.ts";
import { storageNamespaceOf } from "../../domain/datastore_v3/chunk_store.ts";
import { unreadableRecordAdvice } from "../../domain/datastore_v3/read_model.ts";
import { FileSystemStorage } from "../persistence/fs_datastore_storage.ts";
import { readModelStateDir } from "./record_path_guard.ts";
import { AT_RISK_DIR, READ_MODEL_STATE_FILE } from "./sqlite_read_model.ts";

/** How many entries of each kind an inspection lists; the rest are counted. */
export const V3_CONTENT_LISTED = 10;

/** Chunks one `statChunks` call reads at most. */
const STAT_BATCH = 512;

/** A record the read model could not materialise. */
export interface V3UnreadableContent {
  /** The commit namespace, `""` unnamespaced. */
  readonly namespace: string;
  readonly recordKey: string;
  readonly reason: "missing" | "damaged";
  /** The first chunk found missing or damaged, when known. */
  readonly chunk?: string;
  /** How to repair or remove it. */
  readonly advice: string;
}

/** A checkout file moved aside into the read model's `at-risk` directory. */
export interface V3AtRiskContent {
  readonly namespace: string;
  /** The whole file's SHA-256, its name in the at-risk directory. */
  readonly sha256: string;
  /** The record key the file was at; empty when unknown. */
  readonly recordKey: string;
  readonly size: number;
}

/** A chunk a live record names that is stored with the wrong size. */
export interface V3TornChunk {
  readonly namespace: string;
  readonly sha256: string;
  /** A record whose content names it. */
  readonly recordKey: string;
  readonly expectedSize: number;
  readonly size: number;
  /** How to repair it. */
  readonly advice: string;
}

/**
 * What {@link inspectV3Content} found. Each list holds the first
 * {@link V3_CONTENT_LISTED} entries; the counts hold them all.
 */
export interface V3ContentInspection {
  readonly unreadableRecords: number;
  readonly unreadable: readonly V3UnreadableContent[];
  readonly atRiskCopies: number;
  readonly atRisk: readonly V3AtRiskContent[];
  /** Where the at-risk copies lie. */
  readonly atRiskDir: string;
  /** Advice for the at-risk copies. */
  readonly atRiskAdvice: string;
  readonly tornChunks: number;
  readonly torn: readonly V3TornChunk[];
}

/** Options for {@link inspectV3Content}. */
export interface InspectV3ContentOptions {
  readonly repoDir: string;
  /**
   * The repository's datastore config: a filesystem datastore's chunks are
   * stat'ed; a bucket's cannot tear and are not.
   */
  readonly datastoreConfig: DatastoreConfig;
  /** The storage whose chunk sizes are read; the filesystem one by default. */
  readonly stats?: ChunkStatReader;
  readonly signal?: AbortSignal;
}

/**
 * Inspects the checkout's v3 read model state for content it could not
 * materialise or moved aside, and the datastore for torn chunks its live
 * records name. A missing state database, or one from before these tables,
 * reports nothing.
 */
export async function inspectV3Content(
  options: InspectV3ContentOptions,
): Promise<V3ContentInspection> {
  const stateDir = readModelStateDir(options.repoDir);
  const atRiskDir = join(stateDir, AT_RISK_DIR);
  const empty: V3ContentInspection = {
    unreadableRecords: 0,
    unreadable: [],
    atRiskCopies: 0,
    atRisk: [],
    atRiskDir,
    atRiskAdvice: atRiskAdvice(atRiskDir),
    tornChunks: 0,
    torn: [],
  };
  const dbPath = join(stateDir, READ_MODEL_STATE_FILE);
  try {
    if (!(await Deno.stat(dbPath)).isFile) return empty;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return empty;
    throw error;
  }
  const signal = options.signal ?? new AbortController().signal;
  const stats = options.stats ??
    (isCustomDatastoreConfig(options.datastoreConfig)
      ? undefined
      : new FileSystemStorage(options.datastoreConfig.path));

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // A reader can meet a writer's lock while the WAL index is rebuilt.
    db.exec("PRAGMA busy_timeout=5000");
    const tables = new Set(
      (db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ).all() as { name: string }[]).map((row) => row.name),
    );

    let unreadableRecords = 0;
    const unreadable: V3UnreadableContent[] = [];
    if (tables.has("unreadable_records")) {
      unreadableRecords = countOf(db, "unreadable_records");
      const rows = db.prepare(
        "SELECT namespace, record_key, reason, chunk FROM unreadable_records " +
          "ORDER BY namespace, record_key LIMIT ?",
      ).all(V3_CONTENT_LISTED) as {
        namespace: string;
        record_key: string;
        reason: string;
        chunk: string | null;
      }[];
      for (const row of rows) {
        unreadable.push({
          namespace: row.namespace,
          recordKey: row.record_key,
          reason: row.reason === "damaged" ? "damaged" : "missing",
          ...(row.chunk !== null ? { chunk: row.chunk } : {}),
          advice: unreadableRecordAdvice(row.record_key),
        });
      }
    }

    let atRiskCopies = 0;
    const atRisk: V3AtRiskContent[] = [];
    if (tables.has("at_risk_copies")) {
      atRiskCopies = countOf(db, "at_risk_copies");
      const rows = db.prepare(
        "SELECT namespace, sha256, record_key, size FROM at_risk_copies " +
          "ORDER BY created_at, namespace, sha256 LIMIT ?",
      ).all(V3_CONTENT_LISTED) as {
        namespace: string;
        sha256: string;
        record_key: string;
        size: number;
      }[];
      for (const row of rows) {
        atRisk.push({
          namespace: row.namespace,
          sha256: row.sha256,
          recordKey: row.record_key,
          size: row.size,
        });
      }
    }

    const torn = stats !== undefined && tables.has("live_records")
      ? await tornChunks(
        db,
        stats,
        signal,
        tables.has("unreadable_records"),
      )
      : { count: 0, listed: [] };

    return {
      ...empty,
      unreadableRecords,
      unreadable,
      atRiskCopies,
      atRisk,
      tornChunks: torn.count,
      torn: torn.listed,
    };
  } finally {
    db.close();
  }
}

function countOf(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
    n: number;
  };
  return Number(row.n);
}

function atRiskAdvice(atRiskDir: string): string {
  return "They hold the only copy this checkout has of content the " +
    "datastore refused to store again. A command that writes, run where " +
    "the datastore accepts puts, stores them and deletes the copies; or " +
    `delete ${atRiskDir} to discard them.`;
}

function tornAdvice(recordKey: string, heldHere: boolean): string {
  if (!heldHere) return unreadableRecordAdvice(recordKey);
  return "This checkout's file still holds the content: the first command " +
    "after a reboot, or writing the record again, stores the chunk again. " +
    `Until then other checkouts cannot read ${recordKey}.`;
}

/**
 * The chunks the live records name, outside a pre-v3 layout, that `stats`
 * finds stored with a size other than their part's: torn by a crash.
 * Absent chunks are left out (see the module doc).
 */
async function tornChunks(
  db: DatabaseSync,
  stats: ChunkStatReader,
  signal: AbortSignal,
  unreadableTable: boolean,
): Promise<{ count: number; listed: V3TornChunk[] }> {
  // A record this checkout could not materialise has no file here to store
  // the chunk from, so its torn chunk gets that record's advice instead.
  const unreadable = unreadableTable
    ? db.prepare(
      "SELECT 1 FROM unreadable_records WHERE namespace = ? AND record_key = ?",
    )
    : undefined;
  const rows = db.prepare(
    "SELECT namespace, record_key, blob FROM live_records " +
      "WHERE blob IS NOT NULL ORDER BY namespace, record_key",
  ).all() as { namespace: string; record_key: string; blob: string }[];
  let count = 0;
  const listed: V3TornChunk[] = [];
  const seen = new Set<string>();
  let pending = new Map<string, { size: number; recordKey: string }>();
  let pendingNamespace = "";

  const flush = async () => {
    if (pending.size === 0) return;
    const ns = storageNamespaceOf(
      pendingNamespace === ""
        ? SOLO_NAMESPACE
        : restoreNamespace(pendingNamespace),
    );
    const found = await stats.statChunks(ns, [...pending.keys()], signal);
    for (const [sha256, part] of pending) {
      const stat = found.get(sha256);
      if (stat === undefined || stat.size === part.size) continue;
      count++;
      if (listed.length < V3_CONTENT_LISTED) {
        listed.push({
          namespace: pendingNamespace,
          sha256,
          recordKey: part.recordKey,
          expectedSize: part.size,
          size: stat.size,
          advice: tornAdvice(
            part.recordKey,
            unreadable?.get(pendingNamespace, part.recordKey) === undefined,
          ),
        });
      }
    }
    pending = new Map();
  };

  for (const row of rows) {
    let blob: BlobRefJSON;
    try {
      blob = JSON.parse(row.blob) as BlobRefJSON;
    } catch {
      continue;
    }
    // A blob still in a pre-v3 layout has no chunk to stat.
    if (blob.legacyKey !== undefined) continue;
    if (row.namespace !== pendingNamespace) {
      await flush();
      pendingNamespace = row.namespace;
    }
    const parts = blob.parts ?? [{ sha256: blob.sha256, size: blob.size }];
    for (const part of parts) {
      const id = `${row.namespace}/${part.sha256}`;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.set(part.sha256, { size: part.size, recordKey: row.record_key });
      if (pending.size >= STAT_BATCH) await flush();
    }
  }
  await flush();
  return { count, listed };
}
