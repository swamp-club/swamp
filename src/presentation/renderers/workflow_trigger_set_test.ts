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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { renderWorkflowTriggerSet } from "./workflow_trigger_set.ts";

// noColor: true gives one pre-rendered string per record to capture.
await initializeLogging({ noColor: true });

function captureLog(fn: () => void): string {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((m) => [m, console[m]] as const);
  for (const [m] of originals) {
    console[m] = (...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
    };
  }
  try {
    fn();
  } finally {
    for (const [m, orig] of originals) console[m] = orig;
  }
  // deno-lint-ignore no-control-regex
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
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

Deno.test("renderWorkflowTriggerSet: json mode reports the pause asked for", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);
  try {
    renderWorkflowTriggerSet("json", {
      workflowName: "daily-report",
      entry: { schedule: "0 8 * * 1-5", paused: true },
      paused: true,
    });
  } finally {
    console.log = origLog;
  }
  const parsed = JSON.parse(output[0]);
  assertEquals(parsed.paused, true);
  assertEquals(parsed.entry.paused, true);
});

Deno.test("renderWorkflowTriggerSet: log mode renders a resume with nothing stored", () => {
  renderWorkflowTriggerSet("log", {
    workflowName: "daily-report",
    entry: {},
    paused: false,
  });
});

Deno.test("renderWorkflowTriggerSet: log mode reports only the pause when no schedule was set", () => {
  const out = captureLog(() =>
    renderWorkflowTriggerSet("log", {
      workflowName: "daily-report",
      entry: { schedule: "0 8 * * 1-5", inputs: { a: 1 }, paused: true },
      paused: true,
    }, { scheduleSet: false })
  );
  assertStringIncludes(out, "Paused the schedule of");
  assert(!out.includes("Set trigger override"), out);
  assert(!out.includes("inputs:"), out);
});

Deno.test("renderWorkflowTriggerSet: log mode reports a schedule set with a pause", () => {
  const out = captureLog(() =>
    renderWorkflowTriggerSet("log", {
      workflowName: "daily-report",
      entry: { schedule: "0 8 * * 1-5", paused: true },
      paused: true,
    }, { scheduleSet: true })
  );
  assertStringIncludes(out, "Set trigger override for");
  assertStringIncludes(out, "Paused the schedule of");
});

Deno.test("renderWorkflowTriggerSet: log mode reports a schedule change that keeps a pause", () => {
  const out = captureLog(() =>
    renderWorkflowTriggerSet("log", {
      workflowName: "daily-report",
      entry: { schedule: "0 9 * * *", paused: true },
    })
  );
  assertStringIncludes(out, "Set trigger override for");
  assertStringIncludes(out, "the schedule stays paused");
});

Deno.test("renderWorkflowTriggerSet: json mode is the same with or without a schedule set", () => {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (msg: string) => output.push(msg);
  try {
    const data = {
      workflowName: "daily-report",
      entry: { schedule: "0 8 * * 1-5", paused: true },
      paused: true,
    };
    renderWorkflowTriggerSet("json", data, { scheduleSet: false });
    renderWorkflowTriggerSet("json", data, { scheduleSet: true });
  } finally {
    console.log = origLog;
  }
  assertEquals(output[0], output[1]);
  assertEquals(JSON.parse(output[0]).entry.schedule, "0 8 * * 1-5");
});
