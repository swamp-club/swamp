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
import { UserError } from "../errors.ts";
import { SyncTimeoutError } from "./datastore_sync_service.ts";

Deno.test("SyncTimeoutError: message includes direction, label, and timeout", () => {
  const err = new SyncTimeoutError("@swamp/s3-datastore", "push", 300_000);
  assertStringIncludes(err.message, "push");
  assertStringIncludes(err.message, "@swamp/s3-datastore");
  assertStringIncludes(err.message, "300000ms");
});

Deno.test("SyncTimeoutError: message lists all four remedies", () => {
  const err = new SyncTimeoutError("@swamp/s3-datastore", "pull", 300_000);
  // Remedy 1: env var (universal — applies to implicit and explicit sync alike).
  // Ordered first because most timeout firings happen on implicit sync after
  // write commands, where --timeout is not available.
  assertStringIncludes(err.message, "SWAMP_DATASTORE_SYNC_TIMEOUT_MS");
  // Remedy 2: --timeout flag, scoped to `swamp datastore sync` only.
  assertStringIncludes(err.message, "--timeout");
  // Remedy 3: extension update (version-free wording — "the latest extension",
  // not a specific version that would rot across releases).
  assertStringIncludes(err.message, "latest extension");
  // Remedy 4: stuck-lock release.
  assertStringIncludes(err.message, "swamp datastore lock release --force");
});

Deno.test("SyncTimeoutError: --timeout remedy is scoped to 'swamp datastore sync'", () => {
  // The timeout fires from `flushDatastoreSync()` after every command, not
  // just explicit `swamp datastore sync`. A user running e.g. `swamp model
  // run` who hits the timeout will see `--timeout` in the remedies but the
  // flag is not available on their command. The message must make the
  // scope unambiguous so they do not fruitlessly try `swamp model run
  // --timeout ...` and hit "unknown flag".
  const err = new SyncTimeoutError("@swamp/s3-datastore", "push", 300_000);
  assertStringIncludes(err.message, "swamp datastore sync");
  // The env var hint must also mention that it covers implicit syncs —
  // that is the real escape hatch for non-sync commands.
  assertStringIncludes(err.message, "implicit");
});

Deno.test("SyncTimeoutError: extension-update hint does not hardcode a version", () => {
  const err = new SyncTimeoutError("@swamp/s3-datastore", "push", 60_000);
  // Pin the version-free contract: no `YYYY.MM.DD` or `N.N.N` in the message.
  // Any version string would rot every time the extension ships.
  const calendarVersion = /\b20\d{2}\.\d{2}\.\d{2}\b/;
  const semver = /\bv?\d+\.\d+\.\d+\b/;
  assertEquals(
    calendarVersion.test(err.message),
    false,
    "message must not hardcode a calendar-version; use version-free wording",
  );
  assertEquals(
    semver.test(err.message),
    false,
    "message must not hardcode a semver; use version-free wording",
  );
});

Deno.test("SyncTimeoutError: is a UserError", () => {
  const err = new SyncTimeoutError("@swamp/s3-datastore", "push", 1000);
  assertEquals(err instanceof UserError, true);
  assertEquals(err.name, "SyncTimeoutError");
});

Deno.test("SyncTimeoutError: preserves structured fields", () => {
  const cause = new Error("underlying network failure");
  const err = new SyncTimeoutError(
    "@swamp/gcs-datastore",
    "pull",
    120_000,
    { cause },
  );
  assertEquals(err.label, "@swamp/gcs-datastore");
  assertEquals(err.direction, "pull");
  assertEquals(err.timeoutMs, 120_000);
  assertEquals(err.cause, cause);
});

Deno.test("SyncTimeoutError: multi-line message round-trips through JSON", () => {
  // Pins the contract that the --json output path preserves the enriched
  // message verbatim. A future renderer that tries to collapse whitespace
  // or strip newlines would break this assertion.
  const err = new SyncTimeoutError("@swamp/s3-datastore", "push", 300_000);
  const serialized = JSON.stringify({ error: err.message });
  const roundTripped = JSON.parse(serialized) as { error: string };
  assertEquals(roundTripped.error, err.message);
  // Newlines survive the round-trip as `\n` — not stripped, not collapsed.
  assertEquals(roundTripped.error.includes("\n"), true);
});
