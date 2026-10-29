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

import { basename, dirname, join } from "@std/path";
import type { WrittenVersion } from "../../domain/datastore/datastore_sync_service.ts";
import { getSwampLogger } from "../logging/logger.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";

/**
 * The data versions one read or list run wrote while another run held its
 * behavior's lock, so it left them for the next run that takes that lock on
 * this host to publish (swamp-club#3934).
 */
export interface PendingPublish {
  /** The record's file name, which {@link removePendingPublishes} takes. */
  readonly file: string;
  readonly versions: readonly WrittenVersion[];
}

/**
 * The directory holding a cache's pending publishes: beside the cache, never
 * in it, so no push walks it and no pull replaces it. One file per deferred
 * run, so two runs recording at once never write the same file.
 */
export function pendingPublishDir(cachePath: string): string {
  return join(dirname(cachePath), `${basename(cachePath)}.pending-publish`);
}

/** Records `written` for the next run that locks their behavior to publish. */
export async function recordPendingPublish(
  cachePath: string,
  written: readonly WrittenVersion[],
): Promise<void> {
  if (written.length === 0) return;
  const dir = pendingPublishDir(cachePath);
  await Deno.mkdir(dir, { recursive: true });
  const versions = written.map((w) => ({
    modelType: w.modelType,
    modelId: w.modelId,
    dataName: w.dataName,
    version: w.version,
    ...(w.dataId === undefined ? {} : { dataId: w.dataId }),
  }));
  await atomicWriteTextFile(
    join(dir, `${crypto.randomUUID()}.json`),
    JSON.stringify({ versions }),
  );
}

/**
 * The pending publishes holding a version of any of `models`. A record that
 * cannot be read or parsed is skipped and kept.
 */
export async function readPendingPublishes(
  cachePath: string,
  models: ReadonlyArray<{ modelType: string; modelId: string }>,
): Promise<PendingPublish[]> {
  const logger = getSwampLogger(["datastore", "pending-publish"]);
  const keys = new Set(models.map((m) => modelKey(m.modelType, m.modelId)));
  const dir = pendingPublishDir(cachePath);
  const records: PendingPublish[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      let versions: WrittenVersion[];
      try {
        versions = parseVersions(
          JSON.parse(await Deno.readTextFile(join(dir, entry.name))),
        );
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        logger
          .debug`Skipping unreadable pending publish ${entry.name}: ${error}`;
        continue;
      }
      if (versions.some((v) => keys.has(modelKey(v.modelType, v.modelId)))) {
        records.push({ file: entry.name, versions });
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  return records;
}

/** Removes the pending publishes named `files`; one already gone is fine. */
export async function removePendingPublishes(
  cachePath: string,
  files: readonly string[],
): Promise<void> {
  const dir = pendingPublishDir(cachePath);
  for (const file of files) {
    try {
      await Deno.remove(join(dir, file));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}

function modelKey(modelType: string, modelId: string): string {
  return JSON.stringify([modelType, modelId]);
}

function parseVersions(raw: unknown): WrittenVersion[] {
  const list = (raw as { versions?: unknown } | null)?.versions;
  if (!Array.isArray(list)) throw new Error("no versions array");
  return list.map((v) => {
    const entry = v as Record<string, unknown>;
    if (
      typeof entry.modelType !== "string" ||
      typeof entry.modelId !== "string" ||
      typeof entry.dataName !== "string" ||
      !Number.isInteger(entry.version) ||
      (entry.dataId !== undefined && typeof entry.dataId !== "string")
    ) {
      throw new Error("malformed version");
    }
    return {
      modelType: entry.modelType,
      modelId: entry.modelId,
      dataName: entry.dataName,
      version: entry.version as number,
      ...(entry.dataId === undefined ? {} : { dataId: entry.dataId }),
    };
  });
}
