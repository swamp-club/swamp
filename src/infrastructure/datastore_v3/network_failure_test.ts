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
import { isNetworkFailure } from "./network_failure.ts";

/** A Node-style error with a `code`, as the AWS SDK's transport throws. */
function coded(code: string, message = `connect ${code}`): Error {
  return Object.assign(new Error(message), { code });
}

/** The S3 extension's wrapper: its own message, the transport as `cause`. */
function s3Wrapped(cause: unknown, name = "Error"): Error {
  const error = new Error("S3 headObject failed key=_blobs/x", { cause });
  error.name = name;
  return error;
}

Deno.test("isNetworkFailure: an S3 connection refusal, as the extension wraps it", () => {
  assertEquals(isNetworkFailure(s3Wrapped(coded("ECONNREFUSED"))), true);
});

Deno.test("isNetworkFailure: an S3 refusal on every address of a host, as an AggregateError", () => {
  const aggregate = Object.assign(
    new AggregateError([coded("ECONNREFUSED"), coded("ECONNREFUSED")]),
    { code: "ECONNREFUSED" },
  );
  assertEquals(
    isNetworkFailure(s3Wrapped(aggregate, "AggregateError")),
    true,
  );
});

Deno.test("isNetworkFailure: a lookup failure and a request timeout", () => {
  assertEquals(isNetworkFailure(s3Wrapped(coded("ENOTFOUND"))), true);
  const timeout = coded("ETIMEDOUT", "requestTimeout exceeded");
  timeout.name = "TimeoutError";
  assertEquals(isNetworkFailure(s3Wrapped(timeout, "TimeoutError")), true);
  assertEquals(
    isNetworkFailure(new DOMException("timed out", "TimeoutError")),
    true,
  );
});

Deno.test("isNetworkFailure: GCS's fetch failure, by fetch's TypeError and its cause", () => {
  const fetchFailed = new TypeError("fetch failed", {
    cause: new Error(
      "error sending request for url (http://localhost:9/x): client error (Connect): tcp connect error: Connection refused (os error 61)",
    ),
  });
  const wrapped = new Error(
    "GCS getMetadata transport failure — fetch failed",
    {
      cause: fetchFailed,
    },
  );
  wrapped.name = "TypeError";
  assertEquals(isNetworkFailure(wrapped), true);
});

Deno.test("isNetworkFailure: Deno's own connection errors", () => {
  assertEquals(
    isNetworkFailure(new Deno.errors.ConnectionRefused("refused")),
    true,
  );
  assertEquals(isNetworkFailure(new Deno.errors.TimedOut("timed out")), true);
});

Deno.test("isNetworkFailure: an answered request, a cancel and a bug are not network failures", () => {
  const forbidden = Object.assign(new Error("S3 headObject failed HTTP 403"), {
    httpStatusCode: 403,
  });
  assertEquals(isNetworkFailure(forbidden), false);
  assertEquals(
    isNetworkFailure(new DOMException("aborted", "AbortError")),
    false,
  );
  assertEquals(
    isNetworkFailure(
      new TypeError("Cannot read properties of undefined (reading 'x')"),
    ),
    false,
  );
  assertEquals(isNetworkFailure("ECONNREFUSED"), false);
  assertEquals(isNetworkFailure(undefined), false);
});

Deno.test("isNetworkFailure: an AggregateError counts only when every error in it does", () => {
  assertEquals(
    isNetworkFailure(
      new AggregateError([coded("ECONNREFUSED"), new Error("disk full")]),
    ),
    false,
  );
  assertEquals(isNetworkFailure(new AggregateError([])), false);
});
