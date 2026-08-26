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

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  evaluateWorkflowRunFilter,
  MAX_FILTER_LENGTH,
  validateWorkflowRunFilter,
  type WorkflowRunFilterContext,
} from "./workflow_run_filter.ts";

const RUN: WorkflowRunFilterContext = {
  workflowName: "verify-reviews",
  status: "succeeded",
  startedAt: "2026-08-26T10:00:00Z",
  completedAt: "2026-08-26T10:05:00Z",
  duration: 300000,
  inputs: { commit: "b3ff3a8a", branch: "feature/foo" },
  tags: { env: "ci", worktree: "1848" },
  instanceId: "inst-123",
  triggerSource: "cli",
  failedStep: "",
  failureReason: "",
};

// --- Validation: valid expressions ---

Deno.test("validateWorkflowRunFilter: simple string equality", () => {
  const result = validateWorkflowRunFilter('status == "succeeded"');
  assertEquals(result, { valid: true });
});

Deno.test("validateWorkflowRunFilter: inputs map access", () => {
  const result = validateWorkflowRunFilter(
    'inputs.commit == "b3ff3a8a"',
  );
  assertEquals(result, { valid: true });
});

Deno.test("validateWorkflowRunFilter: tags map access", () => {
  const result = validateWorkflowRunFilter('tags.env == "ci"');
  assertEquals(result, { valid: true });
});

Deno.test("validateWorkflowRunFilter: duration numeric comparison", () => {
  const result = validateWorkflowRunFilter("duration > 60000");
  assertEquals(result, { valid: true });
});

Deno.test("validateWorkflowRunFilter: compound expression", () => {
  const result = validateWorkflowRunFilter(
    'status == "failed" && inputs.branch == "main"',
  );
  assertEquals(result, { valid: true });
});

Deno.test("validateWorkflowRunFilter: startedAt string comparison", () => {
  const result = validateWorkflowRunFilter('startedAt > "2026-08-01"');
  assertEquals(result, { valid: true });
});

Deno.test("validateWorkflowRunFilter: matches with literal pattern", () => {
  const result = validateWorkflowRunFilter(
    'workflowName.matches("verify-.*")',
  );
  assertEquals(result, { valid: true });
});

// --- Validation: invalid expressions ---

Deno.test("validateWorkflowRunFilter: syntax error", () => {
  const result = validateWorkflowRunFilter("status ==");
  assertEquals(result.valid, false);
  assertStringIncludes(result.error!, "CEL syntax error");
});

Deno.test("validateWorkflowRunFilter: unknown variable", () => {
  const result = validateWorkflowRunFilter('nonexistent == "foo"');
  assertEquals(result.valid, false);
  assertStringIncludes(result.error!, "CEL type error");
});

Deno.test("validateWorkflowRunFilter: exceeds max length", () => {
  const longFilter = "a".repeat(MAX_FILTER_LENGTH + 1);
  const result = validateWorkflowRunFilter(longFilter);
  assertEquals(result.valid, false);
  assertStringIncludes(result.error!, "maximum length");
});

Deno.test("validateWorkflowRunFilter: matches with dynamic pattern rejected", () => {
  const result = validateWorkflowRunFilter(
    "workflowName.matches(status)",
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.error!, "string literal");
});

Deno.test("validateWorkflowRunFilter: catastrophic backtracking pattern rejected", () => {
  const result = validateWorkflowRunFilter(
    'workflowName.matches("(a+)+")',
  );
  assertEquals(result.valid, false);
  assertStringIncludes(result.error!, "catastrophic backtracking");
});

// --- Evaluation: matching ---

Deno.test("evaluateWorkflowRunFilter: matches on status", () => {
  assertEquals(
    evaluateWorkflowRunFilter('status == "succeeded"', RUN),
    true,
  );
});

Deno.test("evaluateWorkflowRunFilter: matches on inputs.commit", () => {
  assertEquals(
    evaluateWorkflowRunFilter('inputs.commit == "b3ff3a8a"', RUN),
    true,
  );
});

Deno.test("evaluateWorkflowRunFilter: matches on tags.env", () => {
  assertEquals(
    evaluateWorkflowRunFilter('tags.env == "ci"', RUN),
    true,
  );
});

Deno.test("evaluateWorkflowRunFilter: matches on duration comparison", () => {
  assertEquals(
    evaluateWorkflowRunFilter("duration > 60000", RUN),
    true,
  );
});

Deno.test("evaluateWorkflowRunFilter: matches on compound expression", () => {
  assertEquals(
    evaluateWorkflowRunFilter(
      'status == "succeeded" && inputs.branch == "feature/foo"',
      RUN,
    ),
    true,
  );
});

Deno.test("evaluateWorkflowRunFilter: matches on workflowName", () => {
  assertEquals(
    evaluateWorkflowRunFilter('workflowName == "verify-reviews"', RUN),
    true,
  );
});

Deno.test("evaluateWorkflowRunFilter: startedAt lexicographic comparison", () => {
  assertEquals(
    evaluateWorkflowRunFilter('startedAt > "2026-08-01"', RUN),
    true,
  );
  assertEquals(
    evaluateWorkflowRunFilter('startedAt > "2026-09-01"', RUN),
    false,
  );
});

// --- Evaluation: non-matching ---

Deno.test("evaluateWorkflowRunFilter: does not match wrong status", () => {
  assertEquals(
    evaluateWorkflowRunFilter('status == "failed"', RUN),
    false,
  );
});

Deno.test("evaluateWorkflowRunFilter: does not match wrong input", () => {
  assertEquals(
    evaluateWorkflowRunFilter('inputs.commit == "deadbeef"', RUN),
    false,
  );
});

// --- Evaluation: missing optional fields ---

Deno.test("evaluateWorkflowRunFilter: missing optional fields default to empty", () => {
  const minimalRun: WorkflowRunFilterContext = {
    workflowName: "deploy",
    status: "running",
  };
  assertEquals(
    evaluateWorkflowRunFilter('workflowName == "deploy"', minimalRun),
    true,
  );
  assertEquals(
    evaluateWorkflowRunFilter("duration == 0.0", minimalRun),
    true,
  );
  assertEquals(
    evaluateWorkflowRunFilter('startedAt == ""', minimalRun),
    true,
  );
});

// --- Evaluation: non-boolean result returns false ---

Deno.test("evaluateWorkflowRunFilter: non-boolean result returns false", () => {
  assertEquals(
    evaluateWorkflowRunFilter("status", RUN),
    false,
  );
});
