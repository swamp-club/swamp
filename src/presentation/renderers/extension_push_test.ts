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
import { stripAnsiCode } from "@std/fmt/colors";
import type {
  ExtensionPushEvent,
  ExtensionPushResolvedData,
} from "../../libswamp/mod.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  type AcceptedWarnings,
  createExtensionPushRenderer,
} from "./extension_push.ts";

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

const accepted: AcceptedWarnings = {
  safety: [{ file: "models/a.ts", message: "uses Deno.Command" }],
  review: [
    {
      ruleId: "adversarial-review-report",
      dimension: "review",
      severity: "high",
      file: "manifest.yaml",
      message:
        "No adversarial review recorded\nWrite the report to /tmp/x.json",
    },
  ],
};

const completedEvent = {
  kind: "completed",
  data: {
    name: "@test/ext",
    version: "2026.09.16.1",
    extensionId: "ext-123",
    visibility: "public",
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
} as const satisfies ExtensionPushEvent;

/**
 * Captures everything the renderer writes: `writeOutput` and the JSON
 * renderer go through console.log, while LogTape's console sink routes
 * info and warn records to console.info and console.warn.
 */
function capture(run: () => void | Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
  };
  const push = (...args: unknown[]) => {
    logs.push(
      stripAnsiCode(
        args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
      ),
    );
  };
  console.log = push;
  console.info = push;
  console.warn = push;
  return Promise.resolve()
    .then(run)
    .then(() => logs)
    .finally(() => {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
    });
}

Deno.test("extensionPushRenderer: JSON dry run carries acceptedWarnings and omits it when none", async () => {
  const renderer = createExtensionPushRenderer("json");
  const base = {
    name: "@test/ext",
    version: "2026.09.16.1",
    archiveSize: 100,
    visibility: "public" as const,
  };
  const withRecord = await capture(() =>
    renderer.renderDryRun({ ...base, acceptedWarnings: accepted })
  );
  assertEquals(JSON.parse(withRecord[0]).acceptedWarnings, accepted);
  assertEquals(JSON.parse(withRecord[0]).status, "dry_run");

  const without = await capture(() => renderer.renderDryRun(base));
  assertEquals("acceptedWarnings" in JSON.parse(without[0]), false);
});

Deno.test("extensionPushRenderer: JSON completed summary carries acceptedWarnings and omits it when none", async () => {
  const renderer = createExtensionPushRenderer("json");
  const withRecord = await capture(() =>
    renderer.handlers({ acceptedWarnings: accepted }).completed(completedEvent)
  );
  const parsed = JSON.parse(withRecord[0]);
  assertEquals(parsed.acceptedWarnings, accepted);
  assertEquals(parsed.extensionId, "ext-123");

  const without = await capture(() =>
    renderer.handlers().completed(completedEvent)
  );
  assertEquals("acceptedWarnings" in JSON.parse(without[0]), false);
});

Deno.test("extensionPushRenderer: log dry run lists accepted warnings after the summary", async () => {
  const renderer = createExtensionPushRenderer("log");
  const logs = await capture(() =>
    renderer.renderDryRun({
      name: "@test/ext",
      version: "2026.09.16.1",
      archiveSize: 100,
      visibility: "public",
      acceptedWarnings: accepted,
    })
  );
  const output = logs.join("\n");
  const headerAt = output.indexOf(
    "Accepted 2 warnings with --accept-warnings:",
  );
  assertEquals(headerAt > output.indexOf("No API calls were made."), true);
  assertStringIncludes(output, "models/a.ts");
  assertStringIncludes(output, "No adversarial review recorded");
  // Only the first line of a multi-line review message is printed.
  assertEquals(output.includes("Write the report to"), false);
});

Deno.test("extensionPushRenderer: log completed summary lists accepted warnings, singular when one", async () => {
  const renderer = createExtensionPushRenderer("log");
  const one: AcceptedWarnings = { safety: accepted.safety, review: [] };
  const logs = await capture(() =>
    renderer.handlers({ acceptedWarnings: one }).completed(completedEvent)
  );
  const output = logs.join("\n");
  assertStringIncludes(output, 'Pushed "@test/ext"@"2026.09.16.1"');
  assertStringIncludes(output, "Accepted 1 warning with --accept-warnings:");
  assertStringIncludes(output, "models/a.ts");
});

Deno.test("extensionPushRenderer: log summaries say nothing about acceptance when none", async () => {
  const renderer = createExtensionPushRenderer("log");
  const logs = await capture(async () => {
    renderer.renderDryRun({
      name: "@test/ext",
      version: "2026.09.16.1",
      archiveSize: 100,
      visibility: "public",
    });
    await renderer.handlers().completed(completedEvent);
  });
  assertEquals(logs.join("\n").includes("--accept-warnings"), false);
});

Deno.test("extensionPushRenderer: the accept-warnings hint renders in log mode only", async () => {
  const logLines = await capture(() =>
    createExtensionPushRenderer("log").renderAcceptWarningsHint()
  );
  assertEquals(logLines.length, 1);
  assertStringIncludes(logLines[0], "--accept-warnings");

  const jsonLines = await capture(() =>
    createExtensionPushRenderer("json").renderAcceptWarningsHint()
  );
  assertEquals(jsonLines, []);
});
