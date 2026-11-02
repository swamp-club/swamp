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
import type {
  UpdateCheckCacheData,
  UpdateCheckCacheRepository,
} from "./update_check_cache.ts";
import { UpdateNotificationService } from "./update_notification_service.ts";
import type { UpdateChecker } from "./update_service.ts";
import { Platform } from "./platform.ts";

function createMockCacheRepo(
  data: UpdateCheckCacheData | null = null,
): UpdateCheckCacheRepository & { written: UpdateCheckCacheData | null } {
  const repo = {
    written: null as UpdateCheckCacheData | null,
    read(): Promise<UpdateCheckCacheData | null> {
      return Promise.resolve(data);
    },
    write(d: UpdateCheckCacheData): Promise<void> {
      repo.written = d;
      return Promise.resolve();
    },
  };
  return repo;
}

function createMockChecker(
  redirectUrl: string | null = null,
): UpdateChecker {
  return {
    checkForUpdate(): Promise<string | null> {
      return Promise.resolve(redirectUrl);
    },
    fetchChecksum(): Promise<string> {
      return Promise.resolve("abc123");
    },
    downloadAndInstall(): Promise<void> {
      return Promise.resolve();
    },
  };
}

function versionDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const stamp = d.toISOString().replace(/[-T:Z]/g, "").substring(0, 8);
  return `${stamp}.200442.0-sha.abc123`;
}

function versionDaysAgoAlt(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const stamp = d.toISOString().replace(/[-T:Z]/g, "").substring(0, 8);
  return `${stamp}.120000.0-sha.def456`;
}

Deno.test("getNotification returns null for dev build", async () => {
  const cacheRepo = createMockCacheRepo();
  const checker = createMockChecker();
  const service = new UpdateNotificationService(
    "20260206.200442.0-sha.",
    cacheRepo,
    checker,
  );

  const result = await service.getNotification();
  assertEquals(result, null);
});

Deno.test("getNotification returns version_stale when version is old", async () => {
  const cacheRepo = createMockCacheRepo();
  const checker = createMockChecker();
  const service = new UpdateNotificationService(
    "20260106.200442.0-sha.abc123",
    cacheRepo,
    checker,
  );

  const result = await service.getNotification();

  assertEquals(result?.type, "version_stale");
  assertEquals(result?.currentVersion, "20260106.200442.0-sha.abc123");
  if (result?.type === "version_stale") {
    assertEquals(typeof result.versionAgeDays, "number");
  }
});

Deno.test("getNotification returns update_available when cache has newer version", async () => {
  const currentVersion = versionDaysAgo(2);
  const latestVersion = versionDaysAgoAlt(0);
  const cache: UpdateCheckCacheData = {
    latestVersion,
    checkedAt: new Date().toISOString(),
  };
  const cacheRepo = createMockCacheRepo(cache);
  const checker = createMockChecker();
  const service = new UpdateNotificationService(
    currentVersion,
    cacheRepo,
    checker,
  );

  const result = await service.getNotification();
  assertEquals(result, {
    type: "update_available",
    currentVersion,
    latestVersion,
  });
});

Deno.test("getNotification returns null when current version is newer than cache", async () => {
  // user updated via another channel to a version newer than what the
  // background check last cached
  const cache: UpdateCheckCacheData = {
    latestVersion: versionDaysAgo(2),
    checkedAt: new Date().toISOString(),
  };
  const cacheRepo = createMockCacheRepo(cache);
  const checker = createMockChecker();
  const service = new UpdateNotificationService(
    versionDaysAgoAlt(1),
    cacheRepo,
    checker,
  );

  const result = await service.getNotification();
  assertEquals(result, null);
});

Deno.test("getNotification returns null when cache matches current version", async () => {
  const version = versionDaysAgo(2);
  const cache: UpdateCheckCacheData = {
    latestVersion: version,
    checkedAt: new Date().toISOString(),
  };
  const cacheRepo = createMockCacheRepo(cache);
  const checker = createMockChecker();
  const service = new UpdateNotificationService(version, cacheRepo, checker);

  const result = await service.getNotification();
  assertEquals(result, null);
});

Deno.test("getNotification returns null when no cache exists and version is recent", async () => {
  const cacheRepo = createMockCacheRepo(null);
  const checker = createMockChecker();
  const recentVersion = `${
    new Date().toISOString().replace(/[-T:Z]/g, "").substring(0, 8)
  }.120000.0-sha.abc123`;
  const service = new UpdateNotificationService(
    recentVersion,
    cacheRepo,
    checker,
  );

  const result = await service.getNotification();
  assertEquals(result, null);
});

Deno.test("backgroundCheck writes cache when stale", async () => {
  const cacheRepo = createMockCacheRepo(null);
  const redirectUrl =
    "https://artifacts.swamp-club.com/swamp/20260301.120000.0-sha.def456/binary/darwin/aarch64/swamp.tar.gz";
  const checker = createMockChecker(redirectUrl);
  const platform = Platform.from("darwin", "aarch64");

  const service = new UpdateNotificationService(
    "20260228.200442.0-sha.abc123",
    cacheRepo,
    checker,
  );

  service.backgroundCheck(platform);

  await new Promise((resolve) => setTimeout(resolve, 50));

  assertEquals(
    cacheRepo.written?.latestVersion,
    "20260301.120000.0-sha.def456",
  );
  assertEquals(typeof cacheRepo.written?.checkedAt, "string");
});

Deno.test("backgroundCheck skips when cache is fresh", async () => {
  const freshCache: UpdateCheckCacheData = {
    latestVersion: "20260301.120000.0-sha.def456",
    checkedAt: new Date().toISOString(),
  };
  const cacheRepo = createMockCacheRepo(freshCache);
  let checkerCalled = false;
  const checker: UpdateChecker = {
    checkForUpdate(): Promise<string | null> {
      checkerCalled = true;
      return Promise.resolve(null);
    },
    fetchChecksum(): Promise<string> {
      return Promise.resolve("");
    },
    downloadAndInstall(): Promise<void> {
      return Promise.resolve();
    },
  };
  const platform = Platform.from("darwin", "aarch64");

  const service = new UpdateNotificationService(
    "20260228.200442.0-sha.abc123",
    cacheRepo,
    checker,
  );

  service.backgroundCheck(platform);

  await new Promise((resolve) => setTimeout(resolve, 50));

  assertEquals(checkerCalled, false);
  assertEquals(cacheRepo.written, null);
});

Deno.test("backgroundCheck writes cache with current version on network error", async () => {
  const cacheRepo = createMockCacheRepo(null);
  const checker: UpdateChecker = {
    checkForUpdate(): Promise<string | null> {
      return Promise.reject(new Error("network failure"));
    },
    fetchChecksum(): Promise<string> {
      return Promise.resolve("");
    },
    downloadAndInstall(): Promise<void> {
      return Promise.resolve();
    },
  };
  const platform = Platform.from("darwin", "aarch64");

  const service = new UpdateNotificationService(
    "20260228.200442.0-sha.abc123",
    cacheRepo,
    checker,
  );

  service.backgroundCheck(platform);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assertEquals(
    cacheRepo.written?.latestVersion,
    "20260228.200442.0-sha.abc123",
  );
  assertEquals(typeof cacheRepo.written?.checkedAt, "string");
});

Deno.test("backgroundCheck writes cache with current version when redirect has no parseable version", async () => {
  const cacheRepo = createMockCacheRepo(null);
  const checker = createMockChecker("https://example.com/no-version-here");
  const platform = Platform.from("darwin", "aarch64");

  const service = new UpdateNotificationService(
    "20260228.200442.0-sha.abc123",
    cacheRepo,
    checker,
  );

  service.backgroundCheck(platform);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assertEquals(
    cacheRepo.written?.latestVersion,
    "20260228.200442.0-sha.abc123",
  );
  assertEquals(typeof cacheRepo.written?.checkedAt, "string");
});
