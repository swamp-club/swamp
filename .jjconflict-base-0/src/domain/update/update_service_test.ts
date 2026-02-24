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

import { assertEquals } from "@std/assert";
import {
  isDevBuild,
  parseVersionFromRedirectUrl,
  type UpdateChecker,
  UpdateService,
} from "./update_service.ts";
import { Platform } from "./platform.ts";

interface MockCheckerCalls {
  downloadUrls: string[];
}

function createMockChecker(
  redirectUrl: string | null = null,
  calls?: MockCheckerCalls,
): UpdateChecker {
  return {
    checkForUpdate: (_platform: Platform) => Promise.resolve(redirectUrl),
    downloadAndInstall: (url: string, _binaryPath: string) => {
      calls?.downloadUrls.push(url);
      return Promise.resolve();
    },
  };
}

const platform = Platform.from("darwin", "aarch64");

// --- isDevBuild tests ---

Deno.test("isDevBuild returns true for empty sha", () => {
  assertEquals(isDevBuild("20260206.200442.0-sha."), true);
});

Deno.test("isDevBuild returns true for version without -sha. segment", () => {
  assertEquals(isDevBuild("20260206.200442.0"), true);
});

Deno.test("isDevBuild returns false for version with full sha", () => {
  assertEquals(isDevBuild("20260207.123456.0-sha.abc12345"), false);
});

Deno.test("isDevBuild returns false for version with short sha", () => {
  assertEquals(isDevBuild("20260207.123456.0-sha.abcd"), false);
});

// --- parseVersionFromRedirectUrl tests ---

Deno.test("parseVersionFromRedirectUrl extracts version from redirect URL", () => {
  const url =
    "https://artifacts.systeminit.com/swamp/20260207.123456.0-sha.abc12345/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
  assertEquals(
    parseVersionFromRedirectUrl(url),
    "20260207.123456.0-sha.abc12345",
  );
});

Deno.test("parseVersionFromRedirectUrl returns null for non-matching URL", () => {
  assertEquals(parseVersionFromRedirectUrl("https://example.com/foo"), null);
});

Deno.test("parseVersionFromRedirectUrl handles URL with dev sha", () => {
  const url =
    "https://artifacts.systeminit.com/swamp/20260206.200442.0-sha./binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
  assertEquals(parseVersionFromRedirectUrl(url), "20260206.200442.0-sha.");
});

// --- UpdateService.check tests ---

Deno.test("check returns up_to_date when no redirect", async () => {
  const service = new UpdateService(
    createMockChecker(null),
    "20260207.123456.0-sha.abc12345",
    "/usr/local/bin/swamp",
  );

  const result = await service.check(platform);
  assertEquals(result.status, "up_to_date");
  if (result.status === "up_to_date") {
    assertEquals(result.currentVersion, "20260207.123456.0-sha.abc12345");
  }
});

Deno.test("check returns up_to_date when versions match", async () => {
  const redirectUrl =
    "https://artifacts.systeminit.com/swamp/20260207.123456.0-sha.abc12345/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
  const service = new UpdateService(
    createMockChecker(redirectUrl),
    "20260207.123456.0-sha.abc12345",
    "/usr/local/bin/swamp",
  );

  const result = await service.check(platform);
  assertEquals(result.status, "up_to_date");
});

Deno.test("check returns update_available when versions differ", async () => {
  const redirectUrl =
    "https://artifacts.systeminit.com/swamp/20260208.000000.0-sha.def56789/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
  const service = new UpdateService(
    createMockChecker(redirectUrl),
    "20260207.123456.0-sha.abc12345",
    "/usr/local/bin/swamp",
  );

  const result = await service.check(platform);
  assertEquals(result.status, "update_available");
  if (result.status === "update_available") {
    assertEquals(result.currentVersion, "20260207.123456.0-sha.abc12345");
    assertEquals(result.latestVersion, "20260208.000000.0-sha.def56789");
  }
});

Deno.test("check includes warning for dev build", async () => {
  const service = new UpdateService(
    createMockChecker(null),
    "20260206.200442.0-sha.",
    "/usr/local/bin/swamp",
  );

  const result = await service.check(platform);
  assertEquals(result.status, "up_to_date");
  assertEquals(typeof result.warning, "string");
  assertEquals(result.warning?.includes("development build"), true);
});

Deno.test("check has no warning for release build", async () => {
  const service = new UpdateService(
    createMockChecker(null),
    "20260207.123456.0-sha.abc12345",
    "/usr/local/bin/swamp",
  );

  const result = await service.check(platform);
  assertEquals(result.warning, undefined);
});

// --- UpdateService.update tests ---

Deno.test("update returns up_to_date when already current", async () => {
  const redirectUrl =
    "https://artifacts.systeminit.com/swamp/20260207.123456.0-sha.abc12345/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
  const service = new UpdateService(
    createMockChecker(redirectUrl),
    "20260207.123456.0-sha.abc12345",
    "/usr/local/bin/swamp",
  );

  const result = await service.update(platform);
  assertEquals(result.status, "up_to_date");
});

Deno.test("update returns updated when new version available", async () => {
  const redirectUrl =
    "https://artifacts.systeminit.com/swamp/20260208.000000.0-sha.def56789/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
  const calls: MockCheckerCalls = { downloadUrls: [] };
  const service = new UpdateService(
    createMockChecker(redirectUrl, calls),
    "20260207.123456.0-sha.abc12345",
    "/usr/local/bin/swamp",
  );

  const result = await service.update(platform);
  assertEquals(result.status, "updated");
  if (result.status === "updated") {
    assertEquals(result.previousVersion, "20260207.123456.0-sha.abc12345");
    assertEquals(result.newVersion, "20260208.000000.0-sha.def56789");
  }
  // Verify download used the resolved versioned URL, not the stable URL
  assertEquals(calls.downloadUrls, [redirectUrl]);
});

Deno.test("update includes warning for dev build", async () => {
  const redirectUrl =
    "https://artifacts.systeminit.com/swamp/20260208.000000.0-sha.def56789/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
  const service = new UpdateService(
    createMockChecker(redirectUrl),
    "20260206.200442.0-sha.",
    "/usr/local/bin/swamp",
  );

  const result = await service.update(platform);
  assertEquals(result.status, "updated");
  assertEquals(typeof result.warning, "string");
  assertEquals(result.warning?.includes("development build"), true);
});
