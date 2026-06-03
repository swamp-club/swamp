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

import { assertEquals } from "@std/assert/equals";
import { assertStringIncludes } from "@std/assert/string-includes";
import { fromFileUrl } from "@std/path";
import {
  buildUpdateResult,
  checkExtensionVersion,
} from "../../domain/extensions/extension_update_service.ts";

// Re-export tests for the domain functions used by the CLI command.
// The domain logic is tested in extension_update_service_test.ts;
// these tests verify the integration surface used by the command.

Deno.test("extension update: checkExtensionVersion detects update available", () => {
  const result = checkExtensionVersion(
    "@ns/test",
    "2026.01.01.1",
    "2026.02.15.1",
  );
  assertEquals(result.status, "update_available");
});

Deno.test("extension update: checkExtensionVersion detects up to date", () => {
  const result = checkExtensionVersion(
    "@ns/test",
    "2026.02.15.1",
    "2026.02.15.1",
  );
  assertEquals(result.status, "up_to_date");
});

Deno.test("extension update: checkExtensionVersion handles null registry version", () => {
  const result = checkExtensionVersion(
    "@ns/test",
    "2026.01.01.1",
    null,
  );
  assertEquals(result.status, "not_found");
});

Deno.test("extension update: buildUpdateResult aggregates mixed statuses", () => {
  const result = buildUpdateResult([
    {
      status: "updated",
      name: "@ns/a",
      previousVersion: "2026.01.01.1",
      newVersion: "2026.02.01.1",
    },
    {
      status: "up_to_date",
      name: "@ns/b",
      installedVersion: "2026.02.01.1",
      latestVersion: "2026.02.01.1",
    },
    {
      status: "not_found",
      name: "@ns/c",
      installedVersion: "2026.01.01.1",
      error: "Not found",
    },
  ]);
  assertEquals(result.summary.total, 3);
  assertEquals(result.summary.updated, 1);
  assertEquals(result.summary.upToDate, 1);
  assertEquals(result.summary.failed, 1);
});

Deno.test("extension update: buildUpdateResult counts failed status in failed bucket", () => {
  const result = buildUpdateResult([
    {
      status: "failed",
      name: "@ns/a",
      installedVersion: "2026.01.01.1",
      error: "Update failed: safety error",
    },
  ]);
  assertEquals(result.summary.total, 1);
  assertEquals(result.summary.updated, 0);
  assertEquals(result.summary.upToDate, 0);
  assertEquals(result.summary.failed, 1);
});

// W2 plan v4 step 12 — CLI routing regression.
//
// `swamp extension update` MUST dispatch each per-extension upgrade
// through `UpgradeExtensionService` (which delegates to
// `InstallExtensionService`'s phase 8 atomic-tombstone pattern). A
// future refactor that replaces the `UpgradeExtensionService` call with
// a direct `installExtension(...)` invocation would silently break the
// `(kind, type)` collision handling for upgrades — every collision in a
// bulk update would surface as `DuplicateTypeError` instead of the
// pinned tombstone-and-replace behavior.
//
// This is a source-text assertion rather than a runtime test because
// the wiring lives inside a CLI-layer closure constructed only by
// Cliffy `.action(...)`. The closure isn't exposed for unit testing,
// and an integration test that spins up a real registry/repository for
// a one-line wiring check would be overkill. A regex-style check on
// the command file catches the regression mechanically and runs in
// milliseconds.
Deno.test("extension update: command wires UpgradeExtensionService (plan v4 step 12)", async () => {
  const source = await Deno.readTextFile(
    fromFileUrl(new URL("./extension_update.ts", import.meta.url)),
  );
  // The import must be present...
  assertStringIncludes(source, "UpgradeExtensionService");
  // ...and an instance must actually be constructed inside the action.
  assertStringIncludes(source, "new UpgradeExtensionService(");
});

Deno.test("extension update: buildUpdateResult aggregates mixed statuses including failed", () => {
  const result = buildUpdateResult([
    {
      status: "updated",
      name: "@ns/a",
      previousVersion: "2026.01.01.1",
      newVersion: "2026.02.01.1",
    },
    {
      status: "failed",
      name: "@ns/b",
      installedVersion: "2026.01.01.1",
      error: "Update failed: integrity check failed",
    },
    {
      status: "not_found",
      name: "@ns/c",
      installedVersion: "2026.01.01.1",
      error: "Not found in registry",
    },
  ]);
  assertEquals(result.summary.total, 3);
  assertEquals(result.summary.updated, 1);
  assertEquals(result.summary.upToDate, 0);
  assertEquals(result.summary.failed, 2);
});
