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
import type {
  DependencyTrustResult,
} from "@swamp-club/extension-scoring/dependency-audit";
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
    docAnalysisError: null,
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
      license: "MIT",
      licenseWarning: undefined,
      cacheHash: "abc123",
      archiveSize: 1024,
      cacheHit: false,
      dependencyTrustResult: emptyTrustResult,
      findings: {
        safetyWarnings: [],
        reviewRulesResult: { errors: [], warnings: [], passed: true },
        acceptances: { accepted: [] },
        commentSites: {},
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
    const logs = capture(() =>
      renderer.handlers().completed(
        completedEvent(makeScore({ allPassed: false })),
      )
    );

    assertEquals(renderer.passed(), true);
    // A missing factor costs points but fails no check: `status` follows
    // the exit code, `allPassed` reports the rubric (swamp-club#3464).
    const doc = JSON.parse(logs[0]);
    assertEquals(doc.status, "passed");
    assertEquals(doc.allPassed, false);
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
            message: "Extension has behavior upgrade chain errors",
          },
        }),
      UserError,
      "Extension has behavior upgrade chain errors",
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
    commentSites: {
      [join(manifestDir, "models", "b.ts")]: { 9: "  " },
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
    position: "line-above",
    text: "  // swamp-quality-ignore deno-command",
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
    "or accept on the line above: // swamp-quality-ignore deno-command",
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

Deno.test("createExtensionQualityRenderer: a bundle failure prints each compilation error before the error, in log and JSON", () => {
  const manifestDir = resolve("/ext");
  const error = {
    kind: "error" as const,
    error: {
      code: "validation_failed",
      message: "Bundle compilation failed. Fix the errors above and try again.",
      details: {
        compilationErrors: [
          {
            file: join(manifestDir, "models", "a.ts"),
            error: 'Module not found "file:///ext/lib/gone.ts".',
          },
          {
            file: join(manifestDir, "models", "b.ts"),
            error: "first line\nsecond line",
          },
        ],
      },
    },
  } as unknown as Extract<ExtensionQualityEvent, { kind: "error" }>;

  let thrown: unknown;
  const log = capture(() => {
    try {
      createExtensionQualityRenderer("log").handlers({
        manifestDir,
        cwd: manifestDir,
      }).error(error);
    } catch (e) {
      thrown = e;
    }
  });
  assert(thrown instanceof UserError);
  const text = log.join("\n");
  assertStringIncludes(text, "Bundle compilation failed:");
  // Paths print openable from cwd, the way push prints them.
  assertStringIncludes(text, "models");
  assertEquals(text.includes(manifestDir + "/models"), false);
  assertStringIncludes(text, 'Module not found "file:///ext/lib/gone.ts".');
  assertStringIncludes(text, "    first line");
  assertStringIncludes(text, "    second line");

  const json = capture(() => {
    try {
      createExtensionQualityRenderer("json").handlers({ manifestDir })
        .error(error);
    } catch {
      // The run fails after the details print.
    }
  });
  assertEquals(
    JSON.parse(json[0]).compilationErrors,
    (error.error.details as { compilationErrors: unknown }).compilationErrors,
  );
});

Deno.test("createExtensionQualityRenderer: the not-audited block says re-run only when every dependency is down to an outage", () => {
  const manifestDir = resolve("/ext");
  const finding = (dependency: string, fix: "outage" | "specifier") => ({
    dependency,
    message: `not audited: ${fix}`,
    cause: "not-audited" as const,
    notAuditedFix: fix,
  });
  for (
    const [warnings, header] of [
      [
        [finding("a", "outage")],
        "Dependencies not audited (re-run when OSV, npm and JSR are reachable):",
      ],
      [[finding("ms", "specifier")], "Dependencies not audited:"],
      [
        [finding("a", "outage"), finding("ms", "specifier")],
        "Dependencies not audited:",
      ],
    ] as const
  ) {
    const trust: DependencyTrustResult = {
      ...emptyTrustResult,
      warnings: [...warnings],
    };
    const log = capture(() =>
      createExtensionQualityRenderer("log").handlers({
        manifestDir,
        cwd: manifestDir,
      }).completed(
        completedEvent(makeScore(), { dependencyTrustResult: trust }),
      )
    ).join("\n");
    assertStringIncludes(log, header);
    assertEquals(
      log.includes("reachable"),
      header.includes("reachable"),
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
  assertStringIncludes(
    thrown.message,
    "the registry cannot resolve its bare imports",
  );
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
  assertStringIncludes(
    logs.join("\n"),
    "would score the documentation factors 0",
  );
});

const BARE_ZOD_DOC_ERROR =
  'The registry cannot resolve the bare import "zod"; use an explicit npm: or jsr: specifier (npm:zod@4 for zod).';

Deno.test("createExtensionQualityRenderer: a deno doc failure prints after the rubric and fails, with one reason when bare imports explain it", () => {
  const renderer = createExtensionQualityRenderer("log");
  let thrown: unknown;
  const logs = capture(() => {
    try {
      renderer.handlers().completed(
        completedEvent(makeScore({ docAnalysisError: BARE_ZOD_DOC_ERROR }), {
          registryScorable: false,
        }),
      );
    } catch (e) {
      thrown = e;
    }
  });
  const output = logs.join("\n");
  const rubricAt = output.indexOf("Rubric v3");
  const docAt = output.indexOf(
    "deno doc could not analyse this extension's source, so the documentation factors score 0:",
  );
  assert(rubricAt >= 0 && docAt > rubricAt, output);
  assertStringIncludes(output, BARE_ZOD_DOC_ERROR);
  assert(thrown instanceof UserError);
  assertStringIncludes(thrown.message, "bare imports");
  assertEquals(thrown.message.includes("deno doc"), false, thrown.message);
});

Deno.test("createExtensionQualityRenderer: a deno doc failure with no bare imports to explain it fails on its own", () => {
  const renderer = createExtensionQualityRenderer("json");
  let thrown: unknown;
  const logs = capture(() => {
    try {
      renderer.handlers().completed(
        completedEvent(
          makeScore({
            allPassed: true,
            docAnalysisError:
              "Not in the published archive: models/_lib/gone.ts.",
          }),
        ),
      );
    } catch (e) {
      thrown = e;
    }
  });
  assert(thrown instanceof UserError);
  assertEquals(
    thrown.message,
    "Extension quality failed: deno doc could not analyse the source the registry would score.",
  );
  const doc = JSON.parse(logs[0]);
  assertEquals(doc.status, "failed");
  assertEquals(
    doc.docAnalysisError,
    "Not in the published archive: models/_lib/gone.ts.",
  );
});

Deno.test("createExtensionQualityRenderer: json docAnalysisError is null when deno doc succeeded", () => {
  const renderer = createExtensionQualityRenderer("json");
  const logs = capture(() =>
    renderer.handlers().completed(completedEvent(makeScore()))
  );
  assertEquals(JSON.parse(logs[0]).docAnalysisError, null);
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

Deno.test("createExtensionQualityRenderer: json status is failed when the rubric passes but a check would block a push", () => {
  const renderer = createExtensionQualityRenderer("json");
  let thrown: unknown;
  const logs = capture(() => {
    try {
      renderer.handlers({ manifestDir: resolve("/ext") }).completed(
        completedEvent(makeScore({ allPassed: true }), {
          gateFailures: [SAFETY_FAILURE],
        }),
      );
    } catch (e) {
      thrown = e;
    }
  });
  assert(thrown instanceof UserError);
  assertEquals(renderer.passed(), false);
  const doc = JSON.parse(logs[0]);
  assertEquals(doc.allPassed, true);
  assertEquals(doc.registryScorable, true);
  assertEquals(doc.status, "failed");
});

for (const license of ["MIT", null]) {
  Deno.test(`createExtensionQualityRenderer: the declared license (${license}) is in log and JSON`, () => {
    const manifestDir = resolve("/ext");
    const json = capture(() =>
      createExtensionQualityRenderer("json").handlers({ manifestDir })
        .completed(completedEvent(makeScore(), { license }))
    );
    assertEquals(JSON.parse(json[0]).license, license);
    const log = capture(() =>
      createExtensionQualityRenderer("log").handlers({
        manifestDir,
        cwd: manifestDir,
      }).completed(completedEvent(makeScore(), { license }))
    ).join("\n");
    assertStringIncludes(
      log,
      license === null ? "License: none declared" : `License: "${license}"`,
    );
  });
}

Deno.test("createExtensionQualityRenderer: a non-SPDX license warns in log and JSON and does not fail the run", () => {
  const manifestDir = resolve("/ext");
  const licenseWarning = {
    license: "LicenseRef-Mine",
    reason: "custom-ref" as const,
    term: "LicenseRef-Mine",
    message:
      'License "LicenseRef-Mine" in manifest.yaml is not a valid SPDX expression, so it earns no quality points: "LicenseRef-Mine" is a custom reference, not an SPDX identifier; only SPDX ids count.',
    violations: [],
  };
  const score = makeScore({ allPassed: true });
  const json = capture(() =>
    createExtensionQualityRenderer("json").handlers({ manifestDir })
      .completed(
        completedEvent(score, { license: "LicenseRef-Mine", licenseWarning }),
      )
  );
  const doc = JSON.parse(json[0]);
  assertEquals(doc.status, "passed");
  assertEquals(doc.licenseWarnings, [licenseWarning]);
  assertEquals(doc.gateFailures, []);
  const log = capture(() =>
    createExtensionQualityRenderer("log").handlers({
      manifestDir,
      cwd: manifestDir,
    }).completed(
      completedEvent(score, { license: "LicenseRef-Mine", licenseWarning }),
    )
  ).join("\n");
  assertStringIncludes(log, "is not a valid SPDX expression");
});

Deno.test("createExtensionQualityRenderer: JSON carries an empty licenseWarnings when the license is fine", () => {
  const json = capture(() =>
    createExtensionQualityRenderer("json").handlers({
      manifestDir: resolve("/ext"),
    }).completed(completedEvent(makeScore()))
  );
  assertEquals(JSON.parse(json[0]).licenseWarnings, []);
});

Deno.test("createExtensionQualityRenderer: an unaudited dependency is marked ? with its reason in log and carries cause and reason in JSON", () => {
  const manifestDir = resolve("/ext");
  const reason = "OSV lookup failed (HTTP 503)";
  const trust: DependencyTrustResult = {
    passed: true,
    errors: [],
    warnings: [
      { dependency: "tiny", message: "low weekly downloads (10 < 1000)" },
      {
        dependency: "leftpad",
        message: `not audited: ${reason}`,
        cause: "not-audited",
        notAuditedFix: "outage",
      },
    ],
    audited: [{
      name: "leftpad",
      specifier: "npm:leftpad@1.3.0",
      version: "1.3.0",
      registry: "npm",
      license: "MIT",
      weeklyDownloads: null,
      publishedAgo: null,
      passed: false,
      cause: "not-audited",
      reason,
    }],
  };
  const event = completedEvent(makeScore(), { dependencyTrustResult: trust });

  const log = capture(() =>
    createExtensionQualityRenderer("log").handlers({
      manifestDir,
      cwd: manifestDir,
    }).completed(event)
  ).join("\n");
  // Each interpolation renders quoted: the mark, then the dependency.
  assertStringIncludes(log, '"?" "leftpad"@"1.3.0"');
  assertStringIncludes(log, `MIT, not audited: ${reason}`);
  const notAuditedAt = log.indexOf(
    "Dependencies not audited (re-run when OSV, npm and JSR are reachable):",
  );
  const advisoryAt = log.indexOf("Dependency trust warnings (non-blocking):");
  assertEquals(notAuditedAt >= 0 && advisoryAt > notAuditedAt, true);
  assertEquals(
    log.slice(notAuditedAt, advisoryAt).includes("low weekly downloads"),
    false,
  );

  const doc = JSON.parse(
    capture(() =>
      createExtensionQualityRenderer("json").handlers({ manifestDir })
        .completed(event)
    )[0],
  );
  assertEquals(doc.dependencyTrust.audited[0].passed, false);
  assertEquals(doc.dependencyTrust.audited[0].cause, "not-audited");
  assertEquals(doc.dependencyTrust.audited[0].reason, reason);
  assertEquals(doc.dependencyTrust.warnings[1].cause, "not-audited");
});

Deno.test("createExtensionQualityRenderer: an audited dependency a bare import reached names that import in log mode", () => {
  const manifestDir = resolve("/ext");
  const trust: DependencyTrustResult = {
    passed: true,
    errors: [],
    warnings: [],
    audited: [{
      name: "@types/uuid",
      specifier: "npm:@types/uuid@10.0.0",
      importedAs: "uuid-types",
      version: "10.0.0",
      registry: "npm",
      license: "MIT",
      weeklyDownloads: null,
      publishedAgo: null,
      passed: true,
    }, {
      name: "ms",
      specifier: "npm:ms@2.1.3",
      version: "2.1.3",
      registry: "npm",
      license: "MIT",
      weeklyDownloads: null,
      publishedAgo: null,
      passed: true,
    }],
  };
  const log = capture(() =>
    createExtensionQualityRenderer("log").handlers({
      manifestDir,
      cwd: manifestDir,
    }).completed(completedEvent(makeScore(), { dependencyTrustResult: trust }))
  ).join("\n");
  assertStringIncludes(log, '"✓" "@types/uuid"@"10.0.0" (as "uuid-types")');
  assertStringIncludes(log, '"✓" "ms"@"2.1.3"');
  assertEquals(log.includes('"ms"@"2.1.3" (as'), false);
});

Deno.test("createExtensionQualityRenderer: json never prints the shipped versions the archive records (swamp-club#3662)", () => {
  const specifier = {
    name: "ms",
    version: "^2.0.0",
    registry: "npm" as const,
    sourceFile: "models/a.ts",
  };
  const event = completedEvent(makeScore(), {
    dependencyTrustResult: {
      ...emptyTrustResult,
      shipped: [{ specifier, shipped: { version: "2.1.0", from: "lockfile" } }],
    },
  });
  const doc = JSON.parse(
    capture(() =>
      createExtensionQualityRenderer("json").handlers().completed(event)
    )[0],
  );
  assertEquals(Object.keys(doc.dependencyTrust).sort(), [
    "audited",
    "errors",
    "passed",
    "warnings",
  ]);
});
