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
import { z } from "zod";
import { hasControlCharacter } from "../control_characters.ts";
import { Workflow, type WorkflowInput } from "./workflow.ts";
import { WorkflowSchemaError } from "./workflow_schema_error.ts";

/** Any string, with control characters made likely. */
const arbText = fc.oneof(
  fc.string(),
  fc.tuple(
    fc.string(),
    fc.oneof(
      fc.integer({ min: 0x00, max: 0x1f }),
      fc.integer({ min: 0x7f, max: 0x9f }),
    ).map((code) => String.fromCharCode(code)),
    fc.string(),
  ).map(([before, control, after]) => before + control + after),
);

/** A JSON-like value whose keys and strings are author-controlled text. */
const arbValue = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    arbText,
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.array(tie("value"), { maxLength: 3 }),
    fc.dictionary(arbText, tie("value"), { maxKeys: 3 }),
  ),
})).value;

/** A workflow document with arbitrary values in and around its known keys. */
const arbDocument = fc.record({
  id: arbValue,
  name: arbValue,
  tags: arbValue,
  inputs: arbValue,
  jobs: fc.array(
    fc.record({
      name: arbValue,
      steps: fc.array(
        fc.dictionary(arbText, arbValue, { maxKeys: 3 }),
        { maxLength: 2 },
      ),
      dependsOn: arbValue,
    }, { requiredKeys: [] }),
    { maxLength: 2 },
  ),
  extra: fc.dictionary(arbText, arbValue, { maxKeys: 2 }),
}, { requiredKeys: [] }).map(({ extra, ...known }) => ({ ...extra, ...known }));

Deno.test("property: a workflow schema failure is one line with no control characters", () => {
  let rejected = 0;
  fc.assert(
    fc.property(arbDocument, (document) => {
      try {
        Workflow.fromData(document as unknown as WorkflowInput);
      } catch (error) {
        // A raw ZodError must never escape; other errors are not schema
        // failures and are not this property's concern.
        assertEquals(error instanceof z.ZodError, false);
        if (!(error instanceof WorkflowSchemaError)) return;
        rejected++;
        assertEquals(hasControlCharacter(error.message), false);
        assertEquals(
          hasControlCharacter(error.inFile("workflow-x.yaml").message),
          false,
        );
        for (const issue of error.issues) {
          assertEquals(hasControlCharacter(issue.path), false);
          assertEquals(hasControlCharacter(issue.message), false);
        }
      }
    }),
  );
  // The generator must actually exercise the failure path.
  assertEquals(rejected > 0, true);
});
