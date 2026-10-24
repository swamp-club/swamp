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
import { z } from "zod";
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

/** Runs a hook through a schema and returns the data or the issues it adds. */
function run(
  hook: ReturnType<typeof rejectUnknownKeys>,
  data: unknown,
): { data?: unknown; issues: { path: string; message: string }[] } {
  const result = z.preprocess(hook, z.unknown()).safeParse(data);
  return result.success ? { data: result.data, issues: [] } : {
    issues: result.error.issues.map((issue) => ({
      path: z.core.toDotPath(issue.path),
      message: issue.message,
    })),
  };
}

/** The single issue a hook reports for `data`. */
function onlyIssue(
  hook: ReturnType<typeof rejectUnknownKeys>,
  data: unknown,
): { path: string; message: string } {
  const { issues } = run(hook, data);
  assertEquals(issues.length, 1);
  return issues[0];
}

Deno.test("rejectUnknownKeys: passes through objects with only known keys", () => {
  const hook = rejectUnknownKeys("job", JOB_KEYS);
  const data = { name: "build", steps: [], weight: 1 };
  assertEquals(run(hook, data), { data: data, issues: [] });
});

Deno.test("rejectUnknownKeys: passes through non-object values", () => {
  const hook = rejectUnknownKeys("job", JOB_KEYS);
  assertEquals(run(hook, null), { data: null, issues: [] });
  assertEquals(run(hook, undefined), { data: undefined, issues: [] });
  assertEquals(run(hook, "string"), { data: "string", issues: [] });
  assertEquals(run(hook, 42), { data: 42, issues: [] });
  const arr = [{ unknown: true }];
  assertEquals(run(hook, arr), { data: arr, issues: [] });
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
  assertEquals(run(hook, data), { data: data, issues: [] });
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
    assertEquals(run(hook, data), { data: data, issues: [] });
  }
});

Deno.test("rejectUnknownKeys: placement keys on a step get the generic unknown-key message", () => {
  // 'labels' etc. ARE step keys; a hook for steps must never see them as
  // unknown. But if a placement-adjacent typo appears, it is a plain
  // unknown key with a suggestion — not the misplaced-property message.
  const hook = rejectUnknownKeys("step", ["name", "task", "labels"]);
  const error = onlyIssue(hook, { name: "echo", task: {}, lables: { a: "b" } });
  assertEquals(error.path, "lables");
  assertStringIncludes(error.message, "Unknown key 'lables' on step 'echo'");
  assertStringIncludes(error.message, "Did you mean 'labels'?");
});

Deno.test("rejectUnknownKeys: unknown key without close match lists valid keys", () => {
  const hook = rejectUnknownKeys("job", JOB_KEYS);
  const error = onlyIssue(hook, { name: "build", steps: [], zzz_bogus_zzz: 1 });
  assertStringIncludes(error.message, "Unknown key 'zzz_bogus_zzz'");
  assertStringIncludes(
    error.message,
    "Valid job keys: name, description, steps, dependsOn, weight, concurrency, target, labels, platform, queueTimeout",
  );
});

Deno.test("rejectUnknownKeys: leaves driver/driverConfig for the removed-fields hook", () => {
  const hook = rejectUnknownKeys("job", JOB_KEYS);
  const data = { name: "build", steps: [], driver: "docker" };
  // Must pass through so addRemovedDriverFieldIssues (chained first in the
  // schemas) produces its specific migration message.
  assertEquals(run(hook, data), { data: data, issues: [] });
});

Deno.test("rejectUnknownKeys: omits entity name when data has no string name", () => {
  const hook = rejectUnknownKeys("job", JOB_KEYS);
  const error = onlyIssue(hook, { steps: [], zzz_bogus: true });
  assertStringIncludes(error.message, "Unknown key 'zzz_bogus' on job");
});

Deno.test("rejectUnknownKeys: reports every unknown key as its own issue (swamp-club#3832)", () => {
  const hook = rejectUnknownKeys("job", JOB_KEYS);
  const { issues } = run(hook, { name: "build", steps: [], aaa: 1, bbb: 2 });
  assertEquals(issues.map((issue) => issue.path), ["aaa", "bbb"]);
  assertStringIncludes(issues[0].message, "Unknown key 'aaa' on job 'build'");
  assertStringIncludes(issues[1].message, "Unknown key 'bbb' on job 'build'");
});
