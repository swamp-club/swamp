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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  formatCatchUp,
  renderWorkflowTriggerSet,
} from "./workflow_trigger_set.ts";

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

Deno.test("renderWorkflowTriggerSet: json mode outputs valid JSON", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);
  try {
    renderWorkflowTriggerSet("json", {
      workflowName: "scan-cves",
      entry: { schedule: "0 3 * * *", inputs: { channel: "#ops" } },
    });
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(output[0]);
  assertEquals(parsed.workflowName, "scan-cves");
  assertEquals(parsed.entry.schedule, "0 3 * * *");
  assertEquals(parsed.entry.inputs.channel, "#ops");
});

Deno.test("renderWorkflowTriggerSet: json mode without inputs", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);
  try {
    renderWorkflowTriggerSet("json", {
      workflowName: "daily-report",
      entry: { schedule: "0 8 * * 1-5" },
    });
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(output[0]);
  assertEquals(parsed.workflowName, "daily-report");
  assertEquals(parsed.entry.inputs, undefined);
});

Deno.test("formatCatchUp: shows the policy and, when set, its max delay", () => {
  assertEquals(
    formatCatchUp({ policy: "latest", maxDelay: "6h" }),
    "latest (max delay 6h)",
  );
  assertEquals(formatCatchUp({ policy: "latest" }), "latest");
  assertEquals(formatCatchUp({ policy: "none" }), "none");
});

Deno.test("renderWorkflowTriggerSet: log mode prints the catch-up policy when set", () => {
  const lines = captureLog(() =>
    renderWorkflowTriggerSet("log", {
      workflowName: "scan-cves",
      entry: {
        schedule: "0 3 * * *",
        catchUp: { policy: "latest", maxDelay: "6h" },
      },
    })
  );
  const text = lines.join("\n");
  assertStringIncludes(text, "Set trigger override for");
  assertStringIncludes(text, "scan-cves");
  const catchUp = lines.filter((l) => l.includes("catch-up:"));
  assertEquals(catchUp.length, 1);
  assertStringIncludes(catchUp[0], "latest (max delay 6h)");
});

Deno.test("renderWorkflowTriggerSet: log mode prints no catch-up line without a policy", () => {
  const lines = captureLog(() =>
    renderWorkflowTriggerSet("log", {
      workflowName: "scan-cves",
      entry: { schedule: "0 3 * * *" },
    })
  );
  assertStringIncludes(lines.join("\n"), "Set trigger override for");
  assertEquals(lines.filter((l) => l.includes("catch-up")), []);
});
