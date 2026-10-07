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
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import type {
  ExtensionQualityData,
  ExtensionQualityEvent,
} from "../../libswamp/extensions/quality.ts";
import type { LocalGateFailure } from "../../libswamp/extensions/push.ts";
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
  overrides: Partial<ExtensionQualityData> = {},
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
      gateFailures: [],
      excludedFromArchive: [],
      registryScorable: true,
      ...overrides,
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

Deno.test("createExtensionQualityRenderer: json completed carries the warnings with their acceptance, declaredAcceptances and unresolvedWarnings", () => {
  const manifestDir = resolve("/ext");
  const renderer = createExtensionQualityRenderer("json");
  const logs = capture(() =>
    renderer.handlers({ manifestDir }).completed(
      completedWithFindings(manifestDir),
    )
  );
  const doc = JSON.parse(logs[0]);
  const modelB = join(manifestDir, "models", "b.ts");
  assertEquals(doc.warnings.length, 1);
  assertEquals(doc.warnings[0].acceptance, {
    form: "comment",
    file: modelB,
    line: 9,
    position: "same-line",
    text: "// swamp-quality-ignore deno-command",
  });
  assertEquals(doc.reviewRuleWarnings[0].ruleId, "stale-acceptance");
  assertEquals("acceptance" in doc.reviewRuleWarnings[0], false);
  assertEquals(
    doc.declaredAcceptances.accepted[0].reason,
    "reference to a Secret",
  );
  assertEquals("forNextTime" in doc, false);
  assertEquals(doc.unresolvedWarnings.map((e: { file: string }) => e.file), [
    modelB,
    join(manifestDir, "models", "a.ts"),
  ]);
  assertEquals(doc.unresolvedWarnings[0].remediation, "prefer primitives");
  assertEquals(
    doc.unresolvedWarnings[0].acceptance,
    doc.warnings[0].acceptance,
  );
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
  assertEquals("unresolvedWarnings" in doc, false);
});

Deno.test("createExtensionQualityRenderer: log completed prints the accepted and unresolved blocks, paths openable from cwd", () => {
  const manifestDir = resolve("/ext");
  const renderer = createExtensionQualityRenderer("log");
  const logs = capture(() =>
    renderer.handlers({ manifestDir, cwd: manifestDir }).completed(
      completedWithFindings(manifestDir),
    )
  );
  const output = logs.join("\n");
  const a = join("models", "a.ts");
  assertStringIncludes(output, "Accepted warnings:");
  assertStringIncludes(
    output,
    `credentials-sensitive-field — ${a}:4: reference to a Secret`,
  );
  assertStringIncludes(output, "Unresolved warnings:");
  assertEquals(output.includes("For next time:"), false);
  assertStringIncludes(output, `deno-command — ${join("models", "b.ts")}:9:`);
  assertStringIncludes(
    output,
    "or accept on the line: // swamp-quality-ignore deno-command",
  );
  assertStringIncludes(output, `stale-acceptance — ${a}:2:`);
});

Deno.test("createExtensionQualityRenderer: a failed run names the invalid acceptance before the error, in log and JSON", () => {
  const error = {
    kind: "error" as const,
    error: {
      code: "validation_failed",
      message:
        "Extension review found issues that must be resolved before pushing.",
      details: {
        reviewRuleErrors: [{
          ruleId: "invalid-acceptance",
          dimension: "Declared acceptances",
          severity: "high",
          file: "/ext/models/a.ts",
          line: 4,
          message:
            'Acceptance "// swamp-quality-ignore dynamic-code: x" is invalid: cannot be accepted.',
        }],
      },
    },
  } as unknown as Extract<ExtensionQualityEvent, { kind: "error" }>;
  for (const mode of ["log", "json"] as const) {
    const renderer = createExtensionQualityRenderer(mode);
    let thrown: unknown;
    const logs = capture(() => {
      try {
        renderer.handlers({ manifestDir: resolve("/ext") }).error(error);
      } catch (e) {
        thrown = e;
      }
    });
    assert(thrown instanceof UserError, mode);
    const output = logs.join("\n");
    assertStringIncludes(output, "invalid-acceptance", mode);
    assertStringIncludes(output, "swamp-quality-ignore dynamic-code", mode);
    assertStringIncludes(
      output,
      mode === "log" ? "/ext/models/a.ts:4" : '"line": 4',
      mode,
    );
  }
});

const SAFETY_FAILURE: LocalGateFailure = {
  gate: "safety",
  message: "Extension has safety errors that must be resolved before pushing.",
  details: {
    safetyErrors: [{
      ruleId: "hidden-file",
      file: "/ext/files/.notes.md",
      message: "Hidden files are not allowed in extensions.",
    }],
  },
};

Deno.test("createExtensionQualityRenderer: log prints the rubric, then every failed check with its details, then fails", () => {
  const renderer = createExtensionQualityRenderer("log");
  let thrown: unknown;
  const logs = capture(() => {
    try {
      renderer.handlers({ manifestDir: resolve("/ext") }).completed(
        completedEvent(makeScore(), {
          gateFailures: [SAFETY_FAILURE],
          excludedFromArchive: ["/ext/files/.notes.md"],
        }),
      );
    } catch (e) {
      thrown = e;
    }
  });
  assert(thrown instanceof UserError);
  assertStringIncludes(thrown.message, "would block a push (safety)");
  assertEquals(renderer.passed(), false);
  const output = logs.join("\n");
  const rubricAt = output.indexOf("Rubric v3");
  const gatesAt = output.indexOf("Checks that would block a push:");
  assert(rubricAt >= 0 && gatesAt > rubricAt, output);
  assertStringIncludes(output, "/ext/files/.notes.md: Hidden files");
  assertStringIncludes(output, "without the 1 file(s) a check rejected");
});

Deno.test("createExtensionQualityRenderer: json carries the rubric, gateFailures and registryScorable in one document, then fails", () => {
  const renderer = createExtensionQualityRenderer("json");
  let thrown: unknown;
  const logs = capture(() => {
    try {
      renderer.handlers({ manifestDir: resolve("/ext") }).completed(
        completedEvent(makeScore(), {
          gateFailures: [SAFETY_FAILURE],
          registryScorable: false,
        }),
      );
    } catch (e) {
      thrown = e;
    }
  });
  assert(thrown instanceof UserError);
  assertStringIncludes(thrown.message, "cannot score this extension");
  assertEquals(logs.length, 1);
  const doc = JSON.parse(logs[0]);
  assertEquals(doc.rubricVersion, 3);
  assertEquals(doc.status, "failed");
  assertEquals(doc.registryScorable, false);
  assertEquals(doc.gateFailures[0].gate, "safety");
  assertEquals(
    doc.gateFailures[0].details.safetyErrors[0].ruleId,
    "hidden-file",
  );
});

Deno.test("createExtensionQualityRenderer: an unscorable extension fails in log mode even with every check passing", () => {
  const renderer = createExtensionQualityRenderer("log");
  let thrown: unknown;
  const logs = capture(() => {
    try {
      renderer.handlers().completed(
        completedEvent(makeScore(), { registryScorable: false }),
      );
    } catch (e) {
      thrown = e;
    }
  });
  assert(thrown instanceof UserError);
  assertStringIncludes(logs.join("\n"), "would publish unscored");
});

Deno.test("createExtensionQualityRenderer: json status is failed when the rubric passes but the registry cannot score the extension", () => {
  const renderer = createExtensionQualityRenderer("json");
  const logs = capture(() => {
    try {
      renderer.handlers().completed(
        completedEvent(makeScore({ allPassed: true }), {
          registryScorable: false,
        }),
      );
    } catch {
      // The run fails; the document is what is under test.
    }
  });
  const doc = JSON.parse(logs[0]);
  assertEquals(doc.allPassed, true);
  assertEquals(doc.status, "failed");
});
