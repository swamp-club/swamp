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

// The same options DataQueryService parses predicates with.
const env = new Environment({
  unlistedVariablesAreDyn: true,
  homogeneousAggregateLiterals: false,
});

const arbTarget: fc.Arbitrary<DataQueryTarget> = fc.record({
  dataName: fc.string({ minLength: 1 }),
  version: fc.option(fc.integer({ min: 1, max: 1000 }), { nil: undefined }),
  modelName: fc.option(fc.string(), { nil: undefined }),
  workflowRunId: fc.option(fc.uuid(), { nil: undefined }),
  jobName: fc.option(fc.string(), { nil: undefined }),
  stepName: fc.option(fc.string(), { nil: undefined }),
});

/** The record fields a predicate built from `target` reads. */
function recordFor(target: DataQueryTarget): Record<string, unknown> {
  return {
    name: target.dataName,
    version: target.version ?? 1,
    modelName: target.modelName ?? "",
    workflowRunId: target.workflowRunId ?? "",
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
