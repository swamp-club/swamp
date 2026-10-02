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
import { isWorkflowDocument } from "./workflow_document.ts";

Deno.test("isWorkflowDocument: accepts an object with a top-level jobs key", () => {
  assertEquals(isWorkflowDocument({ name: "wf", jobs: [] }), true);
});

Deno.test("isWorkflowDocument: accepts malformed jobs so construction errors surface", () => {
  assertEquals(isWorkflowDocument({ jobs: { build: {} } }), true);
  assertEquals(isWorkflowDocument({ jobs: null }), true);
});

Deno.test("isWorkflowDocument: rejects objects without a jobs key", () => {
  assertEquals(isWorkflowDocument({}), false);
  assertEquals(
    isWorkflowDocument({ networks: ["default"], tests: [] }),
    false,
  );
  assertEquals(
    isWorkflowDocument({ manifestVersion: 1, workflows: ["wf.yaml"] }),
    false,
  );
});

Deno.test("isWorkflowDocument: rejects non-object documents", () => {
  assertEquals(isWorkflowDocument(null), false);
  assertEquals(isWorkflowDocument(undefined), false);
  assertEquals(isWorkflowDocument("jobs"), false);
  assertEquals(isWorkflowDocument(42), false);
  assertEquals(isWorkflowDocument([{ jobs: [] }]), false);
});

Deno.test("isWorkflowDocument: ignores an inherited jobs key", () => {
  assertEquals(isWorkflowDocument(Object.create({ jobs: [] })), false);
});
