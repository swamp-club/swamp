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

import type { SourceMetadata } from "./source_metadata.ts";

/**
 * Port interface for downloading source archives.
 * Implemented by infrastructure adapters.
 */
export interface SourceDownloader {
  /**
   * Download and extract source archive for the given version.
   * @param version Version tag (e.g., "v1.2.3") or "main" for the main branch
   * @param targetDir Directory to extract source into
   * @returns Number of files extracted
   */
  downloadAndExtract(version: string, targetDir: string): Promise<number>;
}

/**
 * Port interface for source metadata persistence.
 * Implemented by infrastructure adapters.
 */
export interface SourceMetadataRepository {
  /**
   * Read source metadata from disk.
   * @returns Metadata if it exists, null otherwise
   */
  read(): Promise<SourceMetadata | null>;

  /**
   * Write source metadata to disk.
   */
  write(metadata: SourceMetadata): Promise<void>;

  /**
   * Delete source metadata file.
   */
  delete(): Promise<void>;

  /**
   * Get the source directory path.
   */
  getSourceDir(): string;
}

/**
 * Result types for source operations.
 */
export type SourceFetchResult =
  | {
    status: "fetched";
    version: string;
    path: string;
    fileCount: number;
    fetchedAt: string;
    previousVersion?: string;
  }
  | {
    status: "already_fetched";
    version: string;
    path: string;
    fileCount: number;
    fetchedAt: string;
  };

export type SourceInfoResult =
  | {
    status: "found";
    version: string;
    path: string;
    fileCount: number;
    fetchedAt: string;
  }
  | { status: "not_found" };

export type SourceCleanResult =
  | { status: "cleaned"; path: string }
  | { status: "not_found"; path: string };

/**
 * Domain service for managing swamp source code.
 */
export class SourceService {
  constructor(
    private readonly downloader: SourceDownloader,
    private readonly repository: SourceMetadataRepository,
  ) {}

  /**
   * Fetch source code for the given version.
   * If the same version is already fetched, returns early.
   */
  async fetch(version: string): Promise<SourceFetchResult> {
    const existing = await this.repository.read();

    // Check if we already have this version
    if (existing && existing.version === version) {
      return {
        status: "already_fetched",
        version: existing.version,
        path: existing.path,
        fileCount: existing.fileCount,
        fetchedAt: existing.fetchedAt,
      };
    }

    const previousVersion = existing?.version;
    const sourceDir = this.repository.getSourceDir();

    // Clean existing source before downloading new version
    if (existing) {
      await this.cleanSourceDir(sourceDir);
    }

    // Download and extract
    const fileCount = await this.downloader.downloadAndExtract(
      version,
      sourceDir,
    );
    const fetchedAt = new Date().toISOString();

    // Save metadata
    const metadata: SourceMetadata = {
      version,
      path: sourceDir,
      fileCount,
      fetchedAt,
    };
    await this.repository.write(metadata);

    return {
      status: "fetched",
      version,
      path: sourceDir,
      fileCount,
      fetchedAt,
      previousVersion,
    };
  }

  /**
   * Get information about currently fetched source.
   */
  async getInfo(): Promise<SourceInfoResult> {
    const metadata = await this.repository.read();
    if (!metadata) {
      return { status: "not_found" };
    }

    return {
      status: "found",
      version: metadata.version,
      path: metadata.path,
      fileCount: metadata.fileCount,
      fetchedAt: metadata.fetchedAt,
    };
  }

  /**
   * Remove downloaded source and metadata.
   */
  async clean(): Promise<SourceCleanResult> {
    const sourceDir = this.repository.getSourceDir();
    const metadata = await this.repository.read();

    if (!metadata) {
      return { status: "not_found", path: sourceDir };
    }

    await this.cleanSourceDir(sourceDir);
    await this.repository.delete();

    return { status: "cleaned", path: sourceDir };
  }

  /**
   * Remove source directory contents.
   */
  private async cleanSourceDir(sourceDir: string): Promise<void> {
    try {
      await Deno.remove(sourceDir, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }
}
