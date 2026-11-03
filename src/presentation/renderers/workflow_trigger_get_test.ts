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

import { assertEquals, assertMatch } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { renderWorkflowTriggerGet } from "./workflow_trigger_get.ts";

// noColor: true selects LogTape's text formatter, so each record reaches the
// console as one pre-rendered string
await initializeLogging({ noColor: true });

// LogTape's console sink routes per level, so every console method is captured
function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((m) => [m, console[m]] as const);
  for (const [m] of originals) {
    console[m] = (...args: unknown[]) => {
      lines.push(stripAnsiCode(args.map(String).join(" ")));
    };
  }
  try {
    fn();
  } finally {
    for (const [m, orig] of originals) console[m] = orig;
  }
  return lines;
}

// the record text after the level and category prefix
function messages(lines: string[]): string[] {
  return lines.map((l) => l.replace(/^.*?workflow·trigger·get:? ?/, ""));
}

Deno.test("renderWorkflowTriggerGet: json mode outputs complete data", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);
  try {
    renderWorkflowTriggerGet("json", {
      workflowName: "scan-cves",
      builtIn: { schedule: "0 6 * * *", inputs: {}, catchUp: null },
      override: {
        schedule: "0 3 * * *",
        catchUp: { policy: "latest", maxDelay: "6h" },
      },
      effective: {
        schedule: "0 3 * * *",
        inputs: {},
        catchUp: { policy: "latest", maxDelay: "6h" },
      },
    });
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(output[0]);
  assertEquals(parsed.workflowName, "scan-cves");
  assertEquals(parsed.builtIn.schedule, "0 6 * * *");
  assertEquals(parsed.override.schedule, "0 3 * * *");
  assertEquals(parsed.effective.schedule, "0 3 * * *");
  assertEquals(parsed.effective.catchUp, { policy: "latest", maxDelay: "6h" });
});

Deno.test("renderWorkflowTriggerGet: json mode with no trigger", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);
  try {
    renderWorkflowTriggerGet("json", {
      workflowName: "nonexistent",
      builtIn: null,
      override: null,
      effective: { schedule: null, inputs: {}, catchUp: null },
    });
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(output[0]);
  assertEquals(parsed.workflowName, "nonexistent");
  assertEquals(parsed.builtIn, null);
  assertEquals(parsed.override, null);
});

// LogTape may quote interpolated strings, so quotes around values are optional
function catchUpLines(lines: string[]): string[] {
  return messages(lines).filter((l) => l.includes("catch-up:"));
}

Deno.test("renderWorkflowTriggerGet: log mode shows each catch-up policy, the effective one from the override", () => {
  const lines = captureLog(() =>
    renderWorkflowTriggerGet("log", {
      workflowName: "scan-cves",
      builtIn: {
        schedule: "0 6 * * *",
        inputs: {},
        catchUp: { policy: "none" },
      },
      override: {
        schedule: "0 3 * * *",
        catchUp: { policy: "latest", maxDelay: "6h" },
      },
      effective: {
        schedule: "0 3 * * *",
        inputs: {},
        catchUp: { policy: "latest", maxDelay: "6h" },
      },
    })
  );
  const text = messages(lines);
  const builtIn = text.indexOf("  built-in:");
  const override = text.indexOf("  override (serve.yaml):");
  const effective = text.indexOf("  effective:");
  assertEquals(
    builtIn >= 0 && builtIn < override && override < effective,
    true,
  );

  const catchUp = catchUpLines(lines);
  assertEquals(catchUp.length, 3);
  assertMatch(catchUp[0], /^ {4}catch-up: "?none"?$/);
  assertMatch(catchUp[1], /^ {4}catch-up: "?latest \(max delay 6h\)"?$/);
  assertMatch(
    catchUp[2],
    /^ {4}catch-up: "?latest \(max delay 6h\)"? \("?override"?\)$/,
  );
  assertEquals(
    text.indexOf(catchUp[2]) > effective,
    true,
    "the effective catch-up is listed under effective",
  );
});

Deno.test("renderWorkflowTriggerGet: log mode marks a built-in catch-up policy as built-in when the override sets none", () => {
  const lines = captureLog(() =>
    renderWorkflowTriggerGet("log", {
      workflowName: "scan-cves",
      builtIn: {
        schedule: "0 6 * * *",
        inputs: {},
        catchUp: { policy: "latest", maxDelay: "2h" },
      },
      override: { schedule: "0 3 * * *" },
      effective: {
        schedule: "0 3 * * *",
        inputs: {},
        catchUp: { policy: "latest", maxDelay: "2h" },
      },
    })
  );
  const catchUp = catchUpLines(lines);
  assertEquals(catchUp.length, 2);
  assertMatch(catchUp[0], /^ {4}catch-up: "?latest \(max delay 2h\)"?$/);
  assertMatch(
    catchUp[1],
    /^ {4}catch-up: "?latest \(max delay 2h\)"? \("?built-in"?\)$/,
  );
});

Deno.test("renderWorkflowTriggerGet: log mode prints no catch-up line when no policy is set", () => {
  const lines = captureLog(() =>
    renderWorkflowTriggerGet("log", {
      workflowName: "scan-cves",
      builtIn: { schedule: "0 6 * * *", inputs: {}, catchUp: null },
      override: null,
      effective: { schedule: "0 6 * * *", inputs: {}, catchUp: null },
    })
  );
  assertEquals(messages(lines).includes("  effective:"), true);
  assertEquals(catchUpLines(lines), []);
});
