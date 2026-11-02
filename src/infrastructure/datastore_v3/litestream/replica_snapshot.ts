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
 * The replica's newest snapshot (swamp-club#4261): what tells the writer's
 * sidecar that Litestream wrote a new level-9 snapshot, so its next check
 * reads through it. One `litestream ltx -level 9` lists the snapshot level,
 * a single LIST request on a bucket.
 *
 * `ltx -json` output is not a documented contract, so anything this does not
 * recognise reads as unknown, and an unknown snapshot never starts a check.
 *
 * @module
 */

import { normalizeTxid } from "../../../domain/datastore_v3/published_lineage.ts";
import {
  litestreamChildEnv,
  type LitestreamReplicaType,
} from "./sidecar_env.ts";

/** Litestream's snapshot level. */
const SNAPSHOT_LEVEL = 9;

/**
 * The newest snapshot's max TXID in `litestream ltx -level 9 -json` output,
 * normalized; undefined when the output is not that shape or lists no
 * snapshot.
 */
export function parseNewestSnapshotTxid(output: string): string | undefined {
  let files: unknown;
  try {
    files = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!Array.isArray(files)) return undefined;
  let newest: string | undefined;
  for (const file of files) {
    if (typeof file !== "object" || file === null) return undefined;
    const entry = file as Record<string, unknown>;
    if (entry.level !== SNAPSHOT_LEVEL) return undefined;
    const max = normalizeTxid(entry.max_txid);
    if (max === undefined) return undefined;
    // Fixed width, so text order is TXID order.
    if (newest === undefined || max > newest) newest = max;
  }
  return newest;
}

/** What {@link readNewestSnapshotTxid} lists. */
export interface SnapshotListRequest {
  /** The hash-checked Litestream binary. */
  readonly binary: string;
  /** A Litestream config naming `source` and its one replica. */
  readonly config: string;
  /** The database path the config names; it is never opened. */
  readonly source: string;
  readonly replicaType: LitestreamReplicaType;
  readonly signal: AbortSignal;
}

/**
 * Lists the replica's snapshot level and resolves with its newest snapshot's
 * max TXID, or undefined when it could not be listed or read.
 */
export async function readNewestSnapshotTxid(
  request: SnapshotListRequest,
): Promise<string | undefined> {
  try {
    const result = await new Deno.Command(request.binary, {
      args: [
        "ltx",
        "-config",
        request.config,
        "-no-expand-env",
        "-level",
        String(SNAPSHOT_LEVEL),
        "-json",
        request.source,
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      signal: request.signal,
      // Only what its replica needs (swamp-club#3534).
      env: litestreamChildEnv(request.replicaType, Deno.env.toObject()),
      clearEnv: true,
    }).output();
    if (!result.success) return undefined;
    return parseNewestSnapshotTxid(new TextDecoder().decode(result.stdout));
  } catch {
    return undefined;
  }
}
