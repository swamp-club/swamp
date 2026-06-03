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

import { assertEquals } from "@std/assert";
import type { SourceMetadata } from "./source_metadata.ts";
import {
  type SourceDownloader,
  type SourceMetadataRepository,
  SourceService,
} from "./source_service.ts";

/**
 * Mock implementation of SourceDownloader for testing.
 */
class MockSourceDownloader implements SourceDownloader {
  downloadCalls: Array<{ version: string; targetDir: string }> = [];
  fileCountToReturn = 100;

  async downloadAndExtract(
    version: string,
    targetDir: string,
  ): Promise<number> {
    this.downloadCalls.push({ version, targetDir });
    return await Promise.resolve(this.fileCountToReturn);
  }
}

/**
 * Mock implementation of SourceMetadataRepository for testing.
 */
class MockSourceMetadataRepository implements SourceMetadataRepository {
  private metadata: SourceMetadata | null = null;
  private readonly sourceDir: string;

  constructor(sourceDir = "/test/.swamp/source") {
    this.sourceDir = sourceDir;
  }

  getSourceDir(): string {
    return this.sourceDir;
  }

  async read(): Promise<SourceMetadata | null> {
    return await Promise.resolve(this.metadata);
  }

  async write(metadata: SourceMetadata): Promise<void> {
    this.metadata = metadata;
    await Promise.resolve();
  }

  async delete(): Promise<void> {
    this.metadata = null;
    await Promise.resolve();
  }

  // Test helper to set initial metadata
  setMetadata(metadata: SourceMetadata): void {
    this.metadata = metadata;
  }
}

Deno.test("SourceService.fetch - downloads and saves metadata for new version", async () => {
  const downloader = new MockSourceDownloader();
  downloader.fileCountToReturn = 245;
  const repository = new MockSourceMetadataRepository();
  const service = new SourceService(downloader, repository);

  const result = await service.fetch("v1.0.0");

  assertEquals(result.status, "fetched");
  if (result.status === "fetched") {
    assertEquals(result.version, "v1.0.0");
    assertEquals(result.fileCount, 245);
    assertEquals(result.path, "/test/.swamp/source");
    assertEquals(result.previousVersion, undefined);
  }

  assertEquals(downloader.downloadCalls.length, 1);
  assertEquals(downloader.downloadCalls[0].version, "v1.0.0");
});

Deno.test("SourceService.fetch - returns already_fetched for same version", async () => {
  const downloader = new MockSourceDownloader();
  const repository = new MockSourceMetadataRepository();
  repository.setMetadata({
    version: "v1.0.0",
    path: "/test/.swamp/source",
    fileCount: 200,
    fetchedAt: "2026-01-01T00:00:00.000Z",
  });
  const service = new SourceService(downloader, repository);

  const result = await service.fetch("v1.0.0");

  assertEquals(result.status, "already_fetched");
  if (result.status === "already_fetched") {
    assertEquals(result.version, "v1.0.0");
    assertEquals(result.fileCount, 200);
  }

  // Should not have downloaded
  assertEquals(downloader.downloadCalls.length, 0);
});

Deno.test("SourceService.fetch - replaces existing version with new one", async () => {
  const downloader = new MockSourceDownloader();
  downloader.fileCountToReturn = 300;
  const repository = new MockSourceMetadataRepository();
  repository.setMetadata({
    version: "v1.0.0",
    path: "/test/.swamp/source",
    fileCount: 200,
    fetchedAt: "2026-01-01T00:00:00.000Z",
  });
  const service = new SourceService(downloader, repository);

  const result = await service.fetch("v2.0.0");

  assertEquals(result.status, "fetched");
  if (result.status === "fetched") {
    assertEquals(result.version, "v2.0.0");
    assertEquals(result.previousVersion, "v1.0.0");
    assertEquals(result.fileCount, 300);
  }

  assertEquals(downloader.downloadCalls.length, 1);
});

Deno.test("SourceService.getInfo - returns not_found when no source", async () => {
  const downloader = new MockSourceDownloader();
  const repository = new MockSourceMetadataRepository();
  const service = new SourceService(downloader, repository);

  const result = await service.getInfo();

  assertEquals(result.status, "not_found");
});

Deno.test("SourceService.getInfo - returns metadata when source exists", async () => {
  const downloader = new MockSourceDownloader();
  const repository = new MockSourceMetadataRepository();
  repository.setMetadata({
    version: "v1.0.0",
    path: "/test/.swamp/source",
    fileCount: 200,
    fetchedAt: "2026-01-01T00:00:00.000Z",
  });
  const service = new SourceService(downloader, repository);

  const result = await service.getInfo();

  assertEquals(result.status, "found");
  if (result.status === "found") {
    assertEquals(result.version, "v1.0.0");
    assertEquals(result.path, "/test/.swamp/source");
    assertEquals(result.fileCount, 200);
    assertEquals(result.fetchedAt, "2026-01-01T00:00:00.000Z");
  }
});

Deno.test("SourceService.clean - returns not_found when no source", async () => {
  const downloader = new MockSourceDownloader();
  const repository = new MockSourceMetadataRepository();
  const service = new SourceService(downloader, repository);

  const result = await service.clean();

  assertEquals(result.status, "not_found");
  assertEquals(result.path, "/test/.swamp/source");
});

Deno.test("SourceService.clean - removes metadata when source exists", async () => {
  const downloader = new MockSourceDownloader();
  const repository = new MockSourceMetadataRepository();
  repository.setMetadata({
    version: "v1.0.0",
    path: "/test/.swamp/source",
    fileCount: 200,
    fetchedAt: "2026-01-01T00:00:00.000Z",
  });
  const service = new SourceService(downloader, repository);

  const result = await service.clean();

  assertEquals(result.status, "cleaned");
  assertEquals(result.path, "/test/.swamp/source");

  // Verify metadata was deleted
  const info = await service.getInfo();
  assertEquals(info.status, "not_found");
});
