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
import { stripAnsiCode } from "@std/fmt/colors";
import { UserError } from "../../domain/errors.ts";
import {
  createModelLeaseAcquireRenderer,
  createModelLeaseReleaseRenderer,
  createModelLeaseStatusRenderer,
} from "./model_lease.ts";

function capture(fn: () => void): string {
  const output: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = origLog;
  }
  return stripAnsiCode(output.join("\n"));
}

const lease = {
  lockKey: "data/aws/ec2/0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a01/.lock",
  fence: 4,
  holdMs: 1_800_000,
  expiresAt: "2026-10-29T12:30:00.000Z",
};
const behavior = {
  name: "web",
  type: "aws/ec2",
  id: "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a01",
};

Deno.test("createModelLeaseAcquireRenderer: log mode names the behavior, its fence and hold; JSON is the data", () => {
  const data = { behavior, existing: false, ...lease };
  const text = capture(() =>
    createModelLeaseAcquireRenderer("log").handlers().completed({
      kind: "completed",
      data,
    })
  );
  assertStringIncludes(text, "Lease held: web (aws/ec2)");
  assertStringIncludes(text, "Fence:   4");
  assertStringIncludes(text, "30m");
  const json = capture(() =>
    createModelLeaseAcquireRenderer("json").handlers().completed({
      kind: "completed",
      data,
    })
  );
  assertEquals(JSON.parse(json), data);
});

Deno.test("createModelLeaseReleaseRenderer: says when the checkout held no lease", () => {
  const text = capture(() =>
    createModelLeaseReleaseRenderer("log").handlers().completed({
      kind: "completed",
      data: { behavior, lockKey: lease.lockKey, released: false },
    })
  );
  assertStringIncludes(text, "this checkout holds none on web");
});

Deno.test("createModelLeaseStatusRenderer: lists each lease's state, or none", () => {
  const handlers = createModelLeaseStatusRenderer("log").handlers();
  assertStringIncludes(
    capture(() =>
      handlers.completed({ kind: "completed", data: { leases: [] } })
    ),
    "this checkout holds none",
  );
  const text = capture(() =>
    handlers.completed({
      kind: "completed",
      data: { leases: [{ ...lease, state: "expired" }] },
    })
  );
  assertStringIncludes(text, "Lease: expired");
  assertStringIncludes(text, lease.lockKey);
});

Deno.test("createModelLeaseStatusRenderer: an error is a UserError in both modes", () => {
  for (const mode of ["log", "json"] as const) {
    assertThrows(
      () =>
        createModelLeaseStatusRenderer(mode).handlers().error({
          kind: "error",
          error: { code: "lease_team_mode_only", message: "team mode only" },
        }),
      UserError,
      "team mode only",
    );
  }
});
