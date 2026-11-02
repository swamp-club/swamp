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
 * a teammate joins via the committed .swamp.yaml, bypassing setup's check, so
 * the first v3 open refuses a checkout holding v2 records before anything
 * catches up, leases or writes; later opens cost one stat
 */

import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";
import { CATALOG_FILES } from "../../domain/datastore/datastore_config.ts";
import { restoreNamespace } from "../../domain/data/namespace.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import {
  checkoutRecordSubdirs,
  recordFiles,
  subdirsHoldingRecords,
} from "../persistence/datastore_records.ts";
import { removeEmptyDirs } from "../persistence/directory_merge.ts";
import { LOCKFILE_NAME } from "../persistence/extension_lockfile_paths.ts";
import { swampPath } from "../persistence/paths.ts";
import { isCheckoutLocalKey, readModelStateDir } from "./record_path_guard.ts";
import { READ_MODEL_STATE_FILE } from "./sqlite_read_model.ts";

export const V3_CHECKOUT_HOLDS_RECORDS_CODE = "v3_checkout_holds_records";

/**
 * not a datastore subdirectory, so the read model never writes or removes a
 * file in it and the join check never counts it
 */
export const PRE_V3_RECORDS_DIR = "pre-v3-records";

export class V3CheckoutHoldsRecordsError extends UserError {
  readonly swampDir: string;
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
 * the lockfile config/upstream_extensions.json counts as the checkout's own:
 * extension auto-install writes it on a fresh checkout's first command, before
 * the check runs. Crash recovery does not use this rule
 */
export function isJoinOwnFile(segments: readonly string[]): boolean {
  if (isCheckoutLocalKey(segments)) return true;
  return segments.length === 2 && segments[0] === "config" &&
    segments[1] === LOCKFILE_NAME;
}

/**
 * the read model creates its state when it opens, before it materialises any
 * file, so a checkout another process is joining already has it; state deleted
 * by hand counts as never opened
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

function recordRoots(
  repoDir: string,
  namespace?: string,
): { readonly dir: string; readonly prefix: string }[] {
  // The namespace comes from .swamp.yaml: one that is no namespace slug
  // (`../..`, a path) is refused before it names a path to walk or move.
  if (namespace) restoreNamespace(namespace);
  return [
    { dir: swampPath(repoDir), prefix: "" },
    ...(namespace
      ? [{ dir: swampPath(repoDir, namespace), prefix: namespace }]
      : []),
  ];
}

/**
 * files the checkout keeps as its own and the v2 catalog are no records; a
 * dot-named data or method name is a record; empty when the checkout has v3
 * state, which is not walked
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
      isJoinOwnFile,
    );
    for (const subdir of holding) {
      found.push(prefix ? join(prefix, subdir) : subdir);
    }
  }
  return found;
}

/**
 * call it before taking the writer lease, restoring a copy, catching up or
 * writing anything for the checkout
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

export interface MovedPreV3Records {
  readonly destination: string;
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
 * only records move; a move that fails part way leaves the moved files moved,
 * and running it again moves the rest into a directory of its own; moves
 * nothing once the checkout has v3 state
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
          isJoinOwnFile,
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
