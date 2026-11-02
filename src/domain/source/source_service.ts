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

export interface SourceDownloader {
  downloadAndExtract(version: string, targetDir: string): Promise<number>;
}

export interface SourceMetadataRepository {
  read(): Promise<SourceMetadata | null>;

  write(metadata: SourceMetadata): Promise<void>;

  delete(): Promise<void>;

  getSourceDir(): string;
}

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

export class SourceService {
  constructor(
    private readonly downloader: SourceDownloader,
    private readonly repository: SourceMetadataRepository,
  ) {}

  async fetch(version: string): Promise<SourceFetchResult> {
    const existing = await this.repository.read();

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

    if (existing) {
      await this.cleanSourceDir(sourceDir);
    }

    const fileCount = await this.downloader.downloadAndExtract(
      version,
      sourceDir,
    );
    const fetchedAt = new Date().toISOString();

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
