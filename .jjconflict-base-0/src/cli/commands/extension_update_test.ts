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

import { assertEquals } from "@std/assert/equals";
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
