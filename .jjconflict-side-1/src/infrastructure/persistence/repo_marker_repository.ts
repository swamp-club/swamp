import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import type { SwampVersion } from "../../domain/repo/swamp_version.ts";
import type { RepoPath } from "../../domain/repo/repo_path.ts";

const MARKER_FILENAME = ".swamp.yaml";

/**
 * Data structure for the .swamp.yaml marker file.
 */
export interface RepoMarkerData {
  swampVersion: string;
  initializedAt: string;
  upgradedAt?: string;
}

/**
 * Repository for reading and writing the .swamp.yaml marker file.
 */
export class RepoMarkerRepository {
  /**
   * Gets the path to the marker file for a given repository.
   */
  getMarkerPath(repoPath: RepoPath): string {
    return join(repoPath.value, MARKER_FILENAME);
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
    await Deno.writeTextFile(path, content);
  }

  /**
   * Creates a new marker data object for initialization.
   */
  createInitMarker(version: SwampVersion): RepoMarkerData {
    return {
      swampVersion: version.toString(),
      initializedAt: new Date().toISOString(),
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
