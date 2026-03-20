// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { atomicWriteTextFile } from "./atomic_write.ts";
import type { SwampVersion } from "../../domain/repo/swamp_version.ts";
import type { RepoPath } from "../../domain/repo/repo_path.ts";
import { swampMarkerPath } from "./paths.ts";
import type { DatastoreConfigData } from "../../domain/datastore/datastore_config.ts";

/**
 * The AI coding tool to configure skills and instructions for.
 */
export type AiTool = "claude" | "cursor" | "opencode" | "codex" | "kiro";

/**
 * Data structure for the .swamp.yaml marker file.
 */
export interface RepoMarkerData {
  swampVersion: string;
  initializedAt: string;
  upgradedAt?: string;
  modelsDir?: string;
  workflowsDir?: string;
  vaultsDir?: string;
  driversDir?: string;
  datastoresDir?: string;
  reportsDir?: string;
  repoId?: string;
  telemetryEndpoint?: string;
  telemetryDisabled?: boolean;
  telemetryKeepFlushed?: boolean;
  tool?: AiTool;
  logLevel?: string;
  gitignoreManaged?: boolean;
  datastore?: DatastoreConfigData;
  trustedCollectives?: string[];
  trustMemberCollectives?: boolean;
}

/**
 * Repository for reading and writing the .swamp.yaml marker file.
 */
export class RepoMarkerRepository {
  /**
   * Gets the path to the marker file for a given repository.
   */
  getMarkerPath(repoPath: RepoPath): string {
    return swampMarkerPath(repoPath.value);
  }

  /**
   * Checks if a marker file exists at the given repository path.
   */
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

  /**
   * Reads the marker file from the given repository path.
   * Returns null if the file does not exist.
   */
  async read(repoPath: RepoPath): Promise<RepoMarkerData | null> {
    const path = this.getMarkerPath(repoPath);
    try {
      const content = await Deno.readTextFile(path);
      const data = parseYaml(content) as RepoMarkerData;
      return data;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Writes the marker file to the given repository path.
   */
  async write(repoPath: RepoPath, data: RepoMarkerData): Promise<void> {
    const path = this.getMarkerPath(repoPath);
    // Remove undefined values since YAML can't stringify them
    const cleanData = JSON.parse(JSON.stringify(data));
    const content = stringifyYaml(cleanData as Record<string, unknown>);
    await atomicWriteTextFile(path, content);
  }

  /**
   * Creates a new marker data object for initialization.
   */
  createInitMarker(version: SwampVersion): RepoMarkerData {
    return {
      swampVersion: version.toString(),
      initializedAt: new Date().toISOString(),
      repoId: crypto.randomUUID(),
    };
  }

  /**
   * Creates an updated marker data object for upgrade.
   */
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
