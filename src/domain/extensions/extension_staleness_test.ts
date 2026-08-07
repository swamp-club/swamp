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
import {
  findStaleExtensions,
  formatStalenessWarning,
  type InstalledExtensionEntry,
} from "./extension_staleness.ts";
import type { ExtensionUpdateCheckMap } from "./extension_update_check_cache.ts";

Deno.test("findStaleExtensions: returns empty when cache is empty", () => {
  const lockfile: Record<string, InstalledExtensionEntry> = {
    "@swamp/s3-datastore": {
      version: "2026.05.26.1",
    },
  };
  const cache: ExtensionUpdateCheckMap = {};

  assertEquals(findStaleExtensions(lockfile, cache), []);
});

Deno.test("findStaleExtensions: returns empty when extension is up to date", () => {
  const lockfile: Record<string, InstalledExtensionEntry> = {
    "@swamp/s3-datastore": {
      version: "2026.07.25.1",
    },
  };
  const cache: ExtensionUpdateCheckMap = {
    "@swamp/s3-datastore": {
      checkedAt: "2026-07-26T00:00:00Z",
      latestVersion: "2026.07.25.1",
    },
  };

  assertEquals(findStaleExtensions(lockfile, cache), []);
});

Deno.test("findStaleExtensions: returns empty when below threshold", () => {
  const lockfile: Record<string, InstalledExtensionEntry> = {
    "@swamp/s3-datastore": {
      version: "2026.07.10.1",
    },
  };
  const cache: ExtensionUpdateCheckMap = {
    "@swamp/s3-datastore": {
      checkedAt: "2026-07-20T00:00:00Z",
      latestVersion: "2026.07.20.1",
    },
  };

  assertEquals(findStaleExtensions(lockfile, cache), []);
});

Deno.test("findStaleExtensions: detects stale extension at threshold boundary", () => {
  const lockfile: Record<string, InstalledExtensionEntry> = {
    "@swamp/s3-datastore": {
      version: "2026.06.12.1",
    },
  };
  const cache: ExtensionUpdateCheckMap = {
    "@swamp/s3-datastore": {
      checkedAt: "2026-06-26T00:00:00Z",
      latestVersion: "2026.06.26.1",
    },
  };

  const result = findStaleExtensions(lockfile, cache);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "@swamp/s3-datastore");
  assertEquals(result[0].daysBehind, 14);
});

Deno.test("findStaleExtensions: detects multiple stale extensions sorted by daysBehind desc", () => {
  const lockfile: Record<string, InstalledExtensionEntry> = {
    "@swamp/s3-datastore": {
      version: "2026.05.26.1",
    },
    "@swamp/vault-aws": {
      version: "2026.03.01.1",
    },
  };
  const cache: ExtensionUpdateCheckMap = {
    "@swamp/s3-datastore": {
      checkedAt: "2026-07-27T00:00:00Z",
      latestVersion: "2026.07.25.1",
    },
    "@swamp/vault-aws": {
      checkedAt: "2026-07-27T00:00:00Z",
      latestVersion: "2026.07.20.1",
    },
  };

  const result = findStaleExtensions(lockfile, cache);
  assertEquals(result.length, 2);
  assertEquals(result[0].name, "@swamp/vault-aws");
  assertEquals(result[0].daysBehind, 141);
  assertEquals(result[1].name, "@swamp/s3-datastore");
  assertEquals(result[1].daysBehind, 60);
});

Deno.test("findStaleExtensions: skips extensions with invalid CalVer in lockfile", () => {
  const lockfile: Record<string, InstalledExtensionEntry> = {
    "@swamp/broken": {
      version: "not-a-calver",
    },
  };
  const cache: ExtensionUpdateCheckMap = {
    "@swamp/broken": {
      checkedAt: "2026-07-27T00:00:00Z",
      latestVersion: "2026.07.25.1",
    },
  };

  assertEquals(findStaleExtensions(lockfile, cache), []);
});

Deno.test("findStaleExtensions: skips extensions with invalid CalVer in cache", () => {
  const lockfile: Record<string, InstalledExtensionEntry> = {
    "@swamp/s3-datastore": {
      version: "2026.05.26.1",
    },
  };
  const cache: ExtensionUpdateCheckMap = {
    "@swamp/s3-datastore": {
      checkedAt: "2026-07-27T00:00:00Z",
      latestVersion: "invalid",
    },
  };

  assertEquals(findStaleExtensions(lockfile, cache), []);
});

Deno.test("findStaleExtensions: uses channel-aware cache key", () => {
  const lockfile: Record<string, InstalledExtensionEntry> = {
    "@swamp/s3-datastore": {
      version: "2026.05.26.1",

      channel: "beta",
    },
  };
  const cache: ExtensionUpdateCheckMap = {
    "@swamp/s3-datastore:beta": {
      checkedAt: "2026-07-27T00:00:00Z",
      latestVersion: "2026.07.25.1",
    },
  };

  const result = findStaleExtensions(lockfile, cache);
  assertEquals(result.length, 1);
  assertEquals(result[0].daysBehind, 60);
});

Deno.test("findStaleExtensions: respects custom threshold", () => {
  const lockfile: Record<string, InstalledExtensionEntry> = {
    "@swamp/s3-datastore": {
      version: "2026.06.01.1",
    },
  };
  const cache: ExtensionUpdateCheckMap = {
    "@swamp/s3-datastore": {
      checkedAt: "2026-06-20T00:00:00Z",
      latestVersion: "2026.06.16.1",
    },
  };

  assertEquals(findStaleExtensions(lockfile, cache, 30), []);
  const defaultResult = findStaleExtensions(lockfile, cache);
  assertEquals(
    defaultResult.length,
    1,
    "default 14-day threshold should catch 15-day gap",
  );
  const result = findStaleExtensions(lockfile, cache, 7);
  assertEquals(result.length, 1);
  assertEquals(result[0].daysBehind, 15);
});

Deno.test("formatStalenessWarning: formats single extension", () => {
  const result = formatStalenessWarning([{
    name: "@swamp/s3-datastore",
    installedVersion: "2026.05.26.1",
    latestVersion: "2026.07.25.1",
    daysBehind: 60,
  }]);
  assertEquals(
    result,
    "1 pulled extension(s) are outdated: @swamp/s3-datastore (60d behind, 2026.05.26.1 → 2026.07.25.1). Run 'swamp extension pull' to update.",
  );
});

Deno.test("formatStalenessWarning: formats multiple extensions", () => {
  const result = formatStalenessWarning([
    {
      name: "@swamp/vault-aws",
      installedVersion: "2026.03.01.1",
      latestVersion: "2026.07.20.1",
      daysBehind: 141,
    },
    {
      name: "@swamp/s3-datastore",
      installedVersion: "2026.05.26.1",
      latestVersion: "2026.07.25.1",
      daysBehind: 60,
    },
  ]);
  assertEquals(
    result,
    "2 pulled extension(s) are outdated: @swamp/vault-aws (141d behind, 2026.03.01.1 → 2026.07.20.1), @swamp/s3-datastore (60d behind, 2026.05.26.1 → 2026.07.25.1). Run 'swamp extension pull' to update.",
  );
});
