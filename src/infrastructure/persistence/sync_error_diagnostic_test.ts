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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { summarizeSyncError } from "./sync_error_diagnostic.ts";

Deno.test("summarizeSyncError: plain Error with message", () => {
  const err = new Error("boom");
  const { summary, fields } = summarizeSyncError(
    "pull",
    "@swamp/s3-datastore",
    err,
  );
  assertEquals(summary, "@swamp/s3-datastore pull failed: boom");
  assertEquals(fields, {
    operation: "pull",
    label: "@swamp/s3-datastore",
    name: "Error",
    message: "boom",
  });
});

Deno.test("summarizeSyncError: AWS-SDK-style opaque error with full $metadata", () => {
  const err = new Error("UnknownError") as Error & {
    Code: string;
    $metadata: { httpStatusCode: number; requestId: string };
  };
  err.name = "UnknownError";
  err.Code = "AccessDenied";
  err.$metadata = { httpStatusCode: 403, requestId: "ABC" };

  const { summary, fields } = summarizeSyncError(
    "pull",
    "@swamp/s3-datastore",
    err,
  );
  assertStringIncludes(summary, "@swamp/s3-datastore pull failed");
  assertStringIncludes(summary, "HTTP 403");
  assertStringIncludes(summary, "requestId=ABC");
  assertStringIncludes(summary, "code=AccessDenied");
  assertEquals(fields, {
    operation: "pull",
    label: "@swamp/s3-datastore",
    httpStatusCode: 403,
    requestId: "ABC",
    code: "AccessDenied",
    name: "UnknownError",
    message: "UnknownError",
  });
});

Deno.test("summarizeSyncError: push operation reflected in summary", () => {
  const { summary, fields } = summarizeSyncError(
    "push",
    "@myorg/custom",
    new Error("x"),
  );
  assertStringIncludes(summary, "push failed");
  assertEquals(fields.operation, "push");
});

Deno.test("summarizeSyncError: lowercase `code` field also recognized", () => {
  const err = { code: "ETIMEDOUT", message: "timed out" };
  const { fields } = summarizeSyncError("push", "@myorg/x", err);
  assertEquals(fields.code, "ETIMEDOUT");
});

Deno.test("summarizeSyncError: `Code` preferred over `code` when both present", () => {
  const err = { Code: "AwsCode", code: "etimedout", message: "x" };
  const { fields } = summarizeSyncError("push", "@myorg/x", err);
  assertEquals(fields.code, "AwsCode");
});

Deno.test("summarizeSyncError: string error", () => {
  const { summary, fields } = summarizeSyncError("pull", "@t/x", "oops");
  assertStringIncludes(summary, "@t/x pull failed");
  assertStringIncludes(summary, "oops");
  assertEquals(fields.message, "oops");
});

Deno.test("summarizeSyncError: number error", () => {
  const { fields } = summarizeSyncError("pull", "@t/x", 42);
  assertEquals(fields.message, "42");
});

Deno.test("summarizeSyncError: null error — only operation+label present", () => {
  const { summary, fields } = summarizeSyncError("pull", "@t/x", null);
  assertEquals(summary, "@t/x pull failed");
  assertEquals(fields, { operation: "pull", label: "@t/x" });
});

Deno.test("summarizeSyncError: undefined error — only operation+label present", () => {
  const { summary, fields } = summarizeSyncError("push", "@t/x", undefined);
  assertEquals(summary, "@t/x push failed");
  assertEquals(fields, { operation: "push", label: "@t/x" });
});

Deno.test("summarizeSyncError: plain object error with no message", () => {
  const err = { Code: "X", $metadata: { httpStatusCode: 500 } };
  const { summary, fields } = summarizeSyncError("pull", "@t/x", err);
  assertStringIncludes(summary, "HTTP 500");
  assertStringIncludes(summary, "code=X");
  assertEquals(fields.httpStatusCode, 500);
  assertEquals(fields.code, "X");
  assertEquals(fields.message, undefined);
});

Deno.test("summarizeSyncError: empty message treated as missing", () => {
  const err = new Error("");
  const { summary, fields } = summarizeSyncError("pull", "@t/x", err);
  // Falls back to the error name ("Error") as trailer.
  assertStringIncludes(summary, ": Error");
  assertEquals(fields.message, undefined);
});

Deno.test("summarizeSyncError: long message truncated at 200 chars with ellipsis", () => {
  const long = "a".repeat(500);
  const err = new Error(long);
  const { summary, fields } = summarizeSyncError("pull", "@t/x", err);
  // `fields.message` retains the full message for consumers that want it
  // (e.g. .cause-walking renderers); only the summary is truncated.
  assertEquals(fields.message, long);
  // Summary contains exactly 200 'a's followed by ellipsis.
  assertStringIncludes(summary, "a".repeat(200) + "…");
  // Summary does NOT contain the 201st 'a' because it was truncated.
  const after = summary.split("a".repeat(200))[1] ?? "";
  assertEquals(after.startsWith("a"), false);
});

Deno.test("summarizeSyncError: throwing getters on read fields don't break extraction", () => {
  // The helper reads .message, .name, .Code, .code, and .$metadata.
  // Simulate a proxy whose getter throws for `message` and `name` (the
  // two most likely fields with exotic getters in SDK-style errors).
  // Other fields must still be extracted normally — no unhandled throw.
  const target = {
    Code: "AccessDenied",
    $metadata: { httpStatusCode: 403, requestId: "R1" },
  };
  const err = new Proxy(target, {
    get(t, p) {
      if (p === "message" || p === "name") throw new Error("getter exploded");
      return (t as Record<string | symbol, unknown>)[p];
    },
  });

  const { summary, fields } = summarizeSyncError("pull", "@t/x", err);

  // Safe fields still extracted.
  assertEquals(fields.httpStatusCode, 403);
  assertEquals(fields.requestId, "R1");
  assertEquals(fields.code, "AccessDenied");
  // Throwing fields are treated as missing, not surfaced as errors.
  assertEquals(fields.message, undefined);
  assertEquals(fields.name, undefined);
  // Summary still renders without the throwing fields.
  assertStringIncludes(summary, "@t/x pull failed");
  assertStringIncludes(summary, "HTTP 403");
  assertStringIncludes(summary, "code=AccessDenied");
});

Deno.test("summarizeSyncError: throwing $metadata getter is safe", () => {
  const target = { message: "real", Code: "X" };
  const err = new Proxy(target, {
    get(t, p) {
      if (p === "$metadata") throw new Error("boom");
      return (t as Record<string | symbol, unknown>)[p];
    },
  });
  const { fields } = summarizeSyncError("pull", "@t/x", err);
  assertEquals(fields.message, "real");
  assertEquals(fields.code, "X");
  assertEquals(fields.httpStatusCode, undefined);
  assertEquals(fields.requestId, undefined);
});

Deno.test("summarizeSyncError: non-numeric httpStatusCode is ignored", () => {
  const err = { $metadata: { httpStatusCode: "403" }, message: "x" };
  const { fields } = summarizeSyncError("pull", "@t/x", err);
  assertEquals(fields.httpStatusCode, undefined);
});

Deno.test("summarizeSyncError: summary is always single-line", () => {
  const err = new Error("line1\nline2\nline3") as Error & { Code: string };
  err.Code = "X";
  const { summary } = summarizeSyncError("pull", "@t/x", err);
  // We don't strip newlines from the raw message (preserves fidelity in
  // fields.message), but the rendered summary is used as an Error.message
  // which most consumers treat as opaque text. Assert the preamble and
  // structural delimiters are on the first line.
  const firstLine = summary.split("\n")[0];
  assertStringIncludes(firstLine, "@t/x pull failed");
  assertStringIncludes(firstLine, "code=X");
});

Deno.test("summarizeSyncError: missing optional fields are absent from `fields`", () => {
  const { fields } = summarizeSyncError("pull", "@t/x", {});
  assertEquals(Object.keys(fields).sort(), ["label", "operation"]);
});
