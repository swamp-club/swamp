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

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { rejectUnknownKeys } from "./unknown_keys.ts";

const JOB_KEYS = [
  "name",
  "description",
  "steps",
  "dependsOn",
  "weight",
  "concurrency",
  "target",
  "labels",
  "platform",
  "queueTimeout",
];

Deno.test("rejectUnknownKeys: passes through objects with only known keys", () => {
  const hook = rejectUnknownKeys("job", JOB_KEYS);
  const data = { name: "build", steps: [], weight: 1 };
  assertEquals(hook(data), data);
});

Deno.test("rejectUnknownKeys: passes through non-object values", () => {
  const hook = rejectUnknownKeys("job", JOB_KEYS);
  assertEquals(hook(null), null);
  assertEquals(hook(undefined), undefined);
  assertEquals(hook("string"), "string");
  assertEquals(hook(42), 42);
  const arr = [{ unknown: true }];
  assertEquals(hook(arr), arr);
});

Deno.test("rejectUnknownKeys: accepts placement keys on job", () => {
  const hook = rejectUnknownKeys("job", JOB_KEYS);
  const data = {
    name: "placed",
    labels: { fb28: "probe" },
    target: "w1",
    platform: "linux",
    queueTimeout: 30,
    steps: [],
  };
  assertEquals(hook(data), data);
});

Deno.test("rejectUnknownKeys: accepts placement keys on workflow", () => {
  const WORKFLOW_KEYS = [
    "name",
    "jobs",
    "target",
    "labels",
    "platform",
    "queueTimeout",
  ];
  const hook = rejectUnknownKeys("workflow", WORKFLOW_KEYS);
  for (const key of ["labels", "target", "platform", "queueTimeout"]) {
    const data = { name: "wf", jobs: [], [key]: "x" };
    assertEquals(hook(data), data);
  }
});

Deno.test("rejectUnknownKeys: placement keys on a step get the generic unknown-key message", () => {
  // 'labels' etc. ARE step keys; a hook for steps must never see them as
  // unknown. But if a placement-adjacent typo appears, it is a plain
  // unknown key with a suggestion — not the misplaced-property message.
  const hook = rejectUnknownKeys("step", ["name", "task", "labels"]);
  const error = assertThrows(
    () => hook({ name: "echo", task: {}, lables: { a: "b" } }),
    Error,
  );
  assertStringIncludes(error.message, "Unknown key 'lables' on step 'echo'");
  assertStringIncludes(error.message, "Did you mean 'labels'?");
});

Deno.test("rejectUnknownKeys: unknown key without close match lists valid keys", () => {
  const hook = rejectUnknownKeys("job", JOB_KEYS);
  const error = assertThrows(
    () => hook({ name: "build", steps: [], zzz_bogus_zzz: 1 }),
    Error,
  );
  assertStringIncludes(error.message, "Unknown key 'zzz_bogus_zzz'");
  assertStringIncludes(
    error.message,
    "Valid job keys: name, description, steps, dependsOn, weight, concurrency, target, labels, platform, queueTimeout",
  );
});

Deno.test("rejectUnknownKeys: leaves driver/driverConfig for the removed-fields hook", () => {
  const hook = rejectUnknownKeys("job", JOB_KEYS);
  const data = { name: "build", steps: [], driver: "docker" };
  // Must pass through so rejectRemovedDriverFields (chained first in the
  // schemas) produces its specific migration message.
  assertEquals(hook(data), data);
});

Deno.test("rejectUnknownKeys: omits entity name when data has no string name", () => {
  const hook = rejectUnknownKeys("job", JOB_KEYS);
  const error = assertThrows(
    () => hook({ steps: [], zzz_bogus: true }),
    Error,
  );
  assertStringIncludes(error.message, "Unknown key 'zzz_bogus' on job");
});
