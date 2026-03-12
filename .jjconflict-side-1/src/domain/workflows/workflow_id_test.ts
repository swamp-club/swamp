// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { createWorkflowId, createWorkflowRunId } from "./workflow_id.ts";

Deno.test("createWorkflowId creates branded type", () => {
  const id = createWorkflowId("550e8400-e29b-41d4-a716-446655440000");
  assertEquals(typeof id, "string");
  assertEquals(id, "550e8400-e29b-41d4-a716-446655440000");
});

Deno.test("createWorkflowRunId creates branded type", () => {
  const id = createWorkflowRunId("550e8400-e29b-41d4-a716-446655440001");
  assertEquals(typeof id, "string");
  assertEquals(id, "550e8400-e29b-41d4-a716-446655440001");
});
