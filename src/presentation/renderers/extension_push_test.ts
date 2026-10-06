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
  ApiCallRecord,
  ExtensionPushEvent,
  ExtensionPushResolvedData,
  RegistryCheckResult,
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

const dryRunBase = {
  name: "@test/ext",
  version: "2026.09.16.1",
  archiveSize: 100,
  visibility: "public" as const,
  contentHash: undefined,
  registryChecks: [],
  apiCalls: [],
};

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
          ...dryRunBase,
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
  safety: [{
    ruleId: "deno-command",
    file: "models/a.ts",
    line: 3,
    message: "uses Deno.Command",
  }],
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
 * info, warn and error records to console.info, console.warn and
 * console.error.
 */
function capture(run: () => void | Promise<void>): Promise<string[]> {
  const logs: string[] = [];
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
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
  console.error = push;
  return Promise.resolve()
    .then(run)
    .then(() => logs)
    .finally(() => {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    });
}

Deno.test("extensionPushRenderer: JSON dry run carries acceptedWarnings and omits it when none", async () => {
  const renderer = createExtensionPushRenderer("json");
  const base = dryRunBase;
  const withRecord = await capture(() =>
    renderer.renderDryRun({
      ...base,
      accepted: { warnings: accepted, waivedBy: "--yes" },
    })
  );
  const parsed = JSON.parse(withRecord[0]);
  assertEquals(parsed.acceptedWarnings, accepted);
  assertEquals(parsed.status, "dry_run");
  // The waiving flag is a log-mode detail; the document carries the record
  // under the key that shipped and nothing else about the waiver.
  assertEquals("accepted" in parsed, false);
  assertEquals("waivedBy" in parsed, false);
  assertEquals(Object.keys(parsed), [
    "name",
    "version",
    "archiveSize",
    "visibility",
    "registryChecks",
    "apiCalls",
    "acceptedWarnings",
    "status",
  ]);

  const without = await capture(() => renderer.renderDryRun(base));
  assertEquals("acceptedWarnings" in JSON.parse(without[0]), false);
});

Deno.test("extensionPushRenderer: JSON completed summary carries acceptedWarnings and omits it when none", async () => {
  const renderer = createExtensionPushRenderer("json");
  const withRecord = await capture(() =>
    renderer.handlers({ accepted: { warnings: accepted, waivedBy: "--force" } })
      .completed(completedEvent)
  );
  const parsed = JSON.parse(withRecord[0]);
  assertEquals(parsed.acceptedWarnings, accepted);
  assertEquals(parsed.extensionId, "ext-123");
  assertEquals("waivedBy" in parsed, false);

  const without = await capture(() =>
    renderer.handlers().completed(completedEvent)
  );
  assertEquals("acceptedWarnings" in JSON.parse(without[0]), false);
});

Deno.test("extensionPushRenderer: log dry run lists accepted warnings after the summary, naming --yes", async () => {
  const renderer = createExtensionPushRenderer("log");
  const logs = await capture(() =>
    renderer.renderDryRun({
      ...dryRunBase,
      accepted: { warnings: accepted, waivedBy: "--yes" },
    })
  );
  const output = logs.join("\n");
  const headerAt = output.indexOf("Accepted 2 warnings with --yes:");
  assertEquals(headerAt > output.indexOf("No API calls were made."), true);
  assertStringIncludes(output, "models/a.ts");
  assertStringIncludes(output, "No adversarial review recorded");
  // Only the first line of a multi-line review message is printed.
  assertEquals(output.includes("Write the report to"), false);
});

Deno.test("extensionPushRenderer: log completed summary lists accepted warnings, singular when one, naming --force", async () => {
  const renderer = createExtensionPushRenderer("log");
  const one: AcceptedWarnings = { safety: accepted.safety, review: [] };
  const logs = await capture(() =>
    renderer.handlers({ accepted: { warnings: one, waivedBy: "--force" } })
      .completed(completedEvent)
  );
  const output = logs.join("\n");
  assertStringIncludes(output, 'Pushed "@test/ext"@"2026.09.16.1"');
  assertStringIncludes(output, "Accepted 1 warning with --force:");
  assertStringIncludes(output, "models/a.ts");
});

Deno.test("extensionPushRenderer: log summaries say nothing about acceptance when none", async () => {
  const renderer = createExtensionPushRenderer("log");
  const logs = await capture(async () => {
    renderer.renderDryRun(dryRunBase);
    await renderer.handlers().completed(completedEvent);
  });
  assertEquals(logs.join("\n").includes("Accepted"), false);
});

const checks: RegistryCheckResult[] = [
  { name: "authentication", status: "passed", message: "Signed in as seth." },
  {
    name: "reserved-collective",
    status: "passed",
    message:
      'Collective "@swamp" is reserved; membership verified by the registry.',
  },
  {
    name: "collective-membership",
    status: "not-run",
    message: "authentication failed",
    cause: "authentication-failed",
  },
  {
    name: "version-exists",
    status: "failed",
    message: "Version 2026.09.16.1 already exists for @test/ext.",
  },
];

const calls: ApiCallRecord[] = [
  {
    service: "registry",
    method: "GET",
    url: "https://swamp-club.com/api/whoami",
    outcome: "ok",
    status: 200,
  },
  {
    service: "osv",
    method: "POST",
    url: "https://api.osv.dev/v1/query",
    outcome: "error",
  },
];

Deno.test("extensionPushRenderer: JSON dry run carries contentHash, registryChecks and apiCalls in the dry_run document", async () => {
  const renderer = createExtensionPushRenderer("json");
  const logs = await capture(() =>
    renderer.renderDryRun({
      ...dryRunBase,
      contentHash: "deadbeef",
      registryChecks: checks,
      apiCalls: calls,
    })
  );
  const parsed = JSON.parse(logs[0]);
  assertEquals(Object.keys(parsed), [
    "name",
    "version",
    "archiveSize",
    "visibility",
    "contentHash",
    "registryChecks",
    "apiCalls",
    "status",
  ]);
  assertEquals(parsed.contentHash, "deadbeef");
  assertEquals(parsed.registryChecks, checks);
  assertEquals(parsed.apiCalls, calls);
  assertEquals(parsed.status, "dry_run");
});

Deno.test("extensionPushRenderer: log dry run prints the content hash, each check's verdict and the calls made", async () => {
  const renderer = createExtensionPushRenderer("log");
  const logs = await capture(() =>
    renderer.renderDryRun({
      ...dryRunBase,
      contentHash: "deadbeef",
      registryChecks: checks,
      apiCalls: calls,
    })
  );
  const output = logs.map(stripAnsiCode).join("\n");
  assertStringIncludes(output, 'Content hash: "deadbeef"');
  assertStringIncludes(output, "Registry checks:");
  assertStringIncludes(output, "authentication: passed — Signed in as seth.");
  assertStringIncludes(
    output,
    "collective membership: not run — authentication failed",
  );
  assertStringIncludes(
    output,
    "version exists: failed — Version 2026.09.16.1 already exists for @test/ext.",
  );
  assertStringIncludes(output, "API calls made (2):");
  assertStringIncludes(
    output,
    "registry: GET https://swamp-club.com/api/whoami ok (200)",
  );
  assertStringIncludes(output, "osv: POST https://api.osv.dev/v1/query error");
  assertEquals(output.includes("No API calls were made."), false);
});

Deno.test("extensionPushRenderer: log dry run says no API calls were made only when the list is empty", async () => {
  const renderer = createExtensionPushRenderer("log");
  const logs = await capture(() => renderer.renderDryRun(dryRunBase));
  const output = logs.map(stripAnsiCode).join("\n");
  assertStringIncludes(output, "No API calls were made.");
  assertEquals(output.includes("Registry checks:"), false);
  assertEquals(output.includes("Content hash:"), false);
});
