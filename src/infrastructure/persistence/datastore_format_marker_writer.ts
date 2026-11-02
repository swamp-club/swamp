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
  DATASTORE_FORMAT_MARKER_KEY,
  type DatastoreFormatMarker,
} from "../../domain/datastore/datastore_format.ts";
import type { WritableDatastoreControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import { syncDirectory } from "./sync_directory.ts";

export function datastoreFormatMarkerText(
  marker: DatastoreFormatMarker,
): string {
  return JSON.stringify(marker, null, 2) + "\n";
}

/**
 * writes only if no marker is there, so of two concurrent setups exactly one
 * writes; true when this call created it, false when one existed, which tells a
 * lost race from another datastore
 */
export async function writeControlPlaneFormatMarker(
  store: Pick<WritableDatastoreControlPlaneStore, "putIfAbsent">,
  marker: DatastoreFormatMarker,
): Promise<boolean> {
  return await store.putIfAbsent(
    DATASTORE_FORMAT_MARKER_KEY,
    new TextEncoder().encode(datastoreFormatMarkerText(marker)),
  );
}

/**
 * written before any file of its format so a crash leaves the directory empty
 * or marked; never replaces anything, atomically; synced before linking and
 * directory after, so power loss never leaves an empty marker
 */
export async function writeDatastoreFormatMarker(
  datastorePath: string,
  marker: DatastoreFormatMarker,
  options: {
    readonly link?: (from: string, to: string) => Promise<void>;
    readonly syncFile?: (file: Deno.FsFile) => Promise<void>;
    readonly syncDirectory?: (dir: string) => Promise<void>;
  } = {},
): Promise<string> {
  const path = join(datastorePath, DATASTORE_FORMAT_MARKER_FILE);
  const bytes = new TextEncoder().encode(datastoreFormatMarkerText(marker));
  const link = options.link ?? Deno.link;
  const syncFile = options.syncFile ?? ((file: Deno.FsFile) => file.sync());
  const syncDir = options.syncDirectory ?? syncDirectory;
  const exists = () =>
    markErrorPaths(
      new UserError(
        `A datastore format marker already exists at ${path}. Nothing was ` +
          "changed.",
      ),
      [path],
    );
  // written to a temp file then hard-linked into place: the link fails if the
  // path exists, so one of two concurrent setups wins and a reader never sees a
  // partial marker
  const tmpPath = join(datastorePath, `.${crypto.randomUUID()}.tmp`);
  // synced and closed before the link so the link never names content that is
  // not on disk yet; Windows prefers a closed file
  const tmp = await Deno.open(tmpPath, { write: true, createNew: true });
  try {
    await writeAll(tmp, bytes);
    await syncFile(tmp);
  } catch (error) {
    tmp.close();
    await Deno.remove(tmpPath).catch(() => {});
    throw error;
  }
  tmp.close();
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
  if (linked) {
    await syncDir(datastorePath);
    return path;
  }
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
    await writeAll(file, bytes);
    await syncFile(file);
  } finally {
    file.close();
  }
  await syncDir(datastorePath);
  return path;
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    written += await file.write(bytes.subarray(written));
  }
}
