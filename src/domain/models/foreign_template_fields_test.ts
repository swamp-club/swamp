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
import { z } from "zod";
import {
  extractForeignTemplateFields,
  foreignTemplatePathPredicate,
} from "./foreign_template_fields.ts";
import type { MethodDefinition } from "./model.ts";

function method(args: z.ZodTypeAny): MethodDefinition {
  return {
    description: "test",
    arguments: args,
    execute: () => Promise.resolve({}),
  };
}

Deno.test("extractForeignTemplateFields: returns declared fields only", () => {
  const schema = z.object({
    monitorName: z.string().meta({ foreignTemplate: true }),
    message: z.string().meta({ foreignTemplate: true }).describe("Alert body"),
    query: z.string(),
    other: z.string().meta({ sensitive: true }),
  });
  assertEquals(extractForeignTemplateFields(schema), [
    "monitorName",
    "message",
  ]);
});

Deno.test("extractForeignTemplateFields: requires the flag to be exactly true", () => {
  const schema = z.object({
    a: z.string().meta({ foreignTemplate: "yes" }),
    b: z.string().meta({ foreignTemplate: false }),
  });
  assertEquals(extractForeignTemplateFields(schema), []);
});

Deno.test("extractForeignTemplateFields: handles both meta orderings and nesting", () => {
  const schema = z.object({
    a: z.string().meta({ foreignTemplate: true }).optional(),
    b: z.string().optional().meta({ foreignTemplate: true }),
    nested: z.object({ c: z.string().min(1).meta({ foreignTemplate: true }) }),
  });
  assertEquals(extractForeignTemplateFields(schema), ["a", "b", "nested.c"]);
});

Deno.test("extractForeignTemplateFields: returns nothing without a schema", () => {
  assertEquals(extractForeignTemplateFields(undefined), []);
});

Deno.test("foreignTemplatePathPredicate: covers declared global arguments and their subtrees", () => {
  const isDeclared = foreignTemplatePathPredicate({
    globalArguments: z.object({
      message: z.string().meta({ foreignTemplate: true }),
      block: z.object({ body: z.string() }).meta({ foreignTemplate: true }),
      tags: z.array(z.string()).meta({ foreignTemplate: true }),
      query: z.string(),
    }),
    methods: {},
  });
  assertEquals(isDeclared("globalArguments.message"), true);
  assertEquals(isDeclared("globalArguments.block"), true);
  assertEquals(isDeclared("globalArguments.block.body"), true);
  assertEquals(isDeclared("globalArguments.tags[0]"), true);
  assertEquals(isDeclared("globalArguments.query"), false);
  assertEquals(isDeclared("globalArguments.messageExtra"), false);
  assertEquals(isDeclared("message"), false);
});

Deno.test("foreignTemplatePathPredicate: covers declared method arguments under the method prefix", () => {
  const isDeclared = foreignTemplatePathPredicate({
    methods: {
      execute: method(z.object({
        run: z.string().meta({ foreignTemplate: true }),
        workingDir: z.string().optional(),
      })),
      other: method(z.object({ run: z.string() })),
    },
  });
  assertEquals(isDeclared("methods.execute.arguments.run"), true);
  assertEquals(isDeclared("methods.execute.arguments.workingDir"), false);
  assertEquals(isDeclared("methods.other.arguments.run"), false);
  assertEquals(isDeclared("globalArguments.run"), false);
});

Deno.test("foreignTemplatePathPredicate: record-typed method arguments declare nothing", () => {
  const isDeclared = foreignTemplatePathPredicate({
    methods: {
      execute: method(
        z.record(z.string(), z.string().meta({ foreignTemplate: true })),
      ),
    },
  });
  assertEquals(isDeclared("methods.execute.arguments.anything"), false);
});
