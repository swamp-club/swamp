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

import {
  assertEquals,
  assertFalse,
  assertInstanceOf,
  assertStringIncludes,
} from "@std/assert";
import { UserError } from "../errors.ts";
import {
  DataVersionConflictError,
  HydrateContractViolationError,
  isUnpublishedDataError,
  ModelLockLostError,
  SyncTimeoutError,
  UnpublishedDataVersionError,
} from "./datastore_sync_service.ts";

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

Deno.test("HydrateContractViolationError: message names the datastore, relPath and absPath", () => {
  const err = new HydrateContractViolationError(
    "@swamp/s3-datastore",
    "ns/data/a/b/1/raw",
    "/cache/ns/data/a/b/1/raw",
  );
  assertStringIncludes(err.message, "@swamp/s3-datastore");
  assertStringIncludes(
    err.message,
    "hydrateFile success for ns/data/a/b/1/raw",
  );
  assertStringIncludes(
    err.message,
    "no file exists at /cache/ns/data/a/b/1/raw",
  );
  assertEquals(err.relPath, "ns/data/a/b/1/raw");
  assertEquals(err.absPath, "/cache/ns/data/a/b/1/raw");
  assertEquals(err.datastoreType, "@swamp/s3-datastore");
});

Deno.test("HydrateContractViolationError: is a UserError with its own name and code", () => {
  const err = new HydrateContractViolationError("t", "r", "a");
  assertEquals(err instanceof UserError, true);
  assertEquals(err.name, "HydrateContractViolationError");
  assertEquals(err.code, "datastore_hydrate_contract_violation");
});

Deno.test("ModelLockLostError: names each model, its current holder, and says nothing was pushed", () => {
  const err = new ModelLockLostError([
    {
      modelType: "aws/s3",
      modelId: "a1",
      heldBy: { holder: "sam@ci", pid: 42 },
    },
    { modelType: "aws/s3", modelId: "a2" },
  ]);
  assertEquals(err instanceof UserError, true);
  assertEquals(err.name, "ModelLockLostError");
  assertEquals(err.code, "model_lock_lost");
  assertStringIncludes(err.message, "aws/s3/a1 (now held by sam@ci, pid 42)");
  assertStringIncludes(err.message, "aws/s3/a2 (now released)");
  assertStringIncludes(err.message, "force-released or taken over");
  assertStringIncludes(err.message, "Nothing was pushed");
  assertStringIncludes(err.message, "version.\nNothing was pushed");
  assertStringIncludes(err.message, "data was discarded from this host");
  assertStringIncludes(err.message, "refreshed from the datastore when it");
  assertStringIncludes(err.message, "Run the method or workflow again");
});

Deno.test("UnpublishedDataVersionError: names the versions and the causes left once the last push runs alone (swamp-club#3860)", () => {
  const err = new UnpublishedDataVersionError([{
    modelType: "command/shell",
    modelId: "m1",
    dataName: "report",
    version: 72,
  }], 3);
  assertInstanceOf(err, UserError);
  assertEquals(err.code, "datastore_unpublished_data_version");
  assertEquals(err.versions.map((v) => v.version), [72]);
  assertStringIncludes(
    err.message,
    "does not hold command/shell/m1 report version 72 after 3 push attempts",
  );
  assertStringIncludes(
    err.message,
    "another swamp process using this repository (a workflow run or swamp serve)",
  );
  assertStringIncludes(err.message, "once that process has finished");
  assertStringIncludes(err.message, "did not keep the uploaded files");
  assertEquals(err.message.includes("serve poller"), false);
  assertStringIncludes(err.message, "The data is on this host only");
});

Deno.test("isUnpublishedDataError: matches the two push refusals and nothing else", () => {
  assertEquals(
    isUnpublishedDataError(
      new ModelLockLostError([{ modelType: "t", modelId: "m" }]),
    ),
    true,
  );
  assertEquals(
    isUnpublishedDataError(
      new UnpublishedDataVersionError([{
        modelType: "t",
        modelId: "m",
        dataName: "d",
        version: 1,
      }], 3),
    ),
    true,
  );
  assertEquals(isUnpublishedDataError(new UserError("other")), false);
  assertEquals(isUnpublishedDataError(undefined), false);
});

Deno.test("DataVersionConflictError: carries and names a failure publishing the run's other data (swamp-club#3934)", () => {
  const version = {
    modelType: "t/x",
    modelId: "m-1",
    dataName: "main",
    version: 1,
  };
  const alone = new DataVersionConflictError([version]);
  assertEquals(alone.publishFailure, undefined);
  assertFalse(alone.message.includes("failed too"));

  const failure = new Error("push failed");
  const both = new DataVersionConflictError([version], {
    publishFailure: failure,
  });
  assertEquals(both.publishFailure, failure);
  assertStringIncludes(both.message, "t/x/m-1 main version 1");
  assertStringIncludes(
    both.message,
    "Publishing the run's other data failed too: push failed",
  );
});
