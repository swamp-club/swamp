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
 * keys come from commits other principals write in team mode, so the read model
 * touches a key only under a synced, non-repo-local first segment, naming no
 * catalog database and outside its own state directory
 */

import { join, resolve, SEPARATOR } from "@std/path";
import {
  ALWAYS_LOCAL_SUBDIRS,
  DEFAULT_DATASTORE_SUBDIRS,
  isRunLogFile,
  PULLED_EXTENSIONS_SUBDIR,
  REPO_LOCAL_STREAM_SUBDIRS,
} from "../../domain/datastore/datastore_config.ts";
import { isReservedNamespaceName } from "../../domain/data/namespace.ts";
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

export const CATALOG_V3_FILE = "_catalog_v3.db";

export function v3CatalogPath(repoDir: string): string {
  return join(readModelStateDir(repoDir), CATALOG_V3_FILE);
}

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

const ATOMIC_WRITE_TEMP =
  /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

/**
 * checkout-local files recovery must leave. Each rule names the artefact
 * exactly, never any dot segment: data and method names may start with a dot
 * and are committed records the sweep must reach
 */
export function isCheckoutLocalKey(segments: readonly string[]): boolean {
  const name = segments.at(-1) ?? "";
  if (ATOMIC_WRITE_TEMP.test(name) || name === ".lock") return true;
  if (name === ".DS_Store") return true;
  if (
    segments[0] === "workflow-runs" &&
    (name === ".runs-index.json" || name === ".runs-index.lock")
  ) {
    return true;
  }
  if (
    segments[0] === "auto-definitions" &&
    segments[1] === ".auto-definition-create"
  ) {
    return true;
  }
  if (isRunLogFile(segments[0], name)) return true;
  return segments[0] === "config" && segments[1] === PULLED_EXTENSIONS_SUBDIR;
}

export function refusedKeyReason(
  key: RecordKey,
  root: string,
  stateDir: string,
): string | undefined {
  const lexical = lexicalRefusal(key.toString(), MATERIALISED_SUBDIRS);
  if (lexical !== undefined) return lexical;
  const segments = key.toString().split("/");
  // compared without case so a case-insensitive filesystem cannot alias the
  // state directory; on a case-sensitive one this only refuses more, so keep it
  const path = resolve(join(root, ...segments)).toLowerCase();
  const state = resolve(stateDir).toLowerCase();
  if (path === state || path.startsWith(state + SEPARATOR)) {
    return "it lands in the read model's state directory";
  }
  return undefined;
}

/**
 * a namespace named after one of swamp's own .swamp directories is left
 * unmaterialised; its records stay in the index so history and chunk collection
 * stay whole
 */
export function isUnprojectedNamespace(namespace: string): boolean {
  return namespace !== "" && isReservedNamespaceName(namespace);
}
