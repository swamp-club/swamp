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
import {
  isWorkflowTriggerSource,
  WORKFLOW_TRIGGER_SOURCES,
} from "./trigger_source.ts";

Deno.test("isWorkflowTriggerSource: accepts every declared source", () => {
  for (const source of WORKFLOW_TRIGGER_SOURCES) {
    assertEquals(isWorkflowTriggerSource(source), true);
  }
});

Deno.test("isWorkflowTriggerSource: rejects unknown and non-string values", () => {
  // Spool files live on disk and may be hand-edited or written by a newer
  // version, so decoding must not trust the value.
  assertEquals(isWorkflowTriggerSource("interactive"), false);
  assertEquals(isWorkflowTriggerSource("Schedule"), false);
  assertEquals(isWorkflowTriggerSource(""), false);
  assertEquals(isWorkflowTriggerSource(undefined), false);
  assertEquals(isWorkflowTriggerSource(null), false);
  assertEquals(isWorkflowTriggerSource(42), false);
  assertEquals(isWorkflowTriggerSource({ triggerSource: "schedule" }), false);
});
