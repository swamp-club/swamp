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

import {
  assertEquals,
  assertInstanceOf,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { InvalidExpressionError, UnresolvedExpressionError } from "./errors.ts";
import { assertMethodArgumentsEvaluated } from "./unresolved_expression_guard.ts";

const FAILED_RAW = "${{ data.latest('producer', 'log').nope }}";
const failed = new Map<string, Error>([
  [
    FAILED_RAW,
    new InvalidExpressionError(
      "No such key: nope",
      "data.latest('producer', 'log').nope",
    ),
  ],
]);

Deno.test("assertMethodArgumentsEvaluated: throws for a failed expression in a top-level argument", () => {
  const error = assertThrows(
    () =>
      assertMethodArgumentsEvaluated(
        "execute",
        { run: `cat ${FAILED_RAW}` },
        failed,
      ),
    UnresolvedExpressionError,
  );
  assertEquals(error.path, "methods.execute.arguments.run");
  assertEquals(error.expression, FAILED_RAW);
  assertStringIncludes(
    error.message,
    "Expression in methods.execute.arguments.run could not be evaluated",
  );
  assertStringIncludes(error.message, "No such key: nope");
  assertInstanceOf(error.cause, InvalidExpressionError);
});

Deno.test("assertMethodArgumentsEvaluated: throws for a failed expression nested in objects and arrays", () => {
  const error = assertThrows(
    () =>
      assertMethodArgumentsEvaluated(
        "deploy",
        { spec: { hosts: ["a", FAILED_RAW] } },
        failed,
      ),
    UnresolvedExpressionError,
  );
  assertEquals(error.path, "methods.deploy.arguments.spec.hosts[1]");
});

Deno.test("assertMethodArgumentsEvaluated: passes when the failed expression is not in this method's arguments", () => {
  assertMethodArgumentsEvaluated(
    "execute",
    { run: "echo overridden" },
    failed,
  );
});

Deno.test("assertMethodArgumentsEvaluated: passes unrecorded expressions through", () => {
  // Runtime and deferred references resolve later, and ${{ }} text that
  // arrived as data content was never evaluated — none are recorded.
  assertMethodArgumentsEvaluated(
    "execute",
    {
      token: "${{ vault.get('main', 'token') }}",
      home: "${{ env.HOME }}",
      body: "docs mention ${{ inputs.example }} as syntax",
    },
    failed,
  );
});

Deno.test("assertMethodArgumentsEvaluated: passes when nothing failed", () => {
  assertMethodArgumentsEvaluated(
    "execute",
    { run: `cat ${FAILED_RAW}` },
    new Map(),
  );
});
