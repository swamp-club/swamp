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
import { isAbsolute, join, resolve } from "@std/path";
import {
  type DatastoreConfig,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import {
  assertSupportedDatastoreFormat,
  DATASTORE_FORMAT_MARKER_FILE,
  type DatastoreEngine,
  DatastoreFormatMismatchError,
  engineForFormat,
  parseDatastoreFormatMarker,
  supportedDatastoreFormatsFor,
  UnreadableDatastoreFormatMarkerError,
} from "../../domain/datastore/datastore_format.ts";
import { markErrorPaths } from "../../domain/errors.ts";
import { expandEnvVars } from "./env_path.ts";
import {
  readDatastoreFormatMarker,
  type ReadDatastoreFormatMarkerOptions,
} from "./datastore_format_marker_reader.ts";

const logger = getLogger(["swamp", "datastore", "format-marker"]);

/**
 * Config objects already checked in this process, whether the check passed
 * or was skipped (a failed read or a datastore that cannot carry a marker),
 * with the engine the check chose, so a degraded remote costs one bounded
 * wait per config, not one per call. A refusal is never recorded.
 * `resolveDatastoreForRepo` returns a fresh config each call and the helpers
 * hand that same object on to `acquireModelLocks`, so one command pays one
 * read, while a newly resolved config is always checked again. Nothing
 * outlives the process: a datastore can be migrated between runs.
 */
const guarded = new WeakMap<DatastoreConfig, DatastoreEngine>();

/**
 * Refuses a datastore whose format marker names a format this binary cannot
 * read, before anything is locked, pulled, pushed or written, and returns the
 * engine to open it with (swamp-club#3279). A datastore without a marker is
 * format 2 and passes. A failed read, or a datastore that cannot carry a
 * marker, is logged at debug and passes as v2, unless the config asks for v3,
 * which needs the marker to prove it.
 *
 * The marker decides the engine. A filesystem config's `format` key only
 * records what setup chose, and a config that disagrees with its marker is
 * refused rather than trusted either way. v3 is read only on filesystem
 * datastores: S3, GCS and extension datastores still refuse format 3.
 *
 * @throws UnsupportedDatastoreFormatError when the format is newer
 * @throws InvalidDatastoreFormatMarkerError when the marker is garbled
 * @throws DatastoreFormatMismatchError when config and marker disagree
 */
export async function ensureSupportedDatastoreFormat(
  repoDir: string,
  config: DatastoreConfig,
  options?: ReadDatastoreFormatMarkerOptions,
): Promise<DatastoreEngine> {
  const known = guarded.get(config);
  if (known !== undefined) return known;
  const custom = isCustomDatastoreConfig(config);
  const read = await readDatastoreFormatMarker(repoDir, config, options);
  let engine: DatastoreEngine;
  try {
    // A local marker that exists but cannot be read could name v3: refuse
    // rather than open it as v2. A remote read that fails stays a skip, as
    // an outage there is surfaced by the command itself.
    if (!custom && read.kind === "unreadable") {
      throw new UnreadableDatastoreFormatMarkerError(
        read.source,
        read.error instanceof Error ? read.error.message : String(read.error),
      );
    }
    const decision = assertSupportedDatastoreFormat(
      read,
      supportedDatastoreFormatsFor(custom ? "custom" : "filesystem"),
    );
    if (decision.kind === "skipped") {
      logger.debug`Datastore format check skipped: ${decision.reason}`;
    }
    engine = decision.kind === "supported"
      ? engineForFormat(decision.format)
      : "v2";
    const asked = custom ? undefined : config.format;
    if (asked !== undefined && engineForFormat(asked) !== engine) {
      throw new DatastoreFormatMismatchError(
        asked,
        decision.kind === "supported" && read.kind === "present"
          ? decision.format
          : undefined,
      );
    }
  } catch (error) {
    if (
      !custom && error instanceof Error &&
      (read.kind === "present" || read.kind === "invalid" ||
        read.kind === "unreadable")
    ) {
      markErrorPaths(error, [read.source]);
    }
    throw error;
  }
  guarded.set(config, engine);
  return engine;
}

/**
 * The engine {@link ensureSupportedDatastoreFormat} chose for `config`, or
 * `undefined` when this config object has not been checked in this process.
 * Code that builds on a checked config (path resolvers, repository contexts)
 * reads the engine here instead of reading the marker again.
 */
export function checkedDatastoreEngine(
  config: DatastoreConfig,
): DatastoreEngine | undefined {
  return guarded.get(config);
}

/**
 * The engine of `config`, synchronously, for code that builds on a config
 * without checking it first (a path resolver): the checked engine when
 * there is one; for an unchecked filesystem datastore, what its format
 * marker says, read from disk; v2 for anything else, since v3 is filesystem
 * only. It never refuses: the format guard does that where a datastore is
 * opened.
 */
export function datastoreEngineOf(config: DatastoreConfig): DatastoreEngine {
  const known = guarded.get(config) ?? peeked.get(config);
  if (known !== undefined) return known;
  if (isCustomDatastoreConfig(config)) return "v2";
  let engine: DatastoreEngine = "v2";
  try {
    const path = join(config.path, DATASTORE_FORMAT_MARKER_FILE);
    if (Deno.lstatSync(path).isFile) {
      const marker = parseDatastoreFormatMarker(Deno.readFileSync(path), path);
      engine = engineForFormat(marker.format);
    }
  } catch {
    engine = "v2";
  }
  peeked.set(config, engine);
  return engine;
}

/** What {@link datastoreEngineOf} read from disk, per config object. */
const peeked = new WeakMap<DatastoreConfig, DatastoreEngine>();

/**
 * The engine of the filesystem datastore a `.swamp.yaml` datastore block
 * names, read from its marker (swamp-club#3279): v3 when the block says
 * `format: 3` or its marker does, v2 otherwise and for any other type.
 */
export function datastoreBlockEngine(
  repoDir: string,
  block: { type?: string; path?: string; format?: number } | undefined,
): DatastoreEngine {
  if (block?.type !== "filesystem" || block.path === undefined) return "v2";
  if (block.format === 3) return "v3";
  const expanded = expandEnvVars(block.path);
  return datastoreEngineOf({
    type: "filesystem",
    path: isAbsolute(expanded) ? expanded : resolve(repoDir, expanded),
  });
}
