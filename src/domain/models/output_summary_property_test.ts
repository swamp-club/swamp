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
import fc from "fast-check";
import { ExecutionStatuses, TriggerTypes } from "./model_output.ts";
import {
  type OutputSummary,
  outputSummaryFromData,
  outputSummaryToData,
} from "./output_summary.ts";

const optionalText = fc.option(fc.string(), { nil: undefined });

const summary: fc.Arbitrary<OutputSummary> = fc.record({
  id: fc.string({ minLength: 1 }),
  definitionId: fc.string({ minLength: 1 }),
  methodName: fc.string({ minLength: 1 }),
  status: fc.constantFrom(...ExecutionStatuses),
  startedAt: fc.date({
    min: new Date("0000-01-01T00:00:00.000Z"),
    max: new Date("9999-12-31T23:59:59.999Z"),
    noInvalidDate: true,
  }),
  durationMs: fc.option(fc.nat(), { nil: undefined }),
  triggeredBy: fc.constantFrom(...TriggerTypes),
  workflowId: optionalText,
  workflowRunId: optionalText,
  stepName: optionalText,
}).map(({ triggeredBy, workflowId, workflowRunId, stepName, ...rest }) => ({
  ...rest,
  provenance: { triggeredBy, workflowId, workflowRunId, stepName },
}));

Deno.test("outputSummaryFromData: returns what outputSummaryToData stored, through JSON", () => {
  fc.assert(
    fc.property(summary, (original) => {
      const line = JSON.stringify(outputSummaryToData(original));
      const read = outputSummaryFromData(JSON.parse(line));
      assertEquals(
        JSON.stringify(outputSummaryToData(read!)),
        line,
      );
    }),
  );
});

Deno.test("outputSummaryFromData: any JSON value is refused or read, never thrown on", () => {
  fc.assert(
    fc.property(fc.jsonValue(), (value) => {
      outputSummaryFromData(value);
    }),
  );
});
