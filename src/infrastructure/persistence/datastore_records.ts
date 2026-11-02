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

import { walk } from "@std/fs";
import { join, relative, resolve, SEPARATOR } from "@std/path";
import {
  getDatastoreDirectories,
  REPO_LOCAL_STREAM_SUBDIRS,
} from "../../domain/datastore/datastore_config.ts";

export type CheckoutOwnFile = (segments: readonly string[]) => boolean;

export function checkoutRecordSubdirs(): readonly string[] {
  // No `directories`: the defaults, which setup checks too.
  return getDatastoreDirectories({ type: "filesystem", path: "" }).filter((
    subdir,
  ) => !(REPO_LOCAL_STREAM_SUBDIRS as readonly string[]).includes(subdir));
}

export async function hasDatastoreRecords(
  sourceDir: string,
  subdirs: readonly string[],
  skip: readonly string[],
  isOwn?: CheckoutOwnFile,
): Promise<boolean> {
  for (const subdir of subdirs) {
    for await (const _ of recordFiles(sourceDir, subdir, skip, isOwn)) {
      return true;
    }
  }
  return false;
}

export async function subdirsHoldingRecords(
  sourceDir: string,
  subdirs: readonly string[],
  skip: readonly string[],
  isOwn?: CheckoutOwnFile,
): Promise<string[]> {
  const found: string[] = [];
  for (const subdir of subdirs) {
    for await (const _ of recordFiles(sourceDir, subdir, skip, isOwn)) {
      found.push(subdir);
      break;
    }
  }
  return found;
}

export async function* recordFiles(
  sourceDir: string,
  subdir: string,
  skip: readonly string[],
  isOwn?: CheckoutOwnFile,
): AsyncGenerator<string> {
  const skipped = skip.map((path) => resolve(sourceDir, path));
  const isSkipped = (path: string) =>
    skipped.some((skip) => path === skip || path.startsWith(skip + SEPARATOR));
  try {
    for await (
      const entry of walk(join(sourceDir, subdir), {
        includeDirs: false,
        followSymlinks: false,
      })
    ) {
      if (isSkipped(resolve(entry.path))) continue;
      const path = relative(sourceDir, entry.path);
      if (isOwn?.(path.split(SEPARATOR))) continue;
      yield path;
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
}
