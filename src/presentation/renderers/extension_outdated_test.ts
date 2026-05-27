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
import { createExtensionOutdatedRenderer } from "./extension_outdated.ts";

Deno.test("JsonExtensionOutdatedRenderer - emits extensions and hasUpdateAvailable", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createExtensionOutdatedRenderer("json");
    await renderer.handlers().completed({
      kind: "completed",
      data: {
        extensions: [
          {
            status: "update_available",
            name: "@ns/foo",
            installedVersion: "2026.01.01.1",
            latestVersion: "2026.05.01.1",
          },
        ],
        hasUpdateAvailable: true,
        hasDeprecated: false,
      },
    });
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.hasUpdateAvailable, true);
    assertEquals(parsed.hasDeprecated, false);
    assertEquals(parsed.extensions.length, 1);
    assertEquals(parsed.extensions[0].status, "update_available");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonExtensionOutdatedRenderer - empty extensions still emits structure", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createExtensionOutdatedRenderer("json");
    await renderer.handlers().completed({
      kind: "completed",
      data: { extensions: [], hasUpdateAvailable: false, hasDeprecated: false },
    });
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.extensions, []);
    assertEquals(parsed.hasUpdateAvailable, false);
  } finally {
    console.log = originalLog;
  }
});
