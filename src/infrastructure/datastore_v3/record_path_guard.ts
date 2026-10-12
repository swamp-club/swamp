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
 * Which record keys the v3 read model may materialise (swamp-club#3239), and
 * where its own state lives.
 *
 * Record keys come from commits, which in team mode other principals write,
 * and serve does not yet bind a key to its aggregate's paths
 * (`design/enablers/datastores.md`, "Authorisation requirements"). In solo
 * layout the cache root is `.swamp/` itself, which also holds repo-local
 * files. So the read model writes or removes a key only when its first
 * segment is a datastore-synced subdirectory other than a repo-local stream
 * directory, it names no catalog database, and it does not land in the read
 * model's own state directory.
 *
 * @module
 */

import { join, resolve, SEPARATOR } from "@std/path";
import {
  ALWAYS_LOCAL_SUBDIRS,
  DEFAULT_DATASTORE_SUBDIRS,
  REPO_LOCAL_STREAM_SUBDIRS,
} from "../../domain/datastore/datastore_config.ts";
import { lexicalRefusal } from "../../domain/datastore_v3/materialisation.ts";
import type { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import { swampPath } from "../persistence/paths.ts";

/**
 * The read model's state directory under `.swamp/`: `_catalog_v3.db`,
 * `_read_model_v3.db` and the lock file. It is no datastore subdirectory, so
 * it is never synced and no record key may reach it.
 */
export const READ_MODEL_STATE_DIR = "_read_model_v3";

/**
 * The read model's state directory for a repository: always in the
 * checkout's own `.swamp/`, never resolved through the datastore, because
 * the cursor records how far this checkout has caught up.
 */
export function readModelStateDir(repoDir: string): string {
  return swampPath(repoDir, READ_MODEL_STATE_DIR);
}

/** The v3 catalog's file in the state directory. */
export const CATALOG_V3_FILE = "_catalog_v3.db";

/**
 * Where a checkout keeps the v3 catalog: its read model's state directory
 * (swamp-club#3279). `catalogDbPath` returns it on a v3 datastore.
 */
export function v3CatalogPath(repoDir: string): string {
  return join(readModelStateDir(repoDir), CATALOG_V3_FILE);
}

/**
 * The repo-local stream directories (swamp-club#3278), defined beside the
 * datastore directories so datastore setup leaves them in place too
 * (swamp-club#3281).
 */
export { REPO_LOCAL_STREAM_SUBDIRS };

/**
 * The first segments a materialised key may have: the synced subdirectories,
 * less the repo-local stream directories. The read model and history
 * compaction both materialise by this set, so a compacted base matches a
 * replay.
 */
export const MATERIALISED_SUBDIRS: ReadonlySet<string> = new Set(
  DEFAULT_DATASTORE_SUBDIRS.filter((dir) =>
    !(ALWAYS_LOCAL_SUBDIRS as readonly string[]).includes(dir) &&
    !(REPO_LOCAL_STREAM_SUBDIRS as readonly string[]).includes(dir)
  ),
);

/**
 * Why the read model must not write or remove `key` under `root`, or
 * undefined when it may. `stateDir` is the read model's state directory.
 */
export function refusedKeyReason(
  key: RecordKey,
  root: string,
  stateDir: string,
): string | undefined {
  const lexical = lexicalRefusal(key.toString(), MATERIALISED_SUBDIRS);
  if (lexical !== undefined) return lexical;
  const segments = key.toString().split("/");
  // With the state directory at `.swamp/_read_model_v3` the first-segment
  // check already refuses it; this one still holds if a caller passes a
  // state directory inside a synced one. Compared without case, so a
  // case-insensitive filesystem cannot alias it; on a case-sensitive one
  // that only refuses more, never less, so keep it.
  const path = resolve(join(root, ...segments)).toLowerCase();
  const state = resolve(stateDir).toLowerCase();
  if (path === state || path.startsWith(state + SEPARATOR)) {
    return "it lands in the read model's state directory";
  }
  return undefined;
}
