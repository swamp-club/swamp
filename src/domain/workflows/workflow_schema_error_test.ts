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

import { assertEquals, assertInstanceOf } from "@std/assert";
import { z } from "zod";
import { UserError } from "../errors.ts";
import { WorkflowSchemaError } from "./workflow_schema_error.ts";

function schemaError(
  schema: z.ZodType,
  data: unknown,
): WorkflowSchemaError {
  const result = schema.safeParse(data);
  if (result.success) throw new Error("expected the data to be rejected");
  return WorkflowSchemaError.fromZodError(result.error);
}

Deno.test("WorkflowSchemaError.fromZodError: is a UserError named for the workflow schema", () => {
  const error = schemaError(z.object({ name: z.string() }), { name: 1 });
  assertInstanceOf(error, UserError);
  assertEquals(error.name, "WorkflowSchemaError");
});

Deno.test("WorkflowSchemaError.fromZodError: prints one issue as its path and message", () => {
  const error = schemaError(
    z.object({ jobs: z.array(z.object({ weight: z.number() })) }),
    { jobs: [{ weight: "heavy" }] },
  );
  assertEquals(
    error.message,
    "jobs[0].weight: Invalid input: expected number, received string",
  );
  assertEquals(error.issues, [{
    path: "jobs[0].weight",
    message: "Invalid input: expected number, received string",
  }]);
});

Deno.test("WorkflowSchemaError.fromZodError: joins several issues on one line", () => {
  const error = schemaError(
    z.object({ name: z.string(), version: z.number() }),
    { name: 1, version: "one" },
  );
  assertEquals(
    error.message,
    "name: Invalid input: expected string, received number; " +
      "version: Invalid input: expected number, received string",
  );
  assertEquals(error.message.includes("\n"), false);
});

Deno.test("WorkflowSchemaError.fromZodError: prints a root-level issue without a path", () => {
  const error = schemaError(z.object({}), "not an object");
  assertEquals(
    error.message,
    "Invalid input: expected object, received string",
  );
  assertEquals(error.issues[0].path, "");
});

Deno.test("WorkflowSchemaError.fromZodError: keeps a custom message", () => {
  const error = schemaError(
    z.object({
      name: z.string().regex(/^[a-z]+$/, { message: "Name must be lowercase" }),
    }),
    { name: "HOST-1" },
  );
  assertEquals(error.message, "name: Name must be lowercase");
});

Deno.test("WorkflowSchemaError.fromZodError: escapes control characters in a record key", () => {
  const error = schemaError(
    z.object({ tags: z.record(z.string(), z.string()) }),
    { tags: { "ev\u001b]0;il\u0007": 1 } },
  );
  assertEquals(error.message.includes("\u001b"), false);
  assertEquals(error.message.includes("\u0007"), false);
  assertEquals(error.issues[0].path.includes("\u001b"), false);
});

Deno.test("WorkflowSchemaError.fromZodError: escapes control characters in a message", () => {
  const error = schemaError(
    z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
      for (const key of Object.keys(value)) {
        ctx.addIssue({ code: "custom", message: `Unknown key '${key}'` });
      }
    }),
    { "bad\nkey\u001b": true },
  );
  assertEquals(error.message, "Unknown key 'bad\\x0akey\\x1b'");
});

Deno.test("WorkflowSchemaError.inFile: names the file in front and keeps the issues", () => {
  const error = schemaError(z.object({ name: z.string() }), { name: 1 });
  const named = error.inFile("workflow-deploy.yaml");
  assertEquals(named instanceof WorkflowSchemaError, true);
  assertEquals(
    named.message,
    "workflow-deploy.yaml: name: Invalid input: expected string, received number",
  );
  assertEquals(named.issues, error.issues);
});

Deno.test("WorkflowSchemaError.inFile: escapes control characters in the file name", () => {
  const error = schemaError(z.object({ name: z.string() }), { name: 1 });
  const named = error.inFile("workflow-\u001b[2J.yaml");
  assertEquals(named.message.includes("\u001b"), false);
});
