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

import { getConfig, getLogger } from "@logtape/logtape";
import { parse as parseYaml } from "@std/yaml";
import { stringify as stringifyYaml } from "@std/yaml/unstable-stringify";
import { atomicWriteTextFile } from "./atomic_write.ts";
import type { SwampVersion } from "../../domain/repo/swamp_version.ts";
import type { RepoPath } from "../../domain/repo/repo_path.ts";
import { swampMarkerPath } from "./paths.ts";
import type { DatastoreConfigData } from "../../domain/datastore/datastore_config.ts";
import {
  checkRetentionConfig,
  type RetentionConfig,
} from "../../domain/retention/retention_policy.ts";
import type { AiTool } from "../../domain/repo/ai_tool.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import { removedDriverFieldMessage } from "../../domain/removed_driver_fields.ts";

export type { AiTool };

const logger = getLogger(["swamp", "persistence", "repo-marker"]);

/** Unknown-key warnings already logged, so a marker read many times warns once. */
const warnedUnknownKeys = new Set<string>();

export type GarbageCollectionConfig = RetentionConfig;

/**
 * tools is canonical; tool is the legacy field kept only so the read normalizer
 * can recognise it, never populated on returned markers or written
 */
export interface RepoMarkerData {
  swampVersion: string;
  initializedAt: string;
  upgradedAt?: string;
  modelsDir?: string;
  workflowsDir?: string;
  vaultsDir?: string;
  datastoresDir?: string;
  reportsDir?: string;
  webhooksDir?: string;
  repoId?: string;
  telemetryEndpoint?: string;
  telemetryDisabled?: boolean;
  telemetryKeepFlushed?: boolean;
  tools?: string[];
  tool?: AiTool;
  logLevel?: string;
  gitignoreManaged?: boolean;
  datastore?: DatastoreConfigData;
  trustedCollectives?: string[];
  trustMemberCollectives?: boolean;
  skillMigrationDismissed?: boolean;
  autoGc?: boolean;
  garbageCollection?: GarbageCollectionConfig;
  defaultVault?: string;
  serverAddress?: string;
}

/**
 * legacy tool: none maps to tools: [], matching a fresh --tool none init and
 * keeping the round-trip idempotent
 */
function normalizeMarker(data: RepoMarkerData): RepoMarkerData {
  if (data.tools === undefined && data.tool !== undefined) {
    data.tools = data.tool === "none" ? [] : [data.tool];
  }
  delete data.tool;
  return data;
}

function rejectRemovedDriverFields(data: RepoMarkerData, path: string): void {
  for (const field of ["defaultDriver", "defaultDriverConfig"]) {
    if (field in data) {
      throw markErrorPaths(
        new UserError(
          `${path}: ${removedDriverFieldMessage(field)}`,
        ),
        [path],
      );
    }
  }
}

function validateGarbageCollection(
  data: RepoMarkerData,
  path: string,
): void {
  const { errors, ignored, unknownKeys } = checkRetentionConfig(
    data.garbageCollection,
  );
  if (errors.length > 0) {
    throw markErrorPaths(
      new UserError(`${path}: ${errors[0].message}`),
      [path],
    );
  }
  // a bad value in these keys is warned about rather than refused; the block is
  // left as written so a rewrite of .swamp.yaml saves it unchanged
  for (const entry of ignored) {
    warnOnce(
      path,
      entry.replacement === undefined
        ? `${entry.message}; ignoring it`
        : entry.message,
    );
  }
  for (const key of unknownKeys) {
    warnOnce(path, `ignoring unknown key garbageCollection.${key}`);
  }
}

/**
 * the CLI reads the marker before logging is configured and a warning then
 * reaches no sink, so it counts as shown only once logging is configured
 */
function warnOnce(path: string, message: string): void {
  const key = `${path}\0${message}`;
  if (warnedUnknownKeys.has(key)) return;
  if (getConfig() === null) return;
  warnedUnknownKeys.add(key);
  logger.warn`${path}: ${message}`;
}

export class RepoMarkerRepository {
  getMarkerPath(repoPath: RepoPath): string {
    return swampMarkerPath(repoPath.value);
  }

  async exists(repoPath: RepoPath): Promise<boolean> {
    const path = this.getMarkerPath(repoPath);
    try {
      const stat = await Deno.stat(path);
      return stat.isFile;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return false;
      }
      throw error;
    }
  }

  async read(repoPath: RepoPath): Promise<RepoMarkerData | null> {
    const path = this.getMarkerPath(repoPath);
    try {
      const content = await Deno.readTextFile(path);
      const data = parseYaml(content) as RepoMarkerData | null;
      if (!data) return null;
      rejectRemovedDriverFields(data, path);
      validateGarbageCollection(data, path);
      return normalizeMarker(data);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  async write(repoPath: RepoPath, data: RepoMarkerData): Promise<void> {
    const path = this.getMarkerPath(repoPath);
    const cleanData = JSON.parse(JSON.stringify(data));
    delete cleanData.tool;
    const content = stringifyYaml(cleanData as Record<string, unknown>, {
      quoteStyle: '"',
    });
    await atomicWriteTextFile(path, content);
  }

  createInitMarker(version: SwampVersion): RepoMarkerData {
    return {
      swampVersion: version.toString(),
      initializedAt: new Date().toISOString(),
      repoId: crypto.randomUUID(),
    };
  }

  createUpgradeMarker(
    existing: RepoMarkerData,
    newVersion: SwampVersion,
  ): RepoMarkerData {
    return {
      ...existing,
      swampVersion: newVersion.toString(),
      upgradedAt: new Date().toISOString(),
    };
  }
}
