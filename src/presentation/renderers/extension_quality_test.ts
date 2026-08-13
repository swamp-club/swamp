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

import { assertEquals, assertThrows } from "@std/assert";
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
