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
import {
  buildUpdateResult,
  checkExtensionVersion,
} from "./extension_update_service.ts";

Deno.test("checkExtensionVersion returns up_to_date when versions are equal", () => {
  const result = checkExtensionVersion(
    "@test/ext",
    "2026.01.15.1",
    "2026.01.15.1",
  );
  assertEquals(result.status, "up_to_date");
  assertEquals(result.name, "@test/ext");
  if (result.status === "up_to_date") {
    assertEquals(result.installedVersion, "2026.01.15.1");
    assertEquals(result.latestVersion, "2026.01.15.1");
  }
});

Deno.test("checkExtensionVersion returns update_available when installed is older", () => {
  const result = checkExtensionVersion(
    "@test/ext",
    "2026.01.15.1",
    "2026.02.01.1",
  );
  assertEquals(result.status, "update_available");
  if (result.status === "update_available") {
    assertEquals(result.installedVersion, "2026.01.15.1");
    assertEquals(result.latestVersion, "2026.02.01.1");
  }
});

Deno.test("checkExtensionVersion returns up_to_date when installed is newer (no downgrade)", () => {
  const result = checkExtensionVersion(
    "@test/ext",
    "2026.03.01.1",
    "2026.02.01.1",
  );
  assertEquals(result.status, "up_to_date");
});

Deno.test("checkExtensionVersion returns not_found when latest is null", () => {
  const result = checkExtensionVersion(
    "@test/ext",
    "2026.01.15.1",
    null,
  );
  assertEquals(result.status, "not_found");
  if (result.status === "not_found") {
    assertEquals(result.installedVersion, "2026.01.15.1");
    assertEquals(
      result.error,
      "Extension @test/ext not found in the registry.",
    );
  }
});

Deno.test("checkExtensionVersion handles micro version differences", () => {
  const result = checkExtensionVersion(
    "@test/ext",
    "2026.01.15.1",
    "2026.01.15.2",
  );
  assertEquals(result.status, "update_available");
});

Deno.test("buildUpdateResult counts up_to_date correctly", () => {
  const result = buildUpdateResult([
    {
      status: "up_to_date",
      name: "@test/a",
      installedVersion: "2026.01.01.1",
      latestVersion: "2026.01.01.1",
    },
    {
      status: "up_to_date",
      name: "@test/b",
      installedVersion: "2026.02.01.1",
      latestVersion: "2026.02.01.1",
    },
  ]);
  assertEquals(result.summary.total, 2);
  assertEquals(result.summary.upToDate, 2);
  assertEquals(result.summary.updated, 0);
  assertEquals(result.summary.failed, 0);
});

Deno.test("buildUpdateResult counts updated correctly", () => {
  const result = buildUpdateResult([
    {
      status: "updated",
      name: "@test/a",
      previousVersion: "2026.01.01.1",
      newVersion: "2026.02.01.1",
    },
  ]);
  assertEquals(result.summary.total, 1);
  assertEquals(result.summary.upToDate, 0);
  assertEquals(result.summary.updated, 1);
  assertEquals(result.summary.failed, 0);
});

Deno.test("buildUpdateResult counts failed correctly", () => {
  const result = buildUpdateResult([
    {
      status: "not_found",
      name: "@test/a",
      installedVersion: "2026.01.01.1",
      error: "Not found",
    },
  ]);
  assertEquals(result.summary.total, 1);
  assertEquals(result.summary.upToDate, 0);
  assertEquals(result.summary.updated, 0);
  assertEquals(result.summary.failed, 1);
});

Deno.test("buildUpdateResult handles mixed statuses", () => {
  const result = buildUpdateResult([
    {
      status: "up_to_date",
      name: "@test/a",
      installedVersion: "2026.01.01.1",
      latestVersion: "2026.01.01.1",
    },
    {
      status: "updated",
      name: "@test/b",
      previousVersion: "2026.01.01.1",
      newVersion: "2026.02.01.1",
    },
    {
      status: "not_found",
      name: "@test/c",
      installedVersion: "2026.01.01.1",
      error: "Not found",
    },
  ]);
  assertEquals(result.summary.total, 3);
  assertEquals(result.summary.upToDate, 1);
  assertEquals(result.summary.updated, 1);
  assertEquals(result.summary.failed, 1);
});

Deno.test("buildUpdateResult counts failed status correctly", () => {
  const result = buildUpdateResult([
    {
      status: "failed",
      name: "@test/a",
      installedVersion: "2026.01.01.1",
      error: "Update failed: network error",
    },
  ]);
  assertEquals(result.summary.total, 1);
  assertEquals(result.summary.upToDate, 0);
  assertEquals(result.summary.updated, 0);
  assertEquals(result.summary.failed, 1);
});

Deno.test("buildUpdateResult handles mixed statuses including failed", () => {
  const result = buildUpdateResult([
    {
      status: "up_to_date",
      name: "@test/a",
      installedVersion: "2026.01.01.1",
      latestVersion: "2026.01.01.1",
    },
    {
      status: "updated",
      name: "@test/b",
      previousVersion: "2026.01.01.1",
      newVersion: "2026.02.01.1",
    },
    {
      status: "not_found",
      name: "@test/c",
      installedVersion: "2026.01.01.1",
      error: "Not found",
    },
    {
      status: "failed",
      name: "@test/d",
      installedVersion: "2026.01.01.1",
      error: "Update failed: integrity check failed",
    },
  ]);
  assertEquals(result.summary.total, 4);
  assertEquals(result.summary.upToDate, 1);
  assertEquals(result.summary.updated, 1);
  assertEquals(result.summary.failed, 2);
});

Deno.test("checkExtensionVersion returns deprecated when up-to-date and deprecated", () => {
  const result = checkExtensionVersion(
    "@test/ext",
    "2026.01.15.1",
    "2026.01.15.1",
    {
      deprecatedAt: "2026-01-01T00:00:00Z",
      deprecationReason: "EOL",
      supersededBy: "@other/ext",
    },
  );
  assertEquals(result.status, "deprecated");
  if (result.status === "deprecated") {
    assertEquals(result.name, "@test/ext");
    assertEquals(result.installedVersion, "2026.01.15.1");
    assertEquals(result.deprecationReason, "EOL");
    assertEquals(result.supersededBy, "@other/ext");
  }
});

Deno.test("checkExtensionVersion returns update_available when deprecated with newer version", () => {
  const result = checkExtensionVersion(
    "@test/ext",
    "2026.01.15.1",
    "2026.02.01.1",
    {
      deprecatedAt: "2026-01-01T00:00:00Z",
      deprecationReason: "EOL",
      supersededBy: "@other/ext",
    },
  );
  assertEquals(result.status, "update_available");
});

Deno.test("checkExtensionVersion falls through to normal comparison when deprecatedAt is null", () => {
  const result = checkExtensionVersion(
    "@test/ext",
    "2026.01.15.1",
    "2026.01.15.1",
    {
      deprecatedAt: null,
      deprecationReason: null,
      supersededBy: null,
    },
  );
  assertEquals(result.status, "up_to_date");
});

Deno.test("buildUpdateResult counts deprecated as total but not upToDate, updated, or failed", () => {
  const result = buildUpdateResult([
    {
      status: "deprecated",
      name: "@test/a",
      installedVersion: "2026.01.01.1",
      deprecationReason: "EOL",
      supersededBy: "@other/a",
    },
    {
      status: "up_to_date",
      name: "@test/b",
      installedVersion: "2026.01.01.1",
      latestVersion: "2026.01.01.1",
    },
  ]);
  assertEquals(result.summary.total, 2);
  assertEquals(result.summary.upToDate, 1);
  assertEquals(result.summary.updated, 0);
  assertEquals(result.summary.failed, 0);
});

Deno.test("buildUpdateResult handles empty array", () => {
  const result = buildUpdateResult([]);
  assertEquals(result.summary.total, 0);
  assertEquals(result.summary.upToDate, 0);
  assertEquals(result.summary.updated, 0);
  assertEquals(result.summary.failed, 0);
  assertEquals(result.extensions, []);
});
