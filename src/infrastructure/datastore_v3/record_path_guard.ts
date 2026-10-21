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
 * The temporary file an atomic write renames over its target
 * (`.<uuid>.tmp`), written beside the target at any depth.
 */
const ATOMIC_WRITE_TEMP =
  /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

/**
 * Whether a file under the materialised subdirectories is the checkout's own
 * and never committed, so recovering an interrupted writer must leave it
 * (swamp-club#3299): an atomic write's temporary file, a `.lock` file (per
 * model under `data/`, the managed lockfile's under `config/`), a workflow's
 * run index, the auto-definition creation locks, a run log, or pulled
 * extension sources and their install staging under managed config.
 * `segments` is the key's path from the cache root.
 *
 * Each rule names the artefact exactly, never "any dot segment": data names
 * and method names may start with a dot (`.kubeconfig`, `.probe`), and those
 * are committed records the recovery sweep must reach (swamp-club#3736).
 */
export function isCheckoutLocalKey(segments: readonly string[]): boolean {
  const name = segments.at(-1) ?? "";
  if (ATOMIC_WRITE_TEMP.test(name) || name === ".lock") return true;
  if (segments[0] === "workflow-runs" && name === ".runs-index.json") {
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

/**
 * Whether the read model leaves every record of commit namespace
 * `namespace` unmaterialised and uncatalogued (swamp-club#3691): a
 * namespace named after one of swamp's own `.swamp/` directories, whose
 * cache root `.swamp/<name>` is that directory. Its records stay in the
 * read model's index, so history and chunk collection stay whole; every
 * checkout skips them, so none of them ever reaches such a directory.
 */
export function isUnprojectedNamespace(namespace: string): boolean {
  return namespace !== "" && isReservedNamespaceName(namespace);
}
