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

import { assertEquals, assertRejects } from "@std/assert";
import { collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  createUpdateCheckDeps,
  UPDATE_CHECK_MAX_ATTEMPTS,
  updateCheck,
  type UpdateCheckDeps,
  type UpdateCheckEvent,
} from "./check.ts";
import { Platform } from "../../domain/update/platform.ts";
import { UserError } from "../../domain/errors.ts";
import { withMockedFetch } from "@swamp-club/swamp-testing";

function makeDeps(overrides: Partial<UpdateCheckDeps> = {}): UpdateCheckDeps {
  return {
    check: () =>
      Promise.resolve({
        status: "up_to_date" as const,
        currentVersion: "1.0.0",
      }),
    update: () =>
      Promise.resolve({
        status: "updated" as const,
        previousVersion: "1.0.0",
        newVersion: "2.0.0",
      }),
    ...overrides,
  };
}

Deno.test("updateCheck: yields checking then completed for check-only", async () => {
  const deps = makeDeps();
  const platform = Platform.detect();

  const events = await collect<UpdateCheckEvent>(
    updateCheck(createLibSwampContext(), deps, {
      checkOnly: true,
      platform,
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "checking" });
  const completed = events[1] as Extract<
    UpdateCheckEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.status, "up_to_date");
});

Deno.test("updateCheck: yields checking then completed for update", async () => {
  const deps = makeDeps();
  const platform = Platform.detect();

  const events = await collect<UpdateCheckEvent>(
    updateCheck(createLibSwampContext(), deps, {
      checkOnly: false,
      platform,
    }),
  );

  assertEquals(events.length, 2);
  assertEquals(events[0], { kind: "checking" });
  const completed = events[1] as Extract<
    UpdateCheckEvent,
    { kind: "completed" }
  >;
  assertEquals(completed.kind, "completed");
  assertEquals(completed.data.status, "updated");
});

Deno.test("createUpdateCheckDeps: the update check retries a timed-out request (swamp-club#3428)", async () => {
  const deps = createUpdateCheckDeps("20261001.000000.0-sha.abcdef12", "", {
    sleep: () => Promise.resolve(),
  });
  const { calls } = await withMockedFetch(
    () => {
      throw new DOMException("timed out", "TimeoutError");
    },
    () =>
      assertRejects(
        () => deps.check(Platform.from("linux", "x86_64")),
        UserError,
      ),
  );

  assertEquals(UPDATE_CHECK_MAX_ATTEMPTS, 3);
  assertEquals(calls.length, UPDATE_CHECK_MAX_ATTEMPTS);
});
