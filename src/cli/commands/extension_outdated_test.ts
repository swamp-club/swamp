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
import type { ExtensionUpdateStatus } from "../../domain/extensions/extension_update_service.ts";
import { filterOutdated } from "./extension_outdated.ts";

Deno.test("filterOutdated: keeps update_available", () => {
  const input: ExtensionUpdateStatus[] = [
    {
      status: "update_available",
      name: "@ns/foo",
      installedVersion: "1.0.0",
      latestVersion: "2.0.0",
    },
  ];
  const out = filterOutdated(input);
  assertEquals(out.length, 1);
  assertEquals(out[0].status, "update_available");
});

Deno.test("filterOutdated: drops up_to_date", () => {
  const input: ExtensionUpdateStatus[] = [
    {
      status: "up_to_date",
      name: "@ns/foo",
      installedVersion: "1.0.0",
      latestVersion: "1.0.0",
    },
    {
      status: "update_available",
      name: "@ns/bar",
      installedVersion: "1.0.0",
      latestVersion: "2.0.0",
    },
  ];
  const out = filterOutdated(input);
  assertEquals(out.length, 1);
  assertEquals(out[0].name, "@ns/bar");
});

Deno.test("filterOutdated: keeps not_found and failed for visibility", () => {
  const input: ExtensionUpdateStatus[] = [
    {
      status: "not_found",
      name: "@ns/missing",
      installedVersion: "1.0.0",
      error: "404",
    },
    {
      status: "failed",
      name: "@ns/broken",
      installedVersion: "1.0.0",
      error: "boom",
    },
  ];
  const out = filterOutdated(input);
  assertEquals(out.length, 2);
});

Deno.test("filterOutdated: hasUpdateAvailable semantic — only update_available drives exit code", () => {
  // not_found + failed alone → no update_available → exit 0
  const noUpdates: ExtensionUpdateStatus[] = [
    {
      status: "not_found",
      name: "@ns/x",
      installedVersion: "1.0.0",
      error: "404",
    },
    {
      status: "failed",
      name: "@ns/y",
      installedVersion: "1.0.0",
      error: "boom",
    },
  ];
  const filtered = filterOutdated(noUpdates);
  const hasUpdateAvailable = filtered.some(
    (s) => s.status === "update_available",
  );
  assertEquals(
    hasUpdateAvailable,
    false,
    "only not_found/failed should NOT trip exit 1",
  );

  // Add an update_available → flips to true
  const withUpdate: ExtensionUpdateStatus[] = [
    ...noUpdates,
    {
      status: "update_available",
      name: "@ns/z",
      installedVersion: "1.0.0",
      latestVersion: "2.0.0",
    },
  ];
  assertEquals(
    filterOutdated(withUpdate).some(
      (s) => s.status === "update_available",
    ),
    true,
  );
});
