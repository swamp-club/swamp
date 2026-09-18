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
import { determineVerdict, formatGateVerdict } from "./check_review_verdict.ts";

Deno.test("determineVerdict: an explicit pass marker passes", () => {
  const output = "VERDICT: pass\n\nNo blocking findings. The diff is clean.";
  assertEquals(determineVerdict(output), { kind: "pass" });
});

Deno.test("determineVerdict: an explicit fail marker fails", () => {
  const output = "VERDICT: fail\n\nBlocking: the new path is unreachable.";
  assertEquals(determineVerdict(output), { kind: "fail" });
});

Deno.test("determineVerdict: blocking findings in prose without a marker are missing, not a pass", () => {
  // Verbatim from the run recorded in swamp-club#2265. The harness inferred a
  // pass from this and the workflow reported success: the word "blocking"
  // appears in a sentence rather than as a `Blocking:` label, so the severity
  // regex never matched. This is the exact output that must never pass again.
  const output =
    "Two blocking findings reported. The skill file changes are good, but the " +
    "`pushDataChanges` removal is a correctness regression that would cause data " +
    "mutations to silently fail to sync to the remote datastore.";
  assertEquals(determineVerdict(output), {
    kind: "missing",
    reason: "no-marker",
  });
});

Deno.test("determineVerdict: a clean review without a marker is missing, not a pass", () => {
  // The benign twin of the case above. Both were inferred as passes; both are
  // now failures, because a reviewer that skips the format is a human's call.
  const output =
    "No blocking findings. The diff is clean — well-tested, follows codebase " +
    "conventions, and handles errors properly across all paths.";
  assertEquals(determineVerdict(output), {
    kind: "missing",
    reason: "no-marker",
  });
});

Deno.test("determineVerdict: a marker mentioned mid-line does not score the review", () => {
  const output =
    "I could not decide whether to emit VERDICT: pass or VERDICT: fail for this " +
    "change, because the diff touches code I was unable to read in full.";
  assertEquals(determineVerdict(output), {
    kind: "missing",
    reason: "no-marker",
  });
});

Deno.test("determineVerdict: the first line-initial marker wins over a later one", () => {
  const output =
    "VERDICT: fail\n\nThe change is unsafe. A prior review of this file recorded\n" +
    "VERDICT: pass, but it reviewed a different diff.";
  assertEquals(determineVerdict(output), { kind: "fail" });
});

Deno.test("determineVerdict: markdown emphasis around the marker is tolerated", () => {
  // The shell pattern this replaced accepted emphasised markers; reviewers do
  // emit them, and dropping that tolerance would turn passes into failures.
  for (
    const output of [
      "**VERDICT: pass**\n\nNo blocking findings anywhere in the diff.",
      "**VERDICT:** **pass**\n\nNo blocking findings anywhere in the diff.",
      "   VERDICT: **pass**\n\nNo blocking findings anywhere in the diff.",
    ]
  ) {
    assertEquals(determineVerdict(output), { kind: "pass" }, output);
  }
});

Deno.test("determineVerdict: a lowercase marker is tolerated", () => {
  const output = "verdict: pass\n\nNo blocking findings in the reviewed diff.";
  assertEquals(determineVerdict(output), { kind: "pass" });
});

Deno.test("determineVerdict: empty and trivially short output is reported as empty", () => {
  for (const output of ["", "\n", "ok", "No findings."]) {
    assertEquals(
      determineVerdict(output),
      { kind: "missing", reason: "empty-output" },
      JSON.stringify(output),
    );
  }
});

Deno.test("determineVerdict: provider errors are detected before any verdict", () => {
  // These mean no review ran. A provider error that happened to carry a pass
  // marker must still fail, so the check runs first.
  for (
    const message of [
      "You have hit your weekly limit for this model.",
      "hit your daily limit",
      "hit your monthly limit",
      '{"type":"rate_limit_error","message":"slow down"}',
      '{"type":"overloaded_error"}',
      '{"type":"authentication_error"}',
      "invalid_api_key supplied",
      "Your credit balance is too low to run this request.",
      "You have exceeded your monthly quota for this workspace.",
    ]
  ) {
    assertEquals(
      determineVerdict(message),
      { kind: "provider-error" },
      message,
    );
  }
});

Deno.test("determineVerdict: a provider error outranks an explicit pass marker", () => {
  const output =
    "VERDICT: pass\n\nreview aborted: rate_limit_error returned by the provider";
  assertEquals(determineVerdict(output), { kind: "provider-error" });
});

Deno.test("formatGateVerdict: renders the gate's decision for the log", () => {
  assertEquals(formatGateVerdict({ kind: "pass" }), "GATE_VERDICT: pass");
  assertEquals(formatGateVerdict({ kind: "fail" }), "GATE_VERDICT: fail");
  assertEquals(
    formatGateVerdict({ kind: "missing", reason: "no-marker" }),
    "GATE_VERDICT: missing",
  );
  assertEquals(
    formatGateVerdict({ kind: "provider-error" }),
    "GATE_VERDICT: provider-error",
  );
});
