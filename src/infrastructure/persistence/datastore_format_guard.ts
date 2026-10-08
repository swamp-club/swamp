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

import { getLogger } from "@logtape/logtape";
import {
  type DatastoreConfig,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import { assertSupportedDatastoreFormat } from "../../domain/datastore/datastore_format.ts";
import { markErrorPaths } from "../../domain/errors.ts";
import {
  readDatastoreFormatMarker,
  type ReadDatastoreFormatMarkerOptions,
} from "./datastore_format_marker_reader.ts";

const logger = getLogger(["swamp", "datastore", "format-marker"]);

/**
 * Config objects already checked in this process. `resolveDatastoreForRepo`
 * returns a fresh config each call and the helpers hand that same object on
 * to `acquireModelLocks`, so one command pays one read, while a newly
 * resolved config is always checked again. Nothing outlives the process: a
 * datastore can be migrated between runs.
 */
const guarded = new WeakSet<DatastoreConfig>();

/**
 * Refuses a datastore whose format marker names a format this binary cannot
 * read, before anything is locked, pulled, pushed or written. A datastore
 * without a marker is format 2 and passes. A failed read, or a datastore that
 * cannot carry a marker, is logged at debug and passes.
 *
 * @throws UnsupportedDatastoreFormatError when the format is newer
 * @throws InvalidDatastoreFormatMarkerError when the marker is garbled
 */
export async function ensureSupportedDatastoreFormat(
  repoDir: string,
  config: DatastoreConfig,
  options?: ReadDatastoreFormatMarkerOptions,
): Promise<void> {
  if (guarded.has(config)) return;
  const read = await readDatastoreFormatMarker(repoDir, config, options);
  try {
    const decision = assertSupportedDatastoreFormat(read);
    if (decision.kind === "skipped") {
      logger.debug`Datastore format check skipped: ${decision.reason}`;
    }
  } catch (error) {
    if (
      !isCustomDatastoreConfig(config) && error instanceof Error &&
      (read.kind === "present" || read.kind === "invalid")
    ) {
      markErrorPaths(error, [read.source]);
    }
    throw error;
  }
  guarded.add(config);
}
