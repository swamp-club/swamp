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

import { join } from "@std/path";
import {
  DATASTORE_FORMAT_MARKER_FILE,
  type DatastoreFormatMarker,
} from "../../domain/datastore/datastore_format.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";

/**
 * Writes a filesystem datastore's format marker at
 * `<datastorePath>/datastore-format.json` (swamp-club#3279). Setup writes it
 * before any file of the format it names, so a crash part-way leaves a
 * directory that is either empty or fully marked.
 *
 * It refuses to replace anything already at that path, atomically: a
 * datastore's format changes only by migration, never by a second setup.
 *
 * @throws UserError when something already exists at the marker path
 */
export async function writeDatastoreFormatMarker(
  datastorePath: string,
  marker: DatastoreFormatMarker,
  options: {
    /** The hard-link call; injectable so a test can stand in a filesystem without links. */
    readonly link?: (from: string, to: string) => Promise<void>;
  } = {},
): Promise<string> {
  const path = join(datastorePath, DATASTORE_FORMAT_MARKER_FILE);
  const text = JSON.stringify(marker, null, 2) + "\n";
  const link = options.link ?? Deno.link;
  const exists = () =>
    markErrorPaths(
      new UserError(
        `A datastore format marker already exists at ${path}. Nothing was ` +
          "changed.",
      ),
      [path],
    );
  // Written whole to a temp file, then linked into place: the link fails if
  // anything is already at the path, so of two concurrent setups exactly
  // one writes the marker, and a reader never sees a partial one.
  const tmpPath = join(datastorePath, `.${crypto.randomUUID()}.tmp`);
  await Deno.writeTextFile(tmpPath, text, { createNew: true });
  let linked = false;
  try {
    await link(tmpPath, path);
    linked = true;
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) throw exists();
    // A filesystem without hard links (exFAT, FAT32, some SMB and NFS
    // mounts) falls through to an exclusive create below.
  } finally {
    await Deno.remove(tmpPath).catch(() => {});
  }
  if (linked) return path;
  // Exclusive create: still exactly one of two concurrent setups wins. A
  // reader may see a partial marker only while setup writes it, and the
  // format guard refuses a garbled one.
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { write: true, createNew: true });
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) throw exists();
    throw error;
  }
  try {
    const bytes = new TextEncoder().encode(text);
    let written = 0;
    while (written < bytes.length) {
      written += await file.write(bytes.subarray(written));
    }
    await file.sync();
  } finally {
    file.close();
  }
  return path;
}
