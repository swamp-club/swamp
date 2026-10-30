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
import { createDefinitionId } from "../definitions/definition.ts";
import { ModelOutput } from "./model_output.ts";
import {
  outputSummaryFromData,
  outputSummaryOf,
  outputSummaryToData,
} from "./output_summary.ts";

function failedOutput(): ModelOutput {
  const output = ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "run",
    status: "running",
    startedAt: new Date("2026-10-30T01:02:03.004Z"),
    provenance: {
      definitionHash: "h",
      modelVersion: "1",
      triggeredBy: "workflow",
      workflowId: "w",
      workflowRunId: "r",
      stepName: "s",
    },
  });
  output.markFailed({ message: "boom" });
  return output;
}

Deno.test("outputSummaryOf: projects the fields a listing needs, with the error message", () => {
  const output = failedOutput();
  const summary = outputSummaryOf(output);
  assertEquals(summary.id, output.id);
  assertEquals(summary.definitionId, output.definitionId);
  assertEquals(summary.status, "failed");
  assertEquals(summary.startedAt, output.startedAt);
  assertEquals(summary.durationMs, output.durationMs);
  assertEquals(summary.errorMessage, "boom");
  assertEquals(summary.provenance, {
    triggeredBy: "workflow",
    workflowId: "w",
    workflowRunId: "r",
    stepName: "s",
  });
});

Deno.test("outputSummaryToData: never stores the error message", () => {
  const stored = JSON.stringify(
    outputSummaryToData(outputSummaryOf(failedOutput())),
  );
  assertEquals(stored.includes("boom"), false);
});

Deno.test("outputSummaryFromData: refuses what is not a stored summary", () => {
  const data = outputSummaryToData(outputSummaryOf(failedOutput()));
  for (
    const bad of [
      null,
      "text",
      [],
      { ...data, id: "" },
      { ...data, definitionId: 1 },
      { ...data, methodName: undefined },
      { ...data, status: "unknown" },
      { ...data, startedAt: "yesterday" },
      { ...data, startedAt: "2026-10-30T01:02:03Z" },
      { ...data, durationMs: -1 },
      { ...data, durationMs: "1" },
      { ...data, triggeredBy: "someone" },
      { ...data, workflowId: 1 },
      { ...data, workflowRunId: 1 },
      { ...data, stepName: 1 },
    ]
  ) {
    assertEquals(outputSummaryFromData(bad), undefined);
  }
});
