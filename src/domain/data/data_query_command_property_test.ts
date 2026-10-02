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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { Environment } from "cel-js";
import {
  dataQueryCommand,
  dataQueryPredicate,
  type DataQueryTarget,
} from "./data_query_command.ts";

/** The run id the stub `latestRun` resolves `workflow` to. */
function latestRunOf(workflow: string): string {
  return `latest-run-of:${workflow}`;
}

// The same options DataQueryService parses predicates with, and a
// latestRun as a query that resolved its runs has it.
const env = new Environment({
  unlistedVariablesAreDyn: true,
  homogeneousAggregateLiterals: false,
}).registerFunction("latestRun(string): dyn", latestRunOf);

/** No run, a pinned run id, or the latest run of a workflow. */
const arbRunSelector: fc.Arbitrary<
  { workflowRunId?: string } | { latestRunWorkflow: string }
> = fc.oneof(
  fc.constant({}),
  fc.record({ workflowRunId: fc.uuid() }),
  fc.record({ latestRunWorkflow: fc.string() }),
);

const arbTarget: fc.Arbitrary<DataQueryTarget> = fc.tuple(
  fc.record({
    dataName: fc.string({ minLength: 1 }),
    version: fc.option(fc.integer({ min: 1, max: 1000 }), { nil: undefined }),
    modelType: fc.option(fc.string(), { nil: undefined }),
    modelId: fc.option(fc.uuid(), { nil: undefined }),
    modelName: fc.option(fc.string(), { nil: undefined }),
    jobName: fc.option(fc.string(), { nil: undefined }),
    stepName: fc.option(fc.string(), { nil: undefined }),
  }),
  arbRunSelector,
).map(([fields, run]) => ({ ...fields, ...run }));

/** The record fields a predicate built from `target` reads. */
function recordFor(target: DataQueryTarget): Record<string, unknown> {
  return {
    name: target.dataName,
    version: target.version ?? 1,
    modelType: target.modelType ?? "",
    modelId: target.modelId ?? "",
    modelName: target.modelName ?? "",
    workflowRunId: target.latestRunWorkflow !== undefined
      ? latestRunOf(target.latestRunWorkflow)
      : target.workflowRunId ?? "",
    jobName: target.jobName ?? "",
    stepName: target.stepName ?? "",
  };
}

/** Reads back one word a POSIX shell would parse from `quoteShellWord`. */
function unquoteShellWord(word: string): string {
  if (!word.startsWith("'")) return word;
  return word.slice(1, -1).replaceAll(`'"'"'`, "'");
}

Deno.test("dataQueryPredicate: matches the record it was built from, for any names", () => {
  fc.assert(
    fc.property(arbTarget, (target) => {
      assertEquals(
        env.evaluate(dataQueryPredicate(target), recordFor(target)),
        true,
      );
    }),
    { numRuns: 300 },
  );
});

Deno.test("dataQueryPredicate: does not match a record with another data name", () => {
  fc.assert(
    fc.property(arbTarget, fc.string(), (target, other) => {
      fc.pre(other !== target.dataName);
      const record = { ...recordFor(target), name: other };
      assertEquals(env.evaluate(dataQueryPredicate(target), record), false);
    }),
    { numRuns: 300 },
  );
});

Deno.test("dataQueryCommand: the shell reads back the exact predicate", () => {
  fc.assert(
    fc.property(arbTarget, fc.boolean(), (target, includeContent) => {
      const command = dataQueryCommand(target, { includeContent });
      const prefix = "swamp data query ";
      const suffix = includeContent ? " --select content" : "";
      assert(command.startsWith(prefix));
      assert(command.endsWith(suffix));
      const word = command.slice(prefix.length, command.length - suffix.length);
      assertEquals(unquoteShellWord(word), dataQueryPredicate(target));
    }),
    { numRuns: 300 },
  );
});

Deno.test("dataQueryPredicate: a latest-run target does not match another run's record", () => {
  fc.assert(
    fc.property(arbTarget, fc.uuid(), (target, otherRun) => {
      fc.pre(target.latestRunWorkflow !== undefined);
      const record = { ...recordFor(target), workflowRunId: otherRun };
      assertEquals(env.evaluate(dataQueryPredicate(target), record), false);
    }),
    { numRuns: 300 },
  );
});
