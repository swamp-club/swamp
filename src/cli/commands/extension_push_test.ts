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

import { assertEquals } from "@std/assert";
import type { OutputMode } from "../../presentation/output/output.ts";
import type { WarningsWaiver } from "../../presentation/renderers/extension_push.ts";
import {
  buildAcceptedWarnings,
  resolveExistingVersionResponse,
  resolveWarningsGate,
  resolveWarningsWaiver,
} from "./extension_push.ts";

function gate(overrides: {
  warningCount?: number;
  waiver?: WarningsWaiver;
  dryRun?: boolean;
  outputMode?: OutputMode;
}) {
  return resolveWarningsGate({
    warningCount: 1,
    waiver: undefined,
    dryRun: false,
    outputMode: "log",
    ...overrides,
  });
}

Deno.test("resolveWarningsWaiver: --yes waives, --force waives, --yes wins when both are passed", () => {
  assertEquals(resolveWarningsWaiver({ yes: true }), "--yes");
  assertEquals(resolveWarningsWaiver({ force: true }), "--force");
  assertEquals(resolveWarningsWaiver({ yes: true, force: true }), "--yes");
  assertEquals(resolveWarningsWaiver({}), undefined);
  assertEquals(resolveWarningsWaiver({ yes: false, force: false }), undefined);
});

Deno.test("resolveWarningsGate: --yes and --force proceed and record the flag in every mode", () => {
  for (const waiver of ["--yes", "--force"] as const) {
    for (const outputMode of ["log", "json"] as const) {
      for (const dryRun of [true, false]) {
        assertEquals(
          gate({ waiver, outputMode, dryRun, warningCount: 3 }),
          { kind: "proceed", waivedBy: waiver },
          `${waiver} ${outputMode} dryRun=${dryRun}`,
        );
      }
    }
  }
});

Deno.test("resolveWarningsGate: json push with a warning and no flag proceeds without a record", () => {
  // The pre-#3015 behaviour: --json never prompted and never refused. The
  // warnings were rendered ahead of the gate, so nothing is hidden.
  assertEquals(gate({ outputMode: "json" }), { kind: "proceed" });
});

Deno.test("resolveWarningsGate: json dry run with a warning and no flag proceeds without a record", () => {
  assertEquals(
    gate({ outputMode: "json", dryRun: true }),
    { kind: "proceed" },
  );
});

Deno.test("resolveWarningsGate: log dry run with a warning and no flag proceeds without prompting", () => {
  // A dry run performs no push and so has nothing to confirm.
  assertEquals(gate({ dryRun: true }), { kind: "proceed" });
});

Deno.test("resolveWarningsGate: log push with a warning and no flag prompts", () => {
  // The prompt helper itself rejects a non-terminal stdin and names --yes, so
  // the gate does not need to know whether a terminal is attached.
  assertEquals(gate({}), { kind: "prompt" });
});

Deno.test("resolveWarningsGate: no warnings proceeds without a record in every mode", () => {
  for (const waiver of ["--yes", "--force", undefined] as const) {
    for (const outputMode of ["log", "json"] as const) {
      for (const dryRun of [true, false]) {
        assertEquals(
          gate({ warningCount: 0, waiver, outputMode, dryRun }),
          { kind: "proceed" },
          `${waiver} ${outputMode} dryRun=${dryRun}`,
        );
      }
    }
  }
});

Deno.test("buildAcceptedWarnings: keeps safety warnings and drops the review skeleton and every remediation", () => {
  const record = buildAcceptedWarnings({
    safetyWarnings: [{
      ruleId: "deno-command",
      file: "models/a.ts",
      line: 7,
      message: "uses Deno.Command",
      remediation: "prefer swamp primitives",
    }],
    reviewRulesResult: {
      warnings: [
        {
          ruleId: "adversarial-review-report",
          dimension: "review",
          severity: "high",
          file: "manifest.yaml",
          message: "No adversarial review recorded",
          remediation: "run the review",
          skeleton: {
            extension: "@test/ext",
            version: "1",
            reviewedAt: "<ISO-8601 timestamp>",
            dimensions: [],
          },
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
    safety: [{
      ruleId: "deno-command",
      file: "models/a.ts",
      line: 7,
      message: "uses Deno.Command",
    }],
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

// ── Existing version (swamp-club#2939) ────────────────────────────────

const LOWER_CHANNEL_MESSAGE =
  "Version 2026.10.06.1 already exists for @x/y on channel 'beta'. " +
  "To move it to 'stable' without re-publishing, run: " +
  "swamp extension promote @x/y 2026.10.06.1 --channel stable";

function existing(overrides: {
  existingChannel?: string;
  requestedChannel?: string;
  checkMessage?: string;
  outputMode?: OutputMode;
  yes?: boolean;
  force?: boolean;
}) {
  return resolveExistingVersionResponse({
    extensionName: "@x/y",
    version: "2026.10.06.1",
    checkMessage: "Version 2026.10.06.1 already exists for @x/y.",
    existingChannel: "stable",
    requestedChannel: "stable",
    outputMode: "log",
    ...overrides,
  });
}

const SAME_CHANNEL_REFUSAL = "Version 2026.10.06.1 already exists for @x/y. " +
  "Use a different version or let the CLI bump it interactively.";

Deno.test("resolveExistingVersionResponse: interactive, a lower channel offers the three-way choice", () => {
  assertEquals(
    existing({ existingChannel: "beta", requestedChannel: "stable" }),
    { kind: "choose" },
  );
  assertEquals(
    existing({ existingChannel: "beta", requestedChannel: "rc" }),
    { kind: "choose" },
  );
});

Deno.test("resolveExistingVersionResponse: interactive, the same or a higher channel asks to bump", () => {
  assertEquals(existing({}), { kind: "bump-prompt" });
  assertEquals(
    existing({ existingChannel: "stable", requestedChannel: "beta" }),
    { kind: "bump-prompt" },
  );
});

Deno.test("resolveExistingVersionResponse: --yes and --force never promote", () => {
  for (const flags of [{ yes: true }, { force: true }]) {
    assertEquals(
      existing({
        existingChannel: "beta",
        requestedChannel: "stable",
        checkMessage: LOWER_CHANNEL_MESSAGE,
        ...flags,
      }),
      { kind: "refuse", message: LOWER_CHANNEL_MESSAGE },
    );
  }
});

Deno.test("resolveExistingVersionResponse: --json refuses a same-channel duplicate with the pre-#2939 message", () => {
  assertEquals(existing({ outputMode: "json" }), {
    kind: "refuse",
    message: SAME_CHANNEL_REFUSAL,
  });
  assertEquals(existing({ yes: true }), {
    kind: "refuse",
    message: SAME_CHANNEL_REFUSAL,
  });
});

Deno.test("resolveExistingVersionResponse: --json on another channel refuses with the channel-aware message", () => {
  assertEquals(
    existing({
      existingChannel: "beta",
      requestedChannel: "stable",
      checkMessage: LOWER_CHANNEL_MESSAGE,
      outputMode: "json",
    }),
    { kind: "refuse", message: LOWER_CHANNEL_MESSAGE },
  );
});
