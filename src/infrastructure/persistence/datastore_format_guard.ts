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
  type DatastoreFormatMarkerRead,
  DatastoreFormatMismatchError,
  engineForFormat,
  parseDatastoreFormatMarker,
  supportedDatastoreFormatsFor,
  UnreachableDatastoreFormatMarkerError,
  UnreadableDatastoreFormatMarkerError,
} from "../../domain/datastore/datastore_format.ts";
import type { CustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import {
  assertV3Hosting,
  missingV3Capabilities,
} from "../../domain/datastore/v3_hosting.ts";
import { markErrorPaths } from "../../domain/errors.ts";
import { expandEnvVars } from "./env_path.ts";
import {
  readDatastoreFormatMarker,
  type ReadDatastoreFormatMarkerOptions,
} from "./datastore_format_marker_reader.ts";
import {
  assertV3BucketExtensionVersion,
  loadedDatastoreExtension,
} from "./datastore_extension_version.ts";
import { resolveCustomProvider } from "./datastore_global_lock.ts";

/**
 * How long the second, uncapped read of an extension datastore's marker may
 * take when the first one timed out or failed and the provider could host v3
 * (swamp-club#3534): long enough for a slow first request and a credentials
 * fetch, short enough that an outage still ends the command.
 */
export const DATASTORE_FORMAT_UNCAPPED_READ_TIMEOUT_MS = 60_000;

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
 * The marker decides the engine. A config's `format` key only records what
 * setup chose, and a config that disagrees with its marker is refused
 * rather than trusted either way. An extension datastore opens as v3
 * (swamp-club#3534) only when its provider can host v3:
 *
 * - config 3 and marker 3: v3;
 * - config 3 and no marker, or a marker naming another format: refused;
 * - config 3 and a marker that cannot be read: v3, provisionally. The v3
 *   writer lease and the copy's first refresh read the marker again, with
 *   no tight deadline, before anything touches the datastore
 *   (`confirmV3BucketMarker`), so a hand-edited `format: 3` over a v2
 *   datastore writes nothing there;
 * - an override (`SWAMP_DATASTORE`, `--datastore`) and marker 3: v3; a
 *   `.swamp.yaml` config with no format and marker 3: refused, since a v3
 *   bucket's repos always record `format: 3`;
 * - no config key, a marker that cannot be read, and a provider that could
 *   host v3: read again without the tight deadline, and refused if that
 *   fails too, never opened as v2 on what may be a v3 datastore;
 * - otherwise a marker that cannot be read is skipped as v2, as before.
 *
 * @throws UnsupportedDatastoreFormatError when the format is newer
 * @throws InvalidDatastoreFormatMarkerError when the marker is garbled
 * @throws DatastoreFormatMismatchError when config and marker disagree
 * @throws UnreachableDatastoreFormatMarkerError when an extension datastore
 *   that may be v3 cannot have its marker read
 * @throws V3HostingUnsupportedError when a v3 extension datastore's provider
 *   cannot host v3
 * @throws V3BucketExtensionTooOldError when a v3 extension datastore's
 *   pulled extension is older than V3_BUCKET_MIN_EXTENSION_VERSION
 */
export async function ensureSupportedDatastoreFormat(
  repoDir: string,
  config: DatastoreConfig,
  options?: ReadDatastoreFormatMarkerOptions,
): Promise<DatastoreEngine> {
  const known = guarded.get(config);
  if (known !== undefined) return known;
  const custom = isCustomDatastoreConfig(config);
  let read = await readDatastoreFormatMarker(repoDir, config, options);
  let provider: DatastoreProvider | undefined;
  if (
    custom && read.kind === "unreadable" && config.format === undefined &&
    config.override === true
  ) {
    // An override names no format, so it may be v3: a provider that could
    // host it is read again, never opened as v2 while the marker is
    // unknown. A `.swamp.yaml` config with no format is v2: setup writes
    // `format: 3` for every v3 datastore, and clones carry it.
    provider = await providerOf(config, options);
    if (
      provider !== undefined && missingV3Capabilities(provider).length === 0
    ) {
      read = await readDatastoreFormatMarker(repoDir, config, {
        ...options,
        timeoutMs: options?.uncappedTimeoutMs ??
          DATASTORE_FORMAT_UNCAPPED_READ_TIMEOUT_MS,
        fallbackTimeoutMs: options?.uncappedTimeoutMs ??
          DATASTORE_FORMAT_UNCAPPED_READ_TIMEOUT_MS,
      });
      if (read.kind === "unreadable") {
        throw new UnreachableDatastoreFormatMarkerError(
          read.source,
          reasonOf(read),
        );
      }
    }
  }
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
    const asked = config.format;
    // A v3 extension datastore whose marker cannot be read now is opened
    // provisionally: the lease and the copy's refresh confirm the marker
    // before anything touches the datastore.
    if (custom && asked === 3 && read.kind === "unreadable") engine = "v3";
    // A `.swamp.yaml` extension config with no format is v2: a v3 bucket's
    // repos always record `format: 3`, so a marker that says v3 under one
    // is another datastore's, or a hand edit, and is never opened as v3
    // (swamp-club#3534). An override carries no format and follows its
    // marker.
    if (
      custom && asked === undefined && config.override !== true &&
      engine === "v3"
    ) {
      throw new DatastoreFormatMismatchError(
        2,
        decision.kind === "supported" ? decision.format : undefined,
      );
    }
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
  if (custom && engine === "v3") {
    provider ??= await providerOf(config, options);
    if (provider === undefined) {
      throw new UnreachableDatastoreFormatMarkerError(
        `the ${config.type} datastore`,
        "its extension could not be loaded",
      );
    }
    assertV3Hosting(provider, config.type);
    // A release older than the minimum lacks swamp-club#3549's guard that
    // keeps its v2 sync off a v3 bucket (swamp-club#3567).
    assertV3BucketExtensionVersion(
      (options?.resolveExtensionVersion ??
        ((dir, type) => loadedDatastoreExtension(dir, type)?.version))(
          repoDir,
          config.type,
        ),
      config.type,
    );
  }
  guarded.set(config, engine);
  return engine;
}

/** The provider of `config`, or undefined when it cannot be resolved. */
async function providerOf(
  config: CustomDatastoreConfig,
  options: ReadDatastoreFormatMarkerOptions | undefined,
): Promise<DatastoreProvider | undefined> {
  try {
    return await (options?.resolveProvider ?? resolveCustomProvider)(config);
  } catch {
    return undefined;
  }
}

function reasonOf(read: DatastoreFormatMarkerRead): string {
  if (read.kind !== "unreadable") return read.kind;
  return read.error instanceof Error ? read.error.message : String(read.error);
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
 * marker says, read from disk; for an unchecked extension datastore, what
 * its config's `format` key says, since its marker is remote. It never
 * refuses: the format guard does that where a datastore is opened.
 */
export function datastoreEngineOf(config: DatastoreConfig): DatastoreEngine {
  const known = guarded.get(config) ?? peeked.get(config);
  if (known !== undefined) return known;
  if (isCustomDatastoreConfig(config)) {
    return config.format === 3 ? "v3" : "v2";
  }
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

/**
 * Whether `config` names an extension datastore synced the v2 way: its own
 * sync service, its provider's locks, its sync service's control plane. A
 * v3 extension datastore (swamp-club#3534) is not: it commits through the
 * commit log, as a filesystem v3 datastore does.
 *
 * Not a type guard on purpose: false does not make a config a filesystem
 * one. Pair it with `isCustomDatastoreConfig` to narrow.
 */
export function isV2CustomDatastore(config: DatastoreConfig): boolean {
  return isCustomDatastoreConfig(config) && datastoreEngineOf(config) !== "v3";
}

/** What {@link datastoreEngineOf} read from disk, per config object. */
const peeked = new WeakMap<DatastoreConfig, DatastoreEngine>();

/**
 * The engine of the datastore a `.swamp.yaml` datastore block names: v3
 * when the block says `format: 3`; for a filesystem datastore also when its
 * marker does (swamp-club#3279); v2 otherwise.
 */
export function datastoreBlockEngine(
  repoDir: string,
  block: { type?: string; path?: string; format?: number } | undefined,
): DatastoreEngine {
  if (block?.format === 3) return "v3";
  if (block?.type !== "filesystem" || block.path === undefined) return "v2";
  const expanded = expandEnvVars(block.path);
  return datastoreEngineOf({
    type: "filesystem",
    path: isAbsolute(expanded) ? expanded : resolve(repoDir, expanded),
  });
}
