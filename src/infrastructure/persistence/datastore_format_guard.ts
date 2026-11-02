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
  DATASTORE_FORMAT_MARKER_MAX_BYTES,
  type DatastoreEngine,
  type DatastoreFormatMarkerRead,
  DatastoreFormatMismatchError,
  engineForFormat,
  InvalidDatastoreFormatMarkerError,
  isBlankDatastoreFormatMarker,
  LostDatastoreFormatMarkerError,
  lostFormatMarkerAdvice,
  type LostFormatMarkerContext,
  parseDatastoreFormatMarker,
  supportedDatastoreFormatsFor,
  UnreachableDatastoreFormatMarkerError,
  UnreadableDatastoreFormatMarkerError,
  V3_DATASTORE_FORMAT,
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
 * second, uncapped marker read after a first timeout or failure when the
 * provider could host v3; covers a slow first request and credentials fetch but
 * still ends the command in an outage
 */
export const DATASTORE_FORMAT_UNCAPPED_READ_TIMEOUT_MS = 60_000;

const logger = getLogger(["swamp", "datastore", "format-marker"]);

export interface DatastoreFormatGuardOptions
  extends ReadDatastoreFormatMarkerOptions {
  /**
   * the datastore is the directory setup was pointed at, not the repository's
   * own; a lost marker's advice says so
   */
  readonly setupTarget?: boolean;
}

/**
 * named here only to stat: its presence tells a v3 datastore whose marker a
 * crash lost from a v2 one; never opened here
 */
const V3_COMMIT_LOG_FILE = "commits.db";

export type LostDatastoreFormatMarker = "absent" | "blank";

/**
 * a commits.db regular file beside no marker or a blank one; it stats the
 * commit log and never opens it; undefined otherwise, including when either
 * can't be looked at
 */
export async function lostDatastoreFormatMarker(
  datastorePath: string,
): Promise<LostDatastoreFormatMarker | undefined> {
  const markerPath = join(datastorePath, DATASTORE_FORMAT_MARKER_FILE);
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(markerPath);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) return undefined;
    return await holdsV3CommitLog(datastorePath) ? "absent" : undefined;
  }
  if (!info.isFile || info.size > DATASTORE_FORMAT_MARKER_MAX_BYTES) {
    return undefined;
  }
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(markerPath);
  } catch {
    return undefined;
  }
  return await lostMarkerOf(datastorePath, {
    kind: "present",
    source: markerPath,
    bytes,
  });
}

async function lostMarkerOf(
  datastorePath: string,
  read: DatastoreFormatMarkerRead,
): Promise<LostDatastoreFormatMarker | undefined> {
  const lost = read.kind === "absent"
    ? "absent"
    : read.kind === "present" && isBlankDatastoreFormatMarker(read.bytes)
    ? "blank"
    : undefined;
  if (lost === undefined) return undefined;
  return await holdsV3CommitLog(datastorePath) ? lost : undefined;
}

async function holdsV3CommitLog(datastorePath: string): Promise<boolean> {
  try {
    return (await Deno.lstat(join(datastorePath, V3_COMMIT_LOG_FILE))).isFile;
  } catch {
    return false;
  }
}

/**
 * configs already checked this process, passed or skipped, with the chosen
 * engine, so a degraded remote costs one bounded wait per config; refusals are
 * never recorded; nothing outlives the process
 */
const guarded = new WeakMap<DatastoreConfig, DatastoreEngine>();

/**
 * the marker decides the engine; a config that disagrees with it is refused; no
 * marker means format 2; an unreadable marker passes as v2 unless v3 is
 * possible, then it is re-read, never opened as v2
 */
export async function ensureSupportedDatastoreFormat(
  repoDir: string,
  config: DatastoreConfig,
  options?: DatastoreFormatGuardOptions,
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
    // an override names no format so it may be v3: a provider that could host
    // it is read again, never opened as v2 while the marker is unknown; a
    // .swamp.yaml config with no format is v2, as setup writes format 3
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
    const lost = custom ? undefined : await lostMarkerOf(config.path, read);
    if (!custom && lost !== undefined) {
      const context: LostFormatMarkerContext = options?.setupTarget
        ? "setup-target"
        : config.format === 3
        ? "v3-config"
        : "config";
      const advice = lostFormatMarkerAdvice(context);
      if (read.kind === "present") {
        // A blank marker is not JSON: the refusal it always had, with the
        // way out for a lost marker.
        throw new InvalidDatastoreFormatMarkerError(
          read.source,
          "not valid JSON",
          advice,
        );
      }
      if (context === "v3-config") {
        throw new DatastoreFormatMismatchError(3, undefined, advice);
      }
      throw markErrorPaths(
        new LostDatastoreFormatMarkerError(config.path, context),
        [config.path],
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
    // a v3 extension datastore whose marker can't be read now opens
    // provisionally: the lease and the copy's refresh confirm the marker before
    // anything touches the datastore
    if (custom && asked === 3 && read.kind === "unreadable") engine = "v3";
    // a .swamp.yaml extension config with no format is v2: v3 bucket repos
    // always record format 3, so a v3 marker under one is another datastore's
    // or a hand edit, never opened as v3; an override follows its marker
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
        V3_DATASTORE_FORMAT,
      );
    }
    assertV3Hosting(provider, config.type);
    // a release older than the minimum lacks the guard that keeps its v2 sync
    // off a v3 bucket
    const resolveExtension = options?.resolveExtension ??
      loadedDatastoreExtension;
    const extension = resolveExtension(repoDir, config.type);
    assertV3BucketExtensionVersion(
      extension?.version,
      config.type,
      undefined,
      extension?.name,
    );
  }
  guarded.set(config, engine);
  return engine;
}

/**
 * its storage is never read here, so neither is its marker; serve refuses a
 * non-v3 datastore (409 datastore_not_v3), which stands for the marker check,
 * and later guards of the same config answer v3 free
 */
export function recordServeUpstreamFormat(config: DatastoreConfig): void {
  guarded.set(config, "v3");
}

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

export function checkedDatastoreEngine(
  config: DatastoreConfig,
): DatastoreEngine | undefined {
  return guarded.get(config);
}

/**
 * synchronous, for unchecked configs such as path resolvers: checked engine,
 * else the filesystem marker from disk, else an extension config's format key
 * as its marker is remote; never refuses
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
 * true for an extension datastore synced the v2 way; a v3 one commits through
 * the commit log. Not a type guard on purpose: false doesn't make a config a
 * filesystem one, so pair with isCustomDatastoreConfig
 */
export function isV2CustomDatastore(config: DatastoreConfig): boolean {
  return isCustomDatastoreConfig(config) && datastoreEngineOf(config) !== "v3";
}

const peeked = new WeakMap<DatastoreConfig, DatastoreEngine>();

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
