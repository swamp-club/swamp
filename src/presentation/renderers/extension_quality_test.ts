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

import { stripAnsiCode } from "@std/fmt/colors";
import { join, resolve } from "@std/path";
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type { ExtensionQualityEvent } from "../../libswamp/mod.ts";
import type { RubricScore } from "../../domain/extensions/extension_rubric_scorer.ts";
import type { DependencyTrustResult } from "../../domain/extensions/extension_dependency_trust_checker.ts";
import { UserError } from "../../domain/errors.ts";
import { createExtensionQualityRenderer } from "./extension_quality.ts";

await initializeLogging({});

function makeScore(overrides: Partial<RubricScore> = {}): RubricScore {
  return {
    rubricVersion: 3,
    factors: [
      {
        id: "has-readme",
        label: "Has README or module doc",
        earnedPoints: 2,
        maxPoints: 2,
        status: "earned",
      },
      {
        id: "symbols-docs",
        label: "Most symbols documented",
        earnedPoints: 0,
        maxPoints: 1,
        status: "missing",
        remediation: "Add JSDoc to >=80% of exported symbols.",
      },
    ],
    earnedPoints: 12,
    maxEarnablePoints: 14,
    maxClientEarnablePoints: 12,
    provisionalPoints: 2,
    percentage: 100,
    allPassed: false,
    ...overrides,
  };
}

const emptyTrustResult: DependencyTrustResult = {
  passed: true,
  audited: [],
  errors: [],
  warnings: [],
};

function completedEvent(
  score: RubricScore,
): Extract<ExtensionQualityEvent, { kind: "completed" }> {
  return {
    kind: "completed",
    data: {
      score,
      cacheHash: "abc123",
      archiveSize: 1024,
      cacheHit: false,
      dependencyTrustResult: emptyTrustResult,
      findings: {
        safetyWarnings: [],
        reviewRulesResult: { errors: [], warnings: [], passed: true },
        acceptances: { accepted: [] },
      },
    },
  };
}

Deno.test(
  "createExtensionQualityRenderer: json completed with allPassed=false reports passed",
  () => {
    const renderer = createExtensionQualityRenderer("json");
    const handlers = renderer.handlers();

    const originalLog = console.log;
    console.log = () => {};
    try {
      handlers.completed(completedEvent(makeScore({ allPassed: false })));
    } finally {
      console.log = originalLog;
    }

    assertEquals(renderer.passed(), true);
  },
);

Deno.test(
  "createExtensionQualityRenderer: json completed with allPassed=true reports passed",
  () => {
    const renderer = createExtensionQualityRenderer("json");
    const handlers = renderer.handlers();

    const originalLog = console.log;
    console.log = () => {};
    try {
      handlers.completed(completedEvent(makeScore({ allPassed: true })));
    } finally {
      console.log = originalLog;
    }

    assertEquals(renderer.passed(), true);
  },
);

Deno.test(
  "createExtensionQualityRenderer: json error throws UserError",
  () => {
    const renderer = createExtensionQualityRenderer("json");
    const handlers = renderer.handlers();

    assertThrows(
      () =>
        handlers.error({
          kind: "error",
          error: {
            code: "quality_failed",
            message: "Extension has model upgrade chain errors",
          },
        }),
      UserError,
      "Extension has model upgrade chain errors",
    );
  },
);

Deno.test(
  "createExtensionQualityRenderer: log completed with allPassed=false reports passed",
  () => {
    const renderer = createExtensionQualityRenderer("log");
    const handlers = renderer.handlers();

    handlers.completed(completedEvent(makeScore({ allPassed: false })));

    assertEquals(renderer.passed(), true);
  },
);

Deno.test(
  "createExtensionQualityRenderer: log error throws UserError",
  () => {
    const renderer = createExtensionQualityRenderer("log");
    const handlers = renderer.handlers();

    assertThrows(
      () =>
        handlers.error({
          kind: "error",
          error: {
            code: "quality_failed",
            message: "Bundle compilation failed",
          },
        }),
      UserError,
      "Bundle compilation failed",
    );
  },
);

// ── Findings report ───────────────────────────────────────────────────

function capture(run: () => void): string[] {
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
  try {
    run();
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
  }
  return logs;
}

function completedWithFindings(
  manifestDir: string,
): Extract<ExtensionQualityEvent, { kind: "completed" }> {
  const event = completedEvent(makeScore());
  event.data.findings = {
    safetyWarnings: [{
      ruleId: "deno-command",
      file: join(manifestDir, "models", "b.ts"),
      line: 9,
      message: "Line 9 uses Deno.Command() to spawn subprocesses.",
      remediation: "prefer primitives",
    }],
    reviewRulesResult: {
      errors: [],
      warnings: [{
        ruleId: "stale-acceptance",
        dimension: "Declared acceptances",
        severity: "medium",
        file: join(manifestDir, "models", "a.ts"),
        line: 2,
        message: "Acceptance of deno-command matches nothing",
        remediation: "remove it",
      }],
      passed: true,
    },
    acceptances: {
      accepted: [{
        ruleId: "credentials-sensitive-field",
        file: "models/a.ts",
        line: 4,
        reason: "reference to a Secret",
        source: "inline",
        message: "looks like a secret",
      }],
    },
  };
  return event;
}

Deno.test("createExtensionQualityRenderer: json completed carries the warnings with paste text, declaredAcceptances and forNextTime", () => {
  const manifestDir = resolve("/ext");
  const renderer = createExtensionQualityRenderer("json");
  const logs = capture(() =>
    renderer.handlers({ manifestDir }).completed(
      completedWithFindings(manifestDir),
    )
  );
  const doc = JSON.parse(logs[0]);
  assertEquals(doc.warnings.length, 1);
  assertEquals(
    doc.warnings[0].acceptance,
    "// swamp-quality-ignore deno-command: <reason>",
  );
  assertEquals(doc.reviewRuleWarnings[0].ruleId, "stale-acceptance");
  assertEquals("acceptance" in doc.reviewRuleWarnings[0], false);
  assertEquals(
    doc.declaredAcceptances.accepted[0].reason,
    "reference to a Secret",
  );
  assertEquals(doc.forNextTime.map((e: { file: string }) => e.file), [
    "models/b.ts",
    "models/a.ts",
  ]);
  assertEquals(doc.forNextTime[0].remediation, "prefer primitives");
});

Deno.test("createExtensionQualityRenderer: json completed omits the report fields when there is nothing to report", () => {
  const renderer = createExtensionQualityRenderer("json");
  const logs = capture(() =>
    renderer.handlers({ manifestDir: resolve("/ext") }).completed(
      completedEvent(makeScore()),
    )
  );
  const doc = JSON.parse(logs[0]);
  assertEquals(doc.warnings, []);
  assertEquals(doc.reviewRuleWarnings, []);
  assertEquals("declaredAcceptances" in doc, false);
  assertEquals("forNextTime" in doc, false);
});

Deno.test("createExtensionQualityRenderer: log completed prints the accepted and For next time blocks", () => {
  const manifestDir = resolve("/ext");
  const renderer = createExtensionQualityRenderer("log");
  const logs = capture(() =>
    renderer.handlers({ manifestDir }).completed(
      completedWithFindings(manifestDir),
    )
  );
  const output = logs.join("\n");
  assertStringIncludes(output, "Accepted, with reasons:");
  assertStringIncludes(
    output,
    "credentials-sensitive-field — models/a.ts:4: reference to a Secret",
  );
  assertStringIncludes(output, "For next time:");
  assertStringIncludes(output, "deno-command — models/b.ts:9:");
  assertStringIncludes(
    output,
    "// swamp-quality-ignore deno-command: <reason>",
  );
  assertStringIncludes(output, "stale-acceptance — models/a.ts:2:");
});
