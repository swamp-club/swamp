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
  checkRetentionConfig,
  RetentionPolicy,
  withoutIgnored,
} from "./retention_policy.ts";

const DAY = 86_400_000;

Deno.test("RetentionPolicy.retentionMs: a kind's own key wins over retention", () => {
  const policy = RetentionPolicy.fromConfig({
    retention: "30d",
    workflowRuns: "7d",
  });
  assertEquals(policy.retentionMs("workflowRuns"), 7 * DAY);
  assertEquals(policy.retentionMs("outputs"), 30 * DAY);
});

Deno.test("RetentionPolicy.retentionMs: an override wins over every key", () => {
  const policy = RetentionPolicy.fromConfig({
    retention: "30d",
    workflowRuns: "7d",
  });
  assertEquals(policy.retentionMs("workflowRuns", DAY), DAY);
});

Deno.test("RetentionPolicy.retentionMs: a kind with no value is undefined", () => {
  const policy = RetentionPolicy.fromConfig({ workflowRuns: "7d" });
  assertEquals(policy.retentionMs("data"), undefined);
  assertEquals(RetentionPolicy.fromConfig(undefined).hasAnyRetention, false);
  assertEquals(policy.hasAnyRetention, true);
});

Deno.test("RetentionPolicy.cutoff: subtracts the retention from now", () => {
  const now = new Date("2026-10-15T12:00:00.000Z");
  const policy = RetentionPolicy.fromConfig({ outputs: "1d" });
  assertEquals(
    policy.cutoff("outputs", now)?.toISOString(),
    "2026-10-14T12:00:00.000Z",
  );
  assertEquals(policy.cutoff("audit", now), undefined);
});

Deno.test("RetentionPolicy.automatic: only the literal true turns it on", () => {
  assertEquals(RetentionPolicy.fromConfig({ automatic: true }).automatic, true);
  assertEquals(RetentionPolicy.fromConfig({}).automatic, false);
  assertEquals(
    RetentionPolicy.fromConfig({ automatic: false }).automatic,
    false,
  );
});

Deno.test("checkRetentionConfig: accepts the full block", () => {
  const result = checkRetentionConfig({
    retention: "30d",
    automatic: true,
    workflowRuns: "14d",
    evaluatedSnapshots: "3d",
    outputs: "7d",
    data: "30d",
    audit: "90d",
    bookkeeping: "24h",
  });
  assertEquals(result, { errors: [], ignored: [], unknownKeys: [] });
});

Deno.test("checkRetentionConfig: reports unknown keys without refusing them", () => {
  const result = checkRetentionConfig({ workflowRuns: "7d", runs: "1d" });
  assertEquals(result.errors, []);
  assertEquals(result.unknownKeys, ["runs"]);
});

Deno.test("checkRetentionConfig: refuses a bad workflowRuns or outputs, as before", () => {
  for (const value of ["0d", "never", "7", 7]) {
    for (const field of ["workflowRuns", "outputs"]) {
      const { errors, ignored } = checkRetentionConfig({ [field]: value });
      assertEquals(errors.map((e) => e.field), [field], String(value));
      assertEquals(ignored, []);
    }
  }
});

Deno.test("checkRetentionConfig: ignores a bad value in a newly recognised key", () => {
  for (const value of ["0d", "never", "7", 7]) {
    const { errors, ignored } = checkRetentionConfig({ data: value });
    assertEquals(errors, [], `value ${String(value)}`);
    assertEquals(ignored.map((e) => e.field), ["data"]);
  }
});

Deno.test("checkRetentionConfig: ignores a non-boolean automatic", () => {
  const { errors, ignored } = checkRetentionConfig({ automatic: "yes" });
  assertEquals(errors, []);
  assertEquals(ignored.map((e) => e.field), ["automatic"]);
});

Deno.test("checkRetentionConfig: ignores snapshots kept longer than their runs", () => {
  const explicit = checkRetentionConfig({
    workflowRuns: "7d",
    evaluatedSnapshots: "14d",
  });
  assertEquals(explicit.errors, []);
  assertEquals(explicit.ignored.map((e) => e.field), ["evaluatedSnapshots"]);
  // The run retention can come from the default.
  const inherited = checkRetentionConfig({
    retention: "7d",
    evaluatedSnapshots: "14d",
  });
  assertEquals(inherited.ignored.map((e) => e.field), ["evaluatedSnapshots"]);
  // With no run retention at all, runs are kept forever.
  assertEquals(
    checkRetentionConfig({ evaluatedSnapshots: "14d" }).ignored,
    [],
  );
});

Deno.test("checkRetentionConfig: refuses a block that is not a mapping", () => {
  for (const value of ["7d", [], null]) {
    const { errors } = checkRetentionConfig(value);
    assertEquals(errors.length, 1);
    assertEquals(errors[0].field, undefined);
  }
  assertEquals(checkRetentionConfig(undefined).errors, []);
});

Deno.test("checkRetentionConfig: accepts a longer default with shorter runs when snapshots are unset", () => {
  assertEquals(
    checkRetentionConfig({ retention: "30d", workflowRuns: "7d" }).errors,
    [],
  );
});

Deno.test("RetentionPolicy.durationFor: unset snapshots follow the run retention", () => {
  const policy = RetentionPolicy.fromConfig({
    retention: "30d",
    workflowRuns: "7d",
  });
  assertEquals(policy.durationFor("evaluatedSnapshots"), "7d");
  assertEquals(
    RetentionPolicy.fromConfig({ workflowRuns: "7d" }).durationFor(
      "evaluatedSnapshots",
    ),
    "7d",
  );
  assertEquals(
    RetentionPolicy.fromConfig({ workflowRuns: "7d", evaluatedSnapshots: "2d" })
      .durationFor("evaluatedSnapshots"),
    "2d",
  );
});

Deno.test("checkRetentionConfig: holds a retention too long for a date at 1000y, legacy keys included", () => {
  for (const field of ["retention", "workflowRuns"]) {
    const config = { [field]: "300000y" };
    const { errors, ignored } = checkRetentionConfig(config);
    assertEquals(errors, []);
    assertEquals(ignored.map((e) => [e.field, e.replacement]), [
      [field, "1000y"],
    ]);
    assertEquals(withoutIgnored(config, ignored), { [field]: "1000y" });
  }
  assertEquals(checkRetentionConfig({ retention: "1000y" }).ignored, []);
});

Deno.test("RetentionPolicy.cutoff: an unrepresentable cutoff means no retention", () => {
  const policy = RetentionPolicy.fromConfig({ retention: "300000y" });
  assertEquals(policy.cutoff("workflowRuns", new Date()), undefined);
});

Deno.test("RetentionPolicy.durationFor: data never follows the shared default", () => {
  const policy = RetentionPolicy.fromConfig({ retention: "30d" });
  assertEquals(policy.durationFor("data"), undefined);
  assertEquals(policy.durationFor("outputs"), "30d");
  assertEquals(
    RetentionPolicy.fromConfig({ retention: "30d", data: "90d" }).durationFor(
      "data",
    ),
    "90d",
  );
});
