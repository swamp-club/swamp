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
 * The check a checkout passes to join a v3 datastore (swamp-club#3690).
 *
 * A v3 datastore starts empty: its records live in the commit log, and a
 * checkout's files are rebuilt from it. Setup refuses a repository that
 * holds records, but a teammate joins through the committed `.swamp.yaml`
 * instead, so the first v3 open of a checkout runs the same check. A
 * checkout that holds v2 records is refused before anything catches up,
 * leases or writes; `swamp doctor datastores --repair` moves the records
 * aside. Once the checkout has v3 state the check is one stat.
 *
 * @module
 */

import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import { CATALOG_FILES } from "../../domain/datastore/datastore_config.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import {
  checkoutRecordSubdirs,
  recordFiles,
  subdirsHoldingRecords,
} from "../persistence/datastore_records.ts";
import { removeEmptyDirs } from "../persistence/directory_merge.ts";
import { swampPath } from "../persistence/paths.ts";
import { isCheckoutLocalKey, readModelStateDir } from "./record_path_guard.ts";
import { READ_MODEL_STATE_FILE } from "./sqlite_read_model.ts";

/** Error code for a checkout that holds records joining a v3 datastore. */
export const V3_CHECKOUT_HOLDS_RECORDS_CODE = "v3_checkout_holds_records";

/**
 * Where `swamp doctor datastores --repair` moves a joining checkout's
 * records, under its `.swamp/`. It is no datastore subdirectory, so the read
 * model never writes or removes a file in it, and the join check never
 * counts it.
 */
export const PRE_V3_RECORDS_DIR = "pre-v3-records";

/**
 * Thrown when a checkout whose `.swamp/` holds records opens a v3 datastore
 * for the first time (swamp-club#3690). Nothing was written.
 */
export class V3CheckoutHoldsRecordsError extends UserError {
  readonly swampDir: string;
  /** The record directories found, relative to `swampDir`. */
  readonly recordDirs: readonly string[];

  constructor(swampDir: string, recordDirs: readonly string[]) {
    super(
      `${swampDir} holds records (${recordDirs.join(", ")}), but .swamp.yaml ` +
        "now names a v3 datastore. A v3 datastore starts empty: its records " +
        "live in its commit log and this checkout's files are rebuilt from " +
        "it, so these records would be overwritten or left mixed with the " +
        "datastore's. Nothing was changed. Run `swamp doctor datastores " +
        "--repair` to preview moving them aside into " +
        `${join(swampDir, PRE_V3_RECORDS_DIR)}, then ` +
        "`swamp doctor datastores --repair -y` to move them; the next " +
        "command catches up from the datastore. Moved records are not in " +
        "the v3 datastore: bringing them in needs migrating records to v3, " +
        "which is not supported yet. To keep using them as they are, check " +
        "out the .swamp.yaml from before the move to v3.",
      V3_CHECKOUT_HOLDS_RECORDS_CODE,
    );
    this.name = "V3CheckoutHoldsRecordsError";
    this.swampDir = swampDir;
    this.recordDirs = recordDirs;
    markErrorPaths(this, [swampDir, join(swampDir, PRE_V3_RECORDS_DIR)]);
  }
}

/**
 * Whether the checkout at `repoDir` has opened a v3 datastore before: its
 * read model's state exists. The read model creates it when it opens,
 * before it materialises any file, so a checkout another process is joining
 * already has it. State deleted by hand counts as never opened.
 */
export async function hasV3CheckoutState(repoDir: string): Promise<boolean> {
  try {
    await Deno.stat(join(readModelStateDir(repoDir), READ_MODEL_STATE_FILE));
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/**
 * The roots a checkout materialises records under: `.swamp/` and, with a
 * namespace, `.swamp/<namespace>/`, each with its path under `.swamp/`.
 */
function recordRoots(
  repoDir: string,
  namespace?: string,
): { readonly dir: string; readonly prefix: string }[] {
  return [
    { dir: swampPath(repoDir), prefix: "" },
    ...(namespace
      ? [{ dir: swampPath(repoDir, namespace), prefix: namespace }]
      : []),
  ];
}

/**
 * The record directories a checkout that has never opened a v3 datastore
 * holds, relative to its `.swamp/`: those of `.swamp/` and, with a
 * namespace, of `.swamp/<namespace>/`, found as v3 setup finds them. Files
 * the checkout keeps as its own under v3 (`isCheckoutLocalKey`: pulled
 * extension sources, dot-prefixed locks and indexes, run logs) and the v2
 * catalog are no records. Empty when the checkout has v3 state, which is
 * not walked.
 */
export async function preV3CheckoutRecordDirs(
  repoDir: string,
  namespace?: string,
): Promise<string[]> {
  if (await hasV3CheckoutState(repoDir)) return [];
  const subdirs = checkoutRecordSubdirs();
  const found: string[] = [];
  for (const { dir, prefix } of recordRoots(repoDir, namespace)) {
    const holding = await subdirsHoldingRecords(
      dir,
      subdirs,
      CATALOG_FILES,
      isCheckoutLocalKey,
    );
    for (const subdir of holding) {
      found.push(prefix ? join(prefix, subdir) : subdir);
    }
  }
  return found;
}

/**
 * Refuses the first v3 open of a checkout whose `.swamp/` holds records
 * (swamp-club#3690). Call it before taking the writer lease, restoring a
 * copy, catching up or writing anything for the checkout.
 *
 * @throws V3CheckoutHoldsRecordsError when the checkout holds records
 */
export async function assertV3CheckoutJoinable(
  repoDir: string,
  namespace?: string,
): Promise<void> {
  const found = await preV3CheckoutRecordDirs(repoDir, namespace);
  if (found.length > 0) {
    throw new V3CheckoutHoldsRecordsError(swampPath(repoDir), found);
  }
}

/** What {@link movePreV3CheckoutRecords} moved, and where to. */
export interface MovedPreV3Records {
  /** The directory the records were moved into, under `.swamp/`. */
  readonly destination: string;
  /** The record directories moved, relative to `.swamp/` and `destination`. */
  readonly moved: readonly string[];
}

/**
 * A name for one run's directory under {@link PRE_V3_RECORDS_DIR}: the UTC
 * time without separators Windows refuses in a path, and a random suffix so
 * two runs in one second never share it.
 */
export function preV3RecordsRunName(now: Date): string {
  const stamp = now.toISOString().replace(/\.\d{3}/, "").replace(/[-:]/g, "");
  return `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Moves the records of a checkout that has never opened a v3 datastore into
 * a new directory under `.swamp/pre-v3-records/`, keeping their paths
 * relative to `.swamp/`, so the next command joins and catches up
 * (swamp-club#3690). Only records move: the files the checkout keeps as its
 * own under v3 and the v2 catalog stay where they are. A move that fails
 * part way leaves the moved files moved, and running it again moves the
 * rest into a directory of its own. Moves nothing once the checkout has v3
 * state; `destination` is then never created.
 */
export async function movePreV3CheckoutRecords(
  repoDir: string,
  namespace?: string,
  now: Date = new Date(),
): Promise<MovedPreV3Records> {
  const destination = swampPath(
    repoDir,
    PRE_V3_RECORDS_DIR,
    preV3RecordsRunName(now),
  );
  const moved: string[] = [];
  if (await hasV3CheckoutState(repoDir)) return { destination, moved };
  for (const { dir, prefix } of recordRoots(repoDir, namespace)) {
    for (const subdir of checkoutRecordSubdirs()) {
      // Listed before anything moves: renaming while a directory is walked
      // can skip entries.
      const files: string[] = [];
      for await (
        const file of recordFiles(
          dir,
          subdir,
          CATALOG_FILES,
          isCheckoutLocalKey,
        )
      ) {
        files.push(file);
      }
      let movedAny = false;
      for (const file of files) {
        const target = join(destination, prefix, file);
        await ensureDir(dirname(target));
        try {
          await Deno.rename(join(dir, file), target);
          movedAny = true;
        } catch (error) {
          // Already moved with the directory a namespace sits under.
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
        }
      }
      if (!movedAny) continue;
      // Version listing reads version directories on disk, so the empty
      // ones the move leaves behind are removed too.
      await removeEmptyDirs(join(dir, subdir));
      moved.push(prefix ? join(prefix, subdir) : subdir);
    }
  }
  return { destination, moved };
}
