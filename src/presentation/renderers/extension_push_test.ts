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

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { ExtensionPushResolvedData } from "../../libswamp/mod.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { createExtensionPushRenderer } from "./extension_push.ts";

await initializeLogging({});

function resolved(
  visibility: "public" | "private" | "default",
): ExtensionPushResolvedData {
  return {
    name: "@test/ext",
    version: "2026.09.16.1",
    visibility,
    description: undefined,
    repository: undefined,
    releaseNotes: undefined,
    models: [],
    workflowFiles: [],
    vaults: [],
    datastores: [],
    reports: [],
    webhooks: [],
    skills: [],
    additionalFiles: [],
    platforms: [],
    labels: [],
    dependencies: [],
  };
}

for (const visibility of ["public", "private", "default"] as const) {
  for (const mode of ["log", "json"] as const) {
    Deno.test(`extensionPushRenderer: ${mode} preview and dry run show requested ${visibility}`, () => {
      const logs: string[] = [];
      const original = console.log;
      console.log = (message: string) => logs.push(message);
      try {
        const renderer = createExtensionPushRenderer(mode);
        renderer.renderResolved(resolved(visibility));
        renderer.renderDryRun({
          name: "@test/ext",
          version: "2026.09.16.1",
          archiveSize: 100,
          visibility,
        });
        if (mode === "json") {
          assertEquals(JSON.parse(logs[0]).visibility, visibility);
          assertEquals(JSON.parse(logs[1]).visibility, visibility);
          assertEquals(JSON.parse(logs[1]).status, "dry_run");
        } else {
          const expected = visibility === "private"
            ? "Requested visibility: private"
            : visibility === "public"
            ? "Requested visibility: public (registry default; existing visibility preserved)"
            : "Requested visibility: default (registry decides)";
          assertEquals(
            logs.filter((line) => line.includes(expected)).length,
            2,
          );
        }
      } finally {
        console.log = original;
      }
    });
  }
}

Deno.test("extensionPushRenderer: JSON success reports applied visibility", async () => {
  const logs: string[] = [];
  const original = console.log;
  console.log = (message: string) => logs.push(message);
  try {
    await createExtensionPushRenderer("json").handlers().completed({
      kind: "completed",
      data: {
        name: "@test/ext",
        version: "2026.09.16.1",
        extensionId: "ext-123",
        visibility: "private",
        channel: "stable",
        archiveSize: 100,
        modelCount: 1,
        workflowCount: 0,
        bundleCount: 1,
        vaultCount: 0,
        datastoreCount: 0,
        reportCount: 0,
        webhookCount: 0,
        skillCount: 0,
      },
    });
    assertEquals(JSON.parse(logs[0]).visibility, "private");
    assertStringIncludes(logs[0], "ext-123");
  } finally {
    console.log = original;
  }
});
