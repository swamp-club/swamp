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
import { join, SEPARATOR } from "@std/path";
import { stripAnsiCode } from "@std/fmt/colors";
import type { FindingsReport } from "./extension_findings_report.ts";
import { remediationFor } from "../../domain/extensions/extension_rule_catalog.ts";
import { evaluateVersionExists } from "../../domain/extensions/extension_publish_checks.ts";
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
  type ExtensionPushRenderer,
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

const ROOT = SEPARATOR === "\\" ? "C:\\" : "/";
/** The author runs the push from `work`; the repo is a sibling of it. */
const PATHS = {
  cwd: join(ROOT, "home", "author", "work"),
  repoDir: join(ROOT, "home", "author", "repo"),
  manifestDir: join(ROOT, "home", "author", "repo", "extensions"),
};

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
    Deno.test(`extensionPushRenderer: ${mode} preview and dry run show requested ${visibility}`, async () => {
      const renderer = createExtensionPushRenderer(mode, PATHS);
      const logs = await capture(() => {
        renderer.renderResolved(resolved(visibility));
        renderer.renderDryRun({ ...dryRunBase, visibility });
      });
      if (mode === "json") {
        // One document: the resolved extension rides inside the dry run's.
        assertEquals(logs.length, 1);
        const doc = JSON.parse(logs[0]);
        assertEquals(doc.resolved.visibility, visibility);
        assertEquals(doc.visibility, visibility);
        assertEquals(doc.status, "dry_run");
      } else {
        const expected = visibility === "private"
          ? "Requested visibility: private"
          : visibility === "public"
          ? "Requested visibility: public (registry default; existing visibility preserved)"
          : "Requested visibility: default (registry decides)";
        // Printed once, through the extension·push logger (swamp-club#3112).
        const matching = logs.filter((line) => line.includes(expected));
        assertEquals(matching.length, 1);
        assertStringIncludes(matching[0], "extension·push:");
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
    "status",
    "name",
    "version",
    "archiveSize",
    "visibility",
    "registryChecks",
    "apiCalls",
    "acceptedWarnings",
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
  assertStringIncludes(output, 'Pushed "@test/ext@2026.09.16.1"');
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
    name: "private-entitlement",
    status: "failed",
    message:
      'Collective "@test" is on the Free plan and its trial ended on 2026-08-19. ' +
      "Private publication requires a paid plan; upgrade at https://swamp-club.com/o/test/billing.",
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
    "status",
    "name",
    "version",
    "archiveSize",
    "visibility",
    "contentHash",
    "registryChecks",
    "apiCalls",
  ]);
  assertEquals(parsed.contentHash, "deadbeef");
  assertEquals(parsed.registryChecks, checks);
  assertEquals(parsed.apiCalls, calls);
  assertEquals(parsed.status, "dry_run");
});

Deno.test("extensionPushRenderer: JSON dry run carries the channels on the version-exists row only", async () => {
  const versionExists = evaluateVersionExists({
    extensionName: "@test/ext",
    version: "2026.09.16.1",
    published: { version: "2026.09.16.1", channel: "beta" },
    requestedChannel: "stable",
  });
  const renderer = createExtensionPushRenderer("json");
  const logs = await capture(() =>
    renderer.renderDryRun({
      ...dryRunBase,
      registryChecks: [checks[0], versionExists],
      apiCalls: [],
    })
  );
  const parsed = JSON.parse(logs[0]);
  assertEquals(parsed.registryChecks[0], checks[0]);
  assertEquals(parsed.registryChecks[1], {
    name: "version-exists",
    status: "failed",
    message:
      "Version 2026.09.16.1 already exists for @test/ext on channel 'beta'. " +
      "To move it to 'stable' without re-publishing, run: " +
      "swamp extension promote @test/ext 2026.09.16.1 --channel stable",
    existingChannel: "beta",
    requestedChannel: "stable",
  });
});

Deno.test("extensionPushRenderer: log dry run names the existing channel on the version-exists row", async () => {
  const versionExists = evaluateVersionExists({
    extensionName: "@test/ext",
    version: "2026.09.16.1",
    published: { version: "2026.09.16.1", channel: "beta" },
    requestedChannel: "stable",
  });
  const renderer = createExtensionPushRenderer("log");
  const logs = await capture(() =>
    renderer.renderDryRun({
      ...dryRunBase,
      registryChecks: [versionExists],
      apiCalls: [],
    })
  );
  assertStringIncludes(
    stripAnsiCode(logs.join("\n")),
    "version exists: failed — Version 2026.09.16.1 already exists for @test/ext on channel 'beta'.",
  );
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
    'private entitlement: failed — Collective "@test" is on the Free plan and its trial ended on 2026-08-19. ' +
      "Private publication requires a paid plan; upgrade at https://swamp-club.com/o/test/billing.",
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

// ── Findings report: declared acceptances and For next time ───────────

const report: FindingsReport = {
  declaredAcceptances: {
    accepted: [{
      ruleId: "credentials-sensitive-field",
      file: "models/a.ts",
      line: 2,
      reason: "reference to a Secret, not a secret",
      source: "inline",
      message: "looks like a secret",
    }],
    generated: { by: "codegen", source: "spec.yaml", commit: "abc" },
  },
  forNextTime: [{
    ruleId: "deno-command",
    file: "models/b.ts",
    line: 9,
    message: "Line 9 uses Deno.Command() to spawn subprocesses.",
    remediation: "Prefer swamp's own primitives.",
    acceptance: "// swamp-quality-ignore deno-command: <reason>",
    placement: "on line 9 of models/b.ts, or the line above",
  }, {
    ruleId: "adversarial-review-report",
    file: "/tmp/review.json",
    message: "No adversarial review recorded",
    remediation: "Run the adversarial review.",
  }],
};

Deno.test("extensionPushRenderer: JSON dry run and completed documents carry declaredAcceptances and forNextTime beside acceptedWarnings", async () => {
  const renderer = createExtensionPushRenderer("json");
  const logs = await capture(async () => {
    renderer.renderDryRun({
      ...dryRunBase,
      accepted: { warnings: accepted, waivedBy: "--yes" },
      report,
    });
    await renderer.handlers({ report }).completed(completedEvent);
  });
  const dryRun = JSON.parse(logs[0]);
  assertEquals(dryRun.status, "dry_run");
  assertEquals(dryRun.acceptedWarnings, accepted);
  assertEquals(dryRun.declaredAcceptances, report.declaredAcceptances);
  assertEquals(dryRun.forNextTime, report.forNextTime);
  assertEquals(dryRun.forNextTime[1].acceptance, undefined);
  const completed = JSON.parse(logs[1]);
  assertEquals("acceptedWarnings" in completed, false);
  assertEquals(completed.declaredAcceptances, report.declaredAcceptances);
  assertEquals(completed.forNextTime, report.forNextTime);
});

Deno.test("extensionPushRenderer: JSON documents omit declaredAcceptances and forNextTime when the report is empty", async () => {
  const renderer = createExtensionPushRenderer("json");
  const logs = await capture(async () => {
    renderer.renderDryRun({ ...dryRunBase, report: {} });
    await renderer.handlers({ report: {} }).completed(completedEvent);
  });
  for (const doc of logs.map((l) => JSON.parse(l))) {
    assertEquals("declaredAcceptances" in doc, false);
    assertEquals("forNextTime" in doc, false);
  }
});

Deno.test("extensionPushRenderer: log dry run and completed summaries print the accepted and For next time blocks after the summary", async () => {
  const renderer = createExtensionPushRenderer("log");
  const logs = await capture(async () => {
    renderer.renderDryRun({ ...dryRunBase, report });
    await renderer.handlers({ report }).completed(completedEvent);
  });
  const output = logs.join("\n");
  const accepted = output.indexOf("Accepted, with reasons:");
  const next = output.indexOf("For next time:");
  assertEquals(accepted > output.indexOf("No API calls were made."), true);
  assertEquals(next > accepted, true);
  assertStringIncludes(output, "generated by codegen from spec.yaml at abc");
  assertStringIncludes(
    output,
    "credentials-sensitive-field — models/a.ts:2: reference to a Secret, not a secret",
  );
  assertStringIncludes(output, "deno-command — models/b.ts:9:");
  assertStringIncludes(output, "fix: Prefer swamp's own primitives.");
  assertStringIncludes(
    output,
    "or accept it, on line 9 of models/b.ts, or the line above:",
  );
  assertStringIncludes(
    output,
    "// swamp-quality-ignore deno-command: <reason>",
  );
  // The unacceptable finding has advice but no acceptance line.
  const reviewAt = output.indexOf(
    "adversarial-review-report — /tmp/review.json",
  );
  assertEquals(reviewAt > 0, true);
  const secondBlock = output.indexOf("For next time:", reviewAt);
  assertEquals(
    output.slice(reviewAt, secondBlock).includes("or accept it"),
    false,
  );
  // Printed twice: once for the dry run, once for the completed push.
  assertEquals(output.split("For next time:").length, 3);
});

Deno.test("extensionPushRenderer: log report prints braces in messages, remediation and reasons verbatim", async () => {
  const renderer = createExtensionPushRenderer("log");
  const braces: FindingsReport = {
    declaredAcceptances: {
      accepted: [{
        ruleId: "schema-strictness",
        file: "models/a.ts",
        line: 2,
        reason: "the {id} shape is validated by the {caller}",
        source: "inline",
        message: "Uses `z.object({}).passthrough()`",
      }],
    },
    forNextTime: [{
      ruleId: "credentials-sensitive-field",
      file: "models/b.ts",
      line: 4,
      message:
        'Field on line "z.object({ apiKey: z.string() })" looks like a secret',
      remediation: remediationFor("credentials-sensitive-field"),
      acceptance:
        "// swamp-quality-ignore credentials-sensitive-field: <reason>",
      placement: "on line 4 of models/b.ts, or the line above",
    }],
  };
  const logs = await capture(() =>
    renderer.renderDryRun({ ...dryRunBase, report: braces })
  );
  const output = logs.join("\n");
  assertStringIncludes(output, "the {id} shape is validated by the {caller}");
  assertStringIncludes(output, "z.object({ apiKey: z.string() })");
  assertStringIncludes(output, ".meta({ sensitive: true })");
  assertEquals(output.includes("undefined"), false);
});

/** A resolved extension with every list populated, in both label forms. */
function populated(): ExtensionPushResolvedData {
  return {
    ...resolved("default"),
    description: "First line\nSecond line with {braces}",
    repository: "https://example.com/ext",
    releaseNotes: "Fixed a thing",
    models: [{
      type: "@test/ext",
      fileName: join("extensions", "models", "m.ts"),
      globalArguments: [
        { name: "text", type: "string", required: true, description: "" },
        { name: "note", type: "string", required: false, description: "" },
      ],
    }],
    workflowFiles: [join("extensions", "workflows", "w.yaml")],
    vaults: [
      {
        type: "@test/vault",
        name: "Named",
        fileName: join("extensions", "vaults", "v.ts"),
        configFields: [{
          name: "token",
          type: "string",
          required: false,
          description: "",
        }],
      },
      { type: "@test/vault2", fileName: join("extensions", "vaults", "u.ts") },
    ],
    datastores: [{
      type: "@test/store",
      fileName: join("extensions", "datastores", "d.ts"),
      configFields: [{
        name: "bucket",
        type: "string",
        required: true,
        description: "",
      }],
    }],
    reports: [
      {
        name: "@test/ext/summary",
        scope: "method",
        fileName: join("extensions", "reports", "r.ts"),
      },
      {
        name: "@test/ext/plain",
        fileName: join("extensions", "reports", "p.ts"),
      },
    ],
    webhooks: [{
      type: "@test/hook",
      name: "Hook",
      fileName: join("extensions", "webhooks", "h.ts"),
    }],
    skills: [{ name: "ext-skill", fileCount: 2 }],
    additionalFiles: ["README.md"],
    platforms: ["linux"],
    labels: ["a", "b"],
    dependencies: ["@test/dep"],
  };
}

const skeleton = {
  extension: "@test/ext",
  version: "2026.09.16.1",
  reviewedAt: "<ISO-8601 timestamp>",
  dimensions: [{ id: "security", verdict: "pending" as const, note: "" }],
};

const reviewWarning = {
  ruleId: "adversarial-review-report",
  dimension: "Adversarial review",
  severity: "medium" as const,
  file: join(ROOT, "tmp", "swamp-extension-review", "r.json"),
  message: "No adversarial review recorded",
  skeleton,
};

const safetyWarning = {
  ruleId: "deno-command",
  file: join(PATHS.repoDir, "extensions", "models", "m.ts"),
  line: 3,
  message: "uses Deno.Command",
};

Deno.test("extensionPushRenderer: log output never prints adjacent or empty interpolations (swamp-club#3017, swamp-club#3118)", async () => {
  const renderer = createExtensionPushRenderer("log", PATHS);
  const logs = await capture(async () => {
    renderer.renderResolved(populated());
    renderer.renderReviewRuleWarnings([reviewWarning]);
    renderer.renderSafetyWarnings([safetyWarning]);
    renderer.renderDryRun({
      ...dryRunBase,
      accepted: { warnings: accepted, waivedBy: "--yes" },
    });
    await renderer.handlers().completed(completedEvent);
  });
  const output = logs.join("\n");
  assertEquals(output.includes('""'), false, output);
  // No LogTape string-concatenation continuation lines.
  assertEquals(logs.some((line) => line.trimEnd().endsWith('" +')), false);

  assertStringIncludes(output, 'Extension: "@test/ext@2026.09.16.1"');
  assertStringIncludes(output, '"text": "string"\n');
  assertStringIncludes(output, '"note": "string" (optional)');
  assertStringIncludes(output, '"token": "string" (optional)');
  assertStringIncludes(output, '"bucket": "string"\n');
  assertStringIncludes(output, '"@test/vault" - "Named" (');
  assertStringIncludes(output, '"@test/vault2" (');
  assertStringIncludes(output, '"@test/ext/summary" ["method"] (');
  assertStringIncludes(output, '"@test/ext/plain" (');
  assertStringIncludes(output, 'Dry run complete for "@test/ext@2026.09.16.1"');
  assertStringIncludes(output, 'Pushed "@test/ext@2026.09.16.1"');
});

Deno.test("extensionPushRenderer: log prints a multi-line description as plain lines, braces verbatim", async () => {
  const renderer = createExtensionPushRenderer("log", PATHS);
  const logs = await capture(() => renderer.renderResolved(populated()));
  const at = logs.findIndex((line) => line.endsWith("Description:"));
  assertEquals(at >= 0, true);
  assertEquals(logs[at + 1].endsWith("  First line"), true);
  assertEquals(logs[at + 2].endsWith("  Second line with {braces}"), true);
  // A single-line value stays on its label's line.
  assertStringIncludes(logs.join("\n"), 'Release Notes: "Fixed a thing"');
});

Deno.test("extensionPushRenderer: log prints quality output one plain line per line", async () => {
  const renderer = createExtensionPushRenderer("log", PATHS);
  const logs = await capture(() =>
    renderer.renderQualityErrors([{
      check: "lint",
      output:
        "error[require-await]: no await\n  --> a.ts:1:1\nFound 1 problem\n",
    }])
  );
  const output = logs.join("\n");
  assertEquals(logs.some((line) => line.trimEnd().endsWith('" +')), false);
  assertStringIncludes(output, "    error[require-await]: no await");
  assertStringIncludes(output, "      --> a.ts:1:1");
  assertStringIncludes(output, "    Found 1 problem");
});

Deno.test("extensionPushRenderer: log prints file paths relative to cwd, absolute when only the root is shared", async () => {
  const renderer = createExtensionPushRenderer("log", PATHS);
  const logs = await capture(() => {
    renderer.renderResolved(populated());
    renderer.renderReviewRuleWarnings([
      reviewWarning,
      { ...reviewWarning, ruleId: "x", file: "(manifest)" },
    ]);
    renderer.renderSafetyWarnings([safetyWarning]);
  });
  const output = logs.join("\n");
  const sibling = join("..", "repo", "extensions", "models", "m.ts");
  assertStringIncludes(output, `"@test/ext" (${JSON.stringify(sibling)})`);
  assertStringIncludes(output, `${JSON.stringify(`${sibling}:3`)}`);
  assertStringIncludes(output, JSON.stringify(join("..", "repo", "README.md")));
  // The review report lives under the temp dir: only the root is shared.
  assertStringIncludes(output, JSON.stringify(reviewWarning.file));
  // A pseudo-file is not a path and prints unchanged.
  assertStringIncludes(output, '"(manifest)"');
});

Deno.test("extensionPushRenderer: log hides the requested-visibility line below the log level", async () => {
  try {
    await initializeLogging({ logLevel: "error", _reset: true });
    const renderer = createExtensionPushRenderer("log", PATHS);
    const logs = await capture(() =>
      renderer.renderResolved(resolved("private"))
    );
    assertEquals(
      logs.some((line) => line.includes("Requested visibility")),
      false,
    );
  } finally {
    await initializeLogging({ _reset: true });
  }
});

Deno.test("extensionPushRenderer: JSON dry run is one document with resolved, warnings and status as fields", async () => {
  const renderer = createExtensionPushRenderer("json", PATHS);
  const logs = await capture(() => {
    renderer.renderResolved(populated());
    renderer.renderReviewRuleWarnings([reviewWarning]);
    renderer.renderSafetyWarnings([safetyWarning]);
    renderer.renderDependencyTrustWarnings([]);
    renderer.renderVersionDriftWarnings([{ check: "lint", output: "drift" }]);
    renderer.renderDryRun(dryRunBase);
  });
  assertEquals(logs.length, 1);
  const doc = JSON.parse(logs[0]);
  assertEquals(Object.keys(doc).slice(0, 3), [
    "status",
    "resolved",
    "warnings",
  ]);
  assertEquals(doc.status, "dry_run");
  // Empty families are omitted.
  assertEquals(Object.keys(doc.warnings), ["review", "safety", "versionDrift"]);
  // The skeleton is a nested object, and the finding keeps its file.
  assertEquals(doc.warnings.review[0].skeleton, skeleton);
  assertEquals(doc.warnings.review[0].file, reviewWarning.file);
  assertEquals(doc.warnings.safety[0], safetyWarning);
  // Resolved file names are absolute.
  assertEquals(
    doc.resolved.models[0].fileName,
    join(PATHS.repoDir, "extensions", "models", "m.ts"),
  );
  assertEquals(doc.resolved.workflowFiles, [
    join(PATHS.repoDir, "extensions", "workflows", "w.yaml"),
  ]);
  assertEquals(doc.resolved.additionalFiles, [
    join(PATHS.repoDir, "README.md"),
  ]);
});

Deno.test("extensionPushRenderer: JSON omits warnings when every family is empty", async () => {
  const renderer = createExtensionPushRenderer("json", PATHS);
  const logs = await capture(() => {
    renderer.renderResolved(resolved("default"));
    renderer.renderDryRun(dryRunBase);
  });
  assertEquals("warnings" in JSON.parse(logs[0]), false);
});

Deno.test("extensionPushRenderer: JSON push is one document with status pushed", async () => {
  const renderer = createExtensionPushRenderer("json", PATHS);
  const logs = await capture(async () => {
    renderer.renderResolved(resolved("default"));
    renderer.renderSafetyWarnings([safetyWarning]);
    await renderer.handlers().completed(completedEvent);
  });
  assertEquals(logs.length, 1);
  const doc = JSON.parse(logs[0]);
  assertEquals(doc.status, "pushed");
  assertEquals(doc.resolved.name, "@test/ext");
  assertEquals(doc.warnings.safety, [safetyWarning]);
  assertEquals(doc.extensionId, "ext-123");
});

Deno.test("extensionPushRenderer: JSON failed push writes its document, then throws", async () => {
  const renderer = createExtensionPushRenderer("json", PATHS);
  let thrown: unknown;
  const logs = await capture(async () => {
    renderer.renderResolved(resolved("default"));
    try {
      await renderer.handlers().error({
        kind: "error",
        error: { code: "push_failed", message: "upload refused" },
      });
    } catch (error) {
      thrown = error;
    }
  });
  assertEquals(logs.length, 1);
  const doc = JSON.parse(logs[0]);
  assertEquals(doc.status, "failed");
  assertEquals(doc.resolved.name, "@test/ext");
  assertEquals((thrown as Error).message, "upload refused");
});

Deno.test("extensionPushRenderer: JSON blocked prepare is one document naming the error family", async () => {
  for (
    const [render, family] of [
      [
        (r: ExtensionPushRenderer) => r.renderReviewRuleErrors([reviewWarning]),
        "review",
      ],
      [
        (r: ExtensionPushRenderer) => r.renderSafetyErrors([safetyWarning]),
        "safety",
      ],
      [
        (r: ExtensionPushRenderer) =>
          r.renderQualityErrors([{ check: "lint", output: "x" }]),
        "quality",
      ],
      [
        (r: ExtensionPushRenderer) =>
          r.renderUpgradeChainErrors([{ check: "lint", output: "x" }]),
        "upgradeChain",
      ],
      [
        (r: ExtensionPushRenderer) =>
          r.renderCompilationErrors([{ file: "a.ts", error: "x" }]),
        "compilation",
      ],
      [
        (r: ExtensionPushRenderer) => r.renderDependencyTrustErrors([]),
        "dependencyTrust",
      ],
      [
        (r: ExtensionPushRenderer) => r.renderCollectiveErrors("@test", []),
        "collective",
      ],
    ] as const
  ) {
    const renderer = createExtensionPushRenderer("json", PATHS);
    const logs = await capture(() => render(renderer));
    assertEquals(logs.length, 1, family);
    const doc = JSON.parse(logs[0]);
    assertEquals(doc.status, "blocked");
    assertEquals(Object.keys(doc.errors), [family]);
  }
});

Deno.test("extensionPushRenderer: log prints a file outside the pushed content absolute even when it shares more than the root with cwd", async () => {
  const renderer = createExtensionPushRenderer("log", PATHS);
  const report = join(ROOT, "home", "author", "tmp", "review.json");
  const logs = await capture(() =>
    renderer.renderReviewRuleWarnings([{ ...reviewWarning, file: report }])
  );
  assertStringIncludes(logs.join("\n"), JSON.stringify(report));
});

Deno.test("extensionPushRenderer: JSON renderUnfinished writes a failed document only when the run wrote none", async () => {
  const unfinished = createExtensionPushRenderer("json", PATHS);
  const logs = await capture(() => {
    unfinished.renderResolved(resolved("default"));
    unfinished.renderSafetyWarnings([safetyWarning]);
    unfinished.renderUnfinished();
  });
  assertEquals(logs.length, 1);
  const doc = JSON.parse(logs[0]);
  assertEquals(doc.status, "failed");
  assertEquals(doc.resolved.name, "@test/ext");
  assertEquals(doc.warnings.safety, [safetyWarning]);

  const finished = createExtensionPushRenderer("json", PATHS);
  const after = await capture(() => {
    finished.renderDryRun(dryRunBase);
    finished.renderUnfinished();
  });
  assertEquals(after.length, 1);
  assertEquals(JSON.parse(after[0]).status, "dry_run");
});

Deno.test("extensionPushRenderer: log renderUnfinished prints nothing", async () => {
  const renderer = createExtensionPushRenderer("log", PATHS);
  const logs = await capture(() => renderer.renderUnfinished());
  assertEquals(logs, []);
});
