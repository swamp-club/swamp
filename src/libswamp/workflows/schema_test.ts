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
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import { workflowSchema, type WorkflowSchemaEvent } from "./schema.ts";

Deno.test("workflowSchema yields completed with schema data", async () => {
  const ctx = createLibSwampContext();
  const events = await collect<WorkflowSchemaEvent>(workflowSchema(ctx));

  assertEquals(events.length, 1);
  assertEquals(events[0].kind, "completed");
  const completed = events[0] as Extract<
    WorkflowSchemaEvent,
    { kind: "completed" }
  >;
  // The generator now produces real JSON schemas from Zod, not stubs
  assert(typeof completed.data.workflow === "object");
  assert(typeof completed.data.job === "object");
  assert(typeof completed.data.step === "object");
  assert(typeof completed.data.stepTask === "object");
  assert(typeof completed.data.triggerCondition === "object");
});
