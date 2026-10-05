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
import type { OutputMode } from "../../presentation/output/output.ts";
import {
  buildAcceptedWarnings,
  resolveWarningsGate,
} from "./extension_push.ts";

const tty = () => true;
const noTty = () => false;

function gate(overrides: {
  warningCount?: number;
  acceptWarnings?: boolean;
  dryRun?: boolean;
  outputMode?: OutputMode;
  stdinIsTty?: () => boolean;
}) {
  return resolveWarningsGate({
    warningCount: 1,
    acceptWarnings: false,
    dryRun: false,
    outputMode: "log",
    stdinIsTty: tty,
    ...overrides,
  });
}

Deno.test("resolveWarningsGate: json dry-run with a warning and no flag refuses and names --accept-warnings", () => {
  const decision = gate({ dryRun: true, outputMode: "json" });
  assertEquals(decision.kind, "refuse");
  if (decision.kind !== "refuse") throw new Error("unreachable");
  assertStringIncludes(decision.message, "--accept-warnings");
  assertStringIncludes(decision.message, "1 warning that");
});

Deno.test("resolveWarningsGate: json dry-run with --accept-warnings proceeds and records acceptance", () => {
  assertEquals(
    gate({ dryRun: true, outputMode: "json", acceptWarnings: true }),
    { kind: "proceed", accepted: true, hint: false },
  );
});

Deno.test("resolveWarningsGate: json push with --accept-warnings proceeds and records acceptance", () => {
  assertEquals(
    gate({ outputMode: "json", acceptWarnings: true, warningCount: 3 }),
    { kind: "proceed", accepted: true, hint: false },
  );
});

Deno.test("resolveWarningsGate: interactive push with a warning prompts; --yes is not an input to the gate", () => {
  // --yes confirms the push prompt only. The gate has no notion of it, so an
  // interactive run that passes --yes still reaches the warnings prompt.
  assertEquals(gate({}), { kind: "prompt" });
});

Deno.test("resolveWarningsGate: interactive push with --accept-warnings skips the warnings prompt", () => {
  assertEquals(
    gate({ acceptWarnings: true }),
    { kind: "proceed", accepted: true, hint: false },
  );
});

Deno.test("resolveWarningsGate: no warnings proceeds without prompting in every mode", () => {
  for (const outputMode of ["log", "json"] as const) {
    for (const stdinIsTty of [tty, noTty]) {
      for (const dryRun of [true, false]) {
        assertEquals(
          gate({ warningCount: 0, outputMode, stdinIsTty, dryRun }),
          { kind: "proceed", accepted: false, hint: false },
        );
      }
    }
  }
});

Deno.test("resolveWarningsGate: log mode without a terminal refuses like --json", () => {
  const decision = gate({ stdinIsTty: noTty, warningCount: 2 });
  assertEquals(decision.kind, "refuse");
  if (decision.kind !== "refuse") throw new Error("unreachable");
  assertStringIncludes(decision.message, "2 warnings that");
  assertStringIncludes(decision.message, "--accept-warnings");
});

Deno.test("resolveWarningsGate: --accept-warnings proceeds without a terminal", () => {
  assertEquals(
    gate({ stdinIsTty: noTty, acceptWarnings: true }),
    { kind: "proceed", accepted: true, hint: false },
  );
});

Deno.test("resolveWarningsGate: interactive dry-run proceeds with a hint instead of a prompt", () => {
  assertEquals(
    gate({ dryRun: true }),
    { kind: "proceed", accepted: false, hint: true },
  );
});

Deno.test("resolveWarningsGate: interactive dry-run with --accept-warnings records acceptance and skips the hint", () => {
  assertEquals(
    gate({ dryRun: true, acceptWarnings: true }),
    { kind: "proceed", accepted: true, hint: false },
  );
});

Deno.test("buildAcceptedWarnings: keeps safety warnings and drops the review skeleton", () => {
  const record = buildAcceptedWarnings({
    safetyWarnings: [{ file: "models/a.ts", message: "uses Deno.Command" }],
    reviewRulesResult: {
      warnings: [
        {
          ruleId: "adversarial-review-report",
          dimension: "review",
          severity: "high",
          file: "manifest.yaml",
          message: "No adversarial review recorded",
          skeleton: '{"dimensions":[]}',
        },
        {
          ruleId: "bare-specifiers",
          dimension: "scoring",
          severity: "medium",
          file: "(multiple files)",
          message: "Extension uses bare import specifiers",
        },
      ],
    },
  });
  assertEquals(record, {
    safety: [{ file: "models/a.ts", message: "uses Deno.Command" }],
    review: [
      {
        ruleId: "adversarial-review-report",
        dimension: "review",
        severity: "high",
        file: "manifest.yaml",
        message: "No adversarial review recorded",
      },
      {
        ruleId: "bare-specifiers",
        dimension: "scoring",
        severity: "medium",
        file: "(multiple files)",
        message: "Extension uses bare import specifiers",
      },
    ],
  });
  assertEquals("skeleton" in record.review[0], false);
});
